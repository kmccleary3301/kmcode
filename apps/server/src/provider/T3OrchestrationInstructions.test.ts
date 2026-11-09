import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Use `delegate_task` for another provider or model",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Ordinary coding tasks need no KM tools");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "top-level threads only when the user asks for a new thread",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "use your native tool for same-provider work",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Every new delegate review or re-check is a new `delegate_task`",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never `t3_thread_send`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`t3_thread_broadcast` for several");
  });

  it("documents schedule-only requests without executing their prompts", () => {
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "When asked only to schedule, use `schedule_task` without running its prompt.",
    );
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "KM Code interaction mode: Default");
    assert.include(injected, "## KM Code browser");
    assert.include(injected, "KM Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
    assert.include(injected, "T3_ACP_MCP_NODE");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "KM Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "KM Code interaction mode: Default");
    assert.notInclude(withoutMcp, "## KM Code browser");
    assert.notInclude(withoutMcp, "KM Code orchestration");
  });
});
