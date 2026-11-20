import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape, ProviderAdapterV2TurnInput } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("antigravity");
const instanceId = ProviderInstanceId.make("antigravity-goal-test");
const modelSelection = {
  instanceId,
  model: "gemini-test-low",
} satisfies ModelSelection;
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  turns: {
    ...CodexProviderCapabilitiesV2.turns,
    supportsNativeGoals: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

function makeAntigravityAdapter(
  started: Array<ProviderAdapterV2TurnInput>,
): ProviderAdapterV2Shape {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cwd = sessionInput.runtimePolicy.cwd ?? "/workspace";
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
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
          events: Stream.never,
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native-thread:${threadId}`,
                strength: "strong",
              },
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
          startTurn: (input) =>
            Effect.sync(() => {
              started.push(input);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
}

function makeAntigravityGoalTestLayer(name: string, started: Array<ProviderAdapterV2TurnInput>) {
  const databaseLayer = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
    ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(makeAntigravityAdapter(started)),
      { databaseLayer, runEffectWorker: false },
    ),
  );
}

it.effect("starts Antigravity /goal objectives verbatim when handoff context is pending", () => {
  const started: Array<ProviderAdapterV2TurnInput> = [];
  const layer = makeAntigravityGoalTestLayer("antigravity-native-goal", started);
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("antigravity-native-goal");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:antigravity-native-goal");
      const messageId = MessageId.make("message:antigravity-native-goal");
      const objective = "/goal Ship the feature";
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-antigravity-native-goal"),
        threadId,
        projectId: ProjectId.make("project:antigravity-native-goal"),
        title: "Antigravity native goal",
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
        commandId: CommandId.make("dispatch-antigravity-native-goal"),
        threadId,
        messageId,
        text: objective,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
      assert.ok(run);
      if (run === undefined || run.providerThreadId === null) return;
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      assert.ok(providerThread);
      if (providerThread === undefined) return;
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:antigravity-native-goal-handoff"),
        type: "context-handoff.updated",
        threadId,
        runId: run.id,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: ContextHandoffId.make("handoff:antigravity-native-goal"),
          threadId,
          targetRunId: run.id,
          fromProviderThreadIds: [],
          toProviderThreadId: providerThread.id,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: "HANDOFF_CONTEXT_SENTINEL",
          createdByProviderInstanceId: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* worker.drain();

      assert.equal(started.length, 1);
      assert.equal(started[0]?.message.text, objective);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("rejects unsupported Antigravity goal controls with recovery guidance", () => {
  const started: Array<ProviderAdapterV2TurnInput> = [];
  const layer = makeAntigravityGoalTestLayer("antigravity-goal-controls", started);
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("antigravity-goal-controls");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:antigravity-goal-controls");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-antigravity-goal-controls"),
        threadId,
        projectId: ProjectId.make("project:antigravity-goal-controls"),
        title: "Antigravity goal controls",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });

      const guidance =
        "Antigravity accepts /goal followed by an objective. Interrupt the running turn, then ask Antigravity to stop the current goal.";
      for (const [index, text] of [
        "/goal",
        "/goal edit",
        "/goal show",
        "/goal clear",
        "/goal pause",
        "/goal resume",
      ].entries()) {
        const rejected = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`dispatch-antigravity-goal-control-${index}`),
            threadId,
            messageId: MessageId.make(`message:antigravity-goal-control-${index}`),
            text,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        if (rejected._tag !== "OrchestratorDispatchError") {
          assert.fail(`Expected OrchestratorDispatchError, got ${rejected._tag}`);
        }
        assert.equal(rejected.cause, guidance);
      }
    }).pipe(Effect.provide(layer)),
  );
});
