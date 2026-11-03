// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalFetchInEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Random from "effect/Random";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  configuredNativeLiveConfigurations,
  makeNativeLiveModelServer,
  writeNativeLiveConfig,
} from "./NativeLiveRuntime.integration.ts";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
const wsProtocolLayer = (url: string, token: string) => {
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    // Socket.makeWebSocket only ever passes its `protocols` option here.
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(socketUrl, protocols as string | string[] | undefined, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};
const decodeThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);
const decodeIssuedSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String, sessionId: Schema.String })),
);

it.live.skipIf(process.env.T3_INSTALLED_CLI === undefined)(
  "runs installed release artifact through Pi and OMP root turns",
  () =>
    Effect.acquireUseRelease(
      makeNativeLiveModelServer,
      (modelServer) =>
        Effect.acquireUseRelease(
          Effect.promise(async () => {
            const root = await NodeFS.promises.mkdtemp(
              NodePath.join(NodeOS.tmpdir(), "t3-installed-native-"),
            );
            return NodeFS.promises.realpath(root);
          }),
          (root) =>
            Effect.gen(function* () {
              const platform = yield* HostProcessPlatform;
              const architecture = yield* HostProcessArchitecture;
              const isWindows = platform === "win32";
              const installedCli = requiredEnvironment("T3_INSTALLED_CLI");
              const reportPath = requiredEnvironment("T3_INSTALLED_NATIVE_REPORT");
              const configurations = configuredNativeLiveConfigurations();
              assert.deepEqual(
                configurations.map((configuration) => configuration.runtime),
                ["pi", "omp"],
                "Both exact native binaries must be configured",
              );

              const home = NodePath.join(root, "home");
              const baseDirectory = NodePath.join(root, "server");
              const runtimeBin = NodePath.join(root, "runtime-bin");
              yield* Effect.promise(() =>
                NodeFS.promises.mkdir(runtimeBin, { recursive: true, mode: 0o700 }),
              );
              for (const configuration of configurations) {
                const agentDirectory = NodePath.join(home, `.${configuration.runtime}`, "agent");
                yield* Effect.promise(() =>
                  NodeFS.promises.mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
                );
                yield* writeNativeLiveConfig(configuration, agentDirectory, modelServer);
                const wrapperPath = NodePath.join(
                  runtimeBin,
                  isWindows ? `${configuration.runtime}.cmd` : configuration.runtime,
                );
                if (isWindows) {
                  yield* Effect.promise(() =>
                    NodeFS.promises.writeFile(
                      wrapperPath,
                      `@echo off\r\ncall "${configuration.binaryPath}" %*\r\n`,
                    ),
                  );
                } else {
                  yield* Effect.promise(() =>
                    NodeFS.promises.symlink(configuration.binaryPath, wrapperPath),
                  );
                }
              }

              const port = yield* Random.nextIntBetween(40_000, 50_000);
              const childEnvironment = {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                PATH: `${runtimeBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
                PI_OFFLINE: "1",
                PI_NO_PTY: "1",
              };
              const stdout: string[] = [];
              const stderr: string[] = [];
              const server = yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const child = NodeChildProcess.spawn(
                    installedCli,
                    ["serve", "--port", String(port), "--base-dir", baseDirectory, "--no-browser"],
                    {
                      env: childEnvironment,
                      shell: isWindows,
                      stdio: ["ignore", "pipe", "pipe"],
                    },
                  );
                  child.stdout.setEncoding("utf8");
                  child.stderr.setEncoding("utf8");
                  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
                  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
                  return child;
                }),
                (child) => {
                  if (child.exitCode !== null) return Effect.void;
                  return Effect.callback<void>((resume) => {
                    const onExit = () => resume(Effect.void);
                    child.once("exit", onExit);
                    if (isWindows && child.pid !== undefined) {
                      NodeChildProcess.spawnSync("taskkill.exe", [
                        "/PID",
                        String(child.pid),
                        "/T",
                        "/F",
                      ]);
                    } else {
                      child.kill("SIGTERM");
                    }
                    return Effect.sync(() => child.removeListener("exit", onExit));
                  }).pipe(
                    Effect.timeoutOrElse({
                      duration: "10 seconds",
                      orElse: () => Effect.void,
                    }),
                  );
                },
              );

              const baseUrl = `http://127.0.0.1:${port}`;
              let ready = false;
              const readyDeadline = (yield* Clock.currentTimeMillis) + 60_000;
              while ((yield* Clock.currentTimeMillis) < readyDeadline) {
                if (server.exitCode !== null) {
                  return yield* Effect.die(
                    `Installed server exited before readiness (${server.exitCode}).\n${stdout.join("")}\n${stderr.join("")}`,
                  );
                }
                const response = yield* Effect.promise(() =>
                  fetch(`${baseUrl}/.well-known/t3/environment`, {
                    signal: AbortSignal.timeout(2_000),
                  }).catch(() => undefined),
                );
                if (response?.ok) {
                  ready = true;
                  break;
                }
                yield* Effect.sleep(100);
              }
              if (!ready) {
                return yield* Effect.die(
                  `Installed server readiness timed out.\n${stdout.join("")}\n${stderr.join("")}`,
                );
              }

              const sessionOutput = yield* Effect.sync(() =>
                NodeChildProcess.execFileSync(
                  installedCli,
                  ["auth", "session", "issue", "--base-dir", baseDirectory, "--json"],
                  {
                    encoding: "utf8",
                    env: childEnvironment,
                    shell: isWindows,
                  },
                ),
              );
              const issued = yield* decodeIssuedSession(sessionOutput);
              const authorization = `Bearer ${issued.token}`;
              const wsUrl = baseUrl.replace(/^http:/u, "ws:") + "/ws";
              const results = yield* makeWsRpcClient.pipe(
                Effect.flatMap((client) =>
                  Effect.gen(function* () {
                    for (const configuration of configurations) {
                      yield* client[WS_METHODS.serverRefreshProviders]({
                        instanceId: ProviderInstanceId.make(configuration.runtime),
                      }).pipe(Effect.timeout("30 seconds"));
                    }
                    const completed: Array<{ runtime: string; assistantText: string }> = [];
                    for (const configuration of configurations) {
                      const runtime = configuration.runtime;
                      const workspaceRoot = NodePath.join(root, `workspace-${runtime}`);
                      yield* Effect.sync(() =>
                        NodeFS.mkdirSync(workspaceRoot, { recursive: true }),
                      );
                      const projectId = ProjectId.make(`installed-native-${runtime}-project`);
                      const threadId = ThreadId.make(`installed-native-${runtime}-thread`);
                      const modelSelection = {
                        instanceId: ProviderInstanceId.make(runtime),
                        model: "local/test",
                      } as const;
                      const createdAt = "2026-08-24T00:00:00.000Z";
                      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                        type: "project.create",
                        commandId: CommandId.make(`installed-native:${runtime}:project`),
                        projectId,
                        title: `Installed ${runtime} project`,
                        workspaceRoot,
                        defaultModelSelection: modelSelection,
                        createdAt,
                      });
                      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                        type: "thread.create",
                        commandId: CommandId.make(`installed-native:${runtime}:thread`),
                        threadId,
                        projectId,
                        title: `Installed ${runtime} thread`,
                        modelSelection,
                        runtimeMode: "approval-required",
                        interactionMode: "default",
                        branch: null,
                        worktreePath: workspaceRoot,
                        createdAt,
                      });
                      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                        type: "thread.turn.start",
                        commandId: CommandId.make(`installed-native:${runtime}:turn`),
                        threadId,
                        message: {
                          messageId: MessageId.make(`installed-native-${runtime}-user`),
                          role: "user",
                          text: `Installed artifact ${runtime} root turn.`,
                          attachments: [],
                        },
                        modelSelection,
                        runtimeMode: "approval-required",
                        interactionMode: "default",
                        createdAt,
                      });

                      const turnDeadline = (yield* Clock.currentTimeMillis) + 60_000;
                      while (true) {
                        const response = yield* Effect.promise(() =>
                          fetch(`${baseUrl}/api/orchestration/threads/${threadId}`, {
                            headers: { authorization },
                            signal: AbortSignal.timeout(2_000),
                          }),
                        );
                        assert.equal(response.status, 200);
                        const snapshot = yield* decodeThreadSnapshot(
                          yield* Effect.promise(() => response.text()),
                        );
                        const assistant = snapshot.thread.messages.find(
                          (message) => message.role === "assistant" && !message.streaming,
                        );
                        if (
                          snapshot.thread.latestTurn?.state === "completed" &&
                          snapshot.thread.session?.status === "ready" &&
                          assistant?.text.includes("NATIVE-MATRIX-OK")
                        ) {
                          completed.push({ runtime, assistantText: assistant.text });
                          break;
                        }
                        if ((yield* Clock.currentTimeMillis) >= turnDeadline) {
                          return yield* Effect.die(
                            `Installed ${runtime} root turn timed out: ${snapshot.thread.latestTurn?.state}/${snapshot.thread.session?.status}`,
                          );
                        }
                        yield* Effect.sleep(100);
                      }
                      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                        type: "thread.session.stop",
                        commandId: CommandId.make(`installed-native:${runtime}:stop`),
                        threadId,
                        createdAt,
                      });
                      const stopDeadline = (yield* Clock.currentTimeMillis) + 30_000;
                      while (true) {
                        const response = yield* Effect.promise(() =>
                          fetch(`${baseUrl}/api/orchestration/threads/${threadId}`, {
                            headers: { authorization },
                            signal: AbortSignal.timeout(2_000),
                          }),
                        );
                        assert.equal(response.status, 200);
                        const snapshot = yield* decodeThreadSnapshot(
                          yield* Effect.promise(() => response.text()),
                        );
                        if (snapshot.thread.session?.status === "stopped") break;
                        if ((yield* Clock.currentTimeMillis) >= stopDeadline) {
                          return yield* Effect.die(
                            `Installed ${runtime} session stop timed out: ${snapshot.thread.session?.status}`,
                          );
                        }
                        yield* Effect.sleep(100);
                      }
                    }
                    return completed;
                  }),
                ),
                Effect.provide(wsProtocolLayer(wsUrl, issued.token)),
              );
              assert.deepEqual(
                results.map((result) => result.runtime),
                ["pi", "omp"],
              );
              yield* Effect.promise(() =>
                NodeFS.promises.writeFile(
                  reportPath,
                  // @effect-diagnostics-next-line preferSchemaOverJson:off - Machine-readable smoke report.
                  `${JSON.stringify(
                    {
                      schemaVersion: 2,
                      installedCli: {
                        name: NodePath.basename(installedCli),
                      },
                      platform,
                      architecture,
                      runtimes: results.map((result) => ({
                        runtime: result.runtime,
                        rootTurn: "completed",
                      })),
                    },
                    null,
                    2,
                  )}\n`,
                ),
              );
            }).pipe(Effect.scoped),
          (root) =>
            Effect.promise(() =>
              NodeFS.promises.rm(root, {
                recursive: true,
                force: true,
                maxRetries: 50,
                retryDelay: 100,
              }),
            ),
        ),
      (modelServer) => Effect.promise(() => modelServer.close()),
    ),
  180_000,
);
