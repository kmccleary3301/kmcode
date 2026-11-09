import type { InlineNode } from "@stream-mdx/core";
import { createMarkdownSnapshotCompiler } from "@stream-mdx/worker/direct";
import { describe, expect, it } from "vite-plus/test";

import { createKmMarkdownExtensions } from "./kmMarkdownExtensions.ts";

const compiler = createMarkdownSnapshotCompiler({
  extensionId: "km-markdown-extensions-test",
  extensions: createKmMarkdownExtensions(),
});

function isInlineNode(value: unknown): value is InlineNode {
  return (
    typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string"
  );
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => ("text" in node ? node.text : "")).join("");
}

async function linksIn(markdown: string): Promise<Array<{ href: string; text: string }>> {
  const { blocks } = await compiler.compile({ text: markdown, finalize: true });
  const links: Array<{ href: string; text: string }> = [];
  const visit = (node: InlineNode): void => {
    if (node.kind === "link")
      links.push({ href: node.href ?? "", text: inlineText(node.children) });
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) if (isInlineNode(child)) visit(child);
    }
  };
  for (const block of blocks) {
    const inline: unknown = block.payload.inline;
    if (Array.isArray(inline)) for (const node of inline) if (isInlineNode(node)) visit(node);
  }
  return links;
}

describe("bare URL autolinks", () => {
  it("links URLs on single-label hosts, which GFM autolinking skips", async () => {
    expect(
      await linksIn(
        "Pick: http://localhost:3166/dev/proto-trace-viewer?variant=raw-transcript\n\nTailnet: https://km-dev-kyle:8080/",
      ),
    ).toEqual([
      {
        href: "http://localhost:3166/dev/proto-trace-viewer?variant=raw-transcript",
        text: "http://localhost:3166/dev/proto-trace-viewer?variant=raw-transcript",
      },
      { href: "https://km-dev-kyle:8080/", text: "https://km-dev-kyle:8080/" },
    ]);
  });

  it("leaves trailing sentence punctuation and wrapping parentheses out of the link", async () => {
    expect(
      await linksIn("Open http://localhost:3167/dev/x?variant=iris. (see http://localhost:3000)"),
    ).toEqual([
      {
        href: "http://localhost:3167/dev/x?variant=iris",
        text: "http://localhost:3167/dev/x?variant=iris",
      },
      { href: "http://localhost:3000", text: "http://localhost:3000" },
    ]);
  });

  it("keeps dotted hosts whole and ignores URLs glued to a word", async () => {
    expect(await linksIn("http://example.com/x and foohttp://localhost:1/y")).toEqual([
      { href: "http://example.com/x", text: "http://example.com/x" },
    ]);
  });
});

describe("file links with spaces in the path", () => {
  it("links path destinations with spaces as their angle-bracket form would", async () => {
    const dir = "/Users/k/infiller";
    const links = await linksIn(
      `See [Amortized Infilling.md:7](${dir}/Amortized Infilling.md:7) and [Traces (1).md](${dir}/Distillation with Traces (1).md).`,
    );
    expect(links).toEqual(
      await linksIn(
        `See [Amortized Infilling.md:7](<${dir}/Amortized Infilling.md:7>) and [Traces (1).md](<${dir}/Distillation with Traces (1).md>).`,
      ),
    );
    expect(links.map((link) => link.text)).toEqual(["Amortized Infilling.md:7", "Traces (1).md"]);
  });

  it("keeps formatting in the label and links relative and home paths", async () => {
    expect(
      await linksIn("[**the** `plan`](./docs/my plan.md) or [notes](~/My Notes/today.md)"),
    ).toEqual(
      await linksIn("[**the** `plan`](<./docs/my plan.md>) or [notes](<~/My Notes/today.md>)"),
    );
  });

  it("leaves destinations that are not paths, or that carry a title, to CommonMark", async () => {
    expect(await linksIn('[a](not a path) [b](/x y "title") [c](/x y')).toEqual([]);
  });
});
