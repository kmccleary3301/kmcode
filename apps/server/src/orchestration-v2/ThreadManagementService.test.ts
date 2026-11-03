import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

const layerManagementDependencies = (
  options: {
    readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly getSession?: ProviderSessionManager.ProviderSessionManagerV2["Service"]["get"];
    readonly hasReceipt?: boolean;
    readonly sessionOverrides?: Partial<ProviderSessionManager.ProviderSessionManagerV2["Service"]>;
  } = {},
) =>
  Layer.mergeAll(
    ThreadCommandExecutor.layer,
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: options.getSession ?? (() => Effect.succeed(Option.none())),
      ...options.sessionOverrides,
    }),
    ServerSettings.layerTest(options.serverSettings).pipe(Layer.orDie),
    Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
      getByCommandId: () =>
        Effect.succeed(options.hasReceipt ? Option.some({} as never) : Option.none()),
    }),
  );

it.effect.each([true, false])(
  "routes auto sends according to the active provider's steering capability",
  (supportsActiveSteering) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:thread-management:auto-steer");
      const threadId = ThreadId.make("thread:thread-management:auto-steer");
      const messageId = MessageId.make("message:thread-management:auto-steer");
      const runId = RunId.make("run:thread-management:auto-steer");
      const attemptId = RunAttemptId.make("run-attempt:thread-management:auto-steer");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("provider-session:auto-steer");
      const providerThreadId = ProviderThreadId.make("provider-thread:auto-steer");
      const driver = ProviderDriverKind.make("codex");
      const now = yield* DateTime.now;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering,
        },
      };
      const session: ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/tmp",
          model: "test-model",
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: () => Effect.die("unused interruptTurn"),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        appThreadId: threadId,
        providerSessionId,
        providerInstanceId,
        driver,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = {
        thread: { id: threadId, projectId, archivedAt: null, deletedAt: null },
        runs: [
          {
            id: runId,
            ordinal: 1,
            status: "running",
            activeAttemptId: attemptId,
            providerThreadId,
          },
        ],
        providerTurns: [{ runAttemptId: attemptId, status: "running" }],
        providerThreads: [providerThread],
        messages: [
          {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "follow up",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        turnItems: [
          {
            type: "user_message",
            messageId,
            inputIntent: "steer",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const dispatchModes = yield* Ref.make<ReadonlyArray<string>>([]);
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () => Effect.succeed(projection),
              dispatch: (command) =>
                Ref.update(dispatchModes, (modes) => [
                  ...modes,
                  command.type === "message.dispatch" ? command.dispatchMode.type : "other",
                ]).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
            }),
            Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
              ensureTranscript: () =>
                Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
            }),
            layerManagementDependencies({
              getSession: () => Effect.succeed(Option.some(session)),
            }),
          ),
        ),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );

      yield* service.sendToThread({
        projectId,
        commandId: CommandId.make("command:thread-management:auto-steer"),
        threadId,
        messageId,
        text: "follow up",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      });

      expect((yield* Ref.get(dispatchModes))[0]).toBe(
        supportsActiveSteering ? "steer_active" : "queue_after_active",
      );
    }),
);

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  // Read-state commands skip transcript hydration entirely: they fire on
  // every activity bump while a thread is open and never touch messages.
  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.visit",
      commandId: CommandId.make("command:thread-management:visit"),
      threadId: targetThreadId,
      visitedAt: "2026-07-30T00:00:00.000Z",
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("command:thread-management:mark-unread"),
      threadId: targetThreadId,
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("derives thread management messages from structural error attributes", () => {
  const projectId = ProjectId.make("project:thread-management:errors");
  const threadId = ThreadId.make("thread:thread-management:errors");
  const runId = RunId.make("run:thread-management:errors");
  const messageId = MessageId.make("message:thread-management:errors");
  const infrastructureCause = new Error("private sqlite detail");

  const threadNotFound = new ThreadManagementService.ThreadManagementThreadNotFoundError({
    projectId,
    threadId,
  });
  expect(threadNotFound).toMatchObject({ projectId, threadId });
  expect(threadNotFound.message).toBe(`Thread ${threadId} was not found in project ${projectId}.`);

  const runNotFound = new ThreadManagementService.ThreadManagementRunNotFoundError({
    threadId,
    runId,
  });
  expect(runNotFound).toMatchObject({ threadId, runId });
  expect(runNotFound.message).toBe(`Run ${runId} does not belong to thread ${threadId}.`);

  const archived = new ThreadManagementService.ThreadManagementThreadArchivedError({
    threadId,
  });
  expect(archived).toMatchObject({ threadId });
  expect(archived.message).toBe(`Thread ${threadId} is archived and cannot receive messages.`);

  const notSteerable = new ThreadManagementService.ThreadManagementNoSteerableRunError({
    threadId,
    mode: "restart",
  });
  expect(notSteerable).toMatchObject({
    threadId,
    mode: "restart",
  });
  expect(notSteerable.message).toBe(
    `Thread ${threadId} has no running turn that can be restarted.`,
  );

  const notInterruptible = new ThreadManagementService.ThreadManagementThreadNotInterruptibleError({
    threadId,
    runId,
  });
  expect(notInterruptible).toMatchObject({ threadId, runId });
  expect(notInterruptible.message).toBe(`Run ${runId} is not currently interruptible.`);

  const listFailure = new ThreadManagementService.ThreadManagementProjectThreadsListError({
    projectId,
    cause: infrastructureCause,
  });
  expect(listFailure).toMatchObject({ projectId, cause: infrastructureCause });
  expect(listFailure.message).toBe(`Unable to list threads in project ${projectId}.`);
  expect(listFailure.message).not.toContain(infrastructureCause.message);

  const durableProjectionFailure =
    new ThreadManagementService.ThreadManagementDurableRunProjectionError({
      threadId,
      messageId,
    });
  expect(durableProjectionFailure).toMatchObject({ threadId, messageId });
  expect(durableProjectionFailure.message).toBe(
    `Message ${messageId} was accepted on thread ${threadId} without a durable run projection.`,
  );
});

it.effect("classifies projection infrastructure failures separately from a missing thread", () => {
  const projectId = ProjectId.make("project:thread-management:projection-failure");
  const threadId = ThreadId.make("thread:thread-management:projection-failure");
  const infrastructureCause = new Error("sqlite read failed");
  const projectionError = new Orchestrator.OrchestratorProjectionError({
    threadId,
    cause: infrastructureCause,
  });
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadProjection: () => Effect.fail(projectionError),
        }),
        layerManagementDependencies(),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementProjectionLoadError);
    expect(error).toMatchObject({
      projectId,
      threadId,
      cause: projectionError,
    });
    expect(error.message).toBe(`Unable to load thread ${threadId} in project ${projectId}.`);
  }).pipe(Effect.provide(layerTest));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        layerManagementDependencies(),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("preserves failed legacy materialization when reading checkpoint context", () => {
  const threadId = ThreadId.make("thread:thread-management:checkpoint-import-failure");
  const importError = new LegacyV1ThreadImporter.LegacyV1ThreadImportError({
    threadId,
    operation: "hydrate transcript for",
    cause: new Error("checkpoint import failed"),
  });
  const layerTest = ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getCheckpointContext: () =>
            Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
        }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          ensureTranscript: () => Effect.fail(importError),
        }),
        layerManagementDependencies(),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* service.getCheckpointContext(threadId).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Orchestrator.OrchestratorProjectionError);
    expect(error).toMatchObject({ threadId, cause: importError });
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([
  { finalStatus: "completed" as const, timedOut: false },
  { finalStatus: "failed" as const, timedOut: false },
  { finalStatus: "cancelled" as const, timedOut: false },
  { finalStatus: "interrupted" as const, timedOut: false },
  { finalStatus: "rolled_back" as const, timedOut: false },
  { finalStatus: "running" as const, timedOut: true },
  { finalStatus: "missing" as const },
])("waitForThread timeout final read when selected run is $finalStatus", (scenario) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-timeout");
    const threadId = ThreadId.make("thread:thread-management:wait-timeout");
    const runId = RunId.make("run:thread-management:wait-timeout");
    const subscribed = yield* Deferred.make<void>();
    let reads = 0;
    const projection = (status: OrchestrationV2Run["status"] | "missing") =>
      ({
        thread: { id: threadId, projectId, deletedAt: null },
        runs: status === "missing" ? [] : [{ id: runId, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            // No run update arrives, so the timeout path runs while a final
            // projection read can still observe a terminal run.
            streamStoredEventsFrom: () =>
              Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              ),
            getThreadRecords: () =>
              Effect.sync(() => {
                reads += 1;
                return projection(reads === 1 ? "running" : scenario.finalStatus);
              }),
          }),
          layerManagementDependencies(),
        ),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 1,
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(fiber);

    if (scenario.finalStatus === "missing") {
      expect(result._tag).toBe("Failure");
      expect(result).toMatchObject({
        failure: expect.any(ThreadManagementService.ThreadManagementRunNotFoundError),
      });
      expect(result).toMatchObject({
        failure: { threadId, runId },
      });
    } else {
      expect(result._tag).toBe("Success");
      expect(result).toMatchObject({
        success: {
          threadId,
          timedOut: scenario.timedOut,
          run: { id: runId, status: scenario.finalStatus },
        },
      });
    }
  }),
);

it.effect("waitForThread reads the run again only when the run updates", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-event");
    const threadId = ThreadId.make("thread:thread-management:wait-event");
    const runId = RunId.make("run:thread-management:wait-event");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    let reads = 0;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            // Only the run.updated stream carries events in this test.
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(() => {
                reads += 1;
                return {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: [{ id: runId, status }],
                } as unknown as OrchestrationV2ThreadProjection;
              }),
          }),
          layerManagementDependencies(),
        ),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    status = "completed";
    yield* Queue.offer(events, stored(1, { type: "run.updated", payload: { id: "other-run" } }));
    yield* Queue.offer(events, stored(2, { type: "run.updated", payload: { id: runId, status } }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "completed" } });
    // The first read plus one for this run's update. The other run caused none.
    expect(reads).toBe(2);
  }),
);

it.effect("defers settlement from its own active turn and settles only after completion", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:self-settle");
    const threadId = ThreadId.make("thread:thread-management:self-settle");
    const runId = RunId.make("run:thread-management:self-settle");
    const commandId = CommandId.make("command:thread-management:self-settle");
    const subscribed = yield* Deferred.make<void>();
    const settlementCommand = yield* Deferred.make<CommandId>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const shell = {
      id: threadId,
      projectId,
      activeRunId: runId,
    };
    const projection = () =>
      ({
        thread: { id: threadId, projectId, deletedAt: null },
        runs: [{ id: runId, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: () => Effect.succeed(shell as never),
            getThreadEventSequence: () => Effect.succeed(0),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () => Effect.sync(projection),
            dispatch: (command) =>
              Effect.succeed(command).pipe(
                Effect.tap((value) => Deferred.succeed(settlementCommand, value.commandId)),
                Effect.as({ sequence: 17 } as never),
              ),
          }),
          layerManagementDependencies(),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const result = yield* service.settleThread({ threadId, commandId, byOwnAgent: true });
      expect(result).toEqual({ settlesWhenTurnEnds: true });
      yield* Deferred.await(subscribed);
      status = "completed";
      yield* Queue.offer(
        events,
        stored(1, { type: "run.updated", payload: { id: runId, status } }),
      );
      expect(yield* Deferred.await(settlementCommand)).toBe(
        CommandId.make(`server:settle-after-run:${runId}`),
      );
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("stops only a running Claude workflow coordinator through its live native runtime", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:workflow-stop");
    const threadId = ThreadId.make("thread:thread-management:workflow-stop");
    const subagentId = NodeId.make("node:thread-management:workflow-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:workflow-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:workflow-stop");
    const providerInstanceId = ProviderInstanceId.make("claudeAgent");
    const driver = ProviderDriverKind.make("claudeAgent");
    const providerThread = {
      id: providerThreadId,
      appThreadId: threadId,
      providerSessionId,
      providerInstanceId,
      driver,
    } as unknown as OrchestrationV2ProviderThread;
    const projection = {
      thread: {
        id: threadId,
        projectId,
        deletedAt: null,
        runtimeMode: "auto",
        interactionMode: "default",
      },
      subagents: [
        {
          id: subagentId,
          threadId,
          runId: null,
          origin: "provider_native",
          driver,
          providerInstanceId,
          providerThreadId,
          nativeTaskRef: { driver, nativeId: "native-task-1", strength: "strong" },
          status: "running",
          workflow: { phases: [], agents: [] },
        },
      ],
      runs: [],
      providerThreads: [providerThread],
    } as unknown as OrchestrationV2ThreadProjection;
    const stopped: Array<string> = [];
    const runtime = {
      stopTask: ({ taskId }: { readonly taskId: string }) =>
        Effect.sync(() => stopped.push(taskId)),
    } as never;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.succeed(projection),
          }),
          layerManagementDependencies({
            getSession: () => Effect.succeed(Option.some(runtime)),
          }),
        ),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.stopWorkflow({ threadId, subagentId });
    expect(stopped).toEqual(["native-task-1"]);
  }),
);

it.effect(
  "reports unsupported workflow-stop targets without opening or stopping another provider",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:thread-management:unsupported-workflow");
      const threadId = ThreadId.make("thread:thread-management:unsupported-workflow");
      const subagentId = NodeId.make("node:thread-management:unsupported-workflow");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const projection = {
        thread: {
          id: threadId,
          projectId,
          deletedAt: null,
          runtimeMode: "auto",
          interactionMode: "default",
        },
        subagents: [
          {
            id: subagentId,
            threadId,
            origin: "provider_native",
            driver,
            providerInstanceId,
            status: "running",
            workflow: { phases: [], agents: [] },
          },
        ],
        runs: [],
        providerThreads: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () => Effect.succeed(projection),
            }),
            layerManagementDependencies(),
          ),
        ),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const error = yield* Effect.flip(service.stopWorkflow({ threadId, subagentId }));
      expect(error.reason).toBe("unsupported");
    }),
);

it.effect("blocks provider dispatch when the project override disables its instance", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:provider-disabled");
    const threadId = ThreadId.make("thread:thread-management:provider-disabled");
    const commandId = CommandId.make("command:thread-management:provider-disabled");
    const instanceId = ProviderInstanceId.make("codex");
    let dispatched = false;
    const projection = {
      thread: {
        id: threadId,
        projectId,
        deletedAt: null,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
      },
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.succeed(projection),
            dispatch: () =>
              Effect.sync(() => {
                dispatched = true;
                return { sequence: 1 } as never;
              }),
          }),
          layerManagementDependencies({
            serverSettings: {
              projectSettingsOverrides: {
                [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
              },
            },
          }),
        ),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const error = yield* Effect.flip(
      service.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:provider-disabled"),
        text: "must not dispatch",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        createdBy: "user",
        creationSource: "web",
      }),
    );

    expect(error).toBeInstanceOf(
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
    );
    expect(dispatched).toBe(false);
  }),
);

it.effect("replays an accepted delegated command after its provider is disabled", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:receipt-replay");
    const threadId = ThreadId.make("thread:thread-management:receipt-replay");
    const commandId = CommandId.make("command:thread-management:receipt-replay");
    const freshCommandId = CommandId.make("command:thread-management:receipt-replay-fresh");
    const instanceId = ProviderInstanceId.make("codex");
    const receipts = new Map<CommandId, unknown>();
    const dispatches: Array<CommandId> = [];
    const newWork: Array<CommandId> = [];
    const projection = {
      thread: { id: threadId, projectId, deletedAt: null },
    } as unknown as OrchestrationV2ThreadProjection;
    const command: OrchestrationV2ServerCommand = {
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId,
      parentThreadId: threadId,
      parentRunId: RunId.make("run:thread-management:receipt-replay"),
      parentNodeId: NodeId.make("node:thread-management:receipt-replay"),
      task: "Review the changes.",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    const settingsLayer = ServerSettings.layerTest({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    }).pipe(Layer.orDie);
    const receiptLayer = Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
      getByCommandId: (lookupId) =>
        Effect.sync(() => {
          const receipt = receipts.get(lookupId);
          return receipt === undefined ? Option.none() : Option.some(receipt as never);
        }),
    });
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.succeed(projection),
            dispatch: (received) =>
              Effect.sync(() => {
                dispatches.push(received.commandId);
                if (!receipts.has(received.commandId)) {
                  newWork.push(received.commandId);
                  receipts.set(received.commandId, { sequence: 42 });
                }
                return { sequence: 42 } as never;
              }),
          }),
          ThreadCommandExecutor.layer,
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeed(Option.none()),
          }),
          settingsLayer,
          receiptLayer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const settings = yield* ServerSettings.ServerSettingsService;

      const accepted = yield* service.dispatch(command);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      });
      const replayed = yield* service.dispatch(command);
      const freshError = yield* Effect.flip(
        service.dispatch({ ...command, commandId: freshCommandId }),
      );

      expect(accepted).toMatchObject({ sequence: 42 });
      expect(replayed).toMatchObject({ sequence: 42 });
      expect(freshError).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(dispatches).toEqual([commandId, commandId]);
      expect(newWork).toEqual([commandId]);
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("stops a reused delegated child and cancels only its queued follow-up", () =>
  Effect.gen(function* () {
    const rootThreadId = ThreadId.make("thread:thread-management:dedup-root");
    const childThreadId = ThreadId.make("thread:thread-management:dedup-child");
    const grandchildThreadId = ThreadId.make("thread:thread-management:dedup-grandchild");
    const originalTaskId = NodeId.make("node:thread-management:dedup-original");
    const followupTaskId = NodeId.make("node:thread-management:dedup-followup");
    const originalRunId = RunId.make("run:thread-management:dedup-original");
    const followupRunId = RunId.make("run:thread-management:dedup-followup");
    const unrelatedRunId = RunId.make("run:thread-management:dedup-unrelated");
    const rootTasks = [
      {
        id: originalTaskId,
        threadId: rootThreadId,
        runId: originalRunId,
        origin: "app_owned",
        childThreadId,
        status: "completed",
      },
      {
        id: followupTaskId,
        threadId: rootThreadId,
        runId: followupRunId,
        origin: "app_owned",
        childThreadId,
        status: "running",
      },
    ];
    const childTasks = [
      {
        id: NodeId.make("node:thread-management:dedup-nested"),
        threadId: childThreadId,
        runId: null,
        origin: "app_owned",
        childThreadId: grandchildThreadId,
        status: "running",
      },
      {
        id: NodeId.make("node:thread-management:dedup-cycle"),
        threadId: childThreadId,
        runId: null,
        origin: "app_owned",
        childThreadId: rootThreadId,
        status: "running",
      },
    ];
    const stoppedThreads: Array<ThreadId> = [];
    const cancelledRuns: Array<RunId> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId) =>
              Effect.succeed({
                subagents:
                  threadId === rootThreadId
                    ? rootTasks
                    : threadId === childThreadId
                      ? childTasks
                      : [],
                runs:
                  threadId === childThreadId
                    ? [
                        {
                          id: originalRunId,
                          status: "completed",
                          delegatedTaskId: originalTaskId,
                        },
                        {
                          id: followupRunId,
                          status: "queued",
                          queueHeld: true,
                          delegatedTaskId: followupTaskId,
                        },
                        {
                          id: unrelatedRunId,
                          status: "queued",
                          queueHeld: true,
                        },
                      ]
                    : [],
                contextTransfers: [],
              } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.stop") stoppedThreads.push(command.threadId);
                if (command.type === "queued-run.cancel") cancelledRuns.push(command.runId);
                return { sequence: stoppedThreads.length + cancelledRuns.length } as never;
              }),
          }),
          layerManagementDependencies(),
        ),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.stopDelegatedTasks({
      threadId: rootThreadId,
      commandId: CommandId.make("command:thread-management:dedup-stop"),
    });

    expect(stoppedThreads).toEqual([childThreadId, grandchildThreadId]);
    expect(cancelledRuns).toEqual([followupRunId]);
  }),
);
it.effect.each([
  {
    name: "releases the unresponsive thread's provider session",
    runStatus: "running" as const,
    turnStatus: "running" as const,
    otherThreads: [] as ReadonlyArray<ThreadId>,
    releaseResult: true,
    expectedOutcome: "released" as const,
    expectedDetaches: 0,
  },
  {
    name: "keeps a session shared with another working thread",
    runStatus: "running" as const,
    turnStatus: "running" as const,
    otherThreads: [ThreadId.make("thread:thread-management:force-stop-sibling")],
    releaseResult: true,
    expectedOutcome: "shared" as const,
    expectedDetaches: 1,
  },
  {
    name: "detaches when a sibling becomes busy before release",
    runStatus: "running" as const,
    turnStatus: "running" as const,
    otherThreads: [] as ReadonlyArray<ThreadId>,
    releaseResult: false,
    expectedOutcome: "shared" as const,
    expectedDetaches: 1,
  },
  {
    name: "settles a completed run's still-running background work",
    runStatus: "completed" as const,
    turnStatus: "completed" as const,
    otherThreads: [ThreadId.make("thread:thread-management:force-stop-sibling")],
    releaseResult: true,
    expectedOutcome: "shared" as const,
    expectedDetaches: 1,
  },
])("Force stop $name", (row) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:force-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:force-stop");
    const providerTurnId = "provider-turn:force-stop";
    const runId = RunId.make("run:thread-management:force-stop");
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const released: Array<ProviderSessionId> = [];
    const detached = yield* Deferred.make<void>();
    const detachCalls: Array<ThreadId> = [];
    const projection = {
      thread: { id: threadId, deletedAt: null },
      runs: [
        { id: runId, ordinal: 1, status: row.runStatus, activeAttemptId: "attempt" },
        { id: RunId.make("run:force-stop-queued"), ordinal: 2, status: "queued" },
      ],
      providerThreads: [{ id: providerThreadId, appThreadId: threadId, providerSessionId }],
      providerTurns: [
        {
          id: providerTurnId,
          providerThreadId,
          runAttemptId: "attempt",
          status: row.turnStatus,
        },
      ],
    } as never;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.succeed(projection),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1 } as never;
              }),
          }),
          layerManagementDependencies({
            sessionOverrides: {
              get: () => Effect.succeed(Option.some({} as never)),
              otherWorkingThreads: () => Effect.succeed(row.otherThreads),
              releaseUnlessBusy: ({ providerSessionId: releasedId }) =>
                Effect.sync(() => {
                  released.push(releasedId);
                  return row.releaseResult;
                }),
              detach: ({ threadId: detachedThreadId }) =>
                Effect.sync(() => {
                  detachCalls.push(detachedThreadId);
                }).pipe(Effect.andThen(Deferred.succeed(detached, undefined))),
            },
          }),
        ),
      ),
    );
    const result = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          const result = yield* service.forceStopThread({ threadId, runId });
          if (row.expectedDetaches > 0) yield* Deferred.await(detached);
          return result;
        }),
      ),
      Effect.provide(layerTest),
    );

    expect(result).toEqual({
      outcome: row.expectedOutcome,
      sharedWithThreadIds: row.otherThreads,
    });
    expect(dispatched).toMatchObject([
      {
        type: "thread.background-work.settle",
        threadId,
        providerThreadId,
        providerTurnId,
        reason: "Force stopped by user",
      },
    ]);
    expect(released).toEqual(row.otherThreads.length === 0 ? [providerSessionId] : []);
    expect(detachCalls).toEqual(Array.from({ length: row.expectedDetaches }, () => threadId));
  }),
);

it.effect("reports a provider session teardown that exceeds the wait as still releasing", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop-releasing");
    const runId = RunId.make("run:thread-management:force-stop-releasing");
    const providerSessionId = ProviderSessionId.make("provider-session:force-stop-releasing");
    const providerThreadId = ProviderThreadId.make("provider-thread:force-stop-releasing");
    const projection = {
      thread: { id: threadId, deletedAt: null },
      runs: [{ id: runId, ordinal: 1, status: "running", activeAttemptId: "attempt" }],
      providerThreads: [{ id: providerThreadId, appThreadId: threadId, providerSessionId }],
      providerTurns: [
        {
          id: "provider-turn:force-stop-releasing",
          providerThreadId,
          runAttemptId: "attempt",
          status: "running",
        },
      ],
    } as never;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.succeed(projection),
            dispatch: () => Effect.succeed({ sequence: 1 } as never),
          }),
          layerManagementDependencies({
            sessionOverrides: {
              get: () => Effect.succeed(Option.some({} as never)),
              otherWorkingThreads: () => Effect.succeed([]),
              releaseUnlessBusy: () => Effect.never,
            },
          }),
        ),
      ),
    );
    const stopping = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.flatMap((service) => service.forceStopThread({ threadId, runId })),
      Effect.provide(layerTest),
      Effect.forkChild,
    );
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(stopping)).toEqual({
      outcome: "releasing",
      sharedWithThreadIds: [],
    });
  }),
);

it.effect("Force stop refuses a superseded run before touching its provider session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop-superseded");
    const stoppedRunId = RunId.make("run:thread-management:force-stop-old");
    let releaseCalled = false;
    const projection = {
      thread: { id: threadId, deletedAt: null },
      runs: [
        { id: stoppedRunId, ordinal: 1, status: "running" },
        { id: RunId.make("run:thread-management:force-stop-new"), ordinal: 2, status: "running" },
      ],
      providerThreads: [],
      providerTurns: [],
    } as never;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.succeed(projection),
          }),
          layerManagementDependencies({
            sessionOverrides: {
              releaseUnlessBusy: () =>
                Effect.sync(() => {
                  releaseCalled = true;
                  return true;
                }),
            },
          }),
        ),
      ),
    );
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(service.forceStopThread({ threadId, runId: stoppedRunId }));
    }).pipe(Effect.provide(layerTest));

    expect(error.reason).toBe("superseded");
    expect(releaseCalled).toBe(false);
  }),
);
