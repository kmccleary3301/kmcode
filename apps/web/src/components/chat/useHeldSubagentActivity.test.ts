import { describe, expect, it } from "vite-plus/test";

import { liveContentPreview, taskPreview } from "./useHeldSubagentActivity";

const assistant = (text: string) => ({ kind: "assistant" as const, text, truncated: false });

describe("liveContentPreview", () => {
  it("shows the sentence being written on the last line, as plain text", () => {
    expect(
      liveContentPreview(assistant("## Plan\n\n- Read `parser.ts`. Then **patch** the [guard](x)\n")),
    ).toBe("Then patch the guard");
  });

  it("keeps the finished sentence until the new one has a few words", () => {
    expect(liveContentPreview(assistant("The guard is missing. So"))).toBe(
      "The guard is missing.",
    );
    expect(liveContentPreview(assistant("The guard is missing. So the fix goes here"))).toBe(
      "So the fix goes here",
    );
  });

  it("shows a long sentence's newest whole words", () => {
    const preview = liveContentPreview(assistant(`start ${"word ".repeat(40)}end`));
    expect(preview?.startsWith("…word ")).toBe(true);
    expect(preview?.endsWith(" end")).toBe(true);
    expect(preview!.length).toBeLessThanOrEqual(121);
  });

  it("previews reasoning but not tool output", () => {
    expect(liveContentPreview({ kind: "reasoning", text: "Weighing the cache", truncated: false })).toBe(
      "Weighing the cache",
    );
    expect(liveContentPreview({ kind: "tool", text: "ok", truncated: false })).toBeNull();
    expect(liveContentPreview(assistant("\n  \n"))).toBeNull();
  });
});

describe("taskPreview", () => {
  it("shows the assignment's first prose line, past headings and one-word labels", () => {
    expect(taskPreview("\n## Target\nRoot\n\nFix the **bridge** attribution\nDetails")).toBe(
      "Fix the bridge attribution",
    );
    expect(taskPreview("# Goal\n  \nRoot")).toBeNull();
  });
});
