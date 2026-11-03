// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const { refresh, showError } = vi.hoisted(() => ({
  refresh: vi.fn(),
  showError: vi.fn(),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "https://environment.test/original.html",
    expiresAt: Date.now() + 60 * 60_000,
  }),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: showError } }));
vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();
const onFullscreenChange = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  refresh.mockReset();
  showError.mockClear();
  onClose.mockClear();
  onFullscreenChange.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button?.click());
}

async function renderInlineFrame() {
  await act(() =>
    root.render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
        onFullscreenChange={onFullscreenChange}
      />,
    ),
  );
}

it("zooms the page within bounds, resets without reloading, and closes", async () => {
  await act(() =>
    root.render(
      <HtmlRenderDialog
        src="https://environment.test/page.html"
        title="Diagram"
        onClose={onClose}
      />,
    ),
  );
  const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
  const src = frame.src;
  for (let step = 0; step < 6; step += 1) await click("Zoom in");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.disabled).toBe(true);
  expect(frame.parentElement?.style.getPropertyValue("zoom")).toBe("2");
  for (let step = 0; step < 8; step += 1) await click("Zoom out");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')?.disabled).toBe(true);
  expect(frame.parentElement?.style.getPropertyValue("zoom")).toBe("0.5");
  await click("Reset zoom");
  expect(frame.parentElement?.style.getPropertyValue("zoom")).toBe("1");
  expect(document.querySelector("iframe")).toBe(frame);
  expect(frame.src).toBe(src);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  await click("Close");
  expect(onClose).toHaveBeenCalledOnce();
});

it("opens a renewed fullscreen page without replacing the inline frame, then restores its focus", async () => {
  await renderInlineFrame();
  const inlineFrame = document.querySelector<HTMLIFrameElement>("iframe")!;
  const inlineSrc = inlineFrame.src;
  const expandButton = document.querySelector<HTMLButtonElement>(
    '[aria-label="Open full screen"]',
  )!;
  expandButton.focus();
  refresh.mockResolvedValue("https://environment.test/renewed.html");
  await click("Open full screen");
  expect(refresh).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"] iframe')?.getAttribute("src")).toContain(
    "https://environment.test/renewed.html#",
  );
  expect(inlineFrame.src).toBe(inlineSrc);
  expect(onFullscreenChange).toHaveBeenLastCalledWith(true);
  await click("Close");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("iframe")).toBe(inlineFrame);
  expect(document.activeElement).toBe(expandButton);
  expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
});

it.each([null, new Error("Disconnected")])(
  "reports an unavailable URL instead of opening a blank page: %s",
  async (failure) => {
    await renderInlineFrame();
    if (failure === null) refresh.mockResolvedValue(null);
    else refresh.mockRejectedValue(failure);
    await click("Open full screen");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Page unavailable" }),
    );
  },
);

it("closes the fullscreen dialog on Escape", async () => {
  await act(() =>
    root.render(
      <HtmlRenderDialog
        src="https://environment.test/page.html"
        title="Diagram"
        onClose={onClose}
      />,
    ),
  );
  await act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(onClose).toHaveBeenCalledOnce();
});
