import type { TranscriptStyle } from "@t3tools/contracts/settings";
import { createContext } from "react";

/**
 * The transcript style rows render in. `MessagesTimeline` provides it from the
 * `transcriptStyle` client setting (or its preview override) and also stamps
 * it on the transcript root as `data-transcript-style`, so most of a style is
 * CSS (`transcript-terminal.css`, `transcript-minimal.css`). Minimal, Minimal+
 * and KM share one look; Minimal+ and KM differ only in which steps open by
 * themselves, and KM stacks a step's intent above it. Components read it only
 * where a style needs different glyphs or text, never different data.
 */
export const TranscriptStyleCtx = createContext<TranscriptStyle>("minimal");

export const TRANSCRIPT_STYLE_OPTIONS: Record<
  TranscriptStyle,
  { readonly label: string; readonly description: string }
> = {
  minimal: {
    label: "Minimal",
    description: "Cursor and Codex desktop look: one muted line per step, opened only on click.",
  },
  "minimal-plus": {
    label: "Minimal+",
    description:
      "Minimal, plus edits, commands and subagents open while they run; the latest few stay open until work moves on.",
  },
  km: {
    label: "KM",
    description: "Minimal, plus edits, writes, commands and code cells open while they run.",
  },
  terminal: {
    label: "Terminal",
    description: "Oh My Pi's terminal look: monospace, its glyphs and colours, framed tool output.",
  },
};
