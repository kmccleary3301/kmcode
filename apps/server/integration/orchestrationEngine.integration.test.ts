// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  ApprovalRequestId,
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  gitRefExists,
  gitShowFileAtRef,
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import {
  configuredNativeLiveConfigurations,
  enableNativeLiveCompaction,
  exerciseNativeLiveQueueModes,
  makeNativeLiveAgentDirectory,
  makeNativeLiveModelServer,
  makeNativeLiveTraceSinkFactory,
  nativeLiveTraceSinkFactory,
  writeNativeCrashWrapper,
  writeNativeLiveConfig,
  writeNativeLiveExtension,
  type NativeLiveConfig,
  type NativeLiveCapabilityObservation,
} from "./NativeLiveRuntime.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);

const PROJECT_ID = asProjectId("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const FIXTURE_TURN_ID = "fixture-turn";
const APPROVAL_REQUEST_ID = asApprovalRequestId("req-approval-1");
type IntegrationProvider = ProviderDriverKind;
const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");

function nowIso() {
  return "2026-05-01T00:00:00.000Z";
}

class IntegrationWaitTimeoutError extends Schema.TaggedError<IntegrationWaitTimeoutError>()(
  "IntegrationWaitTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitForSync<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<A, never> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;

    while (true) {
      const value = read();
      if (predicate(value)) {
        return value;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new IntegrationWaitTimeoutError({ description }));
      }
      yield* Effect.sleep(10);
    }
  });
}

function runtimeBase(
  eventId: string,
  createdAt: string,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function withRealCodexHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_PROVIDER, realCodex: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? CODEX_PROVIDER;
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const instanceId = defaultInstanceIdForDriver(provider);

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: {
        instanceId,
        model: defaultModel,
      },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Integration Thread",
      modelSelection: {
        instanceId,
        model: defaultModel,
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
  readonly createdAt?: string;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: input.modelSelection,
        }
      : {}),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: input.createdAt ?? nowIso(),
  });

it.live("runs a single turn end-to-end and persists checkpoint state in sqlite + git", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });
      const finalizedReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );
      if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(finalizedReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ) &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.checkpoints[0]?.status, "ready");
      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.deepEqual(thread.checkpoints[0]?.files, []);

      const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
      const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
      assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
      assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
    }),
  ),
);

it.live.skipIf(!process.env.CODEX_BINARY_PATH)(
  "keeps the same Codex provider thread across runtime mode switches",
  () =>
    withRealCodexHarness((harness) =>
      Effect.gen(function* () {
        const createdAt = nowIso();

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-real-codex"),
          projectId: PROJECT_ID,
          title: "Integration Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-real-codex"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Integration Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-real-codex-1"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-1"),
            role: "user",
            text: "Reply with exactly ALPHA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: nowIso(),
        });

        const firstThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.streaming === false,
            ),
          180_000,
        );
        assert.equal(firstThread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-real-codex-2"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-2"),
            role: "user",
            text: "Reply with exactly BETA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const secondThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.session.runtimeMode === "approval-required" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text.includes("BETA"),
            ),
          180_000,
        );
        assert.equal(secondThread.session?.threadId, "thread-1");
      }),
    ),
);

it.live("runs multi-turn file edits and persists checkpoint diffs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-1", "2026-02-24T10:01:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-multi-2", "2026-02-24T10:01:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-multi-3", "2026-02-24T10:01:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-4", "2026-02-24T10:01:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-5", "2026-02-24T10:01:00.400Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-1",
        messageId: "msg-user-multi-1",
        text: "Make first edit",
      });
      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.checkpoints.length === 1 && entry.session?.threadId === "thread-1",
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-6", "2026-02-24T10:02:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-7", "2026-02-24T10:02:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-8", "2026-02-24T10:02:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-2",
        messageId: "msg-user-multi-2",
        text: "Make second edit",
      });
      const secondReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );
      if (secondReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(secondReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      const secondTurnThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 2),
      );
      const secondCheckpoint = secondTurnThread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === 2,
      );
      assert.equal(
        secondCheckpoint?.files.some((file) => file.path === "README.md"),
        true,
      );

      assert.deepEqual(
        secondTurnThread.checkpoints.map((row) => row.checkpointTurnCount),
        [1, 2],
      );

      const incrementalDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 1),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });
      assert.equal(incrementalDiff.includes("README.md"), true);

      const fullDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 0),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });
      assert.equal(fullDiff.includes("README.md"), true);

      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 1),
          "README.md",
        ),
        "v2\n",
      );
      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 2),
          "README.md",
        ),
        "v3\n",
      );
    }),
  ),
);

it.live("tracks approval requests and resolves pending approvals on user response", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-approval-1", "2026-02-24T10:03:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "approval.requested",
            ...runtimeBase("evt-approval-2", "2026-02-24T10:03:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            requestId: APPROVAL_REQUEST_ID,
            requestKind: "command",
            detail: "Approve command execution",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-approval-3", "2026-02-24T10:03:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-approval",
        messageId: "msg-user-approval",
        text: "Run command needing approval",
      });

      const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
        entry.activities.some((activity) => activity.kind === "approval.requested"),
      );
      assert.equal(
        thread.activities.some((activity) => activity.kind === "approval.requested"),
        true,
      );

      const pendingRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "pending" && row.decision === null,
      );
      assert.equal(pendingRow.status, "pending");

      yield* harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: THREAD_ID,
        requestId: APPROVAL_REQUEST_ID,
        decision: "accept",
        createdAt: nowIso(),
      });

      const resolvedRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "resolved" && row.decision === "accept",
      );
      assert.equal(resolvedRow.status, "resolved");
      assert.equal(resolvedRow.decision, "accept");

      const approvalResponses = yield* waitForSync(
        () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
        (responses) => responses.length === 1,
        "provider approval response",
      );
      assert.equal(approvalResponses.length, 1);
      assert.equal(approvalResponses[0]?.requestId, "req-approval-1");
      assert.equal(approvalResponses[0]?.decision, "accept");
    }),
  ),
);

it.live("records failed turn runtime state and checkpoint status as error", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-failure-1", "2026-02-24T10:04:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "content.delta",
            ...runtimeBase("evt-failure-2", "2026-02-24T10:04:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              streamKind: "assistant_text",
              delta: "Partial output before failure.\n",
            },
          },
          {
            type: "runtime.error",
            ...runtimeBase("evt-failure-3", "2026-02-24T10:04:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              message: "Sandbox command failed.",
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-failure-4", "2026-02-24T10:04:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              state: "failed",
              errorMessage: "Sandbox command failed.",
            },
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-failure",
        messageId: "msg-user-failure",
        text: "Run risky command",
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.lastError === "Sandbox command failed." &&
          entry.activities.some((activity) => activity.kind === "runtime.error") &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.session?.status, "error");
      assert.equal(thread.checkpoints[0]?.status, "error");

      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
        true,
      );
    }),
  ),
);

it.live("reverts to an earlier checkpoint and trims checkpoint projections + git refs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-1", "2026-02-24T10:05:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-1-tool-started", "2026-02-24T10:05:00.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-1-tool-completed", "2026-02-24T10:05:00.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-1a", "2026-02-24T10:05:00.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-2", "2026-02-24T10:05:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-1",
        messageId: "msg-user-revert-1",
        text: "First edit",
        createdAt: "2026-02-24T10:04:59.900Z",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.threadId === "thread-1" && entry.checkpoints.length === 1,
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-3", "2026-02-24T10:05:01.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-3-tool-started", "2026-02-24T10:05:01.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-3-tool-completed", "2026-02-24T10:05:01.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-3a", "2026-02-24T10:05:01.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-4", "2026-02-24T10:05:01.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-2",
        messageId: "msg-user-revert-2",
        text: "Second edit",
        createdAt: "2026-02-24T10:05:00.900Z",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.activities.some((activity) => activity.turnId === "turn-2"),
        8000,
      );

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-checkpoint-revert"),
        threadId: THREAD_ID,
        turnCount: 1,
        createdAt: nowIso(),
      });

      yield* harness.waitForDomainEvent((event) => event.type === "thread.reverted");
      const revertedThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
      );
      assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.deepEqual(
        revertedThread.messages.map((message) => ({ role: message.role, text: message.text })),
        [
          { role: "user", text: "First edit" },
          { role: "assistant", text: "Updated README to v2.\n" },
        ],
      );
      assert.equal(
        revertedThread.activities.some((activity) => activity.turnId === "turn-2"),
        false,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.started",
        ),
        true,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.completed",
        ),
        true,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(harness.workspaceDir, "README.md"), "utf8"),
        "v2\n",
      );
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
        false,
      );
      assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);
    }),
  ),
);

it.live(
  "appends checkpoint.revert.failed activity when revert is requested without a provider binding",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-no-session"),
          threadId: THREAD_ID,
          turnCount: 0,
          createdAt: nowIso(),
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some(
            (activity) =>
              activity.kind === "checkpoint.revert.failed" &&
              typeof activity.payload === "object" &&
              activity.payload !== null,
          ),
        );
        const failureActivity = thread.activities.find(
          (activity) => activity.kind === "checkpoint.revert.failed",
        );
        assert.equal(failureActivity !== undefined, true);
        assert.equal(
          String(
            (failureActivity?.payload as { readonly detail?: string } | undefined)?.detail,
          ).includes("no persisted provider binding exists"),
          true,
        );
      }),
    ),
);

it.live("starts a claudeAgent session on first turn when provider is requested", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-start-1",
                "2026-02-24T10:10:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-start-2",
                "2026-02-24T10:10:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Claude first turn.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-start-3",
                "2026-02-24T10:10:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-initial",
          messageId: "msg-user-claude-initial",
          text: "Use Claude",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.session.status === "ready" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text === "Claude first turn.\n",
            ),
        );
        assert.equal(thread.session?.providerName, "claudeAgent");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("recovers claudeAgent sessions after provider stopAll using persisted resume state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-recover-1",
                "2026-02-24T10:11:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-recover-2",
                "2026-02-24T10:11:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn before restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-recover-3",
                "2026-02-24T10:11:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-1",
          messageId: "msg-user-claude-recover-1",
          text: "Before restart",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.adapter.stopAll();
        yield* waitForSync(
          () => harness.adapterHarness!.listActiveSessionIds(),
          (sessionIds) => sessionIds.length === 0,
          "provider stopAll",
        );

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-recover-4",
                "2026-02-24T10:11:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-recover-5",
                "2026-02-24T10:11:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn after restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-recover-6",
                "2026-02-24T10:11:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-2",
          messageId: "msg-user-claude-recover-2",
          text: "After restart",
        });
        yield* waitForSync(
          () => harness.adapterHarness!.getStartCount(),
          (count) => count === 2,
          "claude provider recovery start",
        );

        const recoveredThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.messages.some(
              (message) => message.role === "user" && message.text === "After restart",
            ) &&
            !entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        assert.equal(recoveredThread.session?.providerName, "claudeAgent");
        assert.equal(recoveredThread.session?.threadId, "thread-1");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);
it.live("reprojects persisted events after a server restart", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const beforeRestart = yield* harness.waitForThread(
        THREAD_ID,
        (thread) => thread.title === "Integration Thread",
      );
      const rootDir = harness.rootDir;
      yield* harness.dispose;

      const database = new NodeSqlite.DatabaseSync(harness.dbPath);
      try {
        database.exec(`
          DELETE FROM projection_thread_messages;
          DELETE FROM projection_thread_activities;
          DELETE FROM projection_thread_proposed_plans;
          DELETE FROM projection_thread_sessions;
          DELETE FROM projection_turns;
          DELETE FROM projection_pending_approvals;
          DELETE FROM projection_threads;
          DELETE FROM projection_projects;
          DELETE FROM projection_state;
        `);
      } finally {
        database.close();
      }

      yield* Effect.scoped(
        Effect.acquireUseRelease(
          makeOrchestrationIntegrationHarness({
            provider: CODEX_PROVIDER,
            rootDir,
          }).pipe(Effect.provide(NodeServices.layer)),
          (restarted) =>
            Effect.gen(function* () {
              const afterRestart = yield* restarted.waitForThread(
                THREAD_ID,
                (thread) => thread.title === "Integration Thread",
              );
              assert.deepEqual(afterRestart, beforeRestart);
            }),
          (restarted) => restarted.dispose.pipe(Effect.orDie),
        ),
      );
    }),
  ),
);

it.live("forwards claudeAgent approval responses to the provider session", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-approval-1",
                "2026-02-24T10:12:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "approval.requested",
              ...runtimeBase(
                "evt-claude-approval-2",
                "2026-02-24T10:12:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              requestId: APPROVAL_REQUEST_ID,
              requestKind: "command",
              detail: "Approve Claude tool call",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-approval-3",
                "2026-02-24T10:12:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-approval",
          messageId: "msg-user-claude-approval",
          text: "Need approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "approval.requested"),
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-claude-approval-respond"),
          threadId: THREAD_ID,
          requestId: APPROVAL_REQUEST_ID,
          decision: "accept",
          createdAt: nowIso(),
        });

        yield* harness.waitForPendingApproval(
          "req-approval-1",
          (row) => row.status === "resolved" && row.decision === "accept",
        );

        const approvalResponses = yield* waitForSync(
          () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
          (responses) => responses.length === 1,
          "claude provider approval response",
        );
        assert.equal(approvalResponses[0]?.decision, "accept");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("forwards thread.turn.interrupt to claudeAgent provider sessions", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-interrupt-1",
                "2026-02-24T10:13:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-interrupt-2",
                "2026-02-24T10:13:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Long running output.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-interrupt-3",
                "2026-02-24T10:13:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-interrupt",
          messageId: "msg-user-claude-interrupt",
          text: "Start long turn",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.session?.threadId === "thread-1",
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-claude"),
          threadId: THREAD_ID,
          createdAt: nowIso(),
        });
        yield* harness.waitForDomainEvent(
          (event) => event.type === "thread.turn-interrupt-requested",
        );

        const interruptCalls = yield* waitForSync(
          () => harness.adapterHarness!.getInterruptCalls(THREAD_ID),
          (calls) => calls.length === 1,
          "claude provider interrupt call",
        );
        assert.equal(interruptCalls.length, 1);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("reverts claudeAgent turns and rolls back provider conversation state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-1",
                "2026-02-24T10:14:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-2",
                "2026-02-24T10:14:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v2\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-3",
                "2026-02-24T10:14:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-1",
          messageId: "msg-user-claude-revert-1",
          text: "First Claude edit",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-4",
                "2026-02-24T10:14:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-5",
                "2026-02-24T10:14:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v3\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-6",
                "2026-02-24T10:14:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-2",
          messageId: "msg-user-claude-revert-2",
          text: "Second Claude edit",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-2" &&
            entry.checkpoints.length === 2 &&
            entry.session?.providerName === "claudeAgent",
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-claude"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: nowIso(),
        });

        const revertedThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
        );
        assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
          true,
        );
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
          false,
        );
        assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

const runNativeMatrix = (config: NativeLiveConfig) =>
  Effect.acquireUseRelease(
    makeNativeLiveModelServer,
    (modelServer) =>
      Effect.acquireUseRelease(
        makeNativeLiveAgentDirectory("t3-native-matrix-"),
        (agentDirectory) =>
          Effect.gen(function* () {
            yield* writeNativeLiveConfig(config, agentDirectory, modelServer);
            const queueObservation = yield* exerciseNativeLiveQueueModes(config, agentDirectory);
            assert.include(queueObservation.responseCommands, "steer");
            assert.include(queueObservation.responseCommands, "follow_up");
            if (config.runtime === "pi") {
              assert.isAtLeast(
                queueObservation.frameTypes.filter((type) => type === "queue_update").length,
                2,
              );
            } else {
              assert.include(queueObservation.frameTypes, "agent_end");
              assert.include(queueObservation.responseCommands, "branch");
              assert.include(queueObservation.responseCommands, "switch_session");
              assert.include(queueObservation.responseCommands, "compact");
              if (queueObservation.responseCommands.includes("get_subagents")) {
                assert.isAtLeast(
                  queueObservation.subagentStatuses.filter((status) => status === "started").length,
                  1,
                );
                assert.include(queueObservation.frameTypes, "subagent:tool_execution_update:task");
              }
              assert.isDefined(queueObservation.compaction);
              assert.isAtLeast(queueObservation.compaction?.tokensBefore ?? -1, 0);
              assert.isAbove(queueObservation.compaction?.summaryLength ?? 0, 0);
              assert.isNotEmpty(queueObservation.compaction?.firstKeptEntryId);
              assert.equal(queueObservation.compactionPersisted, true);
              assert.equal(queueObservation.processExited, true);
              const cancellation = queueObservation.taskCancellation;
              if (cancellation === undefined) {
                assert.notInclude(queueObservation.responseCommands, "cancel_task");
              } else {
                assert.include(queueObservation.responseCommands, "cancel_task");
                assert.notEqual(cancellation.parentTaskId, cancellation.nestedTaskId);
                assert.equal(cancellation.detached, true);
                assert.equal(cancellation.terminalStatus, "aborted");
                assert.isNotEmpty(cancellation.runId);
              }
            }
            const extensionPath = yield* writeNativeLiveExtension(agentDirectory);
            const capabilityObservation: NativeLiveCapabilityObservation = {
              responseCommands: [],
              frameTypes: [],
              stdinFrameTypes: [],
              uiRequests: [],
            };
            yield* Effect.acquireUseRelease(
              makeOrchestrationIntegrationHarness({
                provider: config.provider,
                nativeLive: {
                  runtime: config.runtime,
                  binaryPath: config.binaryPath,
                  launchArguments: [...config.launchArguments, "--extension", extensionPath],
                  agentDirectory,
                  environment: { PI_OFFLINE: "1", PI_NO_PTY: "1" },
                  ...(config.trustMode === undefined ? {} : { trustMode: config.trustMode }),
                  traceSinkFactory: makeNativeLiveTraceSinkFactory(capabilityObservation),
                },
              }),
              (harness) =>
                Effect.gen(function* () {
                  const projectId = ProjectId.make(`native-matrix-${config.runtime}-project`);
                  const threadId = ThreadId.make(`native-matrix-${config.runtime}-thread`);
                  const instanceId = ProviderInstanceId.make(config.runtime);
                  const modelSelection: ModelSelection = {
                    instanceId,
                    model: "local/test",
                  };
                  const createdAt = "2026-08-23T00:00:00.000Z";
                  yield* harness.engine.dispatch({
                    type: "project.create",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:project-create`),
                    projectId,
                    title: `${config.runtime} native matrix project`,
                    workspaceRoot: harness.workspaceDir,
                    defaultModelSelection: modelSelection,
                    createdAt,
                  });
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:thread-create`),
                    threadId,
                    projectId,
                    title: `${config.runtime} native matrix thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });
                  const turnCreatedAt = (ordinal: number) =>
                    `2026-08-23T00:00:${String(ordinal).padStart(2, "0")}.000Z`;
                  const startTurn = (
                    ordinal: number,
                    text: string,
                    targetThreadId = threadId,
                    options?: {
                      readonly attachments?: ReadonlyArray<ChatAttachment>;
                      readonly modelSelection?: ModelSelection;
                    },
                  ) =>
                    harness.engine.dispatch({
                      type: "thread.turn.start",
                      commandId: CommandId.make(`native-matrix:${config.runtime}:turn:${ordinal}`),
                      threadId: targetThreadId,
                      message: {
                        messageId: MessageId.make(
                          `native-matrix-${config.runtime}-user-${ordinal}`,
                        ),
                        role: "user",
                        text,
                        attachments: options?.attachments ?? [],
                      },
                      modelSelection: options?.modelSelection ?? modelSelection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      createdAt: turnCreatedAt(ordinal),
                    });
                  const startAndWaitForCompleted = (
                    ordinal: number,
                    messageText: string,
                    assistantMarker: string,
                    description: string,
                    targetThreadId = threadId,
                    options?: {
                      readonly attachments?: ReadonlyArray<ChatAttachment>;
                      readonly modelSelection?: ModelSelection;
                    },
                  ) =>
                    Effect.gen(function* () {
                      const before = yield* harness.waitForThread(
                        targetThreadId,
                        () => true,
                        10_000,
                      );
                      const assistantCountBefore = before.messages.filter(
                        (message) =>
                          message.role === "assistant" &&
                          !message.streaming &&
                          message.text.includes(assistantMarker),
                      ).length;
                      const completedFiber = yield* harness.providerService.streamEvents.pipe(
                        Stream.filter(
                          (event) =>
                            event.threadId === targetThreadId && event.type === "turn.completed",
                        ),
                        Stream.runHead,
                        Effect.forkChild,
                      );
                      yield* startTurn(ordinal, messageText, targetThreadId, options);
                      const completed = yield* Fiber.join(completedFiber).pipe(
                        Effect.timeout("30 seconds"),
                      );
                      assert.equal(
                        completed._tag,
                        "Some",
                        `${config.runtime} native turn did not complete`,
                      );
                      if (completed._tag !== "Some" || completed.value.type !== "turn.completed") {
                        return yield* Effect.die("Native matrix turn did not complete.");
                      }
                      assert.equal(completed.value.payload.state, "completed");
                      const thread = yield* harness.waitForThread(
                        targetThreadId,
                        (entry) =>
                          entry.latestTurn?.state === "completed" &&
                          entry.session?.status === "ready" &&
                          entry.messages.some(
                            (message) => message.role === "user" && message.text === messageText,
                          ) &&
                          entry.messages.filter(
                            (message) =>
                              message.role === "assistant" &&
                              !message.streaming &&
                              message.text.includes(assistantMarker),
                          ).length > assistantCountBefore,
                        30_000,
                      );
                      yield* Effect.logInfo(description);
                      return thread;
                    });
                  const waitForNativeProcessExit = (targetThreadId = threadId) =>
                    Effect.gen(function* () {
                      const deadline = (yield* Clock.currentTimeMillis) + 30_000;
                      while (true) {
                        const sessions = yield* harness.providerService.listSessions();
                        if (!sessions.some((session) => session.threadId === targetThreadId)) {
                          return;
                        }
                        if ((yield* Clock.currentTimeMillis) >= deadline) {
                          return yield* Effect.die(
                            new IntegrationWaitTimeoutError({
                              description: `${config.runtime} native process exit`,
                            }),
                          );
                        }
                        yield* Effect.sleep(10);
                      }
                    });

                  const firstMessage = "Reply with the native matrix marker.";
                  const first = yield* startAndWaitForCompleted(
                    1,
                    firstMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} native root turn`,
                  );
                  assert.equal(first.session?.providerName, config.runtime);
                  assert.isAbove(modelServer.requestCount(), 0);
                  assert.isTrue(
                    first.messages.some(
                      (message) => message.text.includes("NATIVE-MATRIX-OK") && !message.streaming,
                    ),
                  );
                  assert.isTrue(
                    capabilityObservation.responseCommands.includes("get_capabilities"),
                    `${config.runtime} did not negotiate capabilities`,
                  );
                  if (
                    config.runtime === "omp" &&
                    capabilityObservation.capabilities !== undefined
                  ) {
                    const capabilities = capabilityObservation.capabilities;
                    const sessions = capabilities.sessions as
                      | Readonly<Record<string, unknown>>
                      | undefined;
                    const tasks = capabilities.tasks as
                      | Readonly<Record<string, unknown>>
                      | undefined;
                    const ui = capabilities.ui as Readonly<Record<string, unknown>> | undefined;
                    assert.equal(sessions?.resume, true);
                    assert.equal(sessions?.fork, true);
                    assert.equal(sessions?.compact, true);
                    assert.equal(tasks?.nested, true);
                    assert.equal(tasks?.background, true);
                    assert.equal(ui?.arbitraryTerminalComponents, false);
                    assert.equal(ui?.openUrl, false);
                  } else if (config.runtime === "omp") {
                    assert.include(
                      capabilityObservation.responseCommands,
                      "set_subagent_subscription",
                    );
                  }

                  const nativeToolCompletedFiber = yield* harness.providerService.streamEvents.pipe(
                    Stream.filter(
                      (event) =>
                        event.threadId === threadId &&
                        event.type === "item.completed" &&
                        JSON.stringify(event.payload).includes("NATIVE-MATRIX-TOOL-OK"),
                    ),
                    Stream.runHead,
                    Effect.forkChild,
                  );
                  yield* startAndWaitForCompleted(
                    9,
                    "NATIVE-MATRIX-TOOL: run the local bash command and return its marker.",
                    "NATIVE-MATRIX-TOOL-OK",
                    `${config.runtime} native local tool execution`,
                  );
                  const nativeToolCompleted = yield* Fiber.join(nativeToolCompletedFiber).pipe(
                    Effect.timeout("20 seconds"),
                  );
                  assert.equal(nativeToolCompleted._tag, "Some");
                  if (nativeToolCompleted._tag !== "Some") {
                    return yield* Effect.die("Native tool completion was not projected.");
                  }
                  // @effect-diagnostics-next-line preferSchemaOverJson:off - Marker-only test payload inspection.
                  const nativeToolPayload = JSON.stringify(nativeToolCompleted.value.payload);
                  assert.match(nativeToolPayload, /NATIVE-MATRIX-TOOL-OK/u);

                  const featureThreadId = ThreadId.make(
                    `native-matrix-${config.runtime}-feature-thread`,
                  );
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(
                      `native-matrix:${config.runtime}:feature-thread-create`,
                    ),
                    threadId: featureThreadId,
                    projectId,
                    title: `${config.runtime} native feature thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });
                  const uiAssistantCountBefore = (yield* harness.waitForThread(
                    featureThreadId,
                    () => true,
                  )).messages.filter((message) => message.role === "assistant").length;
                  yield* startTurn(
                    10,
                    "NATIVE-MATRIX-UI: exercise the portable confirmation.",
                    featureThreadId,
                  );
                  const uiRequests = yield* waitForSync(
                    () => capabilityObservation.uiRequests,
                    (requests) => requests.some((request) => request.method === "confirm"),
                    `${config.runtime} native portable UI request`,
                  );
                  const uiRequest = uiRequests.find((request) => request.method === "confirm")!;
                  const uiResponsesBefore = capabilityObservation.stdinFrameTypes.filter(
                    (type) => type === "extension_ui_response",
                  ).length;
                  yield* harness.providerService.respondToRequest({
                    threadId: featureThreadId,
                    requestId: asApprovalRequestId(uiRequest.id),
                    decision: "accept",
                  });
                  yield* waitForSync(
                    () =>
                      capabilityObservation.stdinFrameTypes.filter(
                        (type) => type === "extension_ui_response",
                      ).length,
                    (count) => count > uiResponsesBefore,
                    `${config.runtime} native portable UI response`,
                  );
                  const uiSettled = yield* harness.waitForThread(
                    featureThreadId,
                    (entry) =>
                      entry.latestTurn?.state === "completed" &&
                      entry.session?.status === "ready" &&
                      entry.messages.filter((message) => message.role === "assistant").length >
                        uiAssistantCountBefore,
                  );
                  assert.equal(uiSettled.latestTurn?.state, "completed");

                  const taskAssistantCountBefore = (yield* harness.waitForThread(
                    featureThreadId,
                    () => true,
                  )).messages.filter((message) => message.role === "assistant").length;
                  const taskFramesBefore = capabilityObservation.frameTypes.length;
                  const taskUiRequestsBefore = capabilityObservation.uiRequests.length;
                  yield* startTurn(
                    11,
                    "NATIVE-MATRIX-TASK: emit semantic host task lifecycle.",
                    featureThreadId,
                  );
                  const taskObservation = yield* waitForSync(
                    () => ({
                      frameTypes: capabilityObservation.frameTypes.slice(taskFramesBefore),
                      uiRequests: capabilityObservation.uiRequests.slice(taskUiRequestsBefore),
                    }),
                    ({ frameTypes, uiRequests }) =>
                      (frameTypes.includes("host_task_started") &&
                        frameTypes.includes("host_task_progress") &&
                        frameTypes.includes("host_task_completed")) ||
                      uiRequests.some(
                        (request) => request.message === "NATIVE-MATRIX-TASK-UNSUPPORTED",
                      ),
                    `${config.runtime} native semantic task capability`,
                  );
                  if (taskObservation.frameTypes.includes("host_task_started")) {
                    assert.include(taskObservation.frameTypes, "host_task_completed");
                  } else {
                    assert.isTrue(
                      taskObservation.uiRequests.some(
                        (request) => request.message === "NATIVE-MATRIX-TASK-UNSUPPORTED",
                      ),
                    );
                  }
                  const taskSettled = yield* harness.waitForThread(
                    featureThreadId,
                    (entry) =>
                      entry.latestTurn?.state === "completed" &&
                      entry.session?.status === "ready" &&
                      entry.messages.filter((message) => message.role === "assistant").length >
                        taskAssistantCountBefore,
                  );
                  assert.equal(taskSettled.latestTurn?.state, "completed");
                  const featureSessions = yield* harness.providerService.listSessions();
                  assert.isTrue(featureSessions.some((session) => session.threadId === threadId));
                  assert.isTrue(
                    featureSessions.some((session) => session.threadId === featureThreadId),
                  );
                  yield* harness.providerService.stopSession({ threadId: featureThreadId });
                  yield* waitForNativeProcessExit(featureThreadId);

                  if (config.runtime === "omp") {
                    yield* enableNativeLiveCompaction(agentDirectory);
                    const compactionThreadId = ThreadId.make("native-matrix-omp-compaction-thread");
                    yield* harness.engine.dispatch({
                      type: "thread.create",
                      commandId: CommandId.make("native-matrix:omp:compaction-thread-create"),
                      threadId: compactionThreadId,
                      projectId,
                      title: "OMP native compaction thread",
                      modelSelection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      branch: null,
                      worktreePath: harness.workspaceDir,
                      createdAt,
                    });
                    yield* startTurn(
                      15,
                      `NATIVE-MATRIX-COMPACTION ${"context ".repeat(4_000)}`,
                      compactionThreadId,
                    );
                    // Let OMP project compaction before the harness starts polling SQLite.
                    yield* Effect.sleep("15 seconds");
                    const compactedThread = yield* harness.waitForThread(
                      compactionThreadId,
                      (entry) =>
                        entry.activities.some(
                          (activity) =>
                            activity.kind === "context-compaction" &&
                            (activity.payload as Readonly<Record<string, unknown>>).state ===
                              "compacted",
                        ),
                      30_000,
                    );
                    assert.isTrue(
                      compactedThread.activities.some(
                        (activity) => activity.kind === "context-compaction",
                      ),
                    );
                    yield* harness.providerService.stopSession({
                      threadId: compactionThreadId,
                    });
                    yield* waitForNativeProcessExit(compactionThreadId);
                    yield* writeNativeLiveConfig(config, agentDirectory, modelServer);
                    const restartedCompactionThread = yield* startAndWaitForCompleted(
                      16,
                      "Reply after the projected compaction restart.",
                      "NATIVE-MATRIX-OK",
                      "OMP projected compaction restart",
                      compactionThreadId,
                    );
                    assert.isTrue(
                      restartedCompactionThread.activities.some(
                        (activity) => activity.kind === "context-compaction",
                      ),
                    );
                    yield* harness.providerService.stopSession({
                      threadId: compactionThreadId,
                    });
                    yield* waitForNativeProcessExit(compactionThreadId);

                    const ompTaskCapabilities = capabilityObservation.capabilities?.tasks as
                      | Readonly<Record<string, unknown>>
                      | undefined;
                    if (
                      ompTaskCapabilities?.nested === true &&
                      ompTaskCapabilities.background === true
                    ) {
                      const nestedTaskThreadId = ThreadId.make(
                        "native-matrix-omp-nested-task-thread",
                      );
                      yield* harness.engine.dispatch({
                        type: "thread.create",
                        commandId: CommandId.make("native-matrix:omp:nested-task-thread-create"),
                        threadId: nestedTaskThreadId,
                        projectId,
                        title: "OMP native nested task thread",
                        modelSelection,
                        runtimeMode: "approval-required",
                        interactionMode: "default",
                        branch: null,
                        worktreePath: harness.workspaceDir,
                        createdAt,
                      });
                      yield* startTurn(12, "NATIVE-MATRIX-SUBAGENT-PARENT", nestedTaskThreadId);
                      const runningTasks = yield* harness.waitForThread(
                        nestedTaskThreadId,
                        (entry) => {
                          const taskPayloads = entry.activities
                            .filter(
                              (activity) =>
                                activity.kind === "task.started" ||
                                activity.kind === "task.progress",
                            )
                            .map(
                              (activity) => activity.payload as Readonly<Record<string, unknown>>,
                            );
                          return taskPayloads.some(
                            (payload) => payload.parentAgentId === "MatrixChild",
                          );
                        },
                        30_000,
                      );
                      const runningTaskPayloads = runningTasks.activities.map(
                        (activity) => activity.payload as Readonly<Record<string, unknown>>,
                      );
                      const detachedParent = runningTaskPayloads.find(
                        (payload) => payload.taskId === "MatrixChild",
                      );
                      const nestedChild = runningTaskPayloads.find(
                        (payload) =>
                          payload.parentAgentId === "MatrixChild" &&
                          typeof payload.taskId === "string" &&
                          payload.taskId.endsWith(".MatrixGrandchild"),
                      );
                      assert.isDefined(detachedParent, "Missing detached MatrixChild projection.");
                      assert.isDefined(nestedChild, "Missing nested MatrixGrandchild projection.");
                      assert.equal(detachedParent?.isBackgrounded, true);
                      assert.equal(nestedChild?.parentAgentId, "MatrixChild");
                      assert.isNotEmpty(nestedChild?.toolUseId);
                      if (typeof nestedChild?.taskId !== "string") {
                        return yield* Effect.die(
                          "OMP nested task projection had no stable task id.",
                        );
                      }
                      const nestedTaskId = nestedChild.taskId;

                      yield* harness.providerService
                        .stopSession({
                          threadId: nestedTaskThreadId,
                        })
                        .pipe(Effect.timeout("10 seconds"));
                      yield* waitForNativeProcessExit(nestedTaskThreadId);
                      const settledTasks = yield* harness.waitForThread(
                        nestedTaskThreadId,
                        (entry) => {
                          const completed = entry.activities
                            .filter((activity) => activity.kind === "task.completed")
                            .map(
                              (activity) => activity.payload as Readonly<Record<string, unknown>>,
                            );
                          const parentTerminal = completed.some(
                            (payload) =>
                              payload.taskId === "MatrixChild" &&
                              (payload.status === "completed" || payload.status === "stopped"),
                          );
                          const childStopped = completed.some(
                            (payload) =>
                              payload.taskId === nestedTaskId && payload.status === "stopped",
                          );
                          return parentTerminal && childStopped;
                        },
                        30_000,
                      );
                      assert.isTrue(
                        settledTasks.activities.some(
                          (activity) =>
                            activity.kind === "task.completed" &&
                            (activity.payload as Readonly<Record<string, unknown>>).taskId ===
                              nestedTaskId,
                        ),
                      );

                      const postCancellationThreadId = ThreadId.make(
                        "native-matrix-omp-post-cancellation-thread",
                      );
                      yield* harness.engine.dispatch({
                        type: "thread.create",
                        commandId: CommandId.make(
                          "native-matrix:omp:post-cancellation-thread-create",
                        ),
                        threadId: postCancellationThreadId,
                        projectId,
                        title: "OMP post-cancellation restart thread",
                        modelSelection,
                        runtimeMode: "approval-required",
                        interactionMode: "default",
                        branch: null,
                        worktreePath: harness.workspaceDir,
                        createdAt,
                      });
                      yield* startAndWaitForCompleted(
                        13,
                        "Reply after the projected nested task cancellation.",
                        "NATIVE-MATRIX-OK",
                        "OMP process restart after nested task cancellation",
                        postCancellationThreadId,
                      );
                    }
                  }

                  const parallelThreadId = ThreadId.make(
                    `native-matrix-${config.runtime}-parallel-thread`,
                  );
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(
                      `native-matrix:${config.runtime}:parallel-thread-create`,
                    ),
                    threadId: parallelThreadId,
                    projectId,
                    title: `${config.runtime} native parallel thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });
                  const parallelMessage = "Reply from the isolated parallel native session.";
                  const parallel = yield* startAndWaitForCompleted(
                    2,
                    parallelMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} parallel native session`,
                    parallelThreadId,
                  );
                  assert.equal(parallel.session?.providerName, config.runtime);
                  const parallelSessions = yield* harness.providerService.listSessions();
                  assert.isTrue(parallelSessions.some((session) => session.threadId === threadId));
                  assert.isTrue(
                    parallelSessions.some((session) => session.threadId === parallelThreadId),
                  );
                  const imageThreadId = ThreadId.make(
                    `native-matrix-${config.runtime}-image-thread`,
                  );
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(
                      `native-matrix:${config.runtime}:image-thread-create`,
                    ),
                    threadId: imageThreadId,
                    projectId,
                    title: `${config.runtime} native image thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });

                  const imageBytes = Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    "base64",
                  );
                  const imageAttachment = {
                    type: "image",
                    id: `native-matrix-${config.runtime}-thread-00000000-0000-4000-8000-000000000001`,
                    name: "native-matrix.png",
                    mimeType: "image/png",
                    sizeBytes: imageBytes.byteLength,
                  } as const satisfies ChatAttachment;
                  yield* Effect.tryPromise(() =>
                    NodeFS.promises.writeFile(
                      NodePath.join(harness.attachmentsDir, `${imageAttachment.id}.png`),
                      imageBytes,
                    ),
                  );
                  const imageRequestsBefore = modelServer.imageRequestCount();
                  const imageMessage =
                    "Inspect the attached image and reply with the matrix marker.";
                  const image = yield* startAndWaitForCompleted(
                    3,
                    imageMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} native image turn`,
                    imageThreadId,
                    { attachments: [imageAttachment] },
                  );
                  assert.equal(modelServer.imageRequestCount(), imageRequestsBefore + 1);
                  assert.isTrue(
                    image.messages.some(
                      (message) => message.role === "user" && message.attachments?.length === 1,
                    ),
                  );

                  const secondMessage = "Complete a second native turn for checkpoint capture.";
                  yield* startAndWaitForCompleted(
                    4,
                    secondMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} second native turn`,
                  );
                  const nativeCheckpoint = yield* harness.providerService.captureNativeCheckpoint({
                    threadId,
                  });
                  const hasNativeCheckpoint = nativeCheckpoint !== undefined;
                  if (config.runtime === "omp") {
                    assert.isFalse(
                      hasNativeCheckpoint,
                      "OMP does not advertise native checkpoint capture",
                    );
                  }
                  if (nativeCheckpoint !== undefined) {
                    yield* harness.providerService.restoreNativeCheckpoint({
                      threadId,
                      checkpoint: nativeCheckpoint,
                    });
                  }

                  const restoredMessage =
                    nativeCheckpoint === undefined
                      ? "Continue with the native matrix turn."
                      : "Reply with the RESTORED native matrix marker.";
                  const restoredDescription =
                    nativeCheckpoint === undefined
                      ? `${config.runtime} continuation turn`
                      : `${config.runtime} restored turn`;
                  const restored = yield* startAndWaitForCompleted(
                    5,
                    restoredMessage,
                    nativeCheckpoint === undefined
                      ? "NATIVE-MATRIX-OK"
                      : "NATIVE-MATRIX-RESTORED-OK",
                    restoredDescription,
                  );
                  assert.isTrue(
                    restored.messages.some(
                      (message) =>
                        message.role === "assistant" &&
                        message.text.length > 0 &&
                        !message.streaming,
                    ),
                  );
                  const modelCapabilities = (capabilityObservation.capabilities?.models as
                    | Readonly<Record<string, unknown>>
                    | undefined) ?? { switch: true };
                  const thinkingCapabilities = (capabilityObservation.capabilities?.thinking as
                    | Readonly<Record<string, unknown>>
                    | undefined) ?? { switch: true };
                  if (modelCapabilities?.switch === true && thinkingCapabilities?.switch === true) {
                    const modelCommandsBefore = capabilityObservation.responseCommands.length;
                    yield* startAndWaitForCompleted(
                      14,
                      "Complete the native model and thinking-level switch.",
                      "NATIVE-MATRIX-OK",
                      `${config.runtime} model and thinking switch`,
                      threadId,
                      {
                        modelSelection: {
                          instanceId,
                          model: "local/alternate",
                          options: [{ id: "thinkingLevel", value: "high" }],
                        },
                      },
                    );
                    const modelCommands =
                      capabilityObservation.responseCommands.slice(modelCommandsBefore);
                    assert.include(modelCommands, "set_model");
                    assert.include(modelCommands, "set_thinking_level");
                  } else {
                    assert.isFalse(
                      modelCapabilities?.switch === true && thinkingCapabilities?.switch === true,
                    );
                  }
                  const retryMessage = "Reply after NATIVE-MATRIX-RETRY succeeds.";
                  const modelRequestsBeforeRetry = modelServer.requestCount();
                  yield* startAndWaitForCompleted(
                    6,
                    retryMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} transient retry turn`,
                  );
                  assert.isAtLeast(
                    modelServer.requestCount(),
                    modelRequestsBeforeRetry + 2,
                    `${config.runtime} native retry did not issue a second model request`,
                  );
                  const holdMessage = "NATIVE-MATRIX-HOLD";
                  const turnStartedFiber = yield* harness.providerService.streamEvents.pipe(
                    Stream.filter(
                      (event) => event.threadId === threadId && event.type === "turn.started",
                    ),
                    Stream.runHead,
                    Effect.forkChild,
                  );
                  const turnSettledFiber = yield* harness.providerService.streamEvents.pipe(
                    Stream.filter(
                      (event) => event.threadId === threadId && event.type === "turn.completed",
                    ),
                    Stream.runHead,
                    Effect.forkChild,
                  );
                  const modelRequestsBeforeHold = modelServer.requestCount();
                  const interruptStartFiber = yield* startTurn(7, holdMessage).pipe(
                    Effect.forkChild,
                  );
                  const started = yield* Fiber.join(turnStartedFiber).pipe(
                    Effect.timeout("10 seconds"),
                  );
                  assert.equal(
                    started._tag,
                    "Some",
                    `${config.runtime} native turn did not emit turn.started`,
                  );
                  if (started._tag !== "Some") {
                    return yield* Effect.die(
                      "Native matrix running turn did not expose a turn ID.",
                    );
                  }
                  const runningTurnId = started.value.turnId;
                  const holdRequestDeadline = (yield* Clock.currentTimeMillis) + 10_000;
                  while (modelServer.requestCount() <= modelRequestsBeforeHold) {
                    if ((yield* Clock.currentTimeMillis) >= holdRequestDeadline) {
                      return yield* Effect.die(
                        new IntegrationWaitTimeoutError({
                          description: `${config.runtime} native hold request`,
                        }),
                      );
                    }
                    yield* Effect.sleep(10);
                  }
                  // Allow the flushed keepalive to reach the native HTTP client before aborting.
                  yield* Effect.sleep(100);
                  yield* harness.engine.dispatch({
                    type: "thread.turn.interrupt",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:interrupt`),
                    threadId,
                    turnId: runningTurnId,
                    createdAt,
                  });
                  yield* harness.waitForDomainEvent(
                    (event) =>
                      event.type === "thread.turn-interrupt-requested" &&
                      event.payload.threadId === threadId &&
                      event.payload.turnId === runningTurnId,
                    10_000,
                  );
                  const settled = yield* Fiber.join(turnSettledFiber).pipe(
                    Effect.timeout("10 seconds"),
                  );
                  assert.equal(
                    settled._tag,
                    "Some",
                    `${config.runtime} native turn did not settle after interrupt`,
                  );
                  if (settled._tag !== "Some") {
                    return yield* Effect.die("Native matrix interrupted turn did not settle.");
                  }
                  if (settled.value.type !== "turn.completed") {
                    return yield* Effect.die(
                      "Native matrix interruption did not emit turn.completed.",
                    );
                  }
                  assert.equal(settled.value.turnId, runningTurnId);
                  assert.equal(settled.value.payload.state, "interrupted");
                  const interrupted = yield* harness.waitForThread(
                    threadId,
                    (thread) =>
                      thread.session?.status === "ready" &&
                      thread.session.activeTurnId === null &&
                      thread.latestTurn?.state !== "running",
                    10_000,
                  );
                  assert.equal(interrupted.session?.status, "ready");
                  assert.notEqual(interrupted.latestTurn?.state, "running");

                  yield* harness.engine.dispatch({
                    type: "thread.session.stop",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:parallel-stop`),
                    threadId: parallelThreadId,
                    createdAt,
                  });
                  yield* waitForNativeProcessExit(parallelThreadId);
                  const isolatedSessions = yield* harness.providerService.listSessions();
                  assert.isFalse(
                    isolatedSessions.some((session) => session.threadId === parallelThreadId),
                  );
                  assert.isTrue(isolatedSessions.some((session) => session.threadId === threadId));

                  yield* harness.engine.dispatch({
                    type: "thread.session.stop",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:stop`),
                    threadId,
                    createdAt,
                  });
                  const stopped = yield* harness.waitForThread(
                    threadId,
                    (thread) =>
                      thread.session?.status === "stopped" || thread.session?.status === "error",
                    30_000,
                  );
                  assert.equal(
                    stopped.session?.status,
                    "stopped",
                    `${config.runtime} stop failed: ${stopped.session?.lastError ?? "unknown"}`,
                  );
                  yield* waitForNativeProcessExit();
                  yield* Fiber.interrupt(interruptStartFiber).pipe(Effect.ignore);
                  const restartedThreadId = ThreadId.make(
                    `native-matrix-${config.runtime}-restart-thread`,
                  );
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(
                      `native-matrix:${config.runtime}:restart-thread-create`,
                    ),
                    threadId: restartedThreadId,
                    projectId,
                    title: `${config.runtime} native restart thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });
                  const restartedMessage = "Reply after the native session restart.";
                  const restarted = yield* startAndWaitForCompleted(
                    8,
                    restartedMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} restarted turn`,
                    restartedThreadId,
                  );
                  assert.equal(restarted.session?.providerName, config.runtime);
                }),
              (harness) => harness.dispose,
            );
          }),
        (agentDirectory) =>
          Effect.tryPromise(() =>
            NodeFS.promises.rm(agentDirectory, { recursive: true, force: true }),
          ),
      ),
    (modelServer) => Effect.tryPromise(() => modelServer.close()),
  ).pipe(Effect.provide(NodeServices.layer));

interface NativeCrashProcessRecord {
  readonly wrapperPid?: unknown;
  readonly childPid?: unknown;
}

const readNativeCrashProcessRecords = (pidPath: string) =>
  Effect.sync(
    () =>
      // @effect-diagnostics-next-line preferSchemaOverJson:off - Private PID fixture written by the crash wrapper.
      JSON.parse(NodeFS.readFileSync(pidPath, "utf8")) as ReadonlyArray<NativeCrashProcessRecord>,
  );

const waitForNativeCrashProcessesToExit = (
  runtime: NativeLiveConfig["runtime"],
  processRecords: ReadonlyArray<NativeCrashProcessRecord>,
  phase: string,
) =>
  Effect.gen(function* () {
    for (const [recordIndex, processRecord] of processRecords.entries()) {
      for (const [label, candidate] of [
        ["wrapper", processRecord.wrapperPid],
        ["native child", processRecord.childPid],
      ] as const) {
        assert.isTrue(
          Number.isInteger(candidate) && Number(candidate) > 0,
          `${runtime} crash wrapper recorded an invalid ${label} PID`,
        );
        const pid = Number(candidate);
        const deadline = (yield* Clock.currentTimeMillis) + 10_000;
        while (true) {
          const running = yield* Effect.sync(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ESRCH"
              ) {
                return false;
              }
              throw error;
            }
          });
          if (!running) break;
          assert.isBelow(
            yield* Clock.currentTimeMillis,
            deadline,
            `${runtime} ${phase} left ${label} process ${pid} running (record ${recordIndex})`,
          );
          yield* Effect.sleep(10);
        }
      }
    }
  });

const runNativeCrashMatrix = (config: NativeLiveConfig) =>
  Effect.acquireUseRelease(
    makeNativeLiveModelServer,
    (modelServer) =>
      Effect.acquireUseRelease(
        makeNativeLiveAgentDirectory(`t3-native-crash-${config.runtime}-`),
        (agentDirectory) =>
          Effect.gen(function* () {
            yield* writeNativeLiveConfig(config, agentDirectory, modelServer);
            const extensionPath = yield* writeNativeLiveExtension(agentDirectory);
            const crashWrapper = yield* writeNativeCrashWrapper(agentDirectory);
            yield* Effect.acquireUseRelease(
              makeOrchestrationIntegrationHarness({
                provider: config.provider,
                nativeLive: {
                  runtime: config.runtime,
                  binaryPath: process.execPath,
                  launchArguments: [
                    crashWrapper.wrapperPath,
                    crashWrapper.pidPath,
                    config.binaryPath,
                    ...config.launchArguments,
                    "--extension",
                    extensionPath,
                  ],
                  agentDirectory,
                  environment: { PI_OFFLINE: "1", PI_NO_PTY: "1" },
                  ...(config.trustMode === undefined ? {} : { trustMode: config.trustMode }),
                  traceSinkFactory: nativeLiveTraceSinkFactory,
                },
              }),
              (harness) =>
                Effect.gen(function* () {
                  const projectId = ProjectId.make(`native-crash-${config.runtime}-project`);
                  const crashThreadId = ThreadId.make(`native-crash-${config.runtime}-thread`);
                  const controlThreadId = ThreadId.make(
                    `native-crash-${config.runtime}-control-thread`,
                  );
                  const replacementThreadId = ThreadId.make(
                    `native-crash-${config.runtime}-replacement-thread`,
                  );
                  const modelSelection: ModelSelection = {
                    instanceId: ProviderInstanceId.make(config.runtime),
                    model: "local/test",
                  };
                  const createdAt = "2026-08-24T00:00:00.000Z";
                  yield* harness.engine.dispatch({
                    type: "project.create",
                    commandId: CommandId.make(`native-crash:${config.runtime}:project`),
                    projectId,
                    title: `${config.runtime} native crash project`,
                    workspaceRoot: harness.workspaceDir,
                    defaultModelSelection: modelSelection,
                    createdAt,
                  });
                  const createThread = (threadId: ThreadId, suffix: string) =>
                    harness.engine.dispatch({
                      type: "thread.create",
                      commandId: CommandId.make(`native-crash:${config.runtime}:${suffix}:create`),
                      threadId,
                      projectId,
                      title: `${config.runtime} native crash ${suffix}`,
                      modelSelection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      branch: null,
                      worktreePath: harness.workspaceDir,
                      createdAt,
                    });
                  const startTurn = (threadId: ThreadId, suffix: string, text: string) =>
                    harness.engine.dispatch({
                      type: "thread.turn.start",
                      commandId: CommandId.make(`native-crash:${config.runtime}:${suffix}:turn`),
                      threadId,
                      message: {
                        messageId: MessageId.make(`native-crash-${config.runtime}-${suffix}-user`),
                        role: "user",
                        text,
                        attachments: [],
                      },
                      modelSelection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      createdAt,
                    });
                  yield* createThread(controlThreadId, "control");
                  yield* createThread(crashThreadId, "crash");
                  yield* startTurn(
                    controlThreadId,
                    "control",
                    "Reply before the isolated crash drill.",
                  );
                  const control = yield* harness.waitForThread(
                    controlThreadId,
                    (thread) =>
                      thread.latestTurn?.state === "completed" &&
                      thread.session?.status === "ready",
                    30_000,
                  );
                  assert.equal(control.session?.providerName, config.runtime);

                  yield* startTurn(
                    crashThreadId,
                    "crash",
                    "NATIVE-MATRIX-CRASH NATIVE-MATRIX-HOLD",
                  );
                  const crashed = yield* harness.waitForThread(
                    crashThreadId,
                    (thread) => thread.session?.status === "error",
                    30_000,
                  );
                  assert.equal(crashed.latestTurn?.state, "error");
                  assert.isTrue((crashed.session?.lastError?.length ?? 0) > 0);
                  assert.isTrue(crashed.messages.some((message) => message.role === "user"));
                  const processRecords = yield* readNativeCrashProcessRecords(crashWrapper.pidPath);
                  assert.isAtLeast(
                    processRecords.length,
                    1,
                    `${config.runtime} crash wrapper did not record a process`,
                  );
                  yield* waitForNativeCrashProcessesToExit(
                    config.runtime,
                    [processRecords[processRecords.length - 1]!],
                    "isolated crash",
                  );
                  const sessionsAfterCrash = yield* harness.providerService.listSessions();
                  assert.isTrue(
                    sessionsAfterCrash.some((session) => session.threadId === controlThreadId),
                  );
                  assert.isFalse(
                    sessionsAfterCrash.some((session) => session.threadId === crashThreadId),
                  );

                  yield* createThread(replacementThreadId, "replacement");
                  yield* startTurn(
                    replacementThreadId,
                    "replacement",
                    "Reply after replacement of the crashed native process.",
                  );
                  const replaced = yield* harness.waitForThread(
                    replacementThreadId,
                    (thread) =>
                      thread.latestTurn?.state === "completed" &&
                      thread.session?.status === "ready" &&
                      thread.messages.some(
                        (message) =>
                          message.role === "assistant" &&
                          !message.streaming &&
                          message.text.includes("NATIVE-MATRIX-OK"),
                      ),
                    30_000,
                  );
                  assert.equal(replaced.session?.providerName, config.runtime);
                  const sessionsAfterReplacement = yield* harness.providerService.listSessions();
                  assert.isTrue(
                    sessionsAfterReplacement.some(
                      (session) => session.threadId === controlThreadId,
                    ),
                  );
                  assert.isTrue(
                    sessionsAfterReplacement.some(
                      (session) => session.threadId === replacementThreadId,
                    ),
                  );

                  for (const [threadId, suffix] of [
                    [controlThreadId, "control"],
                    [replacementThreadId, "replacement"],
                  ] as const) {
                    yield* harness.engine.dispatch({
                      type: "thread.session.stop",
                      commandId: CommandId.make(`native-crash:${config.runtime}:${suffix}:stop`),
                      threadId,
                      createdAt,
                    });
                  }
                  const cleanupDeadline = (yield* Clock.currentTimeMillis) + 30_000;
                  while (true) {
                    const sessions = yield* harness.providerService.listSessions();
                    if (
                      !sessions.some(
                        (session) =>
                          session.threadId === controlThreadId ||
                          session.threadId === replacementThreadId,
                      )
                    ) {
                      break;
                    }
                    if ((yield* Clock.currentTimeMillis) >= cleanupDeadline) {
                      return yield* Effect.die(
                        `${config.runtime} native crash matrix left an owned process`,
                      );
                    }
                    yield* Effect.sleep(10);
                  }
                  yield* waitForNativeCrashProcessesToExit(
                    config.runtime,
                    yield* readNativeCrashProcessRecords(crashWrapper.pidPath),
                    "cleanup",
                  );
                }),
              (harness) => harness.dispose,
            );
          }),
        (agentDirectory) =>
          Effect.tryPromise(() =>
            NodeFS.promises.rm(agentDirectory, { recursive: true, force: true }),
          ),
      ),
    (modelServer) => Effect.tryPromise(() => modelServer.close()),
  ).pipe(Effect.provide(NodeServices.layer));

const nativeMatrixConfigurations = configuredNativeLiveConfigurations();
for (const config of nativeMatrixConfigurations) {
  it.live(
    `runs configured ${config.runtime} through the native T3 lifecycle matrix`,
    () => runNativeMatrix(config),
    120_000,
  );
  it.live(
    `recovers configured ${config.runtime} after an isolated stock native process crash`,
    () => runNativeCrashMatrix(config),
    120_000,
  );
}
