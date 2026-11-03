import { assert, it } from "@effect/vitest";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { rebuildMessageSearch } from "../../orchestration-v2/messageSearchIndex.ts";
import { runMigrations } from "../Migrations.ts";

it.effect.each(["inserted", "updated", "backfilled", "rebuilt"] as const)(
  "keeps normal messages indexed and excludes %s placeholders",
  (path) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const backfilled = path === "backfilled";
      yield* runMigrations({ toMigrationInclusive: backfilled ? 63 : 64 });
      if (!backfilled) {
        // Simulate migration 064's pre-065 triggers on an existing database.
        yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
        yield* sql`
          CREATE TRIGGER orchestration_v2_message_search_insert
          AFTER INSERT ON orchestration_v2_projection_messages
          BEGIN
            INSERT INTO orchestration_v2_message_search (rowid, text)
            VALUES (new.rowid, json_extract(new.payload_json, '$.text'));
          END
        `;
        yield* sql`
          CREATE TRIGGER orchestration_v2_message_search_update
          AFTER UPDATE OF payload_json ON orchestration_v2_projection_messages
          BEGIN
            DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
            INSERT INTO orchestration_v2_message_search (rowid, text)
            VALUES (new.rowid, json_extract(new.payload_json, '$.text'));
          END
        `;
        yield* sql`
          CREATE TRIGGER orchestration_v2_message_search_delete
          AFTER DELETE ON orchestration_v2_projection_messages
          BEGIN
            DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
          END
        `;
        if (path !== "rebuilt") yield* runMigrations();
      }

      const placeholders = [
        ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        ...[
          "",
          " ",
          "\n",
          "\t\r\n",
          "\v\f",
          "\u00a0",
          "\u1680",
          "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a",
          "\u2028\u2029\u202f\u205f\u3000\ufeff",
        ].map((whitespace) => `uLtRaThInK:${whitespace}${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`),
      ];
      const normal = [
        "normal context",
        ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.toLowerCase(),
        `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.toLowerCase()}`,
        `quoted ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT} extra`,
        ` ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        `Ultrathink:\u0085${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
      ];
      for (const [index, text] of [...normal, ...placeholders].entries()) {
        const payload = JSON.stringify({ text, createdBy: "user" });
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages
            (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
          VALUES (${String(index)}, 'thread-1', 'user', 0,
            '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
            ${path === "updated" ? JSON.stringify({ text: "normal context" }) : payload})
        `;
        if (path === "updated") {
          yield* sql`
            UPDATE orchestration_v2_projection_messages SET payload_json = ${payload}
            WHERE message_id = ${String(index)}
          `;
        }
      }
      if (backfilled) yield* runMigrations({ toMigrationInclusive: 64 });
      if (path === "rebuilt") {
        yield* runMigrations();
        yield* rebuildMessageSearch(sql);
      }
      const indexed = yield* sql<{ readonly messageId: string }>`
        SELECT messages.message_id AS "messageId"
        FROM orchestration_v2_message_search AS search
        INNER JOIN orchestration_v2_projection_messages AS messages ON messages.rowid = search.rowid
        ORDER BY messages.rowid
      `;
      assert.deepEqual(
        indexed.map((row) => row.messageId),
        normal.map((_, index) => String(index)),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
