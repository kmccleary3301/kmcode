import { describe, expect, it } from "vite-plus/test";

import {
  formatActivityDetailValue,
  parseActivityDetail,
  type ActivityDetailInput,
} from "./activityDetails.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAATUlEQVR4nGMQqXj2Hx9+tkUEL6ZUP8OoA0ZDYDQEBjwEaG0BIf2jDhgNgdEQGPgQGPCCaNQBoyEwGgIDHgIDXhCNOmA0BEZD4NkAZ0MAy+s8l2OjN+IAAAAASUVORK5CYII=";

describe("parseActivityDetail", () => {
  it("renders native raster data without automatically loading provider-controlled URLs", () => {
    const remoteImage = { type: "image_url", image_url: "https://tracker.example/pixel.png" };
    const activity: ActivityDetailInput = {
      id: "native-image-result",
      tone: "info",
      kind: "tool.completed",
      summary: "Read images",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        data: {
          item: {
            result: {
              content: [remoteImage, { type: "image", mimeType: "image/png", data: PNG }],
            },
          },
        },
      },
    };

    expect(parseActivityDetail(activity).sections).toEqual([
      {
        title: "Result",
        blocks: [
          { kind: "structured", value: remoteImage },
          { kind: "image", source: `data:image/png;base64,${PNG}`, alt: "Tool result image" },
        ],
      },
    ]);
  });
  it("prefers agent intent and renders command input as code", () => {
    const activity: ActivityDetailInput = {
      id: "command-detail",
      tone: "tool",
      kind: "tool.completed",
      summary: "Run command",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        data: {
          item: {
            name: "bash",
            input: {
              i: "Check the generated file",
              command: "  printf hello\n",
              cwd: "/work/project",
            },
            result: { content: "hello" },
          },
        },
      },
    };

    const detail = parseActivityDetail(activity);
    expect(detail.sections[0]).toMatchObject({
      title: "Input",
      description: "Check the generated file",
      blocks: [
        { kind: "code", code: "  printf hello\n", language: "bash" },
        { kind: "options", entries: [{ key: "cwd", value: "/work/project" }] },
      ],
    });
    expect(detail.sections[1]).toMatchObject({
      title: "Result",
      blocks: [{ kind: "text", text: "hello" }],
    });
  });

  it("keeps hashline gutters and omitted ranges instead of inferring line numbers", () => {
    const activity: ActivityDetailInput = {
      id: "hashline-detail",
      tone: "tool",
      kind: "tool.completed",
      summary: "Read file",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        data: {
          item: {
            name: "read",
            input: { path: "src/example.ts" },
            result: { content: " 1|const first = 1\n…\n+8|const later = 2" },
          },
        },
      },
    };

    const result = parseActivityDetail(activity).sections.find(
      (section) => section.title === "Result",
    );
    expect(result?.blocks[0]).toMatchObject({
      kind: "diff",
      mode: "hashline",
      hashLine: true,
      rows: [
        { kind: "context", oldLine: 1, newLine: 1 },
        { kind: "marker", text: "…", oldLine: null, newLine: null },
        { kind: "added", oldLine: null, newLine: 8 },
      ],
    });
  });

  it("keeps result warnings alongside a rich diff without treating prose bullets as deletions", () => {
    const activity: ActivityDetailInput = {
      id: "diff-with-warning",
      tone: "error",
      kind: "tool.completed",
      summary: "Apply edit",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        data: {
          item: {
            name: "edit",
            result: {
              diff: "@@ -1 +1 @@\n-old\n+new",
              content: "- Warning: file mode unchanged.",
              isError: true,
            },
          },
        },
      },
    };
    const detail = parseActivityDetail(activity);
    const result = detail.sections.find((section) => section.title === "Result");
    expect(result?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "diff", mode: "unified" }),
        { kind: "text", text: "- Warning: file mode unchanged." },
      ]),
    );
    expect(detail.sections.find((section) => section.title === "Result metadata")?.blocks).toEqual([
      expect.objectContaining({
        kind: "structured",
        value: expect.objectContaining({ isError: true }),
      }),
    ]);
  });

  it("retains nested grep paths, match gutters, and elided source ranges", () => {
    const activity: ActivityDetailInput = {
      id: "grouped-grep",
      tone: "tool",
      kind: "tool.completed",
      summary: "Search files",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        data: {
          item: {
            name: "grep",
            result:
              "# src/\n## nested/\n### file.ts#ABCD\n*12:const result = true;\n*13|const other = false;\n 14|return result;\n…\n20-24:collapsed",
          },
        },
      },
    };
    const result = parseActivityDetail(activity).sections.find(
      (section) => section.title === "Result",
    );
    expect(result?.blocks).toMatchObject([
      {
        kind: "listing",
        path: "src/nested/file.ts",
        tag: "ABCD",
        rows: [
          { kind: "match", gutter: "12", text: "const result = true;" },
          { kind: "match", gutter: "13", text: "const other = false;" },
          { kind: "context", gutter: "14", text: "return result;" },
          { kind: "gap" },
          { kind: "range", gutter: "20-24", text: "collapsed" },
        ],
      },
    ]);
  });
});

function toolDetail(name: string, input: unknown, result?: unknown) {
  return parseActivityDetail({
    id: "tool-presentation",
    tone: "tool",
    kind: "tool.completed",
    summary: name,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { data: { item: { name, input, result } } },
  });
}

describe("operation-focused tool presentation", () => {
  it("keeps command aliases and falsy options not represented by the operation", () => {
    const command = "  printf '%s' hello  ";
    const detail = toolDetail("bash", {
      i: "Run command",
      command,
      cmd: "another command",
      timeout: 0,
      quiet: false,
      env: null,
    });
    expect(detail.sections[0]?.blocks).toEqual([
      { kind: "code", code: command, language: "bash", softWrap: true },
      { kind: "options", entries: [{ key: "timeout", value: "0ms" }] },
      { kind: "structured", value: { cmd: "another command", quiet: false, env: null } },
    ]);
  });

  it("removes only shown nested eval fields and preserves array positions", () => {
    const detail = toolDetail("eval", {
      i: "Count files",
      cells: [
        { code: "print(1)", title: "Count files" },
        { code: "print(2)", title: "Count more", timeout: 0 },
      ],
      "cells.0.code": "literal key",
    });
    const input = detail.sections[0];
    expect(
      input?.blocks.filter((block) => block.kind === "code").map((block) => block.code),
    ).toEqual(["print(1)", "print(2)"]);
    expect(input?.blocks.find((block) => block.kind === "structured")).toEqual({
      kind: "structured",
      value: { cells: [null, { timeout: 0 }], "cells.0.code": "literal key" },
    });
  });

  it("keeps full values when a target is shortened for display", () => {
    const path = "src/" + "long-directory/".repeat(30) + "file.ts";
    const input = toolDetail("read", { path, limit: 0 }).sections[0];
    expect(input?.blocks.find((block) => block.kind === "structured")).toEqual({
      kind: "structured",
      value: { path },
    });
  });

  it("pairs a usable edit diff with warnings and recoverable original output", () => {
    const content = "[file.ts#ABCD]\n1:const value = 2;\nWarning: check callers";
    const detail = toolDetail(
      "edit",
      { path: "file.ts", oldText: "const value = 1;", newText: "const value = 2;" },
      {
        content,
        details: { diff: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;" },
      },
    );
    expect(detail.sections.find((section) => section.title === "Input")?.blocks).toEqual([
      { kind: "target", text: "file.ts" },
    ]);
    expect(detail.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      expect.objectContaining({ kind: "diff" }),
      { kind: "text", text: "Warning: check callers" },
    ]);
    expect(detail.sections.find((section) => section.title === "Original output")?.blocks).toEqual([
      { kind: "text", text: content },
    ]);
  });

  it("retains numbered output when any edit diff is unusable or the result failed", () => {
    const content = "1:important source text";
    for (const result of [
      { content, details: { diff: "" } },
      { content, details: { diff: "not a diff" } },
      { content, details: { diff: "@@ -1 +1 @@\n-old\n+new", perFileResults: [{ diff: "" }] } },
      { content, isError: true, details: { diff: "@@ -1 +1 @@\n-old\n+new" } },
    ]) {
      const detail = toolDetail("edit", { path: "file.ts" }, result);
      expect(detail.sections.some((section) => section.title === "Original output")).toBe(false);
      const output = detail.sections.find((section) => section.title === "Result");
      expect(output?.blocks.map(formatActivityDetailValue).join("\n")).toContain(content);
    }
  });

  it("does not discard unrelated replacement arguments when result diffs do not match", () => {
    const detail = toolDetail(
      "edit",
      { oldText: "unrelated old", newText: "unrelated new" },
      {
        content: "Updated",
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    );
    expect(detail.sections[0]?.blocks).toContainEqual({
      kind: "structured",
      value: { oldText: "unrelated old", newText: "unrelated new" },
    });
  });
});
describe("status and result fallback presentation", () => {
  it("renders task outcomes without discarding full descriptions or raw metadata", () => {
    const authoredDescription =
      "A deliberately long authored task description that must stay byte-for-byte intact.";
    const result = {
      details: {
        results: [
          { id: "done-agent", exitCode: 0, description: authoredDescription },
          { agent: "failed-agent", exitCode: 1, extra: false },
          { id: "aborted-agent", aborted: true, task: "Stopped by the user" },
          { id: "running-agent", status: "running" },
          { id: "unknown-agent", exitCode: null, note: null },
        ],
      },
      diagnostics: 0,
      isError: false,
    };
    const detail = toolDetail("task", { tasks: ["Review the change"] }, result);
    const output = detail.sections.find((section) => section.title === "Result");
    expect(output?.blocks).toEqual([
      { kind: "status", label: "done-agent", status: "done", description: authoredDescription },
      { kind: "status", label: "failed-agent", status: "failed" },
      {
        kind: "status",
        label: "aborted-agent",
        status: "aborted",
        description: "Stopped by the user",
      },
      { kind: "status", label: "running-agent", status: "running" },
      { kind: "status", label: "unknown-agent", status: "unknown" },
    ]);
    expect(formatActivityDetailValue(output?.blocks[0] ?? { kind: "text", text: "" })).toBe(
      `done-agent: done\n${authoredDescription}`,
    );
    expect(detail.sections.find((section) => section.title === "Result metadata")?.blocks).toEqual([
      expect.objectContaining({
        kind: "structured",
        value: expect.objectContaining({ details: result.details, diagnostics: 0, isError: false }),
      }),
    ]);
  });

  it("renders hub delivery receipts as status blocks while retaining receipt fields", () => {
    const receipts = [
      { to: "reviewer", outcome: "delivered", attempt: 2 },
      { from: "worker", outcome: "", acknowledged: false },
    ];
    const detail = toolDetail("hub", { op: "send", to: "reviewer" }, { details: { receipts } });
    expect(detail.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      { kind: "status", label: "reviewer", status: "delivered" },
      { kind: "status", label: "worker", status: "updated" },
    ]);
    expect(detail.sections.find((section) => section.title === "Result metadata")?.blocks).toEqual([
      expect.objectContaining({ kind: "structured", value: { details: { receipts } } }),
    ]);
  });

  it("uses nested diagnostic text only when primary output is empty and preserves falsy fields", () => {
    const detail = toolDetail(
      "bash",
      { command: "true" },
      {
        content: "",
        details: {
          displayContent: "",
          errorText: "Full diagnostic text",
          displayErrorText: "Secondary diagnostic",
          summary: "Summary fallback",
        },
        isError: false,
        diagnostics: false,
        unknown: null,
      },
    );
    expect(detail.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      { kind: "text", text: "Full diagnostic text" },
    ]);
    expect(detail.sections.find((section) => section.title === "Result metadata")?.blocks).toEqual([
      expect.objectContaining({
        kind: "structured",
        value: expect.objectContaining({
          content: "",
          details: expect.objectContaining({ errorText: "Full diagnostic text" }),
          diagnostics: false,
          unknown: null,
        }),
      }),
    ]);

    const primary = toolDetail(
      "bash",
      { command: "true" },
      { content: "Primary output", details: { errorText: "Must not replace primary output" } },
    );
    expect(primary.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      { kind: "text", text: "Primary output" },
    ]);
  });

  it("uses path syntax only for successful read output, not errors or other tool logs", () => {
    const read = toolDetail("read", { path: "src/example.ts" }, { content: "const answer = 42;" });
    expect(read.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      { kind: "code", code: "const answer = 42;", language: "typescript" },
    ]);

    const readError = toolDetail(
      "read",
      { path: "src/example.ts" },
      {
        content: "const answer = 42;",
        isError: true,
      },
    );
    expect(readError.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      { kind: "text", text: "const answer = 42;" },
    ]);

    const command = toolDetail(
      "bash",
      { command: "printf source", path: "src/example.ts" },
      { content: "const answer = 42;" },
    );
    expect(command.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      { kind: "text", text: "const answer = 42;" },
    ]);
  });

  it("retains source languages for structured edit output", () => {
    const detail = toolDetail(
      "edit",
      { path: "src/example.ts" },
      "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n",
    );
    expect(detail.sections.find((section) => section.title === "Result")?.blocks).toEqual([
      expect.objectContaining({
        kind: "diff",
        language: "typescript",
        rows: expect.arrayContaining([
          expect.objectContaining({ kind: "removed", text: "const value = 1;" }),
          expect.objectContaining({ kind: "added", text: "const value = 2;" }),
        ]),
      }),
    ]);
  });
});

describe("parseActivityDetail with OrchestrationV2TurnItem", () => {
  it("presents command_execution turn item", () => {
    const detail = parseActivityDetail({
      type: "command_execution",
      id: "cmd-1",
      status: "completed",
      input: "ls -la",
      output: "file1.txt\nfile2.txt",
    });
    expect(detail.sections[0]).toMatchObject({
      title: "Input",
      blocks: [{ kind: "code", code: "ls -la", language: "bash" }],
    });
    expect(detail.sections[1]).toMatchObject({
      title: "Result",
      blocks: [{ kind: "text", text: "file1.txt\nfile2.txt" }],
    });
  });

  it("presents file_change turn item with diff", () => {
    const detail = parseActivityDetail({
      type: "file_change",
      id: "fc-1",
      status: "completed",
      fileName: "src/app.ts",
      diffStr: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
    });
    expect(detail.sections[0]).toMatchObject({
      title: "Input",
      blocks: [{ kind: "target", text: "src/app.ts" }],
    });
    const result = detail.sections.find((s) => s.title === "Result");
    expect(result?.blocks[0]).toMatchObject({
      kind: "diff",
      path: "src/app.ts",
    });
  });
});
