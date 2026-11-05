import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
export { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import {
  isActiveSubagentStatus,
  resolveSubagentLifecycle,
  type SubagentLifecycle,
} from "@t3tools/client-runtime/state/subagentRuntime";
import * as Equal from "effect/Equal";
import { shallow } from "zustand/vanilla/shallow";
import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import {
  commandDisplayText,
  commandProgramName,
} from "@t3tools/client-runtime/work-log/command-label";
import {
  explorationSubline,
  formatTurnFoldSummary,
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  turnItemDiffStats,
  workEntryCoalesceCategory,
  workEntryDeviceOperation,
  type DiffStats,
  type ToolCoalesceCategory,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
export {
  normalizeCompactToolLabel,
  toolGroupAction,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  deriveTimelineActivityDecisions,
  isWorkflowAdvancement,
  type TimelineActivityDecisions,
  type TimelineAutoOpen,
} from "./timelineActivityPolicy";
import { isNativeWaitTool } from "./NativeWaitingPane.logic";
import {
  nativeTodoPlanTasks,
  readNativeTodoPlan,
  todoPlanChanges,
  type NativeTodoPlan,
  type NativeTodoTask,
  type TodoPlanChange,
} from "./todoPlan";
import { workEntryPresentation } from "./toolWorkEntryCompactSummary";
import {
  type ChatMessage,
  type ProposedPlan,
  type ThreadShell,
  type TurnDiffSummary,
} from "../../types";
import {
  isOrchestrationV2WorkActive,
  type MessageId,
  type WorktreeSetupSnapshot,
  type OrchestrationV2Subagent,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  RunId,
  type RuntimeRequestId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import type { ApertureEmbedReference } from "@t3tools/shared/apertureEmbed";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { mcpAppReferencesEqual, type McpAppReference } from "@t3tools/shared/mcpApp";
import { dynamicToolTitle } from "@t3tools/shared/toolActivity";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  if (entry.kind === "html-render" || entry.kind === "aperture-embed" || entry.kind === "mcp-app") {
    return entry.runId;
  }
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

/** Whether the entry still represents live activity, not a settled result. */
function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.itemType === "reasoning") return entry.detail?.trim().replace(/\s+/g, " ") || "Thought";
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const item = entry.structuredPayload;
  const title = item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input) : null;
  if (title) return title;
  // A lone web search keeps its heading; the query stays in its detail.
  if (entry.itemType === "web_search") return entry.toolTitle ?? "Web search";
  return workEntryDisplayLabel(entry, undefined);
}

function workEntryToolDataRecord(entry: WorkLogEntry): Record<string, unknown> | undefined {
  return entry.toolData !== null &&
    typeof entry.toolData === "object" &&
    !Array.isArray(entry.toolData)
    ? (entry.toolData as Record<string, unknown>)
    : undefined;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  return collectToolFilePaths(workEntryToolDataRecord(entry));
}

function workEntryReadPaths(entry: WorkLogEntry, workspaceRoot: string | undefined): string[] {
  return workEntryReadRawPaths(entry).map((filePath) =>
    formatWorkspaceRelativePath(filePath, workspaceRoot),
  );
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  const action = toolGroupAction(entry);
  if (action === "code-search" || action === "search") {
    // Adapters title file searches with their target; the item keeps only the pattern.
    const searchLabel =
      entry.itemType === "file_search"
        ? entry.label
        : formatSearchToolLabel(workEntryToolDataRecord(entry));
    if (searchLabel) return searchLabel;
  }
  const readPaths = action === "read" ? workEntryReadPaths(entry, workspaceRoot) : [];
  if (action === "read" && readPaths[0]) {
    return formatReadToolLabel(readPaths[0], readPaths.length - 1);
  }
  // Retrying providers keep their progress label; other diagnostics expose
  // the retained message instead of a generic error heading. File bodies
  // are never a compact read label.
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  const title = item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input) : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  const detailIsSearchOutput =
    (action === "code-search" || action === "search") && /[\r\n]/.test(compactDetail ?? "");
  if (compactDetail && !providerRetry && action !== "read" && !detailIsSearchOutput) {
    return compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  if (action === "read" && !entry.viewedImagePath) {
    return "Read file";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

/** The trimmed thread id a `t3_thread_read` call targets, or null for any other entry. */
export function threadReadTargetId(entry: Pick<WorkLogEntry, "structuredPayload">) {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool") return null;
  if (resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "thread-read") return null;
  const input = item.input;
  const threadId =
    input !== null && typeof input === "object" && "threadId" in input ? input.threadId : null;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

const THREAD_READ_OBJECT = " a T3 thread";

export function threadReadTargetTitle(
  shell: Pick<ThreadShell, "title" | "archivedAt" | "deletedAt"> | null,
) {
  if (!shell || shell.archivedAt !== null || shell.deletedAt !== null) return null;
  return shell.title.trim() || null;
}

/**
 * Names the read thread in place of the generic object ("Read a T3 thread" becomes
 * `Read thread “Title”`), keeping the label's tense. Null keeps the generic label.
 */
export function threadReadLabelPrefix(label: string) {
  return label.endsWith(THREAD_READ_OBJECT)
    ? `${label.slice(0, -THREAD_READ_OBJECT.length)} thread`
    : null;
}

/** Inspectable read-file output is the path when we have one, otherwise nothing. */
export function workEntryReadOutput(
  entry: Pick<
    WorkLogEntry,
    "changedFiles" | "detail" | "viewedImagePath" | "structuredPayload" | "toolData"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const paths = [
    ...new Set(
      workEntryReadRawPaths(entry as WorkLogEntry)
        .map((path) => {
          const trimmed = path.trim().replaceAll("\\", "/");
          if (!workspaceRoot || trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
            return trimmed;
          }
          const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
          const relative = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
          return `${root}/${relative}`;
        })
        .filter((path) => path.length > 0),
    ),
  ];
  if (paths.length > 0) {
    return paths.join("\n");
  }
  return null;
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      entry.detail?.trim().replace(/\s+/g, " ") ||
      (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    // A stopped call is an outcome ("Stopped sleep"), not an empty row.
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

/** Restore a visible tool, including a position partway through its expanded output. */
export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * The follow re-arm band (#5566): strict isAtEnd flickers false for a frame
 * while streaming content grows under the viewport, so follow re-arms within
 * this distance of the real content bottom instead.
 */
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the composer inset spacer, but the composer hides
  // the same amount of viewport, so the inset cancels: plain
  // contentLength - scroll - scrollLength is the gap between the last real row
  // and the visible edge above the composer. LegendList's own isAtEnd subtracts
  // the inset and is true anywhere in the bottom composer-height band, so it is
  // only a fallback here, never a short-circuit.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly itemBounds: ReadonlyArray<{
    readonly top: number | null;
    readonly height: number | null;
  }>;
}): number | null {
  let precedingIndex: number | null = null;

  for (const [index, item] of input.itemBounds.entries()) {
    if (item.top === null) {
      continue;
    }
    const inView =
      item.top < input.scrollBottom && item.top + Math.max(1, item.height ?? 1) > input.scrollTop;
    if (inView) {
      // The first visible marker is the turn at the reader's current position.
      return index;
    }
    if (item.top <= input.scrollTop) {
      precedingIndex = index;
    }
  }

  return precedingIndex;
}

/**
 * Side gutter between the viewport edge and the centered content column.
 * `contentWidth` is the rendered column width, which follows the Chat width
 * setting, so callers measure it rather than assume a fixed maximum.
 */
function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom, a
 * narrow pane, or a wider Chat width setting. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

// The prev/next buttons are centered 4px into the strip and 20px wide, so
// their hitbox reaches 14px past the strip's left edge.
const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

/**
 * The prev/next buttons hang outside the strip's height, so the strip's own
 * width cap does not cover them. Keep them inert to the pointer unless the
 * gutter can hold them; keyboard focus still reaches them.
 */
export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type MessagesTimelineActivityStatus =
  | "working"
  | "monitoring"
  | "waiting"
  | "waiting-for-agents"
  | "retry"
  | "finishing"
  | "disconnected";

export function isCurrentProviderRetryActive(input: {
  runId: RunId | null | undefined;
  providerTurnId: string | null | undefined;
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}): boolean {
  if (input.runId == null || input.providerTurnId == null) return false;
  const latestItem = input.visibleTurnItems.findLast(
    ({ item }) => item.runId === input.runId && item.providerTurnId === input.providerTurnId,
  )?.item;
  return latestItem?.type === "error" && latestItem.retry !== undefined;
}

export function deriveMessagesTimelineActivityStatus(input: {
  isWorking: boolean;
  hasUnsettledRun: boolean;
  runlessWorkActive: boolean;
  awaitingUser: boolean;
  retrying: boolean;
  workCompletedAt: string | null;
  waitingForAgents: boolean;
  waitingOnBackgroundJob: boolean;
}): MessagesTimelineActivityStatus | null {
  if (input.waitingOnBackgroundJob) return "monitoring";
  if (!input.isWorking && !input.hasUnsettledRun && !input.runlessWorkActive) return null;
  if (input.workCompletedAt !== null) {
    return input.waitingForAgents ? "waiting-for-agents" : "finishing";
  }
  if (input.awaitingUser) return "waiting";
  if (input.retrying) return "retry";
  return input.isWorking ? "working" : "disconnected";
}

export function hasRequiredForegroundAgents(input: {
  readonly runId: RunId;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "runId" | "status" | "completionWake" | "completionDelivery">
  >;
}): boolean {
  return input.subagents.some(
    (agent) =>
      agent.runId === input.runId &&
      agent.completionWake !== "always" &&
      (isActiveSubagentStatus(agent.status) ||
        agent.completionDelivery?.state === "pending" ||
        agent.completionDelivery?.state === "claimed"),
  );
}
export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt"
> & {
  readonly workCompletedAt?: string | null;
};
export type TimelineRunTiming = Pick<
  TimelineLatestRun,
  "startedAt" | "completedAt" | "workCompletedAt"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export interface TurnRecapFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** A settled turn's last to-do list and edited files, folded under its answer. */
export interface TurnRecap {
  readonly runId: RunId;
  readonly todos: ReadonlyArray<NativeTodoTask>;
  readonly files: ReadonlyArray<TurnRecapFile>;
  /** Files come from the turn's git checkpoint, so each opens in its diff. */
  readonly checkpoint: boolean;
}

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
  /**
   * The timeline entry an activity's header row grows from. The header keeps
   * it from live card to settled summary, so the row is one box throughout.
   */
  readonly activityAnchorId?: string;
};

/**
 * The list key. An activity header is keyed by its anchor, not by its live or
 * settled form: finishing must not remount it (and replay its arrival) while
 * the next activity takes over a reused live id.
 */
export function timelineRowKey(row: MessagesTimelineRow): string {
  if (row.activityAnchorId === undefined) return row.id;
  const detailSuffix = row.kind === "work" && row.isExpandedToolGroup ? ":details" : "";
  return `activity:${row.activityAnchorId}${detailSuffix}`;
}

type MessagesTimelineRowContent =
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: (WorkLogEntry & { autoExpanded?: boolean | undefined })[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
      /** Latest reasoning in the live group, shown above the status line. */
      thought?: WorkLogEntry;
      /** "Exploring 4 files, 1 search": the group in live tense, never its newest step again. */
      summary: string;
      /** Set for an edit group: its summary's trailing `+n −m`. */
      diffStats?: DiffStats;
      /** `└ a.ts, b.ts, +2` under a live Exploring header. */
      subline?: string;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      workCompletedAt: string | null;
      status: MessagesTimelineActivityStatus;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      subline?: string | undefined;
      summaryKind: ToolGroupSummaryKind;
      toolSurface?: WorkLogEntry["toolSurface"];
      toolIcon?: WorkLogEntry["toolIcon"];
      summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request";
      hasFailure: boolean;
      /** Set for an edit group: its summary's trailing `+n −m`. */
      diffStats?: DiffStats;
      /** The agent's own description of the group's calls, when they all share one. */
      intent?: string;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      /** Set when the turn edited files: the label's trailing `+n −m`. */
      diffStats?: DiffStats;
      expanded: boolean;
    }
  | {
      kind: "attempt-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      active: boolean;
    }
  | {
      kind: "todo-update";
      id: string;
      createdAt: string;
      changes: ReadonlyArray<TodoPlanChange>;
      /** Reported in the running turn, so its marks may draw in. */
      live: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      turnRecap?: TurnRecap | undefined;
      revertTurnCount?: number | undefined;
      plan?: OrchestrationV2ProjectedTurnItem | undefined;
      planRunLive?: boolean | undefined;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      taskCall?: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
      resourceSummary?: boolean;
      autoExpanded?: boolean | undefined;
      /** Child turn items whose details are live or settling in KM. */
      autoExpandedSubagentItemIds?: ReadonlyArray<string> | undefined;
      /** IRC and agent-job notices that render inside this agent group, not as rows. */
      absorbedNotices?: ReadonlyArray<Extract<OrchestrationV2TurnItem, { type: "system_notice" }>>;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      kind: "aperture-embed";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      apertureEmbed: ApertureEmbedReference;
    }
  | {
      kind: "mcp-app";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      itemId: TurnItemId;
      revision: string;
      mcpApp: McpAppReference;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

export type TimelineToolPresentation = T3McpToolPresentation;
export const resolveTimelineToolPresentation = resolveT3McpToolPresentation;

function isWorkEntryExplicitlyUserOpen(
  entry: WorkLogEntry,
  activityCache?: ReadonlySet<string>,
): boolean {
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    return activityCache?.has(entry.id) ?? false;
  }
  const canonicalId = entry.projectedItem?.item.id ?? entry.structuredPayload?.id ?? entry.id;
  return activityCache?.has(`tool:${canonicalId}`) ?? false;
}

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: (WorkLogEntry & { autoExpanded?: boolean | undefined })[],
  activityDecisions?: TimelineActivityDecisions,
): Extract<MessagesTimelineRow, { kind: "work" }> {
  const thoughtAnchorId = groupedEntries.find((entry) => entry.itemType === "reasoning")?.id;
  return {
    kind: "work",
    id: `${groupId}:details`,
    activityAnchorId: thoughtAnchorId ?? groupId,
    createdAt,
    groupedEntries: groupedEntries.map((e) => {
      const autoExpanded =
        activityDecisions?.isAutoExpanded(
          e.id,
          e.projectedItem?.item.id ?? e.structuredPayload?.id,
        ) ?? e.autoExpanded;
      return {
        ...e,
        ...(autoExpanded !== undefined ? { autoExpanded } : {}),
      };
    }),
    isExpandedToolGroup: true,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  diffStats?: DiffStats;
}

interface SupersededAttemptFold {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

/**
 * Groups only provider output owned by an explicitly superseded V2 attempt.
 * User messages remain visible because they are inputs to the logical run,
 * including the steer message that started the replacement attempt.
 */
function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unfoldedRunIds: ReadonlySet<RunId>,
  liveSubagentEntryIds: ReadonlySet<string>,
  liveChildEntryIds?: ReadonlySet<string>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      unfoldedRunIds.has(entry.attempt.runId) ||
      (entry.kind === "message" && entry.message.role === "user") ||
      // A published page stays visible, as it does when its turn folds.
      entry.kind === "html-render" ||
      entry.kind === "aperture-embed" ||
      entry.kind === "mcp-app" ||
      timelineEntryIsPersistentResourceCard(entry) ||
      // A steer supersedes the attempt but leaves its children running.
      liveSubagentEntryIds.has(entry.id) ||
      (liveChildEntryIds && liveChildEntryIds.has(entry.id)) ||
      (entry.kind === "work" && entry.entry.itemType === "system_notice")
    ) {
      continue;
    }
    const entries = entriesByAttemptId.get(entry.attempt.id) ?? [];
    entries.push(entry);
    entriesByAttemptId.set(entry.attempt.id, entries);
  }

  const foldsByAnchorEntryId = new Map<string, SupersededAttemptFold>();
  for (const entries of entriesByAttemptId.values()) {
    const firstEntry = entries[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorEntryId.set(firstEntry.id, {
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * The latest turn counts as unsettled while it is still running (or has not
 * recorded a completion). This is deliberately keyed on the turn's own
 * lifecycle rather than transient working state: right after the user sends
 * a message, the previous turn is still the "active" one until the server
 * creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

/**
 * Keep each child card visible only while that same stable child id is live.
 * Settled siblings in one launch batch return to the parent turn fold.
 */
export type TimelineLiveSubagent = SubagentLifecycle & Pick<OrchestrationV2Subagent, "id">;

function liveSubagentCardEntryIds(
  entries: ReadonlyArray<TimelineEntry>,
  liveSubagentSources?: ReadonlyMap<string, ReadonlyArray<TimelineLiveSubagent> | undefined>,
): ReadonlySet<string> {
  const visible = new Set<string>();
  let batch: Array<Extract<TimelineEntry, { kind: "event" }>> = [];
  const flush = () => {
    if (batch.length === 0) return;
    for (const entry of batch) {
      if (entry.projectedItem.item.type !== "subagent") continue;
      const item = entry.projectedItem.item;
      const live = liveSubagentSources
        ?.get(item.threadId)
        ?.find((agent) => agent.id === item.subagentId);
      const lifecycle = resolveSubagentLifecycle(item, live);
      if (isActiveSubagentStatus(lifecycle.status)) visible.add(entry.id);
    }
    batch = [];
  };
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") {
      flush();
      continue;
    }
    const item = entry.projectedItem.item;
    const previous = batch.at(-1)?.projectedItem.item;
    if (
      previous !== undefined &&
      (previous.runId !== item.runId || previous.providerTurnId !== item.providerTurnId)
    ) {
      flush();
    }
    batch.push(entry);
  }
  flush();
  return visible;
}

/** `runlessKey` stands in for the run of entries that have none. */
function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  // Notices, plans, waits, and agent groups belong to the turn that produced
  // them; persistent resource cards still opt out when the fold hides entries.
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  if (entry.kind === "event") {
    return entry.projectedItem.item.runId ?? runlessKey;
  }
  return null;
}

/** The plan an entry reports: a todo_list event, or OMP's todo tool as an event or a work step. */
function timelineEntryPlan(entry: TimelineEntry): OrchestrationV2ProjectedTurnItem | undefined {
  const projected =
    entry.kind === "event"
      ? entry.projectedItem
      : entry.kind === "work"
        ? entry.entry.projectedItem
        : undefined;
  const item = projected?.item;
  return item?.type === "todo_list" || (item?.type === "dynamic_tool" && item.toolName === "todo")
    ? projected
    : undefined;
}

/** A steer adds input to its existing turn, without creating a new header. */
function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer") ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

/** Maps entries to the fold key used for runless imported turns and V2 turns. */
export function timelineEntryTurnFoldRunIdsByEntryId(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, RunId> {
  const runIds = new Map<string, RunId>();
  let runlessKey: RunId | null = null;
  for (const entry of entries) {
    if (timelineEntryStartsResponse(entry)) {
      const boundaryRunId =
        entry.kind === "message"
          ? entry.message.runId
          : entry.kind === "work"
            ? entry.entry.runId
            : null;
      runlessKey =
        boundaryRunId === null || boundaryRunId === undefined
          ? RunId.make(`runless:${entry.id}`)
          : null;
      continue;
    }
    const runId = timelineEntryFoldRunId(entry, runlessKey);
    if (runId !== null) runIds.set(entry.id, runId);
  }
  return runIds;
}

/** Returns the fold key that owns a timeline entry, including imported runless turns. */
export function timelineEntryTurnFoldRunId(
  entries: ReadonlyArray<TimelineEntry>,
  entryId: string,
): RunId | null {
  return timelineEntryTurnFoldRunIdsByEntryId(entries).get(entryId) ?? null;
}

/**
 * A promptless provider restart replaces the native turn without adding a
 * user message. Keep every provider turn since the initiating prompt in one
 * visual response until the replacement turn settles. Steers keep that
 * boundary; an automatic wake starts a new response with its notification.
 */
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

/** Place the current status after its latest active input, not its first prompt. */
function latestActiveInteractionIndex(
  entries: ReadonlyArray<TimelineEntry>,
  activeRunId: RunId | null,
  hasActiveStatus: boolean,
): number {
  const userInputIndex = entries.findLastIndex(
    (entry) =>
      entry.kind === "message" &&
      entry.message.role === "user" &&
      (entry.message.inputIntent !== "queued_turn" ||
        (activeRunId !== null && entry.message.runId === activeRunId)) &&
      (entry.message.runId === activeRunId || (hasActiveStatus && entry.message.runId === null)),
  );
  if (userInputIndex >= 0) return userInputIndex;
  return entries.findLastIndex(
    (entry) =>
      timelineEntryStartsResponse(entry) &&
      !(entry.kind === "message" && entry.message.inputIntent === "queued_turn"),
  );
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  hasActiveStatus: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.hasActiveStatus) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

/**
 * Settled turns fold activity before their terminal assistant message behind
 * a "Worked for ..." row. Ordinary trailing work joins the fold, while failures
 * and work still in progress stay visible. A prompt without a run (a
 * provider-native subagent, or a turn imported from V1) folds its response
 * the same way.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  runTimingsById?: ReadonlyMap<RunId, TimelineRunTiming> | undefined;
  unfoldedRunIds: ReadonlySet<RunId>;
  /** Keeps the latest runless response open; V2 work must not reopen imported turns. */
  runlessWorkActive: boolean;
  liveSubagentEntryIds: ReadonlySet<string>;
  liveChildEntryIds?: ReadonlySet<string>;
}): ReadonlyMap<string, TurnFold> {
  const interruptedRunIds = new Set<RunId>();
  for (const entry of input.timelineEntries) {
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      (entry.projectedItem.item.type === "run_interrupt_request" ||
        entry.projectedItem.item.type === "run_interrupt_result")
    ) {
      interruptedRunIds.add(entry.projectedItem.item.runId);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message or notification that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
    anchorEntryId: string;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();

  // Fold state is keyed by run, so each runless prompt lends its response a
  // stable key of its own. Decide per prompt, not per thread: a V1 thread's
  // first V2 run must not unfold every imported turn above it.
  let runlessKey: RunId | null = null;
  let pendingBoundary: { createdAt: string; anchorEntryId: string } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? { createdAt: entry.createdAt, anchorEntryId: nextEntry.id }
        : null;
      const boundaryRunId =
        entry.kind === "message"
          ? entry.message.runId
          : entry.kind === "work"
            ? entry.entry.runId
            : null;
      runlessKey = boundaryRunId == null ? RunId.make(`runless:${entry.id}`) : null;
      continue;
    }
    const runId = timelineEntryFoldRunId(entry, runlessKey);
    if (!runId) {
      continue;
    }
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      input.unfoldedRunIds.has(runId) ||
      interruptedRunIds.has(runId) ||
      runlessFailedKeys.has(runId) ||
      (input.runlessWorkActive && runId === runlessKey)
    ) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction =
        entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
      // Settled, successful work and passive events that land after the
      // answer (job notices, final plan or wait snapshots) fold with the turn.
      const isFoldableTrailingActivity =
        (entry.kind === "work" &&
          entry.entry.toolLifecycleStatus !== "inProgress" &&
          !workEntryDisplayIndicatesToolFailure(entry.entry)) ||
        (entry.kind === "event" &&
          !isOrchestrationV2WorkActive(entry.projectedItem.item.status) &&
          timelineEntryFailedItem(entry) === null);
      if (!isCompaction && index > terminalEntryIndex && !isFoldableTrailingActivity) {
        continue;
      }
      // Linked resources and still-working children can outlive their
      // launching run and stay visible after the surrounding work folds.
      if (
        timelineEntryIsPersistentResourceCard(entry) ||
        input.liveSubagentEntryIds.has(entry.id) ||
        (input.liveChildEntryIds?.has(entry.id) ?? false)
      ) {
        continue;
      }
      if (entry.kind === "work" && entry.entry.itemType === "notification") continue;
      // A provider handoff marks who answers next; it is a boundary, not a step.
      if (entry.kind === "event" && entry.projectedItem.item.type === "handoff") continue;
      // Provider warnings and errors outrank tidiness; IRC and job notices fold.
      if (
        entry.kind === "work" &&
        entry.entry.itemType === "system_notice" &&
        (entry.entry.sourceActivityKind === "runtime.warning" ||
          entry.entry.sourceActivityKind === "runtime.error" ||
          (entry.entry.structuredPayload?.type === "system_notice" &&
            (entry.entry.structuredPayload.nativeLevel === "warning" ||
              entry.entry.structuredPayload.nativeLevel === "error")))
      ) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction row stays visible on its own; it only folds away as
    // part of a turn that already folds other work.
    const hidesNonCompactionWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction"),
    );
    if (!hidesNonCompactionWork) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestRun?.runId === runId && input.latestRun.status === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const matchingRunTiming = input.runTimingsById?.get(runId);
    const matchingLatestRun = input.latestRun?.runId === runId ? input.latestRun : null;
    const startedAt = matchingRunTiming?.startedAt ?? matchingLatestRun?.startedAt;
    const workEndedAt =
      matchingRunTiming?.workCompletedAt ??
      matchingLatestRun?.workCompletedAt ??
      matchingRunTiming?.completedAt ??
      matchingLatestRun?.completedAt;
    const elapsedMs =
      startedAt && workEndedAt
        ? computeElapsedMs(startedAt, workEndedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const editedFiles: Record<string, true> = {};
    let stepCount = 0;
    let added = 0;
    let removed = 0;
    for (const entry of group.entries) {
      if (!hiddenEntryIds.has(entry.id)) continue;
      if (entry.kind === "event" && entry.projectedItem.item.type === "subagent") stepCount += 1;
      if (
        entry.kind !== "work" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "reasoning" ||
        !workLogEntryIsToolLike(entry.entry)
      ) {
        continue;
      }
      stepCount += 1;
      const item = entry.entry.structuredPayload;
      const stats = turnItemDiffStats(item);
      if (item?.type === "file_change" && stats !== null) {
        editedFiles[item.fileName] = true;
        added += stats.added;
        removed += stats.removed;
      }
    }
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : formatTurnFoldSummary({
          duration,
          stepCount,
          filesEdited: Object.keys(editedFiles).length,
          diffStats: { added, removed },
        });

    foldsByAnchorEntryId.set(group.anchorEntryId, {
      runId,
      anchorEntryId: group.anchorEntryId,
      createdAt: group.startBoundary ?? firstEntry.createdAt,
      hiddenEntryIds,
      label,
      ...(!isLatestInterruptedTurn && Object.keys(editedFiles).length > 0
        ? { diffStats: { added, removed } }
        : {}),
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * When a settled turn ends with tool calls after its terminal text, treat the
 * text and tools as one visual response. The message metadata becomes the
 * footer for the whole block instead of separating the prose from the tools.
 */
function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.item.type === "error" &&
                entry.projectedItem.item.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

function delegatedTaskClientRequestId(childThreadId: ThreadId | null): string | null {
  if (childThreadId === null) return null;
  const value = String(childThreadId);
  const prefix = "thread:delegated-task:command%3Amcp%3A";
  const requestMarker = "%3Adelegate-task%3A";
  if (!value.startsWith(prefix)) return null;
  const commandEnd = value.indexOf(requestMarker, prefix.length);
  if (commandEnd < prefix.length) return null;
  const requestId = value.slice(commandEnd + requestMarker.length);
  return requestId.length > 0 ? requestId : null;
}

// Delegation already has a durable child card. Remove its tool row only after
// the returned task ID identifies that child; pending calls can share a prompt.
// A native task call is the parent of its children, and their agent panel shows
// its shared context, so the call's own row is a duplicate once a child exists.
function withoutSubagentDelegationRows(entries: ReadonlyArray<TimelineEntry>) {
  const childrenByRun = new Map<
    RunId,
    {
      readonly subagentIds: Set<string>;
      readonly childThreadIds: Set<string>;
      readonly clientRequestIds: Set<string>;
    }
  >();
  const parentItemIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    const item = entry.projectedItem.item;
    if (item.parentItemId !== null) parentItemIds.add(item.parentItemId);
    if (item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? {
      subagentIds: new Set<string>(),
      childThreadIds: new Set<string>(),
      clientRequestIds: new Set<string>(),
    };
    children.subagentIds.add(String(item.subagentId));
    if (item.childThreadId !== null) {
      children.childThreadIds.add(String(item.childThreadId));
      const clientRequestId = delegatedTaskClientRequestId(item.childThreadId);
      if (clientRequestId !== null) children.clientRequestIds.add(clientRequestId);
    }
    childrenByRun.set(item.runId, children);
  }
  return entries.filter((entry) => {
    if (entry.kind !== "work" || workEntryDisplayIndicatesToolFailure(entry.entry)) return true;
    const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
    if (item?.type === "dynamic_tool" && parentItemIds.has(item.id)) return false;
    if (item?.type === "notification" && item.runId !== null) {
      const children = childrenByRun.get(item.runId);
      if (children !== undefined) {
        const source = item.source;
        if (
          source.kind === "delegated_task" &&
          source.taskIds.length === 1 &&
          children.subagentIds.has(String(source.taskIds[0]))
        ) {
          return false;
        }
        if (
          "childThreadId" in source &&
          source.childThreadId !== undefined &&
          children.childThreadIds.has(String(source.childThreadId))
        ) {
          return false;
        }
      }
    }
    if (item === undefined || item.runId === null) return true;
    // Pre-fix OMP turns persisted `write xd://<tool>` calls as file changes.
    const deviceOperation = workEntryDeviceOperation(item);
    const call =
      deviceOperation?.kind === "call"
        ? { toolName: deviceOperation.toolName, input: deviceOperation.input }
        : item.type === "dynamic_tool"
          ? { toolName: item.toolName, input: item.input }
          : null;
    if (call === null || resolveT3McpToolDefinition(call.toolName)?.summaryAction !== "delegate") {
      return true;
    }
    const children = childrenByRun.get(item.runId);
    if (children === undefined) return true;
    const input =
      call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : null;
    const clientRequestId =
      typeof input?.clientRequestId === "string" ? input.clientRequestId.trim() : "";
    if (clientRequestId && children.clientRequestIds.has(clientRequestId)) return false;
    if (item.type !== "dynamic_tool") return true;
    if (item.status !== "running" && item.status !== "completed") return true;
    const output = compactDynamicToolOutput(item.output);
    if (output?.isError) return true;
    if (output?.taskId !== undefined) return !children.subagentIds.has(output.taskId);
    return true;
  });
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

/** A steer or subsequent activity ends thinking even if the provider omits its completion. */
function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  pendingApprovalRequestIds?: ReadonlySet<RuntimeRequestId>;
  latestRun?: TimelineLatestRun | null;
  runTimingsById?: ReadonlyMap<RunId, TimelineRunTiming>;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  explicitActivityCache?: ReadonlySet<string>;
  isWorking: boolean;
  /** Current run label; absent only when there is no live status slot. */
  activityStatus?: MessagesTimelineActivityStatus | null;
  /** Owning activity's native execution end; independent from latestRun. */
  activityRunWorkCompletedAt?: string | null;
  /**
   * The live work has no app run (a provider-native subagent thread), so
   * runless entries are the current response instead of settled history.
   */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  /** Scoped live provider-thread subagent projections keyed by source thread id. */
  liveSubagentSources?: ReadonlyMap<string, ReadonlyArray<TimelineLiveSubagent> | undefined>;
  /** Live bootstrap progress. Renders a stage card under the first user message. */
  worktreeSetup?: WorktreeSetupSnapshot | null;
  autoOpen?: TimelineAutoOpen | undefined;
  /** KM and Minimal+ excerpts that just settled and stay open through the fold delay. */
  settlingExcerptIds?: ReadonlySet<string> | undefined;
  /** Minimal+: how many of the running turn's latest excerpts stay open after settling. */
  excerptsKeptOpen?: number | undefined;
  /** Flat presentation keeps every turn and work entry visible as its own row. */
  layout?: "grouped" | "flat";
}): MessagesTimelineRow[] {
  const settledEntries = settleSupersededReasoning(input.timelineEntries);
  const timelineEntries = withoutSubagentDelegationRows(settledEntries);
  const isPendingApproval = (entry: WorkLogEntry) => {
    const item = entry.projectedItem?.item;
    return (
      item?.type === "approval_request" &&
      input.pendingApprovalRequestIds?.has(item.requestId) === true
    );
  };
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  // Read before delegation rows drop out: an agent panel still shows its task call.
  const taskCallsByItemId: Record<
    string,
    Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>
  > = {};
  for (const entry of settledEntries) {
    const item =
      entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : entry.kind === "event"
          ? entry.projectedItem.item
          : undefined;
    if (
      item?.type === "dynamic_tool" &&
      (item.toolName === "task" || item.toolName === "subagent")
    ) {
      taskCallsByItemId[item.id] = item;
    }
  }
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const liveSubagentEntryIds = liveSubagentCardEntryIds(timelineEntries, input.liveSubagentSources);
  const lifecycleItems = timelineEntries.flatMap((entry) => {
    if (entry.kind === "event") return [entry.projectedItem.item];
    if (entry.kind === "work" && entry.entry.projectedItem) return [entry.entry.projectedItem.item];
    return [];
  });
  const activityDecisions = deriveTimelineActivityDecisions({
    timelineEntries,
    liveSubagentEntryIds,
    lifecycleItems,
    autoOpen: input.autoOpen,
    settlingExcerptIds: input.settlingExcerptIds,
    excerptsKeptOpen: input.excerptsKeptOpen,
  });
  const supersededFoldsByAnchorEntryId =
    input.layout === "flat"
      ? new Map<string, SupersededAttemptFold>()
      : deriveSupersededAttemptFolds(
          timelineEntries,
          failedRunIds,
          liveSubagentEntryIds,
          activityDecisions.liveChildEntryIds,
        );
  const activityStatus = input.activityStatus ?? (input.isWorking ? "working" : null);
  const runlessWorkActive = input.runlessWorkActive ?? false;
  const hasActiveStatus = activityStatus !== null;
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries,
    unsettledRunId,
    hasActiveStatus,
  });
  const foldsByAnchorEntryId =
    input.layout === "flat"
      ? new Map<string, TurnFold>()
      : deriveTurnFolds({
          timelineEntries,
          terminalAssistantMessageIds,
          latestRun: input.latestRun ?? null,
          runTimingsById: input.runTimingsById,
          unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
          runlessWorkActive,
          liveSubagentEntryIds,
          liveChildEntryIds: activityDecisions.liveChildEntryIds,
        });
  const collapsedEntryIds = new Set<string>();
  const explicitlyOpenedEntryIds = new Set<string>();
  if (input.explicitActivityCache?.size) {
    for (const entry of timelineEntries) {
      if (
        (entry.kind === "work" &&
          isWorkEntryExplicitlyUserOpen(entry.entry, input.explicitActivityCache)) ||
        (entry.kind === "event" &&
          input.explicitActivityCache.has(`tool:${entry.projectedItem.item.id}`))
      ) {
        explicitlyOpenedEntryIds.add(entry.id);
      }
    }
  }
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedRunIds?.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) {
        if (
          explicitlyOpenedEntryIds.has(entryId) &&
          !input.explicitActivityCache?.has(`turn-collapsed:${fold.runId}`)
        )
          continue;
        collapsedEntryIds.add(entryId);
      }
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    if (!input.expandedAttemptIds?.has(fold.attemptId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedSupersededEntryIds.add(entryId);
      }
    }
  }
  if (input.pendingApprovalRequestIds?.size) {
    for (const entry of timelineEntries) {
      if (entry.kind === "work" && isPendingApproval(entry.entry)) {
        collapsedEntryIds.delete(entry.id);
        collapsedSupersededEntryIds.delete(entry.id);
      }
    }
  }
  const subagentEventsByTurn = new Map<string, Array<Extract<TimelineEntry, { kind: "event" }>>>();
  const subagentTurnKeyByEntryId = new Map<string, string>();
  let subagentGroupSegment = 0;
  for (const entry of timelineEntries) {
    if (timelineEntryStartsResponse(entry)) subagentGroupSegment += 1;
    if (entry.kind === "event" && entry.projectedItem.item.type !== "subagent") {
      subagentGroupSegment += 1;
      continue;
    }
    if (
      entry.kind !== "event" ||
      entry.projectedItem.item.type !== "subagent" ||
      collapsedEntryIds.has(entry.id) ||
      collapsedSupersededEntryIds.has(entry.id)
    ) {
      continue;
    }
    const item = entry.projectedItem.item;
    const turnKey =
      item.runId !== null || item.providerTurnId !== null
        ? `${String(item.threadId)}\u0000${String(item.runId ?? "")}\u0000${String(item.providerTurnId ?? "")}\u0000${subagentGroupSegment}`
        : `entry:${entry.id}`;
    const group = subagentEventsByTurn.get(turnKey) ?? [];
    group.push(entry);
    subagentEventsByTurn.set(turnKey, group);
    subagentTurnKeyByEntryId.set(entry.id, turnKey);
  }

  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const executionIsActive =
    input.isWorking &&
    activityStatus !== "waiting" &&
    activityStatus !== "waiting-for-agents" &&
    activityStatus !== "finishing" &&
    activityStatus !== "disconnected";
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    executionIsActive &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  const activeInteractionIndex = hasActiveStatus
    ? latestActiveInteractionIndex(
        timelineEntries,
        input.runningRunId ?? unsettledRunId,
        hasActiveStatus,
      )
    : -1;
  const activitySlotIndex = activeInteractionIndex + 1;

  // Contiguous trailing work entries of the active run collapse into one live
  // row that survives between actions: while a tool runs it shows that tool,
  // and once everything settles it keeps the latest tool in past tense
  // instead of vanishing (#8984).
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (executionIsActive && (unsettledRunId !== null || runlessWorkActive)) {
    let tailAttemptId: string | null | undefined;
    // The live row spans only steps that would coalesce; earlier steps of
    // another kind settle into their own Explored/Edited/single rows.
    let tailCategory: ToolCoalesceCategory | undefined;
    for (let index = timelineEntries.length - 1; index >= activitySlotIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        isPendingApproval(entry.entry) ||
        // The plan strip stands alone; it never joins the live step group.
        timelineEntryPlan(entry) !== undefined ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification" ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        foldsByAnchorEntryId.has(entry.id) ||
        supersededFoldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      if (tailAttemptId === undefined) {
        tailAttemptId = entry.attempt?.id ?? null;
      } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
        break;
      }
      if (entry.entry.itemType !== "reasoning") {
        const category = workEntryCoalesceCategory(entry.entry);
        if (tailCategory === undefined) tailCategory = category;
        else if (category === "individual" || category !== tailCategory) break;
      }
      activeToolEntries.unshift(entry);
      if (input.layout === "flat") break;
    }
  }
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry) &&
      !input.pendingApprovalRequestIds?.size);
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          const hasManualExpanded = input.expandedWorkGroupIds?.has(groupId);
          const hasManualCollapsed = input.expandedWorkGroupIds?.has(
            `work-group-collapsed:${groupId}`,
          );
          const defaultExpanded =
            visibleActiveToolEntries.some((entry) =>
              isWorkEntryExplicitlyUserOpen(entry.entry, input.explicitActivityCache),
            ) ||
            activityDecisions.isGroupAutoExpanded(
              groupId,
              visibleActiveToolEntries.map((entry) => entry.id),
            );
          const expanded =
            input.layout !== "flat" &&
            (hasManualExpanded ? true : hasManualCollapsed ? false : defaultExpanded);
          const groupedEntries = visibleActiveToolEntries.map((entry) => entry.entry);
          const exploring =
            groupedEntries.length > 1 &&
            groupedEntries.every(
              (entry) =>
                entry.itemType === "reasoning" || workEntryCoalesceCategory(entry) === "explore",
            );
          const liveSummary = summarizeToolGroup(groupedEntries);
          return {
            kind: "work-live" as const,
            id:
              latestToolKeepsActivityLive || latestToolFailed
                ? LIVE_ACTIVITY_ROW_ID
                : `work-live:${activeWorkAnchor.id}`,
            activityAnchorId: activeWorkAnchor.id,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries,
            groupId,
            expanded,
            active: latestToolKeepsActivityLive,
            summary: liveSummary.summary,
            ...(liveSummary.diffStats ? { diffStats: liveSummary.diffStats } : {}),
            ...(exploring ? { subline: explorationSubline(groupedEntries) } : {}),
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null ? activeToolEntries.map((entry) => entry.id) : [],
  );
  const appendWorkingRow = () => {
    if (activityStatus === null) return;
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt ?? input.latestRun?.startedAt ?? null,
      workCompletedAt:
        activityStatus === "finishing" || activityStatus === "waiting-for-agents"
          ? (input.activityRunWorkCompletedAt ?? input.latestRun?.workCompletedAt ?? null)
          : null,
      status: activityStatus,
    });
  };
  const singleStep = (entry: WorkLogEntry) => ({
    entry: {
      ...entry,
      autoExpanded: activityDecisions.isAutoExpanded(
        entry.id,
        entry.projectedItem?.item.id ?? entry.structuredPayload?.id,
      ),
    },
    displayLabel:
      toolGroupAction(entry) === "edit"
        ? summarizeToolGroup([entry]).summary
        : singleToolCallLabel(entry),
  });
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    // Keep one live row shape as reasoning and tool entries stream into the group.
    nextRows.push(activeWorkRow);
    if (!activeWorkRow.expanded) return;
    // A lone thought renders its body in the live row already.
    if (
      activeWorkRow.groupedEntries.length === 1 &&
      activeWorkRow.groupedEntries[0]?.itemType === "reasoning"
    ) {
      return;
    }
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
        activityDecisions,
      ),
    );
  };

  // One plan strip per run: it stays where the first plan appeared and shows
  // the latest. Each reported update also says what it changed, against the
  // run's previous report.
  const planEntryIdByRun: Record<string, string> = {};
  const latestPlanByRun: Record<string, OrchestrationV2ProjectedTurnItem> = {};
  const reportedPlanByRun: Record<string, NativeTodoPlan> = {};
  const todoChangesByEntryId = new Map<string, ReadonlyArray<TodoPlanChange>>();
  for (const entry of timelineEntries) {
    const plan = timelineEntryPlan(entry);
    if (plan === undefined) continue;
    const runKey = plan.item.runId ?? entry.id;
    planEntryIdByRun[runKey] ??= entry.id;
    // A todo call still in flight has not reported its plan; keep showing the last one.
    const inFlight = plan.item.status === "pending" || plan.item.status === "running";
    if (!inFlight || latestPlanByRun[runKey] === undefined) latestPlanByRun[runKey] = plan;
    const reported = inFlight ? null : readNativeTodoPlan(plan.item);
    if (reported === null) continue;
    todoChangesByEntryId.set(
      entry.id,
      todoPlanChanges(reportedPlanByRun[runKey] ?? null, reported),
    );
    reportedPlanByRun[runKey] = reported;
  }
  // A settled turn recaps under its last answer: the to-dos it last reported
  // and the files it edited, from the git checkpoint when there is one and
  // from its edit steps otherwise.
  const editedFilesByRun = new Map<RunId, Record<string, TurnRecapFile>>();
  const lastAnswerByRun = new Map<RunId, Extract<TimelineEntry, { kind: "message" }>>();
  for (const entry of timelineEntries) {
    if (entry.kind === "message") {
      if (entry.message.role === "assistant" && entry.message.runId != null) {
        lastAnswerByRun.set(entry.message.runId, entry);
      }
      continue;
    }
    if (entry.kind !== "work" || entry.entry.runId == null) continue;
    const item = entry.entry.structuredPayload;
    const stats = turnItemDiffStats(item);
    if (item?.type !== "file_change" || stats === null) continue;
    const files = editedFilesByRun.get(entry.entry.runId) ?? {};
    editedFilesByRun.set(entry.entry.runId, files);
    files[item.fileName] = {
      path: item.fileName,
      additions: (files[item.fileName]?.additions ?? 0) + stats.added,
      deletions: (files[item.fileName]?.deletions ?? 0) + stats.removed,
    };
  }
  const turnRecapByEntryId = new Map<string, TurnRecap>();
  for (const [runId, answer] of lastAnswerByRun) {
    if (runIdIsActiveResponse(runId) || answer.message.streaming) continue;
    const checkpointFiles = turnDiffSummaryByAssistantMessageId.get(answer.message.id)?.files ?? [];
    const checkpoint = checkpointFiles.length > 0;
    const files = checkpoint
      ? checkpointFiles.map(({ path, additions, deletions }) => ({ path, additions, deletions }))
      : Object.values(editedFilesByRun.get(runId) ?? {});
    const reported = reportedPlanByRun[runId];
    const todos = reported === undefined ? [] : nativeTodoPlanTasks(reported);
    if (todos.length === 0 && files.length === 0) continue;
    turnRecapByEntryId.set(answer.id, { runId, todos, files, checkpoint });
  }
  const recappedRunIds = new Set<string>();
  for (const recap of turnRecapByEntryId.values()) recappedRunIds.add(recap.runId);
  const planByUserMessageEntryId = new Map<string, OrchestrationV2ProjectedTurnItem>();
  const planRunLiveByUserMessageEntryId = new Map<string, boolean>();
  const runsWithUserMessagePlan = new Set<string>();

  for (let i = 0; i < timelineEntries.length; i++) {
    const entry = timelineEntries[i];
    if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
      continue;
    }
    let turnRunId: RunId | null = entry.message.runId ?? null;
    let turnPlan: OrchestrationV2ProjectedTurnItem | undefined = undefined;

    for (let j = i + 1; j < timelineEntries.length; j++) {
      const follower = timelineEntries[j];
      if (!follower) continue;
      if (timelineEntryStartsResponse(follower)) {
        break;
      }
      if (turnRunId === null) {
        const followerRunId =
          follower.kind === "work"
            ? follower.entry.runId
            : follower.kind === "event"
              ? follower.projectedItem.item.runId
              : follower.kind === "message"
                ? follower.message.runId
                : null;
        if (followerRunId != null) {
          turnRunId = followerRunId;
        }
      }
      const followerPlan = timelineEntryPlan(follower);
      if (followerPlan !== undefined && turnPlan === undefined) {
        const runKey = followerPlan.item.runId ?? follower.id;
        turnPlan = latestPlanByRun[runKey] ?? followerPlan;
      }
    }

    const resolvedPlan = (turnRunId != null ? latestPlanByRun[turnRunId] : undefined) ?? turnPlan;
    if (resolvedPlan !== undefined) {
      const resolvedRunKey = resolvedPlan.item.runId ?? (turnRunId != null ? turnRunId : null);
      if (resolvedRunKey != null) {
        runsWithUserMessagePlan.add(resolvedRunKey);
      }
      // Docked while the turn works; once it settles the list moves into the
      // recap under the answer.
      if (resolvedRunKey == null || !recappedRunIds.has(resolvedRunKey)) {
        planByUserMessageEntryId.set(entry.id, resolvedPlan);
        const isLive = turnRunId != null ? runIdIsActiveResponse(turnRunId) : runlessWorkActive;
        planRunLiveByUserMessageEntryId.set(entry.id, isLive);
      }
    }
  }
  // Passive agent traffic (IRC, job completions) updates the response's latest
  // agent group in place instead of adding rows. When that group sits in a
  // folded turn, late notices (often runless) fold with it.
  let agentGroupRowIndex: number | null = null;
  let agentGroupFolded = false;

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }
    if (timelineEntryStartsResponse(timelineEntry)) {
      agentGroupRowIndex = null;
      agentGroupFolded = false;
    }
    if (hasActiveStatus && index === activitySlotIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    // The terminal interrupt result is the useful timeline marker. The
    // preceding request is transient bookkeeping and duplicates that marker.
    if (
      timelineEntry.kind === "event" &&
      timelineEntry.projectedItem.item.type === "run_interrupt_request"
    ) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        ...(turnFold.diffStats ? { diffStats: turnFold.diffStats } : {}),
        expanded: input.expandedRunIds?.has(turnFold.runId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      if (timelineEntry.kind === "event" && timelineEntry.projectedItem.item.type === "subagent") {
        agentGroupRowIndex = null;
        agentGroupFolded = true;
      }
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        id: `attempt-fold:${supersededFold.attemptId}`,
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: input.expandedAttemptIds?.has(supersededFold.attemptId) ?? false,
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.entry.label,
        active,
      });
      continue;
    }

    const plan = timelineEntryPlan(timelineEntry);
    if (plan !== undefined) {
      const runKey = plan.item.runId ?? timelineEntry.id;
      const stripEntry =
        !runsWithUserMessagePlan.has(runKey) && planEntryIdByRun[runKey] === timelineEntry.id;
      if (stripEntry) {
        nextRows.push({
          kind: "event",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          projectedItem: latestPlanByRun[runKey] ?? plan,
          autoExpanded: activityDecisions.isAutoExpanded(timelineEntry.id, plan.item.id),
        });
        continue;
      }
      // Later updates read inline, where they happened: what got checked
      // off, dropped, blocked or added.
      const changes = todoChangesByEntryId.get(timelineEntry.id) ?? [];
      if (changes.length > 0) {
        nextRows.push({
          kind: "todo-update",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          changes,
          live: runIdIsActiveResponse(plan.item.runId),
        });
      }
      continue;
    }

    if (timelineEntry.kind === "work") {
      const notice = timelineEntry.entry.structuredPayload;
      const isAgentNotice =
        notice?.type === "system_notice" &&
        (notice.irc !== undefined || notice.jobCompletion !== undefined);
      if (isAgentNotice && agentGroupFolded) continue;
      const agentGroupRow = agentGroupRowIndex === null ? undefined : nextRows[agentGroupRowIndex];
      if (
        agentGroupRowIndex !== null &&
        agentGroupRow?.kind === "event" &&
        isAgentNotice &&
        notice?.type === "system_notice"
      ) {
        nextRows[agentGroupRowIndex] = {
          ...agentGroupRow,
          absorbedNotices: [...(agentGroupRow.absorbedNotices ?? []), notice],
        };
        continue;
      }
      if (
        isPendingApproval(timelineEntry.entry) ||
        (timelineEntry.entry.runId != null && failedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification" ||
        timelineEntry.entry.nativeTerminalFallback !== undefined
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          activityAnchorId: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      if (input.layout === "flat") {
        const step = singleStep(timelineEntry.entry);
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          activityAnchorId: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [step.entry],
          isExpandedToolGroup: false,
          ...(workLogEntryIsToolLike(step.entry) ? { displayLabel: step.displayLabel } : {}),
        });
        continue;
      }

      const groupedEntries = [timelineEntry.entry];
      // Reads and searches merge into one Explored row, edits into one Edited
      // row; every other tool stands alone. Reasoning joins whichever run it is in.
      let groupCategory: ToolCoalesceCategory | null =
        timelineEntry.entry.itemType === "reasoning"
          ? null
          : workEntryCoalesceCategory(timelineEntry.entry);
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          isPendingApproval(nextEntry.entry) ||
          timelineEntryPlan(nextEntry) !== undefined ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          nextEntry.entry.itemType === "notification" ||
          nextEntry.entry.nativeTerminalFallback !== undefined ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          collapsedSupersededEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
          nextEntry.attempt?.id !== timelineEntry.attempt?.id
        ) {
          break;
        }
        if (nextEntry.entry.itemType !== "reasoning") {
          const category = workEntryCoalesceCategory(nextEntry.entry);
          if (groupCategory === null) groupCategory = category;
          else if (category === "individual" || category !== groupCategory) break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        // A lone settled step draws itself; a group over it would only repeat it.
        const singleToolEntry =
          visibleGroupedEntries.length === 1 && workLogEntryIsToolLike(visibleGroupedEntries[0]!)
            ? visibleGroupedEntries[0]!
            : null;
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const hasManualExpanded = input.expandedWorkGroupIds?.has(groupId);
          const hasManualCollapsed = input.expandedWorkGroupIds?.has(
            `work-group-collapsed:${groupId}`,
          );
          const defaultExpanded =
            visibleGroupedEntries.some((entry) =>
              isWorkEntryExplicitlyUserOpen(entry, input.explicitActivityCache),
            ) ||
            activityDecisions.isGroupAutoExpanded(
              groupId,
              visibleGroupedEntries.map((entry) => entry.id),
            );
          const expanded = hasManualExpanded ? true : hasManualCollapsed ? false : defaultExpanded;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          const liveSummary = summarizeToolGroup(visibleGroupedEntries);
          const latestThoughtEntry = visibleGroupedEntries.findLast(
            (entry) => entry.itemType === "reasoning" && (entry.detail?.trim() ?? "") !== "",
          );
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            activityAnchorId: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
            summary: liveSummary.summary,
            ...(liveSummary.diffStats ? { diffStats: liveSummary.diffStats } : {}),
            ...(groupCategory === "explore"
              ? { subline: explorationSubline(visibleGroupedEntries) }
              : {}),
            ...(latestThoughtEntry ? { thought: latestThoughtEntry } : {}),
          });
          // A lone thought renders its body in the live row already.
          if (
            expanded &&
            !(
              visibleGroupedEntries.length === 1 &&
              visibleGroupedEntries[0]?.itemType === "reasoning"
            )
          ) {
            nextRows.push(
              expandedWorkGroupRow(
                groupId,
                timelineEntry.createdAt,
                visibleGroupedEntries,
                activityDecisions,
              ),
            );
          }
        } else if (singleToolEntry !== null) {
          const step = singleStep(singleToolEntry);
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            activityAnchorId: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: [step.entry],
            isExpandedToolGroup: false,
            displayLabel: step.displayLabel,
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const hasManualExpanded = input.expandedWorkGroupIds?.has(groupId);
          const hasManualCollapsed = input.expandedWorkGroupIds?.has(
            `work-group-collapsed:${groupId}`,
          );
          const defaultExpanded =
            visibleGroupedEntries.some((entry) =>
              isWorkEntryExplicitlyUserOpen(entry, input.explicitActivityCache),
            ) ||
            activityDecisions.isGroupAutoExpanded(
              groupId,
              visibleGroupedEntries.map((entry) => entry.id),
            );
          const expanded = hasManualExpanded ? true : hasManualCollapsed ? false : defaultExpanded;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolSurface =
            primarySourceEntry?.toolSurface ??
            visibleGroupedEntries.findLast((entry) => entry.toolSurface !== undefined)?.toolSurface;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          const summaryToolIcon = usesSingleToolCallLabel
            ? resolveWorkEntryToolPresentation(singleEntry, "completed")?.icon
            : undefined;
          const groupSummary = summarizeToolGroup(visibleGroupedEntries);
          // Steps that each say what they are for share a tag only when they agree.
          let groupIntent: string | undefined;
          for (const entry of visibleGroupedEntries) {
            const intent = workLogEntryIsToolLike(entry)
              ? workEntryPresentation(entry).intent
              : undefined;
            if (intent === undefined || intent === groupIntent) continue;
            if (groupIntent !== undefined) {
              groupIntent = undefined;
              break;
            }
            groupIntent = intent;
          }
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            activityAnchorId: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : groupSummary.summary,
            ...(groupSummary.diffStats ? { diffStats: groupSummary.diffStats } : {}),
            summaryKind,
            ...(groupCategory === "explore" && visibleGroupedEntries.length > 1
              ? { subline: explorationSubline(visibleGroupedEntries) }
              : {}),
            ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            ...(summaryToolIcon ? { summaryToolIcon } : {}),
            ...(groupIntent ? { intent: groupIntent } : {}),
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(
                groupId,
                timelineEntry.createdAt,
                visibleGroupedEntries,
                activityDecisions,
              ),
            );
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "aperture-embed") {
      nextRows.push({
        kind: "aperture-embed",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        apertureEmbed: timelineEntry.apertureEmbed,
      });
      continue;
    }

    if (timelineEntry.kind === "mcp-app") {
      nextRows.push({
        kind: "mcp-app",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        itemId: timelineEntry.itemId,
        revision: timelineEntry.revision,
        mcpApp: timelineEntry.mcpApp,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const item = timelineEntry.projectedItem.item;
      if (item.type === "subagent") {
        const turnKey =
          subagentTurnKeyByEntryId.get(timelineEntry.id) ?? `entry:${timelineEntry.id}`;
        const group = subagentEventsByTurn.get(turnKey) ?? [timelineEntry];
        const groupAnchor = group[0];
        if (groupAnchor === undefined || groupAnchor.id !== timelineEntry.id) continue;
        const groupItem = groupAnchor.projectedItem.item;
        if (groupItem.type !== "subagent") continue;
        let taskCall: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> | undefined;
        const autoExpandedSubagentItemIds: string[] = [];
        for (const memberEntry of group) {
          const member = memberEntry.projectedItem.item;
          if (member.type !== "subagent") continue;
          if (
            member.parentItemId !== null &&
            taskCallsByItemId[member.parentItemId] !== undefined &&
            taskCall === undefined
          ) {
            taskCall = taskCallsByItemId[member.parentItemId];
          }
          if (activityDecisions.autoExpandedSubagentItemIds.has(String(member.id))) {
            autoExpandedSubagentItemIds.push(String(member.id));
          }
        }
        nextRows.push({
          kind: "event",
          id: groupAnchor.id,
          createdAt: groupAnchor.createdAt,
          projectedItem: groupAnchor.projectedItem,
          ...(group.length > 1
            ? { subagents: group.map(({ projectedItem }) => projectedItem) }
            : {}),
          autoExpanded: activityDecisions.isAutoExpanded(groupAnchor.id, groupItem.id),
          ...(autoExpandedSubagentItemIds.length > 0 ? { autoExpandedSubagentItemIds } : {}),
          ...(taskCall === undefined ? {} : { taskCall }),
        });
        agentGroupRowIndex = nextRows.length - 1;
        agentGroupFolded = false;
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        // Keep the work-to-event projection of a native wait on the same activity key.
        ...(isNativeWaitTool(item) ? { activityAnchorId: timelineEntry.id } : {}),
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
        autoExpanded: activityDecisions.isAutoExpanded(timelineEntry.id, item.id),
      });
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      turnRecap: turnRecapByEntryId.get(timelineEntry.id),
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      ...(timelineEntry.message.role === "user" && planByUserMessageEntryId.has(timelineEntry.id)
        ? {
            plan: planByUserMessageEntryId.get(timelineEntry.id),
            planRunLive: planRunLiveByUserMessageEntryId.get(timelineEntry.id),
          }
        : {}),
    });
  }

  // Until the agent's turn is live, the setup card sits under the send with
  // the working header above it (the header reads "Setting up worktree…" and
  // later swaps its text in place, so nothing moves at the handoff). "Live"
  // means the turn is in the timeline, not just that the server dispatched
  // it: the card must not vanish in the gap between. Once the turn is live
  // the stage list leaves the timeline; a script that is still running is
  // surfaced by the working header itself. A failed or cancelled setup stays
  // under the send so its outcome and actions remain reachable.
  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  // A finished setup keeps the slot until the turn is live, so the card does
  // not jump above the working header in the gap before the run starts.
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    // While the setup runs, the working header leads the card in the same
    // slot it keeps once the agent's own turn takes over. The main pass may
    // already have placed that header (a bootstrap counts as working).
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
                workCompletedAt: null,
                status: "working",
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  // A setup that owns the working slot sits under it and shows no activity
  // row of its own; every other state gets the usual tail.
  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (hasActiveStatus && !hasWorkingRow && activitySlotIndex === timelineEntries.length) {
    appendWorkingRow();
  }

  const result = attachTrailingToolGroupsToAssistant(
    attachCreatedThreadSummaries(nextRows, timelineEntries),
  );
  return result.map((row, index) =>
    timelineRowIsWorkLog(row) && timelineRowIsWorkLog(result[index + 1])
      ? { ...row, continuesWorkLog: true }
      : row,
  );
}

/** Adjacent work stays one visual list even when virtualization splits its groups. */
function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "work-live" ||
      row.kind === "todo-update")
  );
}

// Keep created chats below the final answer even when the work that created them folds away.
function attachCreatedThreadSummaries(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  const collapsedRuns = new Set<RunId>();
  const createdByRun = new Map<RunId, Array<Extract<MessagesTimelineRow, { kind: "event" }>>>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
    if (row.kind === "turn-fold" && !row.expanded) collapsedRuns.add(row.runId);
  }
  for (const entry of timelineEntries) {
    const projectedItem =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projectedItem?.item.type === "thread_created" && projectedItem.item.runId) {
      const runId = projectedItem.item.runId;
      const entries = createdByRun.get(runId) ?? [];
      entries.push({ kind: "event", id: entry.id, createdAt: entry.createdAt, projectedItem });
      createdByRun.set(runId, entries);
    }
  }
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (terminalIndex !== undefined && (collapsedRuns.has(runId!) || index > terminalIndex))
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      return [
        row,
        ...(createdByRun.get(row.message.runId) ?? []).map((entry) => ({
          ...entry,
          id: `summary:${entry.id}`,
          resourceSummary: true,
        })),
      ];
    }
    return [row];
  });
}

const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";

type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    pendingApprovalRequestIds: previousPendingApprovalRequestIds,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    pendingApprovalRequestIds,
    ...context
  } = input;
  // V2 shell and checkpoint selectors produce fresh summaries for each event.
  // Equivalent summaries must not invalidate a text-only projection.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !shallow(previousPendingApprovalRequestIds, pendingApprovalRequestIds) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (const [index, entry] of timelineEntries.entries()) {
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (isWorkflowAdvancement(previousEntry) !== isWorkflowAdvancement(entry)) return null;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

/** Keep one projection per timeline. Reuse rows only when streaming content changes. */
export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  // The anchor is the list key: a reused row must not keep a previous activity's.
  if (a.kind !== b.kind || a.id !== b.id || a.activityAnchorId !== b.activityAnchorId) {
    return false;
  }

  switch (a.kind) {
    case "working": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.workCompletedAt === bw.workCompletedAt &&
        a.status === bw.status
      );
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "attempt-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return a.createdAt === bc.createdAt && a.label === bc.label && a.active === bc.active;
    }

    case "todo-update": {
      // Changes are rebuilt on every derive; a few short records compare by value.
      const bt = b as typeof a;
      return (
        a.createdAt === bt.createdAt &&
        a.live === bt.live &&
        JSON.stringify(a.changes) === JSON.stringify(bt.changes)
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Entries rebuild on any tool update; an equal page must keep its mounted frame.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "aperture-embed": {
      // The server issues a fresh refId per render, so equal ids keep the frame and its live stream.
      const ba = b as typeof a;
      return (
        a.createdAt === ba.createdAt &&
        a.sourceThreadId === ba.sourceThreadId &&
        a.apertureEmbed.refId === ba.apertureEmbed.refId
      );
    }

    case "mcp-app": {
      // Same reason: an equal app keeps its live frame and its state.
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.revision === bm.revision &&
        mcpAppReferencesEqual(a.mcpApp, bm.mcpApp)
      );
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.autoExpanded === (b as typeof a).autoExpanded &&
        a.taskCall === (b as typeof a).taskCall &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents) &&
        Equal.equals(a.absorbedNotices, (b as typeof a).absorbedNotices)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.subline === bw.subline &&
        a.summaryKind === bw.summaryKind &&
        a.toolSurface === bw.toolSurface &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure &&
        a.intent === bw.intent
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        // Recaps are rebuilt on every derive; a few short records compare by value.
        JSON.stringify(a.turnRecap) === JSON.stringify(bm.turnRecap) &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.plan === bm.plan &&
        a.planRunLive === bm.planRunLive
      );
    }
  }
}
