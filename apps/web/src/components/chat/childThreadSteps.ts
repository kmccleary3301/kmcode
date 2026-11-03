import type { EnvironmentId, OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ToolVerbObject } from "@t3tools/client-runtime/work-log/presentation";
import { deriveToolVerbObject } from "@t3tools/client-runtime/work-log/presentation";
import { useThreadVisibleTurnItems } from "../../state/entities";

/** A child thread's tool call, command, or edit as a step line; null for anything else. */
export function childThreadStep(item: OrchestrationV2TurnItem): ToolVerbObject | null {
  const running = isOrchestrationV2WorkActive(item.status);
  switch (item.type) {
    case "dynamic_tool":
      return deriveToolVerbObject({
        toolName: item.toolName ?? "tool",
        args: item.input,
        running,
        result: item,
      });
    case "command_execution":
      return deriveToolVerbObject({ toolName: "bash", args: { command: item.input }, running });
    case "file_change":
      return deriveToolVerbObject({
        toolName: item.title === "write" ? "write" : "edit",
        args: { path: item.fileName },
        running,
      });
    default:
      return null;
  }
}

/**
 * What a child thread is doing now, as its newest running step ("Reading
 * src/state.ts"). Delegated T3 threads report no current tool of their own, so
 * their cards and hub rows read it here. A null thread skips the subscription.
 */
export function useChildThreadLiveStep(
  environmentId: EnvironmentId,
  childThreadId: ThreadId | null,
): string | null {
  const items = useThreadVisibleTurnItems(
    childThreadId === null ? null : scopeThreadRef(environmentId, childThreadId),
  );
  let liveStep: string | null = null;
  for (const { item } of items) {
    if (!isOrchestrationV2WorkActive(item.status)) continue;
    const step = childThreadStep(item);
    if (step !== null) liveStep = `${step.verb} ${step.object}`.trim();
  }
  return liveStep;
}
