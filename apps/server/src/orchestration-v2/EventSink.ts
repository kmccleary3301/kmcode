import {
  CommandId,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

/**
 * ERRORS
 */
export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface EventSinkV2Shape {
  readonly write: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only when the provider thread is still owned by the
   * expected run attempt and ordinal. Used for late post-terminal
   * provider_thread updates so a completed or superseded attempt cannot clobber
   * a newer attempt that already claimed the thread.
   */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly updateDelegatedCompletionOnlyRunId?: RunId;
    /**
     * Commit only while the run still has this attempt and status, checked in
     * the commit transaction. Otherwise the receipt is recorded as rejected and
     * nothing is written, so a stale snapshot cannot overwrite a newer attempt.
     */
    readonly requireRun?: {
      readonly runId: RunId;
      readonly activeAttemptId: RunAttemptId | null;
      readonly status: OrchestrationV2Run["status"];
    };
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  /**
   * Append a project event, fold it into its row and record the receipt in one
   * transaction. A reused command id commits nothing and returns its receipt.
   */
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  /** Record a rejected project command, or return the receipt its command id already has. */
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    /** Filter before queuing live events so a busy worker retains only the events it handles. */
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

/**
 * IMPLEMENTATIONS
 */
const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });

    const SUBAGENT_SNAPSHOT_INTERVAL_MS = Duration.toMillis(Duration.seconds(2));
    const STREAMING_ITEM_INTERVAL_MS = Duration.toMillis(Duration.millis(250));
    // Tool cards are re-sent while their arguments stream in and on every progress tick, often
    // with only `updatedAt` changed (km-dev 10-29: a pending file_change card stored 347 times in
    // 48 s, ~15 KB each; tool cards were ~85% of new event-log bytes).
    const TOOL_PROGRESS_INTERVAL_MS = Duration.toMillis(Duration.seconds(1));
    const TOOL_PROGRESS_ITEM_TYPES: ReadonlySet<string> = new Set([
      "dynamic_tool",
      "file_change",
      "command_execution",
      "file_search",
      "web_search",
    ]);
    const SNAPSHOT_STATE_IDLE_MS = Duration.toMillis(Duration.minutes(1));
    const SNAPSHOT_FLUSH_RETRY_MS = Duration.toMillis(Duration.seconds(1));
    const TERMINAL_SNAPSHOT_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
    type SnapshotThrottleReservation = {
      readonly key: string;
      readonly event: OrchestrationV2DomainEvent;
      readonly status: string;
      /** A change in any field folded into this key persists immediately. */
      readonly forceKey: string;
      readonly intervalMs: number;
    };
    type SnapshotThrottleState = {
      lastForceKey: string | undefined;
      lastPersistedAt: number | undefined;
      /** Payload of the newest persisted or in-flight throttled snapshot. */
      lastPayload: OrchestrationV2DomainEvent["payload"] | undefined;
      pending: SnapshotThrottleReservation | undefined;
      pendingDueAt: number | undefined;
      flushing: boolean;
    };
    const snapshotThrottleStates = new Map<string, SnapshotThrottleState>();
    // Child-thread model sync runs only for persisted subagent updates, so a
    // model or child-thread change must never wait in the throttle.
    const subagentForceKey = (status: string, model: string | null, childThreadId: string | null) =>
      `${status}\u0000${model ?? ""}\u0000${childThreadId ?? ""}`;
    const snapshotThrottleInfo = (
      event: OrchestrationV2DomainEvent,
    ): SnapshotThrottleReservation | undefined => {
      switch (event.type) {
        case "subagent.updated":
          return {
            key: `subagent:${event.threadId}:${event.payload.id}`,
            event,
            status: event.payload.status,
            forceKey: subagentForceKey(
              event.payload.status,
              event.payload.model,
              event.payload.childThreadId,
            ),
            intervalMs: SUBAGENT_SNAPSHOT_INTERVAL_MS,
          };
        case "turn-item.updated":
          return event.payload.type === "subagent"
            ? {
                key: `turn-item:${event.threadId}:${event.payload.id}`,
                event,
                status: event.payload.status,
                forceKey: subagentForceKey(
                  event.payload.status,
                  event.payload.model ?? null,
                  event.payload.childThreadId,
                ),
                intervalMs: SUBAGENT_SNAPSHOT_INTERVAL_MS,
              }
            : {
                key: `turn-item:${event.threadId}:${event.payload.id}`,
                event,
                status: event.payload.status,
                forceKey: event.payload.status,
                intervalMs:
                  "streaming" in event.payload && event.payload.streaming
                    ? STREAMING_ITEM_INTERVAL_MS
                    : TOOL_PROGRESS_INTERVAL_MS,
              };
        default:
          return undefined;
      }
    };
    // App-owned tasks are low-rate server state machines (delivery claims,
    // wake flags) whose updates must land at once; only provider progress
    // ticks are throttled.
    const shouldThrottleSnapshot = (event: OrchestrationV2DomainEvent): boolean => {
      switch (event.type) {
        case "subagent.updated":
          return event.payload.origin === "provider_native";
        case "turn-item.updated":
          // Provider subagent cards carry no streaming flag, but adapters
          // re-send them on every native progress tick, like subagent.updated.
          // Tool cards are re-sent the same way; status changes still persist at once.
          // A running command's output chunks are kept: background commands report
          // each one as it arrives, often minutes apart.
          if (event.payload.type === "subagent") return event.payload.origin === "provider_native";
          if ("streaming" in event.payload && event.payload.streaming) return true;
          return (
            TOOL_PROGRESS_ITEM_TYPES.has(event.payload.type) &&
            !(event.payload.type === "command_execution" && event.payload.status === "running")
          );
        default:
          return false;
      }
    };
    const newThrottleState = (): SnapshotThrottleState => ({
      lastForceKey: undefined,
      lastPersistedAt: undefined,
      lastPayload: undefined,
      pending: undefined,
      pendingDueAt: undefined,
      flushing: false,
    });
    // Wakes the trailing-flush worker; it sleeps without a timer while nothing is pending.
    const flushWakeups = yield* Queue.sliding<void>(1);
    let lastIdleSweepAt = 0;
    const sweepIdleThrottleStates = (now: number) => {
      lastIdleSweepAt = now;
      for (const [key, state] of snapshotThrottleStates) {
        if (
          state.pending === undefined &&
          !state.flushing &&
          state.lastPersistedAt !== undefined &&
          now - state.lastPersistedAt > SNAPSHOT_STATE_IDLE_MS
        ) {
          snapshotThrottleStates.delete(key);
        }
      }
    };
    /**
     * Pure in-memory step, run before any transaction is opened: callers skip
     * the database entirely when every event is withheld.
     */
    const throttleSnapshotUpdates = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        return yield* Effect.sync(() => {
          if (now - lastIdleSweepAt > SNAPSHOT_STATE_IDLE_MS) sweepIdleThrottleStates(now);
          const persisted: Array<OrchestrationV2DomainEvent> = [];
          const reservations: Array<SnapshotThrottleReservation> = [];
          for (const event of events) {
            const info = snapshotThrottleInfo(event);
            if (info === undefined) {
              persisted.push(event);
              continue;
            }
            const state = snapshotThrottleStates.get(info.key) ?? newThrottleState();
            const forceKeyChanged = state.lastForceKey !== info.forceKey;
            state.lastForceKey = info.forceKey;
            const terminal = TERMINAL_SNAPSHOT_STATUSES.has(info.status);
            const throttleable = shouldThrottleSnapshot(event);
            const forcePersist = forceKeyChanged || terminal || !throttleable;
            if (forcePersist) {
              state.lastPersistedAt = now;
              state.lastPayload = throttleable ? event.payload : undefined;
              state.pending = undefined;
              state.pendingDueAt = undefined;
              if (terminal) {
                snapshotThrottleStates.delete(info.key);
              } else {
                snapshotThrottleStates.set(info.key, state);
              }
              persisted.push(event);
              reservations.push(info);
              continue;
            }
            // Re-sent or flapped-back snapshots match what is already stored.
            // An in-flight flush is about to store its pending payload, so a
            // flap back must still be queued behind it.
            if (
              !state.flushing &&
              state.lastPayload !== undefined &&
              Equal.equals(event.payload, state.lastPayload)
            ) {
              state.pending = undefined;
              state.pendingDueAt = undefined;
              snapshotThrottleStates.set(info.key, state);
              continue;
            }

            const dueAt = (state.lastPersistedAt ?? now) + info.intervalMs;
            if (!state.flushing && now >= dueAt) {
              state.lastPersistedAt = now;
              state.lastPayload = event.payload;
              state.pending = undefined;
              state.pendingDueAt = undefined;
              snapshotThrottleStates.set(info.key, state);
              persisted.push(event);
              reservations.push(info);
              continue;
            }
            state.pending = info;
            state.pendingDueAt = state.flushing ? Math.max(dueAt, now) : dueAt;
            snapshotThrottleStates.set(info.key, state);
            Queue.offerUnsafe(flushWakeups, undefined);
          }
          return { persisted, reservations };
        });
      });
    const requeueSnapshotReservations = (
      reservations: ReadonlyArray<SnapshotThrottleReservation>,
      now: number,
    ) => {
      for (const reservation of reservations) {
        const state = snapshotThrottleStates.get(reservation.key) ?? newThrottleState();
        state.lastForceKey = reservation.forceKey;
        state.lastPersistedAt = now - reservation.intervalMs;
        // Nothing from the failed write is stored, so no payload may be skipped as a duplicate.
        state.lastPayload = undefined;
        if (state.pending === undefined) {
          state.pending = reservation;
        }
        state.pendingDueAt = now;
        snapshotThrottleStates.set(reservation.key, state);
      }
      Queue.offerUnsafe(flushWakeups, undefined);
    };
    const throttleSnapshotEvents = (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      commandId: CommandId | undefined,
    ) =>
      commandId === undefined
        ? throttleSnapshotUpdates(events)
        : Effect.succeed({ persisted: events, reservations: [] });
    const publishStoredEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      events.length === 0
        ? Effect.void
        : eventStore.publishCommitted(events).pipe(Effect.andThen(publishLiveEvents(events)));

    // Transactions commit one at a time, but each writer publishes after its
    // commit. If a writer is descheduled in between, a later commit reaches
    // subscribers first, and clients drop any event at or below the newest
    // sequence they have applied. So a writer takes this lane as the last step
    // of its transaction and holds it until it has published. Publishing never
    // waits, so a writer that holds the transaction while it waits for the
    // lane is not blocked for long.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          let holdsLane = false;
          const takeLane = publishLane.take(1).pipe(
            Effect.andThen(
              Effect.sync(() => {
                holdsLane = true;
              }),
            ),
            Effect.uninterruptible,
          );
          return sql
            .withTransaction(Effect.tap(restore(transaction), () => takeLane))
            .pipe(
              Effect.tap(publish),
              Effect.ensuring(
                Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
              ),
            );
        }),
      );

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      // Throttle before the transaction: withheld snapshot ticks then cost no
      // SQL at all, instead of a BEGIN/COMMIT on the single connection each.
      const throttled = yield* throttleSnapshotEvents(input.events, input.commandId);
      if (throttled.persisted.length === 0 && input.effects.length === 0) {
        return [];
      }
      const attemptedSnapshots = throttled.reservations;
      return yield* commitThenPublish(
        Effect.gen(function* () {
          const candidates =
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(throttled.persisted)
              : throttled.persisted;
          const normalized = yield* normalizeEvents(candidates);
          const committed =
            normalized.length === 0
              ? []
              : yield* eventStore.append({
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  events: normalized,
                });
          yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return committed;
        }),
        (storedEvents) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(storedEvents);
          }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (attemptedSnapshots.length > 0) {
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              yield* Effect.sync(() => requeueSnapshotReservations(attemptedSnapshots, now));
            }
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    });

    const flushThrottledSnapshots = (force = false) =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const ready = yield* Effect.sync(() => {
          const snapshots: Array<SnapshotThrottleReservation> = [];
          for (const state of snapshotThrottleStates.values()) {
            if (force) state.flushing = false;
            if (
              state.pending !== undefined &&
              !state.flushing &&
              (force || (state.pendingDueAt !== undefined && state.pendingDueAt <= now))
            ) {
              state.flushing = true;
              snapshots.push(state.pending);
            }
          }
          sweepIdleThrottleStates(now);
          return snapshots;
        });
        if (ready.length === 0) return;

        yield* commitThenPublish(
          Effect.gen(function* () {
            const normalized = yield* normalizeEvents(
              ready.map((reservation) => reservation.event),
            );
            const committed =
              normalized.length === 0 ? [] : yield* eventStore.append({ events: normalized });
            yield* applyStoredEvents(committed);
            return committed;
          }),
          publishStoredEvents,
        ).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const committedAt = DateTime.toEpochMillis(yield* DateTime.now);
              yield* Effect.sync(() => {
                for (const reservation of ready) {
                  const state = snapshotThrottleStates.get(reservation.key);
                  if (state === undefined) continue;
                  state.flushing = false;
                  state.lastPersistedAt = committedAt;
                  state.lastPayload = reservation.event.payload;
                  if (state.pending?.event === reservation.event) {
                    state.pending = undefined;
                    state.pendingDueAt = undefined;
                  } else if (state.pending !== undefined) {
                    state.pendingDueAt = committedAt + state.pending.intervalMs;
                  }
                  if (
                    TERMINAL_SNAPSHOT_STATUSES.has(reservation.status) &&
                    state.pending === undefined
                  ) {
                    snapshotThrottleStates.delete(reservation.key);
                  }
                }
              });
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const retryAt = DateTime.toEpochMillis(yield* DateTime.now);
              yield* Effect.sync(() => {
                for (const reservation of ready) {
                  const state = snapshotThrottleStates.get(reservation.key) ?? newThrottleState();
                  state.lastForceKey = reservation.forceKey;
                  state.lastPayload = undefined;
                  state.flushing = false;
                  state.lastPersistedAt = retryAt - reservation.intervalMs;
                  if (state.pending === undefined) state.pending = reservation;
                  // The worker wakes on due times, so pace retries of a failing flush here.
                  state.pendingDueAt = retryAt + SNAPSHOT_FLUSH_RETRY_MS;
                  snapshotThrottleStates.set(reservation.key, state);
                }
              });
              yield* Effect.logError("Event snapshot trailing flush failed", {
                cause: Cause.pretty(cause),
              });
            }),
          ),
        );
      });
    yield* Effect.addFinalizer(() =>
      flushThrottledSnapshots(true).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Event snapshot shutdown flush failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
    // Earliest due time of a pending snapshot that is not already being flushed.
    const nextFlushDueAt = () => {
      let dueAt: number | undefined;
      for (const state of snapshotThrottleStates.values()) {
        if (state.pending === undefined || state.flushing || state.pendingDueAt === undefined) {
          continue;
        }
        dueAt = dueAt === undefined ? state.pendingDueAt : Math.min(dueAt, state.pendingDueAt);
      }
      return dueAt;
    };
    yield* Effect.gen(function* () {
      while (true) {
        const dueAt = nextFlushDueAt();
        if (dueAt === undefined) {
          yield* Queue.take(flushWakeups);
          continue;
        }
        const delayMs = dueAt - DateTime.toEpochMillis(yield* DateTime.now);
        if (delayMs > 0) {
          // A newer pending snapshot may be due sooner (streaming items use a shorter interval).
          yield* Effect.raceFirst(Effect.sleep(Duration.millis(delayMs)), Queue.take(flushWakeups));
          continue;
        }
        yield* flushThrottledSnapshots().pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Event snapshot flush worker failed", { cause: Cause.pretty(cause) }),
          ),
        );
      }
    }).pipe(Effect.forkScoped);

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const candidates =
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(input.events)
                : input.events;
            const throttled = yield* throttleSnapshotEvents(candidates, input.commandId);
            const normalized = yield* normalizeEvents(throttled.persisted);
            const storedEvents =
              normalized.length === 0
                ? []
                : yield* eventStore.append({
                    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                    events: normalized,
                  });
            yield* applyStoredEvents(storedEvents);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const candidates =
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events;
          const throttled = yield* throttleSnapshotEvents(candidates, input.commandId);
          const normalized = yield* normalizeEvents(throttled.persisted);
          const storedEvents =
            normalized.length === 0
              ? []
              : yield* eventStore.append({
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  events: normalized,
                });
          yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents };
        }),
        (result) => (result.committed ? publishStoredEvents(result.storedEvents) : Effect.void),
      );
    });

    const existingCommandResult = (commandId: CommandId) =>
      Effect.gen(function* () {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          const requiredRun = input.requireRun;
          if (requiredRun !== undefined) {
            const { runs } = yield* projectionStore.getThreadRecords(input.threadId, ["runs"], {
              runIds: [requiredRun.runId],
            });
            const current = runs.find((run) => run.id === requiredRun.runId);
            if (
              current === undefined ||
              current.status !== requiredRun.status ||
              current.activeAttemptId !== requiredRun.activeAttemptId
            ) {
              const receipt: CommandReceiptStore.CommandReceiptV2 = {
                commandId: input.commandId,
                threadId: input.threadId,
                commandType: input.commandType,
                acceptedAt: input.acceptedAt,
                resultSequence: yield* eventStore.latestSequence({ threadId: input.threadId }),
                status: "rejected",
                error: `Run ${requiredRun.runId} moved past the attempt this command was prepared for.`,
              };
              yield* commandReceipts.upsert(receipt);
              return {
                receipt,
                storedEvents: [],
                committed: false as const,
                cancelledEffectIds: [],
              };
            }
          }

          const completionRunId = input.updateDelegatedCompletionOnlyRunId;
          const events =
            completionRunId === undefined
              ? input.events
              : yield* Effect.forEach(input.events, (event) =>
                  Effect.gen(function* () {
                    if (event.type !== "run.updated" || event.payload.id !== completionRunId)
                      return event;
                    const { runs } = yield* projectionStore.getThreadRecords(
                      event.threadId,
                      ["runs"],
                      { runIds: [completionRunId] },
                    );
                    const current = runs[0];
                    return current === undefined
                      ? event
                      : {
                          ...event,
                          payload: {
                            ...current,
                            delegatedCompletion: event.payload.delegatedCompletion,
                          },
                        };
                  }),
                );
          const normalized = yield* normalizeEvents(events);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          const sequence = storedEvents.at(-1)?.sequence;
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents);
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Event sink layer for application compositions that already own the
 * persistence services. Keeping the outbox instance shared with the worker is
 * important because enqueue notifications are in-memory wakeups backed by the
 * durable SQL queue.
 */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
