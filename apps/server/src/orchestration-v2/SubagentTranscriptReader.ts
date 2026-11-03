// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type OrchestrationV2GetSubagentTranscriptInput,
  type OrchestrationV2GetSubagentTranscriptResult,
  type OrchestrationV2SubagentTranscriptEntry,
  type OrchestrationV2SubagentTranscriptEntryKind,
  ORCHESTRATION_V2_SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH,
  OrchestrationV2GetSubagentTranscriptError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

interface RawMessageRecord {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly toolName?: unknown;
  readonly name?: unknown;
  readonly toolCallId?: unknown;
  readonly tool_call_id?: unknown;
  readonly isError?: unknown;
  readonly summary?: unknown;
  readonly text?: unknown;
  readonly message?: unknown;
  readonly result?: unknown;
}

interface RawSessionEntry {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly timestamp?: unknown;
  readonly message?: RawMessageRecord;
}

function boundText(text: string): { readonly text: string; readonly truncated?: boolean } {
  if (text.length <= ORCHESTRATION_V2_SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH) {
    return { text };
  }
  return {
    text: text.slice(0, ORCHESTRATION_V2_SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH),
    truncated: true,
  };
}

export function parseSubagentTranscriptLines(
  lines: ReadonlyArray<string>,
): ReadonlyArray<OrchestrationV2SubagentTranscriptEntry> {
  const entries: OrchestrationV2SubagentTranscriptEntry[] = [];

  for (const [entryIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as RawSessionEntry)
        : undefined;
    if (entry?.type !== "message" || entry.message === undefined) continue;

    const message = entry.message;
    const baseId =
      typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `message-${entryIndex}`;
    const candidateTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const timestamp =
      candidateTimestamp !== undefined && !Number.isNaN(Date.parse(candidateTimestamp))
        ? candidateTimestamp
        : DateTime.formatIso(DateTime.nowUnsafe());
    const role = typeof message.role === "string" ? message.role : "system";
    const content = message.content;
    const parts = Array.isArray(content) ? content : [content];

    const extractTextParts = (items: ReadonlyArray<unknown>): ReadonlyArray<string> =>
      items.flatMap((part) => {
        if (typeof part === "string" && part.length > 0) return [part];
        if (typeof part === "object" && part !== null && !Array.isArray(part)) {
          const rec = part as Record<string, unknown>;
          const textCandidate =
            typeof rec.text === "string"
              ? rec.text
              : typeof rec.thinking === "string"
                ? rec.thinking
                : typeof rec.content === "string"
                  ? rec.content
                  : typeof rec.summary === "string"
                    ? rec.summary
                    : undefined;
          if (textCandidate && textCandidate.length > 0) return [textCandidate];
        }
        return [];
      });

    if (role === "toolResult" || role === "tool") {
      const toolCallId =
        typeof message.toolCallId === "string" && message.toolCallId.length > 0
          ? message.toolCallId
          : typeof message.tool_call_id === "string" && message.tool_call_id.length > 0
            ? message.tool_call_id
            : undefined;
      const toolName =
        typeof message.toolName === "string" && message.toolName.length > 0
          ? message.toolName
          : typeof message.name === "string" && message.name.length > 0
            ? message.name
            : parts.reduce<string | undefined>((name, part) => {
                if (name) return name;
                if (typeof part === "object" && part !== null) {
                  const r = part as Record<string, unknown>;
                  if (typeof r.name === "string" && r.name.length > 0) return r.name;
                  if (typeof r.toolName === "string" && r.toolName.length > 0) return r.toolName;
                }
                return undefined;
              }, undefined);

      const textPartsForResult = extractTextParts(parts);
      const rawText =
        textPartsForResult.length > 0
          ? textPartsForResult.join("")
          : typeof message.summary === "string" && message.summary.length > 0
            ? message.summary
            : typeof message.text === "string" && message.text.length > 0
              ? message.text
              : typeof message.message === "string" && message.message.length > 0
                ? message.message
                : JSON.stringify(message, null, 2);
      const bounded = boundText(rawText);

      entries.push({
        id: `${baseId}:0`,
        kind: "tool",
        text: bounded.text,
        timestamp,
        ...(toolName === undefined ? {} : { toolName }),
        ...(message.isError === true ? { isError: true } : {}),
        ...(bounded.truncated ? { truncated: true } : {}),
        tool: {
          phase: "result",
          ...(toolCallId === undefined ? {} : { callId: toolCallId }),
          ...(message.result !== undefined ? { result: message.result } : { result: message }),
        },
      });
      continue;
    }

    let emittedPart = 0;
    for (const part of parts) {
      const partRecord =
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? (part as Record<string, unknown>)
          : undefined;
      const partType = typeof partRecord?.type === "string" ? partRecord.type : undefined;
      const toolName =
        typeof partRecord?.name === "string"
          ? partRecord.name
          : typeof partRecord?.toolName === "string"
            ? partRecord.toolName
            : typeof message.toolName === "string"
              ? message.toolName
              : undefined;

      if (role === "assistant" && (partType === "toolCall" || partType === "tool_call")) {
        const argumentsValue =
          partRecord !== undefined && "arguments" in partRecord
            ? partRecord.arguments
            : partRecord?.input;
        const serializedArguments =
          argumentsValue === undefined ? undefined : JSON.stringify(argumentsValue, null, 2);
        const toolCallId =
          typeof partRecord?.id === "string" && partRecord.id.length > 0
            ? partRecord.id
            : typeof partRecord?.toolCallId === "string" && partRecord.toolCallId.length > 0
              ? partRecord.toolCallId
              : typeof partRecord?.tool_call_id === "string" && partRecord.tool_call_id.length > 0
                ? partRecord.tool_call_id
                : undefined;
        const rawText = `Called ${toolName ?? "tool"}${
          serializedArguments === undefined ? "" : `\n${serializedArguments}`
        }`;
        const bounded = boundText(rawText);

        entries.push({
          id: `${baseId}:${emittedPart++}`,
          kind: "tool",
          text: bounded.text,
          timestamp,
          ...(toolName === undefined ? {} : { toolName }),
          ...(bounded.truncated ? { truncated: true } : {}),
          tool: {
            phase: "call",
            ...(toolCallId === undefined ? {} : { callId: toolCallId }),
            ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
          },
        });
        continue;
      }

      for (const text of extractTextParts([part])) {
        const kind: OrchestrationV2SubagentTranscriptEntryKind =
          role === "user"
            ? "user"
            : role === "reasoning" ||
                (role === "assistant" && (partType === "thinking" || partType === "reasoning"))
              ? "reasoning"
              : role === "assistant"
                ? "assistant"
                : "system";
        const bounded = boundText(text);

        entries.push({
          id: `${baseId}:${emittedPart++}`,
          kind,
          text: bounded.text,
          timestamp,
          ...(toolName === undefined ? {} : { toolName }),
          ...(bounded.truncated ? { truncated: true } : {}),
        });
      }
    }

    if (emittedPart > 0) continue;
    const summary =
      typeof message.summary === "string"
        ? message.summary
        : typeof message.text === "string"
          ? message.text
          : typeof message.message === "string"
            ? message.message
            : undefined;
    if (summary === undefined || summary.length === 0) continue;
    const summaryKind: OrchestrationV2SubagentTranscriptEntryKind =
      role === "user"
        ? "user"
        : role === "assistant"
          ? "assistant"
          : role === "reasoning"
            ? "reasoning"
            : "system";
    const bounded = boundText(summary);
    entries.push({
      id: `${baseId}:0`,
      kind: summaryKind,
      text: bounded.text,
      timestamp,
      ...(bounded.truncated ? { truncated: true } : {}),
    });
  }

  return entries;
}

/** A page stops at the last complete line within this many bytes. */
const TRANSCRIPT_PAGE_BYTES = 512 * 1024;

export function readSubagentTranscriptFile(
  transcriptFile: string,
  cursor?: string,
  threadId: ThreadId = ThreadId.make("thread:subagent-transcript"),
): Effect.Effect<
  OrchestrationV2GetSubagentTranscriptResult,
  OrchestrationV2GetSubagentTranscriptError
> {
  const readFailed = (message: string) => (cause: unknown) =>
    new OrchestrationV2GetSubagentTranscriptError({
      reason: "read-failed",
      threadId,
      message: `${message}: ${transcriptFile}`,
      cause,
    });
  return Effect.gen(function* () {
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(transcriptFile),
      catch: (cause) =>
        new OrchestrationV2GetSubagentTranscriptError({
          reason: "file-not-found",
          threadId,
          message: `Transcript file not found on disk: ${transcriptFile}`,
          cause,
        }),
    });

    const size = stat.size;
    let startByte =
      typeof cursor === "string" && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.trunc(Number(cursor)))
        : 0;
    // A cursor past the end means the file was rewritten; restart from the top.
    const reset = startByte > size;
    if (reset) startByte = 0;
    if (startByte >= size) {
      return { entries: [], nextCursor: String(size), reset };
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(transcriptFile, "r"),
        catch: readFailed("Failed to open transcript file"),
      }),
      (handle) =>
        Effect.gen(function* () {
          // Grow the window until it holds one complete line, so a single
          // oversized record still advances the cursor.
          let windowBytes = Math.min(TRANSCRIPT_PAGE_BYTES, size - startByte);
          for (;;) {
            const buffer = Buffer.alloc(windowBytes);
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => handle.read(buffer, 0, windowBytes, startByte),
              catch: readFailed("Failed to read transcript file"),
            });
            const readBuffer = buffer.subarray(0, bytesRead);
            const lastNewlineIndex = readBuffer.lastIndexOf(0x0a);
            if (lastNewlineIndex !== -1) {
              const completeSlice = readBuffer.subarray(0, lastNewlineIndex + 1);
              return {
                entries: parseSubagentTranscriptLines(completeSlice.toString("utf8").split("\n")),
                nextCursor: String(startByte + completeSlice.byteLength),
                reset,
              };
            }
            if (startByte + bytesRead >= size) {
              // The trailing line is still being written.
              return { entries: [], nextCursor: String(startByte), reset };
            }
            windowBytes = Math.min(windowBytes * 2, size - startByte);
          }
        }),
      (handle) => Effect.promise(() => handle.close()),
    );
  });
}

const TranscriptTurnItemRef = Schema.Struct({
  type: Schema.String,
  transcriptFile: Schema.optional(Schema.String),
});
type TranscriptTurnItemRef = typeof TranscriptTurnItemRef.Type;
const decodeTranscriptTurnItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(TranscriptTurnItemRef),
);

export interface SubagentTranscriptReaderOptions {
  readonly lookupTurnItem?: (
    input: OrchestrationV2GetSubagentTranscriptInput,
  ) => Effect.Effect<TranscriptTurnItemRef | null, never>;
}

export const readSubagentTranscript = Effect.fn("orchestration.readSubagentTranscript")(function* (
  input: OrchestrationV2GetSubagentTranscriptInput,
  options?: SubagentTranscriptReaderOptions,
) {
  let turnItem: TranscriptTurnItemRef | null = null;

  if (options?.lookupTurnItem !== undefined) {
    turnItem = yield* options.lookupTurnItem(input);
  } else {
    const sql = yield* SqlClient.SqlClient;
    const targetItemId = input.turnItemId;
    const targetSubagentId = input.subagentId;

    const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${input.threadId}
          AND ${
            targetItemId !== undefined && targetSubagentId !== undefined
              ? sql`(turn_item_id = ${targetItemId} OR json_extract(payload_json, '$.subagentId') = ${targetSubagentId} OR turn_item_id = ${targetSubagentId})`
              : targetItemId !== undefined
                ? sql`turn_item_id = ${targetItemId}`
                : targetSubagentId !== undefined
                  ? sql`(json_extract(payload_json, '$.subagentId') = ${targetSubagentId} OR turn_item_id = ${targetSubagentId})`
                  : sql`1=0`
          }
        ORDER BY ordinal DESC
        LIMIT 1
      `.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetSubagentTranscriptError({
            reason: "read-failed",
            threadId: input.threadId,
            turnItemId: input.turnItemId,
            subagentId: input.subagentId,
            message: "Failed to look up the subagent turn item.",
            cause,
          }),
      ),
    );
    if (rows[0] !== undefined) {
      turnItem = Option.getOrNull(decodeTranscriptTurnItem(rows[0].payload_json));
    }
  }

  if (turnItem === null || turnItem.type !== "subagent") {
    return yield* Effect.fail(
      new OrchestrationV2GetSubagentTranscriptError({
        reason: "not-found",
        threadId: input.threadId,
        turnItemId: input.turnItemId,
        subagentId: input.subagentId,
        message: "Subagent turn item not found.",
      }),
    );
  }

  const transcriptFile = turnItem.transcriptFile;
  if (typeof transcriptFile !== "string" || transcriptFile.trim().length === 0) {
    return yield* Effect.fail(
      new OrchestrationV2GetSubagentTranscriptError({
        reason: "no-transcript-file",
        threadId: input.threadId,
        turnItemId: input.turnItemId,
        subagentId: input.subagentId,
        message: "Subagent has no recorded transcript file.",
      }),
    );
  }

  return yield* readSubagentTranscriptFile(transcriptFile, input.cursor, input.threadId).pipe(
    Effect.mapError(
      (err) =>
        new OrchestrationV2GetSubagentTranscriptError({
          reason: err.reason,
          threadId: input.threadId,
          turnItemId: input.turnItemId,
          subagentId: input.subagentId,
          message: err.message,
          cause: err.cause,
        }),
    ),
  );
});
