import { Children, isValidElement, type ReactNode } from "react";
import type { InlineNodeViewProps, MathEngine } from "@stream-mdx/react";
import katex from "katex";
import "katex/dist/katex.min.css";

const KATEX_ERROR_CLASS = /class\s*=\s*["'][^"']*\bkatex-error\b/iu;

/** KM's KaTeX settings, shared by the native math engine and its presentation wrapper. */
export const chatMarkdownMathEngine: MathEngine = Object.freeze({
  id: "km-katex-v1",
  render(tex: string, { displayMode }: { readonly displayMode: boolean }) {
    try {
      const html = katex.renderToString(tex, {
        displayMode,
        trust: false,
        strict: "error",
        throwOnError: false,
      });
      return (
        <span
          className="chat-markdown-katex-output"
          data-km-katex-error={KATEX_ERROR_CLASS.test(html) ? "true" : undefined}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    } catch {
      return <span className="katex-error" data-km-katex-error="true">{tex}</span>;
    }
  },
});

type MathOutputProps = {
  readonly className?: unknown;
  readonly children?: ReactNode;
  readonly dangerouslySetInnerHTML?: { readonly __html?: unknown };
  readonly "data-km-katex-error"?: unknown;
};

function containsKatexError(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => {
    if (!isValidElement<MathOutputProps>(child)) return false;
    const className = typeof child.props.className === "string" ? child.props.className : "";
    const html = child.props.dangerouslySetInnerHTML?.__html;
    return (
      child.props["data-km-katex-error"] === true ||
      child.props["data-km-katex-error"] === "true" ||
      className.split(/\s+/u).includes("katex-error") ||
      (typeof html === "string" && KATEX_ERROR_CLASS.test(html)) ||
      containsKatexError(child.props.children)
    );
  });
}

export function MarkdownMathPresentation({ node, children }: InlineNodeViewProps) {
  if (node.kind !== "math-inline" && node.kind !== "math-display") return children ?? null;

  const display = node.kind === "math-display";
  const copySource = display ? `\\[\n${node.tex}\n\\]\n\n` : `\\(${node.tex}\\)`;
  const Wrapper = display ? "div" : "span";
  if (containsKatexError(children)) {
    return (
      <Wrapper
        className={display ? "katex-display chat-markdown-math-source" : "chat-markdown-math-source"}
        data-markdown-math={display ? "display" : "inline"}
        data-markdown-copy={copySource}
      >
        {display ? `\\[\n${node.tex}\n\\]` : `\\(${node.tex}\\)`}
      </Wrapper>
    );
  }

  return (
    <Wrapper
      className={display ? "chat-markdown-math-display" : undefined}
      data-markdown-math={display ? "display" : "inline"}
      data-markdown-copy={copySource}
    >
      {children}
    </Wrapper>
  );
}
