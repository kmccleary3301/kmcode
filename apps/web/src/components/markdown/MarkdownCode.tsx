import { inlineCodeFilePathCandidate } from "@t3tools/client-runtime/markdown-links";
import { CodeIcon, Maximize2Icon, PlayIcon, WrapTextIcon } from "lucide-react";
import { Check, Copy } from "lucide";
import React, {
  Suspense,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { InlineNodeViewProps, NodeViewProps } from "@stream-mdx/react";
import { resolveInlineCodeFileLinkMeta } from "../../markdown-links";
import { getClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { SvgGraphic, standaloneSvgImageUrl } from "../chat/SvgGraphic";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { MorphIcon } from "../MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MarkdownLinkContext } from "./MarkdownMedia";
import { ChatMarkdownRendererContext, type ChatMarkdownComponentState } from "./markdownContext";

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/iu;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/u;

function extractFenceTitle(meta: string): string | null {
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/u).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

interface FenceSource {
  readonly info: string;
  readonly isClosed: boolean;
  readonly rawSvg: boolean;
  readonly body: string;
}

function inspectFenceSource(source: string): FenceSource {
  const isRawSvg = /^\s*<svg(?:\s|>)/iu.test(source);
  if (isRawSvg) {
    return {
      info: "svg",
      isClosed: /<\/svg\s*>\s*$/iu.test(source),
      rawSvg: true,
      body: source,
    };
  }
  const opening = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})([^\r\n]*)/u.exec(source);
  if (!opening?.[1]) return { info: "", isClosed: false, rawSvg: false, body: source };
  const fence = opening[1];
  const info = opening[2]?.trim() ?? "";
  const afterOpening = opening[0].length;
  const firstLineEnd = source.indexOf("\n", afterOpening);
  const bodyStart = firstLineEnd < 0 ? source.length : firstLineEnd + 1;
  const marker = fence[0] === "`" ? "`" : "~";
  const closingLine = new RegExp(`^[\\t ]*(?:>[\\t ]?)*[\\t ]*${marker}{${fence.length},}[\\t ]*$`, "u");
  let lineStart = bodyStart;
  while (lineStart <= source.length) {
    const lineFeed = source.indexOf("\n", lineStart);
    const lineEnd = lineFeed < 0 ? source.length : lineFeed;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/u, "");
    if (closingLine.test(line)) {
      return { info, isClosed: true, rawSvg: false, body: source.slice(bodyStart, lineStart) };
    }
    if (lineFeed < 0) break;
    lineStart = lineFeed + 1;
  }
  return { info, isClosed: false, rawSvg: false, body: source.slice(bodyStart) };
}

function fenceMeta(info: string): string {
  const language = /^\S+/u.exec(info)?.[0] ?? "";
  return info.slice(language.length).trim();
}

export function MarkdownInlineCodePresentation({ node, children }: InlineNodeViewProps) {
  const { cwd, imageBaseDir, inlineCodeFileLinkMetaByText, fileLinkChip } = use(
    ChatMarkdownRendererContext,
  );
  const insideLink = use(MarkdownLinkContext);
  if (node.kind !== "code") return children ?? null;
  const codeText = node.text;
  if (!insideLink) {
    const fileLinkMeta =
      inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
      resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
    if (fileLinkMeta) {
      return fileLinkChip(
        fileLinkMeta,
        `\`${codeText}\``,
        inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
      );
    }
  }
  return (
    <code data-inline-code="" data-t3-part="code">
      {children ?? codeText}
    </code>
  );
}

export function MarkdownCodeBlockFrame({
  as: Wrapper = "div",
  language,
  fenceTitle,
  theme,
  wrapped = true,
  title,
  actions,
  headerProps,
  children,
}: {
  as?: React.ElementType;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  wrapped?: boolean;
  /** Replaces the language title, as the composer does with its language picker. */
  title?: React.ReactNode;
  actions?: React.ReactNode;
  headerProps?: React.HTMLAttributes<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <Wrapper
      className="chat-markdown-codeblock group/code my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
      data-t3-surface="code-block"
      data-t3-part="code"
    >
      <div
        {...headerProps}
        className={cn(
          "chat-markdown-codeblock-header flex min-h-7 items-center justify-between gap-2 pt-1 pr-1.5 pb-0 pl-3.5 select-none",
          headerProps?.className,
        )}
      >
        {title ?? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-2xs" data-t3-part="label">
            <MarkdownCodeBlockTitleContent
              fenceTitle={fenceTitle}
              language={language}
              theme={theme}
            />
          </span>
        )}
        {actions}
      </div>
      {children}
    </Wrapper>
  );
}

function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (!fenceTitle) return <span className="truncate">{language}</span>;
  return (
    <>
      <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
      <span className="truncate">{fenceTitle}</span>
    </>
  );
}

function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  onRunShellCommand,
  isStreaming,
  reportMarkdownActionFailure,
  leadingActions,
  canWrap = true,
  diagram = false,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  onRunShellCommand?: ((command: string) => void) | undefined;
  reportMarkdownActionFailure: ChatMarkdownComponentState["reportMarkdownActionFailure"];
  isStreaming: boolean;
  leadingActions?: ReactNode;
  canWrap?: boolean;
  diagram?: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(() => getClientSettings().wordWrap);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const command = code.trim();
  const canRun =
    onRunShellCommand !== undefined &&
    !isStreaming &&
    /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/u.test(language) &&
    code.endsWith("\n") &&
    command.length > 0 &&
    !command.endsWith("\\") &&
    !/[\p{Cc}\p{Cf}]/u.test(code.slice(0, -1));

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          { operation: "copy-code-block", language, ...(fenceTitle ? { fenceTitle } : {}) },
          cause,
        );
      });
  }, [code, fenceTitle, language, reportMarkdownActionFailure]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost-muted" size="icon-xs" onClick={handleCopy} aria-label={copyLabel} />
        }
      >
        <MorphIcon className="size-3" icon={copied ? Check : Copy} />
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );

  if (diagram) {
    return (
      <div className="my-[0.65rem]" data-language={language}>
        {children}
        <div className="mt-0.5 flex items-center justify-between select-none">
          {leadingActions}
          {copyButton}
        </div>
      </div>
    );
  }

  return (
    <MarkdownCodeBlockFrame
      language={language}
      fenceTitle={fenceTitle}
      theme={theme}
      wrapped={wrapped}
      actions={
        <span
          className="flex items-center gap-0.5 transition-opacity duration-150 group-focus-within/code:opacity-100 group-hover/code:opacity-100 [@media(hover:hover)]:opacity-0"
          role="toolbar"
          aria-label="Code block actions"
        >
          {leadingActions}
          {canWrap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={wrapped ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((value) => !value)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {canRun ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => onRunShellCommand(command)}
                    aria-label="Run in terminal"
                  />
                }
              >
                <PlayIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Run in terminal</TooltipPopup>
            </Tooltip>
          ) : null}
          {copyButton}
        </span>
      }
    >
      {children}
    </MarkdownCodeBlockFrame>
  );
}

function SvgCodeBlockPresentation({
  code,
  fenceTitle,
  theme,
  isStreaming,
  isClosed,
  reportMarkdownActionFailure,
  onExpand,
  children,
}: {
  code: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  isStreaming: boolean;
  isClosed: boolean;
  reportMarkdownActionFailure: ChatMarkdownComponentState["reportMarkdownActionFailure"];
  onExpand: (imageUrl: string) => void;
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const toggleLabel = showCode ? "Show graphic" : "Show code";
  const sourceBody = !isClosed || isStreaming ? plainCodeBody(code) : children;
  const showGraphic = !showCode && !isStreaming && isClosed && code.trim().length > 0;
  const expandGraphic = () => {
    const source = typeof XMLSerializer === "undefined" ? null : document.querySelector(".chat-markdown-svg-graphic svg");
    if (source) onExpand(standaloneSvgImageUrl(new XMLSerializer().serializeToString(source)));
  };
  return (
    <MarkdownCodeBlock
      code={code}
      language="svg"
      fenceTitle={fenceTitle}
      theme={theme}
      reportMarkdownActionFailure={reportMarkdownActionFailure}
      isStreaming={isStreaming}
      canWrap={!showGraphic}
      diagram={showGraphic}
      leadingActions={
        isClosed ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => setShowCode((value) => !value)}
                    aria-label={toggleLabel}
                  />
                }
              >
                <CodeIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
            </Tooltip>
            {showGraphic ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      onClick={expandGraphic}
                      aria-label="Expand graphic"
                    />
                  }
                >
                  <Maximize2Icon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Expand graphic</TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        ) : null
      }
    >
      {showGraphic ? (
        <RenderErrorBoundary resetKeys={[code, theme]} fallback={sourceBody}>
          <Suspense fallback={<div className="flex min-h-36 items-center justify-center text-xs text-muted-foreground">Rendering graphic</div>}>
            <SvgGraphic source={code} onExpand={onExpand} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        sourceBody
      )}
    </MarkdownCodeBlock>
  );
}

function plainCodeBody(code: string) {
  return (
    <pre className="chat-markdown-code-source" data-t3-part="code">
      <code>{code}</code>
    </pre>
  );
}

export function MarkdownCodeBlockPresentation({ children, metadata, actions }: NodeViewProps) {
  const [showMermaidCode, setShowMermaidCode] = useState(false);
  const state = use(ChatMarkdownRendererContext);
  // The packed 1.1 runtime emits raw-SVG metadata before the React declaration exposes it.
  const codeMetadata = metadata as typeof metadata & {
    readonly sourceKind?: "raw-svg";
    readonly sourceComplete?: boolean;
  };
  const sourceRange = codeMetadata.sourceRange;
  const authoredSource = sourceRange ? state.text.slice(sourceRange.from, sourceRange.to) : "";
  const fullSource = sourceRange ? state.text.slice(sourceRange.from) : state.text;
  const rawSvg = codeMetadata.sourceKind === "raw-svg";
  const rangedFence = inspectFenceSource(authoredSource);
  const tailFence = inspectFenceSource(fullSource);
  const fence = rawSvg
    ? {
        info: "svg",
        isClosed: codeMetadata.sourceComplete === true,
        rawSvg: true,
        body: authoredSource,
      }
    : tailFence.info
      ? tailFence
      : rangedFence.info
        ? rangedFence
        : tailFence;
  const code = fence.info ? fence.body : authoredSource || fullSource;
  const infoLanguage = /^\S+/u.exec(fence.info)?.[0];
  const language = metadata.language ?? infoLanguage ?? "text";
  const fenceTitle = extractFenceTitle(fenceMeta(fence.info));
  const expandMedia = state.expandMedia;
  const expandSvg = (src: string) =>
    expandMedia({ images: [{ src, name: language === "mermaid" ? "Mermaid diagram" : "SVG graphic" }], index: 0 });

  if (language.toLowerCase() === "mermaid") {
    const showDiagram = fence.isClosed && !showMermaidCode;
    const codeBody = showDiagram ? (
      <div className="chat-markdown-mermaid" data-markdown-copy={authoredSource}>
        {children}
      </div>
    ) : (
      plainCodeBody(code)
    );
    const toggleLabel = showMermaidCode ? "Show diagram" : "Show code";
    return (
      <MarkdownCodeBlock
        code={code}
        language={language}
        fenceTitle={fenceTitle}
        theme={state.resolvedTheme}
        onRunShellCommand={fence.isClosed ? state.onRunShellCommand : undefined}
        reportMarkdownActionFailure={state.reportMarkdownActionFailure}
        isStreaming={state.isStreaming}
        diagram
        leadingActions={
          fence.isClosed ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      onClick={() => setShowMermaidCode((value) => !value)}
                      aria-label={toggleLabel}
                    />
                  }
                >
                  <CodeIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
              </Tooltip>
              {showDiagram ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-xs"
                        onClick={() => {
                          const svg = document.querySelector(".stream-mdx-mermaid-diagram svg");
                          if (svg) expandSvg(standaloneSvgImageUrl(new XMLSerializer().serializeToString(svg)));
                        }}
                        aria-label="Expand diagram"
                      />
                    }
                  >
                    <Maximize2Icon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Expand diagram</TooltipPopup>
                </Tooltip>
              ) : null}
            </>
          ) : null
        }
      >
        {codeBody}
      </MarkdownCodeBlock>
    );
  }

  if (language.toLowerCase() === "svg" || rawSvg || fence.rawSvg) {
    const svgSource = rawSvg
      ? [authoredSource, fullSource, state.text].find((source) => /^\s*<svg(?:\s|>)/iu.test(source)) ??
        authoredSource
      : fence.rawSvg
        ? fence.body
        : code;
    const isClosed =
      rawSvg ? codeMetadata.sourceComplete === true : fence.rawSvg ? /<\/svg\s*>\s*$/iu.test(svgSource) : fence.isClosed;
    return (
      <SvgCodeBlockPresentation
        code={svgSource}
        fenceTitle={fenceTitle}
        theme={state.resolvedTheme}
        isStreaming={state.isStreaming}
        isClosed={isClosed}
        reportMarkdownActionFailure={state.reportMarkdownActionFailure}
        onExpand={expandSvg}
      >
        {children}
      </SvgCodeBlockPresentation>
    );
  }

  return (
    <MarkdownCodeBlock
      code={code}
      language={language}
      fenceTitle={fenceTitle}
      theme={state.resolvedTheme}
      onRunShellCommand={fence.isClosed ? state.onRunShellCommand : undefined}
      reportMarkdownActionFailure={state.reportMarkdownActionFailure}
      isStreaming={state.isStreaming}
    >
      {children}
    </MarkdownCodeBlock>
  );
}
