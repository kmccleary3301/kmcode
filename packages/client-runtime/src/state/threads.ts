import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadActivityPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  environmentThreadLiveOverlayAtom,
  reduceThreadLiveOverlay,
  resetThreadLiveOverlay,
} from "./threadLiveOverlay.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import {
  fetchEnvironmentThreadActivityPage,
  fetchEnvironmentThreadHistoryPage,
} from "./threadHistoryHttp.ts";
import {
  EMPTY_THREAD_ACTIVITY_STATE,
  activityPageRequestKey,
  activitySummaryRefreshRequestsForLiveRow,
  beginThreadActivityRequest,
  failThreadActivityRequest,
  mergeThreadActivityLiveRow,
  mergeThreadActivityPage,
  mergeThreadActivitySummaries,
  resetThreadActivityState,
  type ThreadActivityPageRequest,
  type ThreadActivityState,
} from "./threadActivityMerge.ts";
import {
  applyHistoryPageMeta,
  clearHistoryRequestLoading,
  EMPTY_THREAD_HISTORY_META,
  isActiveHistoryRequest,
  isActiveHistoryRequestCursor,
  mergeHistoryIntoProjection,
  type ThreadHistoryMeta,
} from "./threadHistoryMerge.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function formatHistoryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not load earlier activity.";
}

function historyMetaFromCachedSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
): ThreadHistoryMeta {
  const historyCursor = snapshot.historyCursor ?? null;
  const hasMoreHistory = snapshot.hasMoreHistory ?? false;
  return {
    historyCursor,
    hasMoreHistory,
    loading: false,
    error: null,
    // Cache never stores expanded progressive history (load-earlier growth).
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly acceptsBoundedSnapshots?: boolean;
}

interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  projection: OrchestrationV2ThreadProjection | null,
  sequence: number,
  history: Pick<ThreadHistoryMeta, "historyCursor" | "hasMoreHistory" | "latestLocalTurnOrdinal">,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== projection)
    return false;
  const currentHistory = current.state.history;
  return (
    currentHistory.historyCursor === history.historyCursor &&
    currentHistory.hasMoreHistory === history.hasMoreHistory &&
    (!(history.hasMoreHistory || history.historyCursor !== null) ||
      currentHistory.latestLocalTurnOrdinal === history.latestLocalTurnOrdinal)
  );
}

// A retained "live" state stays live: the cursor resume that follows only
// replays what the thread missed, and on servers that send the completion
// marker the first replayed event moves the status to "synchronizing" on its
// own. Downgrading here would flash a sync label on every return to a
// recently viewed thread.
function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    history: { ...value.history, loading: false, error: null },
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
  const historyController = yield* Effect.serviceOption(
    ThreadHistoryController.ThreadHistoryController,
  );
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const dpopSigner = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const retained = resumeCache?.snapshot;
  const owner = {};
  if (resumeCache) resumeCache.owner = owner;
  const cached =
    retained === undefined
      ? yield* cache.loadThread(environmentId, threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached thread.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
            ),
          ),
        )
      : Option.none<OrchestrationV2ThreadDetailSnapshot>();
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const initialState: EnvironmentThreadState = retained
    ? cachedThreadState(retained.state)
    : {
        data: cachedThread,
        status: statusWithoutLiveData(cachedThread),
        error: Option.none(),
        history: Option.match(cached, {
          onNone: () => EMPTY_THREAD_HISTORY_META,
          onSome: historyMetaFromCachedSnapshot,
        }),
        activity: EMPTY_THREAD_ACTIVITY_STATE,
      };
  const state = yield* SubscriptionRef.make(initialState);
  const scope = yield* Scope.Scope;
  const historyRequestCounter = yield* Ref.make(0);
  const pendingSummaryRefreshes = yield* Ref.make({
    scheduled: false,
    requests: new Map<string, ThreadActivityPageRequest>(),
  });
  // Paging support belongs to the client, even when the initial HTTP request
  // fails. A bounded socket reset retains a cursor so history can be retried.
  const canLoadHistory = Option.isSome(httpClient) && Option.isSome(historyController);
  const acceptsBoundedSocketSnapshots = yield* Ref.make(canLoadHistory);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const initialSequence =
    retained?.sequence ??
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence });
  const lastSequence = yield* SubscriptionRef.make(initialSequence);
  let committed: ThreadResumeSnapshot = {
    state: initialState,
    sequence: initialSequence,
    persisted: retained?.persisted ?? Option.isSome(cached),
    acceptsBoundedSnapshots: canLoadHistory,
  };
  if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  const awaitingCompletion = yield* Ref.make(false);
  const applyLock = yield* Semaphore.make(1);
  // Save only completed data/cursor updates. A canceled scope must not cache
  // a cursor whose event has not reached the data yet.
  const remember = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const sequence = yield* SubscriptionRef.get(lastSequence);
    committed = {
      state: current,
      sequence,
      acceptsBoundedSnapshots: yield* Ref.get(acceptsBoundedSocketSnapshots),
      persisted:
        committed.persisted &&
        matchesThreadSnapshot(committed, Option.getOrNull(current.data), sequence, current.history),
    };
    if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  });
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    // A deletion can arrive while an older snapshot waits in the persistence queue.
    if (committed.state.status === "deleted") return;
    if (
      committed.persisted &&
      matchesThreadSnapshot(
        committed,
        snapshot.projection,
        snapshot.snapshotSequence,
        historyMetaFromCachedSnapshot(snapshot),
      )
    )
      return;
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (
            !matchesThreadSnapshot(
              committed,
              snapshot.projection,
              snapshot.snapshotSequence,
              historyMetaFromCachedSnapshot(snapshot),
            )
          )
            return;
          committed = { ...committed, persisted: true };
          if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const { state: current, sequence: snapshotSequence } = committed;
      return Option.match(current.data, {
        onNone: () => Effect.void,
        onSome: (projection) =>
          shouldPersistThread(projection, current.history)
            ? persist(
                snapshotToPersist(
                  snapshotSequence,
                  projection,
                  current.history,
                  committed.acceptsBoundedSnapshots === true,
                ),
              )
            : Effect.void,
      });
    }),
  );

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setConnecting = SubscriptionRef.update(state, (current) =>
    current.status === "deleted" || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted" || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (message: string) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(message),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    options?: {
      /** Socket/full snapshots: drop progressive meta with the new timeline. */
      readonly resetHistory?: boolean;
      /**
       * Explicit progressive meta installed atomically with the projection
       * (bounded HTTP). Wins over resetHistory when both are supplied.
       */
      readonly history?: ThreadHistoryMeta;
      readonly activity?: ThreadActivityState;
    },
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    // Atomic with concurrent history meta updates: never get-then-set the whole
    // state when only the projection changes. Bounded installs pass history so
    // projection + cursor persist together in one enqueue.
    const next = yield* SubscriptionRef.updateAndGet(state, (previous) => {
      const history =
        options?.history !== undefined
          ? options.history
          : options?.resetHistory === true
            ? EMPTY_THREAD_HISTORY_META
            : previous.history;
      return {
        ...previous,
        data: Option.some(thread),
        // Buffered values from a failed attempt can arrive after its error.
        status: Option.isSome(previous.error)
          ? ("cached" as const)
          : waiting
            ? ("synchronizing" as const)
            : ("live" as const),
        error: previous.error,
        history,
        activity:
          options?.activity === undefined
            ? options?.resetHistory === true
              ? resetThreadActivityState(previous.activity)
              : previous.activity
            : {
                ...options.activity,
                generation: Math.max(
                  options.activity.generation,
                  previous.activity.generation +
                    (options.activity.mode === previous.activity.mode ? 0 : 1),
                ),
              },
      };
    });
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path. Progressive meta rides along when the window is incomplete.
    if (shouldPersistThread(thread, next.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(
        persistence,
        snapshotToPersist(
          snapshotSequence,
          thread,
          next.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const patchHistoryMeta = (patch: (history: ThreadHistoryMeta) => ThreadHistoryMeta) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      history: patch(current.history),
    }));

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
      activity: EMPTY_THREAD_ACTIVITY_STATE,
    });
    yield* remember;
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
  type SequencedItem = Extract<
    OrchestrationV2ThreadStreamItem,
    { kind: "event" | "unknown-event" }
  >;
  const applyEventsLocked = Effect.fn("EnvironmentThreadState.applyEventsLocked")(function* (
    items: ReadonlyArray<SequencedItem>,
  ) {
    const appliedSequence = yield* SubscriptionRef.get(lastSequence);
    let sequence = appliedSequence;
    const fresh: EventItem[] = [];
    for (const item of items) {
      if (item.sequence <= sequence) continue;
      // An event type from a newer server still moves the resume cursor past it.
      sequence = item.sequence;
      if (item.kind === "event") {
        fresh.push(item);
        continue;
      }
      yield* Effect.logDebug("Skipped a thread event type this client does not know.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          // Bounded: the type comes from a newer server and is not validated here.
          eventType: item.eventType.slice(0, 64),
          sequence: item.sequence,
        }),
      );
    }
    if (sequence === appliedSequence) return;
    yield* SubscriptionRef.set(lastSequence, sequence);
    if (fresh.length === 0) return;

    const waiting = yield* Ref.get(awaitingCompletion);
    // Apply against the latest projection/history in one update so a concurrent
    // loadEarlier merge (or history-meta patch) cannot be clobbered by a stale
    // get-then-set rebuild.
    type EventApplyResult =
      | { readonly _tag: "noop" }
      | { readonly _tag: "delete" }
      | {
          readonly _tag: "applied";
          readonly projection: OrchestrationV2ThreadProjection;
          readonly history: ThreadHistoryMeta;
          readonly persist: boolean;
        };

    const applyEvent = (
      current: EnvironmentThreadState,
      item: EventItem,
    ): readonly [EventApplyResult, EnvironmentThreadState] => {
      if (current.status === "deleted") {
        return [{ _tag: "noop" }, current];
      }
      if (Option.isNone(current.data)) {
        return [
          item.event.type === "thread.deleted" ? { _tag: "delete" } : { _tag: "noop" },
          current,
        ];
      }
      if (item.event.type === "thread.deleted") {
        return [{ _tag: "delete" }, current];
      }

      // Incomplete progressive windows only (hasMore or open cursor). Do not
      // use expanded: it remains true after the last page as a cache marker.
      // Full/web and fully-loaded timelines keep default append-on-miss.
      const partial =
        current.history.hasMoreHistory || current.history.historyCursor !== null
          ? {
              partialTimeline: true as const,
              latestLocalTurnOrdinal: current.history.latestLocalTurnOrdinal,
            }
          : undefined;
      const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event, partial);
      const activity =
        item.event.type === "turn-item.updated"
          ? mergeThreadActivityLiveRow(
              current.activity,
              {
                sourceThreadId: item.event.payload.threadId,
                sourceItemId: item.event.payload.id,
                visibility: "local",
                ordinal: item.event.payload.ordinal,
                item: item.event.payload,
                orderKey: {
                  sourceThreadId: item.event.payload.threadId,
                  ordinal: item.event.payload.ordinal,
                  itemId: item.event.payload.id,
                },
              },
              item.sequence,
            )
          : current.activity;
      const projection = next ?? current.data.value;
      const projectionChanged = projection !== current.data.value;
      const activityChanged = activity !== current.activity;
      if (!projectionChanged && !activityChanged) {
        return [{ _tag: "noop" }, current];
      }

      let history = current.history;
      if (partial !== undefined && item.event.type === "turn-item.updated") {
        const ordinal = item.event.payload.ordinal;
        const watermark = history.latestLocalTurnOrdinal;
        if (watermark === null || ordinal > watermark) {
          history = { ...history, latestLocalTurnOrdinal: ordinal };
        }
      }

      const updated: EnvironmentThreadState = {
        ...current,
        data: projectionChanged ? Option.some(projection) : current.data,
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        history,
        activity,
      };
      return [
        {
          _tag: "applied",
          projection,
          history: updated.history,
          persist: projectionChanged,
        },
        updated,
      ];
    };

    const result = yield* SubscriptionRef.modify(
      state,
      (current): readonly [EventApplyResult, EnvironmentThreadState] => {
        let result: EventApplyResult = { _tag: "noop" };
        for (const item of fresh) {
          const [applied, next] = applyEvent(current, item);
          current = next;
          if (applied._tag !== "noop") result = applied;
          if (applied._tag === "delete") break;
        }
        return [result, current];
      },
    );

    const latest = yield* SubscriptionRef.get(state);
    for (const item of fresh) {
      if (item.event.type !== "turn-item.updated") continue;
      const row = {
        sourceThreadId: item.event.payload.threadId,
        sourceItemId: item.event.payload.id,
        visibility: "local" as const,
        ordinal: item.event.payload.ordinal,
        item: item.event.payload,
        orderKey: {
          sourceThreadId: item.event.payload.threadId,
          ordinal: item.event.payload.ordinal,
          itemId: item.event.payload.id,
        },
      };
      for (const request of activitySummaryRefreshRequestsForLiveRow(latest.activity, row)) {
        yield* enqueueSummaryRefresh(request);
      }
    }
    if (result._tag === "delete") {
      yield* setDeleted();
      return;
    }
    if (
      result._tag === "applied" &&
      result.persist &&
      shouldPersistThread(result.projection, result.history)
    ) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(
        persistence,
        snapshotToPersist(
          snapshotSequence,
          result.projection,
          result.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted" && Option.isNone(current.error)
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      const current = yield* SubscriptionRef.get(state);
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      const hasProgressiveHistory =
        item.historyCursor !== undefined ||
        item.hasMoreHistory !== undefined ||
        item.latestLocalTurnOrdinal !== undefined;
      const activity =
        item.activityMode === "summary-v1" && item.activitySummaries !== undefined
          ? mergeThreadActivitySummaries(current.activity, {
              snapshotSequence: item.snapshotSequence,
              activitySummaries: item.activitySummaries,
            })
          : resetThreadActivityState(current.activity);
      yield* setThread(item.projection, {
        ...(hasProgressiveHistory
          ? {
              history: {
                historyCursor: item.historyCursor ?? null,
                hasMoreHistory: item.hasMoreHistory ?? false,
                loading: false,
                error: null,
                expanded: false,
                latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null,
              },
            }
          : { resetHistory: true }),
        activity,
      });
      return;
    }

    yield* applyEventsLocked([item]);
  });
  const applyItems = Effect.fn("EnvironmentThreadState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationV2ThreadStreamItem>,
  ) {
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        let events: SequencedItem[] = [];
        for (const item of items) {
          if (
            item.kind === "unknown-event" ||
            (item.kind === "event" && item.event.type !== "thread.deleted")
          ) {
            events.push(item);
            continue;
          }
          yield* applyEventsLocked(events);
          events = [];
          yield* applyItemLocked(item);
        }
        yield* applyEventsLocked(events);
        yield* remember;
      }),
    );
  });

  const loadEarlier = Effect.fn("EnvironmentThreadState.loadEarlier")(function* (
    throughEntryId?: string,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const directTarget = throughEntryId !== undefined;
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      (!directTarget && (!current.history.hasMoreHistory || current.history.historyCursor === null))
    ) {
      return { _tag: "noop" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    if (current.history.loading) {
      return { _tag: "busy" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }

    // Cursor loads are fenced to the exact cursor; direct targets are one bounded
    // lookup and merge into whatever live projection exists when they complete.
    const requestCursor = directTarget ? null : current.history.historyCursor;
    const requestId = yield* Ref.updateAndGet(historyRequestCounter, (value) => value + 1);
    yield* patchHistoryMeta((history) =>
      directTarget ||
      (requestCursor !== null && isActiveHistoryRequestCursor(requestCursor, history))
        ? { ...history, loading: true, error: null, activeRequestId: requestId }
        : history,
    );

    const runLoad = Effect.gen(function* () {
      const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(preparedOption) || Option.isNone(httpClient)) {
        const message = "Environment is not connected.";
        const stillCurrent = yield* SubscriptionRef.modify(
          state,
          (latest): readonly [boolean, EnvironmentThreadState] => {
            const active =
              isActiveHistoryRequest(requestId, latest.history) &&
              (directTarget ||
                (requestCursor !== null &&
                  isActiveHistoryRequestCursor(requestCursor, latest.history)));
            if (!active) return [false, latest];
            const history = clearHistoryRequestLoading(requestId, latest.history);
            return [
              true,
              {
                ...latest,
                history: { ...history, error: message },
              },
            ];
          },
        );
        if (!stillCurrent) {
          return { _tag: "noop" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
        }
        return {
          _tag: "error",
          message,
        } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
      }

      const pageResult = yield* fetchEnvironmentThreadHistoryPage({
        prepared: preparedOption.value,
        threadId,
        ...(requestCursor === null ? {} : { cursor: requestCursor }),
        ...(directTarget ? { throughEntryId, view: "conversation" as const } : {}),
        signer: dpopSigner,
        remoteAuthorization,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);

      if (Result.isFailure(pageResult)) {
        const message = formatHistoryError(pageResult.failure);
        const stillCurrent = yield* SubscriptionRef.modify(
          state,
          (latest): readonly [boolean, EnvironmentThreadState] => {
            const active =
              isActiveHistoryRequest(requestId, latest.history) &&
              (directTarget ||
                (requestCursor !== null &&
                  isActiveHistoryRequestCursor(requestCursor, latest.history)));
            if (!active) return [false, latest];
            const history = clearHistoryRequestLoading(requestId, latest.history);
            return [
              true,
              {
                ...latest,
                history: { ...history, error: message },
              },
            ];
          },
        );
        if (!stillCurrent) {
          return { _tag: "noop" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
        }
        return {
          _tag: "error",
          message,
        } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
      }

      const page = pageResult.success;
      const waiting = yield* Ref.get(awaitingCompletion);
      return yield* applyLock.withPermits(1)(
        SubscriptionRef.modify(
          state,
          (
            latest,
          ): readonly [
            ThreadHistoryController.ThreadHistoryLoadEarlierResult,
            EnvironmentThreadState,
          ] => {
            if (
              latest.status === "deleted" ||
              Option.isNone(latest.data) ||
              !isActiveHistoryRequest(requestId, latest.history) ||
              (!directTarget &&
                (requestCursor === null ||
                  !isActiveHistoryRequestCursor(requestCursor, latest.history)))
            ) {
              return [{ _tag: "noop" }, latest];
            }
            const merged = mergeHistoryIntoProjection(latest.data.value, page.items);
            return [
              { _tag: "loaded" },
              {
                ...latest,
                data: Option.some(merged),
                status: waiting
                  ? ("synchronizing" as const)
                  : latest.status === "live"
                    ? ("live" as const)
                    : latest.status,
                history: directTarget
                  ? {
                      ...clearHistoryRequestLoading(requestId, latest.history),
                      error: null,
                      expanded: true,
                    }
                  : applyHistoryPageMeta(latest.history, page),
              },
            ];
          },
        ).pipe(Effect.tap(() => remember)),
      );
    });

    return yield* runLoad.pipe(
      Effect.onInterrupt(() =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          history: clearHistoryRequestLoading(requestId, latest.history),
        })),
      ),
    );
  });
  const loadActivityPage = Effect.fn("EnvironmentThreadState.loadActivityPage")(function* (
    request: ThreadActivityPageRequest,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      current.activity.mode !== "summary-v1"
    ) {
      return { _tag: "noop" } satisfies ThreadHistoryController.ThreadActivityLoadResult;
    }
    const requestKey = activityPageRequestKey(request);
    const activityGeneration = current.activity.generation;
    if (current.activity.loadingRequestKeys.has(requestKey)) {
      return { _tag: "busy" } satisfies ThreadHistoryController.ThreadActivityLoadResult;
    }
    const started = yield* SubscriptionRef.modify(
      state,
      (latest): readonly [boolean, EnvironmentThreadState] => {
        if (
          latest.status === "deleted" ||
          Option.isNone(latest.data) ||
          latest.activity.mode !== "summary-v1" ||
          latest.activity.generation !== activityGeneration ||
          latest.activity.loadingRequestKeys.has(requestKey)
        ) {
          return [false, latest];
        }
        return [
          true,
          { ...latest, activity: beginThreadActivityRequest(latest.activity, request) },
        ];
      },
    );
    if (!started) {
      return { _tag: "busy" } satisfies ThreadHistoryController.ThreadActivityLoadResult;
    }

    const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
    let pageResult: Result.Result<OrchestrationV2ThreadActivityPage, unknown>;
    if (Option.isNone(preparedOption) || Option.isNone(httpClient)) {
      pageResult = Result.fail("Environment is not connected.");
    } else {
      pageResult = yield* fetchEnvironmentThreadActivityPage({
        prepared: preparedOption.value,
        threadId,
        pageRequest: request,
        signer: dpopSigner,
        remoteAuthorization,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);
    }
    if (Result.isFailure(pageResult)) {
      const message =
        typeof pageResult.failure === "string"
          ? pageResult.failure
          : formatHistoryError(pageResult.failure);
      return yield* SubscriptionRef.modify(
        state,
        (
          latest,
        ): readonly [ThreadHistoryController.ThreadActivityLoadResult, EnvironmentThreadState] => {
          if (
            latest.activity.mode !== "summary-v1" ||
            latest.activity.generation !== activityGeneration
          ) {
            return [{ _tag: "noop" }, latest];
          }
          return [
            { _tag: "error", message },
            {
              ...latest,
              activity: failThreadActivityRequest(latest.activity, request, message),
            },
          ];
        },
      );
    }

    return yield* applyLock.withPermits(1)(
      SubscriptionRef.modify(
        state,
        (
          latest,
        ): readonly [ThreadHistoryController.ThreadActivityLoadResult, EnvironmentThreadState] => {
          if (
            latest.status === "deleted" ||
            Option.isNone(latest.data) ||
            latest.activity.mode !== "summary-v1" ||
            latest.activity.generation !== activityGeneration
          ) {
            return [{ _tag: "noop" }, latest];
          }
          return [
            { _tag: "loaded" },
            {
              ...latest,
              activity: mergeThreadActivityPage(latest.activity, pageResult.success, request),
            },
          ];
        },
      ).pipe(Effect.tap(() => remember)),
    );
  });

  const enqueueSummaryRefresh = (request: ThreadActivityPageRequest) =>
    Effect.gen(function* () {
      const key = activityPageRequestKey(request);
      const shouldStart = yield* Ref.modify(pendingSummaryRefreshes, (current) => {
        const requests = new Map(current.requests);
        requests.set(key, request);
        return [
          !current.scheduled,
          {
            scheduled: true,
            requests,
          },
        ];
      });
      if (!shouldStart) return;
      yield* Effect.forkIn(scope)(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("250 millis");
            const batch = yield* Ref.modify(pendingSummaryRefreshes, (current) => {
              if (current.requests.size === 0) {
                return [
                  null,
                  {
                    scheduled: false,
                    requests: new Map<string, ThreadActivityPageRequest>(),
                  },
                ] as const;
              }
              return [
                Array.from(current.requests.values()),
                { ...current, requests: new Map<string, ThreadActivityPageRequest>() },
              ] as const;
            });
            if (batch === null) return;
            for (const refresh of batch) yield* loadActivityPage(refresh);
          }
        }),
      );
    });
  if (Option.isSome(historyController)) {
    const registration = yield* historyController.value.register(environmentId, threadId, {
      loadEarlier: (throughEntryId) =>
        loadEarlier(throughEntryId).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
      loadActivityPage: (request) =>
        loadActivityPage(request).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    });
    yield* Effect.addFinalizer(() => historyController.value.unregister(registration));
  }

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setConnecting;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  // Only the first subscription after a warm live resume keeps the retained
  // status. A replacement session or foreground resubscribe on the same scope
  // may have missed events, so those show sync progress until confirmed.
  const resumingLive = yield* Ref.make(initialState.status === "live");
  const markSynchronizing = Effect.gen(function* () {
    if (yield* Ref.get(resumingLive)) return;
    // Connection notifications do not establish that a terminated load restarted.
    // Clear its diagnostic only when this subscription actually tries again.
    yield* SubscriptionRef.update(state, (current) =>
      current.status === "deleted"
        ? current
        : { ...current, status: "synchronizing" as const, error: Option.none() },
    );
  });

  yield* markSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        let current = yield* SubscriptionRef.get(state);
        // A prior definitive miss (or delete event) already cleared this thread.
        // Park the subscription attempt without opening the socket so we do not
        // retry forever against a known-missing id.
        if (current.status === "deleted") {
          return yield* Effect.never;
        }

        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* markSynchronizing;
        yield* Ref.set(resumingLive, false);

        if (Option.isNone(current.data)) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpResult: ThreadSnapshotLoader.ThreadSnapshotLoadResult =
            yield* snapshotLoader.load(prepared, threadId);
          switch (httpResult._tag) {
            case "present": {
              if (canLoadHistory && httpResult.history !== undefined) {
                yield* Ref.set(acceptsBoundedSocketSnapshots, true);
              }
              // Atomic projection + progressive meta so a settled bounded window
              // never persists as a complete full-timeline cache entry. Socket
              // snapshots still go through applyItem (resetHistory).
              yield* applyLock.withPermits(1)(
                Effect.gen(function* () {
                  yield* SubscriptionRef.set(lastSequence, httpResult.snapshot.snapshotSequence);
                  const history: ThreadHistoryMeta =
                    httpResult.history !== undefined
                      ? {
                          historyCursor: httpResult.history.historyCursor,
                          hasMoreHistory: httpResult.history.hasMoreHistory,
                          loading: false,
                          error: null,
                          expanded: false,
                          latestLocalTurnOrdinal: httpResult.history.latestLocalTurnOrdinal ?? null,
                        }
                      : EMPTY_THREAD_HISTORY_META;
                  yield* setThread(httpResult.snapshot.projection, {
                    history,
                    activity: httpResult.activity ?? EMPTY_THREAD_ACTIVITY_STATE,
                  });
                  yield* remember;
                }),
              );
              current = yield* SubscriptionRef.get(state);
              break;
            }
            case "missing": {
              // Definitive HTTP 404: clear any stale cache and do not open or
              // retry a socket subscription for this attempt.
              yield* setDeleted();
              return yield* Effect.never;
            }
            case "unavailable": {
              // Transient HTTP failure: fall through to the socket path.
              break;
            }
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        const acceptBoundedSnapshot = yield* Ref.get(acceptsBoundedSocketSnapshots);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          activityMode: "summary-v1" as const,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          ...(acceptBoundedSnapshot ? { acceptBoundedSnapshot: true as const } : {}),
        };
      }),
      {
        onDefect: () => setStreamError("Could not synchronize the thread."),
        onExpectedFailure: (cause) => setStreamError(formatThreadError(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEachArray(applyItems)),
  );

  return state;
});

function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache: ThreadResumeCache | undefined,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache).pipe(Effect.map(SubscriptionRef.changes)),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ThreadSnapshotLoader.ThreadSnapshotLoader
    | R,
    E
  >,
) {
  // Cache definitions must outlive collectible live-atom definitions. The
  // registry retains these nodes without retaining environment or RPC scopes.
  const resumeFamily = Atom.family((key: string) =>
    Atom.make((): ThreadResumeCache => ({
      snapshot: undefined,
      owner: undefined,
    })).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const resumeAtom = resumeFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(resumeAtom);
          const resume = get.once(resumeAtom);
          const live = threadStateChanges(environmentId, threadId, resume);
          return resume.snapshot === undefined
            ? live
            : Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live);
        },
        {
          initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
        },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });
  const liveOverlaySubscriptionFamily = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const overlayAtom = environmentThreadLiveOverlayAtom(environmentId, threadId);
    return runtime
      .atom(
        (get) => {
          const registry = get.registry;
          const stream = subscribeDynamic(
            ORCHESTRATION_V2_WS_METHODS.subscribeThreadLive,
            () =>
              Effect.sync(() => {
                registry.set(overlayAtom, resetThreadLiveOverlay());
                return { threadId };
              }),
            {
              onDefect: () => Effect.void,
              onExpectedFailure: () => Effect.void,
              retryExpectedFailureAfter: "250 millis",
            },
          ).pipe(
            Stream.mapEffect((item) =>
              Effect.sync(() => {
                const current = registry.get(overlayAtom) ?? resetThreadLiveOverlay();
                const next = reduceThreadLiveOverlay(current, item);
                registry.set(overlayAtom, next);
                return next;
              }),
            ),
            Stream.ensuring(
              Effect.sync(() => {
                registry.set(overlayAtom, resetThreadLiveOverlay());
              }),
            ),
          );
          return followStreamInEnvironment(environmentId, stream);
        },
        { initialValue: resetThreadLiveOverlay() },
      )
      .pipe(
        Atom.setIdleTTL(0),
        Atom.withLabel(`environment-thread-live-overlay-subscription:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
    liveOverlaySubscriptionAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      liveOverlaySubscriptionFamily(threadKey({ environmentId, threadId })),
    /**
     * Restarts a detail stream parked on "deleted" for a thread the shell still
     * lists: a snapshot read that raced the thread's creation got a 404. The
     * retained "deleted" would otherwise park every remount too.
     */
    reviveDeleted: (
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentIdType,
      threadId: ThreadIdType,
    ) => {
      const key = threadKey({ environmentId, threadId });
      const current = AsyncResult.value(registry.get(family(key)));
      if (!Option.exists(current, (state) => state.status === "deleted")) return;
      const resume = registry.get(resumeFamily(key));
      // Clearing the owner keeps the parked stream from re-saving "deleted".
      resume.snapshot = undefined;
      resume.owner = undefined;
      registry.refresh(family(key));
    },
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * as BoundedThreadSnapshotLoader from "./boundedThreadSnapshotHttp.ts";
export * as ThreadHistoryController from "./threadHistoryController.ts";
// Flat so consumers' inferred types can name it.
export type { ThreadHistoryLoadEarlierResult } from "./threadHistoryController.ts";
export * from "./threadHistoryMerge.ts";
export * from "./threadActivityMerge.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
export * from "./threadLiveOverlay.ts";
