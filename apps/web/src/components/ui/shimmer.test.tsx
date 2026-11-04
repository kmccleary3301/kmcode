// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ShimmerLayers } from "./shimmer";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(active: boolean) {
  act(() =>
    root.render(
      <ShimmerLayers active={active} underlay>
        <span data-testid="label">Reading</span>
      </ShimmerLayers>,
    ),
  );
}

describe("ShimmerLayers", () => {
  it("keeps the label's own nodes mounted as the sweep starts and stops", () => {
    render(false);
    const label = container.querySelector('[data-testid="label"]');

    render(true);
    expect(container.querySelector('.shimmer-base > [data-testid="label"]')).toBe(label);

    render(false);
    expect(container.querySelector('.shimmer-base > [data-testid="label"]')).toBe(label);
    expect(container.querySelector(".shimmer-clip")).toBeNull();
  });

  it("hides the sweep's copies from assistive tech and interaction", () => {
    render(true);
    const clip = container.querySelector(".shimmer-clip");

    expect(clip?.getAttribute("aria-hidden")).toBe("true");
    expect(clip?.hasAttribute("inert")).toBe(true);
  });
});
