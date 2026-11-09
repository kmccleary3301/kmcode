import { describe, expect, it } from "vite-plus/test";

import { createTurnItemsProjector } from "./currentTurnItems";
import type { Trace } from "./trace";

const trace: Trace = {
  id: "stable-replay",
  title: "Stable replay",
  source: "test",
  cwd: "/workspace",
  prompt: { text: "Check this trace", at: 1_000 },
  events: [
    {
      kind: "text",
      id: "reply",
      start: 1_100,
      end: 2_100,
      text: "abcdefghij",
    },
  ],
  t0: 1_000,
  t1: 3_000,
};

describe("createTurnItemsProjector", () => {
  it("reuses items until their visible content changes", () => {
    const project = createTurnItemsProjector(trace, 100_000);
    const initial = project(1_200);

    expect(project(1_201)).toBe(initial);

    const streamed = project(1_300);
    expect(streamed).not.toBe(initial);
    expect(streamed[0]).toBe(initial[0]);
    expect(streamed[1]).not.toBe(initial[1]);
  });
});
