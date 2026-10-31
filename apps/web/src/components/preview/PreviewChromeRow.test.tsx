import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PreviewChromeRow } from "./PreviewChromeRow.tsx";

describe("PreviewChromeRow", () => {
  it("hides URL credentials while preserving loopback forwarding details", () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewChromeRow, {
        url: "http://user:secret@localhost:3773/__preview/path?tab=1#/route",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        refreshDisabled: false,
        onBack: () => undefined,
        onForward: () => undefined,
        onRefresh: () => undefined,
        onSubmit: () => undefined,
      }),
    );

    expect(markup).toContain('value="http://localhost:3773/__preview/path?tab=1#/route"');
    expect(markup).not.toContain("user:secret");
  });
});
