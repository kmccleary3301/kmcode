// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  awaitNativeRun,
  configuredNativeRuntimes,
  interruptNativeRun,
  lastAssistantText,
  launchNativeThread,
  makeNativeRoot,
  prepareNativeHome,
  readNativeThread,
  sendNativeMessage,
  startKmCodeServer,
  startNativeModelServer,
  type NativeRuntimeBinary,
} from "./NativeLiveRuntime.integration.ts";

const SERVER_ENTRY = NodePath.resolve(import.meta.dirname, "../src/bin.ts");

/** A source-tree KM Code server whose HOME exposes one stock runtime. */
const withNativeServer = (binary: NativeRuntimeBinary, crashOnMarker: boolean) =>
  Effect.gen(function* () {
    const modelServer = yield* Effect.acquireRelease(
      Effect.promise(startNativeModelServer),
      (server) => Effect.promise(server.close),
    );
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => makeNativeRoot(`km-native-${binary.runtime}-`)),
      (directory) =>
        Effect.promise(() =>
          NodeFS.promises.rm(directory, { recursive: true, force: true, maxRetries: 20 }),
        ),
    );
    const home = yield* prepareNativeHome({ root, runtimes: [binary], modelServer, crashOnMarker });
    const server = yield* startKmCodeServer({
      command: process.execPath,
      prefixArgs: [SERVER_ENTRY],
      home,
    });
    return { server, modelServer, workspaceRoot: NodePath.join(root, "workspace") };
  });

const runLifecycleMatrix = (binary: NativeRuntimeBinary) =>
  Effect.gen(function* () {
    const { server, modelServer, workspaceRoot } = yield* withNativeServer(binary, false);
    const { runtime } = binary;
    const threadId = yield* launchNativeThread(server, {
      runtime,
      workspaceRoot,
      text: "NATIVE-MATRIX first turn",
    });
    const first = yield* awaitNativeRun(server, { threadId, ordinal: 1 });
    assert.equal(first.run.status, "completed");
    assert.include(lastAssistantText(first.projection), "NATIVE-MATRIX-OK");

    // The runtime's own bash tool runs and its output reaches the model.
    yield* sendNativeMessage(server, { runtime, threadId, text: "NATIVE-MATRIX-TOOL run it" });
    const tool = yield* awaitNativeRun(server, { threadId, ordinal: 2 });
    assert.equal(tool.run.status, "completed");
    assert.include(lastAssistantText(tool.projection), "NATIVE-MATRIX-TOOL-OK");

    yield* sendNativeMessage(server, { runtime, threadId, text: "NATIVE-MATRIX-HOLD stall" });
    const held = yield* awaitNativeRun(server, {
      threadId,
      ordinal: 3,
      until: (status) => status === "running",
    });
    yield* interruptNativeRun(server, threadId, held.run.id);
    const interrupted = yield* awaitNativeRun(server, { threadId, ordinal: 3, timeoutMs: 20_000 });
    assert.equal(interrupted.run.status, "interrupted");

    // The same native session continues after the interrupt with its history.
    yield* sendNativeMessage(server, { runtime, threadId, text: "after the interrupt" });
    const resumed = yield* awaitNativeRun(server, { threadId, ordinal: 4 });
    assert.equal(resumed.run.status, "completed");
    assert.include(modelServer.requests.at(-1) ?? "", "NATIVE-MATRIX first turn");

    // The session KM Code started is the one native session listing offers,
    // and opening it returns this thread instead of importing a copy.
    const providerInstanceId = ProviderInstanceId.make(runtime);
    const listed = yield* server.client["server.listNativeSessions"]({ providerInstanceId });
    assert.lengthOf(listed.sessions, 1);
    const sessionId = listed.sessions[0]!.sessionId;
    const opened = yield* server.client["server.openNativeSession"]({
      providerInstanceId,
      sessionId,
    });
    assert.equal(opened.threadId, threadId);
    yield* server.client["server.renameNativeSession"]({
      providerInstanceId,
      sessionId,
      name: "Native matrix renamed",
    });
    assert.equal((yield* readNativeThread(server, threadId)).thread.title, "Native matrix renamed");
    const relisted = yield* server.client["server.listNativeSessions"]({ providerInstanceId });
    assert.equal(relisted.sessions[0]?.title, "Native matrix renamed");
    yield* server.client["server.archiveNativeSession"]({ providerInstanceId, sessionId });
    assert.isNotNull((yield* readNativeThread(server, threadId)).thread.archivedAt);
  }).pipe(Effect.scoped);

const runCrashRecovery = (binary: NativeRuntimeBinary) =>
  Effect.gen(function* () {
    const { server, modelServer, workspaceRoot } = yield* withNativeServer(binary, true);
    const { runtime } = binary;
    const threadId = yield* launchNativeThread(server, {
      runtime,
      workspaceRoot,
      text: "NATIVE-MATRIX before the crash",
    });
    assert.equal((yield* awaitNativeRun(server, { threadId, ordinal: 1 })).run.status, "completed");

    yield* sendNativeMessage(server, {
      runtime,
      threadId,
      text: "NATIVE-MATRIX-CRASH NATIVE-MATRIX-HOLD",
    });
    const crashed = yield* awaitNativeRun(server, { threadId, ordinal: 2, timeoutMs: 25_000 });
    assert.oneOf(crashed.run.status, ["failed", "interrupted"]);

    // A fresh process resumes the same session file with the earlier turns.
    yield* sendNativeMessage(server, { runtime, threadId, text: "RESTORED after the crash" });
    const restored = yield* awaitNativeRun(server, { threadId, ordinal: 3 });
    assert.equal(restored.run.status, "completed");
    assert.include(lastAssistantText(restored.projection), "NATIVE-MATRIX-RESTORED-OK");
    assert.include(modelServer.requests.at(-1) ?? "", "NATIVE-MATRIX before the crash");
  }).pipe(Effect.scoped);

// Both runtimes are always declared so unconfigured runs report skips, not an empty file.
const configured = configuredNativeRuntimes();
for (const runtime of ["pi", "omp"] as const) {
  const binary = configured.find((candidate) => candidate.runtime === runtime);
  it.live.skipIf(binary === undefined)(
    `runs configured ${runtime} through the native KM Code lifecycle matrix`,
    () => runLifecycleMatrix(binary!),
    240_000,
  );
  it.live.skipIf(binary === undefined)(
    `recovers configured ${runtime} after an isolated stock native process crash`,
    () => runCrashRecovery(binary!),
    180_000,
  );
}
