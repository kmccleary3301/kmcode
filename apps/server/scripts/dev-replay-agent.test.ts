// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { parseReplayTurns, SCENARIOS, streamChunks } from "./dev-replay-agent.ts";

const AgentMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(
    Schema.Struct({
      update: Schema.optional(
        Schema.Struct({
          sessionUpdate: Schema.optional(Schema.String),
          toolCallId: Schema.optional(Schema.String),
          status: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  result: Schema.optional(
    Schema.Struct({
      sessionId: Schema.optional(Schema.String),
      stopReason: Schema.optional(Schema.String),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.Number) })),
});
const SessionUpdateParamsSchema = Schema.Struct({
  update: Schema.Struct({ sessionUpdate: Schema.String }),
});
type AgentMessage = typeof AgentMessageSchema.Type;
const decodeAgentMessage = Schema.decodeUnknownSync(Schema.fromJsonString(AgentMessageSchema));
const isSessionUpdateParams = Schema.is(SessionUpdateParamsSchema);

/**
 * Runs the agent over stdio and returns every message it sent until each request is answered.
 * Permission requests get `permissionResult`.
 */
async function talkToAgent(
  requests: ReadonlyArray<(sessionId: string) => object>,
  permissionResult: object = { outcome: { outcome: "selected", optionId: "allow-once" } },
) {
  const agent = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./dev-replay-agent.ts", import.meta.url))],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = NodeReadline.createInterface({ input: agent.stdout })[Symbol.asyncIterator]();
  const received: Array<AgentMessage> = [];
  let sessionId = "";
  try {
    for (const [index, request] of requests.entries()) {
      agent.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request(sessionId) })}\n`,
      );
      for (;;) {
        const line = await lines.next();
        if (line.done) throw new Error("Replay agent exited before responding");
        const message = decodeAgentMessage(line.value);
        received.push(message);
        if (message.method === "session/request_permission") {
          const answer = { jsonrpc: "2.0", id: message.id, result: permissionResult };
          agent.stdin.write(`${JSON.stringify(answer)}\n`);
        }
        if (message.id !== index + 1 || message.method !== undefined) continue;
        sessionId = message.result?.sessionId ?? sessionId;
        break;
      }
    }
  } finally {
    agent.kill();
  }
  return { sessionId, received };
}

describe("dev replay agent", () => {
  it("keeps sessions and tool ids unique across processes and reloads", async () => {
    const prompt = (sessionId: string) => ({ method: "session/prompt", params: { sessionId } });
    const selectTodoList = (sessionId: string) => ({
      method: "session/set_model",
      params: { sessionId, modelId: "todo-list" },
    });
    const requests = [
      () => ({ method: "session/new", params: { cwd: "/tmp" } }),
      selectTodoList,
      prompt,
      prompt,
    ];
    const [first, second] = await Promise.all([talkToAgent(requests), talkToAgent(requests)]);
    expect(first.sessionId).not.toBe(second.sessionId);
    // A server restart loads the same session in a new agent process.
    const reloaded = await talkToAgent([
      () => ({ method: "session/load", params: { sessionId: first.sessionId, cwd: "/tmp" } }),
      () => ({
        method: "session/set_model",
        params: { sessionId: first.sessionId, modelId: "todo-list" },
      }),
      () => ({ method: "session/prompt", params: { sessionId: first.sessionId } }),
    ]);
    const toolCallIds = [...first.received, ...reloaded.received].flatMap((message) =>
      message.params?.update?.toolCallId === undefined ? [] : [message.params.update.toolCallId],
    );
    expect(new Set(toolCallIds).size).toBe(6);
  });

  it.each(SCENARIOS)("$id plays a turn without session setup frames", ({ file }) => {
    const turns = parseReplayTurns(NodeFS.readFileSync(new URL(file, import.meta.url), "utf8"));
    expect(turns.length).toBeGreaterThan(0);
    const updates = turns.flatMap((turn) =>
      turn.frames.flatMap(({ frame }) => {
        if (frame.method !== "session/update" || !isSessionUpdateParams(frame.params)) return [];
        return [frame.params.update.sessionUpdate];
      }),
    );
    expect(updates).toContain("agent_message_chunk");
    expect(updates).not.toContain("available_commands_update");
  });

  it("keeps permission requests and the recorded stop reason in order", () => {
    const turns = parseReplayTurns(
      NodeFS.readFileSync(new URL(SCENARIOS[0].file, import.meta.url), "utf8"),
    );
    const methods = turns[0]!.frames.map(({ frame }) => frame.method);
    expect(methods).toContain("session/request_permission");
    expect(turns[0]!.stopReason).toBe("end_turn");
  });

  it("rejects an unknown scenario instead of playing another one", async () => {
    const { received } = await talkToAgent([
      () => ({ method: "session/new", params: { cwd: "/tmp" } }),
      (sessionId) => ({ method: "session/set_model", params: { sessionId, modelId: "typo" } }),
    ]);
    expect(received.at(-1)?.error?.code).toBe(-32602);
  });

  it("ends the turn with a failed tool call when the user rejects an approval", async () => {
    const { received } = await talkToAgent(
      [
        () => ({ method: "session/new", params: { cwd: "/tmp" } }),
        (sessionId) => ({ method: "session/prompt", params: { sessionId } }),
      ],
      { outcome: { outcome: "selected", optionId: "reject-once" } },
    );
    const updates = received.flatMap((message) =>
      message.params?.update === undefined ? [] : [message.params.update],
    );
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    expect(updates.some((update) => update.toolCallId?.endsWith("showcase-test"))).toBe(false);
    expect(received.at(-1)?.result?.stopReason).toBe("end_turn");
  });

  it("ends the turn as cancelled when the client cancels an open approval", async () => {
    const { received } = await talkToAgent(
      [
        () => ({ method: "session/new", params: { cwd: "/tmp" } }),
        (sessionId) => ({ method: "session/prompt", params: { sessionId } }),
      ],
      { outcome: { outcome: "cancelled" } },
    );
    const requestIndex = received.findIndex(
      (message) => message.method === "session/request_permission",
    );
    expect(received.slice(requestIndex + 1).some((message) => message.method !== undefined)).toBe(
      false,
    );
    expect(received.at(-1)?.result?.stopReason).toBe("cancelled");
  });

  it("leaves frames after a prompt's response out of that turn", () => {
    const transcript = [
      {
        type: "expect_outbound",
        frame: { kind: "request", method: "session/prompt" },
      },
      {
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "root" },
            },
          },
        },
      },
      {
        type: "emit_inbound",
        frame: { kind: "response", method: "session/prompt", result: {} },
      },
      {
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "background" },
            },
          },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const turns = parseReplayTurns(transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.frames).toHaveLength(1);
  });

  it("streams text in chunks that rebuild the original", () => {
    const text = "One two three four five\n\n```ts\nx\n```";
    const chunks = streamChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});
