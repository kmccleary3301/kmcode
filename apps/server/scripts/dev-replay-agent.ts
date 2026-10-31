#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * A free ACP agent for dev servers. It plays recorded ACP transcripts with simulated
 * streaming, so the real adapter, orchestration, and UI run without a paid model.
 * Each scenario is a "model"; each prompt plays the next recorded turn.
 * Unlike acp-replay-agent.ts, it does not assert the client's frames.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as Schema from "effect/Schema";

const LogicalFrameSchema = Schema.Struct({
  kind: Schema.Union([
    Schema.Literal("notification"),
    Schema.Literal("request"),
    Schema.Literal("response"),
  ]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
});
const ReplayEntrySchema = Schema.Struct({
  type: Schema.Union([
    Schema.Literal("emit_inbound"),
    Schema.Literal("expect_outbound"),
    Schema.Literal("runtime_exit"),
    Schema.Literal("transcript_start"),
  ]),
  frame: Schema.optional(LogicalFrameSchema),
  afterMs: Schema.optional(Schema.Number),
});
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const JsonRpcMessageSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(JsonRecordSchema),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const SessionUpdateSchema = Schema.Struct({
  sessionUpdate: Schema.String,
  content: Schema.optional(Schema.Unknown),
});
const PermissionRequestParamsSchema = Schema.Struct({
  toolCall: Schema.optional(Schema.Struct({ toolCallId: Schema.optional(Schema.String) })),
  options: Schema.optional(
    Schema.Array(Schema.Struct({ optionId: Schema.String, kind: Schema.String })),
  ),
});
const PermissionAnswerSchema = Schema.Struct({
  outcome: Schema.optional(
    Schema.Struct({
      outcome: Schema.optional(Schema.String),
      optionId: Schema.optional(Schema.String),
    }),
  ),
});
const PromptResponseSchema = Schema.Struct({ stopReason: Schema.optional(Schema.String) });

type LogicalFrame = typeof LogicalFrameSchema.Type;
type JsonRpcMessage = typeof JsonRpcMessageSchema.Type;
type PermissionAnswer = typeof PermissionAnswerSchema.Type;

const decodeReplayEntry = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayEntrySchema));
const decodeLogicalFrame = Schema.decodeUnknownSync(LogicalFrameSchema);
const decodeJsonRpcMessage = Schema.decodeUnknownSync(JsonRpcMessageSchema);
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecordSchema);
const decodeSessionUpdate = Schema.decodeUnknownSync(SessionUpdateSchema);
const decodePermissionRequestParams = Schema.decodeUnknownSync(PermissionRequestParamsSchema);
const isJsonRecord = Schema.is(JsonRecordSchema);
const isPermissionAnswer = Schema.is(PermissionAnswerSchema);
const isPromptResponse = Schema.is(PromptResponseSchema);

export interface ReplayTurn {
  /** Frames the agent sends: session updates and agent-to-client requests. */
  readonly frames: ReadonlyArray<{ readonly frame: LogicalFrame; readonly afterMs?: number }>;
  readonly stopReason: string;
}

const FIXTURES = "../src/orchestration-v2/testkit/fixtures";

// Recorded fixtures the replay tests already pin, plus a hand-written UI showcase.
// Use acpRegistry transcripts: vendor transcripts carry state in frames this agent drops.
export const SCENARIOS = [
  { id: "showcase", name: "Showcase", file: "./dev-replay/showcase_transcript.ndjson" },
  {
    id: "todo-list",
    name: "Plan and reads",
    file: `${FIXTURES}/todo_list/registry_transcript.ndjson`,
  },
  {
    id: "approval",
    name: "Write approval",
    file: `${FIXTURES}/tool_call_read_only_on_request/registry_transcript.ndjson`,
  },
  {
    id: "question",
    name: "Question",
    file: `${FIXTURES}/acp_elicitation/registry_transcript.ndjson`,
  },
  {
    id: "multi-turn",
    name: "Multi turn",
    file: `${FIXTURES}/multi_turn/registry_transcript.ndjson`,
  },
] as const;

const REPLAYED_UPDATES = {
  agent_message_chunk: true,
  agent_thought_chunk: true,
  tool_call: true,
  tool_call_update: true,
  plan: true,
  plan_update: true,
  plan_removed: true,
  session_info_update: true,
  usage_update: true,
} satisfies Record<string, true>;

// Only requests that ask the user. A replayed terminal/create would run a real command.
const REPLAYED_REQUESTS = {
  "session/request_permission": true,
  "elicitation/create": true,
} satisfies Record<string, true>;

const CHUNK_DELAY_MS = 30;
const FRAME_DELAY_MS = 250;
const MAX_RECORDED_DELAY_MS = 2_000;
const WORDS_PER_CHUNK = 3;

function isReplayedFrame(frame: LogicalFrame): boolean {
  if (frame.kind === "request") return Object.hasOwn(REPLAYED_REQUESTS, frame.method);
  if (frame.kind !== "notification" || frame.method !== "session/update") return false;
  const params = isJsonRecord(frame.params) ? frame.params : undefined;
  const update = params?.update;
  if (!isJsonRecord(update)) return false;
  return (
    typeof update.sessionUpdate === "string" &&
    Object.hasOwn(REPLAYED_UPDATES, update.sessionUpdate)
  );
}

/** Splits a recorded transcript into the turns that follow each `session/prompt`. */
export function parseReplayTurns(ndjson: string): ReadonlyArray<ReplayTurn> {
  const turns: Array<{ frames: Array<ReplayTurn["frames"][number]>; stopReason: string }> = [];
  // Frames after a prompt's response belong to background work, not to that turn.
  let turn: (typeof turns)[number] | undefined;
  for (const line of ndjson.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = decodeReplayEntry(line);
    const frame = entry.frame;
    if (frame === undefined) continue;
    if (
      entry.type === "expect_outbound" &&
      frame.kind === "request" &&
      frame.method === "session/prompt"
    ) {
      turn = { frames: [], stopReason: "end_turn" };
      turns.push(turn);
      continue;
    }
    if (entry.type !== "emit_inbound" || turn === undefined) continue;
    if (frame.kind === "response" && frame.method === "session/prompt") {
      const stopReason = isPromptResponse(frame.result) ? frame.result.stopReason : undefined;
      if (typeof stopReason === "string") turn.stopReason = stopReason;
      turn = undefined;
      continue;
    }
    if (isReplayedFrame(frame)) {
      turn.frames.push(entry.afterMs === undefined ? { frame } : { frame, afterMs: entry.afterMs });
    }
  }
  return turns;
}

/** Splits streamed text into small chunks so the client sees real deltas. */
export function streamChunks(text: string): ReadonlyArray<string> {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: Array<string> = [];
  for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
    chunks.push(words.slice(index, index + WORDS_PER_CHUNK).join(""));
  }
  return chunks.length === 0 ? [text] : chunks;
}

/** Fills the live session, workspace, and per-prompt tool ids, so repeated turns add rows. */
function materialize(
  value: unknown,
  live: { readonly sessionId: string; readonly workspace: string; readonly turnKey: string },
): unknown {
  if (typeof value === "string") return value.replaceAll("<workspace>", live.workspace);
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, live));
  if (!isJsonRecord(value)) return value;
  const materialized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    materialized[key] =
      key === "sessionId"
        ? live.sessionId
        : key === "toolCallId"
          ? `${live.turnKey}-${String(entry)}`
          : materialize(entry, live);
  }
  return materialized;
}

function permissionRejectedToolCallId(
  request: LogicalFrame,
  answer: PermissionAnswer | undefined,
): string | undefined {
  if (request.method !== "session/request_permission" || answer?.outcome === undefined) {
    return undefined;
  }
  const params = decodePermissionRequestParams(request.params);
  const outcome = answer.outcome;
  const chosen = params.options?.find((option) => option.optionId === outcome.optionId);
  const rejected = outcome.outcome !== "selected" || chosen?.kind.startsWith("reject") === true;
  return rejected ? params.toolCall?.toolCallId : undefined;
}

function requireStringParameter(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string") {
    throw Object.assign(new Error(`Missing string parameter ${name}`), { code: -32602 });
  }
  return value;
}

function runAgent(): void {
  const turnsByScenario = new Map<string, ReadonlyArray<ReplayTurn>>();
  const loadTurns = (scenarioId: string) => {
    const cached = turnsByScenario.get(scenarioId);
    if (cached !== undefined) return cached;
    const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
    if (scenario === undefined) throw new Error(`Unknown replay scenario ${scenarioId}`);
    const turns = parseReplayTurns(
      NodeFS.readFileSync(new URL(scenario.file, import.meta.url), "utf8"),
    );
    turnsByScenario.set(scenarioId, turns);
    return turns;
  };

  const sessions = new Map<
    string,
    { cwd: string; model: string; promptCount: number; cancel: (() => void) | undefined }
  >();
  const pendingAgentRequests = new Map<string, (result: unknown) => void>();
  let nextAgentRequestId = 1;

  const send = (message: JsonRpcMessage) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  // Resolves when `promise` settles or the turn is cancelled, whichever comes first.
  const untilAbort = (promise: Promise<unknown>, signal: AbortSignal) => {
    const completion = Promise.withResolvers<void>();
    if (signal.aborted) {
      completion.resolve();
      return completion.promise;
    }
    const onAbort = () => completion.resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      completion.resolve();
    });
    return completion.promise;
  };
  const sleep = (ms: number, signal: AbortSignal) => {
    const timer = Promise.withResolvers<void>();
    setTimeout(() => timer.resolve(), Math.min(ms, MAX_RECORDED_DELAY_MS));
    return untilAbort(timer.promise, signal);
  };

  const playTurn = async (
    sessionId: string,
    turn: ReplayTurn,
    signal: AbortSignal,
  ): Promise<"cancelled" | undefined> => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
    // Random, so a session loaded after a restart cannot reuse earlier tool rows.
    const live = { sessionId, workspace: session.cwd, turnKey: NodeCrypto.randomUUID() };
    for (const recorded of turn.frames) {
      const frame = decodeLogicalFrame(materialize(recorded.frame, live));
      if (frame.kind === "request") {
        await sleep(recorded.afterMs ?? FRAME_DELAY_MS, signal);
        if (signal.aborted) return;
        const id = nextAgentRequestId++;
        let answer: unknown;
        const response = Promise.withResolvers<unknown>();
        pendingAgentRequests.set(String(id), (result) => {
          answer = result;
          response.resolve(result);
        });
        send({ id, method: frame.method, params: decodeJsonRecord(frame.params) });
        await untilAbort(response.promise, signal);
        pendingAgentRequests.delete(String(id));
        // The client answers "cancelled" when the user stops the turn mid-request.
        const permissionAnswer = isPermissionAnswer(answer) ? answer : undefined;
        if (signal.aborted || permissionAnswer?.outcome?.outcome === "cancelled") {
          return "cancelled";
        }
        const toolCallId = permissionRejectedToolCallId(frame, permissionAnswer);
        if (toolCallId === undefined) continue;
        // The recording only has the approved path, so a rejection ends the turn here.
        send({
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
          },
        });
        return;
      }
      const params = decodeJsonRecord(frame.params);
      const updateRecord = decodeJsonRecord(params.update);
      const update = decodeSessionUpdate(updateRecord);
      const content = isJsonRecord(update.content) ? update.content : undefined;
      const text =
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk") &&
        content?.type === "text" &&
        typeof content.text === "string"
          ? content.text
          : undefined;
      // Live recordings hold one frame per token, so text defaults to the chunk pace.
      const firstDelay = recorded.afterMs ?? (text === undefined ? FRAME_DELAY_MS : CHUNK_DELAY_MS);
      const chunks = text === undefined ? [undefined] : streamChunks(text);
      for (const [index, chunk] of chunks.entries()) {
        await sleep(index === 0 ? firstDelay : CHUNK_DELAY_MS, signal);
        if (signal.aborted) return;
        let outputParams = params;
        if (chunk !== undefined) {
          if (content === undefined) throw new Error("Replay text chunk has no content record");
          outputParams = {
            ...params,
            update: { ...updateRecord, content: { ...content, text: chunk } },
          };
        }
        send({ method: frame.method, params: outputParams });
      }
    }
  };

  const handleRequest = async (message: JsonRpcMessage): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "t3-dev-replay", version: "1" },
        };
      case "session/new":
      case "session/load": {
        // T3 starts one agent process per thread, so ids must be unique across processes.
        // Loading after a restart keeps the thread usable; T3 already holds its history.
        const sessionId =
          message.method === "session/load"
            ? requireStringParameter(params, "sessionId")
            : NodeCrypto.randomUUID();
        const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
        sessions.set(sessionId, { cwd, model: SCENARIOS[0].id, promptCount: 0, cancel: undefined });
        return {
          ...(message.method === "session/new" ? { sessionId } : {}),
          models: {
            currentModelId: SCENARIOS[0].id,
            availableModels: SCENARIOS.map((scenario) => ({
              modelId: scenario.id,
              name: scenario.name,
            })),
          },
        };
      }
      case "session/set_model": {
        const sessionId = requireStringParameter(params, "sessionId");
        const modelId = requireStringParameter(params, "modelId");
        const scenario = SCENARIOS.find((candidate) => candidate.id === modelId);
        if (scenario === undefined) {
          throw Object.assign(new Error(`Unknown replay scenario ${modelId}`), { code: -32602 });
        }
        const session = sessions.get(sessionId);
        if (session !== undefined && session.model !== scenario.id) {
          session.model = scenario.id;
          session.promptCount = 0;
        }
        return {};
      }
      case "session/prompt": {
        const sessionId = requireStringParameter(params, "sessionId");
        const session = sessions.get(sessionId);
        if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
        const turns = loadTurns(session.model);
        const turn = turns[session.promptCount % Math.max(turns.length, 1)];
        session.promptCount += 1;
        const controller = new AbortController();
        session.cancel = () => controller.abort();
        let ended: "cancelled" | undefined;
        try {
          if (turn !== undefined) ended = await playTurn(sessionId, turn, controller.signal);
        } finally {
          session.cancel = undefined;
        }
        return {
          stopReason:
            controller.signal.aborted || ended === "cancelled"
              ? "cancelled"
              : (turn?.stopReason ?? "end_turn"),
        };
      }
      case "session/close": {
        const sessionId = requireStringParameter(params, "sessionId");
        sessions.get(sessionId)?.cancel?.();
        sessions.delete(sessionId);
        return {};
      }
      case "authenticate":
      case "session/set_mode":
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  };

  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = decodeJsonRpcMessage(JSON.parse(line));
    } catch {
      process.stderr.write(`dev replay agent ignored a line that is not valid JSON-RPC\n`);
      return;
    }
    if (message.method === undefined) {
      const resolve = pendingAgentRequests.get(String(message.id));
      pendingAgentRequests.delete(String(message.id));
      resolve?.(message.result);
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.method === "session/cancel") {
        const sessionId = message.params?.sessionId;
        if (typeof sessionId === "string") sessions.get(sessionId)?.cancel?.();
      }
      return;
    }
    const id = message.id;
    handleRequest(message).then(
      (result) => send({ id, result }),
      (error: unknown) => {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
            ? error.code
            : -32603;
        const message = error instanceof Error ? error.message : String(error);
        send({ id, error: { code, message } });
      },
    );
  });
}

if (import.meta.main) runAgent();
