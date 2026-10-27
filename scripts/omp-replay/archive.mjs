import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OMP_RECORD_TYPES = new Set(["session", "title", "title_change", "model_change", "thinking_level_change", "message"]);
const OMP_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);
const MAX_CHUNK_CODE_POINTS = 72;
const FRAME_INTERVAL_MS = 24;

export class ArchiveImportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ArchiveImportError";
  }
}

async function loadTranscriptParser() {
  const configuredPath = process.env.OMP_TRANSCRIPT_HTML_PARSER;
  if (configuredPath) {
    const resolvedPath = resolve(configuredPath);
    try {
      return await import(pathToFileURL(resolvedPath).href);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ArchiveImportError(
        `Unable to load transcript parser from OMP_TRANSCRIPT_HTML_PARSER (${configuredPath}): ${detail}`,
        { cause: error },
      );
    }
  }

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const artifact = resolve(scriptsDir, "../../.generated/omp-replay-parser/index.mjs");
  if (existsSync(artifact)) {
    try {
      return await import(pathToFileURL(artifact).href);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ArchiveImportError(
        `Unable to load bundled transcript parser artifact from ${artifact}: ${detail}. Re-run "node scripts/omp-replay/bundle-parser.mjs" to regenerate the bundle.`,
        { cause: error },
      );
    }
  }

  let directory = scriptsDir;
  while (true) {
    const candidate = join(directory, "packages/omp-transcript-html/dist/formats/index.js");
    if (existsSync(candidate)) {
      try {
        return await import(pathToFileURL(candidate).href);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ArchiveImportError(
          `Unable to load transcript parser from ${candidate}: ${detail}. Build the self-contained replay parser artifact with "node scripts/omp-replay/bundle-parser.mjs" or ensure all parser dependencies are installed.`,
          { cause: error },
        );
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new ArchiveImportError(
    "Transcript parser not found. Build the replay parser artifact by running \"node scripts/omp-replay/bundle-parser.mjs\", build the existing omp-transcript-html package, or set OMP_TRANSCRIPT_HTML_PARSER. The built-in replay does not require this parser.",
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOmpJsonl(text) {
  const unsupportedRecords = new Map();
  const unsupportedRoles = new Map();
  let unresolvedImageCount = 0;
  let lineCount = 0;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    lineCount += 1;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      throw new ArchiveImportError(`Line ${index + 1} is not valid JSON. Choose a complete OMP session JSONL export.`);
    }
    if (!isRecord(record)) {
      throw new ArchiveImportError(`Line ${index + 1} is not an OMP event object. Choose a complete OMP session JSONL export.`);
    }

    const type = typeof record.type === "string" ? record.type : "(missing type)";
    if (!OMP_RECORD_TYPES.has(type)) unsupportedRecords.set(type, (unsupportedRecords.get(type) ?? 0) + 1);
    if (type === "message") {
      const message = isRecord(record.message) ? record.message : null;
      const role = message && typeof message.role === "string" ? message.role : "(missing role)";
      if (!OMP_MESSAGE_ROLES.has(role)) unsupportedRoles.set(role, (unsupportedRoles.get(role) ?? 0) + 1);
      if (Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "image" || typeof block.data !== "string") continue;
          const data = block.data;
          if (!data.startsWith("data:") && !(data.length > 50 && /^[A-Za-z0-9+/=]+$/.test(data))) {
            unresolvedImageCount += 1;
          }
        }
      }
    }
  }

  if (lineCount === 0) throw new ArchiveImportError("The selected archive is empty. Choose an OMP session JSONL or ATIF trajectory export.");

  const warnings = [];
  if (unsupportedRecords.size > 0) {
    warnings.push(`Skipped unsupported OMP record types: ${formatCounts(unsupportedRecords)}. Their live state is not replayed.`);
  }
  if (unsupportedRoles.size > 0) {
    warnings.push(`Skipped unsupported OMP message roles: ${formatCounts(unsupportedRoles)}.`);
  }
  if (unresolvedImageCount > 0) {
    warnings.push(`${unresolvedImageCount} OMP image asset reference(s) are unavailable; only the selected text export is loaded.`);
  }
  return warnings;
}

function formatCounts(counts) {
  return [...counts].map(([name, count]) => `${name} (${count})`).join(", ");
}

function chunks(text) {
  const output = [];
  let chunk = "";
  let count = 0;
  for (const codePoint of text) {
    chunk += codePoint;
    count += 1;
    if (count === MAX_CHUNK_CODE_POINTS) {
      output.push(chunk);
      chunk = "";
      count = 0;
    }
  }
  if (chunk) output.push(chunk);
  return output;
}

function createTurnSchedule(turn, resultByCallId, warnings) {
  const schedule = [];
  let atMs = 0;
  let messageOpen = false;
  let messageBlocks = [];
  let contentIndex = 0;

  const append = (frame) => {
    schedule.push({ atMs, frame });
    atMs += FRAME_INTERVAL_MS;
  };
  const openMessage = () => {
    if (messageOpen) return;
    append({ type: "message_start", message: { role: "assistant", content: [] } });
    messageOpen = true;
    messageBlocks = [];
    contentIndex = 0;
  };
  const closeMessage = () => {
    if (!messageOpen) return;
    append({ type: "message_end", message: { role: "assistant", content: messageBlocks } });
    messageOpen = false;
    messageBlocks = [];
    contentIndex = 0;
  };
  const streamText = (text, kind) => {
    if (!text) return;
    openMessage();
    const index = contentIndex++;
    const isThinking = kind === "thinking";
    const eventType = isThinking ? "thinking" : "text";
    append({
      type: "message_update",
      assistantMessageEvent: { type: `${eventType}_start`, contentIndex: index },
    });
    for (const delta of chunks(text)) {
      append({
        type: "message_update",
        assistantMessageEvent: { type: `${eventType}_delta`, contentIndex: index, delta },
      });
    }
    append({
      type: "message_update",
      assistantMessageEvent: { type: `${eventType}_end`, contentIndex: index, content: text },
    });
    messageBlocks.push(isThinking ? { type: "thinking", thinking: text } : { type: "text", text });
  };

  append({ type: "agent_start" });
  for (const item of turn.traceItems) {
    if (item.id === turn.userItem.id) continue;

    if (item.kind === "agent_message" || item.kind === "agent_completion") {
      streamText(item.contentMarkdown ?? "", "text");
      if (item.images?.length || item.audio?.length) {
        warnings.add("Assistant media attachments are not replayed; only recorded text and tool details are carried into the native worker.");
      }
      continue;
    }
    if (item.kind === "thinking") {
      streamText(item.thinking?.text ?? item.contentMarkdown ?? "", "thinking");
      continue;
    }
    if (item.kind === "tool_call" && item.toolCall) {
      const call = item.toolCall;
      const nativeToolCall = {
        type: "toolCall",
        id: call.id,
        name: call.name,
        ...(call.argsRaw === undefined ? {} : { arguments: call.argsRaw }),
      };
      openMessage();
      const index = contentIndex++;
      append({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: index,
          partial: { content: [...messageBlocks, nativeToolCall] },
        },
      });
      append({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: nativeToolCall },
      });
      messageBlocks.push(nativeToolCall);
      closeMessage();

      if (resultByCallId.has(call.id)) {
        append({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          ...(call.argsRaw === undefined ? {} : { args: call.argsRaw }),
        });
      } else {
        warnings.add(`Tool call ${call.id} (${call.name}) has no recorded result; it remains unresolved in the replay.`);
      }
      continue;
    }
    if (item.kind === "tool_result" && item.toolResult) {
      closeMessage();
      const result = item.toolResult;
      if (!resultByCallId.has(result.toolCallId)) {
        warnings.add(`Tool result ${result.toolCallId || "(no call id)"} has no matching recorded tool call.`);
      }
      const nativeResult = {
        content: result.outputRaw ? [{ type: "text", text: result.outputRaw }] : [],
        ...(result.detailsRaw === undefined ? {} : { details: result.detailsRaw }),
      };
      append({
        type: "tool_execution_end",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: nativeResult,
        isError: result.isError,
      });
      if (result.images?.length) {
        warnings.add("Tool-result media attachments are not replayed; recorded text and structured details are preserved.");
      }
      continue;
    }
    if (item.kind === "system_message" || item.role === "system" || item.role === "developer") {
      throw new ArchiveImportError("This archive contains system/developer messages that the native OMP replay pipeline cannot represent. Select an OMP user/assistant session export instead.");
    }
    warnings.add(`Skipped an archive item with unsupported type "${item.kind}".`);
  }

  closeMessage();
  append({ type: "agent_end", isTerminal: true });
  return schedule;
}

/**
 * Convert one explicitly selected transcript's text into native OMP RPC frames.
 * The resolver deliberately returns null: archive imports never open paths, blobs,
 * child trajectories, home directories, or session storage.
 */
export async function importArchive(fileName, text) {
  if (typeof fileName !== "string" || !fileName.trim()) {
    throw new ArchiveImportError("A selected archive file name is required.");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new ArchiveImportError("The selected archive is empty. Choose an OMP session JSONL or ATIF trajectory export.");
  }

  const { detectTranscriptFormat, parseTranscript } = await loadTranscriptParser();
  const source = { name: fileName, text, resolve: async () => null };
  const format = detectTranscriptFormat(source);
  if (!format) {
    throw new ArchiveImportError("Unsupported archive. Choose an OMP session JSONL or ATIF trajectory JSON export.");
  }

  const warnings = new Set([
    "This is a reconstruction: static text is streamed in controlled chunks; original token timing and live event timestamps are not available.",
    "Replay agent_start/agent_end boundaries are generated per imported prompt. Unrecorded IRC, waiting state, and task lifecycle/progress are not synthesized; only recorded tool-result details are forwarded.",
    "Only the selected archive text is read. Referenced assets and child-session files are not opened from disk or home directories.",
    "No live usage metrics are synthesized; recorded tool-result details are preserved verbatim.",
  ]);
  if (format === "omp") {
    for (const warning of validateOmpJsonl(text)) warnings.add(warning);
  }

  let transcript;
  try {
    transcript = await parseTranscript(source, { format });
  } catch (error) {
    if (error instanceof ArchiveImportError) throw error;
    const message = error instanceof Error ? error.message : "The transcript parser rejected this file.";
    throw new ArchiveImportError(`Unable to import the selected archive: ${message}`);
  }

  for (const warning of transcript.meta.warnings) warnings.add(warning);
  const allItems = transcript.allTraceItems;
  const resultByCallId = new Map();
  const allCalls = new Map();
  for (const item of allItems) {
    if (item.toolCall) allCalls.set(item.toolCall.id, item.toolCall);
    if (item.toolResult) resultByCallId.set(item.toolResult.toolCallId, item.toolResult);
  }

  const turns = [];
  for (const turn of transcript.turns) {
    if (turn.userItem.id.endsWith("-user-placeholder")) {
      warnings.add("Content before the first recorded user message is not replayed because it has no source user prompt.");
      continue;
    }
    const prompt = turn.userItem.contentMarkdown ?? "";
    if (!prompt.trim()) {
      throw new ArchiveImportError(`Turn ${turn.index + 1} has no replayable text prompt. Attachment-only user turns cannot be sent through the native text replay worker.`);
    }
    if (turn.userItem.images?.length || turn.userItem.audio?.length) {
      warnings.add("User media attachments are not replayed; the selected archive's text prompts are preserved.");
    }
    turns.push({
      index: turns.length,
      prompt,
      schedule: createTurnSchedule(turn, resultByCallId, warnings),
    });
  }
  if (turns.length === 0) {
    throw new ArchiveImportError("No replayable user turns were found. Choose a complete OMP session JSONL or ATIF trajectory with user messages.");
  }

  for (const [callId] of allCalls) {
    if (!resultByCallId.has(callId)) {
      warnings.add(`Tool call ${callId} has no recorded result; the archive may end before that operation completed.`);
    }
  }

  let atMs = 0;
  const schedule = [];
  for (const turn of turns) {
    for (const event of turn.schedule) schedule.push({ atMs: atMs + event.atMs, frame: event.frame });
    const lastEvent = turn.schedule.at(-1);
    atMs += (lastEvent?.atMs ?? 0) + FRAME_INTERVAL_MS * 2;
  }

  return {
    scenario: "imported-archive",
    title: transcript.meta.title || fileName,
    format,
    warnings: [...warnings],
    turns,
    schedule,
  };
}
