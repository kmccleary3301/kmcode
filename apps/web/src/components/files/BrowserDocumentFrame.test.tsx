// @vitest-environment jsdom

import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { HtmlRenderDocument } from "./BrowserDocumentFrame";

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("reports content height only from the rendered page's own window", async () => {
  const onContentHeight = vi.fn();
  await act(() =>
    root.render(
      <HtmlRenderDocument
        src="https://environment.test/page.html"
        title="Report"
        onContentHeight={onContentHeight}
      />,
    ),
  );
  const frame = container.querySelector("iframe")!;
  const message = {
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: 321 },
  };
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { source: frame.contentWindow, data: message }),
    ),
  );
  expect(onContentHeight).toHaveBeenCalledExactlyOnceWith(321);

  await act(() =>
    window.dispatchEvent(new MessageEvent("message", { source: window, data: message })),
  );
  expect(onContentHeight).toHaveBeenCalledOnce();
});
