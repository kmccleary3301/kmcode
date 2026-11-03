import {
  ThreadId,
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { subagentDisplayName } from "@t3tools/client-runtime/state/subagent-display";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import {
  formatActivityDetailValue,
  parseActivityDetail,
  type ParsedActivityDetail,
} from "@t3tools/client-runtime/activity-details";
import * as DateTime from "effect/DateTime";
import {
  BotIcon,
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { use, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { workEntryDisplayIndicatesToolFailure, type WorkLogEntry } from "../../session-logic";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useClientSettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { useTurnItemDetail } from "../../state/queries";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OmpToolPane } from "./omp-pane/OmpToolPane";
import { GlyphSwap } from "./GlyphSwap";
import { ompPaneModel, type OmpPaneModel } from "./omp-pane/ompPaneModel";
import { ToolActivityPresenter } from "./ToolActivityPresenter";
import { NativeTodoPane } from "./NativeTodoPane";
import { readNativeTodoPlan } from "./todoPlan";
import { NativeWaitingPane, readNativeWaitState, WaitClockGlyph } from "./NativeWaitingPane";
import { AsciiLoader } from "../ui/ascii-loader";
import { FaviconStack } from "../ui/favicon-stack";
import { SpinningGlobe } from "../ui/spinning-globe";
import { NativeSearchPane, readNativeSearchData } from "./NativeSearchPane";
import { useActivityDisclosure, ActivityDisclosurePanel } from "./ActivityDisclosure";
import {
  resolveT3McpThreadTargetDefinition,
  resolveToolWorkEntryCompactSummary,
} from "./toolWorkEntryCompactSummary";
import { TranscriptStyleCtx } from "./transcriptStyle";
import { RollingText } from "./RollingText";
import { ToolIntentTag } from "./ToolIntentTag";
import {
  LiveViewPausedNote,
  useSubagentLiveContent,
} from "../../hooks/useSubagentLiveContent";

type ActivityDetailCacheKey = "all" | "input" | "result";
const TOOL_STEP_ICON_BY_KIND: Record<string, LucideIcon> = {
  ast_edit: PencilIcon,
  bash: TerminalIcon,
  browser: GlobeIcon,
  command: TerminalIcon,
  diff: PencilIcon,
  edit: PencilIcon,
  eval: BracesIcon,
  file_change: PencilIcon,
  file_search: SearchIcon,
  find: SearchIcon,
  glob: SearchIcon,
  grep: SearchIcon,
  hub: ClockIcon,
  read: FileTextIcon,
  rg: SearchIcon,
  search: SearchIcon,
  shell: TerminalIcon,
  subagent: BotIcon,
  task: BotIcon,
  todo: FileTextIcon,
  todo_list: FileTextIcon,
  unknown: WrenchIcon,
  wait: ClockIcon,
  web_search: GlobeIcon,
  websearch: GlobeIcon,
  write: PencilIcon,
};

// Bound remount history so old work entries cannot accumulate for the session lifetime.
const MAX_SHOWN_TOOL_WORK_ENTRY_IDS = 512;
const shownToolWorkEntryIds = new Set<string>();
const parsedActivityDetailCache = new WeakMap<
  object,
  Partial<Record<ActivityDetailCacheKey, ParsedActivityDetail>>
>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const COMPACT_READ_COMPLEX_TARGET_KEYS = [
  "url",
  "urls",
  "paths",
  "files",
  "documents",
  "directory",
  "directories",
  "pattern",
  "patterns",
  "query",
  "queries",
  "web",
  "pdf",
  "document",
  "image",
  "images",
] as const;
const COMPACT_READ_PATH_KEYS = ["path", "file_path", "file", "filename"] as const;

function compactDirectFileReadPath(
  isReadFamily: boolean,
  item: OrchestrationV2TurnItem | undefined,
  entry: ToolWorkEntryCardEntry,
  failed: boolean,
): string | null {
  if (
    !isReadFamily ||
    failed ||
    (item !== undefined && item.type !== "dynamic_tool") ||
    (entry.changedFiles?.length ?? 0) > 1
  ) {
    return null;
  }
  const input = asRecord(item?.type === "dynamic_tool" ? item.input : entry.toolData);
  if (input === null) return null;
  for (const key of COMPACT_READ_COMPLEX_TARGET_KEYS) {
    if (input[key] !== undefined && input[key] !== null) return null;
  }
  const toolKind =
    typeof input.kind === "string" ? input.kind : typeof input.type === "string" ? input.type : "";
  const mediaType =
    typeof input.mimeType === "string"
      ? input.mimeType
      : typeof input.kind === "string"
        ? input.kind
        : typeof input.type === "string"
          ? input.type
          : "";
  if (
    input.isDirectory === true ||
    /^(?:web(?:page|site)?|url|docx?|document|pdf|image|directory)(?:$|[_/-])/i.test(toolKind) ||
    /^(?:application\/(?:pdf|msword|rtf|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument)|image\/)/i.test(
      mediaType,
    )
  ) {
    return null;
  }
  let pathKey: (typeof COMPACT_READ_PATH_KEYS)[number] | undefined;
  for (const key of COMPACT_READ_PATH_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (pathKey !== undefined) return null;
    pathKey = key;
  }
  if (pathKey === undefined) return null;
  const pathValue = input[pathKey];
  if (typeof pathValue !== "string") return null;
  const path = pathValue.trim();
  const windowsDrivePath = /^[a-z]:[\\/]/i.test(path);
  const lastPathSeparator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const lastPathComponent = path.slice(lastPathSeparator + 1);
  if (
    path.length === 0 ||
    path.startsWith("//") ||
    path.startsWith("\\\\") ||
    (!windowsDrivePath &&
      /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:file|ftp|sftp|ssh|mailto|data):)/i.test(path)) ||
    /[\r\n*?[\]{}]/.test(path) ||
    /[\\/]$/.test(path) ||
    lastPathComponent === "." ||
    lastPathComponent === ".." ||
    /\.(?:pdf|docx?|odt|rtf|pages|pptx?|xlsx?|key|png|jpe?g|gif|webp|avif|bmp|tiff?|svg|ico|icns|heic|heif|jp2|j2k|emf|wmf)(?::[^/\\]*)?$/i.test(
      path,
    )
  ) {
    return null;
  }
  const selector = typeof input.sel === "string" ? input.sel.trim() : "";
  return selector.length > 0 ? `${path}:${selector}` : path;
}

function parseCachedActivityDetail(
  activity: Parameters<typeof parseActivityDetail>[0],
  side?: "input" | "result",
): ParsedActivityDetail {
  if (typeof activity !== "object" || activity === null) return parseActivityDetail(activity, side);
  let cachedBySide = parsedActivityDetailCache.get(activity);
  if (cachedBySide === undefined) {
    cachedBySide = {};
    parsedActivityDetailCache.set(activity, cachedBySide);
  }
  const cacheKey = side ?? "all";
  const cached = cachedBySide[cacheKey];
  if (cached !== undefined) return cached;
  const parsed = parseActivityDetail(activity, side);
  cachedBySide[cacheKey] = parsed;
  return parsed;
}
function hasParsedActivityInput(detail: ParsedActivityDetail): boolean {
  return detail.sections.some(
    (section) =>
      section.title === "Input" &&
      (Boolean(section.description?.trim()) ||
        section.blocks.some((block) => formatActivityDetailValue(block).trim().length > 0)),
  );
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
    if (
      payload.type === "dynamic_tool" &&
      payload.output !== undefined &&
      payload.output !== null
    ) {
      if (typeof payload.output === "string") return payload.output || null;
      try {
        return JSON.stringify(payload.output, null, 2) ?? String(payload.output);
      } catch {
        return String(payload.output);
      }
    }
    if (payload.type === "subagent" && (payload.result || payload.progress)) {
      return payload.result ?? payload.progress ?? null;
    }
  }
  return null;
}

function toolResultCopyText(
  entry: ToolWorkEntryCardEntry,
  source: ToolWorkEntryDetailSource | null | undefined,
  item: OrchestrationV2TurnItem | undefined,
): string | null {
  if (item !== undefined) {
    const streamedText = streamPreviewText({
      structuredPayload: item,
    });
    if (streamedText !== null) return streamedText;
  }
  const detail =
    item !== undefined
      ? parseCachedActivityDetail(item, "result")
      : source?.kind === "parsed"
        ? source.detail
        : null;
  const text =
    detail?.sections
      .filter((section) => section.title === "Result")
      .flatMap((section) => section.blocks)
      .map((block) => formatActivityDetailValue(block))
      .join("\n\n") ?? "";
  if (text.length > 0) return text;
  return workEntryDisplayIndicatesToolFailure(entry) && entry.detail?.trim() ? entry.detail : null;
}

export function buildToolCallExpandedBody(
  workEntry: ToolWorkEntryCardEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.toolData !== undefined) {
    let dataToDisplay: unknown = workEntry.toolData;
    const dataObj = asRecord(workEntry.toolData);
    if (dataObj !== null && "input" in dataObj) {
      dataToDisplay = dataObj.input;
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

function hasWorkEntryCallContent(entry: ToolWorkEntryCardEntry): boolean {
  const item = entry.projectedItem?.item ?? entry.structuredPayload;
  const hasNativeInput =
    item?.type === "command_execution"
      ? item.input.length > 0
      : item?.type === "dynamic_tool"
        ? item.input !== null &&
          item.input !== undefined &&
          (typeof item.input !== "string" || item.input.length > 0)
        : item?.type === "file_change"
          ? Boolean(item.fileName)
          : item?.type === "file_search"
            ? Boolean(item.pattern)
            : item?.type === "web_search"
              ? Boolean(item.patterns?.length)
              : item?.type === "subagent"
                ? Boolean(item.prompt)
                : false;
  return (
    hasNativeInput ||
    entry.toolData !== undefined ||
    Boolean(entry.command?.trim()) ||
    Boolean(entry.rawCommand?.trim()) ||
    Boolean(entry.detail?.trim()) ||
    Boolean(entry.changedFiles?.length)
  );
}

function buildToolCallInputText(
  entry: ToolWorkEntryCardEntry,
  workspaceRoot: string | undefined,
  itemOverride?: OrchestrationV2TurnItem | undefined,
): string {
  const item = itemOverride ?? entry.projectedItem?.item ?? entry.structuredPayload;
  if (item?.type === "dynamic_tool") {
    // Copy what the pane shows: the program, command, or file — not the JSON args.
    const input = ompPaneModel(item).input;
    if (input?.kind === "cells") return input.cells.map((cell) => cell.code).join("\n\n");
    if (input?.kind === "command") return input.command;
    if (input?.kind === "file") return input.content;
    if (input?.kind === "prose" || input?.kind === "markdown") return input.text;
  }

  if (item?.type === "command_execution") return item.input;
  if (item?.type === "dynamic_tool" && item.input !== undefined) {
    if (typeof item.input === "string") return item.input;
    try {
      return JSON.stringify(item.input, null, 2) ?? String(item.input);
    } catch {
      return String(item.input);
    }
  }
  if (item?.type === "file_change") return item.fileName;
  if (item?.type === "file_search") return item.pattern ?? "";
  if (item?.type === "web_search") return item.patterns?.join("\n") ?? "";
  if (item?.type === "subagent") return item.prompt;
  if (entry.command?.trim()) return entry.command;
  if (entry.rawCommand?.trim()) return entry.rawCommand;

  const data = asRecord(entry.toolData);
  const nestedItem = asRecord(data?.item) ?? data;
  const input =
    nestedItem?.input ??
    nestedItem?.arguments ??
    data?.input ??
    data?.arguments ??
    (nestedItem?.command !== undefined ? { command: nestedItem.command } : undefined);
  if (input !== undefined) {
    if (typeof input === "string") return input;
    try {
      return JSON.stringify(input, null, 2) ?? String(input);
    } catch {
      return String(input);
    }
  }
  return buildToolCallExpandedBody(entry, workspaceRoot) ?? "";
}

function hasOmittedToolOutput(item: OrchestrationV2TurnItem | undefined): boolean {
  return (
    (item?.type === "command_execution" || item?.type === "dynamic_tool") &&
    item.outputOmitted === true
  );
}

function hasSummarizedToolInput(item: OrchestrationV2TurnItem | undefined): boolean {
  if (item?.type !== "dynamic_tool") return false;
  const input = asRecord(item.input);
  return input?.truncated === true && typeof input.summary === "string";
}

export function ToolTurnItemActivityDetail(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly side: "input" | "result";
  readonly headerIntent?: string | undefined;
  readonly headerSummary?: string | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
}) {
  const item = props.projectedItem.item;
  const detail = useMemo(() => parseCachedActivityDetail(item, props.side), [item, props.side]);
  return (
    <ToolActivityPresenter
      detail={detail}
      side={props.side}
      headerIntent={props.headerIntent}
      headerSummary={props.headerSummary}
      onImageExpand={props.onImageExpand}
    />
  );
}
function ToolDetailBody(props: {
  readonly source: ToolWorkEntryDetailSource;
  readonly side: "input" | "result";
  readonly headerIntent?: string | undefined;
  readonly headerSummary?: string | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
}) {
  if (props.source.kind === "projected") {
    return (
      <ToolTurnItemActivityDetail
        projectedItem={props.source.projectedItem}
        side={props.side}
        headerIntent={props.headerIntent}
        headerSummary={props.headerSummary}
        onImageExpand={props.onImageExpand}
      />
    );
  }
  return (
    <ToolActivityPresenter
      detail={props.source.detail}
      side={props.side}
      headerIntent={props.headerIntent}
      headerSummary={props.headerSummary}
      onImageExpand={props.onImageExpand}
    />
  );
}

export function ToolWorkEntryCard(props: {
  readonly entry: ToolWorkEntryCardEntry;
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly cwd?: string | undefined;
  /** An identity mark (integration logo, KM monogram); null for generic tools. */
  readonly icon: ReactNode;
  readonly detailSource?: ToolWorkEntryDetailSource | null | undefined;
  readonly onImageExpand?: ((source: string, alt: string) => void) | undefined;
  readonly disclosureCache?: Set<string> | undefined;
  readonly lifecycleItems?: ReadonlyArray<OrchestrationV2TurnItem> | undefined;
  readonly autoExpanded?: boolean | undefined;
  readonly onToggleEntry?: ((collapsed: boolean) => void) | undefined;
  /** Defined when the step just joined an open group (it may arrive already
   * settled): it rolls in after this delay. */
  readonly enterDelayMs?: number | undefined;
}) {
  const { entry } = props;
  const transcriptStyle = use(TranscriptStyleCtx);
  const isTerminal = transcriptStyle === "terminal";
  const toolDetail = useClientSettings((settings) => settings.toolDetail);
  const projected = entry.projectedItem?.item;
  const nativeItem = projected ?? entry.structuredPayload;
  const t3ThreadToolDefinition =
    nativeItem?.type === "dynamic_tool" && nativeItem.toolName !== null
      ? resolveT3McpThreadTargetDefinition(nativeItem.toolName)
      : null;
  const threadInput =
    t3ThreadToolDefinition !== null && nativeItem?.type === "dynamic_tool"
      ? asRecord(nativeItem.input)
      : null;
  const targetThreadIdValue =
    typeof threadInput?.threadId === "string" ? threadInput.threadId.trim() : "";
  const targetThreadId =
    targetThreadIdValue.length > 0 ? ThreadId.make(targetThreadIdValue) : null;
  const projectedSource = props.detailSource?.kind === "projected" ? props.detailSource : null;
  const targetEnvironmentId = projectedSource?.environmentId ?? props.environmentId;
  const parentThreadId =
    projectedSource?.projectedItem.sourceThreadId ?? nativeItem?.threadId ?? null;
  const parentThreadRef =
    targetEnvironmentId != null && parentThreadId !== null && targetThreadId !== null
      ? scopeThreadRef(targetEnvironmentId, parentThreadId)
      : null;
  const targetThreadRef =
    targetEnvironmentId != null && targetThreadId !== null
      ? scopeThreadRef(targetEnvironmentId, targetThreadId)
      : null;
  const parentProjection = useThreadProjection(parentThreadRef);
  const targetThreadShell = useThreadShell(targetThreadRef);
  const projectedSubagent = parentProjection?.projection.subagents.find(
    (subagent) => subagent.childThreadId === targetThreadId,
  );
  const formattedSubagentTitle = projectedSubagent
    ? (subagentDisplayName(projectedSubagent) ?? "")
    : "";
  const threadTargetTitle =
    targetThreadId === null
      ? undefined
      : formattedSubagentTitle || targetThreadShell?.title?.trim() || "a thread";
  const canonicalId = nativeItem?.id ?? entry.id;
  const cardDisclosureKey = `tool:${canonicalId}`;
  const isWorkActive =
    nativeItem?.status === "running" ||
    nativeItem?.status === "pending" ||
    entry.toolLifecycleStatus === "inProgress";
  const defaultCardOpen = props.autoExpanded !== undefined ? props.autoExpanded : isWorkActive;

  const cardDisclosure = useActivityDisclosure({
    cache: props.disclosureCache,
    disclosureKey: cardDisclosureKey,
    defaultOpen: defaultCardOpen,
  });
  const cardBodyOpen = isTerminal || cardDisclosure.open;

  const [inputCopyRequestedId, setInputCopyRequestedId] = useState<string | null>(null);
  const [outputCopyRequestedId, setOutputCopyRequestedId] = useState<string | null>(null);
  const [inputCopyErrorId, setInputCopyErrorId] = useState<string | null>(null);
  const [outputCopyErrorId, setOutputCopyErrorId] = useState<string | null>(null);
  const searchHeaderObjectRef = useRef<HTMLSpanElement>(null);
  const [truncatedSearchQuery, setTruncatedSearchQuery] = useState<{
    readonly query: string;
    readonly truncated: boolean;
  } | null>(null);
  const inputCopyRetryPendingRef = useRef(false);
  const inputCopyRefreshingRef = useRef(false);
  const outputCopyRetryPendingRef = useRef(false);
  const outputCopyRefreshingRef = useRef(false);

  const [prevCanonicalId, setPrevCanonicalId] = useState(canonicalId);
  if (prevCanonicalId !== canonicalId) {
    setPrevCanonicalId(canonicalId);
    setInputCopyRequestedId(null);
    setOutputCopyRequestedId(null);
    setInputCopyErrorId(null);
    setOutputCopyErrorId(null);
  }

  const inputCopyRequested = inputCopyRequestedId === canonicalId;
  const outputCopyRequested = outputCopyRequestedId === canonicalId;
  const detailWireItem = projectedSource?.projectedItem.item;
  const subagentItem = detailWireItem?.type === "subagent" ? detailWireItem : null;
  const { liveContent: overlaySubagentLiveContent, rateLimited } = useSubagentLiveContent(
    projectedSource == null
      ? null
      : scopeThreadRef(
          projectedSource.environmentId,
          projectedSource.projectedItem.sourceThreadId,
        ),
    {
      active:
        subagentItem !== null && isOrchestrationV2WorkActive(subagentItem.status),
      subagentId: subagentItem?.subagentId,
      turnItemId: subagentItem?.id,
      persisted: subagentItem?.liveContent,
    },
  );
  const summaryData = useMemo(
    () =>
      resolveToolWorkEntryCompactSummary({
        entry,
        workspaceRoot: props.workspaceRoot,
        threadTargetTitle,
        subagentLiveContent: overlaySubagentLiveContent,
      }),
    [entry, overlaySubagentLiveContent, props.workspaceRoot, threadTargetTitle],
  );
  const compactReadPath =
    toolDetail === "compact" && !isTerminal
      ? compactDirectFileReadPath(
          summaryData.family === "read",
          nativeItem,
          entry,
          summaryData.failed,
        )
      : null;
  const compactDirectRead = compactReadPath !== null;
  const stepState = summaryData.isQueued
    ? "queued"
    : summaryData.isRunning
      ? "running"
      : summaryData.failed
        ? "failed"
        : "settled";
  // A live read that fails turns from the one-line form into a full pane,
  // which remounts the header: the pane skips its entrance (the row is
  // already on screen) and the glyph crossfades from what the line showed.
  const [readForm, setReadForm] = useState<{
    readonly compact: boolean;
    readonly glyph: string;
    readonly reformedFrom: string | null;
  }>({ compact: compactDirectRead, glyph: stepState, reformedFrom: null });
  if (readForm.compact !== compactDirectRead || readForm.glyph !== stepState) {
    setReadForm({
      compact: compactDirectRead,
      glyph: stepState,
      reformedFrom: readForm.compact !== compactDirectRead ? readForm.glyph : readForm.reformedFrom,
    });
  }
  const needsInputDetail = hasSummarizedToolInput(detailWireItem);
  const needsOutputDetail = hasOmittedToolOutput(detailWireItem);
  // The wire drops edit and write bodies; an open pane reads them (live, as
  // each streamed revision lands).
  const needsFileBody =
    detailWireItem?.type === "file_change" && detailWireItem.status !== "failed";
  const fetchesInputDetails =
    !compactDirectRead && needsInputDetail && (cardBodyOpen || inputCopyRequested);
  const fetchesOutputDetails =
    !compactDirectRead &&
    ((needsOutputDetail && (cardBodyOpen || outputCopyRequested)) ||
      (needsFileBody && cardBodyOpen));
  const queryTarget =
    projectedSource !== null &&
    detailWireItem !== undefined &&
    (fetchesInputDetails || fetchesOutputDetails)
      ? {
          environmentId: projectedSource.environmentId,
          threadId: projectedSource.projectedItem.sourceThreadId,
          itemId: projectedSource.projectedItem.sourceItemId,
          revision: turnItemDetailRevision(detailWireItem),
        }
      : null;
  const fetchesDetails = queryTarget !== null;
  const detailQuery = useTurnItemDetail(queryTarget);
  const fetchedItem = detailQuery.data?.item;
  const [lastHydration, setLastHydration] = useState(() => ({
    environmentId: projectedSource?.environmentId,
    threadId: projectedSource?.projectedItem.sourceThreadId,
    item: fetchedItem,
  }));
  if (
    fetchedItem != null &&
    (lastHydration.item !== fetchedItem ||
      lastHydration.environmentId !== projectedSource?.environmentId ||
      lastHydration.threadId !== projectedSource?.projectedItem.sourceThreadId)
  ) {
    setLastHydration({
      environmentId: projectedSource?.environmentId,
      threadId: projectedSource?.projectedItem.sourceThreadId,
      item: fetchedItem,
    });
  }
  const currentFetchedItem =
    detailWireItem !== undefined &&
    fetchedItem !== undefined &&
    fetchedItem !== null &&
    fetchedItem.type === detailWireItem.type &&
    fetchedItem.id === detailWireItem.id &&
    DateTime.formatIso(fetchedItem.updatedAt) === DateTime.formatIso(detailWireItem.updatedAt)
      ? fetchedItem
      : undefined;
  const hasCurrentFetchedItem = currentFetchedItem !== undefined;
  const hasInputCopyError = inputCopyErrorId === canonicalId && !hasCurrentFetchedItem;
  const hasOutputCopyError = outputCopyErrorId === canonicalId && !hasCurrentFetchedItem;
  const nativeInputDetail = useMemo(() => {
    if (compactDirectRead || props.detailSource != null || nativeItem === undefined) return null;
    const detail = parseCachedActivityDetail(nativeItem);
    return hasParsedActivityInput(detail) ? { kind: "parsed" as const, detail } : null;
  }, [compactDirectRead, nativeItem, props.detailSource]);

  const resolvedItem = currentFetchedItem ?? detailWireItem;
  const resolvedDetailSource =
    projectedSource !== null && resolvedItem !== undefined
      ? {
          ...projectedSource,
          projectedItem: { ...projectedSource.projectedItem, item: resolvedItem },
        }
      : (props.detailSource ?? nativeInputDetail);
  const lastDetailRefreshKey = useRef<string | null>(null);
  const { copyToClipboard: copyInputToClipboard, isCopied: isInputCopied } = useCopyToClipboard({
    target: "input",
  });
  const { copyToClipboard: copyOutputToClipboard, isCopied: isOutputCopied } = useCopyToClipboard({
    target: "output",
  });

  useEffect(() => {
    if (
      !fetchesDetails ||
      detailWireItem === undefined ||
      fetchedItem === undefined ||
      hasCurrentFetchedItem
    ) {
      return;
    }
    const refreshKey = `${detailWireItem.id}:${DateTime.formatIso(detailWireItem.updatedAt)}`;
    if (lastDetailRefreshKey.current === refreshKey) return;
    lastDetailRefreshKey.current = refreshKey;
    detailQuery.refresh();
  }, [detailQuery.refresh, detailWireItem, fetchedItem, fetchesDetails, hasCurrentFetchedItem]);

  useEffect(() => {
    if (!inputCopyRequested) {
      inputCopyRetryPendingRef.current = false;
      inputCopyRefreshingRef.current = false;
      return;
    }

    if (inputCopyRetryPendingRef.current) {
      inputCopyRetryPendingRef.current = false;
      inputCopyRefreshingRef.current = true;
      detailQuery.refresh();
      return;
    }

    if (inputCopyRefreshingRef.current) {
      if (detailQuery.isPending) {
        inputCopyRefreshingRef.current = false;
        return;
      }
      if (hasCurrentFetchedItem && resolvedItem !== undefined) {
        inputCopyRefreshingRef.current = false;
        copyInputToClipboard(buildToolCallInputText(entry, props.workspaceRoot, resolvedItem));
        setInputCopyRequestedId(null);
        setInputCopyErrorId(null);
        return;
      }
      if (detailQuery.error !== null || (!detailQuery.isPending && detailQuery.data === null)) {
        inputCopyRefreshingRef.current = false;
        setInputCopyRequestedId(null);
        setInputCopyErrorId(canonicalId);
        return;
      }
      return;
    }

    if (hasCurrentFetchedItem && resolvedItem !== undefined) {
      copyInputToClipboard(buildToolCallInputText(entry, props.workspaceRoot, resolvedItem));
      setInputCopyRequestedId(null);
      setInputCopyErrorId(null);
    } else if (
      detailQuery.error !== null ||
      (!detailQuery.isPending && detailQuery.data === null)
    ) {
      setInputCopyRequestedId(null);
      setInputCopyErrorId(canonicalId);
    }
  }, [
    canonicalId,
    copyInputToClipboard,
    detailQuery.data,
    detailQuery.error,
    detailQuery.isPending,
    detailQuery.refresh,
    entry,
    hasCurrentFetchedItem,
    inputCopyRequested,
    props.workspaceRoot,
    resolvedItem,
  ]);

  useEffect(() => {
    if (!outputCopyRequested) {
      outputCopyRetryPendingRef.current = false;
      outputCopyRefreshingRef.current = false;
      return;
    }

    if (outputCopyRetryPendingRef.current) {
      outputCopyRetryPendingRef.current = false;
      outputCopyRefreshingRef.current = true;
      detailQuery.refresh();
      return;
    }

    if (outputCopyRefreshingRef.current) {
      if (detailQuery.isPending) {
        outputCopyRefreshingRef.current = false;
        return;
      }
      if (hasCurrentFetchedItem && resolvedItem !== undefined) {
        outputCopyRefreshingRef.current = false;
        const text = toolResultCopyText(entry, props.detailSource, resolvedItem);
        if (text !== null) {
          copyOutputToClipboard(text);
          setOutputCopyErrorId(null);
        } else {
          setOutputCopyErrorId(canonicalId);
        }
        setOutputCopyRequestedId(null);
        return;
      }
      if (detailQuery.error !== null || (!detailQuery.isPending && detailQuery.data === null)) {
        outputCopyRefreshingRef.current = false;
        setOutputCopyRequestedId(null);
        setOutputCopyErrorId(canonicalId);
        return;
      }
      return;
    }

    if (hasCurrentFetchedItem && resolvedItem !== undefined) {
      const text = toolResultCopyText(entry, props.detailSource, resolvedItem);
      if (text !== null) {
        copyOutputToClipboard(text);
        setOutputCopyErrorId(null);
      } else {
        setOutputCopyErrorId(canonicalId);
      }
      setOutputCopyRequestedId(null);
    } else if (
      detailQuery.error !== null ||
      (!detailQuery.isPending && detailQuery.data === null)
    ) {
      setOutputCopyRequestedId(null);
      setOutputCopyErrorId(canonicalId);
    }
  }, [
    canonicalId,
    copyOutputToClipboard,
    detailQuery.data,
    detailQuery.error,
    detailQuery.isPending,
    detailQuery.refresh,
    entry,
    hasCurrentFetchedItem,
    outputCopyRequested,
    props.detailSource,
    resolvedItem,
  ]);

  const { failed, target: headerSummary, subagentLiveContent } = summaryData;
  const presentation = summaryData;
  const cardId = useId();
  // Animate a live step once; the timeline's explicit delay also marks new group arrivals.
  const [enteredLive] = useState(
    () =>
      props.enterDelayMs !== undefined ||
      ((summaryData.isRunning || summaryData.isQueued) && !shownToolWorkEntryIds.has(entry.id)),
  );
  useEffect(() => {
    shownToolWorkEntryIds.delete(entry.id);
    shownToolWorkEntryIds.add(entry.id);
    if (shownToolWorkEntryIds.size > MAX_SHOWN_TOOL_WORK_ENTRY_IDS) {
      const oldest = shownToolWorkEntryIds.values().next().value;
      if (oldest !== undefined) shownToolWorkEntryIds.delete(oldest);
    }
  }, [entry.id]);
  const enterStyle =
    enteredLive && props.enterDelayMs
      ? { animationDelay: `${props.enterDelayMs}ms`, animationFillMode: "backwards" as const }
      : undefined;
  const cardBodyId = `tool-${cardId}-body`;
  const detailItem = resolvedItem ?? nativeItem;
  // While a newer revision loads, keep drawing the last fetched body so a
  // streaming pane never drops back to the bodiless wire item.
  const retainedItem =
    lastHydration.environmentId === projectedSource?.environmentId &&
    lastHydration.threadId === projectedSource?.projectedItem.sourceThreadId
      ? lastHydration.item
      : undefined;
  const availableFetchedItem = fetchedItem ?? retainedItem;
  const lastFetchedItem =
    detailWireItem !== undefined &&
    availableFetchedItem != null &&
    availableFetchedItem.type === detailWireItem.type &&
    availableFetchedItem.id === detailWireItem.id
      ? availableFetchedItem
      : undefined;
  const paneItem = currentFetchedItem ?? lastFetchedItem ?? detailItem;
  // Terminal titles show the intent in place of the path when there is one;
  // every other title keeps the path.
  const pathInTitle = !isTerminal || !summaryData.intent;
  const paneModel = useMemo((): OmpPaneModel => {
    const model: OmpPaneModel =
      paneItem !== undefined
        ? ompPaneModel(paneItem, { pathInTitle })
        : {
            input: hasWorkEntryCallContent(entry)
              ? { kind: "prose", text: buildToolCallInputText(entry, props.workspaceRoot) }
              : null,
            output: null,
            outputListing: null,
            outputLanguage: null,
            outputIsError: false,
            outputHasImages: false,
          };
    // A failure with no output still has its diagnostic.
    return model.output === null && failed && entry.detail?.trim()
      ? { ...model, output: entry.detail, outputIsError: true }
      : model;
  }, [entry, failed, paneItem, pathInTitle, props.workspaceRoot]);
  const canCopyInput = hasWorkEntryCallContent(entry);
  const canCopyOutput = paneModel.output !== null || needsOutputDetail;
  const outputDetailLoading =
    fetchesOutputDetails &&
    !hasCurrentFetchedItem &&
    lastFetchedItem === undefined &&
    detailQuery.error === null;
  const nativeTodoPlan = useMemo(
    () => (detailItem === undefined ? null : readNativeTodoPlan(detailItem)),
    [detailItem],
  );
  const nativeWaitState = useMemo(
    () => (detailItem === undefined ? null : readNativeWaitState(detailItem, props.lifecycleItems)),
    [detailItem, props.lifecycleItems],
  );
  const nativeSearchData = useMemo(
    () => (detailItem === undefined ? null : readNativeSearchData(detailItem)),
    [detailItem],
  );
  const searchHeaderQuery = summaryData.isWebSearch
    ? (nativeSearchData?.query ?? summaryData.object)
    : undefined;
  const searchHeaderQueryIsTruncated =
    searchHeaderQuery !== undefined &&
    truncatedSearchQuery?.query === searchHeaderQuery &&
    truncatedSearchQuery.truncated;

  useEffect(() => {
    const queryObject = searchHeaderObjectRef.current;
    if (
      searchHeaderQuery === undefined ||
      queryObject === null ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const truncated = queryObject.scrollWidth > queryObject.clientWidth;
      setTruncatedSearchQuery((current) =>
        current?.query === searchHeaderQuery && current.truncated === truncated
          ? current
          : { query: searchHeaderQuery, truncated },
      );
    });
    observer.observe(queryObject);
    return () => observer.disconnect();
  }, [searchHeaderQuery]);
  const inputCopyAction = (
    <>
      {hasInputCopyError ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1.5 font-sans text-xs text-muted-foreground"
        >
          <XIcon className="size-3 shrink-0 status-failed-mark" aria-hidden="true" />
          Could not load tool input.
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="copy-button"
              data-copy-target
              aria-label="Copy input"
              disabled={!canCopyInput || inputCopyRequested}
              onClick={() => {
                if (needsInputDetail && !hasCurrentFetchedItem) {
                  const isRetry = hasInputCopyError || detailQuery.error !== null;
                  setInputCopyErrorId(null);
                  setInputCopyRequestedId(canonicalId);
                  if (isRetry) inputCopyRetryPendingRef.current = true;
                  return;
                }
                copyInputToClipboard(
                  buildToolCallInputText(entry, props.workspaceRoot, detailItem),
                );
              }}
            >
              {isInputCopied ? (
                <CheckIcon className="icon size-3.5 text-foreground" aria-hidden />
              ) : (
                <CopyIcon className="icon size-3.5" aria-hidden />
              )}
              <span className="sr-only">
                {inputCopyRequested ? "Loading…" : isInputCopied ? "Copied" : "Copy"}
              </span>
            </button>
          }
        />
        <TooltipPopup>Copy input</TooltipPopup>
      </Tooltip>
    </>
  );
  const outputCopyAction = (
    <>
      {hasOutputCopyError ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1.5 font-sans text-xs text-muted-foreground"
        >
          <XIcon className="size-3 shrink-0 status-failed-mark" aria-hidden="true" />
          Could not load tool output.
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="copy-button"
              data-copy-target
              aria-label="Copy output"
              disabled={!canCopyOutput || outputCopyRequested}
              onClick={() => {
                if (needsOutputDetail && !hasCurrentFetchedItem) {
                  const isRetry = hasOutputCopyError || detailQuery.error !== null;
                  setOutputCopyErrorId(null);
                  setOutputCopyRequestedId(canonicalId);
                  if (isRetry) outputCopyRetryPendingRef.current = true;
                  return;
                }
                const outputText = toolResultCopyText(entry, props.detailSource, detailItem);
                if (outputText !== null) copyOutputToClipboard(outputText);
              }}
            >
              {isOutputCopied ? (
                <CheckIcon className="icon size-3.5 text-foreground" aria-hidden />
              ) : (
                <CopyIcon className="icon size-3.5" aria-hidden />
              )}
              <span className="sr-only">
                {outputCopyRequested ? "Loading…" : isOutputCopied ? "Copied" : "Copy"}
              </span>
            </button>
          }
        />
        <TooltipPopup>Copy output</TooltipPopup>
      </Tooltip>
    </>
  );
  const outputOverride =
    paneModel.outputHasImages && resolvedDetailSource ? (
      <ToolDetailBody
        source={resolvedDetailSource}
        side="result"
        headerIntent={presentation.intent ?? undefined}
        headerSummary={headerSummary ?? undefined}
        onImageExpand={props.onImageExpand}
      />
    ) : paneModel.output !== null ? null : outputDetailLoading ? (
      <p role="status" className="omp-pane-note">
        Loading output…
      </p>
    ) : detailQuery.error !== null && fetchesOutputDetails ? (
      <p role="alert" className="omp-pane-note" data-error>
        Could not load the output.
      </p>
    ) : subagentLiveContent ? (
      <pre className="omp-pane-output-text">{subagentLiveContent.text}</pre>
    ) : subagentItem !== null && summaryData.isRunning && rateLimited ? (
      <p className="omp-pane-note">
        <LiveViewPausedNote />
      </p>
    ) : null;

  const isBash =
    summaryData.toolName.toLowerCase() === "bash" ||
    entry.structuredPayload?.type === "command_execution";
  const terminalPreviewLines = !isTerminal
    ? undefined
    : paneModel.input?.kind === "diff"
      ? 40
      : isBash
        ? 20
        : summaryData.family === "read"
          ? 12
          : paneModel.outputListing !== null
            ? 8
            : 3;
  const terminalInputPreviewLines =
    !isTerminal || paneModel.input === null
      ? undefined
      : paneModel.input.kind === "diff"
        ? 40
        : paneModel.input.kind === "command"
          ? 20
          : paneModel.input.kind === "file" || paneModel.input.kind === "cells"
            ? 12
            : undefined;
  const liveOutputText = summaryData.isRunning ? streamPreviewText(entry) : null;
  const liveOutputLines = liveOutputText ? liveOutputText.trimEnd().split(/\r?\n/) : [];
  const maxLiveLines = isBash ? 10 : 3;
  const liveOmittedCount =
    liveOutputLines.length > maxLiveLines ? liveOutputLines.length - maxLiveLines : 0;
  const visibleLiveLines =
    liveOmittedCount > 0 ? liveOutputLines.slice(-maxLiveLines) : liveOutputLines;

  const objectPath =
    compactReadPath === null
      ? summaryData.object
      : formatWorkspaceRelativePath(compactReadPath, props.workspaceRoot);
  const objectIsPath = compactReadPath !== null || summaryData.objectIsPath;
  const objectSlash =
    compactReadPath !== null
      ? Math.max(objectPath.lastIndexOf("/"), objectPath.lastIndexOf("\\"))
      : summaryData.objectIsPath
        ? summaryData.object.lastIndexOf("/")
        : -1;
  // The directory has no flex basis, so it yields space first; the basename
  // ellipsizes only once it alone does not fit. Line counts never truncate.
  const objectText = summaryData.isWebSearch
    ? (nativeSearchData?.query ?? summaryData.object)
    : objectPath;
  const objectView = (
    <>
      {objectText.length > 0 ? (
        <span
          data-tool-object
          className={cn(
            "flex min-w-0 overflow-hidden",
            summaryData.isWebSearch ? "font-sans" : "font-mono",
          )}
        >
          {objectIsPath ? (
            <>
              {objectSlash >= 0 ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {objectPath.slice(0, objectSlash + 1)}
                </span>
              ) : null}
              <span className="min-w-0 truncate font-semibold text-foreground/90">
                {objectPath.slice(objectSlash + 1)}
              </span>
            </>
          ) : (
            <span
              ref={summaryData.isWebSearch ? searchHeaderObjectRef : undefined}
              className="min-w-0 truncate text-muted-foreground"
            >
              {objectText}
            </span>
          )}
        </span>
      ) : null}
      {summaryData.diffStats ? (
        <span className="shrink-0 font-sans tabular-nums">
          {summaryData.diffStats.added > 0 ? (
            <span className="status-diff-added">+{summaryData.diffStats.added}</span>
          ) : null}
          {summaryData.diffStats.removed > 0 ? (
            <span className="ms-1 status-diff-removed">−{summaryData.diffStats.removed}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  // KM and Minimal shine the whole live line (verb and object); Terminal's
  // legend shines the verb alone.
  const lineShine = !isTerminal && summaryData.isRunning;
  const verbView = (
    <>
      {props.icon ? (
        <span className="flex shrink-0 self-center" aria-hidden="true">
          {props.icon}
        </span>
      ) : null}
      <RollingText
        text={summaryData.verb}
        data-tool-verb
        className={cn(
          "shrink-0 font-sans font-medium text-foreground/90",
          summaryData.isRunning && !lineShine && "live-tool-shine",
        )}
      />
    </>
  );
  // The last non-empty output line usually names the failure ("command not found").
  const failureLine = summaryData.failed
    ? (summaryData.failureSnippet
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .findLast((line) => line.length > 0) ?? null)
    : null;
  const toolIconKey = summaryData.toolName
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
  const StepIcon =
    TOOL_STEP_ICON_BY_KIND[summaryData.isWebSearch ? "web_search" : toolIconKey] ??
    TOOL_STEP_ICON_BY_KIND[summaryData.family] ??
    WrenchIcon;
  const isWaitingStep = StepIcon === ClockIcon;
  const statusGlyph = (
    <GlyphSwap
      state={stepState}
      enterFrom={readForm.reformedFrom}
      render={(state) =>
        state === "failed" ? (
          <XIcon className="size-3.5 status-failed-mark" />
        ) : state === "settled" || (state === "queued" && !summaryData.isRunning) ? (
          <StepIcon className="size-3.5" />
        ) : isWaitingStep ? (
          <WaitClockGlyph className="size-3.5" />
        ) : summaryData.isWebSearch ? (
          <SpinningGlobe className="size-3.5" />
        ) : (
          <AsciiLoader />
        )
      }
      data-step-state={stepState}
      className="tool-status-gutter step-glyph mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      aria-hidden="true"
    />
  );
  if (compactDirectRead) {
    return (
      <div
        className={cn(
          "tool-header-left tool-compact-line flex min-w-0 items-center gap-2",
          enteredLive && readForm.reformedFrom === null && "motion-enter",
        )}
        style={enterStyle}
      >
        {statusGlyph}
        <div className="tool-heading min-w-0 flex-1">
          <div
            ref={summaryData.isRunning ? observeVisibleAnimation : undefined}
            className={cn(
              "flex min-w-0 items-baseline gap-1.5 text-sm",
              lineShine && "live-tool-shine",
            )}
          >
            {verbView}
            {objectView}
          </div>
        </div>
      </div>
    );
  }
  // An outcome reads as part of the line it describes: same size and baseline
  // as the object, after a quiet separator, never a separate column.
  const outcome = summaryData.failed
    ? summaryData.exitCode !== undefined
      ? `Failed (exit ${summaryData.exitCode})`
      : "Failed"
    : summaryData.isNoMatch
      ? "No matches"
      : null;
  const rowMeta =
    outcome !== null ? (
      <span className="tool-row-meta">
        <span aria-hidden="true">·</span>
        {outcome}
      </span>
    ) : null;
  // Minimal and Minimal+ keep every step on one line, so the intent trails it as a tag;
  // KM heads the step with it.
  const minimalLook = transcriptStyle === "minimal" || transcriptStyle === "minimal-plus";
  const stackedIntent = minimalLook ? undefined : summaryData.intent;
  const headerContent = (
    <>
      <div className="tool-header-left flex min-w-0 items-start gap-2">
        {statusGlyph}
        {/* The glyph is decorative; failures and empty searches say so in the line. */}
        {summaryData.failed || summaryData.isNoMatch ? null : (
          <span className="tool-state sr-only">
            {summaryData.isQueued ? "Queued" : summaryData.isRunning ? "Running" : "Completed"}
          </span>
        )}
        <div className="tool-heading min-w-0 flex-1">
          {stackedIntent ? (
            <div className="tool-intent truncate font-sans text-sm text-foreground">
              {stackedIntent}
            </div>
          ) : null}
          <div
            ref={summaryData.isRunning ? observeVisibleAnimation : undefined}
            className={cn(
              "flex min-w-0 items-baseline gap-1.5",
              stackedIntent ? "tool-heading-details text-xs text-muted-foreground" : "text-sm",
              lineShine && "live-tool-shine",
            )}
          >
            {verbView}
            {objectView}
            {rowMeta}
            {/* Last, so Minimal can hold it against the line's right edge. */}
            {minimalLook ? <ToolIntentTag intent={summaryData.intent} /> : null}
          </div>
          {failureLine ? (
            <div
              data-tool-failure-line
              className="truncate font-sans text-2xs text-muted-foreground"
            >
              {failureLine}
            </div>
          ) : null}
        </div>
      </div>
      <div className="tool-header-right flex items-center gap-2 shrink-0 text-xs">
        {summaryData.isWebSearch &&
        nativeSearchData !== null &&
        nativeSearchData.sources.length > 0 ? (
          <FaviconStack sources={nativeSearchData.sources} active={summaryData.isRunning} />
        ) : null}
        <ChevronDownIcon
          className="tool-disclosure-chevron size-3.5 text-muted-foreground/60 group-open:rotate-180"
          aria-hidden
        />
      </div>
    </>
  );
  let bodyContent: ReactNode;
  if (nativeTodoPlan !== null) {
    bodyContent = (
      <div data-t3-part="native-todo-tool">
        <NativeTodoPane
          plan={nativeTodoPlan}
          {...(props.disclosureCache === undefined
            ? {}
            : { disclosureCache: props.disclosureCache })}
        />
        {failed ? (
          <p className="flex items-center gap-1.5 px-2.5 text-xs text-muted-foreground">
            <XIcon className="size-3 shrink-0 status-failed-mark" aria-hidden="true" />
            Todo update failed. Showing the native-reported plan.
          </p>
        ) : null}
      </div>
    );
  } else if (nativeWaitState !== null) {
    bodyContent = (
      <div data-t3-part="native-wait-tool">
        <NativeWaitingPane state={nativeWaitState} />
        {failed ? (
          <p className="flex items-center gap-1.5 px-2.5 text-xs text-muted-foreground">
            <XIcon className="size-3 shrink-0 status-failed-mark" aria-hidden="true" />
            Wait failed.
          </p>
        ) : null}
      </div>
    );
  } else if (nativeSearchData !== null) {
    bodyContent = (
      <div data-t3-part="native-search-tool">
        <NativeSearchPane
          data={nativeSearchData}
          {...(props.disclosureCache === undefined
            ? {}
            : { disclosureCache: props.disclosureCache })}
          cwd={props.cwd ?? props.workspaceRoot}
          failed={failed}
          queryIsTruncated={searchHeaderQueryIsTruncated}
        />
      </div>
    );
  } else {
    bodyContent = (
      <OmpToolPane
        model={paneModel}
        streamingArgs={(paneItem ?? detailWireItem)?.status === "pending"}
        running={summaryData.isRunning}
        inputActions={inputCopyAction}
        outputActions={canCopyOutput ? outputCopyAction : null}
        outputOverride={outputOverride}
        previewLines={terminalPreviewLines}
        inputPreviewLines={terminalInputPreviewLines}
        legend={
          isTerminal ? (
            <>
              {statusGlyph}
              <span className="omp-pane-legend-text">
                {summaryData.intent ? (
                  <span className="min-w-0 truncate">{summaryData.intent}</span>
                ) : (
                  <>
                    {verbView}
                    {objectView}
                  </>
                )}
              </span>
            </>
          ) : undefined
        }
      />
    );
  }

  return (
    <div
      className={cn(
        "tool-io-pane assistant-trace borderless-step-row",
        enteredLive && readForm.reformedFrom === null && "step-row-enter",
        failed && "tool-output-error",
      )}
      id={`tool-${cardId}`}
      style={enterStyle}
      data-t3-part="tool-output"
      data-v2-item-type={entry.projectedItem?.item.type}
      data-v2-item-visibility={entry.projectedItem?.visibility}
      data-instant={cardDisclosure.instant || undefined}
      data-cell
      data-terminal-status={
        isTerminal ? (stepState === "settled" ? "success" : stepState) : undefined
      }
      data-terminal-bash={isTerminal && isBash ? "true" : undefined}
    >
      {/* OMP's transcript is just the panes: the pane frame carries the state. */}
      {isTerminal ? null : (
        <div className="tool-header">
          <button
            type="button"
            className="tool-header-disclosure"
            aria-expanded={cardDisclosure.open}
            aria-controls={cardBodyId}
            data-instant={cardDisclosure.instant || undefined}
            aria-label={
              summaryData.intent
                ? `${summaryData.toolName}: ${summaryData.intent}`
                : `${summaryData.toolName} details`
            }
            onClick={(event) => {
              props.onToggleEntry?.(cardDisclosure.open);
              cardDisclosure.toggle(event);
            }}
          >
            {headerContent}
          </button>
        </div>
      )}
      {summaryData.isRunning && visibleLiveLines.length > 0 && !cardBodyOpen ? (
        <div
          data-tool-live-tail
          className="px-3 py-1.5 font-mono text-xs text-muted-foreground bg-muted/30 border-t border-border/40"
        >
          {liveOmittedCount > 0 ? (
            <div className="text-3xs text-muted-foreground/60 mb-0.5">
              … +{liveOmittedCount} lines
            </div>
          ) : null}
          <pre className="whitespace-pre-wrap leading-tight">{visibleLiveLines.join("\n")}</pre>
        </div>
      ) : null}
      <ActivityDisclosurePanel
        open={cardBodyOpen}
        instant={cardDisclosure.instant}
        id={cardBodyId}
        role="region"
        aria-label={
          summaryData.intent
            ? `${summaryData.toolName}: ${summaryData.intent}`
            : `${summaryData.toolName} details`
        }
        className="tool-body tool-io-body"
      >
        {bodyContent}
        {isTerminal && failureLine ? <p data-tool-failure-line>{failureLine}</p> : null}
      </ActivityDisclosurePanel>
    </div>
  );
}
