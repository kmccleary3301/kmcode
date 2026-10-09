import DOMPurify, { type DOMPurify as DOMPurifyInstance } from "dompurify";
import { useMemo } from "react";

import { standaloneSvgImageUrl } from "./MermaidDiagram";

type SvgGraphicResult =
  | {
      readonly status: "rendered";
      readonly svg: string;
      readonly url: string;
      readonly alt: string;
    }
  | { readonly status: "error"; readonly message: string };

let purifier: DOMPurifyInstance | null = null;

/**
 * Model-authored SVG never mounts into the application DOM. It is sanitized,
 * then shown as an image document, which cannot run script, navigate, or load
 * external resources.
 */
function prepareSvgGraphic(source: string): SvgGraphicResult {
  // Sanitizing parses as HTML and would close an unfinished document, so check
  // that the authored source itself is one complete SVG document first.
  const authored = new DOMParser().parseFromString(source, "image/svg+xml");
  if (authored.documentElement.localName !== "svg" || authored.querySelector("parsererror")) {
    return { status: "error", message: "The source is not a complete SVG document." };
  }
  purifier ??= DOMPurify(window);
  const sanitized = purifier.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    return { status: "error", message: "The SVG has no renderable content." };
  }
  // Image documents require the SVG namespace declaration to render at all.
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const svg = new XMLSerializer().serializeToString(root);
  return {
    status: "rendered",
    svg,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    alt: parsed.querySelector("title")?.textContent?.trim() || "SVG graphic",
  };
}

export function SvgGraphic({
  source,
  onExpand,
}: {
  source: string;
  onExpand: (imageUrl: string) => void;
}) {
  const result = useMemo(() => prepareSvgGraphic(source.trim()), [source]);
  if (result.status === "error") {
    return (
      <div>
        <p className="m-0 text-xs text-destructive">Unable to render graphic: {result.message}</p>
        <pre className="mt-2 mb-0 overflow-auto font-mono text-xs whitespace-pre-wrap">
          {source}
        </pre>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <button
        type="button"
        aria-label="Expand graphic"
        className="flex w-full cursor-zoom-in justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onExpand(standaloneSvgImageUrl(result.svg))}
      >
        <img className="h-auto max-w-full" src={result.url} alt={result.alt} />
      </button>
    </div>
  );
}
