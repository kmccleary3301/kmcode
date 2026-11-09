// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RollingText } from "./RollingText";

let root: Root;
let container: HTMLDivElement;
// jsdom lays nothing out: the label clips at 100px, and each test says where
// the changed word ends.
let textRight = 50;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, this.dataset.testid === "label" ? 100 : textRight, 20);
  });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  textRight = 50;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(text: string) {
  act(() =>
    root.render(<RollingText text={text} data-testid="label" style={{ overflowX: "hidden" }} />),
  );
}

describe("RollingText", () => {
  it("rolls a changed word on a line that fits", () => {
    render("Editing src/app");
    render("Editing src/app.ts");

    expect(container.querySelector(".roll-slot")).not.toBeNull();
  });

  // A rolled word is one block, which the ellipsis cannot cut, so it would
  // draw past the ellipsis of a truncated line.
  it("shows a truncated line's change as plain text", () => {
    textRight = 200;
    render("Editing /Users/me/projects/glw/artifacts/report");
    render("Editing /Users/me/projects/glw/artifacts/report.md");

    expect(container.querySelector(".roll-slot")).toBeNull();
    expect(container.textContent).toBe("Editing /Users/me/projects/glw/artifacts/report.md");
  });
});
