import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AgentElapsed } from "./AgentElapsed";
import { resolveSubagentLifecycle } from "@t3tools/client-runtime/state/subagentRuntime";
import { use, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import { MiddleTruncate } from "../ui/middle-truncate";
import * as DateTime from "effect/DateTime";
import { WorkLogRow } from "./WorkLog";
import { resolveHandoffEndpoints, type HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { Fragment } from "react";
import {
  formatSubagentDisplayTitle,
  subagentDisplayName,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  ProviderDriverKind,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentLiveContent,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  type EnvironmentId,
  type NodeId,
  type ScopedThreadRef,
  type TurnItemId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleXIcon,
  ArrowRightLeftIcon,
  ArrowRightIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColorClassName } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { Button, InlineButton } from "../ui/button";
import { T3Wordmark } from "../T3Wordmark";
import { AsciiLoader } from "../ui/ascii-loader";
import { ActivityDisclosurePanel } from "./ActivityDisclosure";
import { GlyphSwap } from "./GlyphSwap";
import { RollingText } from "./RollingText";
import { EXCERPT_FOLD_DELAY_MS } from "./timelineActivityPolicy";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { useChildThreadLiveStep } from "./childThreadSteps";
import {
  LiveViewPausedNote,
  useSubagentLiveContent,
} from "../../hooks/useSubagentLiveContent";
import ChatMarkdown from "../ChatMarkdown";
import { TranscriptStyleCtx } from "./transcriptStyle";
const MINIMAL_SUBAGENT_SETTLE_HOLD_MS = 700;

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

export type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-3xs text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone="danger"
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    const label =
      item.status === "failed"
        ? "Context compaction failed"
        : item.status === "cancelled" || item.status === "interrupted"
          ? "Context compaction stopped"
          : item.status === "pending" || item.status === "running" || item.status === "waiting"
            ? "Compacting context"
            : "Context compacted";
    return (
      <TimelineSystemDivider label={label} detail={item.summary ?? tokenDetail} icon={MinusIcon} />
    );
  }
  if (item.type === "handoff") {
    const { from: fromEndpoints, to } = resolveHandoffEndpoints(item, props.runs);
    return (
      <TimelineSystemDivider
        label="Context handoff"
        icon={ArrowRightLeftIcon}
        showDetailSeparator={false}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-1.5">
            {fromEndpoints.map((endpoint, index) => (
              <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
                {index > 0 ? (
                  <span aria-hidden="true" className="-ml-1">
                    ,
                  </span>
                ) : null}
                <HandoffEndpoint
                  providers={props.providerStatuses}
                  instanceId={endpoint.instanceId}
                  model={endpoint.model}
                />
              </Fragment>
            ))}
            {fromEndpoints.length > 0 ? (
              <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            <HandoffEndpoint
              providers={props.providerStatuses}
              instanceId={item.toProviderInstanceId}
              model={to.model}
            />
          </span>
        }
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    if (props.resourceSummary) {
      return (
        <div
          data-v2-item-type={item.type}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 p-3"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            <MessageSquareIcon className="size-4 text-secondary-label" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.title ?? "Created thread"}
          </span>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </Button>
        </div>
      );
    }
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<T3Wordmark className="size-4 text-icon-muted" aria-hidden />}
        label={<>Created thread{item.title ? ` · ${item.title}` : ""}</>}
        trailing={
          <InlineButton
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </InlineButton>
        }
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <SubagentTimelineLink
        parentRef={scopeThreadRef(props.environmentId, item.threadId)}
        subagentId={item.subagentId}
        providerInstanceId={item.providerInstanceId}
        origin={item.origin}
        status={item.status}
        driver={item.driver}
        provider={props.providerStatuses.find(
          (provider) => provider.instanceId === item.providerInstanceId,
        )}
        providers={props.providerStatuses}
        title={subagentDisplayName(item) ?? "Subagent"}
        task={item.prompt}
        liveContent={item.liveContent ?? null}
        turnItemId={item.id}
        currentTool={item.currentTool}
        result={item.result}
        progress={item.progress}
        startedAt={item.startedAt}
        completedAt={item.completedAt}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

/**
 * In-flight states all present as Working, the way the agents fleet view did:
 * detail belongs in the activity line, and a waiting or queued subagent is
 * still the fleet doing its job. Only settled states differentiate. Idle reads
 * as settled rather than in progress, since a resting child looks done unless
 * resumed.
 */
const STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function subagentStatusVisual(status: OrchestrationV2TurnItem["status"]) {
  return STATUS_VISUALS[status];
}

const SETTLED_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** The server's placeholder when a child ends without output; the status dot already says it. */
const GENERIC_CHILD_END = /^Child task ended with status\b/i;

/** One line of a markdown result: drop list bullets, emphasis, code ticks, and link targets. */
export function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** A JSON object result as its scalar fields, `key value · …`; null for any other result. */
export function subagentJsonResultSummary(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const fields = Object.entries(value as Record<string, unknown>).flatMap(([key, field]) => {
        if (field !== null && typeof field === "object") return [];
        const fieldText = field === null ? "null" : String(field);
        return [`${plainDetail(key)} ${plainDetail(fieldText)}`];
      });
      return fields.length > 0 ? fields.join(" · ") : "Object result";
    }
  } catch {
    // The result is ordinary text rather than a JSON object.
  }
  return null;
}

/** A result as one plain line. */
export function subagentResultDetail(text: string): string | null {
  return subagentJsonResultSummary(text) ?? (plainDetail(text) || null);
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

export function SubagentElapsed({ agent }: { agent: Parameters<typeof AgentElapsed>[0]["agent"] }) {
  return <AgentElapsed agent={agent} />;
}

/** Round provider tile with the agents panel's status dot; rings let a header stack overlap. */
export function SubagentAvatar({
  driver,
  provider,
  status,
  className,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  /** Omitted inside an overlapped stack, where a covered dot would only add noise. */
  status?: OrchestrationV2TurnItem["status"] | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background",
        className,
      )}
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          acpRegistryIconUrl={provider?.iconUrl}
          className="z-auto"
          iconClassName="size-3.5"
        />
      ) : (
        <BotIcon className="size-3.5 text-muted-foreground" />
      )}
      {status ? (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
            subagentStatusVisual(status).dotClass,
          )}
        />
      ) : null}
    </span>
  );
}
/** Shared Minimal/KM delegation header and outlined agent card. */
export function MinimalSubagentGroup(props: {
  readonly names: string;
  readonly active: boolean;
  readonly driver?: ProviderDriverKind | undefined;
  readonly provider?: ServerProvider | undefined;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly children: ReactNode;
}) {
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        aria-label={`${props.active ? "Delegating to" : "Delegated to"} ${props.names}`}
        aria-expanded={props.expanded}
        aria-controls={panelId}
        onClick={() => props.onExpandedChange(!props.expanded)}
        className="minimal-agents-header"
      >
        <GlyphSwap
          state={props.active ? "live" : "settled"}
          render={(state) => (state === "live" ? <AsciiLoader /> : <BotIcon />)}
          className="step-glyph minimal-agents-glyph"
          aria-hidden="true"
        />
        <span className="minimal-agents-label" aria-hidden="true">
          <RollingText text={props.active ? "Delegating to" : "Delegated to"} />
          {props.driver ? <SubagentAvatar driver={props.driver} provider={props.provider} /> : null}
          <span className="minimal-agents-names">{props.names}</span>
        </span>
      </button>
      <ActivityDisclosurePanel open={props.expanded} id={panelId} className="min-w-0">
        <div className="minimal-agents-card">{props.children}</div>
      </ActivityDisclosurePanel>
    </>
  );
}

/** Compact task, live excerpt, result, and metadata shared by both subagent renderers. */
export function MinimalSubagentDetails(props: {
  readonly title: string;
  readonly task: string;
  readonly active: boolean;
  readonly rowActivity: string | null;
  readonly liveStep: string | null;
  readonly liveContent: string | null;
  readonly result: string | null;
  readonly failed: boolean;
  readonly model: string | null;
  readonly metadata?: string | null | undefined;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const model = props.model?.trim() ?? "";
  const normalizedModel = model.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedTitle = props.title.toLowerCase().replace(/[^a-z0-9]/g, "");
  const modelLabel = normalizedModel && !normalizedTitle.includes(normalizedModel) ? model : null;
  const metadata = props.metadata?.trim() || null;
  const footerMetadata = [modelLabel, metadata].filter(Boolean).join(" · ");
  const threadId = props.threadId;
  const liveStep = props.liveStep?.trim() || null;
  const rowActivity = props.rowActivity?.trim() || null;
  const distinctLiveStep =
    liveStep && plainDetail(liveStep) !== plainDetail(rowActivity ?? "") ? liveStep : null;
  const task = props.task.trim();
  const liveContent = props.active ? props.liveContent?.trim() || null : null;
  const result = props.result?.trim() || null;
  const taskRef = useRef<HTMLDivElement>(null);
  const [taskTruncated, setTaskTruncated] = useState(false);
  useEffect(() => {
    const node = taskRef.current;
    if (!node) return;
    const updateOverflow = () => setTaskTruncated(node.scrollHeight > node.clientHeight + 1);
    const mutations = new MutationObserver(updateOverflow);
    mutations.observe(node, { childList: true, subtree: true, characterData: true });
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateOverflow);
    resize?.observe(node);
    updateOverflow();
    return () => {
      mutations.disconnect();
      resize?.disconnect();
    };
  }, [task]);
  return (
    <div className="minimal-agent-details-content">
      {task ? (
        <div
          ref={taskRef}
          data-subagent-task
          data-truncated={taskTruncated ? "" : undefined}
          className="subagent-details-task"
        >
          <ChatMarkdown text={task} cwd={undefined} parseRawHtml={false} />
        </div>
      ) : null}
      {liveContent ? (
        <div data-subagent-live-content="">
          <ChatMarkdown
            text={liveContent}
            cwd={undefined}
            parseRawHtml={false}
            isStreaming={props.active}
            className="subagent-details-live"
          />
        </div>
      ) : null}
      {props.active && distinctLiveStep ? (
        <p data-subagent-live-step className="subagent-details-step">
          <span aria-hidden="true" className="subagent-details-step-glyph">
            <AsciiLoader />
          </span>
          <span className="font-mono">{distinctLiveStep}</span>
        </p>
      ) : null}
      {result ? (
        <div data-subagent-result="">
          <ChatMarkdown
            text={result}
            cwd={undefined}
            parseRawHtml={false}
            className={props.failed ? "text-destructive" : "text-muted-foreground"}
          />
        </div>
      ) : null}
      {footerMetadata || threadId ? (
        <div className="minimal-agent-details-footer">
          {footerMetadata ? (
            <span data-subagent-metadata className="min-w-0 truncate">
              {footerMetadata}
            </span>
          ) : null}
          {threadId ? (
            <button
              type="button"
              data-subagent-open-thread
              aria-label="Open child thread"
              onClick={() => props.onOpenThread(threadId)}
              className="minimal-agent-details-thread-link"
            >
              Open thread →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/** The status a notification reported, frozen at the time it arrived. */
const NOTIFICATION_OUTCOME_STATUS: Record<
  OrchestrationV2Notification["outcome"],
  OrchestrationV2TurnItem["status"] | null
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

const NOTIFICATION_OUTCOME_LABEL: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  updated: "Updated",
  unknown: "Finished",
};

/** Draws a notification for its exact task IDs, or the legacy subagent thread. */
export function SubagentNotificationLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childThreadId?: ThreadId;
  readonly taskIds?: ReadonlyArray<NodeId>;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const agent = useAtomValue(environmentThreadDetails.threadAtom(props.parentRef), (thread) => {
    const subagents = thread?.projection.subagents ?? [];
    if (props.taskIds !== undefined) {
      if (props.taskIds.length !== 1) return null;
      const [taskId] = props.taskIds;
      if (taskId === undefined) return null;
      return subagents.find((candidate) => candidate.id === taskId) ?? null;
    }
    if (props.childThreadId === undefined) return null;
    return subagents.find((candidate) => candidate.childThreadId === props.childThreadId) ?? null;
  });
  if (agent === null) return props.fallback;
  const threadId =
    props.taskIds !== undefined ? agent.childThreadId : (props.childThreadId ?? agent.childThreadId);
  return (
    <SubagentTimelineLink
      parentRef={props.parentRef}
      subagentId={agent.id}
      providerInstanceId={agent.providerInstanceId}
      origin={agent.origin}
      status={agent.status}
      driver={agent.driver}
      provider={props.providerStatuses.find(
        (provider) => provider.instanceId === agent.providerInstanceId,
      )}
      providers={props.providerStatuses}
      title={subagentDisplayName(agent) ?? "Subagent"}
      task={agent.prompt}
      currentTool={agent.currentTool}
      result={agent.result}
      progress={agent.progress}
      startedAt={agent.startedAt}
      completedAt={agent.completedAt}
      threadId={threadId}
      onOpenThread={props.onOpenThread}
      event={{
        status: NOTIFICATION_OUTCOME_STATUS[props.outcome],
        label: NOTIFICATION_OUTCOME_LABEL[props.outcome],
        timestamp: formatShortTimestamp(props.createdAt, props.timestampFormat),
      }}
    />
  );
}

function SubagentTimelineLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly title: string;
  readonly task: string;
  readonly liveContent?: OrchestrationV2SubagentLiveContent | null | undefined;
  readonly turnItemId?: TurnItemId | null | undefined;
  readonly currentTool: OrchestrationV2Subagent["currentTool"];
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Draws a past event about the subagent: its status then, and when it happened instead of elapsed time. */
  readonly event?: {
    readonly status: OrchestrationV2TurnItem["status"] | null;
    readonly label: string;
    readonly timestamp: string;
  };
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  const { liveContent, rateLimited } = useSubagentLiveContent(props.parentRef, {
    active: agent !== null && isOrchestrationV2WorkActive(agent.status),
    subagentId: props.subagentId,
    turnItemId: props.turnItemId,
    persisted: props.liveContent,
  });
  const threadId = props.threadId;
  const lifecycle = resolveSubagentLifecycle(
    {
      status: props.status,
      startedAt: isoOrNull(props.startedAt),
      completedAt: isoOrNull(props.completedAt),
    },
    agent
      ? {
          status: agent.status,
          startedAt: isoOrNull(agent.startedAt),
          completedAt: isoOrNull(agent.completedAt),
        }
      : undefined,
  );
  const liveStatus = lifecycle.status;
  const status = props.event ? props.event.status : liveStatus;
  const statusLabel = props.event?.label ?? subagentStatusVisual(liveStatus).label;
  const result = (agent?.result ?? props.result)?.trim();
  const progress = (agent?.progress ?? props.progress)?.trim();
  const settled = SETTLED_SUBAGENT_STATUSES.has(status ?? liveStatus);
  const rawDetail = settled ? result || progress : progress || result;
  const detail =
    rawDetail && !GENERIC_CHILD_END.test(rawDetail) ? plainDetail(rawDetail) || null : null;
  const failed = status === "failed";
  const transcriptStyle = use(TranscriptStyleCtx);
  const isTerminal = transcriptStyle === "terminal";
  const opensWhileActive = transcriptStyle === "km" || transcriptStyle === "minimal-plus";
  const shownStatus = status ?? liveStatus;
  const active = isOrchestrationV2WorkActive(shownStatus);
  const displayLiveContent =
    liveContent?.kind === "assistant" ? liveContent.text : null;
  const [cardExpandedPreference, setCardExpandedPreference] = useState<boolean | undefined>();
  const [detailsExpandedPreference, setDetailsExpandedPreference] = useState<boolean | undefined>();
  const [cardSettleHold, setCardSettleHold] = useState(false);
  const [detailsSettleHold, setDetailsSettleHold] = useState(false);
  const [wasActive, setWasActive] = useState(active);
  const detailsId = useId();
  if (wasActive !== active) {
    setWasActive(active);
    setCardSettleHold(!active);
    setDetailsSettleHold(!active);
  }
  useEffect(() => {
    if (!cardSettleHold) return;
    const timer = setTimeout(() => setCardSettleHold(false), MINIMAL_SUBAGENT_SETTLE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [cardSettleHold]);
  useEffect(() => {
    if (!detailsSettleHold) return;
    const timer = setTimeout(() => setDetailsSettleHold(false), EXCERPT_FOLD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [detailsSettleHold]);
  const cardExpanded = cardExpandedPreference ?? (active || cardSettleHold);
  const detailsExpanded =
    detailsExpandedPreference ?? (opensWhileActive && (active || detailsSettleHold));
  const timing = lifecycle;
  const childLiveStep = useChildThreadLiveStep(
    props.parentRef.environmentId,
    !isTerminal && active ? threadId : null,
  );
  const currentTool = agent?.currentTool ?? props.currentTool;
  const liveActivity =
    currentTool?.intent?.trim() ||
    (currentTool?.name
      ? currentTool.argsPreview?.trim()
        ? `${currentTool.name} ${currentTool.argsPreview.trim()}`
        : currentTool.name
      : childLiveStep ?? progress ?? (shownStatus === "pending" ? "Starting up" : "Thinking"));
  const task = (agent?.prompt ?? props.task).trim();
  const tooltip = (
    <ThreadHoverCardPopup>
      <SubagentTimelineTooltip
        {...props}
        elapsed={<AgentElapsed agent={timing} />}
        overlayActive={agent !== null && isOrchestrationV2WorkActive(agent.status)}
        model={agent?.model ?? null}
        status={liveStatus}
        result={agent?.result ?? props.result}
        progress={agent?.progress ?? props.progress}
        liveContent={liveContent}
      />
    </ThreadHoverCardPopup>
  );
  if (!isTerminal) {
    const rowFailed = shownStatus === "failed";
    const lineDetail = active
      ? plainDetail(liveActivity) || (shownStatus === "pending" ? "Starting up" : "Thinking")
      : ((result && !GENERIC_CHILD_END.test(result) ? subagentResultDetail(result) : null) ??
        (shownStatus === "completed" ? null : statusLabel));
    const elapsed = (
      <span className="minimal-agent-elapsed tabular-nums">
        <AgentElapsed agent={timing} />
      </span>
    );
    const row = (
      <article
        data-settled={active ? undefined : ""}
        data-failed={rowFailed ? "" : undefined}
        className="minimal-agent-row"
      >
        <div className="minimal-agent-line">
          <Tooltip>
            <TooltipTrigger
              delay={200}
              render={
                threadId === null ? (
                  <div
                    data-v2-item-type="subagent"
                    aria-description={statusLabel}
                    className="minimal-agent-main"
                  >
                    <span className="minimal-agent-glyph" aria-hidden="true">
                      {active ? (
                        <AsciiLoader />
                      ) : shownStatus === "completed" ? (
                        <CheckIcon />
                      ) : SETTLED_SUBAGENT_STATUSES.has(shownStatus) ? (
                        <CircleXIcon className={rowFailed ? "status-failed-mark" : undefined} />
                      ) : (
                        <CircleDashedIcon />
                      )}
                    </span>
                    {props.origin === "app_owned" ? (
                      <span className="minimal-agent-provider" aria-hidden="true">
                        <ProviderInstanceIcon
                          driverKind={props.driver}
                          displayName={props.provider?.displayName ?? props.driver}
                          acpRegistryIconUrl={props.provider?.iconUrl}
                          iconClassName="size-3.5"
                        />
                      </span>
                    ) : null}
                    <span
                      ref={active ? observeVisibleAnimation : undefined}
                      className={cn("minimal-agent-text", active && "cursor-subagent-shimmer")}
                    >
                      <span className="minimal-agent-title">{props.title}</span>
                      {lineDetail ? (
                        <span
                          className={cn(
                            "minimal-agent-activity",
                            rowFailed && "minimal-agent-activity-failed",
                          )}
                        >
                          {lineDetail}
                        </span>
                      ) : null}
                    </span>
                    {elapsed}
                  </div>
                ) : (
                  <button
                    type="button"
                    data-v2-item-type="subagent"
                    aria-label={`Open ${props.title}`}
                    aria-description={statusLabel}
                    onClick={() => props.onOpenThread(threadId)}
                    className="minimal-agent-main cursor-pointer"
                  >
                    <span className="minimal-agent-glyph" aria-hidden="true">
                      {active ? (
                        <AsciiLoader />
                      ) : shownStatus === "completed" ? (
                        <CheckIcon />
                      ) : SETTLED_SUBAGENT_STATUSES.has(shownStatus) ? (
                        <CircleXIcon className={rowFailed ? "status-failed-mark" : undefined} />
                      ) : (
                        <CircleDashedIcon />
                      )}
                    </span>
                    {props.origin === "app_owned" ? (
                      <span className="minimal-agent-provider" aria-hidden="true">
                        <ProviderInstanceIcon
                          driverKind={props.driver}
                          displayName={props.provider?.displayName ?? props.driver}
                          acpRegistryIconUrl={props.provider?.iconUrl}
                          iconClassName="size-3.5"
                        />
                      </span>
                    ) : null}
                    <span
                      ref={active ? observeVisibleAnimation : undefined}
                      className={cn("minimal-agent-text", active && "cursor-subagent-shimmer")}
                    >
                      <span className="minimal-agent-title">{props.title}</span>
                      {lineDetail ? (
                        <span
                          className={cn(
                            "minimal-agent-activity",
                            rowFailed && "minimal-agent-activity-failed",
                          )}
                        >
                          {lineDetail}
                        </span>
                      ) : null}
                    </span>
                    {elapsed}
                  </button>
                )
              }
            />
            {tooltip}
          </Tooltip>
          <button
            type="button"
            data-subagent-details-toggle
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            aria-label={`${detailsExpanded ? "Hide" : "Show"} details for ${props.title}`}
            onClick={() => setDetailsExpandedPreference(!detailsExpanded)}
            className="minimal-agent-details-toggle"
          >
            <ChevronDownIcon aria-hidden="true" />
          </button>
        </div>
        <ActivityDisclosurePanel
          open={detailsExpanded}
          id={detailsId}
          className={cn(
            "minimal-agent-details min-w-0",
            props.origin === "app_owned" && "minimal-agent-details-has-provider",
          )}
        >
          <MinimalSubagentDetails
            title={props.title}
            task={task}
            active={active}
            rowActivity={active ? plainDetail(liveActivity) : null}
            liveStep={active ? childLiveStep ?? progress ?? null : null}
            liveContent={displayLiveContent}
            result={
              result && !GENERIC_CHILD_END.test(result)
                ? (subagentJsonResultSummary(result) ?? result)
                : null
            }
            failed={rowFailed}
            model={agent?.model ?? null}
            threadId={threadId}
            onOpenThread={props.onOpenThread}
          />
          {active && rateLimited ? (
            <div className="mt-1 text-3xs text-muted-foreground">
              <LiveViewPausedNote />
            </div>
          ) : null}
        </ActivityDisclosurePanel>
      </article>
    );
    return (
      <MinimalSubagentGroup
        names={props.title}
        active={active}
        driver={props.driver}
        provider={props.provider}
        expanded={cardExpanded}
        onExpandedChange={setCardExpandedPreference}
      >
        {row}
      </MinimalSubagentGroup>
    );
  }
  const content = (
    <>
      <SubagentAvatar
        driver={props.driver}
        provider={props.provider}
        status={status ?? undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {props.title}
          </span>
          {detail !== null && (props.event !== undefined || status !== "completed") ? (
            <span
              className={cn(
                "shrink-0 text-3xs",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "block text-2xs leading-relaxed",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail === null ? (
            statusLabel
          ) : detail.includes("/") && !detail.includes(" ") ? (
            <MiddleTruncate value={detail} showTitle={false} className="flex" />
          ) : (
            <span className="block truncate">{detail}</span>
          )}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.event ? props.event.timestamp : <SubagentElapsed agent={timing} />}
      </span>
      {threadId !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
        />
      ) : null}
    </>
  );
  const className =
    "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          threadId === null ? (
            <div data-v2-item-type="subagent" aria-description={statusLabel} className={className}>
              {content}
            </div>
          ) : (
            <button
              type="button"
              data-v2-item-type="subagent"
              aria-label={`Open ${props.title}`}
              aria-description={statusLabel}
              onClick={() => props.onOpenThread(threadId)}
              className={cn(
                className,
                "cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              )}
            >
              {content}
            </button>
          )
        }
      />
      {tooltip}
    </Tooltip>
  );
}

function SubagentTimelineTooltip(
  props: Parameters<typeof SubagentTimelineLink>[0] & {
    model: string | null;
    elapsed: ReactNode;
    overlayActive: boolean;
  },
) {
  const environmentId = props.parentRef.environmentId;
  const parent = useThreadShell(props.parentRef)?.source;
  const child = useThreadShell(
    props.threadId ? scopeThreadRef(environmentId, props.threadId) : null,
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  return (
    <SubagentTooltipContent
      title={formatSubagentDisplayTitle(child?.title ?? props.title)}
      model={props.model}
      providerInstanceId={props.providerInstanceId}
      origin={props.origin}
      provider={props.provider}
      providers={props.providers}
      driver={props.driver}
      elapsed={props.elapsed}
      status={props.status}
      overlayActive={props.overlayActive}
      result={props.result}
      progress={props.progress}
      parentThread={parent}
      childThread={child}
      parentProject={parentProject ?? undefined}
      threadRef={props.parentRef}
      subagentId={props.subagentId}
      turnItemId={props.turnItemId}
      liveContent={props.liveContent}
      childProject={childProject ?? undefined}
    />
  );
}

function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const model = props.model?.trim();
  const providerModel =
    model === undefined || model.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === model);
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined && model.length > 0
        ? model
        : (entry?.displayName ?? props.instanceId);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProviderInstanceIcon
              driverKind={entry?.driverKind ?? ProviderDriverKind.make(props.instanceId)}
              displayName={entry?.displayName ?? props.instanceId}
              acpRegistryAgentId={entry?.acpRegistryAgentId}
              acpRegistryIconUrl={entry?.acpRegistryIconUrl}
              iconClassName="size-3"
            />
            <span
              className={cn(
                "truncate font-medium",
                providerTextColorClassName(
                  entry?.driverKind ?? ProviderDriverKind.make(props.instanceId),
                ),
              )}
            >
              {label}
            </span>
          </span>
        }
      />
      <TooltipPopup>
        {entry?.displayName ?? props.instanceId} · {label}
      </TooltipPopup>
    </Tooltip>
  );
}
