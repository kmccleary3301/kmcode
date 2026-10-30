import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { ompPaneModel } from "./ompPaneModel";

const now = DateTime.makeUnsafe("2026-10-30T20:28:14.093Z");

function dynamicTool(
  toolName: string,
  fields: Pick<OrchestrationV2TurnItem & { type: "dynamic_tool" }, "input" | "output" | "details">,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`item-${toolName}`),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: toolName,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "dynamic_tool",
    toolName,
    ...fields,
  };
}

describe("ompPaneModel highlight language", () => {
  it("takes a settled hashline edit's language from details.path", () => {
    const model = ompPaneModel(
      dynamicTool("edit", {
        input: { input: "[src/Tex.tsx#B9B6]\nPUT 1.=1:\n+import type { ReactNode } from \"react\"" },
        output: "[src/Tex.tsx#EBF7]\n1:import type { ReactNode } from \"react\"",
        details: {
          path: "/workspace/src/Tex.tsx",
          diff: '-1|import { renderToString } from "katex"\n+1|import type { ReactNode } from "react"',
        },
      }),
    );
    expect(model.input).toMatchObject({ kind: "diff", language: "tsx", added: 1, removed: 1 });
  });

  it("ignores a read selector when picking a numbered read's language", () => {
    const model = ompPaneModel(
      dynamicTool("read", {
        input: { path: "src/server.py:50-52" },
        output: "50:def main():\n51:    value = 1\n52:    return value",
      }),
    );
    expect(model.outputListing?.map((section) => section.language)).toEqual(["python"]);
  });
});
