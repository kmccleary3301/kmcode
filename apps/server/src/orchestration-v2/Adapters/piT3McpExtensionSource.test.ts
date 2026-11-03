import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_INSTRUCTIONS_ENV,
} from "./piT3McpExtensionSource.ts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";

// The shipped extension, runnable in a VM: Typebox is only needed for MCP tools.
const RUNNABLE_SOURCE = NodeModule.stripTypeScriptTypes(
  PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
    "export default async function",
    "async function",
  ),
);

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;
type TrustHook = (
  event: unknown,
  ctx: {
    cwd: string;
    isProjectTrusted: () => boolean;
    ui: { notify: (message: string, level: string) => void };
  },
) => unknown;

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  await NodeVM.runInNewContext(`${RUNNABLE_SOURCE}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

async function loadTrustHook(argv: ReadonlyArray<string>): Promise<TrustHook> {
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  await NodeVM.runInNewContext(`${RUNNABLE_SOURCE}\nt3McpExtension(pi)`, {
    process: { env: {}, argv },
    pi: {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (name === "before_agent_start") handlers.push(handler);
      },
    },
  });
  const hook = handlers[0];
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi project trust", () => {
  it.each([
    { name: "a trusted folder", trusted: true, argv: [], notices: 0 },
    { name: "an untrusted folder", trusted: false, argv: [], notices: 1 },
    { name: "--no-approve", trusted: false, argv: ["--approve", "-na"], notices: 0 },
  ])("sends $notices trust notice per session for $name", async ({ trusted, argv, notices }) => {
    const sent: string[] = [];
    const ctx = {
      cwd: "/repo",
      isProjectTrusted: () => trusted,
      ui: { notify: (message: string) => sent.push(message) },
    };
    for (const _session of [1, 2]) {
      const hook = await loadTrustHook(["node", "pi", ...argv]);
      for (const _turn of [1, 2]) await hook({}, ctx);
    }
    assert.equal(sent.length, notices * 2);
    for (const message of sent)
      assert.include(message, "for /repo because the folder is not trusted");
  });
});

describe("Pi system prompt", () => {
  async function systemPromptFor(env: Record<string, string>): Promise<ReadonlyArray<string>> {
    const handlers: Array<(event: { systemPrompt: string }, ctx: unknown) => unknown> = [];
    await NodeVM.runInNewContext(`${RUNNABLE_SOURCE}\nt3McpExtension(pi)`, {
      process: { env, argv: [] },
      fetch: () => Promise.reject(new Error("offline")),
      pi: {
        on: (name: string, handler: (event: { systemPrompt: string }, ctx: unknown) => unknown) => {
          if (name === "before_agent_start") handlers.push(handler);
        },
      },
    });
    const ctx = { cwd: "/repo", isProjectTrusted: () => true, ui: { notify: () => undefined } };
    return handlers.flatMap((handler) => {
      const result = handler({ systemPrompt: "BASE" }, ctx);
      return typeof result === "object" && result !== null && "systemPrompt" in result
        ? [String(result.systemPrompt)]
        : [];
    });
  }

  it("appends launch runtime guidance even without the MCP bridge", async () => {
    const prompts = await systemPromptFor({ [T3_PI_RUNTIME_INSTRUCTIONS_ENV]: "RUNTIME" });
    assert.deepEqual(prompts, ["BASE\n\nRUNTIME"]);
  });

  it("adds orchestration guidance after runtime guidance only with the MCP bridge", async () => {
    const prompts = await systemPromptFor({
      [T3_PI_RUNTIME_INSTRUCTIONS_ENV]: "RUNTIME",
      [T3_MCP_URL_ENV]: "http://127.0.0.1:1/mcp",
      [T3_MCP_BEARER_ENV]: "token",
    });
    assert.deepEqual(prompts, [`BASE\n\nRUNTIME\n\n${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}`]);
  });
});
