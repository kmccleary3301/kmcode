import { memo, useMemo, useState } from "react";
import * as DateTime from "effect/DateTime";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  LoaderCircleIcon,
  SquareIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { subagentDisplayName } from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentLiveContent,
  ThreadId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { AsciiLoader } from "~/components/ui/ascii-loader";
import { AgentElapsed } from "./AgentElapsed";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { useChangedSinceMount, usePresence, usePresentList, useSmoothHeight } from "~/lib/motion";
import { useChildThreadLiveStep } from "./childThreadSteps";
import { RollingText } from "./RollingText";
import {
  LiveViewPausedNote,
  useSubagentLiveContent,
} from "../../hooks/useSubagentLiveContent";
import { useHeldSubagentActivity } from "./useHeldSubagentActivity";

const EMPTY_SUBAGENTS: readonly OrchestrationV2Subagent[] = [];

export interface ComposerWorkingHubProps {
  readonly environmentId?: EnvironmentId | undefined;
  readonly threadId?: ThreadId | null | undefined;
}

export const ComposerWorkingHub = memo(function ComposerWorkingHub(props: ComposerWorkingHubProps) {
  if (props.environmentId === undefined || props.threadId == null) return null;
  return <ComposerWorkingHubPanel environmentId={props.environmentId} threadId={props.threadId} />;
});

function agentKey(agent: OrchestrationV2Subagent): string {
  return agent.id;
}

function subagentName(agent: OrchestrationV2Subagent): string {
  return subagentDisplayName(agent) || agent.model || "subagent";
}


function oldestStartedAgent(
  agents: readonly OrchestrationV2Subagent[],
): OrchestrationV2Subagent | null {
  let oldest: OrchestrationV2Subagent | null = null;
  let oldestStart = Infinity;
  for (const agent of agents) {
    if (agent.startedAt == null) continue;
    const startedAt = DateTime.toEpochMillis(agent.startedAt);
    if (startedAt < oldestStart) {
      oldest = agent;
      oldestStart = startedAt;
    }
  }
  return oldest;
}

function canStopNativeWorkflow(agent: OrchestrationV2Subagent): boolean {
  return (
    agent.origin === "provider_native" &&
    agent.driver === "claudeAgent" &&
    agent.workflow !== undefined &&
    agent.status === "running"
  );
}

function canStopAppOwnedSubagent(
  agent: OrchestrationV2Subagent,
): agent is OrchestrationV2Subagent & {
  readonly origin: "app_owned";
  readonly childThreadId: ThreadId;
} {
  return agent.origin === "app_owned" && agent.childThreadId !== null;
}

function ComposerWorkingHubPanel({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isStoppingAll, setIsStoppingAll] = useState(false);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.v2.stopWorkflow);
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.v2.stopWorkflow.permissionAtom(environmentId),
  );
  const liveSubagents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, threadId)),
    (thread) => thread?.projection.subagents ?? EMPTY_SUBAGENTS,
  );

  const liveEntries = useMemo(
    () => liveSubagents.filter((agent) => isOrchestrationV2WorkActive(agent.status)),
    [liveSubagents],
  );
  const liveCount = liveEntries.length;
  const hasStoppableWork = liveEntries.some(
    (agent) =>
      canStopAppOwnedSubagent(agent) || (canOperateWorkflow && canStopNativeWorkflow(agent)),
  );

  // The hub leaves with the last live subagent, closing its panel on the way out.
  if (liveCount === 0 && isOpen) setIsOpen(false);
  const hub = usePresence(liveCount > 0);
  const [shownEntries, setShownEntries] = useState(liveEntries);
  if (liveCount > 0 && shownEntries !== liveEntries) setShownEntries(liveEntries);

  const handleStopAll = async () => {
    if (isStoppingAll) return;
    setIsStoppingAll(true);
    try {
      const childThreadIds = new Set<ThreadId>();
      const workflowTasks = new Map<OrchestrationV2Subagent["id"], OrchestrationV2Subagent>();
      for (const agent of liveEntries) {
        if (canOperateWorkflow && canStopNativeWorkflow(agent)) {
          workflowTasks.set(agent.id, agent);
        } else if (canStopAppOwnedSubagent(agent)) {
          childThreadIds.add(agent.childThreadId);
        }
      }
      const results = await Promise.all([
        ...Array.from(childThreadIds, (childThreadId) =>
          interruptTurn({ environmentId, input: { threadId: childThreadId } }),
        ),
        ...Array.from(workflowTasks.values(), (agent) =>
          stopWorkflow({
            environmentId,
            input: { threadId: agent.threadId, subagentId: agent.id },
          }),
        ),
      ]);
      if (results.some((result) => result._tag === "Failure")) {
        toastManager.add({ type: "error", title: "Could not stop all work" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not stop all work" });
    } finally {
      setIsStoppingAll(false);
    }
  };

  if (!hub.mounted) return null;
  const elapsedEntry = oldestStartedAgent(shownEntries);
  const workingSummary =
    shownEntries.length === 1 && shownEntries[0]
      ? `Waiting on ${subagentName(shownEntries[0])}`
      : `Waiting on ${shownEntries.length} agents`;
  const stopLabel = liveCount === 1 ? "Stop" : "Stop all";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={180}
        render={
          <button
            type="button"
            aria-expanded={isOpen}
            aria-haspopup="dialog"
            aria-label={`${workingSummary}. Show working details`}
            data-composer-status-bump="working"
            data-composer-status-bump-visible={hub.shown ? "true" : "false"}
          />
        }
      >
        <span className="flex shrink-0 items-center" aria-hidden="true">
          <AsciiLoader />
        </span>
        <span className="min-w-0 truncate" data-composer-working-label="true">
          {workingSummary}
        </span>
        {elapsedEntry ? (
          <span
            className="shrink-0 text-muted-foreground tabular-nums"
            data-composer-hub-elapsed="true"
          >
            <AgentElapsed
              agent={{
                status: elapsedEntry.status,
                startedAt:
                  elapsedEntry.startedAt == null ? null : DateTime.formatIso(elapsedEntry.startedAt),
                completedAt:
                  elapsedEntry.completedAt == null
                    ? null
                    : DateTime.formatIso(elapsedEntry.completedAt),
              }}
              compact
            />
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Active subagents"
        data-composer-status-popup="working"
        align="start"
        side="top"
        width="lg"
        padding="none"
      >
        <div
          className="cursor-composer-hub-panel"
          role="region"
          aria-label="Active subagents"
          data-rolling-text=""
        >
          <div className="cursor-composer-hub-header">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Working</span>
              <span>
                {liveCount} {liveCount === 1 ? "agent" : "agents"}
              </span>
            </div>
            {hasStoppableWork ? (
              <button
                type="button"
                disabled={isStoppingAll}
                onClick={() => void handleStopAll()}
                data-composer-hub-stop-all="true"
                className="text-xs text-muted-foreground transition-colors hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
              >
                {isStoppingAll ? "Stopping…" : stopLabel}
              </button>
            ) : null}
          </div>
          <ComposerWorkingHubRows
            environmentId={environmentId}
            threadId={threadId}
            liveEntries={shownEntries}
            canOperateWorkflow={canOperateWorkflow}
            stoppingAll={isStoppingAll}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ComposerWorkingHubRows({
  environmentId,
  threadId,
  liveEntries,
  canOperateWorkflow,
  stoppingAll,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly liveEntries: readonly OrchestrationV2Subagent[];
  readonly canOperateWorkflow: boolean;
  readonly stoppingAll: boolean;
}) {
  // The projection keeps no output; the parent's subagent items carry what each agent is writing.
  const turnItems = useThreadVisibleTurnItems(scopeThreadRef(environmentId, threadId));
  const liveContentBySubagent = useMemo(() => {
    const bySubagent = new Map<OrchestrationV2Subagent["id"], OrchestrationV2SubagentLiveContent>();
    for (const { item } of turnItems) {
      if (item.type === "subagent" && item.liveContent) {
        bySubagent.set(item.subagentId, item.liveContent);
      }
    }
    return bySubagent;
  }, [turnItems]);
  const [mountedAgentIds] = useState(() => new Set(liveEntries.map(agentKey)));
  const rows = usePresentList(liveEntries, agentKey);
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLDivElement>(false);

  return (
    <div ref={outerRef} className="overflow-hidden">
      <div ref={contentRef} className="cursor-composer-hub-rows">
        {rows.map(({ item, key, exiting }) => (
          <ComposerWorkingHubRow
            key={key}
            environmentId={environmentId}
            agent={item}
            liveContent={liveContentBySubagent.get(item.id) ?? null}
            entering={!mountedAgentIds.has(key)}
            exiting={exiting}
            canOperateWorkflow={canOperateWorkflow}
            stoppingAll={stoppingAll}
          />
        ))}
      </div>
    </div>
  );
}

function ComposerWorkingHubRow({
  environmentId,
  agent,
  liveContent,
  entering,
  exiting,
  canOperateWorkflow,
  stoppingAll,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: OrchestrationV2Subagent;
  readonly liveContent: OrchestrationV2SubagentLiveContent | null;
  readonly entering: boolean;
  readonly exiting: boolean;
  readonly canOperateWorkflow: boolean;
  readonly stoppingAll: boolean;
}) {
  const [isStopping, setIsStopping] = useState(false);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.v2.stopWorkflow);
  const status = agent.status;
  const statusChanged = useChangedSinceMount(status);
  const isActive = isOrchestrationV2WorkActive(status);
  const canStop =
    canStopAppOwnedSubagent(agent) || (canOperateWorkflow && canStopNativeWorkflow(agent));
  const childLiveStep = useChildThreadLiveStep(
    environmentId,
    isActive && !agent.currentTool ? agent.childThreadId : null,
  );
  const { liveContent: overlayLiveContent, rateLimited } = useSubagentLiveContent(
    scopeThreadRef(environmentId, agent.threadId),
    { active: isActive, subagentId: agent.id, persisted: liveContent },
  );
  const heldActivity = useHeldSubagentActivity({
    status,
    currentTool: agent.currentTool,
    childLiveStep,
    liveContent: overlayLiveContent,
    progress: agent.progress,
    task: agent.prompt,
  });

  const handleStop = async () => {
    if (isStopping || stoppingAll || !canStop) return;
    setIsStopping(true);
    try {
      const result =
        canOperateWorkflow && canStopNativeWorkflow(agent)
          ? await stopWorkflow({
              environmentId,
              input: { threadId: agent.threadId, subagentId: agent.id },
            })
          : canStopAppOwnedSubagent(agent)
            ? await interruptTurn({
                environmentId,
                input: { threadId: agent.childThreadId },
              })
            : null;
      if (result?._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not stop work" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not stop work" });
    } finally {
      setIsStopping(false);
    }
  };

  return (
    // A finished agent's row collapses out; the rows below close up with it.
    <div
      className="motion-row"
      data-exiting={exiting ? "" : undefined}
      data-glide={exiting ? "shrink" : undefined}
    >
      <div>
        <div className={cn("cursor-composer-hub-row motion-tint", entering && "motion-enter")}>
          <span
            key={isActive ? "active" : status}
            className={cn(
              "flex size-3.5 shrink-0 items-center justify-center",
              statusChanged && "motion-swap",
            )}
            aria-hidden="true"
          >
            {isActive ? (
              <AsciiLoader />
            ) : status === "completed" ? (
              <CheckIcon className="size-3.5 text-muted-foreground" />
            ) : status === "failed" ? (
              <CircleXIcon className="size-3.5 status-failed-mark" />
            ) : status === "interrupted" || status === "cancelled" ? (
              <CircleXIcon className="size-3.5 text-muted-foreground" />
            ) : (
              <CircleDashedIcon className="size-3.5 text-muted-foreground" />
            )}
          </span>
          <span className="max-w-[40%] min-w-0 shrink-0 truncate font-medium text-foreground text-xs motion-tint">
            {subagentName(agent)}
          </span>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
            ·
          </span>
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground motion-tint"
            data-composer-hub-activity="true"
          >
            <RollingText text={heldActivity.text} />
            {isActive && rateLimited ? <LiveViewPausedNote /> : null}
          </span>
          {agent.startedAt != null ? (
            <>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
                ·
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums motion-tint">
                <AgentElapsed
                  agent={{
                    status: agent.status,
                    startedAt: DateTime.formatIso(agent.startedAt),
                    completedAt:
                      agent.completedAt == null ? null : DateTime.formatIso(agent.completedAt),
                  }}
                  compact
                />
              </span>
            </>
          ) : null}
          {isActive && canStop ? (
            <button
              type="button"
              aria-label={`Stop ${subagentName(agent)}`}
              disabled={isStopping || stoppingAll}
              onClick={() => void handleStop()}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
            >
              {isStopping ? (
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              ) : (
                <SquareIcon aria-hidden className="size-3 fill-current" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
