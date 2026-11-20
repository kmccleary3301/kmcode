import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  describeAntigravitySubagentLaunches,
} from "../provider/acp/AntigravityChildWork.ts";
import {
  CHILD,
  invokeStep,
  LAUNCH,
  makeProfile,
  ROOT,
} from "../provider/acp/AntigravityChildWork.testkit.ts";
import * as NativeChildWorkQuery from "./NativeChildWorkQuery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const parentThreadId = ThreadId.make("thread-parent");
const childThreadId = ThreadId.make("thread-child");
const oldChildThreadId = ThreadId.make("thread-old");
const driver = ProviderDriverKind.make("antigravity");
const now = DateTime.makeUnsafe("2026-11-19T00:00:00.000Z");
const modelSelection = { instanceId, model: "test-model" };
const rootRunId = RunId.make("run-root");
const earlierRunId = RunId.make("run-root-earlier");
const otherRunId = RunId.make("run-other");
const rootProviderThreadId = ProviderThreadId.make("provider-root");
const otherProviderThreadId = ProviderThreadId.make("provider-other");
const nativeTaskId = "35bea692fa95447fbdae6333fec5515f";
const subagentNodeId = NodeId.make("subagent-new");
const launch = describeAntigravitySubagentLaunches([LAUNCH]);

const appThread = (input: {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly relationshipToParent: "subagent" | null;
  readonly forkedFrom: OrchestrationV2AppThread["forkedFrom"];
  readonly createdBy: OrchestrationV2AppThread["createdBy"];
  readonly creationSource: OrchestrationV2AppThread["creationSource"];
}): OrchestrationV2AppThread => ({
  createdBy: input.createdBy,
  creationSource: input.creationSource,
  id: input.id,
  projectId: ProjectId.make("project-native-child-work"),
  title: "Child work test",
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: input.parentThreadId,
    relationshipToParent: input.relationshipToParent,
    rootThreadId: input.parentThreadId ?? input.id,
  },
  forkedFrom: input.forkedFrom,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const childThread = appThread({
  id: childThreadId,
  parentThreadId,
  relationshipToParent: "subagent",
  forkedFrom: { type: "node", nodeId: subagentNodeId },
  createdBy: "agent",
  creationSource: "provider",
});

const providerThread = (id: ProviderThreadId, nativeId: string): OrchestrationV2ProviderThread => ({
  id,
  driver,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: parentThreadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: now,
  updatedAt: now,
});

const run = (input: {
  readonly id: RunId;
  readonly providerThreadId: ProviderThreadId;
}): OrchestrationV2Run => ({
  id: input.id,
  threadId: parentThreadId,
  ordinal: input.id === rootRunId ? 1 : 2,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: input.providerThreadId,
  userMessageId: MessageId.make(`message-${input.id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});

const subagent = (input: {
  readonly id: NodeId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly taskId: string;
  readonly title: string | null;
  readonly prompt: string;
}): OrchestrationV2Subagent => ({
  id: input.id,
  threadId: parentThreadId,
  runId: input.runId,
  parentNodeId: NodeId.make("parent-node"),
  origin: "provider_native",
  createdBy: "agent",
  driver,
  providerInstanceId: instanceId,
  providerThreadId: rootProviderThreadId,
  childThreadId: input.childThreadId,
  nativeTaskRef: { driver, nativeId: input.taskId, strength: "strong" },
  prompt: input.prompt,
  title: input.title,
  model: null,
  status: "running",
  result: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
});

const records = (olderRun: RunId): OrchestrationV2ThreadProjection => ({
  thread: childThread,
  subagents: [
    subagent({
      id: subagentNodeId,
      childThreadId,
      runId: rootRunId,
      taskId: nativeTaskId,
      title: launch.title,
      prompt: launch.prompt,
    }),
    subagent({
      id: NodeId.make("subagent-old"),
      childThreadId: oldChildThreadId,
      runId: olderRun,
      taskId: "0ld",
      title: ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
      prompt: "Running",
    }),
  ],
  runs: [
    run({ id: rootRunId, providerThreadId: rootProviderThreadId }),
    run({ id: earlierRunId, providerThreadId: rootProviderThreadId }),
    run({ id: otherRunId, providerThreadId: otherProviderThreadId }),
  ],
  providerThreads: [
    providerThread(rootProviderThreadId, ROOT),
    providerThread(otherProviderThreadId, "00000000-0000-4000-8000-000000000000"),
  ],
  attempts: [],
  nodes: [],
  providerSessions: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});

const readChildren = (olderRun: RunId) =>
  Effect.gen(function* () {
    const query = yield* NativeChildWorkQuery.NativeChildWorkQuery;
    return (yield* query.getNativeChildWork({ threadId: childThreadId })).children;
  }).pipe(
    Effect.provide(
      NativeChildWorkQuery.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(records(olderRun)),
          }),
        ),
      ),
    ),
  );

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "native-child-work-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
)("NativeChildWorkQuery", (it) => {
  it.effect("weighs only batches from the same agent session", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const { profile } = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId);
      yield* makeProfile({
        profile,
        steps: (logUri) => [
          [
            2,
            127,
            invokeStep({ callId: "x", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
        ],
      });
      const fromOtherSession = yield* readChildren(otherRunId);
      expect(fromOtherSession.map((child) => child.conversationId)).toEqual([CHILD]);
      // An earlier run in the same session may own the only record.
      expect(yield* readChildren(earlierRunId)).toEqual([]);
    }),
  );
});
