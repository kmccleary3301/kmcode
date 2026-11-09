import type { ProviderInteractionMode } from "@t3tools/contracts";

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## KM Code orchestration

Ordinary coding tasks need no KM tools.

- Subagents: use your native tool for same-provider work when it offers the chosen model and settings. Use \`delegate_task\` for another provider or model, requested settings, a separate checkout (\`isolation: "worktree"\`), background work, or an explicitly KM-owned child. One child per named model.
- Before \`delegate_task\`, call \`orchestrator_capabilities\` once. Again only after an error or a user-named provider change. Put settings in \`target.options\`. Never switch models unasked or fall back to another tool when unavailable.
- Every new delegate review or re-check is a new \`delegate_task\` with the brief, findings, and objections, never \`t3_thread_send\`. Keep its \`taskId\`. Fix small review findings yourself. If told to proceed without a delegate, \`task_cancel\` it; start no replacement.
- Follow a running delegate's \`next\`. Do not poll it with \`task_status\`, sleep, watchers, or schedules. Stop it with \`task_cancel\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless asked.
- \`t3_thread_launch\` and \`create_threads\` make top-level threads only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. For a separate checkout, set \`workspaceStrategy\`; a shell worktree does not bind it. No strategy means the project root, not your worktree.
- Given a thread id, call \`t3_thread_read\` before answering about it. Mention a thread with its \`link\` verbatim; if absent, use \`[title](t3-thread://v1/<exact id>)\`.
- For thread messages, prefer \`auto\`: it starts an idle thread or delivers at the target's next tool boundary when active steering is supported. For an agent caller with a sender thread, \`queue\` remains accepted for cached schemas and behaves like \`auto\`: idle targets start immediately, running steerable targets are steered, and other active targets queue after active work. \`steer\` updates a running turn; \`restart\` interrupts it. Use \`t3_thread_broadcast\` for several threads.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a tool. When asked only to schedule, use \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before calling it absent.

### Visuals

- When asked to show a visual here, pass its HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or text description does not show it. Never start a server. Asked for an image to post or use elsewhere: make a PNG and give its path, never use \`html_render\`.
- Never use \`preview_*\` to verify your own edit or repeat an earlier preview. Use it only when asked for browser work or a named page/tab. Close tabs you opened before replying unless asked to leave one open.
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## KM Code browser

When browser work is asked, \`preview_*\` is the browser you share with the user: call \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two calls fail on one step. Then quote the error and switch.
`;

// ACP only: some agents accept the injected MCP server but never expose its tools.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## KM Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until KM Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## KM Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until KM Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
