import {
  isToolLifecycleItemType,
  type AssetResource,
  type RuntimeItemStatus,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveT3McpToolDefinition,
  type T3McpToolDefinition,
  type T3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import { parseToolDeviceArguments, parseToolDeviceName } from "@t3tools/shared/toolDevice";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { classifyToolActivity } from "@t3tools/shared/toolActivity";
import { toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";

import {
  summarizeT3ToolCalls,
  t3ToolResultIndicatesFailure,
  type T3ToolSummaryCall,
} from "@t3tools/client-runtime/t3ToolSummary";

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

/** `+n −m` with zero sides omitted; empty when nothing changed. */
export function formatDiffStats(stats: DiffStats): string {
  return [stats.added > 0 ? `+${stats.added}` : "", stats.removed > 0 ? `−${stats.removed}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** Line counts of a successful edit; the wire carries counts, not patch bodies. */
export function turnItemDiffStats(item: OrchestrationV2TurnItem | undefined): DiffStats | null {
  if (
    item?.type !== "file_change" ||
    item.status === "failed" ||
    parseToolDeviceName(item.fileName) !== undefined
  ) {
    return null;
  }
  if (item.additions === undefined && item.deletions === undefined) return null;
  return { added: item.additions ?? 0, removed: item.deletions ?? 0 };
}

/** Active and settled verb per tool; the tense is the step's status. */
const TOOL_VERBS: Record<string, readonly [active: string, settled: string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  ast_edit: ["Editing", "Edited"],
  write: ["Writing", "Wrote"],
  grep: ["Searching", "Searched"],
  rg: ["Searching", "Searched"],
  ast_grep: ["Searching", "Searched"],
  search: ["Searching", "Searched"],
  web_search: ["Searching the web for", "Searched the web for"],
  find: ["Finding", "Found"],
  glob: ["Finding", "Found"],
  ls: ["Listing", "Listed"],
  list: ["Listing", "Listed"],
  bash: ["Running", "Ran"],
  shell: ["Running", "Ran"],
  eval: ["Evaluating", "Evaluated"],
  todo: ["Updating plan", "Updated plan"],
  hub: ["Waiting for", "Waited for"],
  wait: ["Waiting for", "Waited for"],
  task: ["Delegating", "Delegated"],
  browser: ["Browsing", "Browsed"],
  fetch: ["Fetching", "Fetched"],
};

/** Verb for a tool in the tense its status implies; unknown tools read "Running x" / "Ran x". */
export function toolVerb(toolName: string, running: boolean): string {
  const verbs = TOOL_VERBS[toolName.trim().toLowerCase()];
  if (verbs) return running ? verbs[0] : verbs[1];
  return running ? `Running ${toolName}` : `Ran ${toolName}`;
}

export interface ToolVerbObject {
  readonly verb: string;
  readonly object: string;
  /** The object is a file path: render basename bold, folder muted. */
  readonly objectIsPath: boolean;
  /** The agent's own description of the step (`i`, `_i`, `description`). */
  readonly intent: string | undefined;
  /** A search that settled without results: informative, not a failure. */
  readonly noMatch: boolean;
}

export function deriveToolVerbObject(input: {
  readonly toolName: string;
  readonly args: unknown;
  readonly running: boolean;
  /** The settled result as the client sees it; decides "No matches" for searches. */
  readonly result?: SearchResultEvidence | undefined;
  /** A curated name ("Read a T3 thread") that reads better than "Ran mcp__…" for unknown tools. */
  readonly displayName?: string | undefined;
}): ToolVerbObject {
  const name = input.toolName.trim().toLowerCase();
  const args = asRecord(input.args) ?? {};
  const text = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const intent = text("i") ?? text("_i") ?? text("description");
  const deviceTool = name === "read" ? parseToolDeviceName(text("path") ?? "") : undefined;
  if (deviceTool !== undefined) {
    const displayName = resolveT3McpToolDefinition(deviceTool)?.displayName ?? deviceTool;
    return {
      verb: input.running ? "Checking usage for" : "Checked usage for",
      object: displayName,
      objectIsPath: false,
      intent: undefined,
      noMatch: false,
    };
  }
  let object: string;
  let noMatch = false;
  switch (name) {
    case "read":
    case "edit":
    case "ast_edit":
    case "write":
      object = text("path") ?? text("file_path") ?? "file";
      break;
    case "grep":
    case "rg":
    case "ast_grep":
    case "search":
    case "find":
    case "glob": {
      const pattern = text("pattern") ?? text("query") ?? "";
      const scope = text("path");
      object = scope && pattern ? `${pattern} in ${scope}` : pattern || scope || "files";
      noMatch = !input.running && input.result !== undefined && searchFoundNothing(input.result);
      break;
    }
    case "ls":
    case "list":
      object = text("path") ?? ".";
      break;
    case "bash":
    case "shell":
      object = text("command")?.split("\n")[0]?.trim() || "command";
      break;
    case "eval": {
      const language = text("language") ?? text("lang") ?? "code";
      const firstLine = text("code")
        ?.split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim();
      object = firstLine ? `${language} · ${firstLine}` : language;
      break;
    }
    case "todo": {
      const phases = Array.isArray(args.phases) ? args.phases.length : 0;
      object =
        phases > 0 ? `${phases} ${phases === 1 ? "phase" : "phases"}` : (text("op") ?? "plan");
      break;
    }
    case "hub":
    case "wait": {
      const ids = Array.isArray(args.ids) ? args.ids.length : 0;
      object = ids > 0 ? `${ids} ${ids === 1 ? "job" : "jobs"}` : "background jobs";
      break;
    }
    case "task": {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      const first = asRecord(tasks[0]);
      const label =
        (typeof first?.name === "string" && first.name) ||
        (typeof first?.task === "string" && first.task.split("\n")[0]) ||
        text("task") ||
        text("agent") ||
        "task";
      object = tasks.length > 1 ? `${label} +${tasks.length - 1}` : label;
      break;
    }
    case "web_search":
      object = text("query") ?? "the web";
      break;
    default: {
      const firstValue = Object.entries(args).find(
        ([key, value]) =>
          key !== "i" && key !== "_i" && key !== "description" && typeof value === "string",
      )?.[1];
      object = typeof firstValue === "string" ? firstValue.split("\n")[0]!.trim() : "";
    }
  }
  return {
    verb:
      TOOL_VERBS[name] === undefined && input.displayName?.trim()
        ? input.displayName.trim()
        : toolVerb(input.toolName, input.running),
    object,
    objectIsPath:
      (name === "read" || name === "edit" || name === "ast_edit" || name === "write") &&
      object !== "file",
    intent:
      intent !== undefined && intent.toLowerCase() === object.toLowerCase() ? undefined : intent,
    noMatch,
  };
}

interface SearchResultEvidence {
  readonly output?: unknown;
  readonly outputOmitted?: boolean | undefined;
  readonly details?: unknown;
}

/**
 * A settled search that found nothing. The wire withholds plain-text output, so
 * OMP's `details.matchCount`/`fileCount` decide first; local output text is the fallback.
 */
function searchFoundNothing(result: SearchResultEvidence): boolean {
  const details = asRecord(result.details);
  if (typeof details?.matchCount === "number") return details.matchCount === 0;
  if (typeof details?.fileCount === "number") return details.fileCount === 0;
  if (typeof result.output === "string") {
    const output = result.output.trim();
    return (
      output.length === 0 ||
      /^(?:no (?:matches|files|results)(?: found)?|0 matches)\b/i.test(output)
    );
  }
  return result.output === undefined && result.outputOmitted !== true;
}

/** `└ a.ts, b.ts, +4`: what an exploration burst looked at, files by basename, searches by pattern. */
export function explorationSubline(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  const seen: Record<string, true> = {};
  const targets: string[] = [];
  for (const entry of entries) {
    const item = entry.structuredPayload;
    const args = asRecord(item?.type === "dynamic_tool" ? item.input : entry.toolData) ?? {};
    const path = entry.changedFiles?.[0] ?? (typeof args.path === "string" ? args.path : undefined);
    const pattern =
      typeof args.pattern === "string"
        ? args.pattern
        : typeof args.query === "string"
          ? args.query
          : undefined;
    const target =
      toolGroupAction(entry) === "code-search" && pattern
        ? pattern.trim()
        : path
            ?.trim()
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop();
    if (!target || seen[target]) continue;
    seen[target] = true;
    targets.push(target);
  }
  if (targets.length === 0) return "";
  const shown = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `└ ${shown}, +${targets.length - 3}` : `└ ${shown}`;
}

/**
 * Which consecutive steps merge into one row: exploration, edits, or other
 * generic tools ("Used 3 tools"). Commands, eval, web search, and task
 * delegation always stand alone.
 */
export type ToolCoalesceCategory = "explore" | "edit" | "other" | "individual";

const STANDALONE_DYNAMIC_TOOLS: Record<string, true> = { eval: true, task: true, web_search: true };

export function workEntryCoalesceCategory(entry: WorkLogPresentationEntry): ToolCoalesceCategory {
  if (entry.itemType === "reasoning") return "individual";
  const action = toolGroupAction(entry);
  if (action === "read" || action === "code-search") return "explore";
  if (action === "edit" && entry.itemType === "file_change") return "edit";
  if (action === "command" || action === "search") return "individual";
  const payload = entry.structuredPayload;
  if (
    payload?.type === "dynamic_tool" &&
    STANDALONE_DYNAMIC_TOOLS[(payload.toolName ?? "").trim().toLowerCase()]
  ) {
    return "individual";
  }
  return "other";
}

/** `Worked for 39s · 14 steps · edited 3 files +120 −8` */
export function formatTurnFoldSummary(input: {
  readonly duration: string | null;
  readonly stepCount: number;
  readonly filesEdited: number;
  readonly diffStats: DiffStats;
}): string {
  const parts = [input.duration ? `Worked for ${input.duration}` : "Worked"];
  if (input.stepCount > 0) {
    parts.push(`${input.stepCount} ${input.stepCount === 1 ? "step" : "steps"}`);
  }
  if (input.filesEdited > 0) {
    const stats = formatDiffStats(input.diffStats);
    parts.push(
      `edited ${input.filesEdited} ${input.filesEdited === 1 ? "file" : "files"}${stats ? ` ${stats}` : ""}`,
    );
  }
  return parts.join(" · ");
}

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

/** Inspection and copying omit raw outputs, including values from older caches. */
export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

export function contextCompactionLabel(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
    "status" | "beforeTokenCount" | "afterTokenCount"
  >,
): string {
  if (item.status === "running") return "Compacting context";
  if (item.beforeTokenCount !== undefined && item.afterTokenCount !== undefined) {
    return `Context compacted ${formatTokens(item.beforeTokenCount)} → ${formatTokens(item.afterTokenCount)} tokens`;
  }
  return "Context compacted";
}

export interface WorkLogPresentationEntry {
  readonly questionAnswer?: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "read"
  | "edit"
  | "command"
  | "thread-create"
  | "browser"
  | "device"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | "pull-request"
  | ToolGroupAction
  | "dynamic-tool"
  | "reasoning"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/** Structured identity is authoritative, including when it identifies a foreign server. */
function workEntryToolName(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "structuredPayload">,
): string | undefined {
  const item = entry.structuredPayload;
  const deviceOperation = workEntryDeviceOperation(item);
  if (deviceOperation?.kind === "call") return deviceOperation.toolName;
  if (item?.type === "dynamic_tool" && item.toolName) return item.toolName;
  const data = asRecord(entry.toolData);
  if (typeof data?.server === "string" && typeof data.tool === "string") {
    return `${data.server}.${data.tool}`;
  }
  if (typeof data?.toolName === "string") return data.toolName;
  return resolveT3McpToolDefinition(entry.toolTitle) ? entry.toolTitle : entry.label;
}

function workEntryToolOutput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.output
    : (data?.output ?? data?.result ?? data?.rawOutput ?? data?.content);
}

function workEntryToolInput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const deviceOperation = workEntryDeviceOperation(item);
  if (deviceOperation?.kind === "call") return deviceOperation.input;
  if (item?.type === "dynamic_tool") return item.input;
  const data = asRecord(entry.toolData);
  return data?.arguments ?? data?.input ?? data?.rawInput;
}

function resolveT3McpToolPresentation(
  definition: T3McpToolDefinition | null,
  status: string | undefined,
  data?: unknown,
) {
  if (!definition) return null;
  const [action, running, completed, detail] = definition.labels;
  const verb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped"
              ? `Stopped ${running.toLowerCase()}`
              : running;

  const actionKind =
    definition.summaryAction === "link-pr" ||
    definition.summaryAction === "unlink-pr" ||
    definition.summaryAction === "list-prs" ||
    definition.summaryAction === "watch-pr" ||
    definition.summaryAction === "unwatch-pr"
      ? definition.summaryAction
      : undefined;
  const payload = asRecord(data);
  const input =
    asRecord(payload?.arguments) ?? asRecord(payload?.input) ?? asRecord(payload?.rawInput);
  const urlTarget = typeof input?.url === "string" ? parseChangeRequestUrl(input.url) : null;
  const number = urlTarget?.number ?? input?.number;
  const target =
    actionKind !== undefined &&
    actionKind !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? `PR #${number}`
      : detail;
  return {
    displayName: `${verb} ${target}`,
    icon: definition.icon,
    ...(actionKind === undefined ? {} : { action: actionKind }),
  };
}

/** Only active or completed calls can inherit the live group’s present tense. */
export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

/** Resolves tool identity before choosing labels or icons in either client. */
export function resolveWorkEntryToolPresentation(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "toolLifecycleStatus" | "structuredPayload"
  >,
  fallbackStatus?: "inProgress" | "completed",
) {
  const deviceOperation = workEntryDeviceOperation(entry.structuredPayload);
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  if (deviceOperation?.kind === "lookup") {
    const definition = resolveT3McpToolDefinition(deviceOperation.toolName);
    const displayName = definition?.displayName ?? deviceOperation.toolName;
    const verb =
      status === "completed"
        ? "Checked usage for"
        : status === "failed"
          ? "Failed to check usage for"
          : status === "declined"
            ? "Declined to check usage for"
            : status === "stopped"
              ? "Stopped checking usage for"
              : "Checking usage for";
    return { displayName: `${verb} ${displayName}`, icon: definition?.icon ?? "t3-code" };
  }
  const definition = resolveT3McpToolDefinition(workEntryToolName(entry));
  const data =
    deviceOperation?.kind === "call" ? { arguments: workEntryToolInput(entry) } : entry.toolData;
  return resolveT3McpToolPresentation(
    definition,
    definition && t3ToolResultIndicatesFailure(workEntryToolOutput(entry)) ? "failed" : status,
    data,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type WorkEntryDeviceOperation =
  | { readonly kind: "call"; readonly toolName: string; readonly input: unknown }
  | { readonly kind: "lookup"; readonly toolName: string };

/** The call or usage lookup represented by an OMP tool-device turn item. */
export function workEntryDeviceOperation(
  item: OrchestrationV2TurnItem | undefined,
): WorkEntryDeviceOperation | null {
  if (item?.type === "file_change") {
    const toolName = parseToolDeviceName(item.fileName);
    return toolName === undefined
      ? null
      : { kind: "call", toolName, input: parseToolDeviceArguments(item.newStr) };
  }
  if (item?.type !== "dynamic_tool") return null;
  const args = asRecord(item.input);
  const path = typeof args?.path === "string" ? args.path : "";
  const toolName = parseToolDeviceName(path);
  if (toolName === undefined) return null;
  if (item.toolName === "read") return { kind: "lookup", toolName };
  if (item.toolName === "write") {
    return {
      kind: "call",
      toolName,
      input: parseToolDeviceArguments(
        args !== null && typeof args.content === "string" ? args.content : undefined,
      ),
    };
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) return false;
  if (
    resolveT3McpToolDefinition(workEntryToolName(entry)) &&
    t3ToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return true;
  }
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    if (item.exitCode === 1 && item.input && /^\s*(?:rg|grep)\b/.test(item.input)) {
      return false;
    }
    // The exit code outranks text in the output or the command itself.
    if (item.exitCode !== undefined) return item.exitCode !== 0;
    if (item.outputIndicatesFailure) return true;
    // Older servers/caches can still carry output. Read only the previous
    // preview-sized prefix for status, without exposing it in the row detail.
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  // A search that found nothing settled normally; "No matches" is its answer.
  if (
    item?.type === "dynamic_tool" &&
    /^(?:grep|rg|ast_grep|search|find|glob)$/i.test(item.toolName ?? "") &&
    searchFoundNothing(item)
  ) {
    return false;
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

/** Includes legacy activities that stored error output in the command field. */
export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's command as an error. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/** Decides whether the row can show a success marker. */
export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "idle" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

export function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  const title = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  return (
    entry.itemType === "file_search" ||
    (entry.itemType === "web_search" &&
      /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))) ||
    (entry.itemType === "dynamic_tool" && /^(?:grep|glob|find[-\s]+files)$/i.test(title))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.itemType === "thread_created") return "thread-create";
  const deviceOperation = workEntryDeviceOperation(entry.structuredPayload);
  if (deviceOperation?.kind === "lookup") return "other";
  if (deviceOperation?.kind === "call") {
    const devicePresentation = resolveWorkEntryToolPresentation(entry);
    if (devicePresentation?.action !== undefined) return devicePresentation.action;
    if (devicePresentation?.icon === "browser") return "browser";
    if (devicePresentation?.icon === "device") return "device";
    return "other";
  }
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (entry.requestKind === "file-read" || entry.viewedImagePath !== undefined) return "read";
  // Approvals and questions describe requested work, not work that ran.
  if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
    return workLogEntryIsToolLike(entry) ? "other" : "update";
  }
  const data = asRecord(entry.toolData) ?? {};
  const toolName =
    entry.structuredPayload?.type === "dynamic_tool"
      ? entry.structuredPayload.toolName
      : typeof data.toolName === "string"
        ? data.toolName
        : entry.toolTitle;
  const classified = classifyToolActivity({
    itemType:
      entry.itemType === "command_execution" ||
      entry.itemType === "file_change" ||
      entry.itemType === "web_search"
        ? entry.itemType
        : entry.itemType === "dynamic_tool"
          ? "dynamic_tool_call"
          : undefined,
    title: entry.toolTitle ?? entry.label,
    data: {
      ...data,
      ...(toolName ? { toolName } : {}),
    },
  });
  if (classified === "read") return "read";
  if (
    classified === "file_change" ||
    entry.itemType === "file_change" ||
    entry.requestKind === "file-change" ||
    (entry.changedFiles?.length ?? 0) > 0
  )
    return "edit";
  if (
    classified === "command" ||
    entry.itemType === "command_execution" ||
    entry.requestKind === "command" ||
    entry.command
  ) {
    return "command";
  }
  if (classified === "search") {
    return entry.itemType === "web_search" && !workLogEntryIsLocalCodeSearch(entry)
      ? "search"
      : "code-search";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  // A relative path with no known workspace still names a media-file relative
  // to the thread's workspace, so classify against "." and drop the prefix.
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of entry.changedFiles) changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "link-pr":
      return `Linked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unlink-pr":
      return `Unlinked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "watch-pr":
      return `Watching ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unwatch-pr":
      return `Stopped watching ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "list-prs":
      return count === 1
        ? "Checked linked pull requests"
        : `Checked linked pull requests ${count} times`;
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Edited ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "thread-create":
      return `Created ${count} ${count === 1 ? "thread" : "threads"}`;
    case "device":
      return `Used device controls ${count} ${count === 1 ? "time" : "times"}`;
    case "browser":
      return `Used browser ${count} ${count === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

function t3ToolSummaryCall(entry: WorkLogPresentationEntry): T3ToolSummaryCall {
  return {
    input: workEntryToolInput(entry),
    output: workEntryToolOutput(entry),
    outcome:
      entry.toolLifecycleStatus === "failed" ||
      entry.toolLifecycleStatus === "declined" ||
      entry.tone === "error"
        ? "failed"
        : entry.toolLifecycleStatus === "completed"
          ? "completed"
          : "unfinished",
  };
}

function summaryActionPriority(action: ToolGroupAction | T3McpToolSummaryAction): number {
  switch (action) {
    case "command":
    case "edit":
    case "delegate":
    case "task-cancel":
    case "thread-create":
    case "thread-send":
    case "thread-interrupt":
    case "schedule-create":
    case "schedule-update":
    case "schedule-delete":
    case "schedule-run":
    case "thread-configure":
    case "thread-fork":
    case "thread-merge":
    case "thread-organize":
    case "thread-update":
    case "queue-edit":
    case "queue-cancel":
    case "queue-reorder":
    case "queue-steer":
    case "question-respond":
    case "worktree-handoff":
    case "project-create":
    case "project-update":
    case "project-delete":
    case "project-clone":
    case "environment-update":
    case "attachment-prepare":
    case "attachment-discard":
    case "attachment-send":
      return 0;
    case "other":
    case "update":
      return 2;
    default:
      return 1;
  }
}

/**
 * Summarizes at most two action categories; every omitted call still counts in
 * the remainder. An edit summary ends in its `+n −m`, also given as `diffStats`
 * for renderers that style the counts.
 */
export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): {
  summary: string;
  hasFailure: boolean;
  diffStats?: DiffStats;
} {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }
  entries = toolEntries;
  const isExploration =
    entries.length > 0 &&
    entries.every((e) => {
      const a = toolGroupAction(e);
      return a === "read" || a === "code-search";
    });
  if (isExploration) {
    const readCount = entries.filter((e) => toolGroupAction(e) === "read").length;
    const searchCount = entries.filter((e) => toolGroupAction(e) === "code-search").length;
    const parts: string[] = [];
    if (readCount > 0) parts.push(`${readCount} ${readCount === 1 ? "file" : "files"}`);
    if (searchCount > 0) parts.push(`${searchCount} ${searchCount === 1 ? "search" : "searches"}`);
    const isLive = entries.some((e) => e.toolLifecycleStatus === "inProgress");
    const prefix = isLive ? "Exploring" : "Explored";
    return {
      summary: `${prefix} ${parts.join(", ")}`,
      hasFailure: entries.some(workEntryDisplayIndicatesToolFailure),
    };
  }
  const isEdit = entries.length > 0 && entries.every((e) => toolGroupAction(e) === "edit");
  if (isEdit) {
    const fileCount = toolGroupActionCount("edit", entries);
    let added = 0;
    let removed = 0;
    for (const entry of entries) {
      const stats = turnItemDiffStats(entry.structuredPayload);
      added += stats?.added ?? 0;
      removed += stats?.removed ?? 0;
    }
    const statText = formatDiffStats({ added, removed });
    const live = entries.some((entry) => entry.toolLifecycleStatus === "inProgress");
    return {
      summary: `${live ? "Editing" : "Edited"} ${fileCount} ${fileCount === 1 ? "file" : "files"}${statText ? ` ${statText}` : ""}`,
      hasFailure: entries.some(workEntryDisplayIndicatesToolFailure),
      diffStats: { added, removed },
    };
  }
  const isCommand = entries.length > 0 && entries.every((e) => toolGroupAction(e) === "command");
  if (isCommand) {
    const count = entries.length;
    const isLive = entries.some((e) => e.toolLifecycleStatus === "inProgress");
    const prefix = isLive ? "Running" : "Ran";
    return {
      summary: `${prefix} ${count} ${count === 1 ? "command" : "commands"}`,
      hasFailure: entries.some(workEntryDisplayIndicatesToolFailure),
    };
  }
  const groups = new Map<
    ToolGroupAction | T3McpToolSummaryAction,
    {
      action: ToolGroupAction;
      t3Action: T3McpToolSummaryAction | null;
      entries: WorkLogPresentationEntry[];
    }
  >();
  const sources = new Map<string, ToolActivitySource>();
  for (const entry of entries) {
    const t3Action = resolveT3McpToolDefinition(workEntryToolName(entry))?.summaryAction ?? null;
    if (entry.toolSource && t3Action === null) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const key = t3Action ?? action;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { action, t3Action, entries: [entry] });
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.entries.length,
    priority: summaryActionPriority(action),
    ...(group.t3Action
      ? summarizeT3ToolCalls(group.t3Action, group.entries.map(t3ToolSummaryCall))
      : {
          label: toolGroupActionLabel(
            group.action,
            toolGroupActionCount(group.action, group.entries),
          ),
          failedCount: group.entries.filter(workEntryDisplayIndicatesToolFailure).length,
        }),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = sourceValues.map((source) => source.name);
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join(" and ")
          : `${sourceNames.slice(0, -1).join(", ")}, and ${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sources.size === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sourcedCount = entries.filter(
    (entry) =>
      entry.toolSource !== undefined &&
      resolveT3McpToolDefinition(workEntryToolName(entry)) === null,
  ).length;
  const remainingCount =
    entries.length - sourcedCount - selected.reduce((count, group) => count + group.count, 0);
  if (remainingCount > 0) {
    labels.push(`Performed ${remainingCount} other ${remainingCount === 1 ? "action" : "actions"}`);
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    sentenceLabels.length < 3
      ? sentenceLabels.join(" and ")
      : `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
  return { summary, hasFailure: summaries.some((group) => group.failedCount > 0) };
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "reasoning";
  entries = toolEntries;
  if (
    entries.length > 0 &&
    entries.every((entry) => resolveWorkEntryToolPresentation(entry)?.icon === "pull-request")
  )
    return "pull-request";
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = actions.values().next().value!;
  if (action !== "other") return action;
  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (
        entry.itemType === "dynamic_tool" ||
        workEntryDeviceOperation(entry.structuredPayload)?.kind === "call"
      ) {
        return "dynamic-tool";
      }
      if (entry.itemType === "subagent") return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

/**
 * Plain-text line for the latest thought in the live activity row. A
 * bold-only opening line (the Codex summary heading) wins; otherwise this is
 * the first sentence of the reasoning text. Web and mobile both render it.
 */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  // Cut after the first . ? or ! (plus a closing quote or paren) that a space follows.
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
