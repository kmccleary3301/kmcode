// PROTOTYPE: throwaway work-log tree demo. Not production code.
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { useMemo, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { createTurnItemsProjector } from "./currentTurnItems";
import type { Trace } from "./trace";
import type { TimelineLatestRun } from "../../components/chat/MessagesTimeline.logic";

const ENVIRONMENT_ID = EnvironmentId.make("prototype-worklog");
const OMP_INSTANCE_ID = ProviderInstanceId.make("omp");
const noop = () => {};
const noopFork = async () => {};

export function CurrentTimelinePane(props: {
  readonly trace: Trace;
  readonly t: number;
  readonly transcriptStyle: "minimal" | "minimal-plus";
  readonly paneKey: string;
}) {
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  const [wallClock, setWallClock] = useState(() => ({
    traceId: props.trace.id,
    offsetMs: Date.now() - props.t,
  }));
  if (wallClock.traceId !== props.trace.id) {
    setWallClock({ traceId: props.trace.id, offsetMs: Date.now() - props.t });
  }
  const wallOffsetMs = wallClock.offsetMs;
  const projectItemsAt = useMemo(
    () => createTurnItemsProjector(props.trace, wallOffsetMs),
    [props.trace, wallOffsetMs],
  );
  const items = projectItemsAt(props.t);
  const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = useMemo(
    () =>
      items.map((item, position) => ({
        position,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        item,
      })),
    [items],
  );
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems,
        optimisticMessages: [],
      }),
    [visibleTurnItems],
  );
  const lastEventEnd = useMemo(
    () =>
      props.trace.events.reduce(
        (latest, event) => Math.max(latest, event.end),
        props.trace.prompt.at,
      ),
    [props.trace.events, props.trace.prompt.at],
  );
  const isWorking = props.t < lastEventEnd;
  const fallbackRunId = useMemo(
    () => RunId.make(`prototype-worklog-${props.trace.id}-run`),
    [props.trace.id],
  );
  const runId = items[0]?.runId ?? fallbackRunId;
  const runStartedAtDate = useMemo(
    () => DateTime.makeUnsafe(props.trace.prompt.at + wallOffsetMs),
    [props.trace.prompt.at, wallOffsetMs],
  );
  const runCompletedAtDate = useMemo(
    () => (isWorking ? null : DateTime.makeUnsafe(lastEventEnd + wallOffsetMs)),
    [isWorking, lastEventEnd, wallOffsetMs],
  );
  const runStartedAt = useMemo(() => DateTime.formatIso(runStartedAtDate), [runStartedAtDate]);
  const runCompletedAt = useMemo(
    () => (runCompletedAtDate === null ? null : DateTime.formatIso(runCompletedAtDate)),
    [runCompletedAtDate],
  );
  const latestRun: TimelineLatestRun = useMemo(
    () => ({
      runId,
      status: isWorking ? "running" : "completed",
      startedAt: runStartedAt,
      completedAt: runCompletedAt,
      workCompletedAt: runCompletedAt,
    }),
    [isWorking, runCompletedAt, runId, runStartedAt],
  );
  const runs = useMemo(
    () => [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: OMP_INSTANCE_ID,
        modelSelection: { instanceId: OMP_INSTANCE_ID, model: "prototype" },
        requestedAt: runStartedAtDate,
        startedAt: runStartedAtDate,
        workStartedAt: runStartedAtDate,
        completedAt: runCompletedAtDate,
        ...(runCompletedAtDate === null ? {} : { workCompletedAt: runCompletedAtDate }),
      },
    ],
    [runCompletedAtDate, runId, runStartedAtDate],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <MessagesTimeline
        transcriptStyle={props.transcriptStyle}
        isWorking={isWorking}
        activityStatus={isWorking ? "working" : null}
        activityRunWorkCompletedAt={runCompletedAt}
        activeTurnInProgress={isWorking}
        activeTurnStartedAt={runStartedAt}
        listRef={listRef}
        timelineEntries={timelineEntries}
        latestRun={latestRun}
        runningRunId={isWorking ? runId : null}
        turnDiffSummaries={[]}
        routeThreadKey={`prototype-worklog-${props.paneKey}`}
        onOpenTurnDiff={noop}
        onOpenThread={noop}
        onForkFromRun={noopFork}
        onRollbackCheckpoint={noop}
        supportsConversationRollback={false}
        onRevertToTurnCount={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        activeThreadEnvironmentId={ENVIRONMENT_ID}
        markdownCwd={props.trace.cwd}
        resolvedTheme={resolvedTheme}
        timestampFormat="locale"
        workspaceRoot={props.trace.cwd}
        providerStatuses={[]}
        runs={runs}
        anchorMessageId={null}
        onAnchorReady={noop}
        onAnchorSizeChanged={noop}
        contentInsetEndAdjustment={0}
        onIsAtEndChange={noop}
        liveFollowEnabled
        onManualNavigation={noop}
      />
    </div>
  );
}
