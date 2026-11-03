import { describe, expect, it } from "vite-plus/test";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { resolveSubagentLifecycle } from "./subagentRuntime.js";

const oldStart = "2026-10-13T12:00:00.000Z";
const oldEnd = "2026-10-13T12:00:10.000Z";
const laterStart = "2026-10-13T12:00:30.000Z";
const now = Date.parse("2026-10-13T13:00:00.000Z");

describe("resolveSubagentLifecycle", () => {
  it("uses live status and keeps a known end when the same attempt omits it", () => {
    const resolved = resolveSubagentLifecycle(
      { status: "running", startedAt: oldStart, completedAt: oldEnd },
      { status: "completed", startedAt: oldStart, completedAt: null },
    );

    expect(resolved).toEqual({ status: "completed", startedAt: oldStart, completedAt: oldEnd });
    expect(deriveSubagentElapsedMs(resolved, now)).toBe(10_000);
  });

  it("does not carry an earlier completion into a new terminal attempt", () => {
    const resolved = resolveSubagentLifecycle(
      { status: "completed", startedAt: oldStart, completedAt: oldEnd },
      { status: "completed", startedAt: laterStart, completedAt: null },
    );

    expect(resolved).toEqual({ status: "completed", startedAt: laterStart, completedAt: null });
    expect(deriveSubagentElapsedMs(resolved, now)).toBeNull();
  });

  it("clears a stale end when the live child becomes active again", () => {
    const resolved = resolveSubagentLifecycle(
      { status: "completed", startedAt: oldStart, completedAt: oldEnd },
      { status: "running", startedAt: oldStart, completedAt: oldEnd },
    );

    expect(resolved).toEqual({ status: "running", startedAt: oldStart, completedAt: null });
  });

  it("keeps an unknown live restart start unknown after an older terminal attempt", () => {
    const resolved = resolveSubagentLifecycle(
      { status: "completed", startedAt: oldStart, completedAt: oldEnd },
      { status: "running", startedAt: null, completedAt: null },
    );

    expect(resolved).toEqual({ status: "running", startedAt: null, completedAt: null });
    expect(deriveSubagentElapsedMs(resolved, now)).toBeNull();
  });


  it("leaves a terminal child with no known interval at unknown duration", () => {
    const resolved = resolveSubagentLifecycle({
      status: "completed",
      startedAt: null,
      completedAt: null,
    });

    expect(resolved).toEqual({ status: "completed", startedAt: null, completedAt: null });
    expect(deriveSubagentElapsedMs(resolved, now)).toBeNull();
  });
});
