import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("links only PRs created, taken over, or pushed to", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("Link each PR you create, take over, or push to");
    expect(instructions).toContain("one link_pull_request per PR");
    expect(instructions).toContain("Skip PRs you only read or review");
    expect(instructions).not.toContain("list_thread_pull_requests");
  });

  it("adds Aperture instructions only when the capability is enabled", () => {
    const withoutAperture = buildRuntimeInstructions({ harness: "Codex", aperture: false });
    const withAperture = buildRuntimeInstructions({ harness: "Codex", aperture: true });

    expect(buildRuntimeInstructions({ harness: "Codex" })).toBe(withoutAperture);
    expect(withAperture.slice(withoutAperture.length)).toMatch(
      /^\n\n<aperture>\n[^\n]*aperture_guide[^\n]*\n<\/aperture>$/,
    );
  });

  it("watches only when requested or work still waits, without polling", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("Call watch_pull_request when asked to monitor or babysit");
    expect(instructions).toContain("Otherwise act now or hand back.");
    expect(instructions).toContain("Delegated children never watch");
    expect(instructions).toContain("Never wait with sleep");
    expect(instructions).toContain("call unwatch_pull_request");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
