import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventStore from "./EventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

type UnstampedEvent = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt">
    : never
  : never;

const realRecoveryStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  IdAllocator.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const realRecoveryLayer = ProviderRuntimeRecovery.layer.pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
        runRecoveryOnce: Effect.succeed(false),
      }),
      EventSink.layer.pipe(Layer.provideMerge(realRecoveryStores)),
    ),
  ),
);

it("leaves background work without a bound provider runtime untouched", async () => {
  const threadId = ThreadId.make("thread_recovery_background_no_provider_threads");
  const runId = RunId.make("run_recovery_background_no_provider_threads");
  const itemId = TurnItemId.make("turn_item_recovery_background_no_provider_threads");
  const providerInstanceId = ProviderInstanceId.make("codex");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "completed", providerInstanceId }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: itemId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
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
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
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

  await Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    expect(
      committedInput?.events.some((candidate) => candidate.type === "turn-item.updated") ?? false,
    ).toBe(false);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
it("repairs terminal children, interrupts lost owned async work, and preserves unbound imports", async () => {
  const threadId = ThreadId.make("thread_recovery_terminal_child_projection");
  const runId = RunId.make("run_recovery_terminal_child_projection");
  const providerThreadId = ProviderThreadId.make("provider_thread_recovery_terminal_child");
  const providerInstanceId = ProviderInstanceId.make("omp");
  const driver = ProviderDriverKind.make("omp");
  const projectId = ProjectId.make("project:recovery-terminal-child");
  const rootNodeId = NodeId.make("node:recovery-terminal-child-root");
  const now = DateTime.makeUnsafe("2026-11-10T09:30:00.000Z");
  const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
  const terminalChildren = [
    { name: "validation-failed", status: "failed" },
    { name: "validation-interrupted", status: "interrupted" },
    { name: "native-cancelled", status: "cancelled" },
  ] as const;
  const monitorNodeId = NodeId.make("node:recovery-terminal-monitor");
  const monitorItemId = TurnItemId.make("item:recovery-terminal-monitor");
  const liveChildId = NodeId.make("node:recovery-live-async-child");
  const liveParentNodeId = NodeId.make("node:recovery-live-async-parent");
  const liveParentItemId = TurnItemId.make("item:recovery-live-async-parent");
  const liveChildItemId = TurnItemId.make("item:recovery-live-async-child");
  const externalProviderThreadId = ProviderThreadId.make("provider_thread_external_import");
  const externalChildId = NodeId.make("node_external_import");
  const externalChildItemId = TurnItemId.make("item_external_import");
  const providerSessionId = ProviderSessionId.make("provider_session_recovery_terminal_child");
  const events: Array<OrchestrationV2DomainEvent> = [];
  let eventIndex = 0;
  const externalInstanceId = ProviderInstanceId.make("external-native-agent");
  const externalDriver = driver;
  const push = (event: UnstampedEvent) => {
    events.push({
      ...event,
      id: EventId.make(`event:recovery-terminal-child:${eventIndex++}`),
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  };
  const providerRef = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });

  push({
    type: "thread.created",
    threadId,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Terminal child recovery",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  push({
    type: "provider-session.attached",
    threadId,
    driver,
    providerInstanceId,
    payload: {
      id: providerSessionId,
      driver,
      providerInstanceId,
      status: "ready",
      cwd: "/workspace",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  push({
    type: "provider-thread.updated",
    threadId,
    driver,
    providerInstanceId,
    payload: {
      id: providerThreadId,
      appThreadId: threadId,
      ownerNodeId: null,
      driver,
      providerInstanceId,
      providerSessionId,
      nativeThreadRef: providerRef("native-recovery-thread"),
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      pendingBackgroundTasks: [
        { taskId: "omp:async:live-job", kind: "background_task", description: "Live task" },
      ],
    },
  });
  push({
    type: "run.created",
    threadId,
    runId,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("message:recovery-terminal-child"),
      rootNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  const node = (input: {
    readonly id: NodeId;
    readonly parentNodeId: NodeId | null;
    readonly kind: "root_turn" | "tool_call" | "subagent";
    readonly status: "completed" | "running";
    readonly nativeId: string | null;
    readonly providerThreadId?: ProviderThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
  }) =>
    push({
      type: "node.updated",
      threadId,
      runId,
      nodeId: input.id,
      providerInstanceId: input.providerInstanceId ?? providerInstanceId,
      payload: {
        id: input.id,
        threadId,
        runId,
        parentNodeId: input.parentNodeId,
        rootNodeId,
        kind: input.kind,
        status: input.status,
        countsForRun: input.kind === "root_turn",
        providerThreadId: input.providerThreadId ?? providerThreadId,
        providerTurnId: null,
        nativeItemRef: input.nativeId === null ? null : providerRef(input.nativeId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: input.status === "completed" ? now : null,
      },
    });
  node({
    id: rootNodeId,
    parentNodeId: null,
    kind: "root_turn",
    status: "completed",
    nativeId: null,
  });

  push({
    type: "provider-thread.updated",
    threadId,
    driver: externalDriver,
    providerInstanceId: externalInstanceId,
    payload: {
      id: externalProviderThreadId,
      appThreadId: threadId,
      ownerNodeId: null,
      driver: externalDriver,
      providerInstanceId: externalInstanceId,
      providerSessionId: null,
      nativeThreadRef: {
        driver: externalDriver,
        nativeId: "external-native-thread",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      pendingBackgroundTasks: [
        { taskId: "external-task", kind: "background_task", description: "External work" },
      ],
    },
  });
  node({
    id: externalChildId,
    parentNodeId: rootNodeId,
    kind: "subagent",
    status: "running",
    nativeId: "external-native-child",
    providerThreadId: externalProviderThreadId,
    providerInstanceId: externalInstanceId,
  });
  push({
    type: "subagent.updated",
    threadId,
    runId,
    nodeId: externalChildId,
    driver: externalDriver,
    providerInstanceId: externalInstanceId,
    payload: {
      id: externalChildId,
      threadId,
      runId,
      parentNodeId: rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: externalDriver,
      providerInstanceId: externalInstanceId,
      providerThreadId: externalProviderThreadId,
      childThreadId: null,
      nativeTaskRef: {
        driver: externalDriver,
        nativeId: "external-native-child",
        strength: "strong",
      },
      nativeAgentId: "external-task",
      prompt: "External work",
      title: "external-task",
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    },
  });
  push({
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: externalChildId,
    providerInstanceId: externalInstanceId,
    payload: {
      id: externalChildItemId,
      threadId,
      runId,
      nodeId: externalChildId,
      providerThreadId: externalProviderThreadId,
      providerTurnId: null,
      nativeItemRef: {
        driver: externalDriver,
        nativeId: "external-native-child",
        strength: "strong",
      },
      parentItemId: null,
      ordinal: 30,
      type: "subagent",
      status: "running",
      title: "external-task",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      subagentId: externalChildId,
      origin: "provider_native",
      driver: externalDriver,
      providerInstanceId: externalInstanceId,
      childThreadId: null,
      prompt: "External work",
      result: null,
    },
  });
  for (const [index, child] of terminalChildren.entries()) {
    const id = NodeId.make(`node:recovery-${child.name}`);
    const nativeId = `native-${child.name}`;
    node({ id, parentNodeId: rootNodeId, kind: "subagent", status: "running", nativeId });
    push({
      type: "subagent.updated",
      threadId,
      runId,
      nodeId: id,
      driver,
      providerInstanceId,
      payload: {
        id,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId,
        childThreadId: null,
        nativeTaskRef: providerRef(nativeId),
        prompt: `Inspect ${child.name}`,
        title: child.name,
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    });
    push({
      type: "turn-item.updated",
      threadId,
      runId,
      nodeId: id,
      providerInstanceId,
      payload: {
        id: TurnItemId.make(`item:recovery-${child.name}`),
        threadId,
        runId,
        nodeId: id,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: providerRef(nativeId),
        parentItemId: null,
        ordinal: index + 1,
        type: "subagent",
        status: child.status,
        title: child.name,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        subagentId: id,
        origin: "provider_native",
        driver,
        providerInstanceId,
        childThreadId: null,
        prompt: `Inspect ${child.name}`,
        result: null,
      },
    });
  }
  node({
    id: monitorNodeId,
    parentNodeId: rootNodeId,
    kind: "tool_call",
    status: "running",
    nativeId: "native-terminal-monitor",
  });
  push({
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: monitorNodeId,
    providerInstanceId,
    payload: {
      id: monitorItemId,
      threadId,
      runId,
      nodeId: monitorNodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: providerRef("native-terminal-monitor"),
      parentItemId: null,
      ordinal: 4,
      type: "dynamic_tool",
      status: "completed",
      title: "Persistent monitor",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      toolName: "grok.monitor",
      input: { persistent: true, command: "watch task" },
      output: "finished",
      details: {},
    },
  });

  node({
    id: liveParentNodeId,
    parentNodeId: rootNodeId,
    kind: "tool_call",
    status: "completed",
    nativeId: "native-live-parent",
  });
  node({
    id: liveChildId,
    parentNodeId: liveParentNodeId,
    kind: "subagent",
    status: "running",
    nativeId: "native-live-child",
  });
  push({
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: liveParentNodeId,
    providerInstanceId,
    payload: {
      id: liveParentItemId,
      threadId,
      runId,
      nodeId: liveParentNodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: providerRef("native-live-parent"),
      parentItemId: null,
      ordinal: 10,
      type: "dynamic_tool",
      status: "completed",
      title: "task",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      toolName: "task",
      input: { tasks: [{ id: "live-job", task: "continue working" }] },
      output: "Spawned background task",
      details: { async: { state: "running", jobId: "live-job", type: "task" } },
    },
  });
  push({
    type: "subagent.updated",
    threadId,
    runId,
    nodeId: liveChildId,
    driver,
    providerInstanceId,
    payload: {
      id: liveChildId,
      threadId,
      runId,
      parentNodeId: liveParentNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId,
      childThreadId: null,
      nativeTaskRef: providerRef("native-live-child"),
      nativeAgentId: "live-job",
      prompt: "continue working",
      title: "live-job",
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    },
  });
  push({
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: liveChildId,
    providerInstanceId,
    payload: {
      id: liveChildItemId,
      threadId,
      runId,
      nodeId: liveChildId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: providerRef("native-live-child"),
      parentItemId: liveParentItemId,
      ordinal: 11,
      type: "subagent",
      status: "running",
      title: "live-job",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      subagentId: liveChildId,
      origin: "provider_native",
      driver,
      providerInstanceId,
      childThreadId: null,
      prompt: "continue working",
      result: null,
    },
  });

  await Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    yield* eventSink.write({ events });
    const beforeRecoverySequence = yield* eventStore.latestSequence({ threadId });

    yield* recovery.reconcile("startup");

    const firstRecoverySequence = yield* eventStore.latestSequence({ threadId });
    expect(firstRecoverySequence).toBeGreaterThan(beforeRecoverySequence);
    const afterRecovery = yield* projections.getThreadProjection(threadId);
    for (const child of terminalChildren) {
      const id = NodeId.make(`node:recovery-${child.name}`);
      const item = afterRecovery.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === id,
      );
      const subagent = afterRecovery.subagents.find((candidate) => candidate.id === id);
      const childNode = afterRecovery.nodes.find((candidate) => candidate.id === id);
      expect(item?.type === "subagent" ? item.status : null).toBe(child.status);
      expect(subagent?.status).toBe(child.status);
      expect(childNode?.status).toBe(child.status);
      const expectedCompletedAt =
        item?.type === "subagent" && item.completedAt !== null
          ? DateTime.toEpochMillis(item.completedAt)
          : null;
      const actualCompletedAt =
        subagent?.completedAt == null ? null : DateTime.toEpochMillis(subagent.completedAt);
      expect(actualCompletedAt).toBe(expectedCompletedAt);
      expect(subagent?.updatedAt == null ? null : DateTime.toEpochMillis(subagent.updatedAt)).toBe(
        item?.type === "subagent" ? DateTime.toEpochMillis(item.updatedAt) : null,
      );
      expect(
        childNode?.completedAt == null ? null : DateTime.toEpochMillis(childNode.completedAt),
      ).toBe(expectedCompletedAt);
    }
    expect(
      afterRecovery.turnItems.find((candidate) => candidate.id === monitorItemId)?.status,
    ).toBe("completed");
    expect(afterRecovery.nodes.find((candidate) => candidate.id === monitorNodeId)?.status).toBe(
      "completed",
    );
    const recoveredProviderThread = afterRecovery.providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    );
    expect(recoveredProviderThread?.status).toBe("idle");
    expect(recoveredProviderThread?.pendingBackgroundTasks).toEqual([]);
    expect(
      afterRecovery.turnItems.find((candidate) => candidate.id === liveChildItemId)?.status,
    ).toBe("interrupted");
    expect(afterRecovery.subagents.find((candidate) => candidate.id === liveChildId)?.status).toBe(
      "interrupted",
    );
    expect(afterRecovery.nodes.find((candidate) => candidate.id === liveChildId)?.status).toBe(
      "interrupted",
    );
    expect(
      afterRecovery.providerThreads.find((candidate) => candidate.id === externalProviderThreadId),
    ).toMatchObject({
      status: "active",
      pendingBackgroundTasks: [{ taskId: "external-task" }],
    });
    expect(
      afterRecovery.turnItems.find((candidate) => candidate.id === externalChildItemId)?.status,
    ).toBe("running");
    expect(
      afterRecovery.subagents.find((candidate) => candidate.id === externalChildId)?.status,
    ).toBe("running");
    expect(afterRecovery.nodes.find((candidate) => candidate.id === externalChildId)?.status).toBe(
      "running",
    );

    yield* recovery.reconcile("startup");
    expect(yield* eventStore.latestSequence({ threadId })).toBe(firstRecoverySequence);
  }).pipe(Effect.provide(realRecoveryLayer), Effect.runPromise);
});
