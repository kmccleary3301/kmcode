import { toolVerb } from "@t3tools/client-runtime/work-log/presentation";

import { formatCompactElapsedSeconds } from "./AgentElapsed";

export function formatNativeDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return formatCompactElapsedSeconds(milliseconds / 1_000);
}

/** `└ Reading waiting.ts:50-140 · 4s`: what a live agent is doing right now. */
export function formatLiveHookLine(currentTool: {
  readonly name: string;
  readonly intent?: string | undefined;
  readonly argsPreview?: string | undefined;
  readonly elapsedMs?: number | undefined;
}): string {
  const intent = currentTool.intent?.trim();
  const object = currentTool.argsPreview?.trim();
  const body =
    intent && intent !== currentTool.name
      ? intent
      : `${toolVerb(currentTool.name, true)}${object ? ` ${object}` : ""}`;
  return currentTool.elapsedMs !== undefined && currentTool.elapsedMs >= 1_000
    ? `└ ${body} · ${formatCompactElapsedSeconds(currentTool.elapsedMs / 1_000)}`
    : `└ ${body}`;
}
