import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SubagentLiveContent,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  parseActivityDetail,
  parseActivityToolPresentation,
  type ParsedActivityDetail,
} from "@t3tools/client-runtime/activity-details";
import {
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
} from "@t3tools/client-runtime/work-log/presentation";
import * as DateTime from "effect/DateTime";
import { CopyIcon } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

import { workEntryDisplayIndicatesToolFailure, type WorkLogEntry } from "../../session-logic";

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTurnItemDetail } from "../../state/queries";
import { formatShortTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ToolActivityPresenter } from "./ToolActivityPresenter";

const parsedActivityDetailCache = new WeakMap<object, ParsedActivityDetail>();

function parseCachedActivityDetail(
  activity: Parameters<typeof parseActivityDetail>[0],
): ParsedActivityDetail {
  if (typeof activity === "object" && activity !== null) {
    const cached = parsedActivityDetailCache.get(activity);
    if (cached !== undefined) return cached;
    const parsed = parseActivityDetail(activity);
    parsedActivityDetailCache.set(activity, parsed);
    return parsed;
  }
  return parseActivityDetail(activity);
}

export type ToolWorkEntryCardEntry = WorkLogEntry;

export type ToolWorkEntryDetailSource =
  | {
      readonly kind: "projected";
      readonly projectedItem: OrchestrationV2ProjectedTurnItem;
      readonly environmentId: EnvironmentId;
    }
  | {
      readonly kind: "parsed";
      readonly detail: ParsedActivityDetail;
    };

export function streamPreviewText(
  workEntry: Pick<ToolWorkEntryCardEntry, "structuredPayload" | "command" | "detail">,
): string | null {
  const payload = workEntry.structuredPayload;
  if (payload) {
    if (payload.type === "command_execution" && payload.output) {
      return payload.output;
    }
    if (payload.type === "dynamic_tool" && payload.output) {
      return typeof payload.output === "string"
        ? payload.output
        : JSON.stringify(payload.output, null, 2);
    }
    if (payload.type === "subagent" && (payload.result || payload.progress)) {
      return payload.result ?? payload.progress ?? null;
    }
  }
  return null;
}

export function buildToolCallExpandedBody(
  workEntry: ToolWorkEntryCardEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.toolData !== undefined) {
    let dataToDisplay: unknown = workEntry.toolData;
    if (typeof workEntry.toolData === "object" && workEntry.toolData !== null) {
      const dataObj = workEntry.toolData as Record<string, unknown>;
      if ("input" in dataObj) {
        dataToDisplay = dataObj.input;
      }
    }
    blocks.push(`Tool call\n${JSON.stringify(dataToDisplay, null, 2)}`);
  }
  const rawCommand = workEntry.rawCommand?.trim();
  const command = workEntry.command?.trim();
  if (rawCommand && rawCommand !== command) {
    blocks.push(rawCommand);
  } else if (command) {
    blocks.push(command);
  }
  if (workEntry.detail?.trim()) blocks.push(workEntry.detail.trim());
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function ToolTurnItemActivityDetail(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly headerIntent?: string | undefined;
  readonly headerSummary?: string | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
}) {
  const wireItem = props.projectedItem.item;
  const fetches = turnItemNeedsDetailFetch(wireItem);
  const query = useTurnItemDetail(
    fetches
      ? {
          environmentId: props.environmentId,
          threadId: props.projectedItem.sourceThreadId,
          itemId: props.projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
  );
  const fetchedItem = query.data?.item;
  const item = fetchedItem?.type === wireItem.type ? fetchedItem : wireItem;
  const detail = useMemo(() => parseCachedActivityDetail(item), [item]);

  if (query.error !== null) {
    return (
      <p role="alert" className="text-xs text-destructive-foreground">
        Could not load full tool details.
      </p>
    );
  }
  if (fetches && query.isPending && !fetchedItem) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading tool details…
      </p>
    );
  }
  return (
    <ToolActivityPresenter
      detail={detail}
      headerIntent={props.headerIntent}
      headerSummary={props.headerSummary}
      onImageExpand={props.onImageExpand}
    />
  );
}

function ToolDetailBody(props: {
  readonly source: ToolWorkEntryDetailSource;
  readonly headerIntent?: string | undefined;
  readonly headerSummary?: string | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
}) {
  if (props.source.kind === "projected") {
    return (
      <ToolTurnItemActivityDetail
        projectedItem={props.source.projectedItem}
        environmentId={props.source.environmentId}
        headerIntent={props.headerIntent}
        headerSummary={props.headerSummary}
        onImageExpand={props.onImageExpand}
      />
    );
  }
  return (
    <ToolActivityPresenter
      detail={props.source.detail}
      headerIntent={props.headerIntent}
      headerSummary={props.headerSummary}
      onImageExpand={props.onImageExpand}
    />
  );
}

export function SubagentLiveContentOutput({
  liveContent,
}: {
  readonly liveContent: OrchestrationV2SubagentLiveContent;
}) {
  const kindLabel =
    liveContent.kind === "reasoning"
      ? "Thinking"
      : liveContent.kind === "tool"
        ? "Tool"
        : "Responding";
  return (
    <section className="tool-pane-section tool-io-result">
      <div className="tool-pane-divider">
        <span>{kindLabel}</span>
      </div>
      <div className="cell-body">
        <div className="tool-result-content">
          <pre className="tool-result-code">
            <code>{liveContent.text}</code>
          </pre>
          {liveContent.truncated ? (
            <p className="tool-listing-note">
              Complete content appears in the subagent transcript.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function ToolStreamOutput({ workEntry }: { readonly workEntry: ToolWorkEntryCardEntry }) {
  const text = streamPreviewText(workEntry);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "output" });
  if (text === null) return null;
  return (
    <section className="tool-pane-section tool-io-result">
      <div className="tool-pane-divider">
        <span>Live output</span>
        <button
          type="button"
          className="copy-button"
          data-copy-target
          aria-label="Copy output"
          onClick={() => copyToClipboard(text)}
        >
          <CopyIcon className="icon copy-icon size-3.5" aria-hidden />
          <span className="copy-status">{isCopied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div className="cell-body">
        <div className="tool-result-content">
          <pre className="tool-result-code">
            <code>{text}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

export function ToolWorkEntryCard(props: {
  readonly entry: ToolWorkEntryCardEntry;
  readonly workspaceRoot?: string | undefined;
  readonly timestampFormat?: TimestampFormat | undefined;
  readonly icon: ReactNode;
  readonly detailSource?: ToolWorkEntryDetailSource | null | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
}) {
  const { entry } = props;
  const [expanded, setExpanded] = useState(false);
  const projected = entry.projectedItem?.item;
  const t3Presentation = useMemo(() => resolveWorkEntryToolPresentation(entry), [entry]);
  const toolLabel =
    t3Presentation?.displayName ?? entry.toolTitle ?? normalizeCompactToolLabel(entry.label);

  const presentation = useMemo(() => {
    if (projected) {
      if (projected.type === "command_execution") {
        return parseActivityToolPresentation(toolLabel || "bash", { command: projected.input });
      }
      if (projected.type === "file_change") {
        return parseActivityToolPresentation(toolLabel || "edit", { path: projected.fileName });
      }
      if (projected.type === "dynamic_tool") {
        return parseActivityToolPresentation(
          toolLabel || projected.toolName || "tool",
          projected.input,
        );
      }
      if (projected.type === "subagent") {
        return parseActivityToolPresentation(toolLabel || "task", { task: projected.prompt });
      }
    }
    return parseActivityToolPresentation(
      toolLabel,
      entry.toolData ?? (entry.command ? { command: entry.command } : undefined),
    );
  }, [entry.command, entry.toolData, projected, toolLabel]);

  const headerSummary = useMemo(() => {
    if (entry.changedFiles && entry.changedFiles.length > 0) {
      const [firstPath] = entry.changedFiles;
      if (firstPath) {
        const displayPath = formatWorkspaceRelativePath(firstPath, props.workspaceRoot);
        return entry.changedFiles.length === 1
          ? displayPath
          : `${displayPath} +${entry.changedFiles.length - 1} more`;
      }
    }
    return presentation.summary;
  }, [entry.changedFiles, presentation.summary, props.workspaceRoot]);

  const failed = workEntryDisplayIndicatesToolFailure(entry);
  const expandedBody = buildToolCallExpandedBody(entry, props.workspaceRoot);
  const streamText = streamPreviewText(entry);
  const subagentLiveContent =
    projected?.type === "subagent" && projected.liveContent ? projected.liveContent : null;
  const inputText = presentation.inputText ?? expandedBody ?? "";
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "input" });

  const liveStatus =
    entry.toolLifecycleStatus === "inProgress"
      ? subagentLiveContent
        ? subagentLiveContent.kind === "reasoning"
          ? "Thinking"
          : subagentLiveContent.kind === "tool"
            ? "Tool"
            : "Responding"
        : "Running"
      : null;

  const cardId = useId();
  const bodyId = `tool-${cardId}-body`;
  const canExpand =
    props.detailSource !== null &&
    (props.detailSource !== undefined ||
      expandedBody !== null ||
      streamText !== null ||
      subagentLiveContent !== null);

  const startedAt =
    projected?.startedAt !== undefined && projected.startedAt !== null
      ? DateTime.formatIso(projected.startedAt)
      : entry.createdAt;
  const completedAt =
    projected?.completedAt !== undefined && projected.completedAt !== null
      ? DateTime.formatIso(projected.completedAt)
      : null;

  const timestamp = formatShortTimestamp(startedAt, props.timestampFormat ?? "locale") || startedAt;
  const elapsed =
    startedAt && completedAt && Date.parse(completedAt) > Date.parse(startedAt)
      ? formatElapsed(startedAt, completedAt)
      : null;

  const accessibleLabel = presentation.intent
    ? `${presentation.intent} (${presentation.toolName})`
    : presentation.toolName;

  return (
    <div
      className={cn("tool-io-pane assistant-trace", failed && "tool-output-error")}
      id={`tool-${cardId}`}
      data-t3-part="tool-output"
      data-v2-item-type={entry.projectedItem?.item.type}
      data-v2-item-visibility={entry.projectedItem?.visibility}
      data-cell
    >
      <div
        className="tool-header"
        role="button"
        tabIndex={0}
        data-cell-toggle
        aria-label={failed ? `${accessibleLabel}, tool call failed` : accessibleLabel}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => {
          if (canExpand) setExpanded((value) => !value);
        }}
        onKeyDown={(event) => {
          if (!canExpand) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <div className="tool-header-left">
          {props.icon}
          {presentation.intent ? (
            <div className="tool-heading">
              <span className="tool-intent">{presentation.intent}</span>
              <div className="tool-heading-details">
                <span className="tool-name-badge">{presentation.toolName}</span>
                {headerSummary ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="tool-args-summary" />}>
                      {headerSummary}
                    </TooltipTrigger>
                    <TooltipPopup>{headerSummary}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="tool-heading-details">
              <span className="tool-name-badge">{presentation.toolName}</span>
              {headerSummary ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="tool-args-summary" />}>
                    {headerSummary}
                  </TooltipTrigger>
                  <TooltipPopup>{headerSummary}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          )}
        </div>
        <div className="tool-header-right">
          {liveStatus ? (
            <span className="tool-elapsed" role="status">
              {liveStatus}
            </span>
          ) : null}
          <time className="tool-timestamp" dateTime={startedAt}>
            {timestamp}
          </time>
          {elapsed && completedAt ? (
            <Tooltip>
              <TooltipTrigger render={<span className="tool-elapsed" />}>+{elapsed}</TooltipTrigger>
              <TooltipPopup>
                Completed at{" "}
                {formatShortTimestamp(completedAt, props.timestampFormat ?? "locale") ||
                  completedAt}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <button
            type="button"
            className="copy-button"
            data-copy-target
            aria-label="Copy input"
            disabled={inputText.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              copyToClipboard(inputText);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <CopyIcon className="icon copy-icon size-3.5" aria-hidden />
            <span className="copy-status">{isCopied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      {expanded ? (
        <div
          id={bodyId}
          className="cell-body tool-body tool-io-body"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {props.detailSource ? (
            <ToolDetailBody
              source={props.detailSource}
              headerIntent={presentation.intent ?? undefined}
              headerSummary={headerSummary ?? undefined}
              onImageExpand={props.onImageExpand}
            />
          ) : subagentLiveContent ? (
            <SubagentLiveContentOutput liveContent={subagentLiveContent} />
          ) : streamText !== null ? (
            <ToolStreamOutput workEntry={entry} />
          ) : expandedBody !== null ? (
            <section className="tool-pane-section tool-io-input">
              <div className="tool-call-content">
                <pre className="tool-code">
                  <code>{expandedBody}</code>
                </pre>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
