import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorToolkit,
  ScheduleTaskTool,
  ThreadUpdateTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "Start one child agent with only `task`");
    assert.include(DelegateTaskTool.description ?? "", "No parent history");
    assert.include(DelegateTaskTool.description ?? "", "Separate checkout or PR per child");
    assert.include(CreateThreadsTool.description ?? "", "Not delegation");
    assert.include(CreateThreadsTool.description ?? "", "`t3_thread_launch`");
    assert.include(
      OrchestratorToolkit.tools.task_cancel.description ?? "",
      "A finished task keeps its result.",
    );
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Default 'async'.");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "`schedule` is an object, not text.");
    assert.include(ScheduleTaskTool.description ?? "", "next run time or `webhookUrl`");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Rename a thread");
    assert.include(ThreadUpdateTool.description ?? "", "link or unlink a PR");
  });
});
