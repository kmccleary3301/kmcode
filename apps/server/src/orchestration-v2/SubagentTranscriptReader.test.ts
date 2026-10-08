// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import {
  ORCHESTRATION_V2_SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH,
  OrchestrationV2GetSubagentTranscriptError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { afterAll, assert, describe } from "vite-plus/test";
import { readSubagentTranscript, readSubagentTranscriptFile } from "./SubagentTranscriptReader.ts";
import * as SqlClient from "effect/sql/SqlClient";

const dummySql = {} as unknown as SqlClient.SqlClient;

const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "subagent-transcript-test-"));

afterAll(() => {
  NodeFS.rmSync(tempDir, { recursive: true, force: true });
});

describe("SubagentTranscriptReader", () => {
  effectIt.live("pages through a real JSONL transcript file with byte cursors", () =>
    Effect.gen(function* () {
      const filePath = NodePath.join(tempDir, "paging-test.jsonl");
      const line1 =
        JSON.stringify({
          type: "message",
          id: "msg-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "First question" },
        }) + "\n";
      const line2 =
        JSON.stringify({
          type: "message",
          id: "msg-2",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
        }) + "\n";

      NodeFS.writeFileSync(filePath, line1 + line2, "utf8");

      // Read page 1
      const page1 = yield* readSubagentTranscriptFile(filePath, "0");
      assert.strictEqual(page1.entries.length, 2);
      assert.strictEqual(page1.entries[0]?.kind, "user");
      assert.strictEqual(page1.entries[0]?.text, "First question");
      assert.strictEqual(page1.entries[1]?.kind, "assistant");
      assert.strictEqual(page1.entries[1]?.text, "First answer");
      assert.isFalse(page1.reset);
      assert.isAbove(Number(page1.nextCursor), 0);

      // Append line 3
      const line3 =
        JSON.stringify({
          type: "message",
          id: "msg-3",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Follow-up answer" }] },
        }) + "\n";
      NodeFS.appendFileSync(filePath, line3, "utf8");

      // Read page 2 from nextCursor
      const page2 = yield* readSubagentTranscriptFile(filePath, page1.nextCursor);
      assert.strictEqual(page2.entries.length, 1);
      assert.strictEqual(page2.entries[0]?.kind, "assistant");
      assert.strictEqual(page2.entries[0]?.text, "Follow-up answer");
      assert.isFalse(page2.reset);
    }),
  );

  effectIt.live("parses tool calls and results with arguments and status", () =>
    Effect.gen(function* () {
      const filePath = NodePath.join(tempDir, "tool-test.jsonl");
      const lines =
        [
          JSON.stringify({
            type: "message",
            id: "tool-call-msg",
            timestamp: "2026-01-01T00:00:00.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-123",
                  name: "readFile",
                  arguments: { path: "src/index.ts" },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "tool-result-msg",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: {
              role: "toolResult",
              toolCallId: "call-123",
              toolName: "readFile",
              isError: false,
              content: "file contents",
            },
          }),
        ].join("\n") + "\n";

      NodeFS.writeFileSync(filePath, lines, "utf8");

      const result = yield* readSubagentTranscriptFile(filePath);
      assert.strictEqual(result.entries.length, 2);

      const callEntry = result.entries[0]!;
      assert.strictEqual(callEntry.kind, "tool");
      assert.strictEqual(callEntry.tool?.phase, "call");
      assert.strictEqual(callEntry.tool?.callId, "call-123");
      assert.deepEqual(callEntry.tool?.arguments, { path: "src/index.ts" });
      assert.include(callEntry.text, "Called readFile");

      const resultEntry = result.entries[1]!;
      assert.strictEqual(resultEntry.kind, "tool");
      assert.strictEqual(resultEntry.tool?.phase, "result");
      assert.strictEqual(resultEntry.tool?.callId, "call-123");
      assert.strictEqual(resultEntry.text, "file contents");
      assert.strictEqual(resultEntry.isError, undefined);
    }),
  );

  effectIt.live("truncates oversized text entries to 8192 characters and sets truncated flag", () =>
    Effect.gen(function* () {
      const filePath = NodePath.join(tempDir, "truncation-test.jsonl");
      const hugeText = "a".repeat(10_000);
      const line =
        JSON.stringify({
          type: "message",
          id: "huge-msg",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: hugeText }] },
        }) + "\n";

      NodeFS.writeFileSync(filePath, line, "utf8");

      const result = yield* readSubagentTranscriptFile(filePath);
      assert.strictEqual(result.entries.length, 1);
      assert.strictEqual(
        result.entries[0]?.text.length,
        ORCHESTRATION_V2_SUBAGENT_TRANSCRIPT_TEXT_MAX_LENGTH,
      );
      assert.isTrue(result.entries[0]?.truncated);
    }),
  );

  effectIt.live("yields typed error when turn item has no transcriptFile", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readSubagentTranscript(
          {
            threadId: ThreadId.make("thread-1"),
            turnItemId: TurnItemId.make("item-1"),
          },
          {
            lookupTurnItem: () =>
              Effect.succeed({
                type: "subagent",
                // transcriptFile is missing
              }),
          },
        ).pipe(Effect.provideService(SqlClient.SqlClient, dummySql)),
      );

      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, OrchestrationV2GetSubagentTranscriptError);
        assert.strictEqual(error.reason, "no-transcript-file");
      }
    }),
  );

  effectIt.live("yields typed error when transcript file does not exist on disk", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readSubagentTranscript(
          {
            threadId: ThreadId.make("thread-1"),
            turnItemId: TurnItemId.make("item-1"),
          },
          {
            lookupTurnItem: () =>
              Effect.succeed({
                type: "subagent",
                transcriptFile: NodePath.join(tempDir, "non-existent.jsonl"),
              }),
          },
        ).pipe(Effect.provideService(SqlClient.SqlClient, dummySql)),
      );

      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, OrchestrationV2GetSubagentTranscriptError);
        assert.strictEqual(error.reason, "file-not-found");
      }
    }),
  );

  effectIt.live("advances past an oversized record and holds a partial trailing line", () =>
    Effect.gen(function* () {
      const filePath = NodePath.join(tempDir, "oversized-test.jsonl");
      const huge = JSON.stringify({
        type: "message",
        id: "msg-huge",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(600_000) }] },
      });
      const partial = '{"type":"message","id":"msg-partial"';
      NodeFS.writeFileSync(filePath, `${huge}\n${partial}`, "utf8");

      const page = yield* readSubagentTranscriptFile(filePath, "0");
      assert.strictEqual(page.entries.length, 1);
      assert.strictEqual(page.entries[0]?.truncated, true);
      assert.strictEqual(Number(page.nextCursor), Buffer.byteLength(`${huge}\n`));

      const tail = yield* readSubagentTranscriptFile(filePath, page.nextCursor);
      assert.deepStrictEqual(tail.entries, []);
      assert.strictEqual(tail.nextCursor, page.nextCursor);
    }),
  );
});
