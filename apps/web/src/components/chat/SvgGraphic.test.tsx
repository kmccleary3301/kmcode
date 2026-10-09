// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SvgGraphic } from "./SvgGraphic";

function imageDocument(html: string): string {
  const src = /<img\b[^>]*src="([^"]+)"/.exec(html)?.[1];
  if (src === undefined) throw new Error(`Expected an image, got: ${html}`);
  return decodeURIComponent(
    src.replaceAll("&amp;", "&").replace(/^data:image\/svg\+xml;charset=utf-8,/, ""),
  );
}

describe("SvgGraphic", () => {
  it("shows model SVG only as a sanitized image document", () => {
    const html = renderToStaticMarkup(
      <SvgGraphic
        source={
          '<svg onload="alert(1)" viewBox="0 0 10 10"><title>Box</title><script>alert(2)</script><foreignObject><div>x</div></foreignObject><rect width="10" height="10"/></svg>'
        }
        onExpand={() => {}}
      />,
    );
    expect(html).not.toMatch(/<svg\b/);
    expect(html).toContain('alt="Box"');
    const svg = imageDocument(html);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("<rect");
    expect(svg).not.toMatch(/onload|<script|foreignObject/i);
  });

  it("keeps the source and explains why when the SVG is incomplete", () => {
    const html = renderToStaticMarkup(<SvgGraphic source={"<svg><rect"} onExpand={() => {}} />);
    expect(html).toContain("Unable to render graphic");
    expect(html).toContain("&lt;svg&gt;&lt;rect");
    expect(html).not.toContain("<img");
  });
});
