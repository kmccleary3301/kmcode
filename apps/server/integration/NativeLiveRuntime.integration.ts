// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OmpChunkAssembler } from "../src/provider/piFamily/OmpChunkAssembler.ts";
import type { NativeTraceSinkFactory } from "../src/provider/piFamily/NativeTrace.ts";
import type { JsonRecord, PiFamilyRuntimeKind } from "../src/provider/piFamily/protocol.ts";

export type NativeLiveRuntime = PiFamilyRuntimeKind;

export interface NativeLiveConfig {
  readonly runtime: NativeLiveRuntime;
  readonly provider: ProviderDriverKind;
  readonly binaryPath: string;
  readonly launchArguments: ReadonlyArray<string>;
  readonly trustMode?: string;
}

export interface NativeLiveModelServer {
  readonly baseUrl: string;
  readonly requestCount: () => number;
  readonly imageRequestCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * In-memory negotiated capability summary. Only the capability response and
 * response command names are retained; prompt/model bytes are never retained.
 */
export interface NativeLiveCapabilityObservation {
  readonly responseCommands: string[];
  readonly frameTypes: string[];
  readonly stdinFrameTypes: string[];
  readonly uiRequests: Array<{
    readonly id: string;
    readonly method: string;
    readonly message?: string;
  }>;
  capabilities?: Readonly<Record<string, unknown>>;
}

export const makeNativeLiveTraceSinkFactory = (
  observation: NativeLiveCapabilityObservation,
): NativeTraceSinkFactory => ({
  create: () => {
    let stdoutPending = "";
    let stdinPending = "";
    return {
      recordBytes: (stream, bytes) => {
        if (stream !== "stdout" && stream !== "stdin") return;
        const pending =
          (stream === "stdout" ? stdoutPending : stdinPending) + new TextDecoder().decode(bytes);
        const lines = pending.split("\n");
        if (stream === "stdout") stdoutPending = lines.pop() ?? "";
        else stdinPending = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const frame = JSON.parse(line) as {
              readonly type?: unknown;
              readonly command?: unknown;
              readonly data?: unknown;
              readonly id?: unknown;
              readonly method?: unknown;
              readonly message?: unknown;
            };
            if (stream === "stdin") {
              if (typeof frame.type === "string") observation.stdinFrameTypes.push(frame.type);
              continue;
            }
            if (typeof frame.type === "string") observation.frameTypes.push(frame.type);
            if (
              frame.type === "extension_ui_request" &&
              typeof frame.id === "string" &&
              typeof frame.method === "string"
            ) {
              observation.uiRequests.push({
                id: frame.id,
                method: frame.method,
                ...(typeof frame.message === "string" && frame.message.startsWith("NATIVE-MATRIX-")
                  ? { message: frame.message }
                  : {}),
              });
            }
            if (frame.type !== "response" || typeof frame.command !== "string") continue;
            observation.responseCommands.push(frame.command);
            if (
              frame.command === "get_capabilities" &&
              typeof frame.data === "object" &&
              frame.data !== null &&
              !Array.isArray(frame.data)
            ) {
              observation.capabilities = frame.data as Readonly<Record<string, unknown>>;
            }
          } catch {
            // Split or diagnostic lines contain no retained capability evidence.
          }
        }
      },
      recordExit: () => {},
      invalidate: () => {},
      finalize: () => {},
    };
  },
});
/**
 * Captures one synthetic-model prompt as decoded native envelopes. The caller
 * owns the in-memory array; nothing containing prompt or model bytes is written
 * to disk.
 */
export const makeNativeLivePromptCaptureSinkFactory = (
  runtime: NativeLiveRuntime,
  captured: JsonRecord[],
): NativeTraceSinkFactory => ({
  create: () => {
    let stdoutPending = "";
    const chunkAssembler = runtime === "omp" ? new OmpChunkAssembler() : undefined;
    const handleStdout = (value: unknown) => {
      let frame: unknown = value;
      if (chunkAssembler) {
        frame = chunkAssembler.accept(value);
        if (frame === undefined) return;
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
      const record = frame as JsonRecord;
      if (record.type === "response" || record.type === "ready") return;
      captured.push(record);
    };
    return {
      recordBytes: (stream, bytes) => {
        if (stream !== "stdout") return;
        const lines = (stdoutPending + new TextDecoder().decode(bytes)).split("\n");
        stdoutPending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) handleStdout(JSON.parse(line));
        }
      },
      recordExit: () => {},
      invalidate: () => {
        captured.length = 0;
      },
      finalize: () => {},
    };
  },
});

/**
 * A bounded no-retention sink still exercises the adapter's child-exit lifecycle
 * without placing native prompts or model output in test artifacts.
 */
export const nativeLiveTraceSinkFactory: NativeTraceSinkFactory = {
  create: () => ({
    recordBytes: () => {},
    recordExit: () => {},
    invalidate: () => {},
    finalize: () => {},
  }),
};
export const nativeLiveConfiguration = (
  runtime: NativeLiveRuntime,
): NativeLiveConfig | undefined => {
  const binaryPath = process.env[`T3_NATIVE_${runtime.toUpperCase()}_BINARY`]?.trim();
  if (!binaryPath) return undefined;
  return {
    runtime,
    provider: ProviderDriverKind.make(runtime),
    binaryPath,
    launchArguments:
      runtime === "pi"
        ? [
            "--mode",
            "rpc",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--offline",
            "--provider",
            "local",
            "--model",
            "local/test",
          ]
        : [
            "--mode",
            "rpc",
            "--no-skills",
            "--no-rules",
            "--no-title",
            "--provider",
            "local",
            "--model",
            "local/test",
          ],
    ...(runtime === "pi" ? { trustMode: "approve-for-this-run" } : {}),
  };
};

export const configuredNativeLiveConfigurations = (): ReadonlyArray<NativeLiveConfig> => {
  const runtimeFilter = process.env.T3_NATIVE_LIVE_RUNTIME?.trim();
  return (["pi", "omp"] as const)
    .map(nativeLiveConfiguration)
    .filter(
      (config): config is NativeLiveConfig =>
        config !== undefined && (runtimeFilter === undefined || config.runtime === runtimeFilter),
    );
};

export const makeNativeLiveModelServer = Effect.tryPromise<NativeLiveModelServer>(() => {
  const { promise, resolve, reject } = Promise.withResolvers<NativeLiveModelServer>();
  let requestCount = 0;
  let imageRequestCount = 0;
  let retryFailureCount = 0;
  let rawSteerHoldDelayCount = 0;
  const pendingTimers = new Set<NodeJS.Timeout>();
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("error", () => response.destroy());
    request.on("end", () => {
      let message = "";
      let bodyText = "";
      let hasToolResult = false;
      try {
        bodyText = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(bodyText) as {
          readonly messages?: ReadonlyArray<{
            readonly role?: unknown;
            readonly content?: unknown;
          }>;
        };
        const messages = body.messages ?? [];
        const latestUserIndex = messages.findLastIndex((entry) => entry.role === "user");
        hasToolResult = messages.slice(latestUserIndex + 1).some((entry) => entry.role === "tool");
        const content = messages[latestUserIndex]?.content;
        message = typeof content === "string" ? content : JSON.stringify(content ?? "");
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (
        bodyText.includes('"image_url"') ||
        bodyText.includes('"type":"image"') ||
        bodyText.includes('"type": "image"')
      ) {
        imageRequestCount += 1;
      }
      const requestNumber = requestCount + 1;
      if (message.includes("NATIVE-MATRIX-RETRY") && retryFailureCount === 0) {
        retryFailureCount += 1;
        requestCount = requestNumber;
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(
          JSON.stringify({
            error: {
              message: "Native matrix transient failure.",
              type: "rate_limit_error",
            },
          }),
        );
        return;
      }
      const rawSteerHold =
        message.includes("NATIVE-MATRIX-RAW-STEER-HOLD") && rawSteerHoldDelayCount === 0;
      if (rawSteerHold) rawSteerHoldDelayCount += 1;
      const delayMs = message.includes("NATIVE-MATRIX-HOLD")
        ? 30_000
        : bodyText.includes("NATIVE-MATRIX-SUBAGENT-GRANDCHILD-HOLD")
          ? 30_000
          : rawSteerHold
            ? 500
            : message.includes("NATIVE-MATRIX-RAW-FOLLOW-HOLD")
              ? 500
              : message.includes("NATIVE-MATRIX-WRITE")
                ? 500
                : 0;
      let timer: NodeJS.Timeout | undefined;
      const send = () => {
        requestCount = requestNumber;
        if (timer !== undefined) {
          pendingTimers.delete(timer);
          timer = undefined;
        }
        const bashToolTurn = message.includes("NATIVE-MATRIX-TOOL") && !hasToolResult;
        const parentTaskTurn = message.includes("NATIVE-MATRIX-SUBAGENT-PARENT") && !hasToolResult;
        const parityTaskTurn =
          message.includes("NATIVE-MATRIX-SUBAGENT-PARITY-PARENT") && !hasToolResult;
        const childTaskTurn =
          bodyText.includes("NATIVE-MATRIX-SUBAGENT-CHILD") &&
          !bodyText.includes("NATIVE-MATRIX-SUBAGENT-PARITY-CHILD") &&
          !hasToolResult;
        const toolTurn = bashToolTurn || parentTaskTurn || parityTaskTurn || childTaskTurn;
        const toolName = bashToolTurn ? "bash" : "task";
        const toolArguments = bashToolTurn
          ? '{"command":"printf NATIVE-MATRIX-TOOL-OK"}'
          : parityTaskTurn
            ? '{"context":"Native parity task.","tasks":[{"name":"MatrixParityChild","task":"NATIVE-MATRIX-SUBAGENT-PARITY-CHILD"}]}'
            : parentTaskTurn
              ? '{"context":"Native nested task.","tasks":[{"name":"MatrixChild","task":"NATIVE-MATRIX-SUBAGENT-CHILD"}]}'
              : '{"context":"Native nested child task.","tasks":[{"name":"MatrixGrandchild","agent":"sonic","task":"NATIVE-MATRIX-SUBAGENT-GRANDCHILD-HOLD"}]}';
        const marker = hasToolResult
          ? "NATIVE-MATRIX-TOOL-OK"
          : message.includes("RESTORED")
            ? "NATIVE-MATRIX-RESTORED-OK"
            : "NATIVE-MATRIX-OK";
        const usage = bodyText.includes("NATIVE-MATRIX-COMPACTION")
          ? {
              prompt_tokens: Math.ceil(bodyText.length / 4),
              completion_tokens: 10,
              total_tokens: Math.ceil(bodyText.length / 4) + 10,
            }
          : undefined;
        const frames = toolTurn
          ? [
              {
                id: `native-matrix-${requestNumber}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `native-matrix-${toolName}`,
                          type: "function",
                          function: {
                            name: toolName,
                            arguments: toolArguments,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: `native-matrix-${requestNumber}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              },
            ]
          : [
              {
                id: `native-matrix-${requestNumber}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: marker },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: `native-matrix-${requestNumber}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                ...(usage === undefined ? {} : { usage }),
              },
            ];
        if (!response.headersSent) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        response.end(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        );
      };
      if (delayMs > 0) {
        if (!response.headersSent) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.flushHeaders();
        }
        requestCount = requestNumber;
        response.write(": native-matrix-hold\n\n");
        // @effect-diagnostics-next-line globalTimers:off - Native HTTP test server delay.
        timer = setTimeout(send, delayMs);
        pendingTimers.add(timer);
        response.once("close", () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            pendingTimers.delete(timer);
            timer = undefined;
          }
        });
      } else {
        send();
      }
    });
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Native live model server did not expose a TCP address."));
      return;
    }
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requestCount: () => requestCount,
      imageRequestCount: () => imageRequestCount,
      close: () => {
        const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();
        server.closeAllConnections();
        server.closeIdleConnections();
        server.close(() => resolveClose());
        return closePromise;
      },
    });
  });
  return promise;
});

class NativeLiveRuntimeError extends Schema.TaggedError<NativeLiveRuntimeError>()(
  "NativeLiveRuntimeError",
  { cause: Schema.Defect() },
) {}
const nativeLiveError = (cause: unknown): NativeLiveRuntimeError =>
  new NativeLiveRuntimeError({ cause });
export interface NativeLiveQueueObservation {
  readonly responseCommands: ReadonlyArray<string>;
  readonly frameTypes: ReadonlyArray<string>;
  readonly subagentStatuses: ReadonlyArray<string>;
  readonly compaction?: {
    readonly firstKeptEntryId: string;
    readonly summaryLength: number;
    readonly tokensBefore: number;
  };
  readonly compactionPersisted?: true;
  readonly processExited?: true;
  readonly taskCancellation?: {
    readonly parentTaskId: string;
    readonly nestedTaskId: string;
    readonly runId: string;
    readonly detached: true;
    readonly terminalStatus: "aborted";
  };
}

/**
 * Exercises stock RPC lifecycle commands directly. T3's adapter owns normal
 * prompting; this probe isolates native steer/follow-up and OMP branch/resume
 * semantics without injecting untracked extension messages into a T3 turn.
 */
export const exerciseNativeLiveQueueModes = (
  config: NativeLiveConfig,
  agentDirectory: string,
): Effect.Effect<NativeLiveQueueObservation, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<NativeLiveQueueObservation>((resolve, reject) => {
        const child = NodeChildProcess.spawn(config.binaryPath, [...config.launchArguments], {
          cwd: agentDirectory,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDirectory,
          },
          shell: /\.(?:cmd|bat)$/iu.test(config.binaryPath),
          stdio: ["pipe", "pipe", "pipe"],
        });
        const responseCommands: string[] = [];
        const frameTypes: string[] = [];
        const subagentStatuses: string[] = [];
        let stdoutPending = "";
        let stderrTail = "";
        let phase:
          | "starting"
          | "steer-root"
          | "steer-queued"
          | "follow-root"
          | "follow-queued"
          | "branch-messages"
          | "branching"
          | "resuming"
          | "resume-root"
          | "compacting"
          | "subagent-root"
          | "listing-task"
          | "cancelling-task"
          | "awaiting-task-terminal"
          | "verifying-task-settlement"
          | "stopping" = "starting";
        let steerResponse = false;
        let steerTerminal = false;
        let followUpResponse = false;
        let followUpTerminal = false;
        let originalSessionFile: string | undefined;
        let parentTaskId: string | undefined;
        let parentRunId: string | undefined;
        let nestedTaskId: string | undefined;
        let parentTerminalStatus: string | undefined;
        let cancellationConfirmed = false;
        let supportsTargetedCancellation = false;
        let supportsTaskHierarchy = false;
        let compactionResult:
          | {
              readonly firstKeptEntryId: string;
              readonly summaryLength: number;
              readonly tokensBefore: number;
            }
          | undefined;
        let compactionSummary: string | undefined;
        const startedTaskIds: string[] = [];
        let outcome: NativeLiveQueueObservation | Error | undefined;
        let hardKillTimer: NodeJS.Timeout | undefined;
        let deadlineTimer: NodeJS.Timeout | undefined;

        const send = (frame: Readonly<Record<string, unknown>>) => {
          child.stdin.write(`${JSON.stringify(frame)}\n`);
        };
        const stop = (result: NativeLiveQueueObservation | Error) => {
          if (outcome !== undefined) return;
          outcome = result;
          phase = "stopping";
          child.kill("SIGTERM");
          // @effect-diagnostics-next-line globalTimers:off - Owned test child cleanup deadline.
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        };
        const maybeAdvance = () => {
          if (phase === "steer-queued" && steerResponse && steerTerminal) {
            phase = "follow-root";
            send({
              id: "native-matrix-follow-root",
              type: "prompt",
              message: "NATIVE-MATRIX-RAW-FOLLOW-HOLD",
            });
            return;
          }
          if (phase === "follow-queued" && followUpResponse && followUpTerminal) {
            if (config.runtime === "omp") {
              phase = "branch-messages";
              send({ id: "native-matrix-branch-messages", type: "get_branch_messages" });
              return;
            }
            const queueUpdates = frameTypes.filter((type) => type === "queue_update").length;
            if (queueUpdates < 2) {
              stop(new Error(`Native queue probe observed ${queueUpdates} queue updates.`));
              return;
            }
            stop({
              responseCommands: [...responseCommands],
              frameTypes: [...frameTypes],
              subagentStatuses: [...subagentStatuses],
            });
          }
        };
        const startSteering = () => {
          phase = "steer-root";
          send({
            id: "native-matrix-steer-root",
            type: "prompt",
            message: "NATIVE-MATRIX-RAW-STEER-HOLD",
          });
        };
        const handleFrame = (frame: Readonly<Record<string, unknown>>) => {
          if (typeof frame.type === "string") frameTypes.push(frame.type);
          if (frame.type === "response" && typeof frame.command === "string") {
            responseCommands.push(frame.command);
            if (frame.command === "negotiate_protocol") {
              send({ id: "native-matrix-capabilities", type: "get_capabilities" });
              return;
            }
            if (frame.command === "get_capabilities") {
              if (frame.success === true) {
                const data =
                  typeof frame.data === "object" && frame.data !== null
                    ? (frame.data as Readonly<Record<string, unknown>>)
                    : undefined;
                const sessions =
                  typeof data?.sessions === "object" && data.sessions !== null
                    ? (data.sessions as Readonly<Record<string, unknown>>)
                    : undefined;
                const tasks =
                  typeof data?.tasks === "object" && data.tasks !== null
                    ? (data.tasks as Readonly<Record<string, unknown>>)
                    : undefined;
                if (
                  sessions?.fork !== true ||
                  sessions.resume !== true ||
                  sessions.compact !== true ||
                  tasks?.nested !== true ||
                  tasks.background !== true
                ) {
                  stop(new Error("OMP queue probe received an incomplete capability profile."));
                  return;
                }
                supportsTargetedCancellation = tasks.targetedCancellation === true;
                supportsTaskHierarchy = tasks.nested === true && tasks.background === true;
              }
              send({
                id: "native-matrix-subagent-subscription",
                type: "set_subagent_subscription",
                level: "events",
              });
              return;
            }
            if (frame.command === "set_subagent_subscription") {
              if (frame.success !== true) {
                stop(
                  new Error(
                    `OMP queue probe could not subscribe to subagents: ${JSON.stringify(frame)}`,
                  ),
                );
                return;
              }
              send({ id: "native-matrix-state", type: "get_state" });
              return;
            }
            if (frame.command === "get_state") {
              if (config.runtime === "omp") {
                const data =
                  typeof frame.data === "object" && frame.data !== null
                    ? (frame.data as Readonly<Record<string, unknown>>)
                    : undefined;
                originalSessionFile =
                  typeof data?.sessionFile === "string" ? data.sessionFile : undefined;
                if (!originalSessionFile) {
                  stop(new Error("OMP queue probe did not expose its persisted session file."));
                  return;
                }
              }
              startSteering();
              return;
            }
            if (frame.command === "steer" && frame.success === true) {
              steerResponse = true;
              maybeAdvance();
              return;
            }
            if (frame.command === "follow_up" && frame.success === true) {
              followUpResponse = true;
              maybeAdvance();
              return;
            }
            if (frame.command === "get_branch_messages" && frame.success === true) {
              const data =
                typeof frame.data === "object" && frame.data !== null
                  ? (frame.data as Readonly<Record<string, unknown>>)
                  : undefined;
              const messages = Array.isArray(data?.messages) ? data.messages : [];
              const candidate = messages.at(-1);
              const entryId =
                typeof candidate === "object" &&
                candidate !== null &&
                typeof (candidate as Readonly<Record<string, unknown>>).entryId === "string"
                  ? ((candidate as Readonly<Record<string, unknown>>).entryId as string)
                  : undefined;
              if (phase !== "branch-messages" || !entryId) {
                stop(new Error("OMP queue probe did not expose a branchable entry."));
                return;
              }
              phase = "branching";
              send({ id: "native-matrix-branch", type: "branch", entryId });
              return;
            }
            if (frame.command === "branch" && frame.success === true) {
              const data =
                typeof frame.data === "object" && frame.data !== null
                  ? (frame.data as Readonly<Record<string, unknown>>)
                  : undefined;
              if (phase !== "branching" || data?.cancelled !== false || !originalSessionFile) {
                stop(new Error("OMP queue probe did not complete its session branch."));
                return;
              }
              phase = "resuming";
              send({
                id: "native-matrix-resume",
                type: "switch_session",
                sessionPath: originalSessionFile,
              });
              return;
            }
            if (frame.command === "switch_session" && frame.success === true) {
              const data =
                typeof frame.data === "object" && frame.data !== null
                  ? (frame.data as Readonly<Record<string, unknown>>)
                  : undefined;
              if (phase !== "resuming" || data?.cancelled !== false) {
                stop(new Error("OMP queue probe did not resume its original session."));
                return;
              }
              phase = "resume-root";
              send({
                id: "native-matrix-resumed-prompt",
                type: "prompt",
                message: `NATIVE-MATRIX-RAW-RESUMED ${"context ".repeat(20_000)}`,
              });
              return;
            }
            if (frame.command === "compact") {
              const data =
                typeof frame.data === "object" && frame.data !== null
                  ? (frame.data as Readonly<Record<string, unknown>>)
                  : undefined;
              if (
                phase !== "compacting" ||
                frame.success !== true ||
                typeof data?.summary !== "string" ||
                data.summary.length === 0 ||
                typeof data.firstKeptEntryId !== "string" ||
                data.firstKeptEntryId.length === 0 ||
                typeof data.tokensBefore !== "number" ||
                data.tokensBefore < 0
              ) {
                stop(new Error(`OMP queue probe compaction failed: ${JSON.stringify(frame)}`));
                return;
              }
              compactionResult = {
                firstKeptEntryId: data.firstKeptEntryId,
                summaryLength: data.summary.length,
                tokensBefore: data.tokensBefore,
              };
              compactionSummary = data.summary;
              if (!supportsTaskHierarchy) {
                stop({
                  responseCommands: [...responseCommands],
                  frameTypes: [...frameTypes],
                  subagentStatuses: [...subagentStatuses],
                  compaction: compactionResult,
                });
                return;
              }
              phase = "subagent-root";
              send({
                id: "native-matrix-subagent-root",
                type: "prompt",
                message: "NATIVE-MATRIX-SUBAGENT-PARENT",
              });
              return;
            }
            if (frame.command === "get_subagents") {
              const data =
                typeof frame.data === "object" && frame.data !== null
                  ? (frame.data as Readonly<Record<string, unknown>>)
                  : undefined;
              const subagents = Array.isArray(data?.subagents)
                ? (data.subagents as ReadonlyArray<Readonly<Record<string, unknown>>>)
                : [];
              if (phase === "listing-task") {
                const snapshot = subagents.find(
                  (entry) => entry.id === startedTaskIds[0] && entry.status === "running",
                );
                if (
                  snapshot === undefined ||
                  snapshot.detached !== true ||
                  typeof snapshot.id !== "string" ||
                  typeof snapshot.runId !== "string" ||
                  nestedTaskId === undefined ||
                  compactionResult === undefined ||
                  snapshot.id === nestedTaskId
                ) {
                  stop(
                    new Error(
                      `OMP queue probe task hierarchy was incomplete: ${JSON.stringify(data)}`,
                    ),
                  );
                  return;
                }
                parentTaskId = snapshot.id;
                parentRunId = snapshot.runId;
                if (!supportsTargetedCancellation) {
                  stop({
                    responseCommands: [...responseCommands],
                    frameTypes: [...frameTypes],
                    subagentStatuses: [...subagentStatuses],
                    compaction: compactionResult,
                  });
                  return;
                }
                phase = "cancelling-task";
                send({
                  id: "native-matrix-cancel-task",
                  type: "cancel_task",
                  taskId: parentTaskId,
                  runId: parentRunId,
                });
                return;
              }
              if (phase === "verifying-task-settlement") {
                const parent = subagents.find((entry) => entry.id === parentTaskId);
                if (
                  parent?.status !== "aborted" ||
                  subagents.some((entry) => entry.status === "running") ||
                  parentTaskId === undefined ||
                  parentRunId === undefined ||
                  nestedTaskId === undefined ||
                  compactionResult === undefined
                ) {
                  stop(
                    new Error(
                      `OMP queue probe task settlement was incomplete: ${JSON.stringify(data)}`,
                    ),
                  );
                  return;
                }
                stop({
                  responseCommands: [...responseCommands],
                  frameTypes: [...frameTypes],
                  subagentStatuses: [...subagentStatuses],
                  compaction: compactionResult,
                  taskCancellation: {
                    parentTaskId,
                    nestedTaskId,
                    runId: parentRunId,
                    detached: true,
                    terminalStatus: "aborted",
                  },
                });
                return;
              }
            }
            if (frame.command === "cancel_task") {
              const data =
                typeof frame.data === "object" && frame.data !== null
                  ? (frame.data as Readonly<Record<string, unknown>>)
                  : undefined;
              if (
                phase !== "cancelling-task" ||
                frame.success !== true ||
                data?.cancelled !== true ||
                data.taskId !== parentTaskId ||
                (data.runId !== undefined && data.runId !== parentRunId)
              ) {
                stop(
                  new Error(`OMP queue probe task cancellation failed: ${JSON.stringify(frame)}`),
                );
                return;
              }
              cancellationConfirmed = true;
              phase = "awaiting-task-terminal";
              if (parentTerminalStatus === "aborted") {
                phase = "verifying-task-settlement";
                send({ id: "native-matrix-settled-subagents", type: "get_subagents" });
              }
              return;
            }
          }
          if (frame.type === "subagent_lifecycle") {
            const payload =
              typeof frame.payload === "object" && frame.payload !== null
                ? (frame.payload as Readonly<Record<string, unknown>>)
                : undefined;
            const id = typeof payload?.id === "string" ? payload.id : undefined;
            const status = typeof payload?.status === "string" ? payload.status : undefined;
            if (status !== undefined) subagentStatuses.push(status);
            if (status === "started" && id !== undefined && !startedTaskIds.includes(id)) {
              startedTaskIds.push(id);
            }
            if (
              id === parentTaskId &&
              (status === "aborted" || status === "failed" || status === "completed")
            ) {
              parentTerminalStatus = status;
              if (status !== "aborted") {
                stop(new Error(`OMP queue probe cancelled task settled as ${status}.`));
                return;
              }
              if (cancellationConfirmed && phase === "awaiting-task-terminal") {
                phase = "verifying-task-settlement";
                send({ id: "native-matrix-settled-subagents", type: "get_subagents" });
              }
            }
          }
          if (frame.type === "subagent_event") {
            const payload =
              typeof frame.payload === "object" && frame.payload !== null
                ? (frame.payload as Readonly<Record<string, unknown>>)
                : undefined;
            const event =
              typeof payload?.event === "object" && payload.event !== null
                ? (payload.event as Readonly<Record<string, unknown>>)
                : undefined;
            if (typeof event?.type === "string") {
              frameTypes.push(
                `subagent:${event.type}:${typeof event.toolName === "string" ? event.toolName : ""}`,
              );
            }
            if (
              phase === "subagent-root" &&
              event?.type === "tool_execution_update" &&
              event.toolName === "task" &&
              startedTaskIds[0] !== undefined
            ) {
              const partialResult =
                typeof event.partialResult === "object" && event.partialResult !== null
                  ? (event.partialResult as Readonly<Record<string, unknown>>)
                  : undefined;
              const details =
                typeof partialResult?.details === "object" && partialResult.details !== null
                  ? (partialResult.details as Readonly<Record<string, unknown>>)
                  : undefined;
              const progress = Array.isArray(details?.progress)
                ? (details.progress as ReadonlyArray<Readonly<Record<string, unknown>>>)
                : [];
              const nested = progress.find(
                (entry) =>
                  typeof entry.id === "string" &&
                  entry.id !== startedTaskIds[0] &&
                  entry.status === "running",
              );
              if (nested === undefined || typeof nested.id !== "string") return;
              nestedTaskId = nested.id;
              phase = "listing-task";
              send({ id: "native-matrix-running-subagents", type: "get_subagents" });
              return;
            }
          }
          if (frame.type === "agent_start") {
            if (phase === "steer-root") {
              phase = "steer-queued";
              send({
                id: "native-matrix-steer",
                type: "steer",
                message: "NATIVE-MATRIX-RAW-STEER",
              });
            } else if (phase === "follow-root") {
              phase = "follow-queued";
              send({
                id: "native-matrix-follow-up",
                type: "follow_up",
                message: "NATIVE-MATRIX-RAW-FOLLOW-UP",
              });
            }
            return;
          }
          const terminal =
            frame.type === "agent_settled" ||
            (config.runtime === "omp" && frame.type === "agent_end");
          if (!terminal) return;
          if (phase === "steer-queued") steerTerminal = true;
          else if (phase === "follow-queued") followUpTerminal = true;
          else if (phase === "resume-root") {
            phase = "compacting";
            send({
              id: "native-matrix-compact",
              type: "compact",
              customInstructions: "Retain the native matrix marker.",
            });
            return;
          }
          maybeAdvance();
        };

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdoutPending += chunk.toString();
          const lines = stdoutPending.split("\n");
          stdoutPending = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const frame = JSON.parse(line) as Readonly<Record<string, unknown>>;
              handleFrame(frame);
            } catch {
              // Non-JSON diagnostics are ignored; strict adapter parsing is tested separately.
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_048);
        });
        child.once("spawn", () => {
          if (config.runtime === "omp") {
            send({
              id: "native-matrix-negotiate",
              type: "negotiate_protocol",
              protocolVersion: 2,
            });
          } else {
            send({ id: "native-matrix-state", type: "get_state" });
          }
        });
        child.once("error", (cause) => stop(cause));
        child.once("exit", (code, signal) => {
          clearTimeout(hardKillTimer);
          clearTimeout(deadlineTimer);
          if (outcome instanceof Error) {
            reject(outcome);
          } else if (outcome !== undefined) {
            if (
              config.runtime === "omp" &&
              originalSessionFile !== undefined &&
              compactionResult !== undefined &&
              compactionSummary !== undefined
            ) {
              const expectedCompaction = compactionResult;
              const persisted = NodeFS.readFileSync(originalSessionFile, "utf8")
                .split("\n")
                .some((line) => {
                  if (line.length === 0) return false;
                  try {
                    const entry = JSON.parse(line) as Readonly<Record<string, unknown>>;
                    return (
                      entry.type === "compaction" &&
                      entry.summary === compactionSummary &&
                      entry.firstKeptEntryId === expectedCompaction.firstKeptEntryId
                    );
                  } catch {
                    return false;
                  }
                });
              if (!persisted) {
                reject(new Error("OMP queue probe compaction was not persisted to session state."));
                return;
              }
              resolve({ ...outcome, compactionPersisted: true, processExited: true });
              return;
            }
            resolve({ ...outcome, processExited: true });
          } else {
            reject(
              new Error(
                `Native queue probe exited before settlement (code=${String(code)}, signal=${String(signal)}, stderr=${stderrTail || "none"}).`,
              ),
            );
          }
        });
        // @effect-diagnostics-next-line globalTimers:off - Real-runtime integration deadline.
        deadlineTimer = setTimeout(
          () =>
            stop(
              new Error(
                `Native queue probe timed out during ${phase}; responses=${responseCommands.join(",")}; frames=${frameTypes.slice(-12).join(",")}; subagents=${subagentStatuses.join(",")}.`,
              ),
            ),
          20_000,
        );
      }),
    catch: nativeLiveError,
  });

export const makeNativeLiveAgentDirectory = (
  prefix = "t3-native-live-",
): Effect.Effect<string, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      if (NodePath.basename(prefix) !== prefix) {
        throw new Error(`Native live temp prefix must be a basename: ${prefix}`);
      }
      const directory = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
      await NodeFS.promises.chmod(directory, 0o700);
      return directory;
    },
    catch: nativeLiveError,
  });

/**
 * Launches the configured stock runtime as a child and terminates only that
 * owned child when the crash marker crosses stdin. This keeps the production
 * adapter unmodified while exercising its real child-exit path.
 */
export const writeNativeCrashWrapper = (
  agentDirectory: string,
): Effect.Effect<
  { readonly wrapperPath: string; readonly pidPath: string },
  NativeLiveRuntimeError
> =>
  Effect.tryPromise({
    try: async () => {
      const wrapperPath = NodePath.join(agentDirectory, "native-crash-wrapper.cjs");
      const pidPath = NodePath.join(agentDirectory, "native-crash-processes.json");
      await NodeFS.promises.writeFile(
        wrapperPath,
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'const readline = require("node:readline");',
          "const [pidPath, binaryPath, ...binaryArguments] = process.argv.slice(2);",
          "const child = spawn(binaryPath, binaryArguments, { shell: process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(binaryPath), stdio: ['pipe', 'pipe', 'pipe'] });",
          "const processRecords = fs.existsSync(pidPath) ? JSON.parse(fs.readFileSync(pidPath, 'utf8')) : [];",
          "processRecords.push({ wrapperPid: process.pid, childPid: child.pid });",
          "fs.writeFileSync(pidPath, JSON.stringify(processRecords));",
          "child.stdout.pipe(process.stdout);",
          "child.stderr.pipe(process.stderr);",
          "let crashing = false;",
          "const input = readline.createInterface({ input: process.stdin });",
          "input.on('line', (line) => {",
          "  child.stdin.write(line + '\\n');",
          "  if (!crashing && line.includes('NATIVE-MATRIX-CRASH')) {",
          "    crashing = true;",
          "    setTimeout(() => child.kill('SIGKILL'), 750);",
          "  }",
          "});",
          "input.on('close', () => child.stdin.end());",
          "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {",
          "  process.on(signal, () => child.kill(signal));",
          "}",
          "child.once('error', () => process.exit(127));",
          "child.once('exit', (code, signal) => {",
          "  process.exit(code ?? (signal ? 137 : 1));",
          "});",
          "process.once('exit', () => {",
          "  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');",
          "});",
        ].join("\n") + "\n",
        { mode: 0o700 },
      );
      return { wrapperPath, pidPath };
    },
    catch: nativeLiveError,
  });

export const writeNativeLiveConfig = (
  config: NativeLiveConfig,
  agentDirectory: string,
  modelServer: NativeLiveModelServer,
  options?: { readonly asyncEnabled?: boolean },
): Effect.Effect<void, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      if (config.runtime === "pi") {
        await NodeFS.promises.writeFile(
          NodePath.join(agentDirectory, "models.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Pi model test config is JSON.
          JSON.stringify({
            providers: {
              local: {
                baseUrl: modelServer.baseUrl,
                api: "openai-completions",
                apiKey: "native-matrix",
                models: ["test", "alternate"].map((id) => ({
                  id,
                  name: `Native Matrix ${id}`,
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 128_000,
                  maxTokens: 1024,
                })),
              },
            },
          }),
          { mode: 0o600 },
        );
        await NodeFS.promises.writeFile(
          NodePath.join(agentDirectory, "settings.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Pi settings test config is JSON.
          JSON.stringify({
            defaultProvider: "local",
            defaultModel: "test",
            defaultThinkingLevel: "off",
          }),
          { mode: 0o600 },
        );
        return;
      }
      await NodeFS.promises.writeFile(
        NodePath.join(agentDirectory, "models.yml"),
        [
          "providers:",
          "  local:",
          `    baseUrl: ${modelServer.baseUrl}`,
          "    api: openai-completions",
          "    auth: none",
          "    models:",
          "      - id: test",
          "        name: Native Matrix Test",
          "        reasoning: true",
          "        thinking: { mode: effort, efforts: [low, medium, high] }",
          "        input: [text, image]",
          "        contextWindow: 128000",
          "        maxTokens: 1024",
          "      - id: alternate",
          "        name: Native Matrix Alternate",
          "        reasoning: true",
          "        thinking: { mode: effort, efforts: [low, medium, high] }",
          "        input: [text, image]",
          "        contextWindow: 128000",
          "        maxTokens: 1024",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      await NodeFS.promises.writeFile(
        NodePath.join(agentDirectory, "config.yml"),
        [
          "modelRoles:",
          "  task: local/test",
          "  smol: local/test",
          "async:",
          `  enabled: ${options?.asyncEnabled ?? true}`,
          "task:",
          "  isolation:",
          "    mode: none",
          "  maxRecursionDepth: 2",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
    },
    catch: nativeLiveError,
  });

export const enableNativeLiveCompaction = (
  agentDirectory: string,
): Effect.Effect<void, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const configPath = NodePath.join(agentDirectory, "config.yml");
      const current = await NodeFS.promises.readFile(configPath, "utf8");
      await NodeFS.promises.writeFile(
        configPath,
        [
          current.trimEnd(),
          "compaction:",
          "  enabled: true",
          "  strategy: context-full",
          "  thresholdTokens: 1000",
          "  reserveTokens: 200",
          "  keepRecentTokens: 200",
          "  autoContinue: false",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    },
    catch: nativeLiveError,
  });
/** Writes an explicit extension fixture; native runtimes load it through their RPC extension API. */
export const writeNativeLiveExtension = (
  agentDirectory: string,
): Effect.Effect<string, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const extensionPath = NodePath.join(agentDirectory, "native-matrix-extension.ts");
      await NodeFS.promises.writeFile(
        extensionPath,
        [
          "export default function (pi) {",
          '  pi.on("before_agent_start", async (event, ctx) => {',
          '    if (event.prompt.includes("NATIVE-MATRIX-UI")) {',
          '      const accepted = await ctx.ui.confirm("Native matrix confirmation", "Accept the portable UI branch?", { timeout: 5000 });',
          '      ctx.ui.notify(accepted ? "NATIVE-MATRIX-UI-OK" : "NATIVE-MATRIX-UI-CANCELLED", "info");',
          "    }",
          '    if (event.prompt.includes("NATIVE-MATRIX-TASK")) {',
          "      if (!ctx.hostTasks) {",
          '        ctx.ui.notify("NATIVE-MATRIX-TASK-UNSUPPORTED", "warning");',
          "      } else {",
          "        const task = ctx.hostTasks.start({",
          '          id: "native-matrix-semantic-task",',
          '          kind: "job",',
          '          title: "Native matrix semantic task",',
          '          parentToolCallId: "native-matrix-extension-hook",',
          "        });",
          '        task.update({ currentActivity: "NATIVE-MATRIX-TASK-PROGRESS", usage: { toolCalls: 1 } });',
          '        task.complete({ summary: "NATIVE-MATRIX-TASK-OK", usage: { toolCalls: 1 } });',
          "      }",
          "    }",
          "  });",
          "}",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      return extensionPath;
    },
    catch: nativeLiveError,
  });
