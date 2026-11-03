import type { ActivityToolFamily } from "@t3tools/client-runtime/activity-details";
import {
  codeCellKind,
  parseActivityToolPresentation,
} from "@t3tools/client-runtime/activity-details";
import type { TimelineEntry } from "../../session-logic";
import { workLogEntryIsToolLike } from "../../session-logic";
import { isNativeWaitTool, readNativeWaitState } from "./NativeWaitingPane.logic";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { workEntryPresentation } from "./toolWorkEntryCompactSummary";

export interface TimelineActivityDecisions {
  readonly currentForegroundEntryId: string | null;
  readonly autoExpandedEntryIds: ReadonlySet<string>;
  readonly autoExpandedSubagentItemIds: ReadonlySet<string>;
  readonly liveChildEntryIds: ReadonlySet<string>;
  readonly isAutoExpanded: (entryId: string, nativeItemId?: string | null) => boolean;
  readonly isGroupAutoExpanded: (groupId: string, memberIds: ReadonlyArray<string>) => boolean;
}

/**
 * Which activity bodies open by themselves: every foreground step (Terminal),
 * selected live excerpts and subagent details (KM, Minimal+), or none (Minimal).
 */
export type TimelineAutoOpen = "foreground" | "live-excerpts" | "none";

/** KM keeps live excerpts and subagent details expanded through this settle delay. */
export const EXCERPT_FOLD_DELAY_MS = 500;

export interface DeriveTimelineActivityDecisionsInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly liveSubagentEntryIds?: ReadonlySet<string>;
  readonly lifecycleItems?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly autoOpen?: TimelineAutoOpen | undefined;
  /** Excerpts that settled a moment ago: they stay open until the fold delay passes. */
  readonly settlingExcerptIds?: ReadonlySet<string> | undefined;
  /**
   * Live-excerpt mode also keeps this many of the current turn's latest
   * excerpts and subagents open after they settle; older ones fold as work
   * continues. Zero keeps only running steps open.
   */
  readonly excerptsKeptOpen?: number | undefined;
}

const EXCERPT_FAMILIES: Record<ActivityToolFamily, boolean> = {
  command: true,
  write: true,
  diff: true,
  read: false,
  search: false,
  unknown: false,
};

const EXCERPT_ITEM_TYPES: Partial<Record<OrchestrationV2TurnItem["type"], true>> = {
  command_execution: true,
  file_change: true,
};

/** Edits, writes, commands and code cells that do more than read files: the steps whose body KM shows while they run. */
function showsLiveExcerpt(entry: TimelineEntry): boolean {
  if (entry.kind === "work") {
    const { itemType } = entry.entry;
    if (itemType !== undefined && EXCERPT_ITEM_TYPES[itemType] === true) return true;
    const presentation = workEntryPresentation(entry.entry);
    return EXCERPT_FAMILIES[presentation.family] || presentation.codeCell === "code";
  }
  if (entry.kind !== "event") return false;
  const { item } = entry.projectedItem;
  if (EXCERPT_ITEM_TYPES[item.type] === true) return true;
  if (item.type !== "dynamic_tool") return false;
  const toolName = item.toolName ?? undefined;
  return (
    EXCERPT_FAMILIES[parseActivityToolPresentation(toolName, item.input).family] ||
    (toolName !== undefined && codeCellKind(toolName, item.input) === "code")
  );
}

/**
 * Checks whether an entry is a passive update (system notice, notification,
 * progress snapshot, interrupt request/result, compaction, or native subagent).
 * Passive updates must not steal foreground focus or act as workflow successors.
 */
function isPassiveTimelineEntry(entry: TimelineEntry): boolean {
  if (entry.kind === "work") {
    const work = entry.entry;
    if (work.itemType === "system_notice" || work.itemType === "notification") {
      return true;
    }
    if (
      work.sourceActivityKind === "task.progress" ||
      work.sourceActivityKind === "context-compaction" ||
      work.sourceActivityKind === "runtime.error" ||
      work.sourceActivityKind === "runtime.warning"
    ) {
      return true;
    }
    const item = work.projectedItem?.item;
    if (item !== undefined) {
      if (
        item.type === "system_notice" ||
        item.type === "notification" ||
        item.type === "subagent"
      ) {
        return true;
      }
    }
    return false;
  }

  if (entry.kind === "event") {
    const item = entry.projectedItem.item;
    if (
      item.type === "run_interrupt_request" ||
      item.type === "run_interrupt_result" ||
      item.type === "system_notice" ||
      item.type === "notification" ||
      item.type === "subagent"
    ) {
      return true;
    }
    return false;
  }

  if (entry.kind === "message") {
    return entry.message.role === "system";
  }

  return false;
}

/**
 * Returns true if this entry represents a foreground activity candidate
 * (tool call, reasoning work). Passive items like subagents do not steal focus.
 */
function isForegroundCandidateActivity(entry: TimelineEntry): boolean {
  if (isPassiveTimelineEntry(entry)) {
    return false;
  }

  if (entry.kind === "work") {
    const work = entry.entry;
    if (work.itemType === "reasoning" || work.tone === "thinking") {
      return true;
    }
    if (workLogEntryIsToolLike(work)) {
      return true;
    }
    if (work.command !== undefined || work.requestKind !== undefined) {
      return true;
    }
    return false;
  }

  if (entry.kind === "event") {
    const item = entry.projectedItem.item;
    if (
      item.type === "dynamic_tool" ||
      item.type === "command_execution" ||
      item.type === "file_change" ||
      item.type === "file_search" ||
      item.type === "web_search" ||
      item.type === "reasoning"
    ) {
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Checks whether an entry is actively live (running, in progress, streaming).
 * Uses reconciled waitState.waiting for native wait tools and precomputed
 * liveSubagentEntryIds for subagents to avoid stale historical turn item status.
 */
function isTimelineEntryLive(
  entry: TimelineEntry,
  liveSubagentEntryIds?: ReadonlySet<string>,
  lifecycleItems?: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  // Check live subagent exemptions first, even though subagents are passive for foreground focus
  if (entry.kind === "event" && entry.projectedItem.item.type === "subagent") {
    return liveSubagentEntryIds?.has(entry.id) ?? false;
  }
  if (entry.kind === "work" && entry.entry.projectedItem?.item.type === "subagent") {
    return liveSubagentEntryIds?.has(entry.id) ?? false;
  }

  if (isPassiveTimelineEntry(entry)) {
    return false;
  }

  if (entry.kind === "work") {
    const work = entry.entry;
    const item = work.projectedItem?.item;
    if (item !== undefined) {
      if (item.type === "dynamic_tool" && isNativeWaitTool(item)) {
        const waitState = readNativeWaitState(item, lifecycleItems);
        return waitState?.waiting ?? false;
      }
      if (item.status === "running" || item.status === "pending" || item.status === "waiting") {
        return true;
      }
      return false;
    }
    return work.toolLifecycleStatus === "inProgress";
  }

  if (entry.kind === "event") {
    const item = entry.projectedItem.item;
    if (item.type === "dynamic_tool" && isNativeWaitTool(item)) {
      const waitState = readNativeWaitState(item, lifecycleItems);
      return waitState?.waiting ?? false;
    }
    if (item.status === "running" || item.status === "pending" || item.status === "waiting") {
      return true;
    }
    return false;
  }

  if (entry.kind === "message") {
    return Boolean(entry.message.streaming);
  }

  return false;
}

/**
 * Checks whether an entry advances the workflow and therefore acts as a successor
 * to any preceding completed foreground activities.
 */
export function isWorkflowAdvancement(entry: TimelineEntry): boolean {
  if (isPassiveTimelineEntry(entry)) {
    return false;
  }

  if (entry.kind === "message") {
    if (entry.message.role === "user") {
      return true;
    }
    if (entry.message.role === "assistant") {
      return (entry.message.text ?? "").trim().length > 0;
    }
    return false;
  }

  if (entry.kind === "proposed-plan") {
    return (entry.proposedPlan.planMarkdown ?? "").trim().length > 0;
  }

  if (entry.kind === "html-render" || entry.kind === "mcp-app") {
    return true;
  }

  if (entry.kind === "work") {
    const work = entry.entry;
    if (work.itemType === "reasoning" || work.tone === "thinking") {
      return work.toolLifecycleStatus === "inProgress" || Boolean(work.detail?.trim());
    }
    return isForegroundCandidateActivity(entry);
  }

  if (entry.kind === "event") {
    const item = entry.projectedItem.item;
    if (item.type === "reasoning") {
      return item.streaming || Boolean(item.text.trim());
    }
    return isForegroundCandidateActivity(entry);
  }

  return false;
}

/**
 * Derives foreground and successor decisions from the canonical timeline.
 * Tracks workflow advancement in reverse O(n) order so completed predecessor
 * foreground activities fold when a successor exists, while the latest completed
 * activity remains visible until followed by a successor.
 */
export function deriveTimelineActivityDecisions(
  input: DeriveTimelineActivityDecisionsInput,
): TimelineActivityDecisions {
  const { timelineEntries, liveSubagentEntryIds, lifecycleItems, settlingExcerptIds } = input;
  const excerptsKeptOpen = input.excerptsKeptOpen ?? 0;
  const autoOpen = input.autoOpen ?? "foreground";

  const autoExpanded = new Set<string>();
  const autoExpandedSubagentItemIds = new Set<string>();
  // A group stays open while any member is the current foreground work, live
  // or settled, until the workflow moves past it. This is separate from the
  // members' own bodies: KM and Minimal open few or no steps by themselves,
  // but a group must not fold shut between one step and the next.
  const heldOpen = new Set<string>();
  const liveChildren = new Set<string>();
  let latestForegroundEntryId: string | null = null;
  let workflowHasAdvanced = false;
  // Excerpts seen so far in the current turn, newest first; a user message ends the turn.
  let recentExcerptCount = 0;
  let pastCurrentTurn = false;

  for (let i = timelineEntries.length - 1; i >= 0; i--) {
    const entry = timelineEntries[i]!;
    const isLive = isTimelineEntryLive(entry, liveSubagentEntryIds, lifecycleItems);
    const isForeground = isForegroundCandidateActivity(entry);
    const advances = isWorkflowAdvancement(entry);
    const nativeId = extractNativeTurnItemId(entry);
    const isSubagent =
      (entry.kind === "event" && entry.projectedItem.item.type === "subagent") ||
      (entry.kind === "work" && entry.entry.projectedItem?.item.type === "subagent");
    const isSettling =
      settlingExcerptIds?.has(entry.id) === true ||
      (nativeId !== null && settlingExcerptIds?.has(nativeId) === true);
    const isExcerpt =
      autoOpen === "live-excerpts" &&
      ((isSubagent && nativeId !== null) || (isForeground && showsLiveExcerpt(entry)));
    const keptOpen = isExcerpt && !pastCurrentTurn && recentExcerptCount < excerptsKeptOpen;
    if (isExcerpt) recentExcerptCount += 1;
    if (
      autoOpen === "live-excerpts" &&
      isSubagent &&
      nativeId !== null &&
      (isLive || isSettling || keptOpen)
    ) {
      autoExpanded.add(entry.id);
      autoExpanded.add(nativeId);
      autoExpandedSubagentItemIds.add(nativeId);
    }

    if (isLive) {
      liveChildren.add(entry.id);
      if (nativeId) liveChildren.add(nativeId);
    }
    const opensAsExcerpt =
      autoOpen === "live-excerpts" &&
      isForeground &&
      (isLive || isSettling || keptOpen) &&
      showsLiveExcerpt(entry);
    if (opensAsExcerpt || (isForeground && (isLive || !workflowHasAdvanced))) {
      heldOpen.add(entry.id);
      if (autoOpen === "foreground" || opensAsExcerpt) {
        autoExpanded.add(entry.id);
        if (nativeId) autoExpanded.add(nativeId);
        if (latestForegroundEntryId === null) {
          latestForegroundEntryId = entry.id;
        }
      }
    }

    if (advances) {
      workflowHasAdvanced = true;
    }
    if (entry.kind === "message" && entry.message.role === "user") pastCurrentTurn = true;
  }

  const isAutoExpanded = (entryId: string, nativeItemId?: string | null): boolean => {
    if (autoExpanded.has(entryId)) return true;
    if (nativeItemId && autoExpanded.has(nativeItemId)) return true;
    return false;
  };

  const isGroupAutoExpanded = (_groupId: string, memberIds: ReadonlyArray<string>): boolean => {
    return memberIds.some((id) => heldOpen.has(id) || liveChildren.has(id));
  };

  return {
    currentForegroundEntryId: latestForegroundEntryId,
    autoExpandedSubagentItemIds,
    autoExpandedEntryIds: autoExpanded,
    liveChildEntryIds: liveChildren,
    isAutoExpanded,
    isGroupAutoExpanded,
  };
}

function extractNativeTurnItemId(entry: TimelineEntry): string | null {
  if (entry.kind === "work") {
    return entry.entry.projectedItem?.item.id ?? entry.entry.structuredPayload?.id ?? null;
  }
  if (entry.kind === "event") {
    return entry.projectedItem.item.id ?? null;
  }
  return null;
}
