// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off
/**
 * Black-box harness for stock Pi and OMP binaries: a KM Code server process,
 * an isolated HOME whose agent directories point both runtimes at a local
 * OpenAI-compatible model, and a WebSocket RPC client.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import type * as Scope from "effect/Scope";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

export type NativeRuntime = "pi" | "omp";

export interface NativeRuntimeBinary {
  readonly runtime: NativeRuntime;
  readonly binaryPath: string;
}

/** Runtimes whose binary is named by `T3_NATIVE_PI_BINARY` / `T3_NATIVE_OMP_BINARY`. */
export function configuredNativeRuntimes(): ReadonlyArray<NativeRuntimeBinary> {
  const only = process.env.T3_NATIVE_LIVE_RUNTIME?.trim();
  return (["pi", "omp"] as const).flatMap((runtime) => {
    const binaryPath = process.env[`T3_NATIVE_${runtime.toUpperCase()}_BINARY`]?.trim();
    return binaryPath && (only === undefined || only === runtime) ? [{ runtime, binaryPath }] : [];
  });
}

export const NATIVE_MODEL = "local/test";
const HOLD_MS = 30_000;

export interface NativeModelServer {
  readonly baseUrl: string;
  /** Raw request bodies, oldest first. */
  readonly requests: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

function chatFrames(id: string, delta: object, finishReason: string): string {
  const frames = [
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    },
  ];
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * Streams chat completions keyed on markers in the latest user message:
 * `NATIVE-MATRIX-TOOL` asks for a bash call and then reports whether its
 * output came back, `NATIVE-MATRIX-HOLD` stalls long enough to interrupt or
 * crash, and `RESTORED` answers with a distinct marker.
 */
export function startNativeModelServer(): Promise<NativeModelServer> {
  const requests: string[] = [];
  const held = new Set<NodeJS.Timeout>();
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const messages: ReadonlyArray<ChatMessage> =
        typeof parsed === "object" &&
        parsed !== null &&
        "messages" in parsed &&
        Array.isArray(parsed.messages)
          ? parsed.messages
          : [];
      const latestUser = messages.findLastIndex((message) => message.role === "user");
      const prompt = JSON.stringify(messages[latestUser]?.content ?? "");
      const toolResults = messages
        .slice(latestUser + 1)
        .filter((message) => message.role === "tool");
      const id = `native-matrix-${requests.length}`;
      const reply = () => {
        if (prompt.includes("NATIVE-MATRIX-TOOL") && toolResults.length === 0) {
          return chatFrames(
            id,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "native-matrix-bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"command":"printf NATIVE-MATRIX-TOOL-OK"}',
                  },
                },
              ],
            },
            "tool_calls",
          );
        }
        const text =
          toolResults.length > 0
            ? JSON.stringify(toolResults).includes("NATIVE-MATRIX-TOOL-OK")
              ? "NATIVE-MATRIX-TOOL-OK"
              : "NATIVE-MATRIX-TOOL-MISSING"
            : prompt.includes("RESTORED")
              ? "NATIVE-MATRIX-RESTORED-OK"
              : "NATIVE-MATRIX-OK";
        return chatFrames(id, { role: "assistant", content: text }, "stop");
      };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (!prompt.includes("NATIVE-MATRIX-HOLD")) {
        response.end(reply());
        return;
      }
      response.write(": native-matrix-hold\n\n");
      const timer = setTimeout(() => {
        held.delete(timer);
        response.end(reply());
      }, HOLD_MS);
      held.add(timer);
      response.once("close", () => {
        clearTimeout(timer);
        held.delete(timer);
      });
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<NativeModelServer>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Native model server has no TCP address."));
      return;
    }
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      close: () => {
        const closed = Promise.withResolvers<void>();
        for (const timer of held) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => closed.resolve());
        return closed.promise;
      },
    });
  });
  return promise;
}

/** Real path of a fresh private temp directory; macOS tmp is a symlink. */
export async function makeNativeRoot(prefix: string): Promise<string> {
  const directory = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  return NodeFS.promises.realpath(directory);
}

async function writeAgentConfig(runtime: NativeRuntime, agentDirectory: string, baseUrl: string) {
  await NodeFS.promises.mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  if (runtime === "pi") {
    await NodeFS.promises.writeFile(
      NodePath.join(agentDirectory, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl,
            api: "openai-completions",
            apiKey: "native-matrix",
            models: [
              {
                id: "test",
                name: "Native Matrix",
                input: ["text"],
                contextWindow: 128_000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    await NodeFS.promises.writeFile(
      NodePath.join(agentDirectory, "settings.json"),
      JSON.stringify({
        defaultProvider: "local",
        defaultModel: "test",
        defaultThinkingLevel: "off",
      }),
    );
    return;
  }
  await NodeFS.promises.writeFile(
    NodePath.join(agentDirectory, "models.yml"),
    [
      "providers:",
      "  local:",
      `    baseUrl: ${baseUrl}`,
      "    api: openai-completions",
      "    auth: none",
      "    models:",
      "      - id: test",
      "        name: Native Matrix",
      "        input: [text]",
      "        contextWindow: 128000",
      "        maxTokens: 1024",
      "",
    ].join("\n"),
  );
  await NodeFS.promises.writeFile(
    NodePath.join(agentDirectory, "config.yml"),
    ["modelRoles:", "  default: local/test", "  smol: local/test", "  task: local/test", ""].join(
      "\n",
    ),
  );
}

/**
 * Relays stdio to the real runtime and SIGKILLs it shortly after a prompt
 * carrying `NATIVE-MATRIX-CRASH` crosses stdin, exercising the adapter's real
 * child-exit path without modifying it.
 */
const CRASH_WRAPPER = `const { spawn } = require("node:child_process");
const readline = require("node:readline");
const [binary, ...args] = process.argv.slice(2);
const child = spawn(binary, args, { shell: process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(binary), stdio: ["pipe", "inherit", "inherit"] });
let crashing = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  child.stdin.write(line + "\\n");
  if (!crashing && line.includes("NATIVE-MATRIX-CRASH")) {
    crashing = true;
    setTimeout(() => child.kill("SIGKILL"), 750);
  }
}).on("close", () => child.stdin.end());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("error", () => process.exit(127));
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
`;

async function installRuntimeCommand(
  runtimeBin: string,
  binary: NativeRuntimeBinary,
  crashWrapper: string | undefined,
  isWindows: boolean,
) {
  const command = NodePath.join(runtimeBin, isWindows ? `${binary.runtime}.cmd` : binary.runtime);
  if (crashWrapper === undefined) {
    if (isWindows) {
      await NodeFS.promises.writeFile(command, `@echo off\r\ncall "${binary.binaryPath}" %*\r\n`);
    } else {
      await NodeFS.promises.symlink(binary.binaryPath, command);
    }
    return;
  }
  await NodeFS.promises.writeFile(
    command,
    isWindows
      ? `@echo off\r\n"${process.execPath}" "${crashWrapper}" "${binary.binaryPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${crashWrapper}" "${binary.binaryPath}" "$@"\n`,
    { mode: 0o700 },
  );
}

export interface NativeHome {
  readonly home: string;
  readonly baseDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Runtime commands and the server CLI may be `.cmd` shims that need a shell. */
  readonly isWindows: boolean;
}

/**
 * HOME with each runtime's default agent directory configured for the model
 * server, a PATH directory exposing the runtimes under their default command
 * names, and KM Code settings enabling them.
 */
export const prepareNativeHome = (input: {
  readonly root: string;
  readonly runtimes: ReadonlyArray<NativeRuntimeBinary>;
  readonly modelServer: NativeModelServer;
  readonly crashOnMarker?: boolean;
}) =>
  Effect.gen(function* () {
    const isWindows = (yield* HostProcessPlatform) === "win32";
    return yield* Effect.promise(async (): Promise<NativeHome> => {
      const home = NodePath.join(input.root, "home");
      const runtimeBin = NodePath.join(input.root, "runtime-bin");
      const baseDirectory = NodePath.join(input.root, "server");
      await NodeFS.promises.mkdir(runtimeBin, { recursive: true, mode: 0o700 });
      let crashWrapper: string | undefined;
      if (input.crashOnMarker === true) {
        crashWrapper = NodePath.join(runtimeBin, "native-crash-wrapper.cjs");
        await NodeFS.promises.writeFile(crashWrapper, CRASH_WRAPPER);
      }
      for (const binary of input.runtimes) {
        await writeAgentConfig(
          binary.runtime,
          NodePath.join(home, `.${binary.runtime}`, "agent"),
          input.modelServer.baseUrl,
        );
        await installRuntimeCommand(runtimeBin, binary, crashWrapper, isWindows);
      }
      const settingsPath = NodePath.join(baseDirectory, "userdata", "settings.json");
      await NodeFS.promises.mkdir(NodePath.dirname(settingsPath), { recursive: true });
      await NodeFS.promises.writeFile(
        settingsPath,
        JSON.stringify({ providers: { pi: { enabled: true }, omp: { enabled: true } } }),
      );
      const {
        PI_CODING_AGENT_DIR: _agentDir,
        OMP_PROFILE: _profile,
        PI_PROFILE: _piProfile,
        ...inherited
      } = process.env;
      return {
        home,
        baseDirectory,
        isWindows,
        environment: {
          ...inherited,
          HOME: home,
          USERPROFILE: home,
          PATH: `${runtimeBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
          PI_NO_PTY: "1",
        },
      };
    });
  });

const makeWsClient = RpcClient.make(WsRpcGroup);
export type NativeWsClient = Effect.Success<typeof makeWsClient>;

export interface KmCodeServer {
  readonly client: NativeWsClient;
  readonly output: () => string;
}

/**
 * Starts `<command> [...prefix] serve` against the home's base directory,
 * waits for readiness, and connects an authenticated RPC client. The process
 * is stopped when the scope closes.
 */
export const startKmCodeServer = (input: {
  readonly command: string;
  readonly prefixArgs: ReadonlyArray<string>;
  readonly home: NativeHome;
}): Effect.Effect<KmCodeServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const port = yield* Random.nextIntBetween(40_000, 50_000);
    const output: string[] = [];
    const run = (args: ReadonlyArray<string>) =>
      NodeChildProcess.spawn(input.command, [...input.prefixArgs, ...args], {
        env: input.home.environment,
        shell: input.home.isWindows && /\.(?:cmd|bat)$/iu.test(input.command),
        stdio: ["ignore", "pipe", "pipe"],
      });
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = run([
          "serve",
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
          "--base-dir",
          input.home.baseDirectory,
          "--no-browser",
        ]);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
        return child;
      }),
      (child) =>
        child.exitCode !== null
          ? Effect.void
          : Effect.callback<void>((resume) => {
              child.once("exit", () => resume(Effect.void));
              if (input.home.isWindows && child.pid !== undefined) {
                NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
              } else {
                child.kill("SIGTERM");
              }
            }).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.void })),
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = (yield* Clock.currentTimeMillis) + 90_000;
    while (true) {
      if (server.exitCode !== null) {
        return yield* Effect.die(`KM Code server exited (${server.exitCode}).\n${output.join("")}`);
      }
      const response = yield* Effect.promise(() =>
        // @effect-diagnostics-next-line globalFetchInEffect:off - Black-box probe of the server under test.
        fetch(`${baseUrl}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(2_000),
        }).catch(() => undefined),
      );
      if (response?.ok) break;
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(`KM Code server readiness timed out.\n${output.join("")}`);
      }
      yield* Effect.sleep("200 millis");
    }
    const token = yield* Effect.promise(() => {
      const issued = Promise.withResolvers<string>();
      const issue = run([
        "auth",
        "session",
        "issue",
        "--base-dir",
        input.home.baseDirectory,
        "--token-only",
      ]);
      let stdout = "";
      issue.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      issue.once("error", issued.reject);
      issue.once("exit", (code) =>
        code === 0
          ? issued.resolve(stdout.trim())
          : issued.reject(new Error(`auth session issue exited ${code}`)),
      );
      return issued.promise;
    });
    const ticket = yield* Effect.promise(async () => {
      // @effect-diagnostics-next-line globalFetchInEffect:off - Black-box request to the server under test.
      const response = await fetch(`${baseUrl}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("ticket" in body)) {
        throw new Error(`WebSocket ticket request failed with ${response.status}.`);
      }
      return String(body.ticket);
    });
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Socket.layerWebSocket(
            `${baseUrl.replace(/^http:/u, "ws:")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2`,
          ),
        ),
        Layer.provide(NodeSocket.layerWebSocketConstructor),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ).pipe(Effect.orDie);
    const client = yield* makeWsClient.pipe(Effect.provide(protocol));
    return { client, output: () => output.join("") };
  });

// Every test runs its own server and database, so a process-wide counter is unique.
let commandSequence = 0;
const nextCommandId = () => CommandId.make(`native-matrix-command-${++commandSequence}`);
const nextMessageId = () => MessageId.make(`native-matrix-message-${++commandSequence}`);

export const modelSelectionFor = (runtime: NativeRuntime) =>
  ({ instanceId: ProviderInstanceId.make(runtime), model: NATIVE_MODEL }) as const;

/** A project rooted at `workspaceRoot` and a thread whose first turn is `text`. */
export const launchNativeThread = (
  server: KmCodeServer,
  input: { readonly runtime: NativeRuntime; readonly workspaceRoot: string; readonly text: string },
) =>
  Effect.gen(function* () {
    const project = yield* server.client["projects.mutate"]({
      type: "project.create",
      commandId: nextCommandId(),
      projectId: ProjectId.make(`native-matrix-${input.runtime}-project-${++commandSequence}`),
      title: `Native ${input.runtime}`,
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: true,
    });
    const launched = yield* server.client["orchestration.launchThread"]({
      commandId: nextCommandId(),
      projectId: project.id,
      title: `Native ${input.runtime} matrix`,
      generateTitle: false,
      modelSelection: modelSelectionFor(input.runtime),
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: input.text, attachments: [] },
    });
    return launched.threadId;
  }).pipe(Effect.orDie);

export const sendNativeMessage = (
  server: KmCodeServer,
  input: { readonly runtime: NativeRuntime; readonly threadId: ThreadId; readonly text: string },
) =>
  server.client["orchestration.dispatchCommand"]({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: nextCommandId(),
    threadId: input.threadId,
    messageId: nextMessageId(),
    text: input.text,
    attachments: [],
    modelSelection: modelSelectionFor(input.runtime),
    dispatchMode: { type: "start_immediately" },
  }).pipe(Effect.orDie);

export const interruptNativeRun = (
  server: KmCodeServer,
  threadId: ThreadId,
  runId: OrchestrationV2ThreadProjection["runs"][number]["id"],
) =>
  server.client["orchestration.dispatchCommand"]({
    type: "run.interrupt",
    commandId: nextCommandId(),
    threadId,
    runId,
    holdQueue: true,
  }).pipe(Effect.orDie);

export const readNativeThread = (server: KmCodeServer, threadId: ThreadId) =>
  server.client["orchestration.getThreadProjection"]({ threadId }).pipe(Effect.orDie);

const TERMINAL_RUN_STATUSES: ReadonlyArray<string> = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
];

/**
 * Polls until the thread has its `ordinal`-th run (1-based) in a state the
 * predicate accepts, failing with the server log on timeout.
 */
export const awaitNativeRun = (
  server: KmCodeServer,
  input: {
    readonly threadId: ThreadId;
    readonly ordinal: number;
    readonly until?: (status: string) => boolean;
    readonly timeoutMs?: number;
  },
) =>
  Effect.gen(function* () {
    const until = input.until ?? ((status: string) => TERMINAL_RUN_STATUSES.includes(status));
    const deadline = (yield* Clock.currentTimeMillis) + (input.timeoutMs ?? 90_000);
    while (true) {
      const projection = yield* readNativeThread(server, input.threadId);
      const run = projection.runs[input.ordinal - 1];
      if (run !== undefined && until(run.status)) return { run, projection };
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(
          `Run ${input.ordinal} of ${input.threadId} timed out at ${run?.status ?? "missing"}.\n${server.output().slice(-8_000)}`,
        );
      }
      yield* Effect.sleep("250 millis");
    }
  });

export const lastAssistantText = (projection: OrchestrationV2ThreadProjection) =>
  projection.messages.findLast((message) => message.role === "assistant")?.text ?? "";
