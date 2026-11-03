import type { Root, RootContent } from "mdast";
import type { Transformer } from "unified";

/** Route standalone SVG documents to the image-isolated graphic renderer. */
export function remarkSvgGraphics(): Transformer<Root> {
  return (root, file) => {
    const source = String(file.value);
    const visit = (node: Root | RootContent): void => {
      if (
        node.type === "root" ||
        node.type === "blockquote" ||
        node.type === "listItem" ||
        node.type === "footnoteDefinition"
      ) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          const first = child?.type === "paragraph" ? child.children[0] : null;
          const start = child?.position?.start.offset;
          const end = child?.position?.end.offset;
          const value =
            child?.type === "html"
              ? child.value
              : first?.type === "html" &&
                  /^\s*<svg(?:\s|>)/i.test(first.value) &&
                  start !== undefined &&
                  end !== undefined
                ? source.slice(start, end)
                : null;
          if (value !== null && /^\s*<svg(?:\s|>)/i.test(value) && /<\/svg>\s*$/i.test(value)) {
            node.children[index] = {
              type: "code",
              lang: "svg",
              value,
              ...(child?.position ? { position: child.position } : {}),
            };
          } else if (child) visit(child);
        }
      } else if (node.type === "list") {
        for (const child of node.children) visit(child);
      }
    };
    visit(root);
  };
}
