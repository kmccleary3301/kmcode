import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { emptyProjection } from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect("leaves durable effects for the worker after runtime reconciliation", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([]),
          }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.map((count) => count < 2),
            ),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.recover),
      Effect.provide(layer),
    );
    assert.deepEqual(summary, {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    });
    assert.equal(yield* Ref.get(runs), 0);
  }),
);

it.effect("reads recovery projections only for threads that need runtime recovery", () => {
  const settledThreadIds = Array.from({ length: 1_000 }, (_, index) =>
    ThreadId.make(`thread_recovery_settled_${index}`),
  );
  const recoveryThreadId = ThreadId.make("thread_recovery_candidate");
  const projectionReads = vi.fn<(threadId: ThreadId) => void>();
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [...settledThreadIds, recoveryThreadId].map((id) => ({ id })),
              archivedThreads: [],
            } as never),
          getRecoveryThreadIds: () => Effect.succeed([recoveryThreadId]),
          getRuntimeRecoveryProjection: (threadId) => {
            projectionReads(threadId);
            return Effect.succeed({
              thread: { id: threadId },
              runtimeRequests: [],
              providerSessions: [],
              providerThreads: [],
              providerTurns: [],
              runs: [],
              attempts: [],
              nodes: [],
              subagents: [],
              messages: [],
              turnItems: [],
            } as unknown as OrchestrationV2ThreadProjection);
          },
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    assert.deepEqual(
      projectionReads.mock.calls.map(([threadId]) => threadId),
      [recoveryThreadId],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
    },
  );
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_orphaned"),
        nodeId: NodeId.make("node_orphaned"),
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "old process" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
    attempts: [],
    providerTurns: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    assert.equal(command?.events[0]?.type, "runtime-request.updated");
    if (command?.events[0]?.type === "runtime-request.updated") {
      assert.equal(command.events[0].payload.status, "expired");
      assert.equal(command.events[0].payload.responseCapability.type, "not_resumable");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("preserves async questions across startup and shutdown", () => {
  const threadId = ThreadId.make("async-recovery-thread");
  const nodeId = NodeId.make("async-recovery-node");
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("async-recovery-request"),
        nodeId,
        status: "pending",
        responseCapability: { type: "message" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
    turnItems: [],
    attempts: [],
    providerTurns: [],
    subagents: [],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const commitCommand = vi.fn(() => Effect.die("an async question needs no process-loss write"));
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    assert.equal((yield* recovery.reconcile("startup")).closedRequests, 0);
    assert.equal((yield* recovery.reconcile("startup")).closedRequests, 0);
    assert.isFalse(commitCommand.mock.calls.length > 0);
  }).pipe(Effect.provide(layer));
});

it.effect("uses the same reconciliation path to cancel runtime requests during shutdown", () => {
  const threadId = ThreadId.make("thread_shutdown_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_shutdown"),
        nodeId: NodeId.make("node_shutdown"),
        status: "pending",
        responseCapability: { type: "live" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
    attempts: [],
    providerTurns: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("shutdown");
    assert.equal(summary.closedRequests, 1);
    assert.equal(summary.retiredEffects, 1);
    const requestEvent = committedInput?.events[0];
    assert.equal(requestEvent?.type, "runtime-request.updated");
    if (requestEvent?.type === "runtime-request.updated") {
      assert.equal(requestEvent.payload.status, "cancelled");
      assert.equal(requestEvent.payload.responseCapability.type, "not_resumable");
      if (requestEvent.payload.responseCapability.type === "not_resumable") {
        assert.match(requestEvent.payload.responseCapability.reason, /shut down/);
      }
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "preserves a replayable waiting run while cancelling its process-bound background work",
  () => {
    const threadId = ThreadId.make("thread_waiting_checkpoint");
    const runId = RunId.make("run_waiting_checkpoint");
    const providerThreadId = ProviderThreadId.make("provider_thread_waiting_checkpoint");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const providerSessionId = ProviderSessionId.make("provider_session_waiting_checkpoint");
    const backgroundItemId = TurnItemId.make("turn_item_waiting_checkpoint");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId,
          status: "idle",
          pendingBackgroundTasks: [
            { taskId: String(backgroundItemId), description: "Finish background task" },
          ],
        },
      ],
      runs: [{ id: runId, status: "waiting", providerInstanceId, providerThreadId }],
      providerTurns: [],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: backgroundItemId,
          runId,
          nodeId: null,
          providerThreadId,
          type: "command_execution",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({
                committed: true,
                cancelledEffectCount: 0,
              } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () =>
              Effect.succeed([
                {
                  request: { type: "checkpoint.capture", runId },
                  status: "running",
                },
              ] as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.requeuedEffects, 1);

      const command = committedInput;
      assert.isNotNull(command);
      if (command === null) return;
      // The run stays waiting for its checkpoint; it only records the work
      // the restart cancelled so the next provider turn can be told.
      assert.isFalse(command.events.some((event) => event.type === "run.updated"));
      const recorded = command.events.flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );
      // The roster entry is the same task as the item, so it is listed once.
      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId, kinds: ["shell"] }],
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === backgroundItemId &&
            event.payload.status === "cancelled",
        ),
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.id === providerThreadId &&
            event.payload.pendingBackgroundTasks?.length === 0,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "records cancelled work on the provider thread that lost it after a provider switch",
  () => {
    const threadId = ThreadId.make("thread_switch_note");
    const claudeRunId = RunId.make("run_switch_note_claude");
    const codexRunId = RunId.make("run_switch_note_codex");
    const claudeThreadId = ProviderThreadId.make("provider_thread_switch_note_claude");
    const codexThreadId = ProviderThreadId.make("provider_thread_switch_note_codex");
    const claude = ProviderInstanceId.make("claude");
    const codex = ProviderInstanceId.make("codex");
    const claudeProviderSessionId = ProviderSessionId.make("provider_session_switch_note_claude");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    // Claude launched a background subagent, then the thread switched to Codex.
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: claudeProviderSessionId,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claude,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: claudeThreadId,
          providerSessionId: claudeProviderSessionId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claude,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "task-claude", description: "Watch the build" }],
        },
        {
          id: codexThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codex,
          status: "idle",
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: claudeRunId,
          ordinal: 1,
          status: "completed",
          providerInstanceId: claude,
          providerThreadId: claudeThreadId,
        },
        {
          id: codexRunId,
          ordinal: 2,
          status: "completed",
          providerInstanceId: codex,
          providerThreadId: codexThreadId,
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_switch_note_subagent"),
          runId: claudeRunId,
          nodeId: null,
          providerThreadId: claudeThreadId,
          nativeItemRef: null,
          providerInstanceId: claude,
          type: "subagent",
          title: "Background subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const recorded = (committedInput?.events ?? []).flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );
      // The Codex run is later, but only Claude's turns may be told about it.
      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId: claudeRunId, kinds: ["subagent", "task"] }],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("cancels a stale waiting run when no checkpoint capture can finish it", () => {
  const threadId = ThreadId.make("thread_stale_waiting");
  const runId = RunId.make("run_stale_waiting");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "waiting",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const runEvent = committedInput?.events.find((event) => event.type === "run.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("closes a secret request card's form when its run is recovered", () => {
  const threadId = ThreadId.make("thread_secret_recovery");
  const runId = RunId.make("run_secret_recovery");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "running", providerInstanceId: ProviderInstanceId.make("codex") }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: "turn-item:secret-request:recovery",
        threadId,
        runId,
        nodeId: null,
        type: "secret_request",
        status: "waiting",
        secretStatus: "pending",
        label: "GitHub token",
        reason: "Used as GH_TOKEN.",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const itemEvent = committedInput?.events.find((event) => event.type === "turn-item.updated");
    const card = itemEvent?.type === "turn-item.updated" ? itemEvent.payload : null;
    assert.equal(card?.status, "cancelled");
    assert.equal(card?.type === "secret_request" ? card.secretStatus : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("holds accepted queued work without cancelling its execution state after restart", () => {
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "queued",
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 0);
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "queued");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : null, 1);
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queueHeld : false, true);
    assert.isUndefined(attemptEvent);
    assert.isUndefined(nodeEvent);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "cancels the complete in-flight subtree and stops its persisted session without reopening it",
  () => {
    const threadId = ThreadId.make("thread_recovery_cancel");
    const runId = RunId.make("run_recovery_cancel");
    const attemptId = RunAttemptId.make("attempt_recovery_cancel");
    const rootNodeId = NodeId.make("node_recovery_cancel");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_cancel");
    const providerTurnId = ProviderTurnId.make("provider_turn_recovery_cancel");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_cancel");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "active",
        },
      ],
      providerTurns: [
        {
          id: providerTurnId,
          runAttemptId: attemptId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
      runs: [
        {
          id: runId,
          status: "starting",
          providerThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          rootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: rootNodeId, runId, status: "running" }],
      subagents: [],
      messages: [{ id: MessageId.make("message_recovery_cancel"), runId, streaming: true }],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_recovery_cancel"),
          runId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 2 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
        .recover;
      assert.equal(summary.terminalizedRuns, 1);
      assert.equal(summary.stoppedSessions, 1);
      assert.equal(summary.retiredEffects, 2);
      assert.deepEqual(committedInput?.cancelUnsettledEffects?.effectTypes, [
        "provider-turn.start",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "runtime-request.respond",
      ]);
      const events = committedInput?.events ?? [];
      assert.deepEqual(
        events.map((event) => [
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
        [
          ["run.updated", "cancelled"],
          ["run-attempt.updated", "cancelled"],
          ["node.updated", "cancelled"],
          ["provider-turn.updated", "cancelled"],
          ["message.updated", null],
          ["turn-item.updated", "cancelled"],
          ["provider-thread.updated", "idle"],
          ["provider-session.updated", "stopped"],
        ],
      );
      const messageEvent = events.find((event) => event.type === "message.updated");
      assert.isFalse(messageEvent?.type === "message.updated" && messageEvent.payload.streaming);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "clears persisted pendingBackgroundTasks and terminalizes stale background items on settled runs",
  () => {
    const threadId = ThreadId.make("thread_recovery_background");
    const settledRunId = RunId.make("run_recovery_background_settled");
    const activeRunId = RunId.make("run_recovery_background_active");
    const activeAttemptId = RunAttemptId.make("attempt_recovery_background_active");
    const activeRootNodeId = NodeId.make("node_recovery_background_active");
    const idleProviderThreadId = ProviderThreadId.make("provider_thread_recovery_background_idle");
    const activeProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_active",
    );
    const secondaryProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_secondary",
    );
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_background");
    const secondaryProviderSessionId = ProviderSessionId.make(
      "provider_session_recovery_background_secondary",
    );
    const settledStaleItemId = TurnItemId.make("turn_item_recovery_background_stale");
    const activeRunItemId = TurnItemId.make("turn_item_recovery_background_active");
    const nullRunCommandItemId = TurnItemId.make("turn_item_recovery_background_null_run");
    const nullRunSubagentItemId = TurnItemId.make("turn_item_recovery_background_null_subagent");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    const secondaryInstanceId = ProviderInstanceId.make("claude-secondary");
    const subagentInstanceId = ProviderInstanceId.make("claude-subagent");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "ready",
        },
        {
          id: secondaryProviderSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: secondaryInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: idleProviderThreadId,
          providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          // Index-0 is intentionally a different instance so misattribution
          // to providerThreads[0] fails the assertions below.
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "bg-settled", description: "sleep 30" }],
        },
        {
          id: activeProviderThreadId,
          providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "active",
          pendingBackgroundTasks: [{ taskId: "bg-active", description: "npm test" }],
        },
        {
          id: secondaryProviderThreadId,
          providerSessionId: secondaryProviderSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: secondaryInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: settledRunId,
          status: "completed",
          providerInstanceId: claudeInstanceId,
          providerThreadId: idleProviderThreadId,
        },
        {
          id: activeRunId,
          status: "running",
          providerInstanceId: claudeInstanceId,
          providerThreadId: activeProviderThreadId,
        },
      ],
      attempts: [
        {
          id: activeAttemptId,
          runId: activeRunId,
          rootNodeId: activeRootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: activeRootNodeId, runId: activeRunId, status: "running" }],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: settledStaleItemId,
          runId: settledRunId,
          nodeId: null,
          providerThreadId: idleProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          id: activeRunItemId,
          runId: activeRunId,
          nodeId: activeRootNodeId,
          providerThreadId: activeProviderThreadId,
          type: "dynamic_tool",
          status: "running",
        },
        {
          // Missing run: must attribute via providerThreadId, not index 0.
          id: nullRunCommandItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          // Missing run with a real matching provider thread whose instance
          // differs from the subagent's own: own providerInstanceId must win.
          id: nullRunSubagentItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "subagent",
          status: "running",
          providerInstanceId: subagentInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 1);
      const events = committedInput?.events ?? [];

      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      // Active-run item + settled-run stale + null-run command + null-run subagent.
      assert.equal(turnItemCancels.length, 4);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [activeRunItemId, nullRunCommandItemId, nullRunSubagentItemId, settledStaleItemId].sort(),
      );

      const cancelById = (id: TurnItemId) =>
        turnItemCancels.find(
          (event) => event.type === "turn-item.updated" && event.payload.id === id,
        );
      assert.equal(cancelById(nullRunCommandItemId)?.providerInstanceId, secondaryInstanceId);
      // Subagent own instance wins over the matching thread's secondary instance.
      assert.notEqual(subagentInstanceId, secondaryInstanceId);
      assert.equal(cancelById(nullRunSubagentItemId)?.providerInstanceId, subagentInstanceId);
      // Settled-run item still prefers the run's provider instance when present.
      assert.equal(cancelById(settledStaleItemId)?.providerInstanceId, claudeInstanceId);

      const providerThreadEvents = events.filter(
        (event) => event.type === "provider-thread.updated",
      );
      // Only threads with active status or nonempty rosters are rewritten.
      assert.equal(providerThreadEvents.length, 2);
      for (const event of providerThreadEvents) {
        if (event.type !== "provider-thread.updated") continue;
        assert.deepEqual(event.payload.pendingBackgroundTasks ?? [], []);
      }
      const idleThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === idleProviderThreadId,
      );
      assert.equal(
        idleThreadEvent?.type === "provider-thread.updated" ? idleThreadEvent.payload.status : null,
        "idle",
      );
      const activeThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === activeProviderThreadId,
      );
      assert.equal(
        activeThreadEvent?.type === "provider-thread.updated"
          ? activeThreadEvent.payload.status
          : null,
        "idle",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "terminalizes a leftover nonpersistent dynamic_tool on a settled run after process loss",
  () => {
    const threadId = ThreadId.make("thread_recovery_orphan_wait");
    const settledRunId = RunId.make("run_recovery_orphan_wait_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_orphan_wait");
    const orphanWaitItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-4669f3bb-78c9-4af1-b44e-daa340d2c538",
    );
    const persistentMonitorItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-persistent-monitor",
    );
    const orphanWaitNodeId = NodeId.make("node_recovery_orphan_wait");
    const persistentMonitorNodeId = NodeId.make("node_recovery_persistent_monitor");
    const codexInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_orphan_wait");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId, providerInstanceId: codexInstanceId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: settledRunId,
          status: "completed",
          providerInstanceId: codexInstanceId,
          providerThreadId,
        },
      ],
      attempts: [],
      nodes: [
        { id: orphanWaitNodeId, runId: settledRunId, status: "running", kind: "tool_call" },
        {
          id: persistentMonitorNodeId,
          runId: settledRunId,
          status: "running",
          kind: "tool_call",
        },
      ],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: orphanWaitItemId,
          runId: settledRunId,
          nodeId: orphanWaitNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "t3-code.t3_thread_wait",
          input: {
            threadId:
              "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
            timeoutMs: 30000,
          },
        },
        {
          id: persistentMonitorItemId,
          runId: settledRunId,
          nodeId: persistentMonitorNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "grok.monitor",
          input: { persistent: true, command: "tail -f" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      const turnItemCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      // Process loss means the provider is gone, so even a persistent monitor
      // cannot still be alive. The leftover wait and the monitor both close.
      assert.equal(turnItemCancels.length, 2);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [orphanWaitItemId, persistentMonitorItemId].sort(),
      );
      const nodeCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "node.updated" && event.payload.status === "cancelled",
      );
      assert.equal(nodeCancels.length, 2);
      assert.deepEqual(
        nodeCancels.map((event) => event.type === "node.updated" && event.payload.id).sort(),
        [orphanWaitNodeId, persistentMonitorNodeId].sort(),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "terminalizes the linked subagent and node for a stale subagent item on a settled run",
  () => {
    const threadId = ThreadId.make("thread_recovery_subagent");
    const settledRunId = RunId.make("run_recovery_subagent_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_subagent");
    const staleSubagentNodeId = NodeId.make("node_recovery_subagent_stale");
    const doneSubagentNodeId = NodeId.make("node_recovery_subagent_done");
    const staleItemId = TurnItemId.make("turn_item_recovery_subagent_stale");
    const doneItemId = TurnItemId.make("turn_item_recovery_subagent_done");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_subagent");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      // Settled run: the stale-item loop owns it, not the nonterminal loop.
      runs: [
        {
          id: settledRunId,
          status: "completed",
          providerInstanceId: claudeInstanceId,
          providerThreadId,
        },
      ],
      attempts: [],
      nodes: [
        { id: staleSubagentNodeId, runId: settledRunId, status: "running" },
        { id: doneSubagentNodeId, runId: settledRunId, status: "completed" },
      ],
      subagents: [
        {
          id: staleSubagentNodeId,
          runId: settledRunId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "running",
        },
        {
          // Already finished with a real result: must never be overwritten.
          id: doneSubagentNodeId,
          runId: settledRunId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "completed",
          result: "done",
        },
      ],
      messages: [],
      turnItems: [
        {
          id: staleItemId,
          runId: settledRunId,
          nodeId: staleSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "running",
          subagentId: staleSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
        {
          id: doneItemId,
          runId: settledRunId,
          nodeId: doneSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "completed",
          subagentId: doneSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const events = committedInput?.events ?? [];

      // Only the nonterminal subagent item is cancelled.
      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      assert.equal(turnItemCancels.length, 1);

      // The linked subagent entity is terminalized alongside its turn item.
      const subagentCancels = events.filter((event) => event.type === "subagent.updated");
      assert.equal(subagentCancels.length, 1);
      const subagentCancel = subagentCancels[0];
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.id : null,
        staleSubagentNodeId,
      );
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.status : null,
        "cancelled",
      );

      // So is its execution node, which no live process can terminalize.
      const nodeCancels = events.filter((event) => event.type === "node.updated");
      assert.equal(nodeCancels.length, 1);
      const nodeCancel = nodeCancels[0];
      assert.equal(
        nodeCancel?.type === "node.updated" ? nodeCancel.payload.id : null,
        staleSubagentNodeId,
      );

      // The already-completed subagent and node are left untouched.
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("leaves delegated tasks to their own child threads after process loss", () => {
  const threadId = ThreadId.make("thread_recovery_delegation");
  const settledRunId = RunId.make("run_recovery_delegation_settled");
  const runningRunId = RunId.make("run_recovery_delegation_running");
  const providerThreadId = ProviderThreadId.make("provider_thread_recovery_delegation");
  const claudeInstanceId = ProviderInstanceId.make("claude");
  const driver = ProviderDriverKind.make("claude");
  const settledTaskId = NodeId.make("node_recovery_delegation_settled");
  const runningTaskId = NodeId.make("node_recovery_delegation_running");
  const nativeSubagentId = NodeId.make("node_recovery_native_subagent");
  const delegatedTask = (id: NodeId, runId: RunId) => ({
    id,
    runId,
    origin: "app_owned",
    childThreadId: ThreadId.make(`thread:delegated-task:${id}`),
    driver,
    providerInstanceId: claudeInstanceId,
    status: "running",
  });
  const subagentItem = (subagentId: NodeId, runId: RunId, origin: string) => ({
    id: TurnItemId.make(`turn_item:${subagentId}`),
    runId,
    nodeId: subagentId,
    providerThreadId,
    type: "subagent",
    status: "running",
    subagentId,
    origin,
    childThreadId:
      origin === "app_owned" ? ThreadId.make(`thread:delegated-task:${subagentId}`) : null,
    providerInstanceId: claudeInstanceId,
    title: `subagent ${subagentId}`,
  });
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId: claudeInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: claudeInstanceId,
        ownerNodeId: null,
        status: "idle",
        pendingBackgroundTasks: [],
      },
    ],
    providerTurns: [],
    runs: [
      {
        id: settledRunId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
      {
        id: runningRunId,
        ordinal: 2,
        status: "running",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
    ],
    attempts: [],
    nodes: [
      { id: settledTaskId, runId: settledRunId, status: "running", kind: "subagent" },
      { id: runningTaskId, runId: runningRunId, status: "running", kind: "subagent" },
      { id: nativeSubagentId, runId: settledRunId, status: "running", kind: "subagent" },
    ],
    subagents: [
      delegatedTask(settledTaskId, settledRunId),
      delegatedTask(runningTaskId, runningRunId),
      {
        ...delegatedTask(nativeSubagentId, settledRunId),
        origin: "provider_native",
        childThreadId: null,
      },
    ],
    messages: [],
    turnItems: [
      subagentItem(settledTaskId, settledRunId, "app_owned"),
      subagentItem(runningTaskId, runningRunId, "app_owned"),
      subagentItem(nativeSubagentId, settledRunId, "provider_native"),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const events = committedInput?.events ?? [];
    const touched = events.flatMap((event) =>
      event.type === "turn-item.updated"
        ? event.payload.type === "subagent"
          ? [event.payload.subagentId]
          : []
        : event.type === "subagent.updated" || event.type === "node.updated"
          ? [event.payload.id]
          : [],
    );
    // The run is recovered, but provider work without a bound session remains untouched.
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runningRunId &&
          event.payload.status === "cancelled",
      ),
    );
    assert.notInclude(touched, settledTaskId);
    assert.notInclude(touched, runningTaskId);
    assert.notInclude(touched, nativeSubagentId);
    const noted = events.flatMap((event) =>
      event.type === "run.background-work-cancelled"
        ? event.payload.restartCancelledBackgroundWork.map((work) => work.label)
        : [],
    );
    assert.deepEqual(noted, []);
  }).pipe(Effect.provide(layer));
});

describe("ProviderRuntimeRecoveryService safe native settlement inspection", () => {
  function makeRecoveryFixture(options?: {
    readonly status?: OrchestrationV2Run["status"];
    readonly omitSessionBinding?: boolean;
  }) {
    const now = DateTime.makeUnsafe("2026-10-12T08:00:00.000Z");
    const threadId = ThreadId.make("thread_recovery_fixture");
    const runId = RunId.make("run_recovery_fixture");
    const attemptId = RunAttemptId.make("attempt_recovery_fixture");
    const rootNodeId = NodeId.make("node_recovery_fixture");
    const providerInstanceId = ProviderInstanceId.make("claudeAgent");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_fixture");
    const providerTurnId = ProviderTurnId.make("turn_fixture");
    const providerSessionId = options?.omitSessionBinding
      ? null
      : ("provider_session_recovery_fixture" as ProviderSessionId);

    const base = emptyProjection({
      id: EventId.make("event:fixture:thread-created"),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("project_recovery_fixture"),
        title: "Recovery Fixture Thread",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "claude-3-7-sonnet" },
        runtimeMode: "full-access",
        activeProviderThreadId: providerThreadId,
        branch: null,
        worktreePath: null,
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        lastVisitedAt: null,
        settledOverride: null,
        settledAt: null,
      },
    });

    const run: OrchestrationV2ThreadProjection["runs"][number] = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "claude-3-7-sonnet" },
      providerThreadId,
      userMessageId: MessageId.make("msg_user_fixture"),
      rootNodeId,
      activeAttemptId: attemptId,
      status: options?.status ?? "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };

    const attempt: OrchestrationV2ThreadProjection["attempts"][number] = {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId,
      providerThreadId,
      providerTurnId,
      reason: "initial",
      status: "running",
      startedAt: now,
      completedAt: null,
    };

    const node: OrchestrationV2ThreadProjection["nodes"][number] = {
      id: rootNodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "running",
      countsForRun: true,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };

    const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
      id: providerThreadId,
      driver: ProviderDriverKind.make("claude"),
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("claude"),
        nativeId: "native_thread_fixture",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };

    const providerSessions: OrchestrationV2ThreadProjection["providerSessions"] =
      providerSessionId === null
        ? []
        : [
            {
              id: providerSessionId,
              driver: ProviderDriverKind.make("claude"),
              providerInstanceId,
              status: "ready",
              cwd: "/workspace",
              model: "claude-3-7-sonnet",
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          ];

    const providerTurn: OrchestrationV2ThreadProjection["providerTurns"][number] = {
      id: providerTurnId,
      providerThreadId,
      runAttemptId: attemptId,
      nodeId: rootNodeId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    };

    const message: OrchestrationV2ThreadProjection["messages"][number] = {
      id: MessageId.make("msg_stream_fixture"),
      threadId,
      runId,
      nodeId: rootNodeId,
      createdBy: "agent",
      creationSource: "provider",
      role: "assistant",
      text: "streaming assistant message",
      attachments: [],
      streaming: true,
      createdAt: now,
      updatedAt: now,
    };

    const subagent: OrchestrationV2ThreadProjection["subagents"][number] = {
      id: NodeId.make("subagent_child_fixture"),
      threadId,
      runId,
      parentNodeId: rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("claude"),
      providerInstanceId,
      providerThreadId,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "child subagent task",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };

    const turnItem: OrchestrationV2ThreadProjection["turnItems"][number] = {
      id: TurnItemId.make("turn_item_fixture"),
      type: "dynamic_tool",
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "dynamic tool",
      toolName: "dynamic_tool",
      input: {},
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };

    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      runs: [run],
      attempts: [attempt],
      nodes: [node],
      providerThreads: [providerThread],
      providerSessions,
      providerTurns: [providerTurn],
      messages: [message],
      subagents: [subagent],
      turnItems: [turnItem],
    };
    return {
      now,
      threadId,
      runId,
      attemptId,
      rootNodeId,
      providerThreadId,
      providerSessionId,
      providerInstanceId,
      providerTurnId,
      projection,
    };
  }

  it.effect.each([
    { runStatus: "completed", expectedChildStatus: "completed" },
    { runStatus: "interrupted", expectedChildStatus: "interrupted" },
    { runStatus: "cancelled", expectedChildStatus: "interrupted" },
  ] satisfies ReadonlyArray<{
    readonly runStatus: OrchestrationV2Run["status"];
    readonly expectedChildStatus: "completed" | "interrupted";
  }>)(
    "ignores persisted async, job, and newer-timestamp claims after process loss when the parent run is $runStatus",
    ({ runStatus, expectedChildStatus }) => {
      const fixture = makeRecoveryFixture();
      const parentItem = fixture.projection.turnItems[0];
      const subagent = fixture.projection.subagents[0];
      if (parentItem?.type !== "dynamic_tool" || subagent === undefined) {
        return Effect.die("Expected the recovery fixture's parent tool and native subagent");
      }
      const settledAt = DateTime.makeUnsafe("2026-10-12T08:29:19.696Z");
      const laterUpdateAt = DateTime.makeUnsafe("2026-10-12T08:29:20.000Z");
      const endedRun: OrchestrationV2ThreadProjection["runs"][number] = {
        ...fixture.projection.runs[0]!,
        status: runStatus,
        activeAttemptId: null,
        completedAt: settledAt,
      };
      const endedRootNode: OrchestrationV2ThreadProjection["nodes"][number] = {
        ...fixture.projection.nodes[0]!,
        status: runStatus,
        completedAt: settledAt,
      };
      const completedParentItem: typeof parentItem = {
        ...parentItem,
        status: "completed",
        completedAt: settledAt,
        updatedAt: settledAt,
      };
      const laterSubagent: typeof subagent = {
        ...subagent,
        id: NodeId.make("subagent_later_workpool_child"),
        updatedAt: laterUpdateAt,
      };
      const asyncSubagent: typeof subagent = {
        ...subagent,
        id: NodeId.make("subagent_async_workpool_child"),
      };
      const asyncParentItem: typeof parentItem = {
        ...completedParentItem,
        id: TurnItemId.make("turn_item_async_workpool_parent"),
        ordinal: 3,
        details: { async: { state: "running" } },
      };
      const activeJobSubagent: typeof subagent = {
        ...subagent,
        id: NodeId.make("subagent_active_wait_child"),
        nativeAgentId: "workpool-agent",
      };
      const activeJobParentItem: typeof parentItem = {
        ...completedParentItem,
        id: TurnItemId.make("turn_item_active_wait_parent"),
        ordinal: 6,
        details: {
          jobs: [
            {
              id: "workpool-batch-b1",
              type: "task",
              status: "running",
              agentId: "workpool-agent",
            },
          ],
        },
      };
      const makeChildItem = (input: {
        readonly id: string;
        readonly subagent: typeof subagent;
        readonly parentItemId: TurnItemId;
        readonly ordinal: number;
        readonly updatedAt: DateTime.Utc;
      }): OrchestrationV2ThreadProjection["turnItems"][number] => ({
        id: TurnItemId.make(input.id),
        type: "subagent",
        threadId: fixture.threadId,
        runId: fixture.runId,
        nodeId: fixture.rootNodeId,
        providerThreadId: fixture.providerThreadId,
        providerTurnId: fixture.providerTurnId,
        nativeItemRef: null,
        parentItemId: input.parentItemId,
        ordinal: input.ordinal,
        status: "running",
        title: input.subagent.title,
        startedAt: fixture.now,
        completedAt: null,
        updatedAt: input.updatedAt,
        subagentId: input.subagent.id,
        origin: "provider_native",
        driver: input.subagent.driver,
        providerInstanceId: input.subagent.providerInstanceId,
        childThreadId: null,
        prompt: input.subagent.prompt,
        result: null,
      });
      const staleChildItem = makeChildItem({
        id: "turn_item_stale_workpool_child",
        subagent,
        parentItemId: parentItem.id,
        ordinal: 2,
        updatedAt: settledAt,
      });
      const laterChildItem = makeChildItem({
        id: "turn_item_later_workpool_child",
        subagent: laterSubagent,
        parentItemId: parentItem.id,
        ordinal: 4,
        updatedAt: laterUpdateAt,
      });
      const asyncChildItem = makeChildItem({
        id: "turn_item_async_workpool_child",
        subagent: asyncSubagent,
        parentItemId: asyncParentItem.id,
        ordinal: 5,
        updatedAt: settledAt,
      });
      const activeJobChildItem = makeChildItem({
        id: "turn_item_active_wait_child",
        subagent: activeJobSubagent,
        parentItemId: activeJobParentItem.id,
        ordinal: 7,
        updatedAt: settledAt,
      });
      const projection: OrchestrationV2ThreadProjection = {
        ...fixture.projection,
        runs: [endedRun],
        nodes: [endedRootNode],
        subagents: [subagent, laterSubagent, asyncSubagent, activeJobSubagent],
        turnItems: [
          completedParentItem,
          staleChildItem,
          laterChildItem,
          asyncParentItem,
          asyncChildItem,
          activeJobParentItem,
          activeJobChildItem,
        ],
      };
      let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
        null;
      const layer = ProviderRuntimeRecovery.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                committedInput = input;
                return Effect.succeed({
                  receipt: {
                    commandId: input.commandId,
                    threadId: input.threadId,
                    commandType: input.commandType,
                    acceptedAt: input.acceptedAt,
                    resultSequence: 0,
                    status: "accepted",
                    error: null,
                  },
                  storedEvents: [],
                  committed: true,
                  cancelledEffectCount: 0,
                });
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
              cancelUnsettled: () => Effect.succeed([]),
              signalCancellations: () => Effect.void,
            }),
          ),
        ),
      );

      return Effect.gen(function* () {
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
        const events = committedInput?.events ?? [];
        const statusForTurnItem = (id: TurnItemId) => {
          const event = events.find(
            (candidate) => candidate.type === "turn-item.updated" && candidate.payload.id === id,
          );
          return event?.type === "turn-item.updated" ? event.payload.status : null;
        };
        const statusForSubagent = (id: NodeId) => {
          const event = events.find(
            (candidate) => candidate.type === "subagent.updated" && candidate.payload.id === id,
          );
          return event?.type === "subagent.updated" ? event.payload.status : null;
        };
        assert.equal(statusForTurnItem(staleChildItem.id), expectedChildStatus);
        assert.equal(statusForSubagent(subagent.id), expectedChildStatus);
        assert.equal(statusForTurnItem(laterChildItem.id), expectedChildStatus);
        assert.equal(statusForSubagent(laterSubagent.id), expectedChildStatus);
        assert.equal(statusForTurnItem(asyncChildItem.id), "interrupted");
        assert.equal(statusForSubagent(asyncSubagent.id), "interrupted");
        assert.equal(statusForTurnItem(activeJobChildItem.id), "interrupted");
        assert.equal(statusForSubagent(activeJobSubagent.id), "interrupted");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "native confirmed settlement on shutdown settles run, attempt, node, and providerTurn as completed without LLM continuation, and conservatively cancels incomplete children",
    () =>
      Effect.gen(function* () {
        const fixture = makeRecoveryFixture();
        const nativeSettledAt = DateTime.makeUnsafe("2026-10-12T08:29:19.696Z");
        const expectedNativeTurnRef: OrchestrationV2ProviderRef = {
          driver: ProviderDriverKind.make("claude"),
          nativeId: "native_turn_leaf_fixture",
          strength: "strong",
        };
        const expectedNativeHeadRef: OrchestrationV2ProviderRef = {
          driver: ProviderDriverKind.make("claude"),
          nativeId: "native_head_leaf_fixture",
          strength: "strong",
        };
        let committedInput:
          | Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
          | null = null;
        const preparedWrites: Parameters<
          EventSink.EventSinkV2["Service"]["writeWithEffects"]
        >[0][] = [];

        const layer = ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(fixture.projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) => {
                  committedInput = input;
                  return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
                },
                writeWithEffects: (input) => {
                  preparedWrites.push(input);
                  return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
                },
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                cancelUnsettled: () => Effect.succeed([]),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                inspectSettlement: () =>
                  Effect.succeed({
                    settledAt: nativeSettledAt,
                    providerTurnId: fixture.providerTurnId,
                    nativeTurnRef: expectedNativeTurnRef,
                    nativeConversationHeadRef: expectedNativeHeadRef,
                  }),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;

          // prepareForShutdown suppresses continuation write for confirmed native-settled run
          yield* recovery.prepareForShutdown;
          assert.equal(preparedWrites.length, 0);

          yield* recovery.reconcile("shutdown");
          assert.isNotNull(committedInput);
          const events = committedInput!.events;

          // 1. Run is completed with native settlement time
          const runEvent = events.find((e) => e.type === "run.updated");
          assert.isDefined(runEvent);
          assert.equal(runEvent!.payload.status, "completed");
          assert.deepEqual(runEvent!.payload.completedAt, nativeSettledAt);

          // 2. Attempt is completed with native settlement time
          const attemptEvent = events.find((e) => e.type === "run-attempt.updated");
          assert.isDefined(attemptEvent);
          assert.equal(attemptEvent!.payload.status, "completed");
          assert.deepEqual(attemptEvent!.payload.completedAt, nativeSettledAt);

          // 3. Node is completed with native settlement time
          const nodeEvent = events.find((e) => e.type === "node.updated");
          assert.isDefined(nodeEvent);
          assert.equal(nodeEvent!.payload.status, "completed");
          assert.deepEqual(nodeEvent!.payload.completedAt, nativeSettledAt);
          // 4. ProviderTurn is completed with native settlement time and nativeTurnRef
          const turnEvent = events.find((e) => e.type === "provider-turn.updated");
          assert.isDefined(turnEvent);
          assert.equal(turnEvent!.payload.status, "completed");
          assert.deepEqual(turnEvent!.payload.completedAt, nativeSettledAt);
          assert.deepEqual(turnEvent!.payload.nativeTurnRef, expectedNativeTurnRef);

          // 5. ProviderThread head is updated with nativeConversationHeadRef
          const threadEvent = events.find((e) => e.type === "provider-thread.updated");
          assert.isDefined(threadEvent);
          assert.deepEqual(threadEvent!.payload.nativeConversationHeadRef, expectedNativeHeadRef);

          // 5. Streaming message is finalized with non-streaming status
          const msgEvent = events.find((e) => e.type === "message.updated");
          assert.isDefined(msgEvent);
          assert.isFalse(msgEvent!.payload.streaming);

          // 6. Incomplete child subagent is NOT forced completed; remains conservatively cancelled
          const subagentEvent = events.find((e) => e.type === "subagent.updated");
          assert.isDefined(subagentEvent);
          assert.equal(subagentEvent!.payload.status, "cancelled");

          // 7. Incomplete turn item is NOT forced completed; remains conservatively cancelled
          const itemEvent = events.find((e) => e.type === "turn-item.updated");
          assert.isDefined(itemEvent);
          assert.equal(itemEvent!.payload.status, "cancelled");

          // 8. No continuation effect is scheduled
          assert.equal(committedInput!.effects.length, 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "pending, unsupported, or missing original binding remains usual cancellation and continuation",
    () =>
      Effect.gen(function* () {
        const fixture = makeRecoveryFixture();
        let committedInput:
          | Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
          | null = null;

        // inspectSettlement returns null (unsupported / not settled / missing binding)
        const layer = ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(fixture.projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) => {
                  committedInput = input;
                  return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
                },
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                cancelUnsettled: () => Effect.succeed([]),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                inspectSettlement: () => Effect.succeed(null),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
          yield* recovery.reconcile("shutdown");
          assert.isNotNull(committedInput);
          const events = committedInput!.events;

          const runEvent = events.find((e) => e.type === "run.updated");
          assert.isDefined(runEvent);
          assert.equal(runEvent!.payload.status, "cancelled");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("missing session binding on providerThread falls back to usual cancellation", () =>
    Effect.gen(function* () {
      const fixture = makeRecoveryFixture({ omitSessionBinding: true });
      let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
        null;
      let inspectCalled = false;

      const layer = ProviderRuntimeRecovery.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(fixture.projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                committedInput = input;
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              listByCommandId: () => Effect.succeed([]),
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
              cancelUnsettled: () => Effect.succeed([]),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              inspectSettlement: () =>
                Effect.sync(() => {
                  inspectCalled = true;
                  return null;
                }),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        yield* recovery.reconcile("shutdown");
        assert.isFalse(inspectCalled);
        assert.isNotNull(committedInput);
        const runEvent = committedInput!.events.find((e) => e.type === "run.updated");
        assert.equal(runEvent?.payload.status, "cancelled");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retry or compaction get_state false is not native proof and falls back to usual cancellation",
    () =>
      Effect.gen(function* () {
        const fixture = makeRecoveryFixture();
        let committedInput:
          | Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
          | null = null;

        const layer = ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(fixture.projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) => {
                  committedInput = input;
                  return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
                },
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                cancelUnsettled: () => Effect.succeed([]),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                // When compaction/retry is active, inspectSettlement returns null
                inspectSettlement: () => Effect.succeed(null),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
          yield* recovery.reconcile("shutdown");
          const runEvent = committedInput!.events.find((e) => e.type === "run.updated");
          assert.equal(runEvent?.payload.status, "cancelled");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "resumed fresh quiet context has no active turn binding and is unavailable as proof",
    () =>
      Effect.gen(function* () {
        const fixture = makeRecoveryFixture();
        let committedInput:
          | Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
          | null = null;

        const layer = ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(fixture.projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) => {
                  committedInput = input;
                  return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
                },
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                cancelUnsettled: () => Effect.succeed([]),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                // Fresh quiet context: activeTurn is null or not matching runId -> returns null
                inspectSettlement: () => Effect.succeed(null),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
          yield* recovery.reconcile("shutdown");
          const runEvent = committedInput!.events.find((e) => e.type === "run.updated");
          assert.equal(runEvent?.payload.status, "cancelled");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "startup recovery cannot reconstruct lost native work and MUST NOT infer past completion",
    () =>
      Effect.gen(function* () {
        const fixture = makeRecoveryFixture();
        const nativeSettledAt = DateTime.makeUnsafe("2026-10-12T08:29:19.696Z");
        const parentItem = fixture.projection.turnItems[0];
        const subagent = fixture.projection.subagents[0];
        if (parentItem?.type !== "dynamic_tool" || subagent === undefined) {
          return yield* Effect.die("Expected the recovery fixture's active parent and subagent");
        }
        const asyncParentItem: typeof parentItem = {
          ...parentItem,
          status: "completed",
          completedAt: nativeSettledAt,
          updatedAt: nativeSettledAt,
          details: { async: { state: "running" } },
        };
        const childItem: OrchestrationV2ThreadProjection["turnItems"][number] = {
          id: TurnItemId.make("turn_item_current_async_subagent"),
          type: "subagent",
          threadId: fixture.threadId,
          runId: fixture.runId,
          nodeId: fixture.rootNodeId,
          providerThreadId: fixture.providerThreadId,
          providerTurnId: fixture.providerTurnId,
          nativeItemRef: null,
          parentItemId: parentItem.id,
          ordinal: 2,
          status: "running",
          title: "still running",
          startedAt: fixture.now,
          completedAt: null,
          updatedAt: nativeSettledAt,
          subagentId: subagent.id,
          origin: "provider_native",
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          childThreadId: null,
          prompt: subagent.prompt,
          result: null,
        };
        const projection: OrchestrationV2ThreadProjection = {
          ...fixture.projection,
          turnItems: [asyncParentItem, childItem],
        };
        let committedInput:
          | Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
          | null = null;
        let inspectCalled = false;

        const layer = ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([fixture.threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) => {
                  committedInput = input;
                  return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
                },
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                cancelUnsettled: () => Effect.succeed([]),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                inspectSettlement: () =>
                  Effect.sync(() => {
                    inspectCalled = true;
                    return {
                      settledAt: nativeSettledAt,
                      providerTurnId: fixture.providerTurnId,
                      nativeTurnRef: null,
                      nativeConversationHeadRef: null,
                    };
                  }),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
          yield* recovery.reconcile("startup");
          // Startup MUST NOT query runtime inspection or infer past completion
          assert.isFalse(inspectCalled);
          const runEvent = committedInput!.events.find((e) => e.type === "run.updated");
          assert.equal(runEvent?.payload.status, "cancelled");
          const events = committedInput!.events;
          const childItemEvent = events.find(
            (event) => event.type === "turn-item.updated" && event.payload.id === childItem.id,
          );
          const subagentEvent = events.find(
            (event) => event.type === "subagent.updated" && event.payload.id === subagent.id,
          );
          assert.equal(
            childItemEvent?.type === "turn-item.updated" ? childItemEvent.payload.status : null,
            "cancelled",
          );
          assert.equal(
            subagentEvent?.type === "subagent.updated" ? subagentEvent.payload.status : null,
            "cancelled",
          );
        }).pipe(Effect.provide(layer));
      }),
  );
});
