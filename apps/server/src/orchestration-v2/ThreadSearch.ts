import {
  IsoDateTime,
  MessageId,
  OrchestrationThreadSearchSource,
  OrchestrationV2ThreadOpens,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  foldSearchQuery,
  messageMatcher,
  messageSearchTokens,
  rankMessageMatches,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { indexedMessageCondition, indexedMessageText } from "./messageSearchIndex.ts";

// Bound recent index hits and fallback scans before scoring messages in memory.
const MESSAGE_CANDIDATE_LIMIT = 10_000;
const MESSAGE_SCAN_LIMIT = 20_000;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;
const SNIPPET_LEAD = 24;
const decodeThreadOpens = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ThreadOpens),
);
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Carries no query text: search input is user content. */
export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStringArray = Schema.encodeEffect(StringArrayJson);
const SearchRequest = Schema.Struct({
  ftsMatch: Schema.NullOr(Schema.String),
  words: Schema.String,
  limit: Schema.Int,
});
const SearchRow = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
const ThreadActivityRequest = Schema.Struct({ threadIds: Schema.String });
const ThreadActivityRow = Schema.Struct({
  threadId: ThreadId,
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  opens: Schema.NullOr(Schema.String),
});

/** Up to 240 characters starting a few words before the actual message match. */
function buildSearchSnippet(text: string, matchStart: number): string {
  let start = Math.max(0, matchStart - SNIPPET_LEAD);
  const wordStart = text.slice(start, matchStart).search(/\s/);
  if (start > 0 && wordStart !== -1) start += wordStart + 1;
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  const rawEnd = Math.min(text.length, start + 480);
  const shown = text
    .slice(start, rawEnd)
    .replace(/\*\*|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let end = Math.min(shown.length, 238);
  if (isLowSurrogate(shown.charCodeAt(end))) end--;
  const cut = end < shown.length || rawEnd < text.length;
  return `${start > 0 ? "…" : ""}${shown.slice(0, end)}${cut ? "…" : ""}`;
}

/**
 * Searches the finished user and assistant messages of active V2 threads in
 * active projects. Legacy V1 transcripts that have not been imported yet are
 * not searched.
 */
export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  const hasSearchIndex = index.length > 0;

  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ ftsMatch, words, limit }) => {
      const everyWord = sql`
        NOT EXISTS (
          SELECT 1
          FROM json_each(${words}) AS search_words
          WHERE instr(
            lower(${indexedMessageText(sql, "messages.payload_json")}),
            lower(replace(replace(search_words.value, '’', ''''), '‘', ''''))
          ) = 0
        )
      `;
      const messageFilter =
        ftsMatch === null
          ? sql`
              messages.rowid > (
                SELECT coalesce(max(rowid), 0)
                FROM orchestration_v2_projection_messages
              ) - ${MESSAGE_SCAN_LIMIT}
              AND ${everyWord}
            `
          : sql`
              messages.rowid IN (
                SELECT orchestration_v2_message_search.rowid
                FROM orchestration_v2_message_search
                INNER JOIN orchestration_v2_projection_messages AS candidate_messages
                  ON candidate_messages.rowid = orchestration_v2_message_search.rowid
                INNER JOIN orchestration_v2_projection_threads AS candidate_threads
                  ON candidate_threads.thread_id = candidate_messages.thread_id
                INNER JOIN projection_projects AS candidate_projects
                  ON candidate_projects.project_id = candidate_threads.project_id
                WHERE orchestration_v2_message_search MATCH ${ftsMatch}
                  AND candidate_threads.deleted_at IS NULL
                  AND candidate_threads.archived_at IS NULL
                  AND candidate_projects.deleted_at IS NULL
                  AND json_extract(candidate_threads.payload_json, '$.lineage.sideChat') IS NOT 1
                  AND candidate_messages.message_id NOT LIKE 'async-answer:%'
                  AND ${indexedMessageCondition(sql, "candidate_messages")}
                ORDER BY orchestration_v2_message_search.rowid DESC
                LIMIT ${MESSAGE_CANDIDATE_LIMIT}
              )
              AND ${everyWord}
            `;
      return sql`
        SELECT
          messages.message_id AS "messageId",
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          messages.role AS source,
          json_extract(messages.payload_json, '$.text') AS "matchText",
          messages.created_at AS "messageCreatedAt"
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND json_extract(threads.payload_json, '$.lineage.sideChat') IS NOT 1
          AND messages.message_id NOT LIKE 'async-answer:%'
          AND ${indexedMessageCondition(sql, "messages")}
          AND ${messageFilter}
        ORDER BY messages.rowid DESC
        LIMIT ${limit}
      `;
    },
  });
  const threadActivityRows = SqlSchema.findAll({
    Request: ThreadActivityRequest,
    Result: ThreadActivityRow,
    execute: ({ threadIds }) => sql`
      SELECT
        threads.thread_id AS "threadId",
        (
          SELECT user_messages.updated_at
          FROM orchestration_v2_projection_messages AS user_messages
          WHERE user_messages.thread_id = threads.thread_id
            AND user_messages.role = 'user'
            AND COALESCE(json_extract(user_messages.payload_json, '$.createdBy'), 'user') = 'user'
          ORDER BY user_messages.updated_at DESC, user_messages.message_id DESC
          LIMIT 1
        ) AS "latestUserMessageAt",
        threads.created_at AS "createdAt",
        json_extract(threads.payload_json, '$.opens') AS opens
      FROM orchestration_v2_projection_threads AS threads
      WHERE threads.thread_id IN (SELECT value FROM json_each(${threadIds}))
    `,
  });
  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const tokens = messageSearchTokens(input.query);
      if (tokens.long.length === 0) return { matches: [] };

      const canUseTrigram =
        hasSearchIndex && tokens.long.every((token) => Array.from(token).length >= 3);
      const ftsMatch = canUseTrigram
        ? tokens.long.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ")
        : null;
      const words = yield* encodeStringArray(canUseTrigram ? tokens.short : tokens.words).pipe(
        Effect.mapError((cause) => new ThreadSearchError({ operation: "query", cause })),
      );
      const rows = yield* searchRows({
        ftsMatch,
        words,
        limit: canUseTrigram ? MESSAGE_CANDIDATE_LIMIT : MESSAGE_SCAN_LIMIT,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadSearchError({
              operation: Schema.isSchemaError(cause) ? "decode" : "query",
              cause,
            }),
        ),
      );
      type Hit = {
        readonly row: typeof SearchRow.Type;
        readonly text: string;
        readonly quality: number;
        readonly offset: number;
      };
      const best = new Map<ThreadId, Hit>();
      const hitCounts = new Map<ThreadId, number>();
      const matchMessage = messageMatcher(input.query);
      const newer = (left: Hit, right: Hit) =>
        (right.row.messageCreatedAt ?? "").localeCompare(left.row.messageCreatedAt ?? "");
      const compareHits = (left: Hit, right: Hit) =>
        right.quality - left.quality ||
        Number(left.row.source !== "user") - Number(right.row.source !== "user") ||
        newer(left, right);

      for (const row of rows) {
        const text = row.matchText.replace(MARKDOWN_LINK, "$1");
        const match = matchMessage(text);
        if (match === null) continue;
        const hit = { row, text, ...match };
        const current = best.get(row.threadId);
        if (current === undefined || hit.quality > current.quality) {
          best.set(row.threadId, hit);
          hitCounts.set(row.threadId, 1);
        } else if (hit.quality === current.quality) {
          hitCounts.set(row.threadId, (hitCounts.get(row.threadId) ?? 1) + 1);
          if (compareHits(hit, current) < 0) best.set(row.threadId, hit);
        }
      }

      const encodedThreadIds =
        best.size === 0
          ? null
          : yield* encodeStringArray([...best.keys()]).pipe(
              Effect.mapError((cause) => new ThreadSearchError({ operation: "query", cause })),
            );
      const activityRows =
        encodedThreadIds === null
          ? []
          : yield* threadActivityRows({
              threadIds: encodedThreadIds,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadSearchError({
                    operation: Schema.isSchemaError(cause) ? "decode" : "query",
                    cause,
                  }),
              ),
            );
      const subjects = new Map<ThreadId, ThreadSearchSubject>();
      for (const row of activityRows) {
        const activityAt = Date.parse(row.latestUserMessageAt ?? row.createdAt);
        subjects.set(row.threadId, {
          title: "",
          activityAt: Number.isFinite(activityAt) ? activityAt : null,
          opens: row.opens === null ? null : Option.getOrNull(decodeThreadOpens(row.opens)),
        });
      }
      const ranked = rankMessageMatches(
        [...best.values()].map((hit) => ({
          ...hit,
          hits: hitCounts.get(hit.row.threadId) ?? 1,
          messageCreatedAt: hit.row.messageCreatedAt,
        })),
        (hit) => subjects.get(hit.row.threadId),
        foldSearchQuery(input.query),
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      return {
        matches: ranked.slice(0, input.limit ?? 50).map((hit) => ({
          threadId: hit.row.threadId,
          projectId: hit.row.projectId,
          messageId: hit.row.messageId,
          source: hit.row.source,
          snippet: buildSearchSnippet(hit.text, hit.offset),
          messageCreatedAt: hit.messageCreatedAt,
          quality: hit.quality,
          hits: hit.hits,
        })),
      };
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
