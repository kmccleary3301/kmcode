import { use, useEffect, useId, useMemo, useState } from "react";
import * as DateTime from "effect/DateTime";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleXIcon,
  Loader2Icon,
  RotateCwIcon,
} from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type { ResolvedSubagentLifecycle } from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveSubagentLifecycle } from "@t3tools/client-runtime/state/subagentRuntime";
import { subagentDisplayName } from "@t3tools/client-runtime/state/subagent-display";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import { cn } from "~/lib/utils";
import type { ToolVerbObject } from "@t3tools/client-runtime/work-log/presentation";
import { childThreadStep, useChildThreadLiveStep } from "./childThreadSteps";
import {
  MinimalSubagentDetails,
  MinimalSubagentGroup,
  plainDetail,
  SubagentAvatar,
  SubagentElapsed,
  subagentJsonResultSummary,
  subagentResultDetail,
} from "./V2LifecycleRow";
import { formatNativeDuration } from "./subagentHookFormat";
import { AsciiLoader } from "../ui/ascii-loader";
import { TerminalSpinner } from "../ui/terminal-spinner";
import { TranscriptStyleCtx } from "./transcriptStyle";
import ChatMarkdown from "../ChatMarkdown";
import { ActivityDisclosurePanel } from "./ActivityDisclosure";
import { useChangedSinceMount, useSmoothHeight } from "~/lib/motion";
import { useHeldSubagentActivity } from "./useHeldSubagentActivity";
import { RollingText } from "./RollingText";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { ShimmerLayers } from "../ui/shimmer";
import {
  LiveViewPausedNote,
  useSubagentLiveContent,
} from "../../hooks/useSubagentLiveContent";

export type SubagentTaskTrackerMember = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

type NativeCurrentTool = NonNullable<OrchestrationV2Subagent["currentTool"]>;
type NativeRetry = NonNullable<OrchestrationV2Subagent["retry"]>;
type NativeMetrics = NonNullable<OrchestrationV2Subagent["metrics"]>;

type SystemNoticeItem = Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;
type SubagentJobCompletion = NonNullable<SystemNoticeItem["jobCompletion"]>;

type SubagentIrcNotice = {
  readonly from: string;
  readonly to: string;
  readonly body: string;
};

type ResolvedMember = {
  readonly item: SubagentTaskTrackerMember;
  readonly lifecycle: ResolvedSubagentLifecycle;
  readonly title: string;
  readonly task: string;
  readonly agentType: string | undefined;
  readonly nativeAgentId: string | undefined;
  readonly model: string | null;
  readonly currentTool: NativeCurrentTool | null | undefined;
  readonly completionPercent: number | undefined;
  readonly retry: NativeRetry | null | undefined;
  readonly metrics: NativeMetrics | undefined;
  readonly progress: string | undefined;
  readonly result: string | null;
  readonly recentOutput: SubagentTaskTrackerMember["liveContent"] | undefined;
};

/** How long minimal keeps the delegation card up after the last agent settles. */
const MINIMAL_SETTLE_HOLD_MS = 700;

const SUBAGENT_STATUS: Record<
  SubagentTaskTrackerMember["status"],
  { readonly label: string; readonly icon: typeof CircleDashedIcon }
> = {
  pending: { label: "Queued", icon: CircleDashedIcon },
  running: { label: "Running", icon: Loader2Icon },
  waiting: { label: "Waiting", icon: CircleDashedIcon },
  idle: { label: "Idle", icon: CircleDashedIcon },
  completed: { label: "Completed", icon: CheckIcon },
  failed: { label: "Failed", icon: CircleXIcon },
  cancelled: { label: "Cancelled", icon: RotateCwIcon },
  interrupted: { label: "Aborted", icon: RotateCwIcon },
};

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

function snapshotMatchesLiveAttempt(
  item: SubagentTaskTrackerMember,
  live: OrchestrationV2Subagent | null,
): boolean {
  if (live === null) return true;
  const itemStart = isoOrNull(item.startedAt);
  const lifecycle = resolveSubagentLifecycle(
    {
      status: item.status,
      startedAt: itemStart,
      completedAt: isoOrNull(item.completedAt),
    },
    {
      status: live.status,
      startedAt: isoOrNull(live.startedAt),
      completedAt: isoOrNull(live.completedAt),
    },
  );
  return itemStart !== null && lifecycle.startedAt === itemStart;
}

function resolveReported<T>(
  liveValue: T | undefined,
  snapshotValue: T | undefined,
  snapshotMatchesAttempt: boolean,
): T | undefined {
  if (liveValue !== undefined) return liveValue;
  return snapshotMatchesAttempt ? snapshotValue : undefined;
}

function resolveNativeMetrics(
  liveMetrics: NativeMetrics | undefined,
  snapshotMetrics: NativeMetrics | undefined,
  snapshotMatchesAttempt: boolean,
): NativeMetrics | undefined {
  if (!snapshotMatchesAttempt || snapshotMetrics === undefined) return liveMetrics;
  if (liveMetrics === undefined) return snapshotMetrics;
  return {
    toolCount: liveMetrics.toolCount ?? snapshotMetrics.toolCount,
    requests: liveMetrics.requests ?? snapshotMetrics.requests,
    tokens: liveMetrics.tokens ?? snapshotMetrics.tokens,
    contextTokens: liveMetrics.contextTokens ?? snapshotMetrics.contextTokens,
    contextWindow: liveMetrics.contextWindow ?? snapshotMetrics.contextWindow,
    cost: liveMetrics.cost ?? snapshotMetrics.cost,
  };
}

function resolveMember(
  item: SubagentTaskTrackerMember,
  live: OrchestrationV2Subagent | null,
): ResolvedMember {
  const lifecycle = resolveSubagentLifecycle(
    {
      status: item.status,
      startedAt: isoOrNull(item.startedAt),
      completedAt: isoOrNull(item.completedAt),
    },
    live
      ? {
          status: live.status,
          startedAt: isoOrNull(live.startedAt),
          completedAt: isoOrNull(live.completedAt),
        }
      : undefined,
  );
  const snapshotMatchesAttempt = snapshotMatchesLiveAttempt(item, live);
  const title =
    subagentDisplayName({
      driver: item.driver,
      nativeAgentId: live?.nativeAgentId ?? item.nativeAgentId,
      title: live?.title || item.title,
    }) ?? "Subagent";
  return {
    item,
    lifecycle,
    title,
    task: live?.prompt ?? (snapshotMatchesAttempt ? item.prompt : ""),
    agentType: resolveReported(live?.agentType, item.agentType, snapshotMatchesAttempt),
    nativeAgentId: resolveReported(live?.nativeAgentId, item.nativeAgentId, snapshotMatchesAttempt),
    model: resolveReported(live?.model, item.model, snapshotMatchesAttempt)?.trim() || null,
    currentTool:
      lifecycle.status !== "pending" && isOrchestrationV2WorkActive(lifecycle.status)
        ? resolveReported(live?.currentTool, item.currentTool, snapshotMatchesAttempt)
        : undefined,
    completionPercent: resolveReported(
      live?.completionPercent,
      item.completionPercent,
      snapshotMatchesAttempt,
    ),
    retry: resolveReported(live?.retry, item.retry, snapshotMatchesAttempt),
    metrics: resolveNativeMetrics(live?.metrics, item.metrics, snapshotMatchesAttempt),
    progress: live?.progress ?? (snapshotMatchesAttempt ? item.progress : undefined),
    result: live === null ? (snapshotMatchesAttempt ? item.result : null) : live.result,
    recentOutput: snapshotMatchesAttempt ? item.liveContent : undefined,
  };
}

function boundedText(value: string, limit = 600): string {
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

const nativeIntegerFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nativeCostFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function taskContextFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("context" in input)) return undefined;
  const context = input.context;
  return typeof context === "string" && context.trim().length > 0 ? context : undefined;
}

function formatContextMetric(metrics: NativeMetrics | undefined): string | undefined {
  if (!metrics) return undefined;
  const contextTokens = metrics.contextTokens;
  const contextWindow = metrics.contextWindow;
  if (contextTokens !== undefined && contextWindow !== undefined) {
    if (contextWindow > 0) {
      const pct = Math.round((contextTokens / contextWindow) * 100);
      return `ctx ${pct}%`;
    }
    return `${nativeIntegerFormatter.format(contextTokens)} used / ${nativeIntegerFormatter.format(contextWindow)} window`;
  }
  if (contextTokens !== undefined) {
    return `${nativeIntegerFormatter.format(contextTokens)} ctx`;
  }
  if (contextWindow !== undefined) {
    return `${nativeIntegerFormatter.format(contextWindow)} window`;
  }
  return undefined;
}

function formatMetricFooterLine(member: ResolvedMember, includeModel = true): string | null {
  const parts: string[] = [];
  if (includeModel && member.model) parts.push(member.model);
  if (member.metrics?.tokens !== undefined) {
    const kTokens =
      member.metrics.tokens >= 1_000
        ? `${(member.metrics.tokens / 1_000).toFixed(1)}k tokens`
        : `${member.metrics.tokens} tokens`;
    parts.push(kTokens);
  }
  const context = formatContextMetric(member.metrics);
  if (context) parts.push(context);
  if (member.metrics?.cost !== undefined) {
    parts.push(nativeCostFormatter.format(member.metrics.cost));
  }
  if (member.completionPercent !== undefined) {
    parts.push(`${member.completionPercent}%`);
  }
  if (member.metrics?.toolCount !== undefined) {
    parts.push(`${nativeIntegerFormatter.format(member.metrics.toolCount)} tool calls`);
  }
  if (member.metrics?.requests !== undefined) {
    parts.push(`${nativeIntegerFormatter.format(member.metrics.requests)} requests`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function matchJobCompletion(
  member: ResolvedMember,
  completions?: ReadonlyArray<SubagentJobCompletion>,
): SubagentJobCompletion | undefined {
  if (!completions || completions.length === 0) return undefined;
  const memberId = String(member.item.subagentId).toLowerCase();
  const nativeId = member.nativeAgentId?.toLowerCase();
  const title = member.title.toLowerCase();
  return completions.find((job) => {
    const jid = job.jobId.toLowerCase();
    if (jid === memberId || (nativeId && jid === nativeId)) return true;
    if (
      job.agentId &&
      (job.agentId.toLowerCase() === memberId ||
        (nativeId && job.agentId.toLowerCase() === nativeId))
    )
      return true;
    if (job.label && job.label.toLowerCase() === title) return true;
    return false;
  });
}

/** Whether a notice's sender names this agent by id, native id, title, or role. */
function noticeIsFromMember(notice: SubagentIrcNotice, member: ResolvedMember): boolean {
  const from = notice.from.trim().toLowerCase();
  return (
    from === String(member.item.subagentId).toLowerCase() ||
    from === member.nativeAgentId?.toLowerCase() ||
    from === member.title.toLowerCase() ||
    from === member.agentType?.toLowerCase()
  );
}

export function SubagentTaskTracker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly members: ReadonlyArray<SubagentTaskTrackerMember>;
  readonly autoExpandedDetailsItemIds?: ReadonlyArray<string> | undefined;
  readonly taskCall?: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> | undefined;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly detailsExpansionCache?: Set<string> | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** IRC and job notices absorbed into this group instead of standalone rows. */
  readonly notices?: ReadonlyArray<SystemNoticeItem> | undefined;
}) {
  const transcriptStyle = use(TranscriptStyleCtx);
  const isTerminal = transcriptStyle === "terminal";
  const isKm = transcriptStyle === "km";
  const panelId = useId();
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => thread?.projection.subagents,
  );
  const members = props.members.map((item) => {
    const live = liveAgents?.find((agent) => agent.id === item.subagentId) ?? null;
    return resolveMember(item, live);
  });

  const [expandedDetails, setExpandedDetails] = useState<ReadonlyMap<string, boolean>>(() => {
    const preferences = new Map<string, boolean>();
    for (const { subagentId } of props.members) {
      const id = String(subagentId);
      if (props.detailsExpansionCache?.has(`subagent-details:${id}`)) {
        preferences.set(id, true);
      } else if (props.detailsExpansionCache?.has(`subagent-details-collapsed:${id}`)) {
        preferences.set(id, false);
      }
    }
    return preferences;
  });
  const setDetailsExpanded = (subagentId: string, open: boolean) => {
    const cacheKey = `subagent-details:${subagentId}`;
    const collapsedCacheKey = `subagent-details-collapsed:${subagentId}`;
    if (open) {
      props.detailsExpansionCache?.delete(collapsedCacheKey);
      props.detailsExpansionCache?.add(cacheKey);
    } else {
      props.detailsExpansionCache?.delete(cacheKey);
      props.detailsExpansionCache?.add(collapsedCacheKey);
    }
    setExpandedDetails((current) => {
      if (current.get(subagentId) === open) return current;
      const next = new Map(current);
      next.set(subagentId, open);
      return next;
    });
  };

  const taskCall = props.taskCall;
  const isNativeTaskCall = taskCall?.toolName?.trim().toLowerCase() === "task";
  const taskCallId = isNativeTaskCall && taskCall ? String(taskCall.id) : null;
  const sharedContext =
    isNativeTaskCall && taskCall ? taskContextFromInput(taskCall.input) : undefined;

  const ircNotices: SubagentIrcNotice[] = [];
  const jobCompletions: SubagentJobCompletion[] = [];
  for (const notice of props.notices ?? []) {
    if (notice.irc) ircNotices.push({ ...notice.irc, body: notice.message });
    if (notice.jobCompletion) jobCompletions.push(notice.jobCompletion);
  }
  const runningCount = members.filter(({ lifecycle }) =>
    isOrchestrationV2WorkActive(lifecycle.status),
  ).length;
  const anyActive = runningCount > 0;
  const doneCount = members.filter(({ lifecycle }) => lifecycle.status === "completed").length;
  const failedCount = members.filter(({ lifecycle }) => lifecycle.status === "failed").length;
  const noun = members.length === 1 ? "agent" : "agents";
  const headerTitle = [
    `${members.length} ${noun}`,
    runningCount > 0 ? `${runningCount} running` : "",
    doneCount > 0 ? `${doneCount} done` : "",
    failedCount > 0 ? `${failedCount} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // Notices whose sender is not one of these agents stay visible in the group footer.
  const unmatchedIrcNotices = ircNotices.filter(
    (notice) => !members.some((member) => noticeIsFromMember(notice, member)),
  );
  const panelKey = `subagent-task-tracker-${panelId}`;
  const titleChanged = useChangedSinceMount(headerTitle);

  // KM and Minimal keep the card up for a beat after the last agent settles,
  // so its check lands before the card blurs away (about 0.7s in the recording).
  const [settleHold, setSettleHold] = useState(false);
  const [wasActive, setWasActive] = useState(anyActive);
  if (wasActive !== anyActive) {
    setWasActive(anyActive);
    setSettleHold(!anyActive);
  }
  useEffect(() => {
    if (!settleHold) return;
    const timer = setTimeout(() => setSettleHold(false), MINIMAL_SETTLE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [settleHold]);

  const trackerExpanded = isTerminal || props.expanded || settleHold;
  const leadMember = members[0];
  const agentNames =
    members.length > 2
      ? `${leadMember?.title} and ${members.length - 1} others`
      : [leadMember?.title, members[1]?.title].filter(Boolean).join(" and ");
  const leadProvider = props.providerStatuses.find(
    (provider) => provider.instanceId === leadMember?.item.providerInstanceId,
  );
  const memberRows = members.map((member) => {
    const id = String(member.item.subagentId);
    const matchedJob = matchJobCompletion(member, jobCompletions);
    const memberIrcNotices = ircNotices.filter((notice) => noticeIsFromMember(notice, member));
    return (
      <SubagentTaskRow
        key={id}
        environmentId={props.environmentId}
        member={member}
        provider={props.providerStatuses.find(
          (provider) => provider.instanceId === member.item.providerInstanceId,
        )}
        detailsPreference={expandedDetails.get(id)}
        autoExpanded={props.autoExpandedDetailsItemIds?.includes(String(member.item.id)) ?? false}
        onDetailsExpandedChange={(open) => setDetailsExpanded(id, open)}
        onOpenThread={props.onOpenThread}
        ircNotices={memberIrcNotices}
        jobCompletion={matchedJob}
      />
    );
  });
  const unmatchedNoticeRows =
    unmatchedIrcNotices.length > 0 ? (
      <div className="space-y-1 px-3 py-2 text-2xs text-muted-foreground">
        {unmatchedIrcNotices.map((irc, index) => (
          <p key={index} className="truncate border-l-2 border-border/60 pl-2">
            <span className="font-medium text-foreground/80">{irc.from}</span> “{irc.body}”
          </p>
        ))}
      </div>
    ) : null;

  const terminalHeaderContent = (
    <>
      <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
        {members.slice(0, 3).map(({ item }) => (
          <SubagentAvatar
            key={item.subagentId}
            driver={item.driver}
            provider={props.providerStatuses.find(
              (provider) => provider.instanceId === item.providerInstanceId,
            )}
          />
        ))}
        {members.length > 3 ? (
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground ring-1 ring-background">
            +{members.length - 3}
          </span>
        ) : null}
      </span>
      <span
        key={headerTitle}
        className={cn(
          "block min-w-0 flex-1 truncate text-xs font-semibold motion-tint",
          titleChanged && "motion-swap-text",
        )}
      >
        {headerTitle}
      </span>
    </>
  );

  return (
    <section
      data-subagent-task-tracker
      data-native-task-call={taskCallId ?? undefined}
      data-terminal-subagent-tracker={isTerminal ? "true" : undefined}
      className={
        isTerminal
          ? "min-w-0 rounded-lg border border-border/60 bg-muted/20 overflow-hidden"
          : "min-w-0"
      }
    >
      {isTerminal ? (
        <>
          <div
            role="heading"
            aria-level={3}
            className="flex min-h-9 w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-foreground transition-colors motion-tint"
          >
            {terminalHeaderContent}
          </div>
          <ActivityDisclosurePanel open={trackerExpanded} id={panelKey} className="min-w-0">
            <div className="border-t border-border/40 divide-y divide-border/25">
              {taskCallId && sharedContext !== undefined ? (
                <NativeTaskContext key={taskCallId} context={sharedContext} />
              ) : null}
              {memberRows}
              {unmatchedNoticeRows}
            </div>
          </ActivityDisclosurePanel>
        </>
      ) : (
        <MinimalSubagentGroup
          names={agentNames}
          active={anyActive}
          driver={leadMember?.item.driver}
          provider={leadProvider}
          expanded={trackerExpanded}
          onExpandedChange={(expanded) => {
            setSettleHold(false);
            props.onExpandedChange(expanded);
          }}
        >
          {memberRows}
          {unmatchedNoticeRows}
        </MinimalSubagentGroup>
      )}
    </section>
  );
}

/** Terminal's shared Task context: the first lines, then the rest on request. */
function NativeTaskContext(props: { readonly context: string }) {
  const contextLines = props.context.replace(/\r/g, "").split("\n");
  const [contextExpanded, setContextExpanded] = useState(false);
  const contextPreviewLimit = 3;
  const hiddenContextLineCount = Math.max(0, contextLines.length - contextPreviewLimit);
  const contextText = contextExpanded
    ? props.context
    : contextLines.slice(0, contextPreviewLimit).join("\n");
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLDivElement>(false);
  return (
    <div data-native-task-context className="border-b border-border/30 px-3 py-2 text-xs">
      <span className="text-2xs font-medium text-muted-foreground">Shared context</span>
      <div ref={outerRef} className="overflow-hidden">
        <div ref={contentRef}>
          <div
            role="region"
            aria-label="Shared Task context"
            className="mt-1 text-2xs text-muted-foreground"
          >
            <ChatMarkdown
              text={contextText}
              cwd={undefined}
              parseRawHtml={false}
              className="text-2xs text-muted-foreground leading-[inherit]"
            />
            {hiddenContextLineCount > 0 ? (
              <button
                type="button"
                className="terminal-preview-more"
                aria-label={`Expand ${hiddenContextLineCount} more lines`}
                onClick={() => setContextExpanded(true)}
              >
                … {hiddenContextLineCount} more lines
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SubagentTaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly member: ResolvedMember;
  readonly provider: ServerProvider | undefined;
  readonly detailsPreference: boolean | undefined;
  readonly autoExpanded: boolean;
  readonly onDetailsExpandedChange: (open: boolean) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly ircNotices?: ReadonlyArray<SubagentIrcNotice> | undefined;
  readonly jobCompletion?: SubagentJobCompletion | undefined;
}) {
  const detailsId = useId();
  const transcriptStyle = use(TranscriptStyleCtx);
  const isTerminal = transcriptStyle === "terminal";
  const isKm = transcriptStyle === "km";
  const { item, lifecycle, title } = props.member;
  const { liveContent: overlayLiveContent, rateLimited } = useSubagentLiveContent(
    scopeThreadRef(props.environmentId, item.threadId),
    {
      active: isOrchestrationV2WorkActive(lifecycle.status),
      subagentId: item.subagentId,
      turnItemId: item.id,
      persisted: props.member.recentOutput,
    },
  );
  const status = SUBAGENT_STATUS[lifecycle.status];
  const childThreadId = item.childThreadId;
  const result = props.member.result?.trim();
  const progress = props.member.progress?.trim();
  const liveContent = overlayLiveContent;
  const [terminalOutputExpanded, setTerminalOutputExpanded] = useState(false);
  const terminalOutputPreviewLimit = 3;
  const terminalOutputLines = useMemo(
    () => (isTerminal && liveContent ? liveContent.text.replace(/\r/g, "").split("\n") : null),
    [isTerminal, liveContent],
  );
  const hiddenTerminalOutputLineCount =
    terminalOutputLines === null
      ? 0
      : Math.max(0, terminalOutputLines.length - terminalOutputPreviewLimit);
  const terminalOutputText =
    terminalOutputLines !== null && !terminalOutputExpanded
      ? terminalOutputLines.slice(0, terminalOutputPreviewLimit).join("\n")
      : (liveContent?.text ?? "");
  const currentTool = props.member.currentTool;
  const retry = props.member.retry;
  const nativeAgentId = props.member.nativeAgentId?.trim();
  const agentType = props.member.agentType?.trim();
  const percent = props.member.completionPercent;
  const elapsedLifecycle =
    lifecycle.status === "pending"
      ? { ...lifecycle, startedAt: null, completedAt: null }
      : lifecycle;

  const isCompleted = lifecycle.status === "completed";
  const isFailed = lifecycle.status === "failed";
  const isActive = isOrchestrationV2WorkActive(lifecycle.status);
  const [enteredLive] = useState(isActive);
  const detailsExpanded =
    isTerminal || (props.detailsPreference ?? (isKm && (isActive || props.autoExpanded)));
  const childLiveStep = useChildThreadLiveStep(
    props.environmentId,
    isActive && !currentTool ? childThreadId : null,
  );
  const statusChanged = useChangedSinceMount(lifecycle.status);

  const resultFirstLine = result ? result.split(/\r?\n/)[0]?.trim() : null;
  const taskFirstLine = props.member.task ? props.member.task.split(/\r?\n/)[0]?.trim() : null;
  const summaryLine =
    isCompleted && resultFirstLine ? resultFirstLine : (taskFirstLine ?? resultFirstLine);
  const minimalResultLine = useMemo(
    () => (!isTerminal && result ? subagentResultDetail(result) : null),
    [isTerminal, result],
  );
  const modelLabel = props.member.model?.trim() || props.provider?.displayName?.trim() || null;
  const heldActivity = useHeldSubagentActivity({
    status: lifecycle.status,
    currentTool,
    childLiveStep,
    liveContent,
    progress,
    task: props.member.task,
  });
  const liveActivity = heldActivity.latestText;
  const metricFooter = formatMetricFooterLine(props.member);
  const minimalMetricFooter = formatMetricFooterLine(props.member, false);
  const activityKey = isActive ? heldActivity.key : summaryLine;
  const activityLineChanged = useChangedSinceMount(activityKey);
  // Minimal swaps only when the held step changes, not while its arguments stream.
  const minimalActivityLine = isActive
    ? plainDetail(heldActivity.text) || null
    : (minimalResultLine ?? (isFailed ? "Failed" : null));
  const minimalActivityLineChanged = useChangedSinceMount(
    isActive ? activityKey : minimalActivityLine,
  );

  // Minimal rolls the whole line when an agent finishes: the working line
  // leaves up into a blur, the finished one rises in, and the glyph resolves.
  const lineKey = isActive ? "active" : lifecycle.status;
  const lineKeyChanged = useChangedSinceMount(lineKey);
  const [lineRoll, setLineRoll] = useState<{
    readonly key: string;
    readonly active: boolean;
    readonly activity: string | null | undefined;
    readonly leaving: {
      readonly active: boolean;
      readonly activity: string | null | undefined;
    } | null;
  }>({ key: lineKey, active: isActive, activity: minimalActivityLine, leaving: null });
  if (lineRoll.key !== lineKey || lineRoll.activity !== minimalActivityLine) {
    setLineRoll({
      key: lineKey,
      active: isActive,
      activity: minimalActivityLine,
      // Reduced motion hides the leaving line in CSS; otherwise its exit
      // animation ending removes it.
      leaving:
        lineRoll.key !== lineKey
          ? { active: lineRoll.active, activity: lineRoll.activity }
          : lineRoll.leaving,
    });
  }

  const rowPanels = (
    <>
      {/* IRC quoted line inside sender's row */}
      <ActivityDisclosurePanel open={Boolean(props.ircNotices && props.ircNotices.length > 0)}>
        {props.ircNotices && props.ircNotices.length > 0 ? (
          <div className="pl-5 pt-1 text-2xs text-muted-foreground italic border-l-2 border-border/60 ml-2 my-1">
            {props.ircNotices.map((irc, idx) => (
              <p key={idx} className="truncate">
                “{irc.body}”
              </p>
            ))}
          </div>
        ) : null}
      </ActivityDisclosurePanel>

      {/* Opened row details */}
      <ActivityDisclosurePanel
        open={detailsExpanded}
        id={detailsId}
        className={cn(
          "minimal-agent-details min-w-0",
          item.origin === "app_owned" && !isTerminal && "minimal-agent-details-has-provider",
        )}
      >
        {isTerminal ? (
          <div className="mt-2 pl-5 space-y-2 text-2xs border-t border-border/20 pt-2">
            {nativeAgentId ? (
              <p className="text-3xs text-muted-foreground">ID: {nativeAgentId}</p>
            ) : null}

            {props.member.task.trim() ? (
              <div className="space-y-0.5">
                <span className="font-medium text-foreground/80">Task</span>
                <ChatMarkdown
                  text={props.member.task}
                  cwd={undefined}
                  parseRawHtml={false}
                  className="text-muted-foreground text-2xs leading-[inherit]"
                />
              </div>
            ) : null}

            {isActive || progress ? (
              <div>
                <span className="font-medium text-foreground/80">Progress: </span>
                <span className="text-muted-foreground">{isActive ? liveActivity : progress}</span>
              </div>
            ) : null}

            <ActivityDisclosurePanel open={Boolean(retry)}>
              {retry ? (
                <div data-native-retry className="text-muted-foreground">
                  Retry attempt {retry.attempt}
                  {retry.delayMs !== undefined ? ` · ${formatNativeDuration(retry.delayMs)}` : ""}
                  {retry.message ? `: ${retry.message}` : ""}
                </div>
              ) : null}
            </ActivityDisclosurePanel>

            {liveContent ? (
              <div className="space-y-0.5">
                <span className="font-medium text-muted-foreground text-3xs">Recent output</span>
                <ChatMarkdown
                  text={terminalOutputText}
                  cwd={undefined}
                  parseRawHtml={false}
                  isStreaming={isActive}
                  className="rounded bg-muted/40 p-2 text-foreground/90 text-2xs leading-[inherit]"
                />
                {hiddenTerminalOutputLineCount > 0 ? (
                  <button
                    type="button"
                    className="terminal-preview-more"
                    aria-label={`Expand ${hiddenTerminalOutputLineCount} more lines`}
                    onClick={() => setTerminalOutputExpanded(true)}
                  >
                    … {hiddenTerminalOutputLineCount} more lines
                  </button>
                ) : null}
              </div>
            ) : isActive && rateLimited ? (
              <div className="space-y-0.5">
                <span className="font-medium text-muted-foreground text-3xs">Recent output</span>
                <LiveViewPausedNote />
              </div>
            ) : null}

            {result ? (
              <div className="space-y-0.5">
                <span className="font-medium text-foreground/80">{isFailed ? "Error" : "Result"}</span>
                <ChatMarkdown
                  text={result}
                  cwd={undefined}
                  parseRawHtml={false}
                  className="text-foreground/90 text-2xs leading-[inherit]"
                />
              </div>
            ) : null}

            {childThreadId !== null ? (
              <ChildThreadStepsView
                environmentId={props.environmentId}
                childThreadId={childThreadId}
                onOpenThread={props.onOpenThread}
              />
            ) : null}

            {metricFooter ? (
              <p
                data-native-agent-metrics
                className="text-3xs text-muted-foreground tabular-nums pt-1 border-t border-border/30"
              >
                {metricFooter}
              </p>
            ) : null}
          </div>
        ) : (<>
          <MinimalSubagentDetails
            title={title}
            task={props.member.task}
            active={isActive}
            rowActivity={isActive ? plainDetail(liveActivity) : null}
            liveStep={isActive ? childLiveStep ?? progress ?? null : null}
            liveContent={
              isActive && liveContent?.kind === "assistant" ? boundedText(liveContent.text) : null
            }
            result={!isActive && result ? (subagentJsonResultSummary(result) ?? result) : null}
            failed={isFailed}
            model={props.member.model ?? null}
            metadata={minimalMetricFooter}
            threadId={childThreadId}
            onOpenThread={props.onOpenThread}
          />
          {isActive && rateLimited ? (
            <div className="mt-1 text-3xs text-muted-foreground">
              <LiveViewPausedNote />
            </div>
          ) : null}
        </>)}
      </ActivityDisclosurePanel>
    </>
  );

  if (!isTerminal) {
    const rowContent = (
      <>
        <span
          key={lineKey}
          className={cn("minimal-agent-glyph", lineKeyChanged && "minimal-agent-glyph-in")}
          aria-hidden="true"
        >
          {isActive ? (
            <AsciiLoader />
          ) : isCompleted ? (
            <CheckIcon />
          ) : isFailed ||
            lifecycle.status === "interrupted" ||
            lifecycle.status === "cancelled" ? (
            <CircleXIcon className={isFailed ? "status-failed-mark" : undefined} />
          ) : (
            <CircleDashedIcon />
          )}
        </span>
        {item.origin === "app_owned" ? (
          <span className="minimal-agent-provider" aria-hidden="true">
            <ProviderInstanceIcon
              driverKind={item.driver}
              displayName={props.provider?.displayName ?? item.driver}
              acpRegistryIconUrl={props.provider?.iconUrl}
              iconClassName="size-3.5"
            />
          </span>
        ) : null}
        <span
          key={`${lineKey}-line`}
          ref={isActive ? observeVisibleAnimation : undefined}
          className={cn(
            "minimal-agent-text",
            lineKeyChanged && "minimal-agent-roll-in",
            isActive && "cursor-subagent-shimmer",
          )}
        >
          <ShimmerLayers active={isActive} copyClassName="minimal-agent-text">
            <span className="minimal-agent-title">{title}</span>
            {minimalActivityLine ? (
              <span
                key={isActive ? "live" : activityKey}
                className={cn(
                  "minimal-agent-activity",
                  isFailed && "minimal-agent-activity-failed",
                  !isActive && minimalActivityLineChanged && "motion-swap-text",
                )}
              >
                {isActive ? <RollingText text={minimalActivityLine} /> : minimalActivityLine}
              </span>
            ) : null}
          </ShimmerLayers>
        </span>
        {lineRoll.leaving ? (
          <span key={`${lineKey}-leaving`} className="minimal-agent-leaving" aria-hidden="true">
            <span className="minimal-agent-glyph">
              {lineRoll.leaving.active ? <AsciiLoader /> : null}
            </span>
            {item.origin === "app_owned" ? (
              <span className="minimal-agent-provider">
                <ProviderInstanceIcon
                  driverKind={item.driver}
                  displayName={props.provider?.displayName ?? item.driver}
                  acpRegistryIconUrl={props.provider?.iconUrl}
                  iconClassName="size-3.5"
                />
              </span>
            ) : null}
            <span
              className="minimal-agent-text"
              onAnimationEnd={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  event.animationName !== "minimal-line-out"
                ) {
                  return;
                }
                setLineRoll((current) => ({ ...current, leaving: null }));
              }}
            >
              <span className="minimal-agent-title">{title}</span>
              {lineRoll.leaving.activity ? (
                <span className="minimal-agent-activity">{lineRoll.leaving.activity}</span>
              ) : null}
            </span>
          </span>
        ) : null}
      </>
    );
    return (
      <article
        data-subagent-id={item.subagentId}
        data-settled={isActive ? undefined : ""}
        data-failed={isFailed ? "" : undefined}
        className={cn("minimal-agent-row", enteredLive && "motion-enter")}
      >
        <div className="minimal-agent-line">
          <button
            type="button"
            data-subagent-open-thread={childThreadId !== null ? "" : undefined}
            aria-label={
              childThreadId !== null
                ? `Open child thread for ${title}`
                : `${detailsExpanded ? "Hide" : "Show"} details for ${title}`
            }
            aria-expanded={childThreadId === null ? detailsExpanded : undefined}
            aria-controls={childThreadId === null ? detailsId : undefined}
            onClick={() => {
              if (childThreadId !== null) {
                props.onOpenThread(childThreadId);
              } else {
                props.onDetailsExpandedChange(!detailsExpanded);
              }
            }}
            className="minimal-agent-main"
          >
            {rowContent}
          </button>
          <span className="minimal-agent-elapsed tabular-nums">
            {props.jobCompletion?.durationMs !== undefined ? (
              formatNativeDuration(props.jobCompletion.durationMs)
            ) : (
              <SubagentElapsed agent={elapsedLifecycle} />
            )}
          </span>
          <button
            type="button"
            data-subagent-details-toggle
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            aria-label={`${detailsExpanded ? "Hide" : "Show"} details for ${title}`}
            onClick={() => props.onDetailsExpandedChange(!detailsExpanded)}
            className="minimal-agent-details-toggle"
          >
            <ChevronDownIcon aria-hidden="true" />
          </button>
        </div>
        <span className="sr-only">{status.label}</span>
        {rowPanels}
      </article>
    );
  }

  return (
    <article
      data-subagent-id={item.subagentId}
      data-terminal-subagent-row="true"
      className={cn(
        "group/agent-row px-3 py-2 min-w-0 transition-colors hover:bg-accent/20 motion-tint",
        enteredLive && "motion-enter",
      )}
    >
      {/* Live status uses OMP's spinner; settled rows use OMP's glyphs. */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          key={lifecycle.status}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            statusChanged && "motion-swap",
          )}
          aria-hidden="true"
        >
          {isActive ? (
            <TerminalSpinner />
          ) : isCompleted ? (
            <span className="terminal-subagent-success">✔</span>
          ) : isFailed ? (
            <span className="terminal-subagent-failed">✘</span>
          ) : lifecycle.status === "interrupted" || lifecycle.status === "cancelled" ? (
            <span className="terminal-subagent-muted">⏹</span>
          ) : (
            <span className="terminal-subagent-muted">⏳</span>
          )}
        </span>
        <span className="sr-only">{status.label}</span>
        {agentType ? <span className="sr-only">{agentType}</span> : null}
        {props.member.task ? <span className="sr-only">{props.member.task}</span> : null}

        <h3 className="m-0 min-w-0 shrink truncate text-sm font-medium text-foreground motion-tint">
          {title}
        </h3>

        {modelLabel ? (
          <span className="shrink-0 text-xs text-muted-foreground motion-tint">{modelLabel}</span>
        ) : null}

        {/* Right-aligned actions: elapsed, open thread */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="text-2xs text-muted-foreground tabular-nums">
            {props.jobCompletion?.durationMs !== undefined ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground motion-tint">
                <CheckIcon className="size-2.5" aria-hidden="true" />
                <span>{formatNativeDuration(props.jobCompletion.durationMs)}</span>
              </span>
            ) : (
              <SubagentElapsed agent={elapsedLifecycle} />
            )}
          </span>

          {childThreadId !== null ? (
            <button
              type="button"
              data-subagent-open-thread
              aria-label={`Open child thread for ${title}`}
              onClick={() => props.onOpenThread(childThreadId)}
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Line 2 (indented under the title): latest activity with shimmer while live, result summary when done */}
      <div className="pl-6 min-w-0 pr-2">
        {isActive ? (
          <div
            ref={observeVisibleAnimation}
            className="cursor-subagent-shimmer truncate text-xs text-muted-foreground motion-tint"
            data-native-current-tool={currentTool?.name ? "" : undefined}
          >
            <ShimmerLayers active copyClassName="truncate text-xs">
              {currentTool?.name && currentTool.intent?.trim() ? (
                <span className="sr-only">{currentTool.name}: </span>
              ) : null}
              <RollingText text={heldActivity.text} />
            </ShimmerLayers>
          </div>
        ) : summaryLine ? (
          <div
            key={summaryLine}
            className={cn(
              "truncate text-xs text-muted-foreground motion-tint",
              activityLineChanged && "motion-swap-text",
            )}
          >
            {summaryLine}
          </div>
        ) : null}
      </div>

      {/* 3px progress bar while live; a settled row shows its result instead */}
      {percent !== undefined && isOrchestrationV2WorkActive(lifecycle.status) ? (
        <div
          className="mt-1.5 h-[3px] w-full rounded-full bg-muted/60 overflow-hidden"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full origin-left bg-muted-foreground/60 transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${Math.min(100, Math.max(0, percent)) / 100})` }}
          />
        </div>
      ) : null}

      {rowPanels}
    </article>
  );
}

function ChildThreadStepsView(props: {
  readonly environmentId: EnvironmentId;
  readonly childThreadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const visibleItems = useAtomValue(
    environmentThreadDetails.visibleTurnItemsAtom(
      scopeThreadRef(props.environmentId, props.childThreadId),
    ),
  );

  const steps = useMemo(() => {
    if (!visibleItems || visibleItems.length === 0) return [];
    return visibleItems.slice(-5).flatMap((projected) => {
      const item = projected.item;
      const step = childThreadStep(item);
      if (step === null) return [];
      const running = isOrchestrationV2WorkActive(item.status);
      return [{ id: projected.sourceItemId, step, running, failed: item.status === "failed" }];
    });
  }, [visibleItems]);

  const [mountedStepIds] = useState(() => new Set(steps.map((s) => s.id)));
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLOListElement>(false);

  if (steps.length === 0) {
    return (
      <div className="pt-1">
        <button
          type="button"
          onClick={() => props.onOpenThread(props.childThreadId)}
          className="inline-flex items-center gap-1 text-3xs font-medium text-primary hover:underline"
        >
          Open thread
          <ArrowRightIcon className="size-3" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1 pt-1">
      <div ref={outerRef} className="overflow-hidden">
        <ol ref={contentRef} className="space-y-0.5 text-2xs text-muted-foreground">
          {steps.map(({ id, step, running, failed }) => {
            const statusKey = running ? "running" : failed ? "failed" : "completed";
            return (
              <ChildThreadStepRow
                key={id}
                step={step}
                statusKey={statusKey}
                running={running}
                failed={failed}
                entering={!mountedStepIds.has(id)}
              />
            );
          })}
        </ol>
      </div>
      <button
        type="button"
        onClick={() => props.onOpenThread(props.childThreadId)}
        className="inline-flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
      >
        Open thread
        <ArrowRightIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

function ChildThreadStepRow(props: {
  readonly step: ToolVerbObject;
  readonly statusKey: string;
  readonly running: boolean;
  readonly failed: boolean;
  readonly entering: boolean;
}) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const statusChanged = useChangedSinceMount(props.statusKey);
  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-1.5 motion-tint",
        props.entering && "motion-enter",
      )}
      data-terminal-subagent-step={isTerminal ? "true" : undefined}
    >
      <span
        key={props.statusKey}
        className={cn("flex w-3.5 shrink-0 justify-center", statusChanged && "motion-swap")}
        aria-hidden="true"
      >
        {isTerminal ? (
          props.running ? (
            <TerminalSpinner />
          ) : props.failed ? (
            <span className="terminal-subagent-failed">✘</span>
          ) : (
            <span className="terminal-subagent-success">✔</span>
          )
        ) : props.running ? (
          <Loader2Icon className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : props.failed ? (
          <CircleXIcon className="size-3 status-failed-mark" />
        ) : (
          <CheckIcon className="size-3 text-muted-foreground" />
        )}
      </span>
      <span className="shrink-0 text-foreground/80 motion-tint">{props.step.verb}</span>
      <span
        className={cn("min-w-0 truncate font-mono motion-tint", props.step.noMatch && "opacity-70")}
      >
        {props.step.noMatch ? `${props.step.object} · No matches` : props.step.object}
      </span>
    </li>
  );
}
