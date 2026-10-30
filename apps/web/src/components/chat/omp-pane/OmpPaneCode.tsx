import { useCodeBlock, useCodeDiff } from "@stream-mdx/react";
import type {
  HeadlessNodeViewProps,
  NodePresentations,
  StreamingFeatureFlags,
} from "@stream-mdx/react";
import type { CSSProperties } from "react";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import {
  createKmMarkdownAppendStream,
  createKmMarkdownWorker,
  useKmMarkdownRenderConfig,
} from "../../markdown/markdownRuntime";

const StreamingMarkdown = lazy(() =>
  import("@stream-mdx/react").then((module) => ({ default: module.StreamingMarkdown })),
);

/**
 * Code inside an OMP pane: a grid of rows with a line-number column, code
 * that soft-wraps inside its own column, coloured stripes for diff rows and
 * grey stripes for search hits. stream-mdx highlights the code in its worker;
 * this file only lays those tokens into the OMP-owned rows.
 */

export type OmpCodeRowKind = "add" | "remove" | "context" | "hunk" | "match" | "range" | "gap";

export interface OmpCodeRow {
  readonly text: string;
  /** One cell per gutter column; every row of a block has the same count. */
  readonly gutter: ReadonlyArray<string>;
  readonly kind?: OmpCodeRowKind;
}

export interface OmpCodeBlock {
  /** Shiki grammar id ("typescript", "bash", "text", …). */
  readonly language: string;
  readonly rows: ReadonlyArray<OmpCodeRow>;
  readonly gutters: number;
  readonly title?: string;
}

interface TokenStyle {
  readonly fg?: string;
  readonly fs?: number;
}
interface TokenSpan {
  readonly t: string;
  readonly v?: { readonly dark?: TokenStyle; readonly light?: TokenStyle };
  readonly s?: TokenStyle;
}
interface TokenLine {
  readonly spans: ReadonlyArray<TokenSpan>;
}

interface PaneBlockTokens {
  readonly lines: ReadonlyArray<TokenLine | null>;
  readonly rowKinds: ReadonlyArray<OmpCodeRowKind | null>;
  readonly diffStatus?: "complete" | "incomplete" | "malformed";
}

type PaneCodeContextValue = (
  block: number,
  lines: ReadonlyArray<TokenLine | null>,
  rowKinds: ReadonlyArray<OmpCodeRowKind | null>,
  diffStatus: PaneBlockTokens["diffStatus"],
) => void;

const NO_TOKENS: ReadonlyArray<TokenLine | null> = [];
const NO_ROW_KINDS: ReadonlyArray<OmpCodeRowKind | null> = [];
const NO_SKILL_NAMES: ReadonlyArray<string> = [];

// Shiki font-style bits.
const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;
const FONT_STRIKETHROUGH = 8;

/** Enable worker token and diff output for the OMP code view. */
const PANE_FEATURES = {
  html: false,
  mdx: false,
  math: false,
  tables: false,
  footnotes: false,
  callouts: false,
  codeHighlighting: "incremental",
  liveTokenization: true,
  emitHighlightTokens: true,
  emitDiffBlocks: true,
  outputMode: "tokens",
} satisfies StreamingFeatureFlags;

const PaneCodeContext = createContext<PaneCodeContextValue | null>(null);

function TokenText({ line, text }: { readonly line: TokenLine | null; readonly text: string }) {
  // Tokens trail the text while it streams; only trust a line that matches.
  if (line === null || line.spans.map((span) => span.t).join("") !== text) return text;
  return line.spans.map((span, index) => {
    const light = span.v?.light ?? span.s;
    const dark = span.v?.dark ?? span.s;
    const fontStyle = light?.fs ?? dark?.fs ?? 0;
    const decorations = [
      fontStyle & FONT_UNDERLINE ? "underline" : null,
      fontStyle & FONT_STRIKETHROUGH ? "line-through" : null,
    ].filter((value) => value !== null);
    const style: Record<string, string> = {};
    if (light?.fg) style["--shiki-light"] = light.fg;
    if (dark?.fg) style["--shiki-dark"] = dark.fg;
    if (fontStyle & FONT_ITALIC) style.fontStyle = "italic";
    if (fontStyle & FONT_BOLD) style.fontWeight = "600";
    if (decorations.length > 0) style.textDecorationLine = decorations.join(" ");
    return (
      // eslint-disable-next-line react/no-array-index-key -- spans are positional within a fixed line.
      <span key={index} style={style satisfies CSSProperties}>
        {span.t}
      </span>
    );
  });
}

export function OmpCodeRows({
  block,
  tokenLines,
  rowKinds = NO_ROW_KINDS,
  diffStatus,
  previewLines,
  expanded,
}: {
  readonly block: OmpCodeBlock;
  readonly tokenLines: ReadonlyArray<TokenLine | null>;
  readonly rowKinds?: ReadonlyArray<OmpCodeRowKind | null> | undefined;
  readonly diffStatus?: PaneBlockTokens["diffStatus"];
  readonly previewLines?: number | undefined;
  readonly expanded?: boolean | undefined;
}) {
  const compact = useClientSettings((settings) => settings.toolDetail === "compact");
  const rows =
    previewLines !== undefined && !expanded ? block.rows.slice(0, previewLines) : block.rows;
  return (
    <div className="omp-code" data-gutters={block.gutters} data-diff-status={diffStatus}>
      {block.title ? <div className="omp-code-title">{block.title}</div> : null}
      {rows.map((row, index) =>
        compact && row.kind === "hunk" && row.text.startsWith("@@") ? null : (
          // eslint-disable-next-line react/no-array-index-key -- rows only append while streaming.
          <div key={index} className="omp-code-row" data-kind={rowKinds[index] ?? row.kind ?? "context"}>
            {row.gutter.map((cell, column) => (
              // eslint-disable-next-line react/no-array-index-key -- gutter columns are fixed per block.
              <span key={column} className="omp-code-gutter" aria-hidden="true">
                {cell}
              </span>
            ))}
            <code className="omp-code-text">
              <TokenText line={tokenLines[index] ?? null} text={row.text} />
            </code>
          </div>
        ),
      )}
    </div>
  );
}

function PaneCodeView({ handle }: HeadlessNodeViewProps<"code">) {
  const onTokens = useContext(PaneCodeContext);
  const metadata = useCodeBlock(handle);
  const { lines, diffStatus } = useCodeDiff(handle, {
    from: 0,
    to: metadata.lineCount,
  });
  const blockMatch = metadata.info.match(/(?:^|\s)block=(\d+)(?:\s|$)/);
  const blockIndex = blockMatch === null ? -1 : Number(blockMatch[1]);
  const tokenLines = useMemo(
    () =>
      lines.map((line) => {
        const decoration = line.decoration;
        if (decoration === undefined || decoration.exactness === "unavailable") return null;
        const diffTokens = decoration.diffTokens;
        const tokens = line.diffKind === "del" ? diffTokens?.old : diffTokens?.new;
        return tokens ?? decoration.tokens;
      }),
    [lines],
  );
  const rowKinds = useMemo<ReadonlyArray<OmpCodeRowKind | null>>(
    () =>
      lines.map((line) => {
        switch (line.diffKind) {
          case "add":
            return "add";
          case "del":
            return "remove";
          case "hunk":
            return "hunk";
          case "context":
            return "context";
          default:
            return null;
        }
      }),
    [lines],
  );

  useEffect(() => {
    if (blockIndex >= 0) onTokens?.(blockIndex, tokenLines, rowKinds, diffStatus);
  }, [blockIndex, diffStatus, onTokens, rowKinds, tokenLines]);
  return null;
}

const PANE_PRESENTATIONS = {
  code: { view: PaneCodeView },
} satisfies NodePresentations;

function sourceRow(row: OmpCodeRow, diff: boolean): string {
  if (!diff) return row.text;
  switch (row.kind) {
    case "add":
      return `+${row.text}`;
    case "remove":
      return `-${row.text}`;
    case "context":
      return ` ${row.text}`;
    default:
      return row.text;
  }
}

/** The blocks as one markdown document, with an open final fence while streaming. */
function paneMarkdown(blocks: ReadonlyArray<OmpCodeBlock>, complete: boolean): string {
  return blocks
    .map((block, index) => {
      const diff = block.rows.some(
        (row) => row.kind === "add" || row.kind === "remove" || row.kind === "hunk",
      );
      const body = block.rows.map((row) => sourceRow(row, diff)).join("\n");
      const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const language = diff ? `diff-${block.language}` : block.language;
      const open = `${fence}${language} block=${index}\n${body}`;
      return index < blocks.length - 1 || complete ? `${open}\n${fence}` : open;
    })
    .join("\n\n");
}

export function OmpPaneCode({
  blocks,
  complete,
  previewLines,
}: {
  readonly blocks: ReadonlyArray<OmpCodeBlock>;
  /** False while the code is still streaming. */
  readonly complete: boolean;
  /** OMP's collapsed line budget; omitted outside terminal transcript style. */
  readonly previewLines?: number | undefined;
}) {
  const [tokens, setTokens] = useState<ReadonlyArray<PaneBlockTokens>>([]);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const markdown = useMemo(() => paneMarkdown(blocks, complete), [blocks, complete]);
  const [stream, setStream] = useState(() => createKmMarkdownAppendStream(markdown, complete));
  if (!markdown.startsWith(stream.sent) || (stream.closed && markdown !== stream.sent)) {
    setStream(createKmMarkdownAppendStream(markdown, complete));
  }
  useLayoutEffect(() => {
    stream.push(markdown.slice(stream.sent.length));
    if (complete) stream.close();
  }, [complete, markdown, stream]);

  const renderConfig = useKmMarkdownRenderConfig({
    lineBreaks: false,
    parseRawHtml: false,
    streamWordFade: false,
    isStreaming: !complete,
    pullRequestRepositoryUrl: null,
    skillNames: NO_SKILL_NAMES,
  });
  const compact = useClientSettings((settings) => settings.toolDetail === "compact");
  let hiddenLineCount = 0;
  if (previewLines !== undefined && !previewExpanded) {
    for (const block of blocks) {
      let visibleRowCount = 0;
      for (const row of block.rows) {
        if (!compact || row.kind !== "hunk" || !row.text.startsWith("@@")) visibleRowCount += 1;
      }
      hiddenLineCount += Math.max(0, visibleRowCount - previewLines);
    }
  }
  const onTokens = useCallback<PaneCodeContextValue>((block, lines, rowKinds, diffStatus) => {
    setTokens((previous) => {
      const old = previous[block];
      if (old?.lines === lines && old.rowKinds === rowKinds && old.diffStatus === diffStatus)
        return previous;
      const next = [...previous];
      next[block] = { lines, rowKinds, ...(diffStatus === undefined ? {} : { diffStatus }) };
      return next;
    });
  }, []);

  return (
    <div className="omp-code-host">
      {blocks.map((block, index) => (
        // eslint-disable-next-line react/no-array-index-key -- blocks keep their order.
        <OmpCodeRows
          key={index}
          block={block}
          tokenLines={tokens[index]?.lines ?? NO_TOKENS}
          rowKinds={tokens[index]?.rowKinds ?? NO_ROW_KINDS}
          {...(tokens[index]?.diffStatus === undefined
            ? {}
            : { diffStatus: tokens[index].diffStatus })}
          previewLines={previewLines}
          expanded={previewExpanded}
        />
      ))}
      {hiddenLineCount > 0 ? (
        <button
          type="button"
          className="terminal-preview-more"
          aria-label={`Expand ${hiddenLineCount} more lines`}
          onClick={() => setPreviewExpanded(true)}
        >
          … {hiddenLineCount} more lines
        </button>
      ) : null}
      {blocks.length > 0 ? (
        <div hidden>
          <PaneCodeContext.Provider value={onTokens}>
            <Suspense fallback={null}>
              <StreamingMarkdown
                stream={stream}
                engine="worker"
                worker={createKmMarkdownWorker}
                features={PANE_FEATURES}
                themes={renderConfig.themes}
                highlightEngine={renderConfig.highlightEngine}
                extensionId={renderConfig.extensionId}
                components={PANE_PRESENTATIONS}
                className="omp-code-token-document"
                caret={false}
              />
            </Suspense>
          </PaneCodeContext.Provider>
        </div>
      ) : null}
    </div>
  );
}
