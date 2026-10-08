import {
  formatActivityDetailValue,
  type ActivityDetailBlock,
  type ActivityDetailDiffRow,
  type ActivityDetailListingRow,
  type ActivityDetailSection,
  type ParsedActivityDetail,
} from "@t3tools/client-runtime/activity-details";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { LRUCache } from "../../lib/lruCache";
import { useTheme } from "../../hooks/useTheme";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Suspense, use, useCallback, useId, useMemo, useState, type UIEvent } from "react";
import { CopyIcon } from "lucide-react";
import { RenderErrorBoundary } from "../RenderErrorBoundary";

const TOOL_DETAIL_ROW_BATCH_SIZE = 48;
const highlightedLinesCache = new LRUCache<ReadonlyArray<string>>(48, 4 * 1024 * 1024);

function highlightedLinesSize(key: string, highlightedLines: ReadonlyArray<string>): number {
  let characters = key.length;
  for (const line of highlightedLines) characters += line.length;
  return Math.max(1, characters * 2);
}

function useProgressiveRows<T>(rows: ReadonlyArray<T>): {
  readonly visibleRows: ReadonlyArray<T>;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
} {
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(rows.length, TOOL_DETAIL_ROW_BATCH_SIZE),
  );
  const boundedVisibleCount = Math.min(rows.length, visibleCount);
  const visibleRows = useMemo(
    () => rows.slice(0, boundedVisibleCount),
    [boundedVisibleCount, rows],
  );
  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (boundedVisibleCount >= rows.length) return;
      const element = event.currentTarget;
      const remainingScroll = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remainingScroll > element.clientHeight * 2) return;
      setVisibleCount((current) =>
        Math.min(rows.length, Math.max(current, boundedVisibleCount) + TOOL_DETAIL_ROW_BATCH_SIZE),
      );
    },
    [boundedVisibleCount, rows.length],
  );
  return { visibleRows, onScroll };
}

function highlightedBody(markup: string): string | null {
  const codeStart = markup.indexOf("<code");
  if (codeStart < 0) return null;
  const bodyStart = markup.indexOf(">", codeStart);
  const bodyEnd = markup.lastIndexOf("</code>");
  if (bodyStart < 0 || bodyEnd <= bodyStart) return null;
  return markup.slice(bodyStart + 1, bodyEnd);
}

function HighlightedLine(props: { readonly code: string; readonly language: string | null }) {
  const theme = useTheme();
  const language = props.language ?? "text";
  const themeName = theme.resolvedTheme === "light" ? "github-light" : "github-dark";
  const highlighter = use(getSyntaxHighlighterPromise(language, themeName));
  const html = useMemo(() => {
    try {
      return highlightedBody(
        highlighter.codeToHtml(props.code, { lang: language, theme: themeName }),
      );
    } catch {
      return null;
    }
  }, [highlighter, language, props.code, themeName]);
  if (html === null) return <>{props.code || " "}</>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function extractHighlightedLines(markup: string): ReadonlyArray<string> {
  const body = highlightedBody(markup);
  if (body === null) return [];
  const starts = [...body.matchAll(/<span class="line"[^>]*>/g)];
  return starts.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < starts.length ? (starts[index + 1]?.index ?? body.length) : body.length;
    return body.slice(start, end).replace(/<\/span>\s*$/, "");
  });
}

function useHighlightedLines(
  lines: ReadonlyArray<string>,
  language: string | null,
): ReadonlyArray<string> | null {
  const theme = useTheme();
  const resolvedLanguage = language ?? "text";
  const themeName = theme.resolvedTheme === "light" ? "github-light" : "github-dark";
  const highlighter = use(getSyntaxHighlighterPromise(resolvedLanguage, themeName));
  const joinedCode = lines.join("\n");
  return useMemo(() => {
    const cacheKey = `${themeName}\0${resolvedLanguage}\0${joinedCode}`;
    const cached = highlightedLinesCache.get(cacheKey);
    if (cached !== null) return cached;
    try {
      const markup = highlighter.codeToHtml(joinedCode, {
        lang: resolvedLanguage,
        theme: themeName,
      });
      const highlighted = extractHighlightedLines(markup);
      if (highlighted.length !== lines.length) return null;
      highlightedLinesCache.set(cacheKey, highlighted, highlightedLinesSize(cacheKey, highlighted));
      return highlighted;
    } catch {
      return null;
    }
  }, [highlighter, joinedCode, lines.length, resolvedLanguage, themeName]);
}

function HighlightedMarkupLine(props: {
  readonly highlighted: string | null;
  readonly fallback: string;
}) {
  if (props.highlighted === null) return <>{props.fallback || " "}</>;
  return <span dangerouslySetInnerHTML={{ __html: props.highlighted }} />;
}

function ListingRows(props: {
  readonly rows: ReadonlyArray<ActivityDetailListingRow>;
  readonly highlightedLines: ReadonlyArray<string> | null;
}) {
  let highlightedIndex = 0;
  return props.rows.map((row, index) => {
    const highlighted =
      row.kind === "gap" ? null : (props.highlightedLines?.[highlightedIndex++] ?? null);
    return (
      <ListingRow key={`${index}:${row.gutter}:${row.text}`} row={row} highlighted={highlighted} />
    );
  });
}

function HighlightedListingRows(props: {
  readonly rows: ReadonlyArray<ActivityDetailListingRow>;
  readonly language: string | null;
}) {
  const codeRows = props.rows.filter((row) => row.kind !== "gap");
  const highlightedLines = useHighlightedLines(
    codeRows.map((row) => row.text),
    props.language,
  );
  return <ListingRows rows={props.rows} highlightedLines={highlightedLines} />;
}

function DiffRows(props: {
  readonly rows: ReadonlyArray<ActivityDetailDiffRow>;
  readonly highlightedLines: ReadonlyArray<string> | null;
  readonly hashLine: boolean;
}) {
  let highlightedIndex = 0;
  return props.rows.map((row, index) => {
    const highlighted =
      row.kind === "added" || row.kind === "removed" || row.kind === "context"
        ? (props.highlightedLines?.[highlightedIndex++] ?? null)
        : null;
    return (
      <DiffRow
        key={`${index}:${row.kind}:${row.text}`}
        row={row}
        highlighted={highlighted}
        hashLine={props.hashLine}
      />
    );
  });
}

function HighlightedDiffRows(props: {
  readonly rows: ReadonlyArray<ActivityDetailDiffRow>;
  readonly language: string | null;
  readonly hashLine: boolean;
}) {
  const codeRows = props.rows.filter(
    (row) => row.kind === "added" || row.kind === "removed" || row.kind === "context",
  );
  const highlightedLines = useHighlightedLines(
    codeRows.map((row) => row.text),
    props.language,
  );
  return (
    <DiffRows rows={props.rows} highlightedLines={highlightedLines} hashLine={props.hashLine} />
  );
}

function ListingRow(props: {
  readonly row: ActivityDetailListingRow;
  readonly highlighted: string | null;
}) {
  if (props.row.kind === "gap") {
    return (
      <div className="tool-listing-row" data-kind="gap">
        <span />
        <code />
      </div>
    );
  }
  return (
    <div
      className="tool-listing-row"
      {...(props.row.kind === "context" ? {} : { "data-kind": props.row.kind })}
    >
      <span>{props.row.gutter}</span>
      <code>
        <HighlightedMarkupLine highlighted={props.highlighted} fallback={props.row.text} />
      </code>
    </div>
  );
}

function ListingBlock(props: {
  readonly block: Extract<ActivityDetailBlock, { kind: "listing" }>;
}) {
  const { visibleRows, onScroll } = useProgressiveRows(props.block.rows);
  return (
    <div
      className="tool-listing"
      {...(props.block.language ? { "data-language": props.block.language } : {})}
    >
      {props.block.path ? (
        <div className="tool-listing-file">
          <span className="tool-listing-path">{props.block.path}</span>
          {props.block.tag ? <span className="tool-listing-tag">#{props.block.tag}</span> : null}
        </div>
      ) : null}
      <div
        className="tool-listing-rows"
        data-rendered-rows={visibleRows.length}
        data-total-rows={props.block.rows.length}
        onScroll={onScroll}
      >
        <RenderErrorBoundary fallback={<ListingRows rows={visibleRows} highlightedLines={null} />}>
          <Suspense fallback={<ListingRows rows={visibleRows} highlightedLines={null} />}>
            <HighlightedListingRows rows={visibleRows} language={props.block.language} />
          </Suspense>
        </RenderErrorBoundary>
      </div>
      {props.block.notes.map((note, index) => (
        <div className="tool-listing-note" key={`${index}:${note}`}>
          {note}
        </div>
      ))}
    </div>
  );
}

function DiffRow(props: {
  readonly row: ActivityDetailDiffRow;
  readonly highlighted: string | null;
  readonly hashLine: boolean;
}) {
  const code = (
    <code>
      <HighlightedMarkupLine highlighted={props.highlighted} fallback={props.row.text} />
    </code>
  );
  if (props.hashLine) {
    return (
      <div
        className={cn(
          "tool-diff-row",
          `tool-diff-row--${props.row.kind}`,
          "tool-diff-row--hashline",
        )}
      >
        <span>{props.row.newLine ?? props.row.oldLine ?? ""}</span>
        {code}
      </div>
    );
  }
  return (
    <div className={cn("tool-diff-row", `tool-diff-row--${props.row.kind}`)}>
      <span>{props.row.oldLine ?? ""}</span>
      <span>{props.row.newLine ?? ""}</span>
      {code}
    </div>
  );
}

function DiffBlock(props: { readonly block: Extract<ActivityDetailBlock, { kind: "diff" }> }) {
  const { visibleRows, onScroll } = useProgressiveRows(props.block.rows);
  return (
    <div
      className={cn(
        "tool-diff",
        props.block.hashLine && "tool-diff--hashline",
        props.block.mode === "edit" && "tool-diff--edit",
      )}
      role="region"
      aria-label={props.block.mode === "edit" ? "Edit input" : "Unified diff"}
      data-rendered-rows={visibleRows.length}
      data-total-rows={props.block.rows.length}
      onScroll={onScroll}
    >
      {props.block.path ? <div className="tool-listing-file">{props.block.path}</div> : null}
      <RenderErrorBoundary
        fallback={
          <DiffRows rows={visibleRows} highlightedLines={null} hashLine={props.block.hashLine} />
        }
      >
        <Suspense
          fallback={
            <DiffRows rows={visibleRows} highlightedLines={null} hashLine={props.block.hashLine} />
          }
        >
          <HighlightedDiffRows
            rows={visibleRows}
            language={props.block.language}
            hashLine={props.block.hashLine}
          />
        </Suspense>
      </RenderErrorBoundary>
    </div>
  );
}

function CodeBlock(props: {
  readonly code: string;
  readonly language: string;
  readonly title?: string;
  readonly softWrap?: boolean;
}) {
  const languageClass = props.language.replace(/[^a-z0-9_-]/gi, "") || "text";
  return (
    <div className={cn("tool-code", props.softWrap && "tool-command-single-line")}>
      {props.title ? <div className="tool-code-title">{props.title}</div> : null}
      <div className="markdown-renderer markdown-v2-output prose markdown tool-source">
        <div className={cn("docs-code-block markdown-code-block", `language-${languageClass}`)}>
          <div className="docs-code-block__body">
            <pre className="shiki">
              <code>
                <RenderErrorBoundary fallback={props.code}>
                  <Suspense fallback={props.code}>
                    <HighlightedLine code={props.code} language={props.language} />
                  </Suspense>
                </RenderErrorBoundary>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function StructuredBlock(props: {
  readonly block: Extract<ActivityDetailBlock, { kind: "structured" }>;
  readonly resultSide: boolean;
}) {
  let value: string;
  try {
    value = JSON.stringify(props.block.value, null, 2) ?? String(props.block.value);
  } catch {
    value = String(props.block.value);
  }
  if (props.resultSide) return <CodeBlock code={value} language="json" />;
  return (
    <pre className="tool-code">
      <code>{value}</code>
    </pre>
  );
}

function DetailBlock(props: {
  readonly block: ActivityDetailBlock;
  readonly onImageExpand: ((source: string, alt: string) => void) | undefined;
  readonly resultSide: boolean;
}) {
  switch (props.block.kind) {
    case "status":
      return (
        <div className="tool-result-status">
          <strong>{props.block.label}</strong>
          <span>{props.block.status}</span>
          {props.block.description ? <span>{props.block.description}</span> : null}
        </div>
      );
    case "text":
      return (
        <pre className={props.resultSide ? "tool-result-code" : "tool-code"}>
          <code>{props.block.text}</code>
        </pre>
      );
    case "target":
      return <div className="tool-target">{props.block.text}</div>;
    case "options":
      return (
        <div className="tool-options">
          {props.block.entries.map((entry) => (
            <span className="tool-option" key={entry.key}>
              <span className="tool-option-key">{entry.key}</span> <code>{entry.value}</code>
            </span>
          ))}
        </div>
      );
    case "code":
      return (
        <CodeBlock
          code={props.block.code}
          language={props.block.language}
          {...(props.block.title === undefined ? {} : { title: props.block.title })}
          {...(props.block.softWrap === undefined ? {} : { softWrap: props.block.softWrap })}
        />
      );
    case "listing":
      return (
        <div className="tool-code">
          <ListingBlock block={props.block} />
        </div>
      );
    case "diff":
      return (
        <div className="tool-code">
          <DiffBlock block={props.block} />
        </div>
      );
    case "structured":
      return <StructuredBlock block={props.block} resultSide={props.resultSide} />;
    case "image": {
      const { source, alt } = props.block;
      const onImageExpand = props.onImageExpand;
      const image = <img src={source} alt={alt} className="message-image" loading="lazy" />;
      return onImageExpand ? (
        <button
          type="button"
          className="message-image-link"
          aria-label={`Expand ${alt}`}
          onClick={() => onImageExpand(source, alt)}
        >
          {image}
        </button>
      ) : (
        image
      );
    }
  }
}

function DetailSection(props: {
  readonly section: ActivityDetailSection;
  readonly onImageExpand: ((source: string, alt: string) => void) | undefined;
}) {
  return (
    <section className="tool-pane-section">
      <details className="tool-arguments-details">
        <summary>{props.section.title}</summary>
        {props.section.description ? (
          <div className="tool-intent">{props.section.description}</div>
        ) : null}
        {props.section.blocks.map((block, index) => (
          <DetailBlock
            key={`${index}:${block.kind}`}
            block={block}
            onImageExpand={props.onImageExpand}
            resultSide
          />
        ))}
      </details>
    </section>
  );
}

function OutputSection(props: {
  readonly section: ActivityDetailSection;
  readonly onImageExpand: ((source: string, alt: string) => void) | undefined;
}) {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(true);
  const outputText = props.section.blocks
    .map((block) => formatActivityDetailValue(block))
    .join("\n\n");
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "output" });
  return (
    <section
      className="tool-pane-section tool-io-result"
      id={`${bodyId}-section`}
      data-trackable-item
      data-cell
    >
      <div
        className="tool-pane-divider"
        role="button"
        tabIndex={0}
        data-cell-toggle
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <span>Output</span>
        <button
          type="button"
          className="copy-button"
          data-copy-target
          aria-label="Copy output"
          onClick={(event) => {
            event.stopPropagation();
            copyToClipboard(outputText);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <CopyIcon className="icon copy-icon size-3.5" aria-hidden />
          <span className="copy-status">{isCopied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div id={bodyId} className={cn("cell-body", !expanded && "hidden")}>
        <div className="tool-result-content">
          {props.section.blocks.map((block, index) => (
            <DetailBlock
              key={`${index}:${block.kind}`}
              block={block}
              onImageExpand={props.onImageExpand}
              resultSide
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function InputSection(props: {
  readonly section: ActivityDetailSection;
  readonly onImageExpand: ((source: string, alt: string) => void) | undefined;
  readonly headerIntent: string | undefined;
  readonly headerSummary: string | undefined;
}) {
  const description =
    props.section.description && props.section.description !== props.headerIntent
      ? props.section.description
      : undefined;
  const visibleBlocks = props.section.blocks.filter(
    (block) => !(block.kind === "target" && block.text === props.headerSummary),
  );
  const argumentBlocks = visibleBlocks.filter((block) => block.kind === "structured");
  const contentBlocks = visibleBlocks.filter(
    (block) =>
      block.kind !== "structured" &&
      (block.kind !== "target" || block.text.trim().length > 0) &&
      (block.kind !== "options" || block.entries.length > 0),
  );
  const argumentText = argumentBlocks.map((block) => formatActivityDetailValue(block)).join("\n\n");
  if (description === undefined && contentBlocks.length === 0 && argumentBlocks.length === 0)
    return null;
  return (
    <section className="tool-pane-section tool-io-input">
      <div className="tool-call-content">
        {description ? <div className="tool-intent">{description}</div> : null}
        {contentBlocks.map((block, index) => (
          <DetailBlock
            key={`${index}:${block.kind}`}
            block={block}
            onImageExpand={props.onImageExpand}
            resultSide={false}
          />
        ))}
        {argumentBlocks.length > 0 ? (
          <details className="tool-arguments-details">
            <summary>Arguments</summary>
            <pre className="tool-arguments-json">
              <code>{argumentText}</code>
            </pre>
          </details>
        ) : null}
      </div>
    </section>
  );
}

export function ToolActivityPresenter(props: {
  readonly detail: ParsedActivityDetail;
  readonly headerIntent?: string | undefined;
  readonly headerSummary?: string | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
}) {
  const inputSections = props.detail.sections.filter((section) => section.title === "Input");
  const resultSections = props.detail.sections.filter((section) => section.title === "Result");
  const additionalSections = props.detail.sections.filter(
    (section) => section.title !== "Input" && section.title !== "Result",
  );
  return (
    <>
      {inputSections.map((section, index) => (
        <InputSection
          key={`${section.title}:${index}`}
          section={section}
          headerIntent={props.headerIntent}
          headerSummary={props.headerSummary}
          onImageExpand={props.onImageExpand}
        />
      ))}
      {resultSections.map((section, index) => (
        <OutputSection
          key={`${section.title}:${index}`}
          section={section}
          onImageExpand={props.onImageExpand}
        />
      ))}
      {additionalSections.map((section) => (
        <DetailSection key={section.title} section={section} onImageExpand={props.onImageExpand} />
      ))}
    </>
  );
}
