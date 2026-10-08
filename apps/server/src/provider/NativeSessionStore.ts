// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
/**
 * Reads and annotates Pi and OMP session files on disk. Both runtimes keep one
 * JSONL file per session: a `session` header, then entries linked by
 * `id`/`parentId` into a tree whose last entry is the active leaf. OMP also
 * reserves a fixed-width `title` slot as the first line, rewritten in place.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type {
  ProviderInstanceId,
  ProviderNativeSessionRuntime,
  ProviderNativeSessionStatus,
  ProviderNativeSessionSummary,
} from "@t3tools/contracts";

const SESSION_PREFIX_BYTES = 16 * 1024;
const SESSION_SUFFIX_BYTES = 32 * 1024;
const MAX_SESSION_FILES = 2_000;
const READ_CONCURRENCY = 16;
/** OMP's first-line title slot is exactly this many UTF-8 bytes, newline included. */
export const OMP_TITLE_SLOT_BYTES = 256;

export interface NativeSessionLocation {
  readonly runtime: ProviderNativeSessionRuntime;
  /** Base for relative directories in launch arguments and the environment. */
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly launchArguments: ReadonlyArray<string>;
}

export interface NativeSessionFile {
  readonly filePath: string;
  readonly summary: ProviderNativeSessionSummary;
}

export type NativeHistoryMessage =
  | {
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly createdAt: string;
    }
  | {
      readonly role: "reasoning";
      readonly text: string;
      readonly createdAt: string;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      /** Absent while the call has no recorded result. */
      readonly result:
        | {
            readonly outputText: string;
            readonly details: unknown;
            readonly isError: boolean;
            readonly completedAt: string;
          }
        | undefined;
      readonly createdAt: string;
    };

interface SessionHeader {
  readonly id: string;
  readonly cwd: string;
  readonly slotTitle: string | undefined;
  readonly headerTitle: string | undefined;
  readonly timestamp: string | undefined;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function parseRecord(line: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function argumentValue(args: ReadonlyArray<string>, name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function resolveIn(location: NativeSessionLocation, directory: string): string {
  return NodePath.isAbsolute(directory) ? directory : NodePath.resolve(location.cwd, directory);
}

/** The harness agent directory (`config.yml`, `agent.db`, default `sessions/`). */
export function resolveNativeAgentDirectory(location: NativeSessionLocation): string {
  const agentDirectory = location.environment.PI_CODING_AGENT_DIR;
  if (agentDirectory !== undefined && agentDirectory.length > 0) {
    return resolveIn(location, agentDirectory);
  }
  const configuredHome = location.environment.HOME;
  const home =
    configuredHome === undefined || configuredHome.length === 0
      ? NodeOS.homedir()
      : resolveIn(location, configuredHome);
  if (location.runtime === "pi") return NodePath.join(home, ".pi", "agent");
  const profile =
    argumentValue(location.launchArguments, "--profile") ??
    location.environment.OMP_PROFILE ??
    location.environment.PI_PROFILE;
  return profile !== undefined && profile.length > 0
    ? NodePath.join(home, ".omp", "profiles", profile, "agent")
    : NodePath.join(home, ".omp", "agent");
}

export function resolveNativeSessionDirectory(location: NativeSessionLocation): string {
  const explicit =
    argumentValue(location.launchArguments, "--session-dir") ??
    location.environment.PI_CODING_AGENT_SESSION_DIR;
  if (explicit !== undefined && explicit.length > 0) return resolveIn(location, explicit);
  return NodePath.join(resolveNativeAgentDirectory(location), "sessions");
}

function parseSessionHeader(prefix: string): SessionHeader | undefined {
  let slotTitle: string | undefined;
  for (const rawLine of prefix.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const record = parseRecord(line);
    if (record === undefined) return undefined;
    if (record.type === "title") {
      slotTitle = nonEmpty(record.title);
      continue;
    }
    const id = nonEmpty(record.id);
    const cwd = nonEmpty(record.cwd);
    if (record.type !== "session" || id === undefined || cwd === undefined) return undefined;
    return {
      id,
      cwd,
      slotTitle,
      headerTitle: nonEmpty(record.title),
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    };
  }
  return undefined;
}

function contentText(content: unknown, includeReasoning: boolean): string | undefined {
  if (typeof content === "string") return nonEmpty(content);
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    const text =
      record?.type === "text"
        ? record.text
        : includeReasoning && record?.type === "thinking"
          ? record.thinking
          : undefined;
    if (typeof text === "string" && text.trim().length > 0) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function firstUserPrompt(prefix: string): string | undefined {
  for (const rawLine of prefix.split(/\r?\n/u)) {
    const record = parseRecord(rawLine);
    const message = asRecord(record?.message);
    if (record?.type !== "message" || message?.role !== "user") continue;
    const text = contentText(message.content, false)?.replace(/\s+/gu, " ");
    if (text !== undefined) return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }
  return undefined;
}

function sessionStatus(message: JsonRecord): ProviderNativeSessionStatus {
  if (message.role === "user") return "pending";
  if (message.role === "toolResult") return "interrupted";
  if (message.role !== "assistant") return "unknown";
  if (message.stopReason === "error") return "error";
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "length") return "interrupted";
  const endsInToolCall =
    Array.isArray(message.content) &&
    message.content.some((block) => asRecord(block)?.type === "toolCall");
  return endsInToolCall ? "interrupted" : "complete";
}

/** Latest title, model, and status recorded in a session's tail window. */
function scanSuffix(suffix: string): {
  readonly title: string | undefined;
  readonly model: string | undefined;
  readonly status: ProviderNativeSessionStatus;
} {
  let title: string | undefined;
  let model: string | undefined;
  let status: ProviderNativeSessionStatus = "unknown";
  for (const rawLine of suffix.split(/\r?\n/u)) {
    const record = parseRecord(rawLine.trim());
    if (record === undefined) continue;
    const renamed =
      record.type === "session_info"
        ? nonEmpty(record.name)
        : record.type === "title_change"
          ? nonEmpty(record.title)
          : undefined;
    if (renamed !== undefined) title = renamed;
    const message = asRecord(record.message);
    const modelId =
      record.type === "model_change"
        ? nonEmpty(record.modelId ?? record.model)
        : record.type === "message"
          ? nonEmpty(message?.model)
          : undefined;
    if (modelId !== undefined) {
      const provider = nonEmpty(
        record.type === "model_change" ? record.provider : message?.provider,
      );
      model = provider !== undefined && !modelId.includes("/") ? `${provider}/${modelId}` : modelId;
    }
    if (record.type === "message" && message !== undefined) status = sessionStatus(message);
  }
  return { title, model, status };
}

export async function readNativeSessionFile(
  filePath: string,
  providerInstanceId: ProviderInstanceId,
  runtime: ProviderNativeSessionRuntime,
): Promise<NativeSessionFile | undefined> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const prefixLength = Math.min(stat.size, SESSION_PREFIX_BYTES);
    const suffixLength = Math.min(stat.size, SESSION_SUFFIX_BYTES);
    const prefix = Buffer.allocUnsafe(prefixLength);
    const suffix = Buffer.allocUnsafe(suffixLength);
    await handle.read(prefix, 0, prefixLength, 0);
    await handle.read(suffix, 0, suffixLength, stat.size - suffixLength);
    const prefixText = prefix.toString("utf8");
    const header = parseSessionHeader(prefixText);
    if (header === undefined) return undefined;
    const createdAt =
      isoTimestamp(header.timestamp) ??
      isoTimestamp(stat.birthtimeMs) ??
      isoTimestamp(stat.ctimeMs);
    const updatedAt = isoTimestamp(stat.mtimeMs);
    if (createdAt === undefined || updatedAt === undefined) return undefined;
    // The tail window may start mid-line; scanSuffix skips the unparsable fragment.
    const tail = scanSuffix(suffix.toString("utf8"));
    return {
      filePath,
      summary: {
        providerInstanceId,
        runtime,
        sessionId: header.id,
        cwd: header.cwd,
        // OMP's slot always holds the current title; older title_change
        // entries can still sit in the tail window.
        title:
          header.slotTitle ??
          tail.title ??
          header.headerTitle ??
          firstUserPrompt(prefixText) ??
          "Untitled session",
        ...(tail.model === undefined ? {} : { model: tail.model }),
        createdAt,
        updatedAt,
        status: tail.status,
      },
    };
  } finally {
    await handle.close();
  }
}

function sessionFileNames(entries: ReadonlyArray<NodeFS.Dirent>): Record<string, true> {
  const names: Record<string, true> = {};
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) names[entry.name] = true;
  }
  return names;
}

/**
 * Session files live in `<root>/<cwd-slug>/<file>.jsonl`, or directly in an
 * explicit `--session-dir`. OMP keeps a session's subagent transcripts in a
 * sibling directory named after the session file, which is never a session.
 */
async function discoverSessionFiles(root: string): Promise<ReadonlyArray<string>> {
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = await NodeFSP.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (asRecord(error)?.code === "ENOENT") return [];
    throw error;
  }
  const rootSessions = sessionFileNames(entries);
  const files = Object.keys(rootSessions).map((name) => NodePath.join(root, name));
  for (const entry of entries) {
    if (files.length >= MAX_SESSION_FILES) break;
    if (!entry.isDirectory() || rootSessions[`${entry.name}.jsonl`]) continue;
    const directory = NodePath.join(root, entry.name);
    const children = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const name of Object.keys(sessionFileNames(children))) {
      files.push(NodePath.join(directory, name));
    }
  }
  return files.slice(0, MAX_SESSION_FILES);
}

/** Newest file first per session id; unreadable or headerless files are skipped. */
export async function listNativeSessionFiles(
  location: NativeSessionLocation,
  providerInstanceId: ProviderInstanceId,
): Promise<ReadonlyArray<NativeSessionFile>> {
  const paths = await discoverSessionFiles(resolveNativeSessionDirectory(location));
  const sessions: Array<NativeSessionFile | undefined> = [];
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const index = next;
      next += 1;
      sessions[index] = await readNativeSessionFile(
        paths[index]!,
        providerInstanceId,
        location.runtime,
      )
        // A file can vanish or be mid-write between readdir and open.
        .catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  const seen: Record<string, true> = {};
  return sessions
    .filter((session): session is NativeSessionFile => session !== undefined)
    .sort(
      (left, right) =>
        right.summary.updatedAt.localeCompare(left.summary.updatedAt) ||
        left.filePath.localeCompare(right.filePath),
    )
    .filter((session) => {
      if (seen[session.summary.sessionId]) return false;
      seen[session.summary.sessionId] = true;
      return true;
    });
}

async function readTree(filePath: string): Promise<{
  readonly nodes: Record<string, { readonly parentId: string | null; readonly record: JsonRecord }>;
  readonly leafId: string | undefined;
}> {
  const nodes: Record<string, { readonly parentId: string | null; readonly record: JsonRecord }> =
    {};
  let leafId: string | undefined;
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    const record = parseRecord(line);
    // The session header's id names the session, not a tree entry.
    if (record === undefined || typeof record.id !== "string" || record.type === "session") {
      continue;
    }
    nodes[record.id] = {
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      record,
    };
    leafId = record.id;
  }
  return { nodes, leafId };
}

/**
 * The active branch, oldest first: prompts, then each assistant message's
 * thinking, text, and tool calls in content order. Tool results attach to
 * their call.
 */
export async function readNativeHistory(
  filePath: string,
): Promise<ReadonlyArray<NativeHistoryMessage>> {
  const { nodes, leafId } = await readTree(filePath);
  const branch: JsonRecord[] = [];
  const visited: Record<string, true> = {};
  let cursor = leafId;
  while (cursor !== undefined && visited[cursor] === undefined) {
    visited[cursor] = true;
    const node = nodes[cursor];
    if (node === undefined) break;
    branch.push(node.record);
    cursor = node.parentId ?? undefined;
  }
  branch.reverse();
  const history: NativeHistoryMessage[] = [];
  const toolIndexes: Record<string, number> = {};
  for (const record of branch) {
    const message = asRecord(record.message);
    const createdAt = isoTimestamp(record.timestamp ?? message?.timestamp);
    if (record.type !== "message" || message === undefined || createdAt === undefined) continue;
    if (message.role === "user") {
      const text = contentText(message.content, false);
      if (text !== undefined) history.push({ role: "user", text, createdAt });
      continue;
    }
    if (message.role === "toolResult") {
      const toolCallId = nonEmpty(message.toolCallId);
      const index = toolCallId === undefined ? undefined : toolIndexes[toolCallId];
      const call = index === undefined ? undefined : history[index];
      if (index === undefined || call?.role !== "tool") continue;
      history[index] = {
        ...call,
        result: {
          outputText: contentText(message.content, false) ?? "",
          details: message.details,
          isError: message.isError === true,
          completedAt: createdAt,
        },
      };
      continue;
    }
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      const text = nonEmpty(message.content);
      if (text !== undefined) history.push({ role: "assistant", text, createdAt });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const content of message.content) {
      const block = asRecord(content);
      const text =
        block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : null;
      if (typeof text === "string") {
        if (text.trim().length === 0) continue;
        const role = block?.type === "thinking" ? "reasoning" : "assistant";
        const previous = history.at(-1);
        // Adjacent blocks of one kind read as one message.
        if (previous?.role === role && previous.createdAt === createdAt) {
          history[history.length - 1] = { ...previous, text: `${previous.text}\n\n${text}` };
        } else {
          history.push({ role, text, createdAt });
        }
        continue;
      }
      const toolCallId = block?.type === "toolCall" ? nonEmpty(block.id) : undefined;
      if (block === undefined || toolCallId === undefined) continue;
      toolIndexes[toolCallId] = history.length;
      history.push({
        role: "tool",
        toolCallId,
        toolName: nonEmpty(block.name) ?? "tool",
        args: block.arguments,
        result: undefined,
        createdAt,
      });
    }
  }
  return history;
}

/** OMP `session-title-slot.ts` layout: fixed key order, space padding, user source. */
export function serializeOmpTitleSlot(title: string, updatedAt: string): string {
  const line = (candidate: string, pad: string) =>
    `${JSON.stringify({ type: "title", v: 1, title: candidate, source: "user", updatedAt, pad })}\n`;
  const codePoints = [...title];
  let length = codePoints.length;
  while (
    length > 0 &&
    Buffer.byteLength(line(codePoints.slice(0, length).join(""), "")) > OMP_TITLE_SLOT_BYTES
  ) {
    length -= 1;
  }
  const fitted = codePoints.slice(0, length).join("");
  const padBytes = OMP_TITLE_SLOT_BYTES - Buffer.byteLength(line(fitted, ""));
  return line(fitted, " ".repeat(Math.max(0, padBytes)));
}

/**
 * Records a user-chosen session title the way each runtime does: OMP rewrites
 * its fixed-width title slot in place; Pi (and OMP files predating the slot)
 * get a rename entry appended under the active leaf.
 */
export async function writeNativeSessionTitle(input: {
  readonly filePath: string;
  readonly runtime: ProviderNativeSessionRuntime;
  readonly title: string;
  readonly updatedAt: string;
  readonly entryId: string;
}): Promise<void> {
  if (input.runtime === "omp") {
    const handle = await NodeFSP.open(input.filePath, "r+");
    try {
      const head = Buffer.alloc(OMP_TITLE_SLOT_BYTES);
      const { bytesRead } = await handle.read(head, 0, OMP_TITLE_SLOT_BYTES, 0);
      const slot =
        bytesRead === OMP_TITLE_SLOT_BYTES && head[OMP_TITLE_SLOT_BYTES - 1] === 0x0a
          ? parseRecord(head.toString("utf8", 0, OMP_TITLE_SLOT_BYTES - 1))
          : undefined;
      if (slot?.type === "title" && slot.v === 1 && typeof slot.pad === "string") {
        await handle.write(serializeOmpTitleSlot(input.title, input.updatedAt), 0, "utf8");
        return;
      }
    } finally {
      await handle.close();
    }
  }
  const { leafId } = await readTree(input.filePath);
  const entry =
    input.runtime === "omp"
      ? {
          type: "title_change",
          id: input.entryId,
          parentId: leafId ?? null,
          timestamp: input.updatedAt,
          title: input.title,
          source: "user",
        }
      : {
          type: "session_info",
          id: input.entryId,
          parentId: leafId ?? null,
          timestamp: input.updatedAt,
          name: input.title,
        };
  await NodeFSP.appendFile(input.filePath, `${JSON.stringify(entry)}\n`);
}
