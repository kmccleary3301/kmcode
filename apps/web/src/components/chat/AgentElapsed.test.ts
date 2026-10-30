import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { AgentElapsed, formatCompactElapsedSeconds } from "./AgentElapsed";

it.each([
  [45, "45s"],
  [90, "1m"],
  [59 * 60 + 59, "59m"],
  [60 * 60, "1h"],
  [90 * 60, "1.5h"],
  [119 * 60, "1.9h"],
  [14 * 60 * 60 + 40 * 60, "14h"],
])("formats %ss as %s", (seconds, label) => {
  expect(formatCompactElapsedSeconds(seconds)).toBe(label);
});

it("renders live elapsed time on its first paint", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T10:00:07.000Z"));
  try {
    const markup = renderToStaticMarkup(
      createElement(AgentElapsed, {
        agent: {
          status: "running",
          startedAt: "2026-10-27T10:00:00.000Z",
          completedAt: null,
        },
      }),
    );
    expect(markup).toContain(">7s</span>");
  } finally {
    vi.useRealTimers();
  }
});
