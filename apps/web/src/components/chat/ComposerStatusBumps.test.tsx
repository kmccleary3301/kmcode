import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerStatusBumps } from "./ComposerStatusBumps";

function renderForceStop(stopping = false) {
  return renderToStaticMarkup(
    createElement(ComposerStatusBumps, {
      backgroundWork: null,
      forceStopBump: { stopping, onForceStop: vi.fn() },
      goal: null,
      threadId: null,
      todoPlan: null,
    }),
  );
}

describe("ComposerStatusBumps", () => {
  it("renders the warning and action for an unresponsive background run", () => {
    const markup = renderForceStop();

    expect(markup).toContain('data-composer-status-bump="force-stop"');
    expect(markup).toContain('aria-label="Force stop unresponsive background run"');
    expect(markup).toContain("Stop unresponsive");
    expect(markup).toContain("Force stop");
  });

  it("disables the background force-stop action while the request is active", () => {
    const markup = renderForceStop(true);

    expect(markup).toContain("disabled");
    expect(markup).toContain("Force stopping...");
  });
});
