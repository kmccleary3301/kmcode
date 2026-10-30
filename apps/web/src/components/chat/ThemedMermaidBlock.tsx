import { createMermaidBlock } from "@stream-mdx/mermaid";
import type { MermaidEngine } from "@stream-mdx/react";
import { createElement, useMemo } from "react";

import { useTheme } from "../../hooks/useTheme";

function createKmThemedMermaidEngine(theme: "dark" | "neutral"): MermaidEngine {
  const MermaidBlock = createMermaidBlock({ config: { theme } });
  const view: MermaidEngine["view"] = ({ source, children, metadata, actions }) =>
    createElement(MermaidBlock, {
      code: source,
      renderCode: children,
      language: metadata.language ?? "mermaid",
      blockId: metadata.id,
      isFinalized: metadata.isFinalized,
      controls: { copy: false },
      copy: actions.copy,
    });
  return Object.freeze({ id: "stream-mdx-mermaid", view });
}

/** Create a Mermaid engine using KM appearance without native copy controls. */
export function useThemedMermaidEngine(): MermaidEngine {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "neutral";
  return useMemo(() => createKmThemedMermaidEngine(theme), [theme]);
}
