import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { WorkLogEntry } from "../../session-logic";
import { resolveToolWorkEntryCompactSummary } from "./toolWorkEntryCompactSummary.ts";

describe("compact tool-device presentation", () => {
  it("uses the historical xd write arguments for the live T3 thread-wait label", () => {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("device-thread-wait"),
      type: "file_change",
      threadId: ThreadId.make("thread-parent"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "write",
      startedAt: DateTime.makeUnsafe("2026-10-23T00:00:00.000Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-23T00:00:00.000Z"),
      fileName: "xd://mcp__t3-code__t3_thread_wait",
      newStr: JSON.stringify({ threadId: "thread-agent" }),
      additions: 4,
    };
    const entry: WorkLogEntry = {
      id: "device-thread-wait",
      createdAt: "2026-10-23T00:00:00.000Z",
      label: "Wrote xd://mcp__t3-code__t3_thread_wait",
      tone: "tool",
      itemType: "file_change",
      toolLifecycleStatus: "inProgress",
      structuredPayload: item,
    };

    const summary = resolveToolWorkEntryCompactSummary({
      entry,
      threadTargetTitle: "Agent alpha",
    });
    expect(summary).toMatchObject({
      verb: "Waiting for",
      object: "Agent alpha",
      objectIsPath: false,
      diffStats: null,
    });
  });
  it("replaces a repeated delegate label with the task title", () => {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("device-delegate-task"),
      type: "dynamic_tool",
      threadId: ThreadId.make("thread-parent"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: DateTime.makeUnsafe("2026-10-23T00:00:00.000Z"),
      completedAt: DateTime.makeUnsafe("2026-10-23T00:00:01.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-23T00:00:01.000Z"),
      toolName: "write",
      input: {
        path: "xd://mcp__t3-code__delegate_task",
        content: JSON.stringify({
          i: "Delegated a child task",
          title: "Brand Researcher",
          task: "Research the brand and its competitors.",
          clientRequestId: "request-123",
        }),
      },
    };
    const entry: WorkLogEntry = {
      id: "device-delegate-task",
      createdAt: "2026-10-23T00:00:01.000Z",
      label: "Delegated a child task",
      detail: "Delegated a child task",
      tone: "tool",
      itemType: "dynamic_tool",
      toolTitle: "Delegated a child task",
      toolLifecycleStatus: "completed",
      structuredPayload: item,
    };

    const summary = resolveToolWorkEntryCompactSummary({ entry });

    expect(summary.intent).toBeUndefined();
    expect(summary.object).toBe("Brand Researcher");
  });
});
