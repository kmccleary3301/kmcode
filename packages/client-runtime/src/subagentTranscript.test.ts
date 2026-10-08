import type { OrchestrationV2SubagentTranscriptEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentTranscriptEntries } from "./subagentTranscript.ts";

function entry(
  id: string,
  timestamp: string,
  overrides: Partial<OrchestrationV2SubagentTranscriptEntry> = {},
): OrchestrationV2SubagentTranscriptEntry {
  return {
    id,
    kind: "tool",
    text: id,
    timestamp,
    ...overrides,
  };
}

describe("deriveSubagentTranscriptEntries", () => {
  it("pairs adjacent native call and result entries without losing raw payloads", () => {
    const [pair] = deriveSubagentTranscriptEntries([
      entry("call-1", "2026-01-01T00:00:00.000Z", {
        toolName: "read",
        tool: { phase: "call", callId: "call-1", arguments: { path: "src/a.ts" } },
      }),
      entry("result-1", "2026-01-01T00:00:02.000Z", {
        toolName: "read",
        tool: { phase: "result", callId: "call-1", result: { content: "hello" } },
      }),
    ]);

    expect(pair).toMatchObject({
      entry: { id: "call-1" },
      callEntry: { id: "call-1" },
      resultEntry: { id: "result-1" },
      toolData: {
        name: "read",
        input: { path: "src/a.ts" },
        result: { content: "hello" },
      },
    });
  });

  it("pairs only adjacent matching IDs and preserves interleaved events", () => {
    const derived = deriveSubagentTranscriptEntries([
      entry("call-a", "2026-01-01T00:00:00.000Z", {
        toolName: "read",
        tool: { phase: "call", callId: "a", arguments: { path: "a" } },
      }),
      entry("call-b", "2026-01-01T00:00:01.000Z", {
        toolName: "read",
        tool: { phase: "call", callId: "b", arguments: { path: "b" } },
      }),
      entry("result-b", "2026-01-01T00:00:02.000Z", {
        toolName: "read",
        tool: { phase: "result", callId: "b", result: { content: "b" } },
      }),
      entry("result-a", "2026-01-01T00:00:03.000Z", {
        toolName: "read",
        tool: { phase: "result", callId: "a", result: { content: "a" } },
      }),
    ]);

    expect(derived.map((item) => item.entry.id)).toEqual(["call-a", "call-b", "result-a"]);
    expect(derived[0]?.resultEntry).toBeUndefined();
    expect(derived[1]?.resultEntry?.id).toBe("result-b");
    expect(derived[2]?.callEntry).toBeUndefined();
  });

  it("keeps legacy tool text untouched and does not invent structured data", () => {
    const [legacy] = deriveSubagentTranscriptEntries([
      entry("legacy", "2026-01-01T00:00:00.000Z", { text: 'Called read {"path":"a"}' }),
    ]);

    expect(legacy).toEqual({ entry: expect.objectContaining({ id: "legacy" }) });
    expect(legacy?.entry.text).toBe('Called read {"path":"a"}');
    expect(legacy?.toolData).toBeUndefined();
  });
});
