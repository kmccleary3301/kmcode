import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadLiveItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ThreadLiveOverlay from "../ThreadLiveOverlay.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { handoffBudget } from "../ContextHandoffBudget.ts";
import { makePiAdapterV2, PI_PROVIDER } from "./PiAdapterV2.ts";
import { makePiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";
import { OMP_DIALECT, PI_DIALECT, type PiDialect } from "../../provider/piDialect.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  layerServerConfig,
  ThreadLiveOverlay.layer,
);

const layerTestWithTestClock = Layer.mergeAll(layerTest, TestClock.layer());

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  /** Data returned by the next `get_entries` acks, consumed in order. */
  readonly queueEntries: (data: unknown) => void;
  /** Data returned by the next active-branch `get_messages` acks. */
  readonly queueMessages: (data: unknown) => void;
  /** Make the next `switch_session` ack report an extension veto. */
  readonly vetoNextSwitch: () => void;
  /** Fields overriding the recorded idle state in the next `get_state` acks, in order. */
  readonly queueState: (data: Record<string, unknown>) => void;
  /** Hold the next `get_state` response until the test resolves it. */
  readonly deferNextState: () => void;
  /** Resolve the held `get_state` request. */
  readonly resolveDeferredState: (data: unknown) => Effect.Effect<void>;
  /** Reject the next `get_state` request. */
  readonly failNextState: () => void;
  readonly deferNextLifecycle: (type: "switch_session" | "new_session") => void;
  readonly queueModels: (models: ReadonlyArray<unknown>) => void;
  readonly vetoNextNewSession: () => void;
  /** Every request received by the fake process. */
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  /** Data returned by the next `get_session_stats` acks, consumed in order. */
  readonly queueStats: (data: unknown) => void;
  /** Pi before 0.84.4 answers clear_queue as an unknown command. */
  readonly setClearQueue: (
    result:
      | { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
      | "unknown_command",
  ) => void;
  /** Data returned by the next `get_commands` acks, consumed in order. */
  readonly queueCommands: (data: unknown) => void;
  /** Make the next `get_commands` ack fail. */
  readonly failNextCommands: () => void;
  /** Reject the next OMP goal RPC. */
  readonly failNextGoal: () => void;
  /** Close the fake process stdout stream. */
  readonly closeStdout: Effect.Effect<void>;
  readonly lastSpawn: () => {
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  };
}

/**
 * Pi 1.0.0's idle `get_state` reply, taken from the `simple` replay fixture
 * (fixtures/simple/pi_transcript.ndjson) minus the model object. Pi omits
 * `model` when none is selected and `sessionName` until one is set.
 */
const recordedIdleState = (sessionFile: string) => ({
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionFile,
  sessionId: "00000000-0000-4000-8000-000000000002",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
});

/**
 * In-process fake `pi --mode rpc` for races and failures a live Pi cannot
 * produce on demand: captures every stdin record, auto-acks requests, and lets
 * tests push protocol events to stdout. Behaviour a real Pi can show belongs
 * in a replay fixture instead (see PiAdapterV2.testkit.ts).
 */
const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entriesQueue: Array<unknown> = [];
  const messagesQueue: Array<unknown> = [];
  const stateQueue: Array<Record<string, unknown>> = [];
  const statsQueue: Array<unknown> = [];
  const commandsQueue: Array<{ readonly success: boolean; readonly data?: unknown }> = [];
  const allRequests: Array<PiRpcRecord> = [];
  let deferState = false;
  let deferredStateRequest: PiRpcRecord | undefined;
  let failState = false;
  let failGoal = false;
  let vetoSwitch = false;
  let vetoNewSession = false;
  let deferredLifecycle: string | undefined;
  let sessionFile = FAKE_SESSION_FILE;
  let sessionGeneration = 0;
  let models: ReadonlyArray<unknown> = [];
  let clearQueue: Parameters<FakePi["setClearQueue"]>[0] = { steering: [], followUp: [] };
  let stdinBuffer = "";

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (typeof record["id"] !== "string") return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        if (failState) {
          failState = false;
          return { ...base, success: false, error: "state unavailable" };
        }
        // Queued data overrides fields of the recorded idle state, so a test
        // that only cares about the session file still gets a real shape.
        return { ...base, data: { ...recordedIdleState(sessionFile), ...stateQueue.shift() } };
      case "get_available_models":
        return { ...base, data: { models } };
      case "new_session": {
        const cancelled = vetoNewSession;
        vetoNewSession = false;
        if (!cancelled) sessionFile = `/fake/new-${++sessionGeneration}.jsonl`;
        return { ...base, data: { cancelled } };
      }
      case "switch_session": {
        const cancelled = vetoSwitch;
        vetoSwitch = false;
        return { ...base, data: { cancelled } };
      }
      case "get_entries":
        return { ...base, data: entriesQueue.shift() ?? { entries: [], leafId: null } };
      case "get_messages":
        return { ...base, data: messagesQueue.shift() ?? { messages: [] } };
      case "get_session_stats":
        return { ...base, data: statsQueue.shift() ?? {} };
      case "clear_queue":
        return clearQueue === "unknown_command"
          ? { ...base, success: false, error: "Unknown command: clear_queue" }
          : { ...base, data: clearQueue };
      case "get_commands":
        return { ...base, ...(commandsQueue.shift() ?? { data: { commands: [] } }) };
      case "fork":
        return { ...base, data: { text: "Hello pi", cancelled: false } };
      case "goal":
        if (failGoal) {
          failGoal = false;
          return { ...base, success: false, error: "Goal mode is disabled (goal.enabled)." };
        }
        return base;
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        allRequests.push(record);
        yield* Queue.offer(requests, record);
        if (record["type"] === "get_state" && deferState) {
          deferState = false;
          deferredStateRequest = record;
          continue;
        }
        if (record["type"] === deferredLifecycle) {
          deferredLifecycle = undefined;
          continue;
        }
        const response = respondTo(record);
        if (response !== null) yield* emit(response);
      }
    });

  let lastSpawn: { readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv } = {
    args: [],
    env: {},
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = {
          args: command.args,
          env: command.options.env ?? {},
        };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    emit,
    takeRequest,
    queueEntries: (data) => entriesQueue.push(data),
    queueMessages: (data) => messagesQueue.push(data),
    deferNextState: () => {
      deferState = true;
    },
    resolveDeferredState: (data) =>
      Effect.gen(function* () {
        const record = deferredStateRequest;
        assert.isDefined(record);
        deferredStateRequest = undefined;
        yield* emit({
          type: "response",
          id: record!["id"],
          command: "get_state",
          success: true,
          data,
        });
      }),
    failNextState: () => {
      failState = true;
    },
    deferNextLifecycle: (type) => {
      deferredLifecycle = type;
    },
    queueModels: (value) => {
      models = value;
    },
    vetoNextNewSession: () => {
      vetoNewSession = true;
    },
    allRequests: () => allRequests,
    vetoNextSwitch: () => {
      vetoSwitch = true;
    },
    queueState: (data) => stateQueue.push(data),
    queueStats: (data) => statsQueue.push(data),
    setClearQueue: (result) => {
      clearQueue = result;
    },
    queueCommands: (data) => commandsQueue.push({ success: true, data }),
    failNextCommands: () => commandsQueue.push({ success: false }),
    failNextGoal: () => {
      failGoal = true;
    },
    closeStdout: Queue.end(stdout),
    lastSpawn: () => lastSpawn,
  } satisfies FakePi;
});

const makeAdapter = Effect.fnUntraced(function* (
  fake: FakePi,
  launchArgs = "",
  forkFake?: FakePi,
  dialect: PiDialect = PI_DIALECT,
  replacementFake?: FakePi,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const threadLiveOverlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
  const fileSystem = yield* FileSystem.FileSystem;
  let sessionSpawns = 0;
  const spawner =
    forkFake === undefined && replacementFake === undefined
      ? fake.spawner
      : ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command) && command.args.includes("--fork")) {
            return (forkFake ?? fake).spawner.spawn(command);
          }
          sessionSpawns += 1;
          return sessionSpawns > 1 && replacementFake !== undefined
            ? replacementFake.spawner.spawn(command)
            : fake.spawner.spawn(command);
        });
  return makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs, customModels: [] },
    dialect,
    environment: {},
    spawner,
    fileSystem,
    idAllocator,
    serverConfig,
    threadLiveOverlay,
  });
});

const openRuntime = Effect.fnUntraced(function* (
  fake: FakePi,
  model = "default",
  threadId = THREAD_ID,
  providerSessionId = SESSION_ID,
  forkFake?: FakePi,
  dialect: PiDialect = PI_DIALECT,
  replacementFake?: FakePi,
) {
  const adapter = yield* makeAdapter(fake, "", forkFake, dialect, replacementFake);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  /** Takes an event that is only emitted after a stream flush timer. */
  const takeFlushedEvent = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Effect.race(
      takeEvent(predicate),
      Effect.forever(TestClock.adjust(Duration.millis(10)).pipe(Effect.andThen(Effect.yieldNow))),
    );
  return { runtime, takeEvent, takeFlushedEvent, emitted };
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello pi",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
  isRunAttemptActive?: ProviderAdapterV2TurnInput["isRunAttemptActive"],
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
    ...(isRunAttemptActive === undefined ? {} : { isRunAttemptActive }),
  });
});

const expectModelFailure = (errorMessage: string) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    const { runtime, takeEvent } = yield* openRuntime(fake);
    const providerThread = yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    yield* startTurn(runtime, providerThread);
    yield* fake.takeRequest("prompt");
    yield* fake.emit({ type: "agent_start" });
    yield* fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
      },
    });
    yield* fake.emit({ type: "agent_settled" });

    const sessionError = yield* takeEvent(
      (event) =>
        event.type === "provider_session.updated" && event.providerSession.status === "error",
    );
    assert.isTrue(
      sessionError.type === "provider_session.updated" &&
        sessionError.providerSession.lastError === errorMessage,
    );
    const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
    assert.isTrue(
      terminal.type === "turn.terminal" &&
        terminal.status === "failed" &&
        terminal.failure.message === errorMessage,
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest));

describe("PiAdapterV2", () => {
  it.effect("stops provider-initiated work that has no T3 turn owner", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* fake.emit({ type: "agent_start" });

      const sessionError = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      assert.isTrue(
        sessionError.type === "provider_session.updated" &&
          sessionError.providerSession.lastError?.includes("invisible tool execution") === true,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("injects the T3 MCP extension and bearer when a session exists", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-pi-mcp"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-pi",
        providerInstanceId: PI_INSTANCE_ID,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-pi-token",
        browserToolsAvailable: true,
      });
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      const spawn = fake.lastSpawn();
      assert.isTrue(spawn.args.includes("--extension"));
      const extensions = spawn.args.flatMap((arg, index) =>
        arg === "--extension" ? [spawn.args[index + 1]] : [],
      );
      assert.isFalse(spawn.args.includes("--no-extensions"));
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-mcp-extension.ts")));
      assert.equal(spawn.env.T3_MCP_URL, "http://127.0.0.1:43123/mcp");
      assert.equal(spawn.env.T3_MCP_BEARER_TOKEN, "secret-pi-token");
      assert.equal(spawn.env.T3_PI_RUNTIME_MODE, "full-access");
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID))),
      Effect.scoped,
      Effect.provide(layerTest),
    ),
  );

  it.effect("rejects a resume while a turn is active", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
      assert.match(String(error.cause), /while a turn is active/);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("self-heals an orphaned Pi turn without weakening the active-turn guard", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const replacementFake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        PI_DIALECT,
        replacementFake,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      const activeTurnError = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Follow-up",
        undefined,
        2,
        THREAD_ID,
        () => Effect.succeed(true),
      ).pipe(Effect.flip);
      assert.equal(activeTurnError._tag, "ProviderAdapterTurnStartError");
      assert.match(String(activeTurnError.cause), /already has an active turn/);

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Follow-up",
        undefined,
        2,
        THREAD_ID,
        () => Effect.succeed(false),
      );
      yield* replacementFake.takeRequest("prompt");
      const orphanTerminal = yield* takeEvent(
        (event) => event.type === "turn.terminal" && event.runOrdinal === 1,
      );
      assert.isTrue(
        orphanTerminal.type === "turn.terminal" && orphanTerminal.status === "interrupted",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("waits for a slow Pi resume without starting a replacement", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextLifecycle("switch_session");
      const resumed = yield* runtime.resumeThread({ providerThread }).pipe(Effect.forkChild);
      const request = yield* fake.takeRequest("switch_session");
      yield* TestClock.adjust(Duration.millis(16_820));
      yield* fake.emit({
        type: "response",
        id: request.id,
        command: "switch_session",
        success: true,
        data: { cancelled: false },
      });
      assert.equal((yield* Fiber.join(resumed)).nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      assert.isFalse(fake.allRequests().some((request) => request.type === "new_session"));
      yield* startTurn(runtime, providerThread, "default");
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("creates a distinct native session after a failed resume", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.vetoNextSwitch();
      yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      const replacement = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      assert.equal(replacement.id, providerThread.id);
      assert.notEqual(
        replacement.nativeThreadRef?.nativeId,
        providerThread.nativeThreadRef?.nativeId,
      );
      assert.equal(
        fake.allRequests().filter((request) => request.type === "new_session").length,
        1,
      );
      yield* startTurn(runtime, replacement, "default");
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["veto", "same identity"] as const)(
    "rejects a replacement with %s",
    (invalidReplacement) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        if (invalidReplacement === "veto") fake.vetoNextNewSession();
        else fake.queueState({ sessionFile: FAKE_SESSION_FILE });
        const error = yield* runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterEnsureThreadError");
        assert.match(
          String(error.cause),
          invalidReplacement === "veto" ? /cancelled/ : /distinct session/,
        );
        yield* startTurn(runtime, providerThread, "default").pipe(Effect.flip);
        assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("retires a timed-out lifecycle process before a late switch can race replacement", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextLifecycle("switch_session");
      const resumed = yield* runtime
        .resumeThread({ providerThread })
        .pipe(Effect.flip, Effect.forkChild);
      const request = yield* fake.takeRequest("switch_session");
      yield* TestClock.adjust(Duration.seconds(60));
      const error = yield* Fiber.join(resumed);
      assert.match(String(error.cause), /timed out after 60000ms/);
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      yield* fake.emit({
        type: "response",
        id: request.id,
        command: "switch_session",
        success: true,
        data: { cancelled: false },
      });
      yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
          existingProviderThread: { ...providerThread, nativeThreadRef: null },
        })
        .pipe(Effect.flip);
      assert.isFalse(
        fake
          .allRequests()
          .some((request) => request.type === "new_session" || request.type === "prompt"),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "uses the lifecycle deadline for fresh sessions and drops replaced native metadata",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.deferNextLifecycle("new_session");
        fake.queueState({ sessionFile: "/fake/fresh-after-delay.jsonl" });
        const replacing = yield* runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
            existingProviderThread: {
              ...providerThread,
              nativeThreadRef: null,
              nativeConversationHeadRef: {
                driver: PI_PROVIDER,
                nativeId: "old-leaf",
                strength: "strong",
              },
              contextUsage: { usedTokens: 314_551, maxTokens: 1_000_000 },
            },
          })
          .pipe(Effect.forkChild);
        const request = yield* fake.takeRequest("new_session");
        yield* TestClock.adjust(Duration.millis(16_820));
        yield* fake.emit({
          type: "response",
          id: request.id,
          command: "new_session",
          success: true,
          data: { cancelled: false },
        });
        const replacement = yield* Fiber.join(replacing);
        assert.equal(replacement.nativeThreadRef?.nativeId, "/fake/fresh-after-delay.jsonl");
        assert.isNull(replacement.contextUsage);
        assert.isNull(replacement.nativeConversationHeadRef);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("replaces a native session when the first resume's state refresh fails", () =>
    Effect.gen(function* () {
      const original = yield* makeFakePi;
      const originalRuntime = yield* openRuntime(original);
      const providerThread = yield* originalRuntime.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      fake.failNextState();
      yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      const replacement = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      assert.notEqual(
        replacement.nativeThreadRef?.nativeId,
        providerThread.nativeThreadRef?.nativeId,
      );
      yield* startTurn(runtime, replacement, "default");
      yield* fake.takeRequest("prompt");
      assert.isTrue(fake.allRequests().some((request) => request.type === "new_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("retires an interrupted switch before accepting further requests", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextLifecycle("switch_session");
      const resumed = yield* runtime.resumeThread({ providerThread }).pipe(Effect.forkChild);
      yield* fake.takeRequest("switch_session");
      yield* Fiber.interrupt(resumed);
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
          existingProviderThread: { ...providerThread, nativeThreadRef: null },
        })
        .pipe(Effect.flip);
      assert.isFalse(fake.allRequests().some((request) => request.type === "new_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("budgets legacy native history with Pi's selected model capacity", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        sessionFile: FAKE_SESSION_FILE,
        model: { provider: "anthropic", id: "large", contextWindow: 1_000_000 },
      });
      fake.queueModels([{ provider: "anthropic", id: "small", contextWindow: 32_000 }]);
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const budget = (model: string) =>
        handoffBudget({
          tokenCap: 16_000,
          userText: "$handoff",
          attachments: [],
          providerThread,
          nativeContextEstimate: 307_543,
          modelContextWindow: runtime.getModelContextWindow?.(modelSelection(model)),
        });
      assert.equal(budget("default"), 16_000);
      assert.equal(budget("anthropic/large"), 16_000);
      assert.equal(runtime.getModelContextWindow?.(modelSelection("anthropic/small")), 32_000);
      assert.equal(budget("anthropic/small"), 0);
      assert.isUndefined(runtime.getModelContextWindow?.(modelSelection("anthropic/unknown")));
      assert.isUndefined(
        runtime.getModelContextWindow?.({
          instanceId: ProviderInstanceId.make("other-pi"),
          model: "anthropic/large",
        }),
      );
      // New native sessions have their own default, even within one process.
      fake.queueState({
        sessionFile: "/fake/replacement.jsonl",
        model: { provider: "anthropic", id: "small", contextWindow: 32_000 },
      });
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      assert.equal(runtime.getModelContextWindow?.(modelSelection("default")), 32_000);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("adopts the run's provider thread identity instead of minting a second row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const now = yield* DateTime.now;
      // The placeholder row the orchestrator creates for a first run: no
      // native identity yet. The adapter must bind the pi session to this
      // row instead of registering a second session-file-keyed row, or the
      // projection ends up with two live rows per app thread.
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:pi:native-thread:pending:run:thread-pi-test:1"),
        driver: PI_PROVIDER,
        providerInstanceId: PI_INSTANCE_ID,
        providerSessionId: SESSION_ID,
        appThreadId: THREAD_ID,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: placeholder,
      });
      assert.equal(providerThread.id, placeholder.id);
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      assert.isFalse(fake.allRequests().some((request) => request.type === "new_session"));
      const updated = yield* takeEvent((event) => event.type === "provider_thread.updated");
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === placeholder.id,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("follows OMP's save redirect when another process holds the session file", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      // An unrelated notice must not move the binding.
      yield* fake.emit({ type: "notice", level: "warning", message: "x", source: "other" });
      fake.queueState({ sessionFile: "/fake/redirected.jsonl" });
      yield* fake.emit({
        type: "notice",
        level: "warning",
        message: "Session is open for writing in another omp process",
        source: "session-persistence",
      });
      const moved = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeThreadRef?.nativeId !== FAKE_SESSION_FILE,
      );
      assert.isTrue(
        moved.type === "provider_thread.updated" &&
          moved.providerThread.id === providerThread.id &&
          moved.providerThread.nativeThreadRef?.nativeId === "/fake/redirected.jsonl",
      );
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      const idle = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" && event.providerThread.status === "idle",
      );
      assert.isTrue(
        idle.type === "provider_thread.updated" &&
          idle.providerThread.nativeThreadRef?.nativeId === "/fake/redirected.jsonl",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("resets applied thinking when returning to Pi default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        model: { provider: "xai", id: "grok-4.6" },
        thinkingLevel: "medium",
        sessionFile: FAKE_SESSION_FILE,
        sessionId: "abc",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      // An explicit effort on a concrete model.
      yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
        instanceId: PI_INSTANCE_ID,
        model: "xai/grok-4.6",
        options: [{ id: "thinking", value: "high" }],
      });
      const modelRequest = yield* fake.takeRequest("set_model");
      assert.equal(modelRequest["provider"], "xai");
      assert.equal(modelRequest["modelId"], "grok-4.6");
      const levelRequest = yield* fake.takeRequest("set_thinking_level");
      assert.equal(levelRequest["level"], "high");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      // Back to Pi default with no explicit thinking choice of its own.
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        {
          instanceId: PI_INSTANCE_ID,
          model: "default",
        },
        2,
      );
      const replayModel = yield* fake.takeRequest("set_model");
      assert.equal(replayModel["provider"], "xai");
      assert.equal(replayModel["modelId"], "grok-4.6");
      const resetLevel = yield* fake.takeRequest("set_thinking_level");
      assert.equal(resetLevel["level"], "medium");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("expands a selected $ skill through Pi's native skill command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            description: "Review this repository.",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Review this change please $repo-review",
      );
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review Review this change please");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("expands every selected $ skill through Pi native skill commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
          {
            name: "skill:deploy",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/deploy/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "use $repo-review and $deploy");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review /skill:deploy use  and");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { historical: false, label: "the latest turn" },
    { historical: true, label: "a historical turn" },
  ])("natively forks $label into an independent session", ({ historical }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const forkFile = "/fake/forked.jsonl";
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        forkFake,
      );
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: `u${ordinal}`, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: forkFile });
      const target = ThreadId.make("fork-target");
      const forked = yield* runtime.forkThread({
        sourceProviderThread: source,
        sourceProviderTurns: historical ? [turn(1), turn(2)] : [turn(1)],
        providerTurnId: turn(1).id,
        targetThreadId: target,
      });
      assert.equal(forked.appThreadId, target);
      assert.equal(forked.nativeThreadRef?.nativeId, forkFile);
      assert.notEqual(forked.id, source.id);
      assert.equal(source.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      const args = forkFake.lastSpawn().args;
      assert.equal(args[args.indexOf("--fork") + 1], FAKE_SESSION_FILE);
      assert.include(args, "--no-extensions");
      assert.include(args, "--no-tools");
      assert.notInclude(args, "--no-session");
      assert.deepEqual(
        forkFake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId),
        historical ? ["u2"] : [],
      );
      assert.isFalse(
        fake.allRequests().some((request) => request.type === "fork" || request.type === "clone"),
      );
      // ProviderTurnStartService adopts the fork into its pending row.
      const adopted = { ...forked, id: ProviderThreadId.make("pending-fork-row") };
      yield* startTurn(runtime, adopted, "default", [], "Continue", undefined, 1, target);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const updated = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" && event.providerThread.appThreadId === target,
      );
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === adopted.id,
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* runtime.resumeThread({ providerThread: adopted });
      assert.equal(
        fake.allRequests().findLast((request) => request.type === "switch_session")?.sessionPath,
        forkFile,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("presents explicitly namespaced MCP extension tools", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      for (const type of ["tool_execution_start", "tool_execution_end"]) {
        yield* fake.emit({
          type,
          toolCallId: "weather-call",
          toolName: "mcp__weather__get_weather",
          args: { city: "Berlin" },
          result: { content: [{ type: "text", text: "Sunny" }] },
          isError: false,
        });
        const event = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Expected an MCP tool item");
        assert.equal(event.turnItem.title, "get weather");
        assert.equal(
          event.turnItem.status,
          type === "tool_execution_start" ? "running" : "completed",
        );
        assert.deepEqual(event.turnItem.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(event.turnItem.input, { city: "Berlin" });
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("observes official subagent results without inventing child threads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stderr: "",
                sessionFile: "/ignored/custom-extension-session.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
            ],
          },
        },
      });
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files" &&
          running.subagent.childThreadId === null,
      );

      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
            ],
          },
        },
      });
      const doneCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        doneCard.type === "subagent.updated" &&
          doneCard.subagent.result === "repo has one file" &&
          doneCard.subagent.childThreadId === null,
      );
      const subagentItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        subagentItem.type === "turn_item.updated" &&
          subagentItem.turnItem.type === "subagent" &&
          subagentItem.turnItem.childThreadId === null,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reports live context usage carried on the streamed message snapshot", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        sessionFile: FAKE_SESSION_FILE,
        model: { provider: "anthropic", id: "opus", contextWindow: 300_000 },
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      // OMP has no top-level `usage`; the full snapshot carries it.
      yield* fake.emit({
        type: "message_update",
        message: {
          role: "assistant",
          usage: { input: 2, output: 413, cacheRead: 205_537, totalTokens: 208_545 },
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working." },
      });
      const report = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined,
      );
      assert.isTrue(report.type === "provider_turn.updated");
      if (report.type !== "provider_turn.updated") return;
      assert.include(report.providerTurn.tokenUsage, {
        usedTokens: 208_545,
        maxTokens: 300_000,
        inputTokens: 2,
        cachedInputTokens: 205_537,
        outputTokens: 413,
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("previews streamed tool arguments until actual execution starts", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, takeFlushedEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Listing." },
      });
      const toolCall = (args: unknown) => ({
        type: "toolCall",
        id: "call_ls",
        name: "bash",
        arguments: args,
      });
      const partial = (args: unknown) => ({
        content: [{ type: "text", text: "Listing." }, toolCall(args)],
      });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: partial({}) },
      });
      const commandItem = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
          ? event.turnItem
          : undefined;
      const answer = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
      );
      assert.isTrue(answer.type === "turn_item.updated" && answer.turnItem.status === "completed");
      const previewed = commandItem(yield* takeEvent((event) => commandItem(event) !== undefined));
      assert.equal(previewed?.status, "pending");
      assert.isNull(previewed?.startedAt);
      assert.equal(previewed?.input, "");

      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: '{"command":"ls"',
          partial: partial({ command: "ls" }),
        },
      });
      const streamed = commandItem(
        yield* takeFlushedEvent((event) => commandItem(event)?.input === "ls"),
      );
      assert.equal(streamed?.id, previewed?.id);
      assert.equal(streamed?.status, "pending");
      assert.isNull(streamed?.startedAt);

      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: toolCall({ command: "ls -la" }),
        },
      });
      yield* takeEvent((event) => commandItem(event)?.input === "ls -la");
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_ls",
        toolName: "bash",
        args: { command: "ls -la" },
      });
      const started = commandItem(
        yield* takeEvent((event) => commandItem(event)?.status === "running"),
      );
      assert.equal(started?.id, previewed?.id);
      assert.equal(started?.ordinal, previewed?.ordinal);
      assert.isNotNull(started?.startedAt);
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_ls",
        toolName: "bash",
        result: { content: [{ type: "text", text: "a\nb" }] },
        isError: false,
      });
      const done = commandItem(
        yield* takeEvent((event) => commandItem(event)?.status === "completed"),
      );
      assert.equal(done?.id, started?.id);
      assert.equal(done?.input, "ls -la");
      assert.equal(done?.output, "a\nb");
      assert.isFalse(
        fake.allRequests().some((request) => request["type"] === "set_subagent_subscription"),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("nests tools invoked through another tool under their caller", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const takeToolEvents = Effect.fnUntraced(function* (toolCallId: string) {
        const node = yield* takeEvent(
          (event) =>
            event.type === "node.updated" && event.node.nativeItemRef?.nativeId === toolCallId,
        );
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId,
        );
        if (node.type !== "node.updated" || item.type !== "turn_item.updated") {
          return yield* Effect.die("Expected tool node and item events");
        }
        return { node: node.node, item: item.turnItem };
      });

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_code",
        toolName: "codemode",
        args: { code: "await read({ path: 'a.ts' })" },
      });
      const caller = yield* takeToolEvents("call_code");
      assert.equal(caller.node.parentNodeId, caller.node.rootNodeId);
      assert.isNull(caller.item.parentItemId);

      const phases = [
        { type: "tool_execution_update", partialResult: { content: [] } },
        { type: "tool_execution_start", args: { path: "a.ts" } },
        {
          type: "tool_execution_end",
          isError: true,
          result: { content: [{ type: "text", text: "ENOENT" }] },
        },
      ] as const;
      for (const phase of phases) {
        yield* fake.emit({
          ...phase,
          toolCallId: "call_code/1",
          toolName: "read",
          parentToolCallId: "call_code",
        });
        const nested = yield* takeToolEvents("call_code/1");
        assert.equal(nested.node.parentNodeId, caller.node.id);
        assert.equal(nested.item.parentItemId, caller.item.id);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "terminalizes parallel tool calls when one call's execution events race its preview",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });

        const firstCall = {
          type: "toolCall",
          id: "call_read",
          name: "read",
          arguments: { path: "first.md" },
        };
        const secondCall = {
          type: "toolCall",
          id: "call_todo",
          name: "todo",
          arguments: { op: "done", task: "second" },
        };
        yield* fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: 0,
            toolCall: firstCall,
          },
        });
        yield* fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: 1,
            toolCall: secondCall,
          },
        });
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_read",
          toolName: "read",
          args: { path: "first.md" },
        });
        yield* fake.emit({
          type: "tool_execution_end",
          toolCallId: "call_read",
          toolName: "read",
          result: { content: [{ type: "text", text: "first result" }] },
          isError: false,
        });

        const dynamicTool = (event: ProviderAdapterV2Event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? event.turnItem
            : undefined;
        const firstResult = dynamicTool(
          yield* takeEvent(
            (event) =>
              dynamicTool(event)?.toolName === "read" && dynamicTool(event)?.status === "completed",
          ),
        );
        assert.isDefined(firstResult);
        assert.equal(firstResult?.toolName, "read");
        assert.deepEqual(firstResult?.input, { path: "first.md" });
        assert.equal(firstResult?.output, "first result");

        // Pi can deliver an update before the start/end pair for a fast parallel
        // call. This marks the preview as executing without setting startedAt.
        yield* fake.emit({
          type: "tool_execution_update",
          toolCallId: "call_todo",
          toolName: "todo",
          partialResult: { content: [{ type: "text", text: "working" }] },
        });
        yield* fake.emit({
          type: "agent_settled",
          messages: [
            {
              role: "toolResult",
              toolCallId: "call_todo",
              toolName: "todo",
              content: [{ type: "text", text: "second result" }],
              isError: false,
            },
          ],
        });

        type DynamicToolTurnItem = Extract<
          Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"],
          { type: "dynamic_tool" }
        >;
        let finalSecondResult: DynamicToolTurnItem | undefined;
        let providerTurnCompleted = false;
        let terminal: Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> | undefined;
        while (terminal === undefined) {
          const event = yield* takeEvent(() => true);
          const toolItem = dynamicTool(event);
          if (toolItem?.toolName === "todo") finalSecondResult = toolItem;
          if (event.type === "provider_turn.updated" && event.providerTurn.status === "completed") {
            providerTurnCompleted = true;
          }
          if (event.type === "turn.terminal") terminal = event;
        }
        assert.equal(finalSecondResult?.toolName, "todo");
        assert.deepEqual(finalSecondResult?.input, { op: "done", task: "second" });
        assert.equal(finalSecondResult?.output, "second result");
        assert.equal(finalSecondResult?.status, "completed");
        assert.isTrue(providerTurnCompleted && terminal.status === "completed");
        assert.equal(firstResult?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("does not leave a previewed tool call running when it never executes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: {
            content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
          },
        },
      });
      yield* fake.emit({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
      });
      yield* fake.emit({ type: "agent_settled" });
      const ended = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "interrupted",
      );
      assert.isTrue(
        ended.type === "turn_item.updated" &&
          ended.turnItem.status === "interrupted" &&
          ended.turnItem.completedAt !== null &&
          ended.turnItem.startedAt === null,
      );
      const providerTurn = yield* takeEvent(
        (event) => event.type === "provider_turn.updated" && event.providerTurn.status === "failed",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        providerTurn.type === "provider_turn.updated" &&
          terminal.type === "turn.terminal" &&
          terminal.status === "failed",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("streams OMP child-agent previews and transcript files onto subagent items", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const overlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
      const overlayEvents = yield* Queue.unbounded<OrchestrationV2ThreadLiveItem>();
      yield* overlay.items(THREAD_ID).pipe(
        Stream.runForEach((item) => Queue.offer(overlayEvents, item)),
        Effect.forkScoped,
      );
      yield* overlay.view(THREAD_ID);
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent, emitted } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const defaultSubscription = yield* fake.takeRequest("set_subagent_subscription");
      assert.equal(defaultSubscription["level"], "progress");
      const viewingSubscription = yield* fake.takeRequest("set_subagent_subscription");
      assert.equal(viewingSubscription["level"], "events");
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const progressEntry = {
        index: 0,
        id: "0-Scout",
        agent: "scout",
        task: "map the repo",
        status: "running",
        recentOutput: ["reading files"],
        recentTools: [],
        toolCount: 0,
      };
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_task",
        toolName: "task",
        partialResult: {
          content: [{ type: "text", text: "running" }],
          details: { results: [], progress: [progressEntry] },
        },
      });
      const subagentItem = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "subagent"
          ? event.turnItem
          : undefined;
      const takeOverlayItem = (predicate: (item: OrchestrationV2ThreadLiveItem) => boolean) =>
        Effect.race(
          Effect.gen(function* () {
            while (true) {
              const item = yield* Queue.take(overlayEvents);
              if (predicate(item)) return item;
            }
          }),
          Effect.forever(
            TestClock.adjust(Duration.millis(10)).pipe(Effect.andThen(Effect.yieldNow)),
          ),
        );
      const takeAvailableEvents = Effect.gen(function* () {
        const available: Array<ProviderAdapterV2Event> = [];
        let next = yield* Queue.poll(emitted);
        while (Option.isSome(next)) {
          available.push(next.value);
          next = yield* Queue.poll(emitted);
        }
        return available;
      });
      const running = subagentItem(yield* takeEvent((event) => subagentItem(event) !== undefined));
      assert.equal(running?.status, "running");
      assert.equal(running?.progress, "reading files");

      yield* fake.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "0-Scout",
          agent: "scout",
          status: "started",
          sessionFile: "/tmp/omp/child.jsonl",
          parentToolCallId: "call_task",
          index: 0,
        },
      });
      const lifecycleItem = subagentItem(
        yield* takeEvent((event) => subagentItem(event)?.transcriptFile === "/tmp/omp/child.jsonl"),
      );
      assert.isUndefined(lifecycleItem?.liveContent);
      yield* takeAvailableEvents;
      yield* fake.emit({
        type: "subagent_event",
        payload: {
          id: "0-Scout",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: "layout",
              partial: { content: [{ type: "thinking", thinking: "Considering layout" }] },
            },
          },
        },
      });
      const thinking = yield* takeOverlayItem(
        (item) => item.kind === "subagent-live" && item.liveContent?.kind === "reasoning",
      );
      assert.equal(thinking.kind, "subagent-live");
      assert.equal(
        thinking.kind === "subagent-live" ? thinking.turnItemId : null,
        lifecycleItem?.id,
      );
      assert.deepEqual(thinking.kind === "subagent-live" ? thinking.liveContent : null, {
        kind: "reasoning",
        text: "Considering layout",
      });
      assert.isUndefined(running?.liveContent);
      assert.equal(lifecycleItem?.transcriptFile, "/tmp/omp/child.jsonl");
      const persistedEventsAfterThinking = yield* takeAvailableEvents;
      assert.isFalse(
        persistedEventsAfterThinking.some(
          (event) => subagentItem(event)?.liveContent !== undefined,
        ),
      );

      const longAnswer = `${"x".repeat(9_000)}END`;
      yield* fake.emit({
        type: "subagent_event",
        payload: {
          id: "0-Scout",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "END",
              partial: {
                content: [{ type: "text", text: longAnswer }],
              },
            },
          },
        },
      });
      const answering = yield* takeOverlayItem(
        (item) => item.kind === "subagent-live" && item.liveContent?.kind === "assistant",
      );
      const answeringContent = answering.kind === "subagent-live" ? answering.liveContent : null;
      assert.equal(answeringContent?.truncated, true);
      assert.equal(answeringContent?.text.length, 8_192);
      assert.isTrue(answeringContent?.text.endsWith("END"));

      const persistedEventsAfterAnswer = yield* takeAvailableEvents;
      assert.isFalse(
        persistedEventsAfterAnswer.some((event) => subagentItem(event)?.liveContent !== undefined),
      );
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_task",
        toolName: "task",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            results: [{ ...progressEntry, status: undefined, exitCode: 0, output: "one file" }],
          },
        },
      });
      const done = subagentItem(
        yield* takeEvent((event) => subagentItem(event)?.status === "completed"),
      );
      assert.equal(done?.result, "one file");
      assert.isUndefined(done?.liveContent);
      assert.equal(done?.transcriptFile, "/tmp/omp/child.jsonl");
      const cleared = yield* takeOverlayItem(
        (item) => item.kind === "subagent-live" && item.liveContent === null,
      );
      assert.equal(cleared.kind, "subagent-live");
      const subscriptions = fake
        .allRequests()
        .filter((request) => request["type"] === "set_subagent_subscription")
        .map((request) => request["level"]);
      assert.deepEqual(subscriptions, ["progress", "events"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("switches OMP subagent detail after a viewer's fifteen-second linger", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, undefined, OMP_DIALECT);
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "progress");
      const overlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
      const viewer = yield* Effect.scoped(
        overlay.view(THREAD_ID).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "events");
      yield* Fiber.interrupt(viewer);
      yield* TestClock.adjust(Duration.seconds(15));
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "progress");
    }).pipe(Effect.scoped, Effect.provide(layerTestWithTestClock)),
  );

  it.effect("rate-limits OMP token events for sixty seconds", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const overlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
      const overlayEvents = yield* Queue.unbounded<OrchestrationV2ThreadLiveItem>();
      yield* overlay.items(THREAD_ID).pipe(
        Stream.runForEach((item) => Queue.offer(overlayEvents, item)),
        Effect.forkScoped,
      );
      const viewer = yield* Effect.scoped(
        overlay.view(THREAD_ID).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, undefined, OMP_DIALECT);
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "progress");
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "events");
      for (let index = 0; index < 201; index += 1) {
        yield* fake.emit({
          type: "subagent_event",
          payload: {
            id: "guard-test",
            event: {
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                partial: { content: [{ type: "text", text: "x" }] },
              },
            },
          },
        });
      }
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "progress");
      const rateLimitedMode = yield* Effect.gen(function* () {
        while (true) {
          const item = yield* Queue.take(overlayEvents);
          if (item.kind === "live-mode" && item.reason === "rate-limited") return item;
        }
      });
      assert.equal(rateLimitedMode.mode, "progress");
      yield* TestClock.adjust(Duration.seconds(60));
      assert.equal((yield* fake.takeRequest("set_subagent_subscription"))["level"], "events");
      yield* Fiber.interrupt(viewer);
    }).pipe(Effect.scoped, Effect.provide(layerTestWithTestClock)),
  );
  it.effect("normalizes nested OMP progress identity and reported metadata", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent, takeFlushedEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_task",
        toolName: "task",
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_task",
        toolName: "task",
        isError: false,
        result: {
          content: [{ type: "text", text: "Spawned reviewer" }],
          details: {
            progress: [],
            async: { state: "running", jobId: "child-session-3", type: "task" },
          },
        },
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed",
      );

      const subagentItem = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "subagent"
          ? event.turnItem
          : undefined;
      const nativeId = "child-session-3";
      yield* fake.emit({
        type: "subagent_progress",
        payload: {
          index: 3,
          agent: "reviewer",
          agentSource: "extension",
          task: "review the route handler",
          parentToolCallId: "call_task",
          sessionFile: "/tmp/omp/reviewer.jsonl",
          progress: {
            id: nativeId,
            agent: "reviewer",
            status: "pending",
            task: "review the route handler",
            description: "Route review",
            durationMs: 0,
          },
        },
      });
      const pending = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "subagent",
      );
      const pendingItem = subagentItem(pending);
      if (pendingItem === undefined) {
        return yield* Effect.die("Expected the pending OMP subagent timeline item");
      }
      const stableSubagentId = pendingItem.subagentId;
      assert.equal(pendingItem?.status, "pending");
      assert.isNull(pendingItem?.startedAt);
      assert.equal(pendingItem?.title, "child-session-3");
      assert.equal(pendingItem?.prompt, "review the route handler");

      const args = "x".repeat(600);
      yield* fake.emit({
        type: "subagent_progress",
        payload: {
          index: 3,
          agent: "reviewer",
          agentSource: "extension",
          task: "review the route handler",
          parentToolCallId: "call_task",
          sessionFile: "/tmp/omp/reviewer.jsonl",
          progress: {
            id: nativeId,
            agent: "reviewer",
            status: "running",
            task: "review the route handler",
            description: "Route review",
            durationMs: 8_000,
            currentTool: "read_file",
            currentToolIntent: "Locate the route handler",
            currentToolArgs: args,
            completionPercent: 62,
            resolvedModel: "anthropic/claude-sonnet-5",
            retryState: {
              attempt: 2,
              maxAttempts: 5,
              delayMs: 30_000,
              errorMessage: "Rate limited",
              startedAtMs: 1_800_000_000_000,
            },
          },
        },
      });
      const runningSubagentEvent = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.id === stableSubagentId,
      );
      if (runningSubagentEvent.type !== "subagent.updated") {
        return yield* Effect.die("Expected the OMP subagent projection");
      }
      assert.equal(runningSubagentEvent.subagent.status, "running");
      assert.equal(runningSubagentEvent.subagent.prompt, "review the route handler");
      const runningEvent = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.subagentId === stableSubagentId,
      );
      if (runningEvent.type !== "turn_item.updated" || runningEvent.turnItem.type !== "subagent") {
        return yield* Effect.die("Expected the OMP subagent timeline item");
      }
      assert.equal(runningEvent.turnItem.status, "running");
      const running = runningEvent.turnItem;
      assert.equal(running.id, pending.type === "turn_item.updated" ? pending.turnItem.id : null);
      assert.equal(running.title, "child-session-3");
      assert.equal(running.prompt, "review the route handler");
      assert.equal(running.nativeAgentId, nativeId);
      assert.equal(running.agentType, "reviewer");
      assert.equal(running.completionPercent, 62);
      assert.deepEqual(running.currentTool, {
        name: "read_file",
        intent: "Locate the route handler",
        argsPreview: "x".repeat(240),
      });
      assert.deepEqual(running.retry, {
        attempt: 2,
        delayMs: 30_000,
        message: "Rate limited",
      });
      assert.equal(runningSubagentEvent.subagent.nativeAgentId, nativeId);
      assert.equal(runningSubagentEvent.subagent.agentType, "reviewer");
      assert.equal(runningSubagentEvent.subagent.completionPercent, 62);
      assert.equal(runningSubagentEvent.subagent.model, "anthropic/claude-sonnet-5");
      assert.deepEqual(runningSubagentEvent.subagent.currentTool, {
        name: "read_file",
        intent: "Locate the route handler",
        argsPreview: "x".repeat(240),
      });
      assert.deepEqual(runningSubagentEvent.subagent.retry, {
        attempt: 2,
        delayMs: 30_000,
        message: "Rate limited",
      });
      yield* TestClock.adjust(Duration.millis(1_000));
      fake.queueState({ isSettled: true });
      yield* fake.emit({
        type: "agent_end",
        messages: [],
        isTerminal: true,
        willRetry: false,
      });
      yield* takeFlushedEvent((event) => event.type === "turn.terminal");
      yield* fake.emit({
        type: "subagent_progress",
        payload: {
          index: 3,
          agent: "reviewer",
          agentSource: "extension",
          task: "review the route handler",
          parentToolCallId: "call_task",
          sessionFile: "/tmp/omp/reviewer.jsonl",
          progress: {
            id: nativeId,
            agent: "reviewer",
            status: "completed",
            task: "review the route handler",
            description: "Route review",
            durationMs: 9_000,
            resolvedModel: "anthropic/claude-sonnet-5",
          },
        },
      });
      const completedEvent = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.subagentId === stableSubagentId,
      );
      if (
        completedEvent.type !== "turn_item.updated" ||
        completedEvent.turnItem.type !== "subagent"
      ) {
        return yield* Effect.die("Expected the late OMP child completion");
      }
      assert.equal(completedEvent.turnItem.status, "completed");
      assert.equal(completedEvent.turnItem.id, running.id);
      assert.equal(completedEvent.turnItem.runId, RunId.make(`run:${THREAD_ID}:1`));
      assert.equal(completedEvent.turnItem.startedAt, running.startedAt);
      assert.equal(
        DateTime.toEpochMillis(completedEvent.turnItem.completedAt!) -
          DateTime.toEpochMillis(completedEvent.turnItem.startedAt!),
        9_000,
      );
      yield* fake.emit({
        type: "subagent_progress",
        payload: {
          index: 4,
          agent: "reviewer",
          task: "check another route",
          parentToolCallId: "call_task",
          progress: {
            id: "child-session-4",
            agent: "reviewer",
            status: "completed",
            task: "check another route",
            description: "Second route review",
          },
        },
      });
      const unknownElapsedEvent = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.nativeAgentId === "child-session-4",
      );
      if (
        unknownElapsedEvent.type !== "turn_item.updated" ||
        unknownElapsedEvent.turnItem.type !== "subagent"
      ) {
        return yield* Effect.die("Expected the terminal OMP child snapshot");
      }
      assert.equal(unknownElapsedEvent.turnItem.status, "completed");
      assert.isNull(unknownElapsedEvent.turnItem.startedAt);
      assert.isNotNull(unknownElapsedEvent.turnItem.completedAt);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("persists only native OMP notices and IRC relays without reviving ended roots", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: { role: "user", content: '<irc from="fake">not a native relay</irc>' },
      });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_exec",
        toolName: "exec",
        args: { command: "echo '<irc notice>'" },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_exec",
        toolName: "exec",
        isError: false,
        result: { content: [{ type: "text", text: '<irc from="fake">tool output</irc>' }] },
      });

      const noticeEvent = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? event.turnItem
          : undefined;
      yield* fake.emit({
        type: "notice",
        level: "warning",
        source: "native-test",
        message: "Native warning",
      });
      const nativeNoticeEvent = yield* takeEvent((event) => noticeEvent(event) !== undefined);
      const nativeItem = noticeEvent(nativeNoticeEvent);
      assert.equal(nativeItem?.message, "Native warning");
      assert.equal(nativeItem?.runId, RunId.make(`run:${THREAD_ID}:1`));
      assert.isNotNull(nativeItem?.providerTurnId);
      assert.equal(nativeItem?.nativeLevel, "warning");
      assert.equal(nativeItem?.nativeSource, "native-test");

      yield* fake.emit({
        type: "irc_message",
        message: {
          role: "custom",
          customType: "irc:relay",
          content: "[IRC Scout → team] Native body",
          details: { from: "Scout", to: "team", body: "Native body" },
          timestamp: 1_800_000_000_000,
        },
      });
      const relayEvent = yield* takeEvent((event) => noticeEvent(event) !== undefined);
      const relay = noticeEvent(relayEvent);
      assert.equal(relay?.message, "Native body");
      assert.equal(relay?.runId, RunId.make(`run:${THREAD_ID}:1`));
      assert.deepEqual(relay?.irc, { from: "Scout", to: "team" });
      assert.isNotNull(relay?.startedAt);
      assert.isNotNull(relay?.completedAt);
      if (relay?.startedAt == null || relay.completedAt == null) {
        return yield* Effect.die("Expected the native IRC timestamp on the notice");
      }
      assert.equal(DateTime.toEpochMillis(relay.startedAt), 1_800_000_000_000);
      assert.equal(DateTime.toEpochMillis(relay.completedAt), 1_800_000_000_000);
      assert.equal(DateTime.toEpochMillis(relay.updatedAt), 1_800_000_000_000);
      assert.isTrue((nativeItem?.ordinal ?? -1) < (relay?.ordinal ?? -1));

      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* fake.emit({
        type: "irc_message",
        message: {
          role: "custom",
          customType: "irc:relay",
          content: "[IRC Scout → team] Idle body",
          details: { from: "Scout", to: "team", body: "Idle body" },
          timestamp: 1_800_000_000_001,
        },
      });
      const idleRelayEvent = yield* takeEvent((event) => noticeEvent(event) !== undefined);
      const idleRelay = noticeEvent(idleRelayEvent);
      assert.equal(idleRelay?.message, "Idle body");
      assert.isNull(idleRelay?.runId);
      assert.isNull(idleRelay?.providerTurnId);
      assert.isNull(idleRelay?.nodeId);
      assert.isTrue(idleRelay?.id !== nativeItem?.id);

      yield* fake.emit({
        type: "notice",
        level: "info",
        source: "after-root",
        message: "Idle notice",
      });
      const idleNoticeEvent = yield* takeEvent(
        (event) =>
          noticeEvent(event) !== undefined ||
          (event.type === "provider_turn.updated" && event.providerTurn.status === "running"),
      );
      const idleNotice = noticeEvent(idleNoticeEvent);
      assert.equal(idleNotice?.message, "Idle notice");
      assert.isNull(idleNotice?.runId);
      assert.isNull(idleNotice?.providerTurnId);
      assert.isNull(idleNotice?.nodeId);
      assert.isTrue(idleNotice?.id !== nativeItem?.id);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps an async OMP task call completed while its background subagent finishes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const progressEntry = { index: 0, id: "Scout", agent: "scout", task: "read package.json" };
      const taskItem = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.toolName === "task"
          ? event.turnItem
          : undefined;
      const subagentItem = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "subagent"
          ? event.turnItem
          : undefined;
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_async_task",
        toolName: "task",
        args: { tasks: [{ id: "Scout", assignment: "read package.json" }] },
      });
      // The async call returns at once; the job keeps reporting on the same tool call id.
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_async_task",
        toolName: "task",
        isError: false,
        result: {
          content: [{ type: "text", text: "Spawned agent `Scout` (job `Scout`)." }],
          details: {
            results: [],
            progress: [{ ...progressEntry, status: "pending" }],
            async: { state: "running", jobId: "Scout", type: "task" },
          },
        },
      });
      assert.equal(
        taskItem(yield* takeEvent((event) => taskItem(event)?.status === "completed"))?.status,
        "completed",
      );
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_async_task",
        toolName: "task",
        partialResult: {
          content: [{ type: "text", text: "Running background task Scout..." }],
          details: {
            results: [],
            progress: [{ ...progressEntry, status: "running", recentOutput: ["reading"] }],
            async: { state: "running", jobId: "Scout", type: "task" },
          },
        },
      });
      const running = yield* takeEvent(
        (event) => taskItem(event) !== undefined || subagentItem(event) !== undefined,
      );
      assert.equal(subagentItem(running)?.status, "running");
      // Once the agent yields, OMP sends no further tool updates; the job's
      // result arrives as an `async-result` delivery that starts a new agent run.
      yield* fake.emit({ type: "agent_start" });
      const asyncMessage = {
        id: "native-async-message-scout",
        role: "custom",
        customType: "async-result",
        content:
          '<system-notice>\nBackground job Scout has completed.\n<task-result id="Scout" agent="task" status="completed" duration="4.0s">\n<meta lines="1" size="9B" />\n<output>\n@t3tools\n</output>\n</task-result>\n</system-notice>',
        timestamp: 1_800_000_000_000,
        details: {
          jobs: [
            {
              jobId: "Scout",
              type: "task",
              agentId: "native-scout",
              label: "Scout",
              durationMs: 4_000,
            },
          ],
        },
      };
      yield* fake.emit({ type: "message_end", message: asyncMessage });
      yield* fake.emit({ type: "custom_message", message: asyncMessage });
      yield* fake.emit({
        type: "notice",
        timestamp: 1_800_000_000_001,
        message: "after-active-async-sentinel",
      });
      type SystemNoticeTurnItem = Extract<
        Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"],
        { type: "system_notice" }
      >;
      let completionNotice: SystemNoticeTurnItem | undefined;
      let completionNoticeCount = 0;
      let finished: ReturnType<typeof subagentItem> = undefined;
      let sentinelSeen = false;
      const systemNotice = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? event.turnItem
          : undefined;
      while (!sentinelSeen || finished?.status !== "completed") {
        const event = yield* takeEvent(() => true);
        const notice = systemNotice(event);
        if (notice?.jobCompletion?.jobId === "Scout") {
          completionNoticeCount += 1;
          completionNotice ??= notice;
        }
        const finishedItem = subagentItem(event);
        if (finishedItem?.status === "completed") finished = finishedItem;
        sentinelSeen = notice?.message === "after-active-async-sentinel";
      }
      assert.equal(finished?.status, "completed");
      assert.equal(finished?.id, subagentItem(running)?.id);
      assert.equal(finished?.result, "@t3tools");
      assert.equal(completionNoticeCount, 1);
      assert.isDefined(completionNotice);
      assert.equal(completionNotice?.jobCompletion?.type, "task");
      assert.equal(completionNotice?.jobCompletion?.agentId, "native-scout");
      assert.equal(completionNotice?.jobCompletion?.label, "Scout");
      assert.equal(completionNotice?.jobCompletion?.durationMs, 4_000);
      assert.isNotNull(completionNotice?.runId);
      assert.isNotNull(completionNotice?.providerTurnId);
      assert.isNotNull(completionNotice?.nodeId);
      assert.isTrue(completionNotice?.message.startsWith("Background job completed"));
      assert.equal(DateTime.toEpochMillis(completionNotice!.startedAt!), 1_800_000_000_000);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "does not reuse prior activation timing for a new native task activation without timing metadata",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        yield* fake.emit({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
        });
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          OMP_DIALECT,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_activation_timing",
          toolName: "task",
          args: { tasks: [{ task: "inspect activation timing" }] },
        });

        const takePair = (id: string) =>
          Effect.gen(function* () {
            const canonicalEvent = yield* takeEvent(
              (event) => event.type === "subagent.updated" && event.subagent.nativeAgentId === id,
            );
            if (canonicalEvent.type !== "subagent.updated") {
              return yield* Effect.die("Expected the native subagent update");
            }
            const turnItemEvent = yield* takeEvent(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "subagent" &&
                event.turnItem.nativeAgentId === id,
            );
            if (
              turnItemEvent.type !== "turn_item.updated" ||
              turnItemEvent.turnItem.type !== "subagent"
            ) {
              return yield* Effect.die("Expected the native subagent turn item");
            }
            return { canonical: canonicalEvent.subagent, turnItem: turnItemEvent.turnItem };
          });

        const startedAtMs = 1_800_000_000_000;
        const completedAtMs = 1_800_000_009_000;
        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-activation-first",
            agent: "scout",
            parentToolCallId: "call_activation_timing",
            index: 0,
            startedAt: startedAtMs,
            progress: { status: "running", requests: 4 },
          },
        });
        const firstAttempt = yield* takePair("job-activation-first");
        assert.equal(DateTime.toEpochMillis(firstAttempt.turnItem!.startedAt!), startedAtMs);
        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-activation-first",
            parentToolCallId: "call_activation_timing",
            index: 0,
            startedAt: startedAtMs + 60_000,
            progress: { status: "running", requests: 5 },
          },
        });
        const repeatedUpdate = yield* takePair("job-activation-first");
        assert.equal(DateTime.toEpochMillis(repeatedUpdate.turnItem!.startedAt!), startedAtMs);
        assert.equal(DateTime.toEpochMillis(repeatedUpdate.canonical!.startedAt!), startedAtMs);

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-activation-first",
            parentToolCallId: "call_activation_timing",
            index: 0,
            completedAt: completedAtMs,
            durationMs: 4_000,
            progress: { status: "completed" },
          },
        });
        const firstCompletion = yield* takePair("job-activation-first");
        assert.equal(firstCompletion.turnItem?.status, "completed");
        assert.equal(DateTime.toEpochMillis(firstCompletion.turnItem!.startedAt!), startedAtMs);
        assert.equal(DateTime.toEpochMillis(firstCompletion.turnItem!.completedAt!), completedAtMs);

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-activation-second",
            agent: "scout",
            parentToolCallId: "call_activation_timing",
            index: 0,
            progress: { status: "running" },
          },
        });
        const secondAttempt = yield* takePair("job-activation-second");
        assert.equal(secondAttempt.turnItem?.status, "running");
        assert.isNull(secondAttempt.turnItem?.startedAt);
        assert.isNull(secondAttempt.turnItem?.completedAt);
        assert.isUndefined(secondAttempt.turnItem?.metrics);
        assert.isNull(secondAttempt.canonical?.startedAt);
        assert.isNull(secondAttempt.canonical?.completedAt);
        assert.isUndefined(secondAttempt.canonical?.metrics);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "applies late terminal native child usage metrics without changing known completion state",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        yield* fake.emit({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
        });
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          OMP_DIALECT,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_late_usage",
          toolName: "task",
          args: { tasks: [{ task: "inspect late child usage" }] },
        });

        const takePair = () =>
          Effect.gen(function* () {
            const canonicalEvent = yield* takeEvent(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeAgentId === "job-late-usage",
            );
            if (canonicalEvent.type !== "subagent.updated") {
              return yield* Effect.die("Expected the native subagent update");
            }
            const turnItemEvent = yield* takeEvent(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "subagent" &&
                event.turnItem.nativeAgentId === "job-late-usage",
            );
            if (
              turnItemEvent.type !== "turn_item.updated" ||
              turnItemEvent.turnItem.type !== "subagent"
            ) {
              return yield* Effect.die("Expected the native subagent turn item");
            }
            return { canonical: canonicalEvent.subagent, turnItem: turnItemEvent.turnItem };
          });

        const startedAtMs = 1_800_000_000_000;
        const completedAtMs = 1_800_000_009_000;
        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-late-usage",
            agent: "scout",
            parentToolCallId: "call_late_usage",
            index: 0,
            startedAt: startedAtMs,
            progress: { status: "running", requests: 7 },
          },
        });
        const running = yield* takePair();
        assert.equal(DateTime.toEpochMillis(running.turnItem!.startedAt!), startedAtMs);

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-late-usage",
            parentToolCallId: "call_late_usage",
            index: 0,
            completedAt: completedAtMs,
            usage: { cost: { total: 0.23 } },
            progress: { status: "completed", requests: 7 },
          },
        });
        const completed = yield* takePair();
        assert.equal(completed.turnItem?.status, "completed");
        assert.equal(DateTime.toEpochMillis(completed.turnItem!.completedAt!), completedAtMs);
        assert.deepEqual(completed.turnItem?.metrics, { requests: 7, cost: 0.23 });

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-late-usage",
            parentToolCallId: "call_late_usage",
            index: 0,
            usage: { cost: { total: 0 } },
            progress: { status: "completed" },
          },
        });
        const lateUsage = yield* takePair();
        const terminalMetrics = { requests: 7, cost: 0 };
        assert.equal(lateUsage.canonical?.status, "completed");
        assert.equal(lateUsage.turnItem?.status, "completed");
        assert.equal(DateTime.toEpochMillis(lateUsage.turnItem!.startedAt!), startedAtMs);
        assert.equal(DateTime.toEpochMillis(lateUsage.turnItem!.completedAt!), completedAtMs);
        assert.equal(DateTime.toEpochMillis(lateUsage.turnItem!.updatedAt), completedAtMs);
        assert.deepEqual(lateUsage.canonical?.metrics, terminalMetrics);
        assert.deepEqual(lateUsage.turnItem?.metrics, terminalMetrics);
        assert.equal(DateTime.toEpochMillis(lateUsage.canonical!.startedAt!), startedAtMs);
        assert.equal(DateTime.toEpochMillis(lateUsage.canonical!.completedAt!), completedAtMs);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps an OMP task name stable across progress, wait, and result records", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      const nativeAgentId = "0-ResponseFinish";
      const name = "ResponseFinish";
      const task = "Capture responsive response themes";
      const description = "Capturing responsive response themes";
      const takeSubagent = () =>
        Effect.gen(function* () {
          const event = yield* takeEvent(
            (event) =>
              event.type === "subagent.updated" && event.subagent.nativeAgentId === nativeAgentId,
          );
          if (event.type !== "subagent.updated") {
            return yield* Effect.die("Expected an OMP subagent update");
          }
          return event.subagent;
        });

      const progressEntry = {
        index: 0,
        id: nativeAgentId,
        agent: "task",
        agentSource: "project",
        status: "running",
        task,
        assignment: task,
        description,
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        requests: 0,
        tokens: 0,
        cost: 0,
        durationMs: 1,
      };
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_title",
        toolName: "task",
        args: { tasks: [{ name, agent: "task", task }] },
      });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_title",
        toolName: "task",
        partialResult: {
          content: [{ type: "text", text: "Running" }],
          details: { results: [], progress: [progressEntry] },
        },
      });
      const toolProgress = yield* takeSubagent();

      yield* fake.emit({
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "task",
          agentSource: "project",
          task,
          assignment: task,
          parentToolCallId: "call_title",
          progress: progressEntry,
        },
      });
      const progress = yield* takeSubagent();

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_wait",
        toolName: "wait",
        args: { jobId: nativeAgentId },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_wait",
        toolName: "wait",
        isError: false,
        result: {
          content: [{ type: "text", text: "Still running" }],
          details: {
            jobs: [
              {
                id: nativeAgentId,
                type: "task",
                status: "running",
                label: nativeAgentId,
                durationMs: 100,
                parentToolCallId: "call_title",
              },
            ],
          },
        },
      });
      const waiting = yield* takeSubagent();

      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_title",
        toolName: "task",
        isError: false,
        result: {
          content: [{ type: "text", text: "Finished" }],
          details: {
            results: [
              {
                index: 0,
                id: nativeAgentId,
                agent: "task",
                agentSource: "project",
                status: "completed",
                task,
                assignment: task,
                description,
                exitCode: 0,
                output: "Finished",
                durationMs: 150,
              },
            ],
          },
        },
      });
      const result = yield* takeSubagent();

      assert.deepEqual(
        [toolProgress.title, progress.title, waiting.title, result.title],
        [name, name, name, name],
      );
      assert.equal(progress.agentType, "task");
      assert.equal(progress.prompt, task);
      assert.equal(result.agentType, "task");
      assert.equal(result.prompt, task);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "preserves native Task metrics through progress, terminal results, and a new activation",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        yield* fake.emit({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
        });
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          OMP_DIALECT,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_metrics",
          toolName: "task",
          args: { tasks: [{ task: "inspect metrics" }] },
        });
        const nativeAgentId = "job-metrics";
        const canonicalAgent = (event: ProviderAdapterV2Event, agentId = nativeAgentId) =>
          event.type === "subagent.updated" && event.subagent.nativeAgentId === agentId
            ? event.subagent
            : undefined;
        const subagentItem = (event: ProviderAdapterV2Event, agentId = nativeAgentId) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.nativeAgentId === agentId
            ? event.turnItem
            : undefined;
        const takeAgentPair = (agentId = nativeAgentId) =>
          Effect.gen(function* () {
            const canonical = canonicalAgent(
              yield* takeEvent((event) => canonicalAgent(event, agentId) !== undefined),
              agentId,
            );
            const turnItem = subagentItem(
              yield* takeEvent((event) => subagentItem(event, agentId) !== undefined),
              agentId,
            );
            return { canonical, turnItem };
          });

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: nativeAgentId,
            agent: "scout",
            parentToolCallId: "call_metrics",
            index: 0,
            progress: {
              status: "running",
              task: "inspect metrics",
              toolCount: 5,
              requests: 3,
              tokens: 150,
              contextTokens: 45,
              contextWindow: 200,
              cost: 0.04,
            },
          },
        });
        const initial = yield* takeAgentPair();
        const initialMetrics = {
          toolCount: 5,
          requests: 3,
          tokens: 150,
          contextTokens: 45,
          contextWindow: 200,
          cost: 0.04,
        };
        assert.deepEqual(initial.canonical?.metrics, initialMetrics);
        assert.deepEqual(initial.turnItem?.metrics, initialMetrics);

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: nativeAgentId,
            parentToolCallId: "call_metrics",
            index: 0,
            progress: {
              status: "running",
              requests: 4,
              contextTokens: 0,
            },
          },
        });
        const partial = yield* takeAgentPair();
        const mergedMetrics = { ...initialMetrics, requests: 4, contextTokens: 0 };
        assert.deepEqual(partial.canonical?.metrics, mergedMetrics);
        assert.deepEqual(partial.turnItem?.metrics, mergedMetrics);

        yield* fake.emit({
          type: "tool_execution_end",
          toolCallId: "call_metrics",
          toolName: "task",
          isError: false,
          result: {
            content: [{ type: "text", text: "finished" }],
            details: {
              results: [
                {
                  id: nativeAgentId,
                  status: "completed",
                  requests: 8,
                  tokens: 250,
                  contextTokens: 70,
                  contextWindow: 300,
                  usage: { cost: { total: 0.17 } },
                },
              ],
            },
          },
        });
        const terminal = yield* takeAgentPair();
        const terminalMetrics = {
          toolCount: 5,
          requests: 8,
          tokens: 250,
          contextTokens: 70,
          contextWindow: 300,
          cost: 0.17,
        };
        assert.equal(terminal.turnItem?.status, "completed");
        assert.deepEqual(terminal.canonical?.metrics, terminalMetrics);
        assert.deepEqual(terminal.turnItem?.metrics, terminalMetrics);

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-metrics-next",
            agent: "scout",
            parentToolCallId: "call_metrics",
            index: 0,
            progress: { status: "running", toolCount: 2 },
          },
        });
        const nextActivation = yield* takeAgentPair("job-metrics-next");
        assert.equal(nextActivation.turnItem?.status, "running");
        assert.deepEqual(nextActivation.canonical?.metrics, { toolCount: 2 });
        assert.deepEqual(nextActivation.turnItem?.metrics, { toolCount: 2 });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "links native child items to their actual parent task items and retains known links",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        yield* fake.emit({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
        });
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          OMP_DIALECT,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        const parentTaskItem = (event: ProviderAdapterV2Event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.toolName === "task"
            ? event.turnItem
            : undefined;
        const childItem = (event: ProviderAdapterV2Event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "subagent"
            ? event.turnItem
            : undefined;
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_parent_a",
          toolName: "task",
          args: { tasks: [{ task: "parent A" }] },
        });
        const parentA = parentTaskItem(
          yield* takeEvent((event) => parentTaskItem(event) !== undefined),
        );
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_parent_b",
          toolName: "task",
          args: { tasks: [{ task: "parent B" }] },
        });
        const parentB = parentTaskItem(
          yield* takeEvent((event) => parentTaskItem(event) !== undefined),
        );

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-parent-a",
            parentToolCallId: "call_parent_a",
            index: 0,
            progress: { status: "running", task: "parent A" },
          },
        });
        const childA = childItem(
          yield* takeEvent((event) => childItem(event)?.nativeAgentId === "job-parent-a"),
        );
        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-parent-b",
            parentToolCallId: "call_parent_b",
            index: 0,
            progress: { status: "running", task: "parent B" },
          },
        });
        const childB = childItem(
          yield* takeEvent((event) => childItem(event)?.nativeAgentId === "job-parent-b"),
        );
        assert.equal(childA?.parentItemId, parentA?.id);
        assert.equal(childB?.parentItemId, parentB?.id);
        assert.notEqual(parentA?.id, parentB?.id);

        yield* fake.emit({
          type: "subagent_progress",
          payload: {
            id: "job-parent-a",
            progress: { status: "running", requests: 2 },
          },
        });
        const partialChildA = childItem(
          yield* takeEvent(
            (event) =>
              childItem(event)?.nativeAgentId === "job-parent-a" &&
              childItem(event)?.metrics?.requests === 2,
          ),
        );
        assert.equal(partialChildA?.parentItemId, parentA?.id);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("records late async job completion once as a runless native notice", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_late_task",
        toolName: "task",
        args: { tasks: [{ task: "finish after the root" }] },
      });
      yield* fake.emit({
        type: "subagent_progress",
        payload: {
          id: "job-actual-17",
          parentToolCallId: "call_late_task",
          index: 0,
          progress: { status: "running", task: "finish after the root" },
        },
      });
      const runningChild = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "subagent" &&
        event.turnItem.nativeAgentId === "job-actual-17"
          ? event.turnItem
          : undefined;
      yield* takeEvent((event) => runningChild(event) !== undefined);

      fake.queueState({
        isSettled: true,
        isStreaming: false,
        isCompacting: false,
        hasPendingAsyncWork: false,
        pendingMessageCount: 0,
      });
      yield* fake.emit({ type: "agent_end", isTerminal: true, willRetry: false });
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Run two remains active",
        undefined,
        2,
      );
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );

      const asyncMessage = {
        role: "custom",
        customType: "async-result",
        timestamp: 1_800_000_000_000,
        content: "parent raw result should not appear in the completion notice",
        details: {
          jobs: [
            {
              jobId: "job-actual-17",
              type: "task",
              status: "completed",
              agentId: "native-agent-17",
              label: "Friendly worker label",
              durationMs: 2_500,
              parentToolCallId: "call_late_task",
            },
            {
              jobId: "job-actual-18",
              type: "task",
              status: "completed",
              agentId: "native-agent-18",
              label: "Friendly worker label",
              durationMs: 1_200,
              parentToolCallId: "call_late_task",
            },
          ],
        },
      };
      yield* fake.emit({ type: "message_end", message: asyncMessage });
      yield* fake.emit({ type: "custom_message", message: asyncMessage });
      yield* fake.emit({
        type: "notice",
        timestamp: 1_800_000_000_001,
        message: "after-async-completion-sentinel",
      });

      type SystemNoticeTurnItem = Extract<
        Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"],
        { type: "system_notice" }
      >;
      type SubagentTurnItem = Extract<
        Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"],
        { type: "subagent" }
      >;
      const completionNotices = new Map<string, SystemNoticeTurnItem>();
      const expectedJobIds: Record<string, true> = {
        "job-actual-17": true,
        "job-actual-18": true,
      };
      let completionNoticeCount = 0;
      let completedChild: SubagentTurnItem | undefined;
      let rootRevived = false;
      let activeRootTerminated = false;
      let sentinelSeen = false;
      const systemNotice = (event: ProviderAdapterV2Event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? event.turnItem
          : undefined;
      while (!sentinelSeen) {
        const event = yield* takeEvent(() => true);
        const notice = systemNotice(event);
        const jobId = notice?.jobCompletion?.jobId;
        if (notice !== undefined && jobId !== undefined && expectedJobIds[jobId] === true) {
          completionNoticeCount += 1;
          completionNotices.set(jobId, notice);
        }
        const child = runningChild(event);
        if (child?.status === "completed") completedChild = child;
        if (event.type === "provider_turn.updated" && event.providerTurn.status === "running") {
          rootRevived = true;
        }
        if (event.type === "turn.terminal") activeRootTerminated = true;
        sentinelSeen = notice?.message === "after-async-completion-sentinel";
      }

      const firstCompletionNotice = completionNotices.get("job-actual-17");
      const secondCompletionNotice = completionNotices.get("job-actual-18");
      assert.equal(completionNoticeCount, 2);
      assert.deepEqual(Array.from(completionNotices.keys()).sort(), [
        "job-actual-17",
        "job-actual-18",
      ]);
      assert.isFalse(rootRevived);
      assert.isFalse(activeRootTerminated);
      assert.equal(completedChild?.status, "completed");
      assert.isDefined(firstCompletionNotice);
      assert.equal(firstCompletionNotice?.jobCompletion?.type, "task");
      assert.equal(firstCompletionNotice?.jobCompletion?.status, "completed");
      assert.equal(firstCompletionNotice?.jobCompletion?.agentId, "native-agent-17");
      assert.equal(firstCompletionNotice?.jobCompletion?.label, "Friendly worker label");
      assert.equal(firstCompletionNotice?.jobCompletion?.durationMs, 2_500);
      assert.equal(firstCompletionNotice?.runId, null);
      assert.equal(firstCompletionNotice?.providerTurnId, null);
      assert.equal(firstCompletionNotice?.nodeId, null);
      assert.isTrue(firstCompletionNotice?.message.startsWith("Background job completed"));
      assert.isTrue(firstCompletionNotice?.message.includes("job-actual-17"));
      assert.isFalse(firstCompletionNotice?.message.includes("Friendly worker label"));
      assert.isFalse(
        firstCompletionNotice?.message.includes("parent raw result should not appear"),
      );
      assert.equal(DateTime.toEpochMillis(firstCompletionNotice!.startedAt!), 1_800_000_000_000);
      assert.equal(secondCompletionNotice?.jobCompletion?.jobId, "job-actual-18");
      assert.equal(secondCompletionNotice?.jobCompletion?.label, "Friendly worker label");
      assert.equal(secondCompletionNotice?.runId, null);
      assert.equal(secondCompletionNotice?.providerTurnId, null);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("persists edit patches, write content, and line counts on file change items", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const patch = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n";
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_edit",
        toolName: "edit",
        args: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_edit",
        toolName: "edit",
        isError: false,
        result: {
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
          details: { diff: "-1 old\n+1 new", patch, firstChangedLine: 1 },
        },
      });
      const edit = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "file_change" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        edit.type === "turn_item.updated" &&
          edit.turnItem.type === "file_change" &&
          edit.turnItem.fileName === "a.ts" &&
          edit.turnItem.diffStr === patch &&
          // File headers are not changed lines; the wire drops the patch but keeps these.
          edit.turnItem.additions === 1 &&
          edit.turnItem.deletions === 1,
      );

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_write",
        toolName: "write",
        args: { path: "b.ts", content: "export {};\n" },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_write",
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: "Successfully wrote to b.ts" }] },
      });
      const write = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "file_change" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        write.type === "turn_item.updated" &&
          write.turnItem.type === "file_change" &&
          write.turnItem.fileName === "b.ts" &&
          write.turnItem.newStr === "export {};\n" &&
          write.turnItem.additions === 1,
      );

      // A failed edit has no patch, so it keeps the error to show when expanded.
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_edit_failed",
        toolName: "edit",
        args: { path: "c.ts", edits: [{ oldText: "missing", newText: "new" }] },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_edit_failed",
        toolName: "edit",
        isError: true,
        result: { content: [{ type: "text", text: "Could not find the text in c.ts." }] },
      });
      const failedEdit = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "file_change" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        failedEdit.type === "turn_item.updated" &&
          failedEdit.turnItem.type === "file_change" &&
          failedEdit.turnItem.diffStr === "Could not find the text in c.ts." &&
          failedEdit.turnItem.additions === undefined,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reports a write to an xd:// tool device as that tool's call, not a file edit", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const args = { title: "Child", task: "Run it", mode: "async" };
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_device",
        toolName: "write",
        args: { path: "xd://mcp__t3-code__delegate_task", content: JSON.stringify(args) },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_device",
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: '{"childThreadId":"thread-child"}' }] },
      });
      const call = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.status === "completed" &&
          (event.turnItem.type === "dynamic_tool" || event.turnItem.type === "file_change"),
      );
      assert.isTrue(call.type === "turn_item.updated" && call.turnItem.type === "dynamic_tool");
      if (call.type !== "turn_item.updated" || call.turnItem.type !== "dynamic_tool") return;
      assert.equal(call.turnItem.toolName, "mcp__t3-code__delegate_task");
      assert.deepEqual(call.turnItem.input, args);
      assert.equal(call.turnItem.output, '{"childThreadId":"thread-child"}');
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps an xd:// tool read as a documentation lookup", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const args = { path: "xd://mcp__t3-code__delegate_task" };
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_device_read",
        toolName: "read",
        args,
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_device_read",
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text: "Usage: delegate_task(...)" }] },
      });
      const lookup = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.status === "completed" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.toolName === "read",
      );
      assert.isTrue(lookup.type === "turn_item.updated" && lookup.turnItem.type === "dynamic_tool");
      if (lookup.type !== "turn_item.updated" || lookup.turnItem.type !== "dynamic_tool") return;
      assert.equal(lookup.turnItem.toolName, "read");
      assert.deepEqual(lookup.turnItem.input, args);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("settles a command-only prompt from its deferred ack and idle probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/command-only");
      yield* fake.takeRequest("prompt");
      // A pure extension command: dialog + notify, then the deferred ack —
      // pi emits no agent_start/agent_settled at all.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-cmd",
        method: "notify",
        message: "done",
        notifyType: "info",
      });
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      // The adapter probes get_state (auto-acked idle by the fake), then
      // settles the turn as completed.
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "publishes root execution end before terminal metadata finalization for Pi and OMP",
    () =>
      Effect.gen(function* () {
        for (const dialect of [PI_DIALECT, OMP_DIALECT]) {
          const fake = yield* makeFakePi;
          if (dialect === OMP_DIALECT) {
            yield* fake.emit({
              type: "ready",
              protocolVersion: 1,
              supportedProtocolVersions: [1, 2],
            });
          }
          const { runtime, takeEvent } = yield* openRuntime(
            fake,
            "default",
            THREAD_ID,
            SESSION_ID,
            undefined,
            dialect,
          );
          const providerThread = yield* runtime.ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
          });
          yield* startTurn(runtime, providerThread);
          yield* fake.takeRequest("prompt");
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit(
            dialect === OMP_DIALECT
              ? { type: "agent_end", isTerminal: true }
              : { type: "agent_settled" },
          );

          const executionEndOrTerminal = yield* takeEvent(
            (event) =>
              String(event.type) === "run.execution-ended" || event.type === "turn.terminal",
          );
          assert.equal(String(executionEndOrTerminal.type), "run.execution-ended");
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("leaves /compacted as an ordinary prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compacted please");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/compacted please");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "compact"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails a compact that never started", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      yield* fake.emit({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "Nothing to compact (session too small)",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("restarts Pi when Stop interrupts a user compact", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("steers /compact as RPC compact instead of a prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "agent_start" });
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer-compact" as never,
          text: "/compact keep the tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const compact = yield* fake.takeRequest("compact");
      assert.equal(compact["customInstructions"], "keep the tests");
      assert.isUndefined(compact["streamingBehavior"]);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "response", command: "compact", success: true });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("persists current xAI capacity text for the thread error banner", () =>
    expectModelFailure("The model is currently at capacity due to high demand."),
  );

  it.effect("persists extension-normalized xAI capacity text for the thread error banner", () =>
    expectModelFailure(
      "Provider overloaded: The model is currently at capacity due to high demand.",
    ),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({ requestId: requestId!, decision: "accept" });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("remembers session approvals only for identical confirmation content", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        decision: "acceptForSession",
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust-again",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response"))["id"], "ui-trust-again");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-other",
        method: "confirm",
        title: "Run project extensions?",
        message: "A different project.",
      });
      const other = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.isTrue(
        other.type === "runtime_request.updated" &&
          other.runtimeRequest.nativeRequestRef?.nativeId === "ui-other",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("offers an explicit empty value for extension input dialogs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-input",
        method: "input",
        title: "Optional value",
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      assert.isTrue(
        event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
        return;
      assert.equal(event.turnItem.questions[0]?.options[0]?.value, "");
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { "ui-input": "" },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["value"], "");
      assert.isUndefined(response["cancelled"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("raises bridge edit confirmations as file-change approvals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      for (const [id, title, requestKind] of [
        ["ui-edit", "Allow edit?", "file-change"],
        ["ui-bash", "Allow bash?", "command"],
        ["ui-ext", "Deploy to staging?", "command"],
      ] as const) {
        yield* fake.emit({ type: "extension_ui_request", id, method: "confirm", title });
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.isTrue(
          item.type === "turn_item.updated" &&
            item.turnItem.type === "approval_request" &&
            item.turnItem.requestKind === requestKind,
          `${title} should be ${requestKind}`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reads a thread snapshot from pi's active branch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueMessages({
        messages: [
          {
            role: "user",
            content: "hello pi",
            timestamp: 1700000000000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello back" }],
            timestamp: 1700000001000,
          },
          { role: "toolResult", content: [] },
        ],
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.messages[0]!.role, "user");
      assert.equal(snapshot.messages[0]!.text, "hello pi");
      assert.equal(snapshot.messages[1]!.role, "assistant");
      assert.equal(snapshot.messages[1]!.text, "hello back");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps snapshot message identities distinct across native sessions", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const first = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const messages = {
        messages: [{ role: "user", content: "same text", timestamp: 1700000000000 }],
      };
      fake.queueMessages(messages);
      const a = yield* runtime.readThreadSnapshot({ providerThread: first });
      fake.queueState({ sessionFile: "/fake/another-session.jsonl" });
      const second = yield* runtime.ensureThread({
        threadId: ThreadId.make("second-thread"),
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: {
          ...first,
          nativeThreadRef: {
            driver: PI_PROVIDER,
            nativeId: "/fake/another-session.jsonl",
            strength: "strong",
          },
        },
      });
      fake.queueMessages(messages);
      const b = yield* runtime.readThreadSnapshot({ providerThread: second });
      assert.notEqual(a.messages[0]!.id, b.messages[0]!.id);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects a nonpersistent session UUID instead of treating it as a resumable path", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      // A --no-session Pi keeps its session in memory and reports no file.
      fake.queueState({ sessionFile: undefined });
      const result = yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps a settled turn's late prompt rejection off the next turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // An extension command can hold its prompt ack open past settlement.
      yield* startTurn(runtime, providerThread, "default", [], "/my-command");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const firstTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(firstTerminal.type === "turn.terminal" && firstTerminal.status === "completed");

      yield* startTurn(runtime, providerThread, "default", [], "Second turn", undefined, 2);
      yield* fake.takeRequest("prompt");
      // The rejection answers the first turn's prompt. It must not consume or
      // fail the second turn's prompt acknowledgement.
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "late command rejection",
      });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const secondTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        secondTerminal.type === "turn.terminal" && secondTerminal.status === "completed",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows compaction progress and completes the same activity row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });

      const runningNode = yield* takeEvent(
        (event) => event.type === "node.updated" && event.node.kind === "system",
      );
      const runningItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        runningNode.type === "node.updated" &&
          runningNode.node.status === "running" &&
          runningItem.type === "turn_item.updated" &&
          runningItem.turnItem.type === "compaction" &&
          runningItem.turnItem.status === "running" &&
          runningItem.turnItem.title === "Compacting context...",
      );

      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 200_000, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      const completedNode = yield* takeEvent(
        (event) => event.type === "node.updated" && event.node.kind === "system",
      );
      const completedItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        runningNode.type === "node.updated" &&
          completedNode.type === "node.updated" &&
          runningItem.type === "turn_item.updated" &&
          runningItem.turnItem.type === "compaction" &&
          completedItem.type === "turn_item.updated" &&
          completedItem.turnItem.type === "compaction" &&
          completedNode.node.id === runningNode.node.id &&
          completedNode.node.status === "completed" &&
          completedItem.turnItem.id === runningItem.turnItem.id &&
          completedItem.turnItem.ordinal === runningItem.turnItem.ordinal &&
          completedItem.turnItem.startedAt === runningItem.turnItem.startedAt &&
          completedItem.turnItem.status === "completed" &&
          completedItem.turnItem.title === "Context compacted" &&
          completedItem.turnItem.beforeTokenCount === 200_000 &&
          completedItem.turnItem.afterTokenCount === 3_400,
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("uses distinct compaction IDs for first turns in separate threads", () =>
    Effect.gen(function* () {
      const firstFake = yield* makeFakePi;
      const { runtime: firstRuntime, takeEvent: takeFirstEvent } = yield* openRuntime(firstFake);
      const firstProviderThread = yield* firstRuntime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(firstRuntime, firstProviderThread);
      yield* firstFake.takeRequest("prompt");
      yield* firstFake.emit({ type: "agent_start" });
      yield* firstFake.emit({ type: "compaction_start", reason: "threshold" });
      const first = yield* takeFirstEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      const secondThreadId = ThreadId.make("thread-pi-test-second");
      const secondFake = yield* makeFakePi;
      const { runtime: secondRuntime, takeEvent: takeSecondEvent } = yield* openRuntime(
        secondFake,
        "default",
        secondThreadId,
        ProviderSessionId.make("provider-session-pi-test-second"),
      );
      const secondProviderThread = yield* secondRuntime.ensureThread({
        threadId: secondThreadId,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(
        secondRuntime,
        secondProviderThread,
        "default",
        [],
        "Hello from another thread",
        undefined,
        1,
        secondThreadId,
      );
      yield* secondFake.takeRequest("prompt");
      yield* secondFake.emit({ type: "agent_start" });
      yield* secondFake.emit({ type: "compaction_start", reason: "threshold" });
      const second = yield* takeSecondEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      assert.isTrue(
        first.type === "turn_item.updated" &&
          first.turnItem.type === "compaction" &&
          second.type === "turn_item.updated" &&
          second.turnItem.type === "compaction" &&
          first.turnItem.ordinal === second.turnItem.ordinal &&
          first.turnItem.id !== second.turnItem.id,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows aborted compactions as stopped", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      const running = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: true,
        willRetry: false,
      });
      const stopped = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        running.type === "turn_item.updated" &&
          running.turnItem.type === "compaction" &&
          stopped.type === "turn_item.updated" &&
          stopped.turnItem.type === "compaction" &&
          stopped.turnItem.id === running.turnItem.id &&
          stopped.turnItem.status === "cancelled" &&
          stopped.turnItem.title === "Context compaction stopped",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps the turn open and updates one retry row through final failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: true });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 3_000,
        errorMessage: "529 overloaded",
      });
      const firstRetry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          firstRetry.turnItem.status === "running" &&
          firstRetry.turnItem.title === "Provider retry" &&
          firstRetry.turnItem.failure.retryable === true &&
          firstRetry.turnItem.retry?.attempt === 1 &&
          firstRetry.turnItem.retry.maxAttempts === 3 &&
          firstRetry.turnItem.retry.retryDelayMs === 3_000,
      );

      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 3,
        maxAttempts: 3,
        delayMs: 12_000,
        errorMessage: "529 still overloaded",
      });
      const lastRetry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          lastRetry.type === "turn_item.updated" &&
          lastRetry.turnItem.type === "error" &&
          lastRetry.turnItem.id === firstRetry.turnItem.id &&
          lastRetry.turnItem.startedAt === firstRetry.turnItem.startedAt &&
          lastRetry.turnItem.retry?.attempt === 3,
      );

      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "529 overloaded",
      });
      const failedRetry = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          failedRetry.type === "turn_item.updated" &&
          failedRetry.turnItem.type === "error" &&
          failedRetry.turnItem.id === firstRetry.turnItem.id &&
          failedRetry.turnItem.title === "Provider error" &&
          failedRetry.turnItem.failure.retryable === false &&
          failedRetry.turnItem.retry?.attempt === 3 &&
          failedRetry.turnItem.retry.maxAttempts === 3,
      );
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("overloaded") &&
          terminal.retry?.attempt === 3 &&
          terminal.retry.maxAttempts === 3 &&
          terminal.retryStartedAt === firstRetry.turnItem.startedAt,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("preserves exhausted retry failure through non-retrying compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 5,
        maxAttempts: 5,
        delayMs: 48_000,
        errorMessage: "socket timed out",
      });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 5,
        finalError: "socket timed out",
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 200_000, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "socket timed out" &&
          terminal.retry?.attempt === 5 &&
          terminal.retry.maxAttempts === 5,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("marks retry progress recovered when Pi succeeds", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "temporary network failure",
        },
      });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 5,
        delayMs: 3_000,
        errorMessage: "temporary network failure",
      });
      const running = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* fake.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      const recovered = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        running.type === "turn_item.updated" &&
          running.turnItem.type === "error" &&
          recovered.type === "turn_item.updated" &&
          recovered.turnItem.type === "error" &&
          recovered.turnItem.id === running.turnItem.id &&
          recovered.turnItem.status === "completed" &&
          recovered.turnItem.title === "Provider recovered",
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      pi: "clears its native queue",
      clearQueue: { steering: ["Use the other file", ""], followUp: ["Then summarize"] },
      notices: [
        "Stop cleared 3 queued messages Pi had not read:\n\nUse the other file\n\nThen summarize",
      ],
    },
    { pi: "predates clear_queue", clearQueue: "unknown_command", notices: [] },
  ] as const)("Stop aborts and retires Pi when it $pi", ({ clearQueue, notices }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.setClearQueue(clearQueue);
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const runningTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        runningTurn.type === "provider_turn.updated" ? runningTurn.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: providerTurnId!,
        requestRuntimeRestart: true,
      });
      yield* fake.takeRequest("abort");
      assert.deepEqual(
        fake
          .allRequests()
          .map((request) => request["type"])
          .filter((type) => type === "clear_queue" || type === "abort"),
        ["clear_queue", "abort"],
      );
      const emitted: Array<string> = [];
      yield* takeEvent((event) => {
        if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
          emitted.push(event.turnItem.message);
        }
        return (
          event.type === "provider_session.updated" && event.providerSession.status === "stopped"
        );
      });
      assert.deepEqual<ReadonlyArray<string>>(emitted, notices);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops active retry progress when the turn is interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const runningTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        runningTurn.type === "provider_turn.updated" ? runningTurn.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 6_000,
        errorMessage: "temporary network failure",
      });
      const retrying = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      yield* fake.emit({ type: "agent_settled" });

      const stopped = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        retrying.type === "turn_item.updated" &&
          retrying.turnItem.type === "error" &&
          stopped.type === "turn_item.updated" &&
          stopped.turnItem.type === "error" &&
          stopped.turnItem.id === retrying.turnItem.id &&
          stopped.turnItem.status === "interrupted" &&
          stopped.turnItem.title === "Provider retry stopped",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps extension-started compaction and recovery in the settled turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      // Extension ctx.compact() waits for this first settlement, then starts
      // compaction in a detached continuation.
      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* fake.emit({ type: "agent_start" });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps working after a settle probe fails before detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      fake.failNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("restarts Pi when Stop interrupts detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("re-probes terminal OMP turns with the capped settlement backoff", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      const stateRequestCount = () =>
        fake.allRequests().filter((request) => request.type === "get_state").length;
      const initialStateRequestCount = stateRequestCount();
      const unsettledState = { isSettled: false, pendingMessageCount: 1 };
      yield* fake.emit({ type: "agent_start" });
      fake.queueState(unsettledState);
      yield* fake.emit({ type: "agent_end", isTerminal: true, willRetry: false });
      yield* fake.takeRequest("get_state");
      yield* Effect.yieldNow;

      let expectedRequestCount = initialStateRequestCount + 1;
      assert.equal(stateRequestCount(), expectedRequestCount);

      const delays = [30_000, 60_000, 120_000, 240_000, 600_000, 600_000];
      for (const [index, delayMs] of delays.entries()) {
        fake.queueState(
          index === delays.length - 1
            ? { isSettled: true, pendingMessageCount: 0 }
            : unsettledState,
        );

        yield* TestClock.adjust(Duration.millis(delayMs - 1));
        assert.equal(stateRequestCount(), expectedRequestCount);
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;

        expectedRequestCount += 1;
        assert.equal(stateRequestCount(), expectedRequestCount);
        yield* fake.takeRequest("get_state");
        yield* Effect.yieldNow;
      }

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops settlement re-probes after new agent activity", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      const stateRequestCount = () =>
        fake.allRequests().filter((request) => request.type === "get_state").length;
      const initialStateRequestCount = stateRequestCount();
      const unsettledState = { isSettled: false, pendingMessageCount: 1 };
      yield* fake.emit({ type: "agent_start" });
      fake.queueState(unsettledState);
      yield* fake.emit({ type: "agent_end", isTerminal: true, willRetry: false });
      yield* fake.takeRequest("get_state");
      yield* Effect.yieldNow;

      assert.equal(stateRequestCount(), initialStateRequestCount + 1);
      fake.queueState(unsettledState);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Effect.yieldNow;
      assert.equal(stateRequestCount(), initialStateRequestCount + 2);
      yield* fake.takeRequest("get_state");
      yield* Effect.yieldNow;

      yield* fake.emit({ type: "agent_start" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(60));
      yield* Effect.yieldNow;
      assert.equal(stateRequestCount(), initialStateRequestCount + 2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows OMP background waits and clears them on resumed agent activity", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      fake.queueState({
        isSettled: false,
        isStreaming: false,
        isCompacting: false,
        hasPendingAsyncWork: true,
        pendingMessageCount: 0,
      });
      yield* fake.emit({ type: "agent_end", isTerminal: true, willRetry: false });
      yield* fake.takeRequest("get_state");

      const waitingEvent = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.pendingBackgroundTasks?.some(
            (task) => task.kind === "background_task" && task.description === "Background job",
          ) === true,
      );
      if (waitingEvent.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the OMP background wait roster");
      }
      const waitingTask = waitingEvent.providerThread.pendingBackgroundTasks?.[0];
      assert.isDefined(waitingTask);
      assert.equal(waitingTask.kind, "background_task");
      assert.equal(waitingTask.description, "Background job");
      assert.isTrue(waitingTask.taskId.startsWith("omp:async:"));

      yield* fake.emit({ type: "agent_start" });
      const resumedEvent = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.pendingBackgroundTasks?.every(
            (task) => task.kind !== "background_task" || task.description !== "Background job",
          ) === true,
      );
      if (resumedEvent.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the OMP background wait roster to clear");
      }
      assert.deepEqual(resumedEvent.providerThread.pendingBackgroundTasks, []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("creates an OMP goal through RPC and mirrors goal_updated", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "/goal set Ship it");
      const get = yield* fake.takeRequest("goal");
      assert.equal(get["op"], "get");
      const create = yield* fake.takeRequest("goal");
      assert.equal(create["op"], "create");
      assert.equal(create["objective"], "Ship it");

      yield* fake.emit({
        type: "goal_updated",
        goal: {
          id: "goal-1",
          objective: "Ship it",
          status: "active",
          tokensUsed: 12,
          timeUsedSeconds: 3,
          createdAt: 1,
          updatedAt: 2,
        },
      });
      const updated = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.goal?.status === "active" &&
          event.providerThread.goal.objective === "Ship it",
      );
      if (updated.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the OMP goal provider-thread update");
      }
      assert.equal(updated.providerThread.goal?.tokensUsed, 12);
      assert.equal(updated.providerThread.goal?.tokenBudget, null);
      assert.equal(updated.providerThread.goal?.timeUsedSeconds, 3);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("runs a new OMP goal's first turn inside the KM turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "/goal Ship it");
      yield* fake.takeRequest("goal");
      yield* fake.takeRequest("goal");
      // OMP does not continue goals for RPC hosts, so the turn starts the goal's work itself.
      const kickoff = yield* fake.takeRequest("prompt");
      assert.equal(
        kickoff["message"],
        "Your goal is set (/goal create). Work on it now, continuing from where you left off.",
      );
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", isTerminal: true, willRetry: false });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("maps OMP paused, complete, and dropped goal events", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      for (const [nativeStatus, expectedStatus] of [
        ["active", "active"],
        ["paused", "paused"],
        ["complete", "complete"],
        ["dropped", null],
      ]) {
        yield* fake.emit({
          type: "goal_updated",
          goal: {
            id: "goal-1",
            objective: "Ship it",
            status: nativeStatus,
            tokensUsed: 5,
            tokenBudget: 100,
            timeUsedSeconds: 2,
            createdAt: 1,
            updatedAt: 2,
          },
        });
        const updated = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" &&
            (event.providerThread.goal?.status ?? null) === expectedStatus,
        );
        assert.isTrue(updated.type === "provider_thread.updated");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("maps /goal clear to the OMP drop RPC operation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "/goal clear");
      const drop = yield* fake.takeRequest("goal");
      assert.equal(drop["op"], "drop");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("surfaces OMP goal RPC errors and settles the KM turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.failNextGoal();

      yield* startTurn(runtime, providerThread, "default", [], "/goal show");
      const get = yield* fake.takeRequest("goal");
      assert.equal(get["op"], "get");
      const error = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      if (error.type !== "turn_item.updated" || error.turnItem.type !== "error") {
        return yield* Effect.die("Expected a visible OMP goal RPC error");
      }
      assert.include(error.turnItem.failure.message, "Goal mode is disabled");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows the OMP background wait when the agent yields to a background job", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.isTrue(
        running.type === "provider_turn.updated" && running.providerTurn.status === "running",
      );

      const stateRequestCount = () =>
        fake.allRequests().filter((request) => request.type === "get_state").length;
      const initialStateRequestCount = stateRequestCount();
      yield* fake.emit({ type: "agent_start" });
      fake.queueState({
        isSettled: false,
        isStreaming: false,
        isCompacting: false,
        hasPendingAsyncWork: true,
        pendingMessageCount: 0,
      });
      yield* fake.emit({
        type: "agent_end",
        isTerminal: false,
        yielded: true,
        awaitingAsyncWork: true,
      });
      const stateRequestFiber = yield* fake
        .takeRequest("get_state")
        .pipe(Effect.timeoutOption(Duration.seconds(1)), Effect.forkScoped);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust(Duration.seconds(1));
      const stateRequest = yield* Fiber.join(stateRequestFiber);
      assert.equal(stateRequest._tag, "Some");
      assert.equal(stateRequestCount(), initialStateRequestCount + 1);

      const waitingEvent = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.pendingBackgroundTasks?.some(
            (task) => task.kind === "background_task" && task.description === "Background job",
          ) === true,
      );
      if (waitingEvent.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the OMP background wait roster");
      }
      const waitingTask = waitingEvent.providerThread.pendingBackgroundTasks?.[0];
      assert.isDefined(waitingTask);
      assert.equal(waitingTask.kind, "background_task");
      assert.equal(waitingTask.description, "Background job");
      assert.isTrue(waitingTask.taskId.startsWith("omp:async:"));

      const completionCheckFiber = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      ).pipe(Effect.timeoutOption(Duration.millis(1)), Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));
      const completionCheck = yield* Fiber.join(completionCheckFiber);
      assert.equal(completionCheck._tag, "None");

      yield* fake.emit({ type: "agent_start" });
      const resumedEvent = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.pendingBackgroundTasks?.every(
            (task) => task.kind !== "background_task" || task.description !== "Background job",
          ) === true,
      );
      if (resumedEvent.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the OMP background wait roster to clear");
      }
      assert.deepEqual(resumedEvent.providerThread.pendingBackgroundTasks, []);

      const requestCountBeforeNonAsyncYield = stateRequestCount();
      yield* fake.emit({ type: "agent_end", isTerminal: false, yielded: true });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Still running" },
      });
      const nonAsyncYieldResult = yield* takeEvent(
        (event) =>
          (event.type === "provider_thread.updated" &&
            event.providerThread.pendingBackgroundTasks?.some(
              (task) => task.kind === "background_task" && task.description === "Background job",
            ) === true) ||
          (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"),
      );
      assert.isTrue(
        nonAsyncYieldResult.type === "turn_item.updated" &&
          nonAsyncYieldResult.turnItem.type === "assistant_message" &&
          nonAsyncYieldResult.turnItem.status === "completed",
      );
      assert.equal(stateRequestCount(), requestCountBeforeNonAsyncYield);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("names each OMP background job on the wait and drops each one that ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        OMP_DIALECT,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const backgroundJob = (toolCallId: string, jobId: string, intent: string, command: string) =>
        Effect.gen(function* () {
          yield* fake.emit({
            type: "tool_execution_start",
            toolCallId,
            toolName: "bash",
            intent,
            args: { command },
          });
          yield* fake.emit({
            type: "tool_execution_end",
            toolCallId,
            toolName: "bash",
            result: {
              content: [{ type: "text", text: `Backgrounded as job ${jobId} (no deadline)` }],
              details: { async: { state: "running", jobId, type: "bash" } },
            },
          });
        });
      yield* backgroundJob("call_gate", "bg_1", "Running gate 42", "make gate GATE=42");
      yield* backgroundJob("call_watch", "bg_2", "Watching CI", "gh run watch 7");

      fake.queueState({
        isSettled: false,
        isStreaming: false,
        isCompacting: false,
        hasPendingAsyncWork: true,
        pendingMessageCount: 0,
      });
      yield* fake.emit({
        type: "agent_end",
        isTerminal: false,
        yielded: true,
        awaitingAsyncWork: true,
      });
      const waiting = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
      );
      if (waiting.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the OMP background wait roster");
      }
      const roster = waiting.providerThread.pendingBackgroundTasks ?? [];
      assert.deepEqual(
        roster.map(({ taskId, kind, description, command }) => ({
          taskId,
          kind,
          description,
          command,
        })),
        [
          {
            taskId: "omp:async:bg_1",
            kind: "background_task",
            description: "Running gate 42",
            command: "make gate GATE=42",
          },
          {
            taskId: "omp:async:bg_2",
            kind: "background_task",
            description: "Watching CI",
            command: "gh run watch 7",
          },
        ],
      );
      assert.isTrue(roster.every((task) => task.startedAt !== undefined));

      // OMP keeps streaming a backgrounded call's job frames after the call ends.
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_watch",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "run 7 passed" }],
          details: { async: { state: "completed", jobId: "bg_2", type: "bash" } },
        },
      });
      const remaining = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.pendingBackgroundTasks?.length === 1,
      );
      if (remaining.type !== "provider_thread.updated") {
        return yield* Effect.die("Expected the finished job to leave the roster");
      }
      assert.deepEqual(
        remaining.providerThread.pendingBackgroundTasks?.map((task) => task.taskId),
        ["omp:async:bg_1"],
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("ignores an idle snapshot made stale by a steer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.deferNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:late-steer" as never,
          text: "Continue after settlement",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Recovered" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered" }],
          stopReason: "stop",
        },
      });
      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Recovered",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("PiRpc framing", () => {
  it.effect("reassembles records across chunk boundaries and strips CR", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
        dialect: PI_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text)).pipe(Effect.asVoid);
      yield* push('{"type":"agent_');
      yield* push('start"}\r\n{"type":"agent_settled"}\nnot json\n{"type":"queue_update"}\n');

      yield* push("x".repeat(8 * 1024 * 1024));
      yield* push('x{"type":"must_not_emit"}\n{"type":"after_oversized"}\n');

      const first = yield* Queue.take(connection.events);
      assert.equal(first["type"], "agent_start");
      const second = yield* Queue.take(connection.events);
      assert.equal(second["type"], "agent_settled");
      const third = yield* Queue.take(connection.events);
      assert.equal(third["type"], "queue_update");
      assert.equal((yield* Queue.take(connection.events))["type"], "after_oversized");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// This fails before a provider transcript exists, so a replay fixture is not
// an honest fit. The boundary is the stdio transport seeing stdout end.
describe("PiRpc early process exit", () => {
  const makeHandle = (options: {
    readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly stderr: Stream.Stream<Uint8Array>;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      exitCode: options.exitCode,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: options.stderr,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("reports a nonzero exit code instead of an unexplained stdout close", () =>
    Effect.gen(function* () {
      const secret = "API_KEY=super-secret\n";
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.fromIterable([new TextEncoder().encode(secret)]),
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
        dialect: PI_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
      assert.isFalse((error.detail ?? "").includes("API_KEY"));
      assert.isFalse((error.detail ?? "").includes("super-secret"));
      assert.isFalse(error.message.includes("API_KEY"));
      assert.isFalse(error.message.includes("super-secret"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the unexplained stdout-close message when the process has not exited", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
            stderr: Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
        dialect: PI_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const fiber = yield* Effect.forkChild(Queue.take(connection.events).pipe(Effect.flip));
      yield* TestClock.adjust(Duration.millis(300));
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process closed stdout");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the exit-code diagnosis when stdin breaks while exit is still pending", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.sleep(Duration.millis(50)).pipe(
              Effect.andThen(Effect.succeed(ChildProcessSpawner.ExitCode(1))),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "stdin",
                description: "broken pipe",
              }),
            ),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
        dialect: PI_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const fiber = yield* Effect.forkChild(Queue.take(connection.events).pipe(Effect.flip));
      yield* TestClock.adjust(Duration.millis(300));
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
