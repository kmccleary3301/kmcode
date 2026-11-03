import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  [false, true]
    .flatMap((mailbox) =>
      (
        [
          "before delivery",
          "during delivery",
          "before dispatch",
          "after delivery",
          "without native steering",
          "settled only",
        ] as const
      ).map((timing) => ({
        mailbox,
        timing,
        label: mailbox ? "mailbox notification" : "steering",
      })),
    )
    .filter(
      ({ mailbox, timing }) =>
        mailbox || (timing !== "without native steering" && timing !== "settled only"),
    ),
)("delivers $label when completion wins $timing", ({ mailbox, timing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const steerEntered = yield* Deferred.make<void>();
      const rejectSteer = yield* Deferred.make<void>();
      let steerCalls = 0;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: timing !== "without native steering",
        },
      };
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.gen(function* () {
                  steerCalls += 1;
                  if (timing === "after delivery") return;
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(rejectSteer);
                  return yield* new ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn already completed",
                  });
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:steering-completion");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:steering-completion"),
          title: "Steering race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const messageId = MessageId.make("message:steering");
        const taskId = NodeId.make("task:mailbox");
        if (mailbox) {
          const sink = yield* EventSink.EventSinkV2;
          const current = yield* orchestrator.getThreadProjection(threadId);
          const parentRun = current.runs.find((run) => run.id === first.runId)!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("mailbox:cohort"),
                type: "run.updated",
                threadId,
                runId: first.runId,
                occurredAt: now,
                payload: {
                  ...parentRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId, taskIds: [taskId] },
                  },
                },
              },
              {
                id: EventId.make("mailbox:task"),
                type: "subagent.updated",
                threadId,
                runId: first.runId,
                nodeId: taskId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: first.runId,
                  parentNodeId: first.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "Do background work",
                  title: "Background test",
                  model: null,
                  completionWake: timing === "settled only" ? "settled_only" : "always",
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const dispatchSteer = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "fix the popover",
          attachments: [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          dispatchMode: mailbox
            ? { type: "queue_after_active" }
            : { type: "steer_active", targetRunId: first.runId },
          createdBy: mailbox ? "agent" : "user",
          creationSource: mailbox ? "server" : "web",
          ...(mailbox
            ? {
                delegatedCompletion: {
                  parentRunId: first.runId,
                  generation: 1,
                  taskIds: [taskId],
                },
              }
            : {}),
        });
        if (timing !== "before dispatch") yield* dispatchSteer;
        if (timing === "after delivery") yield* worker.drain();
        const delivery =
          timing === "during delivery" ? yield* worker.runOnce.pipe(Effect.forkScoped) : null;
        if (delivery !== null) yield* Deferred.await(steerEntered);
        const completed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        if (delivery !== null) {
          yield* Deferred.succeed(rejectSteer, undefined);
          yield* Fiber.join(delivery);
        }
        if (timing === "before dispatch") yield* dispatchSteer;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (timing === "after delivery") {
          assert.equal(steerCalls, 1);
          assert.equal(started.length, 1);
          if (mailbox) {
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
            assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
            assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
            assert.equal(
              delivered.turnItems.filter((item) => item.type === "notification").length,
              1,
            );
            yield* orchestrator.dispatch({
              type: "notification.delivery.accept",
              commandId: CommandId.make("duplicate-acceptance"),
              threadId,
              messageId,
            });
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("read-result"),
              parentThreadId: threadId,
              taskId,
              observedByRunId: first.runId,
            });
            const acknowledged = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
          }
          return;
        }
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
        else assert.equal(started[1]?.message.text, "fix the popover");
        assert.deepEqual(started[1]?.message.attachments, [
          {
            type: "image",
            id: "steering-screenshot",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
        assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
        assert.equal(
          final.messages.find((message) => message.id === messageId)?.runId,
          started[1]?.runId,
        );
        assert.equal(
          final.turnItems.filter((item) =>
            mailbox
              ? item.type === "notification"
              : item.type === "user_message" && item.messageId === messageId,
          ).length,
          1,
        );
        yield* worker.drain();
        assert.equal(started.length, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `steering-completion-${timing}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);

// Claude and Pi steer live but cannot interrupt-and-restart, so a changed
// selection waits for the next turn as the thread's saved selection.
const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  supportsActiveSteering = true,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const started: ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering,
      supportsSteeringByInterruptRestart: false,
    },
  };
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              const turnStartedAt = yield* DateTime.now;
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: turnStartedAt,
                  completedAt: null,
                },
              });
            }),
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  // Creates the thread and starts its first turn on `runSelection`.
  const startFirstTurn = (text = "first") =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`thread:${name}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: "Steer with changed options",
        modelSelection: runSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const running = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const initialDispatch = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.timeoutOption("5 seconds"));
      assert.isTrue(Option.isSome(initialDispatch), "initial turn should dispatch");
      const startedEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
      assert.isTrue(Option.isSome(startedEffects), "provider start effects should drain");
      const runningTurn = yield* Fiber.join(running).pipe(Effect.timeoutOption("5 seconds"));
      assert.isTrue(Option.isSome(runningTurn), "provider should report a running turn");
      return threadId;
    });
  return { events, started, steered, layer, startFirstTurn };
});

it.effect("steers a changed turn-scoped selection into a provider that cannot restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-change",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        const steer = (id: string, selection: ModelSelection) =>
          orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text: id,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.andThen(worker.drain()));

        yield* steer("steer-changed", composerSelection);
        const changed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed"]);
        assert.equal(started.length, 1);
        assert.lengthOf(changed.attempts, 1);
        assert.equal(changed.runs[0]?.status, "running");
        assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
        assert.deepEqual(changed.thread.modelSelection, composerSelection);

        // Choosing the running run's selection again replaces the saved choice.
        yield* steer("steer-reverted", runSelection);
        const reverted = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
        assert.lengthOf(reverted.attempts, 1);
        assert.deepEqual(reverted.thread.modelSelection, runSelection);

        // The saved choice moves to another instance while the run keeps going.
        // Steering with the run's selection brings the thread's instance back too.
        const otherSelection = {
          instanceId: ProviderInstanceId.make("codex-work"),
          model: "other",
        };
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("switched-away"),
              type: "thread.provider-switched",
              threadId,
              providerInstanceId: otherSelection.instanceId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...reverted.thread,
                providerInstanceId: otherSelection.instanceId,
                modelSelection: otherSelection,
              },
            },
          ],
        });
        yield* steer("steer-back", runSelection);
        const back = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
        assert.equal(back.thread.providerInstanceId, instanceId);
        assert.deepEqual(back.thread.modelSelection, runSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a steer that missed the turn on the saved next-turn selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-follow-up",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "late steer",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        // The turn ends before the worker delivers the steer, so the steer
        // becomes a follow-up turn.
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
        assert.deepEqual(started[1]?.modelSelection, composerSelection);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
it.effect("force sends multiple queued messages and can force send a requeued message again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "multiple-promoted-messages",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        for (const text of ["one", "two", "remaining"]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`queue-${text}`),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const promote = Effect.fn("test.promote")(function* (text: string, commandId: string) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const messageId = MessageId.make(`message:${text}`);
          const queued = projection.runs.find(
            (run) => run.status === "queued" && run.userMessageId === messageId,
          );
          assert.isDefined(queued);
          if (queued === undefined) return;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(commandId),
            threadId,
            queuedRunId: queued.id,
            targetRunId: started[0]!.runId,
          });
        });
        yield* promote("one", "promote-one");
        yield* promote("two", "promote-two");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two"]);

        // The completion-race fallback redispatches the same message into the queue.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("requeue-one"),
          threadId,
          messageId: MessageId.make("message:one"),
          text: "one",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const requeued = yield* orchestrator.getThreadProjection(threadId);
        const requeuedItem = requeued.turnItems.find(
          (item) =>
            item.type === "user_message" && item.messageId === MessageId.make("message:one"),
        );
        assert.equal(requeuedItem?.status, "pending");
        assert.isNull(requeuedItem?.startedAt);
        assert.isNull(requeuedItem?.completedAt);
        yield* promote("one", "promote-one-again");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two", "one"]);
        assert.lengthOf(started, 1);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          final.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:remaining")],
        );
        for (const text of ["one", "two"]) {
          const items = final.turnItems.filter(
            (item) => item.type === "user_message" && item.messageId === `message:${text}`,
          );
          assert.lengthOf(items, 1);
          assert.equal(items[0]?.status, "completed");
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.live("skips active compaction when promoting a queued message to steer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-compaction-promotion",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        const compactionRun = started[0]!;
        const initialProjection = yield* orchestrator.getThreadProjection(threadId);
        const initialMessage = initialProjection.messages.find(
          (message) => message.id === compactionRun.message.messageId,
        );
        assert.isDefined(initialMessage);
        if (initialMessage === undefined) return;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        // The fake provider keeps a regular active turn while the projection models native /compact.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:compaction-message"),
              type: "message.updated",
              threadId,
              runId: compactionRun.runId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: { ...initialMessage, text: "/compact", updatedAt: now },
            },
          ],
        });
        const followupMessageId = MessageId.make("message:compaction-followup");
        const queuedMessage = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-followup"),
            threadId,
            messageId: followupMessageId,
            text: "follow-up instead of compacting",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(queuedMessage), "follow-up should queue");
        const queuedProjection = yield* orchestrator.getThreadProjection(threadId);
        const queuedRun = queuedProjection.runs.find(
          (run) => run.userMessageId === followupMessageId,
        );
        assert.ok(queuedRun);
        if (queuedRun === undefined) return;
        const compactionSettled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === compactionRun.runId &&
              event.payload.status !== "waiting" &&
              event.payload.status !== "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const promoted = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote-followup"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: compactionRun.runId,
          })
          .pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(promoted), "promotion should interrupt compaction");
        const afterPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterPromotion.runs.find((run) => run.id === queuedRun.id)?.queuePosition, 1);
        assert.equal(
          afterPromotion.runs.find((run) => run.id === compactionRun.runId)?.status,
          "running",
        );
        assert.isTrue(
          afterPromotion.turnItems.some(
            (item) => item.runId === compactionRun.runId && item.type === "run_interrupt_request",
          ),
          "promotion should request interruption and let the provider report terminal state",
        );
        const activeTurn = afterPromotion.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            ...activeTurn,
            status: "interrupted",
            completedAt: yield* DateTime.now,
          },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: activeTurn.providerThreadId,
          providerTurnId: activeTurn.id,
          runOrdinal: compactionRun.runOrdinal,
          status: "interrupted",
          failure: null,
          threadDisposition: "reusable",
        });
        const stoppedEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(stoppedEffects), "interrupt effects should drain");
        const settled = yield* Fiber.join(compactionSettled).pipe(
          Effect.timeoutOption("2 seconds"),
        );
        assert.isTrue(Option.isSome(settled), "compaction should settle after its interrupt");
        const settledEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(settledEffects), "settled compaction effects should drain");
        const resumed = yield* orchestrator.resumeQueuedRuns.pipe(
          Effect.timeoutOption("5 seconds"),
        );
        assert.isTrue(Option.isSome(resumed), "queued message should resume");
        const followupEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(followupEffects), "follow-up effects should drain");

        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(final.runs.find((run) => run.id === queuedRun.id)?.status, "running");
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, followupMessageId);
        assert.equal(started[1]?.message.text, "follow-up instead of compacting");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("batches queued inter-thread messages into the next active steerable turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("queued-mcp-steer-batch");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        const messageIds = ["first-follow-up", "second-follow-up", "third-follow-up"].map((id) =>
          MessageId.make(`message:${id}`),
        );
        for (const [index, messageId] of messageIds.entries()) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`queue-agent-${index}`),
            threadId,
            messageId,
            text: `follow-up-${index}`,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          });
        }
        yield* TestClock.adjust("1 millis");
        const first = started[0];
        assert.isDefined(first);
        if (first === undefined) return;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const firstTurn = projection.providerTurns.find(
          (turn) => turn.runAttemptId === first.attemptId,
        );
        assert.isDefined(firstTurn);
        if (firstTurn === undefined) return;
        const firstRun = projection.runs.find((run) => run.id === first.runId);
        assert.isDefined(firstRun);
        if (firstRun === undefined) return;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("batch-first-run-completed"),
              type: "run.updated",
              threadId,
              runId: firstRun.id,
              ...(firstRun.rootNodeId === null ? {} : { nodeId: firstRun.rootNodeId }),
              providerInstanceId: firstRun.providerInstanceId,
              occurredAt: now,
              payload: {
                ...firstRun,
                status: "completed",
                completedAt: now,
                workCompletedAt: now,
              },
            },
            {
              id: EventId.make("batch-first-turn-completed"),
              type: "provider-turn.updated",
              threadId,
              runId: firstRun.id,
              nodeId: firstTurn.nodeId,
              providerInstanceId: firstRun.providerInstanceId,
              occurredAt: now,
              payload: { ...firstTurn, status: "completed", completedAt: now },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.equal(started.length, 2);
        let promotedProjection = yield* orchestrator.getThreadProjection(threadId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const promotedCount = promotedProjection.turnItems.filter(
            (item) =>
              item.type === "user_message" &&
              item.inputIntent === "promoted_queued_to_steer" &&
              messageIds.slice(1).includes(item.messageId),
          ).length;
          if (promotedCount === 2) break;
          yield* Effect.yieldNow;
          promotedProjection = yield* orchestrator.getThreadProjection(threadId);
        }
        const promotedCount = promotedProjection.turnItems.filter(
          (item) =>
            item.type === "user_message" &&
            item.inputIntent === "promoted_queued_to_steer" &&
            messageIds.slice(1).includes(item.messageId),
        ).length;
        assert.equal(promotedCount, 2, "remaining queued messages should promote");
        yield* worker.drain();

        assert.equal(started.length, 2);
        assert.deepEqual(steered, ["follow-up-1", "follow-up-2"]);
        const final = yield* orchestrator.getThreadProjection(threadId);
        for (const messageId of messageIds.slice(1)) {
          const message = final.messages.find((candidate) => candidate.id === messageId);
          assert.equal(message?.runId, started[1]?.runId);
          assert.isTrue(
            final.turnItems.some(
              (item) =>
                item.type === "user_message" &&
                item.messageId === messageId &&
                item.inputIntent === "promoted_queued_to_steer",
            ),
          );
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("absorbs held inter-thread messages after Stop but preserves held user queue order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("queued-mcp-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        const userMessageIds = ["user-before-agent", "user-after-agent"].map((id) =>
          MessageId.make(`message:${id}`),
        );
        const agentMessageIds = ["agent-one", "agent-two"].map((id) =>
          MessageId.make(`message:${id}`),
        );
        for (const [index, messageId] of [
          userMessageIds[0]!,
          agentMessageIds[0]!,
          userMessageIds[1]!,
          agentMessageIds[1]!,
        ].entries()) {
          const isAgent = agentMessageIds.includes(messageId);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`stop-queue-${index}`),
            threadId,
            messageId,
            text: String(messageId),
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: isAgent ? "agent" : "user",
            creationSource: isAgent ? "mcp" : "web",
          });
        }
        const first = started[0];
        assert.isDefined(first);
        if (first === undefined) return;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const firstTurn = projection.providerTurns.find(
          (turn) => turn.runAttemptId === first.attemptId,
        );
        assert.isDefined(firstTurn);
        if (firstTurn === undefined) return;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-held-agent-queue"),
          threadId,
        });
        const stopEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(stopEffects), "Stop effects should drain");
        const now = yield* DateTime.now;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...firstTurn, status: "interrupted", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: firstTurn.providerThreadId,
          providerTurnId: firstTurn.id,
          runOrdinal: first.runOrdinal,
          status: "interrupted",
          failure: null,
          threadDisposition: "reusable",
        });
        let stoppedProjection = yield* orchestrator.getThreadProjection(threadId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            stoppedProjection.runs.find((run) => run.id === first.runId)?.status === "interrupted"
          )
            break;
          yield* Effect.yieldNow;
          stoppedProjection = yield* orchestrator.getThreadProjection(threadId);
        }
        assert.equal(
          stoppedProjection.runs.find((run) => run.id === first.runId)?.status,
          "interrupted",
          "Stop should settle the original run",
        );
        yield* TestClock.adjust("1 millis");

        const wakeId = MessageId.make("message:post-stop-wake");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("post-stop-wake"),
          threadId,
          messageId: wakeId,
          text: "wake after Stop",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "provider",
        });
        const wakeEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(wakeEffects), "the wake run's effects should drain");
        let wakeProjection = yield* orchestrator.getThreadProjection(threadId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const promotedCount = wakeProjection.turnItems.filter(
            (item) =>
              item.type === "user_message" &&
              item.inputIntent === "promoted_queued_to_steer" &&
              agentMessageIds.includes(item.messageId),
          ).length;
          if (promotedCount === 2) break;
          yield* Effect.yieldNow;
          wakeProjection = yield* orchestrator.getThreadProjection(threadId);
        }
        const promotedCount = wakeProjection.turnItems.filter(
          (item) =>
            item.type === "user_message" &&
            item.inputIntent === "promoted_queued_to_steer" &&
            agentMessageIds.includes(item.messageId),
        ).length;
        assert.equal(promotedCount, 2, "held agent messages should promote");
        const steerEffects = yield* worker.drain().pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(steerEffects), "held-message steer effects should drain");

        const final = yield* orchestrator.getThreadProjection(threadId);
        const queuedUserRuns = final.runs
          .filter((run) => userMessageIds.includes(run.userMessageId))
          .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queuedUserRuns.map((run) => run.userMessageId),
          userMessageIds,
        );
        assert.isTrue(queuedUserRuns.every((run) => run.status === "queued" && run.queueHeld));
        assert.deepEqual(steered, [String(agentMessageIds[0]), String(agentMessageIds[1])]);
        assert.equal(started.length, 2);
        assert.isTrue(
          agentMessageIds.every((messageId) =>
            final.messages.some(
              (message) => message.id === messageId && message.runId === started[1]?.runId,
            ),
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("leaves queued inter-thread messages queued when the provider cannot steer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "queued-mcp-non-steerable",
        false,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn();
        const messageIds = ["first", "second"].map((id) => MessageId.make(`message:${id}`));
        for (const [index, messageId] of messageIds.entries()) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`non-steerable-queue-${index}`),
            threadId,
            messageId,
            text: `message-${index}`,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          });
        }
        const first = started[0];
        assert.isDefined(first);
        if (first === undefined) return;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const firstTurn = projection.providerTurns.find(
          (turn) => turn.runAttemptId === first.attemptId,
        );
        assert.isDefined(firstTurn);
        if (firstTurn === undefined) return;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            ...firstTurn,
            status: "completed",
            completedAt: yield* DateTime.now,
          },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: firstTurn.providerThreadId,
          providerTurnId: firstTurn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        let settledProjection = yield* orchestrator.getThreadProjection(threadId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (settledProjection.runs.find((run) => run.id === first.runId)?.status === "waiting")
            break;
          yield* Effect.yieldNow;
          settledProjection = yield* orchestrator.getThreadProjection(threadId);
        }
        assert.equal(
          settledProjection.runs.find((run) => run.id === first.runId)?.status,
          "waiting",
        );
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 2);
        assert.deepEqual(steered, []);
        assert.equal(
          final.runs.find((run) => run.userMessageId === messageIds[1])?.status,
          "queued",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);
