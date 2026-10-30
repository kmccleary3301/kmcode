// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { BottomStickScrollArea } from "./bottom-stick";

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("contains child margins and fades only when content actually overflows", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <BottomStickScrollArea live>
        <p style={{ marginBlockStart: "16px" }}>Thinking</p>
      </BottomStickScrollArea>,
    ),
  );

  const viewport = container.querySelector<HTMLElement>("[data-bottom-stick-viewport]");
  if (viewport === null) throw new Error("Bottom stick viewport is missing");
  const content = viewport.firstElementChild;
  if (!(content instanceof HTMLElement)) throw new Error("Bottom stick content is missing");
  expect(content.classList.contains("flow-root")).toBe(true);

  let scrollHeight = 100;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: 100,
  });

  viewport.scrollTop = 5;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(viewport.dataset.stickFade).toBe("");

  scrollHeight = 200;
  viewport.scrollTop = 50;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(viewport.dataset.stickFade).toBe("top bottom");
});
