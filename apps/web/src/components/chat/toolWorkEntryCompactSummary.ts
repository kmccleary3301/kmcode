import type {
  OrchestrationV2SubagentLiveContent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  codeCellKind,
  parseActivityToolPresentation,
  type ActivityToolFamily,
} from "@t3tools/client-runtime/activity-details";
import {
  deriveToolVerbObject,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  workEntryDeviceOperation,
  turnItemDiffStats,
  type DiffStats,
} from "@t3tools/client-runtime/work-log/presentation";

import { workEntryDisplayIndicatesToolFailure, type WorkLogEntry } from "../../session-logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

export type ToolWorkEntryCardEntry = WorkLogEntry;
const WEB_SEARCH_TOOL_NAMES: Record<string, true> = {
  "web search": true,
  web_search: true,
  websearch: true,
};

export function resolveT3McpThreadTargetDefinition(toolName: string) {
  const definition = resolveT3McpToolDefinition(toolName);
  switch (definition?.summaryAction) {
    case "thread-read":
    case "thread-send":
    case "thread-wait":
    case "thread-interrupt":
      return definition;
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The tool name, family, intent, target and code-cell kind a work entry's row presents. */
export function workEntryPresentation(entry: ToolWorkEntryCardEntry) {
  const projected = entry.projectedItem?.item ?? entry.structuredPayload;
  const deviceOperation = workEntryDeviceOperation(projected);
  const toolLabel =
    resolveWorkEntryToolPresentation(entry)?.displayName ??
    entry.toolTitle ??
    normalizeCompactToolLabel(entry.label);
  let semanticToolName = toolLabel;
  let rawInput: unknown =
    entry.toolData ?? (entry.command ? { command: entry.command } : undefined);
  // Activity payloads carry their arguments under `input`; devices and typed
  // items hand over the arguments themselves, which the parser must be told.
  let plainArguments = deviceOperation !== null;
  if (deviceOperation?.kind === "call") {
    semanticToolName = deviceOperation.toolName;
    rawInput = deviceOperation.input;
  } else if (deviceOperation?.kind === "lookup") {
    semanticToolName = deviceOperation.toolName;
    rawInput = {};
  } else if (projected !== undefined) {
    plainArguments = true;
    switch (projected.type) {
      case "command_execution":
        semanticToolName = "command_execution";
        rawInput = { command: projected.input };
        break;
      case "file_change":
        semanticToolName = "file_change";
        rawInput = { path: projected.fileName };
        break;
      case "file_search":
        semanticToolName = "file_search";
        rawInput = { pattern: projected.pattern };
        break;
      case "web_search":
        semanticToolName = "web_search";
        rawInput = { patterns: projected.patterns };
        break;
      case "dynamic_tool":
        semanticToolName = projected.toolName ?? "tool";
        rawInput = projected.input;
        break;
      case "subagent":
        semanticToolName = "task";
        rawInput = { task: projected.prompt };
        break;
      default:
        plainArguments = false;
        break;
    }
  }
  const presentation = parseActivityToolPresentation(
    semanticToolName,
    plainArguments ? { input: rawInput } : rawInput,
  );
  const toolName = toolLabel || presentation.toolName;
  // Adapters lift the agent's own description onto commands and edits, whose
  // typed fields keep no arguments; an intent that only restates the tool says nothing.
  const intent =
    projected?.type === "command_execution" ||
    projected?.type === "file_change" ||
    projected?.type === "dynamic_tool"
      ? (projected.intent ?? presentation.intent)
      : presentation.intent;
  return {
    ...presentation,
    toolName,
    intent:
      intent?.replace(/[\s_-]+/g, "").toLowerCase() ===
      toolName.replace(/[\s_-]+/g, "").toLowerCase()
        ? undefined
        : intent,
    codeCell: codeCellKind(semanticToolName, rawInput),
  };
}

export function workEntryToolState(
  item: OrchestrationV2TurnItem | undefined,
  entry: ToolWorkEntryCardEntry,
  failed: boolean,
): string | null {
  switch (item?.status) {
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return failed ? "Failed" : "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    default:
      if (failed || entry.toolLifecycleStatus === "failed") return "Failed";
      if (entry.toolLifecycleStatus === "declined") return "Declined";
      if (entry.toolLifecycleStatus === "stopped") return "Stopped";
      if (entry.toolLifecycleStatus === "completed") return "Completed";
      return null;
  }
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  rb: "ruby",
  php: "php",
  java: "java",
  c: "c",
  cpp: "cpp",
  swift: "swift",
};

export function detectToolLanguage(
  item: OrchestrationV2TurnItem | undefined,
  entry: ToolWorkEntryCardEntry,
  targetPath?: string | null,
): string | undefined {
  if (item?.type === "dynamic_tool") {
    const input = asRecord(item.input);
    if (typeof input?.language === "string" && input.language.trim().length > 0) {
      return input.language.trim();
    }
    if (typeof input?.lang === "string" && input.lang.trim().length > 0) {
      return input.lang.trim();
    }
    if (item.toolName && item.toolName.toLowerCase() in EXTENSION_LANGUAGE_MAP) {
      return EXTENSION_LANGUAGE_MAP[item.toolName.toLowerCase()];
    }
    if (item.toolName === "javascript" || item.toolName === "python") {
      return item.toolName;
    }
  }
  if (item?.type === "command_execution") {
    return "bash";
  }
  if (targetPath) {
    const filename = targetPath.split(/[\\/]/).pop() ?? "";
    const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : undefined;
    if (ext && ext in EXTENSION_LANGUAGE_MAP) {
      return EXTENSION_LANGUAGE_MAP[ext];
    }
  }
  const label = entry.label?.toLowerCase();
  if (label === "javascript" || label === "python" || label === "bash") {
    return label;
  }
  return undefined;
}

export interface ToolWorkEntryCompactSummaryData {
  readonly toolName: string;
  readonly family: ActivityToolFamily;
  readonly isWebSearch: boolean;
  readonly intent: string | undefined;
  readonly target: string | undefined;
  readonly language: string | undefined;
  readonly verb: string;
  readonly object: string;
  readonly objectIsPath: boolean;
  readonly isQueued: boolean;
  readonly isRunning: boolean;
  readonly isNoMatch: boolean;
  /** Edit size from typed counts; null for non-edits and failed edits. */
  readonly diffStats: DiffStats | null;
  readonly stateSummary: string | null;
  readonly stateLabel: string | null;
  readonly exitCode: number | undefined;
  readonly failed: boolean;
  readonly failureSnippet: string | null;
  readonly subagentLiveContent: OrchestrationV2SubagentLiveContent | null;
}

export function resolveToolWorkEntryCompactSummary(input: {
  readonly entry: ToolWorkEntryCardEntry;
  readonly workspaceRoot?: string | undefined;
  readonly threadTargetTitle?: string | undefined;
  readonly subagentLiveContent?: OrchestrationV2SubagentLiveContent | null | undefined;
}): ToolWorkEntryCompactSummaryData {
  const { entry } = input;
  const projected = entry.projectedItem?.item;
  const nativeItem = projected ?? entry.structuredPayload;
  const deviceOperation = workEntryDeviceOperation(nativeItem);
  const presentation = workEntryPresentation(entry);
  const intent = presentation.intent;
  const nativeToolName =
    deviceOperation?.kind === "call"
      ? deviceOperation.toolName
      : nativeItem?.type === "dynamic_tool"
        ? (nativeItem.toolName ?? nativeItem.title ?? presentation.toolName)
        : presentation.toolName;
  const t3ThreadToolDefinition =
    deviceOperation?.kind === "call"
      ? resolveT3McpThreadTargetDefinition(deviceOperation.toolName)
      : nativeItem?.type === "dynamic_tool" && nativeItem.toolName !== null
        ? resolveT3McpThreadTargetDefinition(nativeItem.toolName)
        : null;
  const dynamicInput =
    deviceOperation?.kind === "call"
      ? asRecord(deviceOperation.input)
      : nativeItem?.type === "dynamic_tool"
        ? asRecord(nativeItem.input)
        : null;
  const isDelegateTask =
    resolveT3McpToolDefinition(nativeToolName)?.summaryAction === "delegate";
  const taskTitle =
    typeof dynamicInput?.title === "string" ? dynamicInput.title.trim() || undefined : undefined;
  const taskFirstLine =
    typeof dynamicInput?.task === "string"
      ? dynamicInput.task.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
      : undefined;
  const delegateTarget = asRecord(dynamicInput?.target);
  const delegateTaskTarget =
    taskTitle ??
    taskFirstLine ??
    (typeof delegateTarget?.model === "string" ? delegateTarget.model.trim() : undefined) ??
    (typeof delegateTarget?.driverKind === "string"
      ? delegateTarget.driverKind.trim()
      : undefined) ??
    (typeof delegateTarget?.providerInstanceId === "string"
      ? delegateTarget.providerInstanceId.trim()
      : undefined);
  const hasThreadId =
    typeof dynamicInput?.threadId === "string" && dynamicInput.threadId.trim().length > 0;
  const threadTarget =
    t3ThreadToolDefinition !== null && hasThreadId
      ? input.threadTargetTitle?.trim() || "a thread"
      : undefined;
  const isWebSearch =
    nativeItem?.type === "web_search" ||
    WEB_SEARCH_TOOL_NAMES[nativeToolName.trim().toLowerCase()] === true;

  let target: string | undefined = presentation.summary;
  let targetPathForLanguage: string | null = null;
  if (deviceOperation === null && entry.changedFiles && entry.changedFiles.length > 0) {
    const [firstPath] = entry.changedFiles;
    if (firstPath) {
      targetPathForLanguage = firstPath;
      const displayPath = formatWorkspaceRelativePath(firstPath, input.workspaceRoot);
      target =
        entry.changedFiles.length === 1
          ? displayPath
          : `${displayPath} +${entry.changedFiles.length - 1} more`;
    }
  } else if (deviceOperation === null && presentation.summary) {
    targetPathForLanguage = presentation.summary;
  }

  const language = detectToolLanguage(nativeItem, entry, targetPathForLanguage);
  const failed = workEntryDisplayIndicatesToolFailure(entry);
  const subagentLiveContent =
    input.subagentLiveContent !== undefined
      ? input.subagentLiveContent
      : projected?.type === "subagent" && projected.liveContent
        ? projected.liveContent
        : null;
  const nativeState = workEntryToolState(nativeItem, entry, failed);
  const stateLabel =
    nativeItem?.status === "running" &&
    nativeItem.startedAt !== null &&
    subagentLiveContent !== null
      ? subagentLiveContent.kind === "reasoning"
        ? "Thinking"
        : subagentLiveContent.kind === "tool"
          ? "Tool"
          : "Responding"
      : nativeState;
  const exitCode = nativeItem?.type === "command_execution" ? nativeItem.exitCode : undefined;
  const stateSummary =
    stateLabel === null
      ? exitCode === undefined
        ? null
        : `Exit ${exitCode}`
      : `${stateLabel}${exitCode === undefined ? "" : ` · exit ${exitCode}`}`;

  const failureSnippet = failed
    ? ((entry.detail?.trim() ||
        (nativeItem?.type === "command_execution" ? nativeItem.output?.trim() : null) ||
        (nativeItem?.type === "dynamic_tool" && typeof nativeItem.output === "string"
          ? nativeItem.output.trim()
          : null)) ??
      null)
    : null;

  // Arguments still streaming: the tool has not started, so it reads "Queued".
  const isQueued = nativeItem?.status === "pending";
  const isRunning =
    !isQueued && (nativeItem?.status === "running" || entry.toolLifecycleStatus === "inProgress");
  const verbObj = deriveToolVerbObject({
    toolName:
      deviceOperation?.kind === "call"
        ? deviceOperation.toolName
        : nativeItem?.type === "command_execution"
          ? "bash"
          : nativeItem?.type === "file_change"
            ? nativeItem.title === "write"
              ? "write"
              : "edit"
            : nativeItem?.type === "dynamic_tool"
              ? (nativeItem.toolName ?? presentation.toolName)
              : (entry.toolTitle ?? entry.label),
    args:
      deviceOperation?.kind === "call"
        ? deviceOperation.input
        : nativeItem?.type === "command_execution"
          ? { command: nativeItem.input }
          : nativeItem?.type === "file_change"
            ? { path: nativeItem.fileName }
            : nativeItem?.type === "dynamic_tool"
              ? nativeItem.input
              : (entry.toolData ?? (entry.command ? { command: entry.command } : undefined)),
    running: isRunning,
    result: nativeItem?.type === "dynamic_tool" ? nativeItem : undefined,
    displayName:
      deviceOperation?.kind === "call" ||
      (nativeItem?.type === "dynamic_tool" && nativeItem.toolName !== presentation.toolName)
        ? presentation.toolName
        : undefined,
  });
  const intentCandidate = verbObj.intent ?? intent;
  const repeatsLabel =
    intentCandidate !== undefined &&
    (intentCandidate.trim() === presentation.toolName.trim() ||
      intentCandidate.trim() === entry.label.trim() ||
      intentCandidate.trim() === entry.toolTitle?.trim() ||
      intentCandidate.trim() === entry.detail?.trim());
  const displayIntent = isDelegateTask && repeatsLabel ? undefined : intentCandidate;
  const objectRepeatsLabel =
    verbObj.object.trim() === presentation.toolName.trim() ||
    verbObj.object.trim() === entry.label.trim() ||
    verbObj.object.trim() === entry.toolTitle?.trim() ||
    verbObj.object.trim() === entry.detail?.trim();
  const displayObject =
    isDelegateTask && (objectRepeatsLabel || verbObj.object.trim().length === 0)
      ? (delegateTaskTarget ?? target ?? presentation.toolName)
      : (verbObj.object || target || presentation.toolName);
  const threadDetailSuffix =
    t3ThreadToolDefinition?.labels[3].endsWith("a T3 thread") === true ? " a T3 thread" : "";
  const threadVerb =
    threadTarget !== undefined &&
    threadDetailSuffix.length > 1 &&
    verbObj.verb.endsWith(threadDetailSuffix)
      ? verbObj.verb.slice(0, -threadDetailSuffix.length)
      : verbObj.verb;

  const webSearchQuery =
    nativeItem?.type === "web_search"
      ? nativeItem.patterns?.join(", ").trim()
      : typeof dynamicInput?.query === "string" && dynamicInput.query.trim()
        ? dynamicInput.query.trim()
        : Array.isArray(dynamicInput?.patterns) &&
            typeof dynamicInput.patterns[0] === "string" &&
            dynamicInput.patterns[0].trim()
          ? dynamicInput.patterns[0].trim()
          : undefined;
  const searchObject = webSearchQuery ?? (verbObj.object === "the web" ? "" : verbObj.object);

  return {
    toolName: presentation.toolName,
    family: presentation.family,
    isWebSearch,
    intent: displayIntent,
    target,
    language,
    verb: isQueued
      ? "Queued"
      : isWebSearch
        ? isRunning
          ? "Searching the web"
          : "Searched the web"
        : threadVerb,
    object: isWebSearch ? searchObject : (threadTarget ?? displayObject),
    objectIsPath: verbObj.objectIsPath,
    isQueued,
    isRunning,
    isNoMatch: verbObj.noMatch,
    diffStats: turnItemDiffStats(nativeItem),
    stateSummary,
    stateLabel,
    exitCode,
    failed: failed && !verbObj.noMatch,
    failureSnippet: verbObj.noMatch ? null : failureSnippet,
    subagentLiveContent,
  };
}
