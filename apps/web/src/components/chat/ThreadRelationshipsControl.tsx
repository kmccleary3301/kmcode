import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { CollapsibleSectionHeader, SectionHeaderStatus } from "../ui/collapsible-section-header";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  threadRelationshipRowStatus,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
  type ThreadRelationshipWalkRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import { threadRuntimeHasActiveWork } from "@t3tools/client-runtime/state/thread-execution";
import type {
  EnvironmentId,
  NodeId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { groupBy } from "effect/Array";
import { useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShells,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

// Lineage paging: a busy thread can accumulate dozens of forks and subagents,
// and the panel it lives in already scrolls. Show a workable window, keep the
// rest behind Show more, and bound what is shown so the sections below Lineage
// stay reachable.
const THREAD_LINEAGE_INITIAL_COUNT = 6;
const THREAD_LINEAGE_PAGE_COUNT = 12;

export function resolveThreadLineageWindow<Row>(
  rows: ReadonlyArray<Row>,
  visibleCount: number,
): { readonly visibleRows: ReadonlyArray<Row>; readonly hiddenCount: number } {
  const visibleRows = rows.slice(0, visibleCount);
  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
}

export function ThreadLineageRowList(props: {
  readonly hiddenCount: number;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      {/*
        Bounded rather than free-growing so Lineage cannot push the rest of the
        thread details panel out of view. Plain overflow, not a ScrollArea
        component: this sits inside an already scrolling panel, where a
        max-height-only virtual viewport measures badly. Every row is a focusable
        button, so keyboard users reach and scroll the region through the rows
        themselves and the container needs no extra tab stop of its own.
      */}
      <ul
        aria-label="Related threads"
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0"
      >
        {props.children}
      </ul>
      {props.hiddenCount > 0 ? (
        <button
          type="button"
          onClick={props.onShowMore}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Show {Math.min(props.hiddenCount, THREAD_LINEAGE_PAGE_COUNT)} more
        </button>
      ) : null}
    </>
  );
}

function ThreadLineageGroup(props: {
  readonly label: string | null;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly expanded: boolean;
  readonly children: (rows: ReadonlyArray<ThreadRelationshipWalkRow>) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.expanded);
  const [visibleCount, setVisibleCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(props.rows, visibleCount);
  const failedCount = props.rows.filter(
    ({ edge }) => edge.status === "failed" || edge.status === "error",
  ).length;
  if (props.rows.length === 0) return null;
  return (
    <div>
      {props.label ? (
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          accessory={
            failedCount > 0 ? <SectionHeaderStatus>{failedCount} failed</SectionHeaderStatus> : null
          }
        >
          {props.label}
          {!expanded && ` (${props.rows.length})`}
        </CollapsibleSectionHeader>
      ) : null}
      {expanded ? (
        <ThreadLineageRowList
          hiddenCount={hiddenCount}
          onShowMore={() => setVisibleCount((count) => count + THREAD_LINEAGE_PAGE_COUNT)}
        >
          {props.children(visibleRows)}
        </ThreadLineageRowList>
      ) : null}
    </div>
  );
}

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return formatSubagentDisplayTitle(input.title);
}

/**
 * A delegated task settles with its first run, but the parent can keep sending
 * the child follow-ups. While the child thread has a live run, the row's timer
 * and hover card follow that run instead of the settled task.
 */
function liveSubagent<Agent extends RuntimeSubagent>(
  agent: Agent | undefined,
  childThread: OrchestrationV2ThreadShell | null | undefined,
  hasActiveWork: boolean,
): Agent | undefined {
  const liveStatus =
    childThread?.activityRunStatus ??
    (childThread != null &&
    ["preparing", "starting", "running", "waiting"].includes(childThread.status)
      ? childThread.status
      : null);
  if (!agent || childThread?.activeRunId == null || !liveStatus || !hasActiveWork) return agent;
  const startedAt = childThread.activityRunStartedAt;
  return {
    ...agent,
    status: liveStatus === "running" || liveStatus === "waiting" ? liveStatus : "pending",
    startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
    completedAt: null,
    // The settled task's output belongs to its first run, not this one.
    progress: null,
    result: null,
    error: null,
  };
}

function canStopNativeWorkflow(agent: OrchestrationV2Subagent): boolean {
  return (
    agent.origin === "provider_native" &&
    agent.driver === "claudeAgent" &&
    agent.workflow !== undefined &&
    agent.status === "running"
  );
}

export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const subagentsByThreadId = useMemo(
    () =>
      new Map(
        (projection?.subagents ?? [])
          .filter((subagent) => subagent.childThreadId !== null)
          .map((subagent) => [
            subagent.childThreadId,
            {
              ...projectedSubagentsToRuntime([subagent])[0]!,
              task: subagent,
              driver: subagent.driver,
              providerInstanceId: subagent.providerInstanceId,
              origin: subagent.origin,
            },
          ]),
      ),
    [projection?.subagents],
  );
  const threadShells = useThreadShells();
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
  const graph = useMemo(() => {
    const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
      ...threadShells
        .filter((thread) => thread.environmentId === props.environmentId)
        .map((thread) => thread.source),
      ...(archivedShells ?? []),
    ];
    return deriveThreadRelationshipGraph({ threads: shells, projection });
  }, [archivedShells, projection, props.environmentId, threadShells]);
  const currentThread = projection?.thread ?? graph.nodes.get(props.threadId)?.thread;
  const currentProject = projects.find((project) => project.id === currentThread?.projectId);
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.v2.stopWorkflow);
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.v2.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const mergeErrorToastId = useRef<string | null>(null);
  const detachErrorToastId = useRef<string | null>(null);
  const [stoppingTaskId, setStoppingTaskId] = useState<NodeId | null>(null);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = useMemo(
    () =>
      orderWebThreadLineageRows({
        graph,
        rows: immediateThreadRelationships(graph, props.threadId),
        currentThreadId: props.threadId,
        mergeTargetThreadId,
      }),
    [graph, mergeTargetThreadId, props.threadId],
  );
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;

  const {
    related = [],
    active = [],
    previous = [],
  } = groupBy(relationshipRows, ({ edge }) => {
    if (edge.kind !== "subagent" || isParentThreadRelationship(edge, props.threadId))
      return "related";
    return ["completed", "failed", "error", "cancelled", "interrupted", "idle"].includes(
      edge.status ?? "",
    )
      ? "previous"
      : "active";
  });
  const groups = [
    { id: "related", label: null, rows: related, expanded: true },
    { id: "active", label: null, rows: active, expanded: true },
    { id: "previous", label: "Previous agents", rows: previous, expanded: false },
  ];
  // Subagents without a child thread yet have no row, so count them separately.
  const runningCount =
    (projection?.subagents.filter(
      (agent) => agent.childThreadId === null && agent.status === "running",
    ).length ?? 0) + active.filter(({ edge }) => edge.status === "running").length;
  const nativeWorkflowTasks =
    projection?.subagents.filter(
      (agent) => agent.childThreadId === null && canStopNativeWorkflow(agent),
    ) ?? [];

  if (relationshipRows.length === 0 && runningCount === 0) {
    return null;
  }

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  const merge = async () => {
    if (!latestMergeBackRun || mergeTargetThreadId === null || busyAction !== null) return;
    if (mergeErrorToastId.current !== null) {
      toastManager.close(mergeErrorToastId.current);
      mergeErrorToastId.current = null;
    }
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestMergeBackRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      mergeErrorToastId.current = toastManager.add({
        type: "error",
        title: "Could not merge back",
      });
      return;
    }
    openThread(mergeTargetThreadId);
  };

  const detach = async () => {
    if (!canDetach || busyAction !== null) return;
    if (detachErrorToastId.current !== null) {
      toastManager.close(detachErrorToastId.current);
      detachErrorToastId.current = null;
    }
    setBusyAction("detach");
    const result = await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      detachErrorToastId.current = toastManager.add({
        type: "error",
        title: "Could not disconnect agent session",
      });
    }
  };

  const stopSubagent = async (subagentId: NodeId, childThreadId: ThreadId) => {
    if (stoppingTaskId !== null) return;
    setStoppingTaskId(subagentId);
    try {
      const result = await interruptTurn({
        environmentId: props.environmentId,
        input: { threadId: childThreadId },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not stop subagent" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not stop subagent" });
    } finally {
      setStoppingTaskId(null);
    }
  };

  const stopWorkflowTask = async (task: OrchestrationV2Subagent) => {
    if (stoppingTaskId !== null) return;
    setStoppingTaskId(task.id);
    try {
      const result = await stopWorkflow({
        environmentId: props.environmentId,
        input: { threadId: task.threadId, subagentId: task.id },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not stop workflow" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    } finally {
      setStoppingTaskId(null);
    }
  };

  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  return (
    <ThreadDetailsSection
      headingId="thread-details-lineage-heading"
      title={runningCount > 0 ? `Lineage · ${runningCount} running` : "Lineage"}
      data-thread-relationships-panel
      actions={
        canDetach ? (
          <Menu>
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="More thread actions"
                  disabled={busyAction !== null}
                />
              }
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-60 max-w-(--available-width)">
              <MenuItem onClick={() => void detach()}>
                <UnplugIcon className="size-3.5" />
                Disconnect agent session
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null
      }
    >
      {groups.map((group) => (
        <ThreadLineageGroup key={`${scopedThreadKey(ref)}:${group.id}`} {...group}>
          {(visibleRows) =>
            visibleRows.map(({ threadId, edge }) => {
              const node = graph.nodes.get(threadId);
              const isSubagent = edge.kind === "subagent";
              const isMergeTarget = threadId === mergeTargetThreadId;
              const isParent = isParentThreadRelationship(edge, props.threadId);
              const childThread = node?.thread;
              const childRuntimeHasActiveWork =
                childThread != null &&
                threadRuntimeHasActiveWork({
                  status: childThread.status,
                  activeRunId: childThread.activeRunId,
                  activityRunWorkCompletedAt:
                    childThread.activityRunWorkCompletedAt == null
                      ? null
                      : DateTime.formatIso(childThread.activityRunWorkCompletedAt),
                });
              const RelationshipIcon = isParent
                ? CornerLeftUpIcon
                : isSubagent
                  ? BotIcon
                  : GitForkIcon;
              const relationship = relationshipLabel(edge, props.threadId);
              const agent = liveSubagent(
                isSubagent && !isParent ? subagentsByThreadId.get(threadId) : undefined,
                childThread,
                childRuntimeHasActiveWork,
              );
              const endedChildActivation =
                isSubagent &&
                !isParent &&
                agent !== undefined &&
                childThread != null &&
                childThread.activityRunWorkCompletedAt != null &&
                childThread.activeRunId === null &&
                !childRuntimeHasActiveWork;
              const pendingChildSuccessor =
                isSubagent &&
                !isParent &&
                childThread != null &&
                childThread.activeRunId === null &&
                childRuntimeHasActiveWork &&
                (childThread.status === "preparing" ||
                  childThread.status === "starting" ||
                  childThread.status === "queued");
              const status =
                endedChildActivation && agent !== undefined
                  ? agent.status
                  : pendingChildSuccessor && childThread != null
                    ? childThread.status
                    : threadRelationshipRowStatus(graph, { threadId, edge });
              const failed = status === "failed" || status === "error";
              const canStopChild =
                agent !== undefined &&
                agent.task.origin === "app_owned" &&
                childThread?.activeRunId != null &&
                ["pending", "running", "waiting"].includes(agent.status);
              const canStopWorkflow =
                canOperateWorkflow && agent !== undefined && canStopNativeWorkflow(agent.task);
              const canStop = canStopChild || canStopWorkflow;
              const trailingVisibilityClass = canStop
                ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
                : "";
              const threadTitle = relationshipThreadTitle({
                title: node?.thread?.title ?? agent?.title ?? threadId,
                isSubagent,
              });
              const provider = providers?.find(
                (entry) =>
                  entry.instanceId ===
                  (agent?.providerInstanceId ?? node?.thread?.providerInstanceId),
              );
              const providerDriver = agent?.driver ?? provider?.driver;
              const project = projects.find((project) => project.id === node?.thread?.projectId);
              const relationshipHint = node?.missing
                ? "This related thread is unavailable"
                : `Open ${relationship.toLowerCase()} in this chat`;
              const RelationshipPopup = agent ? ThreadHoverCardPopup : TooltipPopup;
              const relationshipTooltip = agent ? (
                <SubagentTooltipContent
                  title={threadTitle}
                  model={agent.model}
                  providerInstanceId={agent.providerInstanceId}
                  origin={agent.origin}
                  provider={provider}
                  providers={providers}
                  driver={providerDriver}
                  elapsed={<AgentElapsed agent={agent} />}
                  status={agent.status}
                  overlayActive={isOrchestrationV2WorkActive(agent.status)}
                  result={agent.result}
                  progress={agent.progress}
                  threadRef={scopeThreadRef(props.environmentId, props.threadId)}
                  subagentId={agent.id}
                  parentThread={currentThread ?? undefined}
                  childThread={node?.thread ?? undefined}
                  parentProject={currentProject}
                  childProject={project}
                />
              ) : (
                relationshipHint
              );
              const relationshipContent = (
                <>
                  <ThreadRelationshipIcon
                    driver={isSubagent && !isParent ? providerDriver : undefined}
                    provider={provider}
                    fallbackIcon={RelationshipIcon}
                    status={status}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                      {threadTitle}
                    </span>
                  </span>
                  {agent ? null : (
                    <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                  {/* One trailing item keeps room for the title: the icon dot already
                      carries status, so an agent with a known time shows only that. */}
                  {agent && !failed && deriveSubagentElapsedMs(agent, 0) !== null ? (
                    <span
                      className={`shrink-0 text-2xs font-normal tabular-nums text-muted-foreground ${trailingVisibilityClass}`}
                    >
                      <AgentElapsed agent={agent} compact />
                    </span>
                  ) : !isMergeTarget ? (
                    <span
                      className={`shrink-0 text-2xs ${failed ? "text-destructive" : "text-muted-foreground"} ${trailingVisibilityClass}`}
                    >
                      {threadRelationshipStatusLabel(status)}
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={threadId} className="group relative flex h-8 items-center rounded-lg">
                  {isMergeTarget ? (
                    <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
                      <Tooltip>
                        <TooltipTrigger
                          delay={200}
                          render={
                            <ThreadDetailsControl
                              size="sm"
                              variant="ghost"
                              part="primary"
                              aria-label={`${threadTitle} ${threadRelationshipStatusLabel(status)}`}
                              disabled={node?.missing === true}
                              onClick={() => openThread(threadId)}
                            />
                          }
                        >
                          {relationshipContent}
                        </TooltipTrigger>
                        <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                      </Tooltip>
                      <span
                        aria-hidden="true"
                        className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS}
                      />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <ThreadDetailsControl
                              size="sm"
                              variant="ghost"
                              part="secondary"
                              aria-label={
                                parentTitle
                                  ? `Merge back to ${parentTitle}`
                                  : "Merge back to source conversation"
                              }
                              disabled={!canMerge || busyAction !== null}
                              onClick={() => void merge()}
                            >
                              {busyAction === "merge" ? (
                                <LoaderCircleIcon className="size-3 animate-spin" />
                              ) : (
                                <PullRequestGlyph.merged className="size-3" />
                              )}
                            </ThreadDetailsControl>
                          }
                        />
                        <TooltipPopup side="left">
                          {latestMergeBackRun === null
                            ? "Complete a run in this fork before merging it back"
                            : parentTitle
                              ? `Merge this conversation back into ${parentTitle}`
                              : "Merge this conversation back into its source"}
                        </TooltipPopup>
                      </Tooltip>
                      <span className="shrink-0 border border-transparent ps-1 pe-2.5 text-2xs font-medium text-muted-foreground">
                        {threadRelationshipStatusLabel(status)}
                      </span>
                    </div>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        delay={200}
                        render={
                          <ThreadDetailsControl
                            size="sm"
                            variant="ghost"
                            disabled={node?.missing === true}
                            onClick={() => openThread(threadId)}
                            part="row"
                          />
                        }
                      >
                        {relationshipContent}
                      </TooltipTrigger>
                      <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                    </Tooltip>
                  )}
                  {canStop && agent ? (
                    <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <ThreadDetailsControl
                              size="icon-xs"
                              variant="ghost"
                              part="icon"
                              tone="destructive"
                              aria-label={`Stop ${canStopWorkflow ? "workflow" : "subagent"} ${threadTitle}`}
                              disabled={stoppingTaskId !== null}
                              onClick={() => {
                                if (canOperateWorkflow && canStopNativeWorkflow(agent.task)) {
                                  void stopWorkflowTask(agent.task);
                                } else if (
                                  agent.task.origin === "app_owned" &&
                                  agent.task.childThreadId !== null
                                ) {
                                  void stopSubagent(agent.task.id, agent.task.childThreadId);
                                }
                              }}
                            />
                          }
                        >
                          {stoppingTaskId === agent.task.id ? (
                            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                          ) : (
                            <SquareIcon aria-hidden className="size-3 fill-current" />
                          )}
                        </TooltipTrigger>
                        <TooltipPopup side="left">
                          {canStopWorkflow ? "Stop workflow" : "Stop subagent"}
                        </TooltipPopup>
                      </Tooltip>
                    </div>
                  ) : null}
                </li>
              );
            })
          }
        </ThreadLineageGroup>
      ))}
      {nativeWorkflowTasks.length > 0 ? (
        <div role="list" aria-label="Active workflows">
          {nativeWorkflowTasks.map((task) => {
            const title = relationshipThreadTitle({
              title: task.title ?? "Workflow",
              isSubagent: true,
            });
            const provider = providers?.find(
              (entry) => entry.instanceId === task.providerInstanceId,
            );
            return (
              <div
                key={task.id}
                role="listitem"
                className="group relative flex h-8 items-center rounded-lg"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2">
                  <ThreadRelationshipIcon
                    driver={task.driver}
                    provider={provider}
                    fallbackIcon={BotIcon}
                    status={task.status}
                  />
                  <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
                    {title}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {threadRelationshipStatusLabel(task.status)}
                  </span>
                </div>
                {canOperateWorkflow && canStopNativeWorkflow(task) ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="destructive"
                          aria-label={`Stop workflow ${title}`}
                          disabled={stoppingTaskId !== null}
                          onClick={() => void stopWorkflowTask(task)}
                        >
                          {stoppingTaskId === task.id ? (
                            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                          ) : (
                            <SquareIcon aria-hidden className="size-3 fill-current" />
                          )}
                        </ThreadDetailsControl>
                      }
                    />
                    <TooltipPopup side="left">Stop workflow</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
