import { use, useId, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import ChatMarkdown from "../ChatMarkdown";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getSearchProviderLabel,
  type NativeSearchData,
  type NativeSearchSource,
} from "./NativeSearchPane.logic";
import { TranscriptStyleCtx } from "./transcriptStyle";

export {
  readNativeSearchData,
  getSearchProviderLabel,
  formatSearchAge,
  extractDomain,
  type NativeSearchData,
  type NativeSearchMetadata,
  type NativeSearchSource,
  type NativeSearchUsage,
} from "./NativeSearchPane.logic";

function sourceDisclosureKey(paneKey: string): string {
  return `native-search-sources-expanded:${paneKey}`;
}

const COLLAPSED_SOURCE_LIMIT = 4;

function SourcePreview({
  source,
  terminalStyle = false,
}: {
  readonly source: NativeSearchSource;
  readonly terminalStyle?: boolean;
}) {
  const [snippetExpanded, setSnippetExpanded] = useState(false);
  const snippetLines =
    terminalStyle && source.snippet !== null && source.snippet !== undefined
      ? source.snippet.replace(/\r/g, "").split("\n")
      : null;
  const hiddenSnippetLineCount =
    snippetLines === null ? 0 : Math.max(0, snippetLines.length - 3);
  const snippetText =
    snippetLines !== null && !snippetExpanded
      ? snippetLines.slice(0, 3).join("\n")
      : source.snippet;
  const metaParts: string[] = [];
  if (source.domain) metaParts.push(source.domain);
  if (source.ageText) {
    metaParts.push(source.ageText);
  } else if (source.publishedDate) {
    metaParts.push(source.publishedDate);
  }

  const label = source.domain || source.url || source.title;
  const triggerClassName =
    "inline-flex min-w-0 max-w-full text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

  if (terminalStyle) {
    return (
      <li className="w-full min-w-0" data-native-search-source>
        <div className="flex min-w-0 flex-col gap-0.5">
          {source.safeHref ? (
            <a
              href={source.safeHref}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${source.title} (${label})`}
              className={triggerClassName}
            >
              <span className="break-words">{label}</span>
            </a>
          ) : (
            <span className={triggerClassName}>
              <span className="break-words">{label}</span>
            </span>
          )}
          {source.title !== label ? (
            <p className="break-words text-xs font-medium text-foreground">{source.title}</p>
          ) : null}
          {metaParts.length > 0 ? (
            <p className="text-2xs text-muted-foreground">{metaParts.join(" · ")}</p>
          ) : null}
          {source.snippet ? (
            <>
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                {snippetText}
              </p>
              {hiddenSnippetLineCount > 0 ? (
                <button
                  type="button"
                  className="terminal-preview-more"
                  aria-label={`Expand ${hiddenSnippetLineCount} more lines`}
                  onClick={() => setSnippetExpanded(true)}
                >
                  … {hiddenSnippetLineCount} more lines
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </li>
    );
  }

  const trigger = source.safeHref ? (
    <a
      href={source.safeHref}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${source.title} (${label})`}
      className={triggerClassName}
    >
      <span className="truncate">{label}</span>
    </a>
  ) : (
    <button type="button" aria-label={`Preview ${source.title}`} className={triggerClassName}>
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <li className="min-w-0" data-native-search-source>
      <PreviewCard>
        <PreviewCardTrigger render={trigger} delay={350} closeDelay={120} />
        <PreviewCardPopup align="start" className="w-80 max-w-[calc(100vw-2rem)] text-left">
          <div className="min-w-0 p-3">
            <p className="break-words text-sm font-medium leading-snug text-foreground">
              {source.title}
            </p>
            {metaParts.length > 0 ? (
              <p className="mt-1 text-2xs text-muted-foreground">{metaParts.join(" · ")}</p>
            ) : null}
            {source.snippet ? (
              <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {source.snippet}
              </p>
            ) : null}
          </div>
        </PreviewCardPopup>
      </PreviewCard>
    </li>
  );
}

export function NativeSearchPane({
  data,
  disclosureCache,
  cwd,
  queryIsTruncated = false,
  failed = false,
}: {
  readonly data: NativeSearchData;
  readonly disclosureCache?: Set<string>;
  readonly cwd?: string | undefined;
  readonly queryIsTruncated?: boolean | undefined;
  readonly failed?: boolean | undefined;
}) {
  const paneId = useId();
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const [localDisclosureCache, setLocalDisclosureCache] = useState<Set<string>>(() => new Set());
  const [, forceRender] = useState(0);
  const cache = disclosureCache ?? localDisclosureCache;
  const sourcesExpandedKey = `native-search-sources-expanded:${data.key}`;

  const { copyToClipboard: copyAnswer, isCopied: isAnswerCopied } = useCopyToClipboard({
    target: "answer",
  });

  const sourcesExpanded =
    isTerminal || data.sources.length <= COLLAPSED_SOURCE_LIMIT || cache.has(sourcesExpandedKey);

  const toggleSources = () => {
    const nextValue = !sourcesExpanded;
    if (disclosureCache === undefined) {
      setLocalDisclosureCache((current) => {
        const next = new Set(current);
        if (nextValue) next.add(sourcesExpandedKey);
        else next.delete(sourcesExpandedKey);
        return next;
      });
    } else {
      if (nextValue) disclosureCache.add(sourcesExpandedKey);
      else disclosureCache.delete(sourcesExpandedKey);
      forceRender((rev) => rev + 1);
    }
  };

  const displayedSources = sourcesExpanded
    ? data.sources
    : data.sources.slice(0, COLLAPSED_SOURCE_LIMIT);

  const metadata = data.metadata;
  const usage = metadata?.usage;
  const metaParts: string[] = [];
  const provider =
    metadata?.providerLabel ??
    (metadata?.provider ? getSearchProviderLabel(metadata.provider) : undefined);
  if (provider) metaParts.push(provider);
  if (metadata?.model) metaParts.push(metadata.model);
  if (metadata?.authMode) metaParts.push(metadata.authMode);
  if (usage?.inputTokens !== undefined) {
    metaParts.push(`${usage.inputTokens.toLocaleString()} in`);
  }
  if (usage?.outputTokens !== undefined) {
    metaParts.push(`${usage.outputTokens.toLocaleString()} out`);
  }
  if (
    usage?.totalTokens !== undefined &&
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined
  ) {
    metaParts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  }
  if (usage?.searchRequests !== undefined) {
    metaParts.push(
      `${usage.searchRequests.toLocaleString()} ${usage.searchRequests === 1 ? "search" : "searches"}`,
    );
  }

  const error = data.error ?? (failed ? "Search failed." : undefined);

  return (
    <section
      aria-labelledby={`${paneId}-heading`}
      className="flex min-w-0 flex-col gap-2 text-xs"
      data-native-search-pane
      data-t3-part="native-search-card"
    >
      <h4 id={`${paneId}-heading`} className="sr-only">
        Web search
      </h4>

      {queryIsTruncated && data.query ? (
        <p
          className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
          data-section="query"
        >
          {data.query}
        </p>
      ) : null}

      {data.answer ? (
        <div className="group relative min-w-0" data-section="answer">
          <div className="min-w-0 pr-6">
            <ChatMarkdown text={data.answer} cwd={cwd} className="native-search-answer-markdown" />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="copy-button absolute top-0 right-0 size-6 justify-center rounded-sm p-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  data-copy-target
                  aria-label="Copy search answer"
                  onClick={() => copyAnswer(data.answer!)}
                >
                  {isAnswerCopied ? (
                    <CheckIcon className="icon size-3 shrink-0 text-foreground" aria-hidden />
                  ) : (
                    <CopyIcon className="icon size-3 shrink-0" aria-hidden />
                  )}
                  <span className="sr-only">{isAnswerCopied ? "Copied" : "Copy"}</span>
                </button>
              }
            />
            <TooltipPopup>Copy</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}

      {data.sources.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1" data-section="sources">
          <ul
            className={
              isTerminal
                ? "flex min-w-0 list-none flex-col gap-2 p-0"
                : "flex min-w-0 list-none flex-wrap items-center gap-x-3 gap-y-1 p-0"
            }
          >
            {displayedSources.map((source, index) => (
              <SourcePreview
                key={`${source.url || source.title}:${index}`}
                source={source}
                terminalStyle={isTerminal}
              />
            ))}
          </ul>
          {!isTerminal && data.sources.length > COLLAPSED_SOURCE_LIMIT ? (
            <button
              type="button"
              className="w-fit text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={sourcesExpanded}
              onClick={toggleSources}
            >
              {sourcesExpanded
                ? "Show fewer"
                : `+${data.sources.length - displayedSources.length} more`}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground"
          data-section="error"
        >
          <XIcon className="mt-0.5 size-3 shrink-0 status-failed-mark" aria-hidden="true" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}

      {metaParts.length > 0 ? (
        <div className="truncate text-2xs text-muted-foreground" data-section="metadata">
          {metaParts.join(" · ")}
        </div>
      ) : null}
    </section>
  );
}
