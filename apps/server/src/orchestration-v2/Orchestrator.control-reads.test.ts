import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("records approval feedback on its request without dispatching a parent turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:approval-feedback");
    const sessionId = ProviderSessionId.make("session:approval-feedback");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-approval-feedback"),
      threadId,
      projectId: ProjectId.make("project:approval-feedback"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("session:approval-feedback"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    for (const name of ["child", "other"]) {
      yield* projections.apply({
        id: EventId.make(`request:${name}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(name),
          nodeId: NodeId.make(`node:${name}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: sessionId,
            supportsFeedback: name === "child",
          },
          createdAt: now,
          resolvedAt: null,
        },
      });
    }
    const commandId = CommandId.make("respond-approval-feedback");
    const feedback = "Run it in a safer manner.";
    for (const [index, invalid] of [
      { requestId: RuntimeRequestId.make("other"), decision: "decline" as const, feedback },
      { requestId: RuntimeRequestId.make("child"), decision: "accept" as const, feedback },
      { requestId: RuntimeRequestId.make("child"), decision: "decline" as const, feedback: "  " },
    ].entries()) {
      const rejectedId = CommandId.make(`invalid-feedback:${index}`);
      const rejected = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: rejectedId,
          threadId,
          ...invalid,
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(rejected));
      assert.deepEqual(yield* outbox.listByCommandId(rejectedId), []);
    }
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId,
      threadId,
      requestId: RuntimeRequestId.make("child"),
      decision: "decline",
      feedback,
    });
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(
      projection.runtimeRequests.find((request) => request.id === "child")?.feedback,
      feedback,
    );
    assert.equal(
      projection.runtimeRequests.find((request) => request.id === "other")?.status,
      "pending",
    );
    assert.equal(projection.messages.at(-1)?.text, feedback);
    const feedbackMessageId = MessageId.make("approval-feedback:child");
    assert.ok(
      projection.visibleTurnItems.some(
        ({ item }) =>
          item.type === "user_message" &&
          item.messageId === feedbackMessageId &&
          item.text === feedback,
      ),
    );
    const history = yield* projections.getTimelinePage(threadId, { limit: 20, view: "messages" });
    assert.ok(
      history.items.some(
        ({ item }) =>
          item.type === "user_message" &&
          item.messageId === feedbackMessageId &&
          item.text === feedback,
      ),
    );
    assert.equal(projection.runs.length, 0);
    assert.deepEqual(
      (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request),
      [
        {
          type: "runtime-request.respond",
          providerSessionId: sessionId,
          requestId: RuntimeRequestId.make("child"),
          decision: "decline",
          feedback,
        },
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                decision: "accept",
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);
const completeAndSnoozeThread = Effect.fn("test.completeAndSnoozeThread")(function* (
  name: string,
  snoozeMinutes: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Snoozed completion",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`dispatch-${name}`),
    threadId,
    messageId: MessageId.make(`dispatch-${name}`),
    text: "Run in the background",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "agent",
    creationSource: "mcp",
  });
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`interrupt-${name}`),
    threadId,
    runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
  });
  const completedAt = (yield* projections.getThreadProjection(threadId)).runs.at(-1)?.completedAt;
  assert.ok(completedAt);
  yield* TestClock.adjust("1 second");
  const snoozedUntil = DateTime.add(yield* DateTime.now, { minutes: snoozeMinutes });
  yield* orchestrator.dispatch({
    type: "thread.snooze",
    commandId: CommandId.make(`snooze-${name}`),
    threadId,
    snoozedUntil: DateTime.formatIso(snoozedUntil),
  });
  return { threadId, completedAt, snoozedUntil };
});

it.effect("mark unread retires an expired snooze so a dismissed wake stays dismissed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt, snoozedUntil } = yield* completeAndSnoozeThread(
      "mark-unread-expired-snooze",
      1,
    );
    yield* TestClock.adjust("2 minutes");
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("dismiss-woke"),
      threadId,
      visitedAt: DateTime.formatIso(snoozedUntil),
    });
    const dismissed = yield* projections.getThread(threadId);
    assert.deepEqual(dismissed.lastVisitedAt, snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-expired-snooze"),
      threadId,
    });
    const markedUnread = yield* projections.getThread(threadId);
    assert.deepEqual(
      markedUnread.lastVisitedAt,
      DateTime.subtract(completedAt, { milliseconds: 1 }),
    );
    assert.isNull(markedUnread.snoozedUntil);
    assert.isNull(markedUnread.snoozedAt);
    assert.deepEqual(markedUnread.lastSnoozeWakeAt, snoozedUntil);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mark unread leaves a future snooze untouched", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt } = yield* completeAndSnoozeThread(
      "mark-unread-future-snooze",
      60,
    );
    yield* TestClock.adjust("1 minute");
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("visit-snoozed"),
      threadId,
      visitedAt: DateTime.formatIso(yield* DateTime.now),
    });
    const visited = yield* projections.getThread(threadId);
    assert.isNotNull(visited.snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-future-snooze"),
      threadId,
    });
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...visited,
      lastVisitedAt: DateTime.subtract(completedAt, { milliseconds: 1 }),
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

// Stop's settle follow-up runs after the provider interrupt returns, possibly
// long after the Stop (retries) or again (an effect replayed after a crash).
// A later run's background work is not that Stop's to end.
it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    // The settle that followed a Stop of run 1's turn, dispatched only after
    // run 2 had settled with work of its own.
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    // A settle that found nothing to end replays as a no-op, even after work
    // it would match appears: its receipt is recorded with no events.
    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "pingdotgg/t3code",
      number: 123,
      url: "https://github.com/pingdotgg/t3code/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      workspaceStrategy: {
        type: "worktree",
        baseRef: "parent-head",
        startFromOrigin: false,
      },
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);
    assert.equal(child.runs[0]?.status, "preparing");
    assert.deepEqual(child.runs[0]?.workspacePreparation, {
      type: "worktree",
      baseRef: "parent-head",
      startFromOrigin: false,
    });

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/pingdotgg/t3code/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("finalizes a follow-up continuation without replacing the original result", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:followup-parent");
    const projectId = ProjectId.make("project:followup-parent");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-followup-parent"),
      threadId: parentThreadId,
      projectId,
      title: "Follow-up parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-followup-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:followup-parent"),
      text: "Start a delegated task.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("create-followup-original-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Complete the original task.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });

    const afterDelegation = yield* projections.getThreadProjection(parentThreadId);
    const originalTask = afterDelegation.subagents[0]!;
    const childThreadId = originalTask.childThreadId!;
    const childBefore = yield* projections.getThreadProjection(childThreadId);
    const originalChildRun = childBefore.runs[0]!;
    assert.equal(originalChildRun.delegatedTaskId, originalTask.id);
    yield* projections.apply({
      id: EventId.make("original-followup-result-message"),
      type: "message.updated",
      threadId: childThreadId,
      runId: originalChildRun.id,
      nodeId: originalChildRun.rootNodeId!,
      occurredAt: now,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:original-followup-result"),
        threadId: childThreadId,
        runId: originalChildRun.id,
        nodeId: originalChildRun.rootNodeId!,
        role: "assistant",
        text: "The original result stays published.",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("complete-followup-original-child-run"),
      type: "run.updated",
      threadId: childThreadId,
      runId: originalChildRun.id,
      occurredAt: now,
      payload: {
        ...originalChildRun,
        status: "completed",
        completedAt: now,
      },
    });
    yield* orchestrator.recoverDelegatedTasks;
    const afterOriginalCompletion = yield* projections.getThreadProjection(parentThreadId);
    assert.equal(
      afterOriginalCompletion.subagents.find((task) => task.id === originalTask.id)?.result,
      "The original result stays published.",
    );
    assert.isTrue(
      afterOriginalCompletion.contextTransfers.some(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourcePoint.runId === originalChildRun.id,
      ),
    );

    const followupCommand = {
      type: "message.dispatch",
      commandId: CommandId.make("dispatch-followup-child-message"),
      threadId: childThreadId,
      senderThreadId: parentThreadId,
      messageId: MessageId.make("message:followup-child"),
      text: "Continue with this follow-up.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "mcp",
    } as const;
    yield* orchestrator.dispatch(followupCommand);

    const afterFollowup = yield* projections.getThreadProjection(parentThreadId);
    const originalAfter = afterFollowup.subagents.find((task) => task.id === originalTask.id)!;
    const followupTask = afterFollowup.subagents.find((task) => task.id !== originalTask.id)!;
    const childAfterFollowup = yield* projections.getThreadProjection(childThreadId);
    const followupRun = childAfterFollowup.runs.find(
      (run) => run.delegatedTaskId === followupTask.id,
    );
    assert.notEqual(followupTask.id, originalTask.id);
    assert.equal(originalAfter.status, "completed");
    assert.equal(originalAfter.result, "The original result stays published.");
    assert.equal(followupTask.status, "running");
    assert.isNull(followupTask.result);
    assert.ok(followupRun);

    yield* projections.apply({
      id: EventId.make("cancel-followup-child-run"),
      type: "run.updated",
      threadId: childThreadId,
      runId: followupRun!.id,
      occurredAt: now,
      payload: { ...followupRun!, status: "cancelled", completedAt: now },
    });
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([
      {
        id: `effect:restart-continuation:${followupRun!.id}`,
        commandId: CommandId.make("queue-followup-restart-continuation"),
        threadId: childThreadId,
        request: {
          type: "provider-runtime.continue",
          sourceRunId: followupRun!.id,
        },
      },
    ]);
    yield* orchestrator.recoverDelegatedTasks;
    const beforeContinuation = yield* projections.getThreadProjection(parentThreadId);
    const stillPendingFollowup = beforeContinuation.subagents.find(
      (task) => task.id === followupTask.id,
    )!;
    assert.equal(stillPendingFollowup.status, "running");
    assert.isNull(stillPendingFollowup.result);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("continue-followup-child-task"),
      threadId: childThreadId,
      messageId: MessageId.make("message:continue-followup-child"),
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: followupRun!.id,
    });
    const childAfterContinuation = yield* projections.getThreadProjection(childThreadId);
    const continuationRun = childAfterContinuation.runs.find(
      (run) => run.restartContinuationOfRunId === followupRun!.id,
    )!;
    assert.equal(continuationRun.delegatedTaskId, followupTask.id);
    yield* projections.apply({
      id: EventId.make("followup-result-message"),
      type: "message.updated",
      threadId: childThreadId,
      runId: continuationRun.id,
      nodeId: continuationRun.rootNodeId!,
      occurredAt: now,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:followup-result"),
        threadId: childThreadId,
        runId: continuationRun.id,
        nodeId: continuationRun.rootNodeId!,
        role: "assistant",
        text: "The follow-up result is independent.",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("complete-followup-child-continuation"),
      type: "run.updated",
      threadId: childThreadId,
      runId: continuationRun.id,
      occurredAt: now,
      payload: { ...continuationRun, status: "completed", completedAt: now },
    });
    yield* orchestrator.recoverDelegatedTasks;
    const afterFollowupCompletion = yield* projections.getThreadProjection(parentThreadId);
    const completedOriginal = afterFollowupCompletion.subagents.find(
      (task) => task.id === originalTask.id,
    )!;
    const completedFollowup = afterFollowupCompletion.subagents.find(
      (task) => task.id === followupTask.id,
    )!;
    assert.equal(completedOriginal.result, "The original result stays published.");
    assert.equal(completedFollowup.status, "completed");
    assert.equal(completedFollowup.result, "The follow-up result is independent.");
    assert.equal(completedFollowup.completionDelivery?.state, "claimed");
    assert.isTrue(
      afterFollowupCompletion.runs
        .find((run) => run.id === parentRun.id)
        ?.delegatedCompletion?.delivery?.taskIds.includes(followupTask.id),
    );
    assert.deepEqual(
      afterFollowupCompletion.contextTransfers
        .filter((transfer) => transfer.type === "subagent_result")
        .map((transfer) => transfer.sourcePoint.runId)
        .toSorted(),
      [originalChildRun.id, continuationRun.id].toSorted(),
    );
    // Replaying the same accepted child message cannot create another task or run.
    yield* orchestrator.dispatch(followupCommand);
    const afterRetry = yield* projections.getThreadProjection(parentThreadId);
    const childAfterRetry = yield* projections.getThreadProjection(childThreadId);
    assert.equal(afterRetry.subagents.length, 2);
    assert.equal(
      childAfterRetry.runs.filter((run) => run.delegatedTaskId === followupTask.id).length,
      2,
    );
    assert.equal(
      afterRetry.subagents.find((task) => task.id === originalTask.id)?.result,
      "The original result stays published.",
    );
    const monitorNotification = {
      type: "message.dispatch",
      commandId: CommandId.make("dispatch-child-monitor-notification"),
      threadId: childThreadId,
      messageId: MessageId.make("message:child-monitor-notification"),
      text: "The pull request is still open.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "provider",
      notification: {
        source: { kind: "monitor" },
        outcome: "updated",
        summary: "The pull request is still open.",
      },
    } as const;
    yield* orchestrator.dispatch(monitorNotification);
    assert.equal((yield* projections.getThreadProjection(parentThreadId)).subagents.length, 2);

    const backgroundNotification = {
      type: "message.dispatch",
      commandId: CommandId.make("dispatch-child-background-notification"),
      threadId: childThreadId,
      messageId: MessageId.make("message:child-background-notification"),
      text: "A background task finished; inspect its result.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "provider",
      notification: {
        source: { kind: "background_task" },
        outcome: "completed",
        summary: "A background task finished.",
      },
    } as const;
    yield* orchestrator.dispatch(backgroundNotification);
    const afterBackgroundFollowup = yield* projections.getThreadProjection(parentThreadId);
    const backgroundTask = afterBackgroundFollowup.subagents.find(
      (task) => task.id !== originalTask.id && task.id !== followupTask.id,
    );
    assert.equal(backgroundTask?.origin, "app_owned");
    assert.equal(backgroundTask?.prompt, backgroundNotification.text);
    assert.equal(backgroundTask?.completionWake, "always");
    const childAfterBackgroundFollowup = yield* projections.getThreadProjection(childThreadId);
    assert.isTrue(
      childAfterBackgroundFollowup.runs.some((run) => run.delegatedTaskId === backgroundTask?.id),
    );
  }).pipe(Effect.provide(layerTest)),
);
