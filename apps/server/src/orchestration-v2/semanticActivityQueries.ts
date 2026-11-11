import {
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadActivityPage,
  type OrchestrationV2ThreadActivityRow,
  type OrchestrationV2ThreadActivitySummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  decodeThreadActivityCursor,
  encodeThreadActivityCursor,
  THREAD_ACTIVITY_PAGE_LIMIT,
  type ThreadActivityCursorPayload,
} from "./threadHistoryPaging.ts";

/**
 * Indexed SQL activity summaries and pages for summary-v1 semantic sync.
 *
 * Groups are user turns. A group starts at each visible turn-start user message
 * (`inputIntent` `turn_start` or `queued_turn`) and runs until the next visible
 * turn start in the same source. Rows before a thread's first turn start form a
 * leading group whose head is the first visible row. Run id changes do not split
 * groups.
 *
 * Activity rows are group rows except user and assistant messages. Summaries use
 * scalar aggregates over one group's range. Pages read at most one bounded window
 * of activity rows, plus EXISTS lookaheads for the adjacent cursors.
 *
 * Every query is bounded by the group's range, the fork cutoff, and the primary
 * key or the `(thread_id, ordinal, turn_item_id)` index. No query reads a whole
 * thread history.
 */

export type SemanticActivitySource = {
  readonly threadId: string;
  /** Highest ordinal visible from this source (fork cutoff), or null for all rows. */
  readonly maxOrdinal: number | null;
};

export type SemanticActivityQueryError =
  | { readonly _tag: "InvalidActivityCursor" }
  | { readonly _tag: "InvalidActivityRequest"; readonly reason: string }
  | {
      readonly _tag: "ActivityNotFound";
      readonly sourceThreadId?: string | undefined;
      readonly groupStartItemId?: string | undefined;
      readonly anchorItemId?: string | undefined;
    }
  | { readonly _tag: "ThreadNotFound"; readonly threadId: string }
  | { readonly _tag: "ReadError"; readonly cause: unknown };

export type SemanticActivitySummarySource = SemanticActivitySource & {
  /** Ordinal window of this source to summarize. Only groups overlapping it are returned. */
  readonly ordinalRange: { readonly from: number; readonly to: number };
};

export type SemanticActivitySummaryInput = {
  readonly threadId: string;
  readonly sources: ReadonlyArray<SemanticActivitySummarySource>;
};

export type SemanticActivityPageInput = {
  readonly threadId: string;
  readonly sources: ReadonlyArray<SemanticActivitySource>;
  readonly sourceThreadId?: string | undefined;
  readonly groupStartItemId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly anchorItemId?: string | undefined;
  readonly limit?: number | undefined;
  readonly summaryOnly?: boolean | undefined;
};

type ItemRow = {
  readonly turn_item_id: string;
  readonly ordinal: number;
  readonly run_id: string | null;
  readonly type: string;
  readonly status: string;
  readonly payload_json: string;
  readonly input_intent: string | null;
};

type ActivityGroup = {
  readonly source: SemanticActivitySource;
  readonly head: ItemRow;
  /** Ordinal of the next visible turn start in this source, or null for the last group. */
  readonly nextOrdinal: number | null;
};

type GroupScalarRow = {
  readonly activity_count: number;
  readonly step_count: number;
  readonly files_edited_count: number;
  readonly added: number;
  readonly removed: number;
  readonly has_failure: number;
  readonly started_activity: string | null;
  readonly completed_activity: string | null;
  readonly started_all: string | null;
  readonly completed_all: string | null;
};

type CountRow = { readonly key: string; readonly count: number };

const SEMANTIC_ERROR_TAGS: Record<string, true> = {
  InvalidActivityCursor: true,
  InvalidActivityRequest: true,
  ActivityNotFound: true,
  ThreadNotFound: true,
  ReadError: true,
};

const PREVIEW_MAX_LENGTH = 160;
const DEFAULT_LIMIT = THREAD_ACTIVITY_PAGE_LIMIT;

const decodeTurnItemPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const decodeOptionalDate = Schema.decodeUnknownEffect(Schema.NullOr(Schema.DateTimeUtcFromString));

const readError = (cause: unknown): SemanticActivityQueryError => ({ _tag: "ReadError", cause });

const normalizeError = (cause: unknown): SemanticActivityQueryError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string" &&
  Object.hasOwn(SEMANTIC_ERROR_TAGS, cause._tag)
    ? (cause as SemanticActivityQueryError)
    : readError(cause);

const isTurnStartRow = (row: ItemRow): boolean =>
  row.type === "user_message" &&
  (row.input_intent === "turn_start" || row.input_intent === "queued_turn");

const isActivityRow = (row: ItemRow): boolean =>
  row.type !== "user_message" && row.type !== "assistant_message";

const preview = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, PREVIEW_MAX_LENGTH);
};

// Min/max over nullable ISO timestamps; ISO UTC strings order lexicographically.
const earliest = (values: ReadonlyArray<string | null>): string | null =>
  values.reduce<string | null>(
    (best, value) => (value === null ? best : best === null || value < best ? value : best),
    null,
  );

const latest = (values: ReadonlyArray<string | null>): string | null =>
  values.reduce<string | null>(
    (best, value) => (value === null ? best : best === null || value > best ? value : best),
    null,
  );

// Visibility mirrors `createOrchestrationV2TurnItemVisibility` in
// `@t3tools/shared/orchestrationV2Timeline`. Requires the outer query to alias
// `orchestration_v2_projection_turn_items` as `item`.
const visibleItem = (sql: SqlClient.SqlClient) =>
  sql.literal(`(
    NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS hidden_run
      WHERE hidden_run.run_id = item.run_id AND hidden_run.status = 'rolled_back'
    )
    AND NOT (
      item.type = 'user_message'
      AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS cancelled_run
        WHERE cancelled_run.run_id = item.run_id AND cancelled_run.status = 'cancelled'
      )
    )
    AND NOT (
      item.type = 'run_interrupt_result'
      AND item.run_id IS NOT NULL
      AND item.node_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_run_attempts AS superseded_attempt
        WHERE superseded_attempt.run_id = item.run_id
          AND superseded_attempt.root_node_id = item.node_id
          AND superseded_attempt.status = 'superseded'
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS interrupt_request
        WHERE interrupt_request.thread_id = item.thread_id
          AND interrupt_request.type = 'run_interrupt_request'
          AND interrupt_request.run_id = item.run_id
      )
    )
  )`);

const activityItem = (sql: SqlClient.SqlClient) =>
  sql.literal(`(item.type NOT IN ('user_message', 'assistant_message'))`);

const turnStartItem = (sql: SqlClient.SqlClient) =>
  sql.literal(`(
    item.type = 'user_message'
    AND json_extract(item.payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
  )`);

const itemColumns = (sql: SqlClient.SqlClient) =>
  sql.literal(`
    item.turn_item_id AS turn_item_id,
    item.ordinal AS ordinal,
    item.run_id AS run_id,
    item.type AS type,
    item.status AS status,
    item.payload_json AS payload_json,
    json_extract(item.payload_json, '$.inputIntent') AS input_intent
  `);

const itemScope = (sql: SqlClient.SqlClient, source: SemanticActivitySource) =>
  sql`item.thread_id = ${source.threadId}
    AND (${source.maxOrdinal} IS NULL OR item.ordinal <= ${source.maxOrdinal})
    AND ${visibleItem(sql)}`;

const groupScope = (sql: SqlClient.SqlClient, group: ActivityGroup) =>
  sql`${itemScope(sql, group.source)}
    AND item.ordinal >= ${group.head.ordinal}
    AND (${group.nextOrdinal} IS NULL OR item.ordinal < ${group.nextOrdinal})`;

/** Last visible turn start at or before `ordinal`, or the leading group head when none exists. */
const findGroupHead = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
  ordinal: number,
): Effect.Effect<ItemRow | undefined, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const turnStarts = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${itemScope(sql, source)}
        AND item.ordinal <= ${ordinal}
        AND ${turnStartItem(sql)}
      ORDER BY item.ordinal DESC
      LIMIT 1
    `;
    const turnStart = turnStarts[0];
    if (turnStart !== undefined) return turnStart;
    const leading = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${itemScope(sql, source)}
        AND item.ordinal <= ${ordinal}
      ORDER BY item.ordinal ASC
      LIMIT 1
    `;
    return leading[0];
  }).pipe(Effect.mapError(readError));

const findFirstVisibleItem = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
): Effect.Effect<ItemRow | undefined, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const rows = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${itemScope(sql, source)}
      ORDER BY item.ordinal ASC
      LIMIT 1
    `;
    return rows[0];
  }).pipe(Effect.mapError(readError));

const findItemById = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
  itemId: string,
): Effect.Effect<ItemRow | undefined, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const rows = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE item.turn_item_id = ${itemId}
        AND ${itemScope(sql, source)}
      LIMIT 1
    `;
    return rows[0];
  }).pipe(Effect.mapError(readError));

/** Ordinal of the next visible turn start after `headOrdinal`, or null for the last group. */
const findNextGroupOrdinal = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
  headOrdinal: number,
): Effect.Effect<number | null, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly ordinal: number }>`
      SELECT item.ordinal AS ordinal
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${itemScope(sql, source)}
        AND item.ordinal > ${headOrdinal}
        AND ${turnStartItem(sql)}
      ORDER BY item.ordinal ASC
      LIMIT 1
    `;
    return rows[0]?.ordinal ?? null;
  }).pipe(Effect.mapError(readError));

/** Visible turn starts in `(from, to]`, in order. Bounded by the selected range. */
const findTurnStartsInRange = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
  range: { readonly from: number; readonly to: number },
): Effect.Effect<ReadonlyArray<ItemRow>, SemanticActivityQueryError> =>
  sql<ItemRow>`
    SELECT ${itemColumns(sql)}
    FROM orchestration_v2_projection_turn_items AS item
    WHERE ${itemScope(sql, source)}
      AND item.ordinal > ${range.from}
      AND item.ordinal <= ${range.to}
      AND ${turnStartItem(sql)}
    ORDER BY item.ordinal ASC
  `.pipe(Effect.mapError(readError));

const resolveGroupOf = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
  row: ItemRow,
): Effect.Effect<ActivityGroup | undefined, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const head = yield* findGroupHead(sql, source, row.ordinal);
    if (head === undefined) return undefined;
    const nextOrdinal = yield* findNextGroupOrdinal(sql, source, head.ordinal);
    return { source, head, nextOrdinal };
  });

const groupsInRange = (
  sql: SqlClient.SqlClient,
  source: SemanticActivitySource,
  range: { readonly from: number; readonly to: number },
): Effect.Effect<ReadonlyArray<ActivityGroup>, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const heads: Array<ItemRow> = [];
    const containing = yield* findGroupHead(sql, source, range.from);
    if (containing !== undefined) {
      heads.push(containing);
    } else {
      // No visible row at or before `from`. A non-turn-start first row is a leading group head.
      const first = yield* findFirstVisibleItem(sql, source);
      if (first !== undefined && first.ordinal <= range.to && !isTurnStartRow(first)) {
        heads.push(first);
      }
    }
    heads.push(...(yield* findTurnStartsInRange(sql, source, range)));
    const groups: Array<ActivityGroup> = [];
    for (const head of heads) {
      const nextOrdinal = yield* findNextGroupOrdinal(sql, source, head.ordinal);
      groups.push({ source, head, nextOrdinal });
    }
    return groups;
  });

const firstPreviewText = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
  path: string,
): Effect.Effect<string | null, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly text: string | null }>`
      SELECT json_extract(item.payload_json, ${path}) AS text
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
        AND ${activityItem(sql)}
        AND TRIM(COALESCE(json_extract(item.payload_json, ${path}), '')) <> ''
      ORDER BY item.ordinal ASC
      LIMIT 1
    `;
    return preview(rows[0]?.text ?? null);
  }).pipe(Effect.mapError(readError));

const summarizeGroup = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
): Effect.Effect<OrchestrationV2ThreadActivitySummary, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const { source, head } = group;

    const scalarRows = yield* sql<GroupScalarRow>`
      SELECT
        COALESCE(SUM(CASE WHEN ${activityItem(sql)} THEN 1 ELSE 0 END), 0) AS activity_count,
        COALESCE(SUM(CASE WHEN ${activityItem(sql)} AND item.type <> 'reasoning' THEN 1 ELSE 0 END), 0) AS step_count,
        COUNT(DISTINCT CASE WHEN item.type = 'file_change' THEN json_extract(item.payload_json, '$.fileName') END) AS files_edited_count,
        COALESCE(SUM(CASE WHEN item.type = 'file_change' THEN json_extract(item.payload_json, '$.additions') END), 0) AS added,
        COALESCE(SUM(CASE WHEN item.type = 'file_change' THEN json_extract(item.payload_json, '$.deletions') END), 0) AS removed,
        COALESCE(MAX(CASE WHEN ${activityItem(sql)}
          AND (item.status = 'failed'
            OR item.type = 'error'
            OR json_extract(item.payload_json, '$.outputIndicatesFailure') = 1)
          THEN 1 ELSE 0 END), 0) AS has_failure,
        MIN(CASE WHEN ${activityItem(sql)} THEN json_extract(item.payload_json, '$.startedAt') END) AS started_activity,
        MAX(CASE WHEN ${activityItem(sql)} THEN json_extract(item.payload_json, '$.completedAt') END) AS completed_activity,
        MIN(json_extract(item.payload_json, '$.startedAt')) AS started_all,
        MAX(json_extract(item.payload_json, '$.completedAt')) AS completed_all
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
    `.pipe(Effect.mapError(readError));
    const scalars = scalarRows[0];
    if (scalars === undefined) {
      return yield* Effect.fail(readError("missing group aggregate"));
    }

    const countsByType = yield* sql<CountRow>`
      SELECT item.type AS key, COUNT(*) AS count
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
        AND ${activityItem(sql)}
      GROUP BY item.type
      ORDER BY MIN(item.ordinal) ASC
    `.pipe(Effect.mapError(readError));
    const statusCounts = yield* sql<CountRow>`
      SELECT item.status AS key, COUNT(*) AS count
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
        AND ${activityItem(sql)}
      GROUP BY item.status
      ORDER BY MIN(item.ordinal) ASC
    `.pipe(Effect.mapError(readError));

    const firstActivityRows = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
        AND ${activityItem(sql)}
      ORDER BY item.ordinal ASC
      LIMIT 1
    `.pipe(Effect.mapError(readError));
    const lastActivityRows = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
        AND ${activityItem(sql)}
      ORDER BY item.ordinal DESC
      LIMIT 1
    `.pipe(Effect.mapError(readError));
    const first = firstActivityRows[0] ?? head;
    let last = lastActivityRows[0];
    if (last === undefined) {
      const tailRows = yield* sql<ItemRow>`
        SELECT ${itemColumns(sql)}
        FROM orchestration_v2_projection_turn_items AS item
        WHERE ${groupScope(sql, group)}
        ORDER BY item.ordinal DESC
        LIMIT 1
      `.pipe(Effect.mapError(readError));
      last = tailRows[0] ?? head;
    }

    const labelText = yield* firstPreviewText(sql, group, "$.title");
    const intentText = yield* firstPreviewText(sql, group, "$.intent");

    const runId = head.run_id;
    let runStatus: string | null = null;
    if (runId !== null) {
      const runRows = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${runId}
          AND thread_id = ${source.threadId}
        LIMIT 1
      `.pipe(Effect.mapError(readError));
      runStatus = runRows[0]?.status ?? null;
    }

    const hasActivity = scalars.activity_count > 0;
    const startedAt = yield* decodeOptionalDate(
      hasActivity ? scalars.started_activity : scalars.started_all,
    ).pipe(Effect.mapError(readError));
    const endedAt = yield* decodeOptionalDate(
      hasActivity ? scalars.completed_activity : scalars.completed_all,
    ).pipe(Effect.mapError(readError));

    return {
      sourceThreadId: ThreadId.make(source.threadId),
      groupStartItemId: TurnItemId.make(head.turn_item_id),
      turnStartItemId: isTurnStartRow(head) ? TurnItemId.make(head.turn_item_id) : null,
      runId: runId === null ? null : RunId.make(runId),
      firstItemId: TurnItemId.make(first.turn_item_id),
      firstOrdinal: first.ordinal,
      lastItemId: TurnItemId.make(last.turn_item_id),
      lastOrdinal: last.ordinal,
      activityCount: scalars.activity_count,
      countsByType: countsByType.map((row) => ({ type: row.key, count: row.count })),
      statusCounts: statusCounts.map((row) => ({ status: row.key, count: row.count })),
      runStatus,
      stepCount: scalars.step_count,
      filesEditedCount: scalars.files_edited_count,
      diffStats: { added: scalars.added, removed: scalars.removed },
      hasFailure: scalars.has_failure === 1,
      labelPreview: labelText,
      intentPreview: intentText,
      startedAt,
      endedAt,
    };
  });

const readSnapshotSequence = (
  sql: SqlClient.SqlClient,
  threadId: string,
): Effect.Effect<number, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
      SELECT MAX(sequence) AS snapshot_sequence
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id = ${threadId}
    `;
    return rows[0]?.snapshot_sequence ?? 0;
  }).pipe(Effect.mapError(readError));

// Activity windows. Each returns at most `limit` rows ordered by ordinal ascending.
const activityFrom = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
  ordinal: number,
  limit: number,
): Effect.Effect<ReadonlyArray<ItemRow>, SemanticActivityQueryError> =>
  sql<ItemRow>`
    SELECT ${itemColumns(sql)}
    FROM orchestration_v2_projection_turn_items AS item
    WHERE ${groupScope(sql, group)}
      AND item.ordinal >= ${ordinal}
      AND ${activityItem(sql)}
    ORDER BY item.ordinal ASC
    LIMIT ${limit}
  `.pipe(Effect.mapError(readError));

/** Nearest activity rows strictly before `ordinal`, returned in ascending order. */
const activityBefore = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
  ordinal: number,
  limit: number,
): Effect.Effect<ReadonlyArray<ItemRow>, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    if (limit <= 0) return [];
    const rows = yield* sql<ItemRow>`
      SELECT ${itemColumns(sql)}
      FROM orchestration_v2_projection_turn_items AS item
      WHERE ${groupScope(sql, group)}
        AND item.ordinal < ${ordinal}
        AND ${activityItem(sql)}
      ORDER BY item.ordinal DESC
      LIMIT ${limit}
    `.pipe(Effect.mapError(readError));
    return rows.toReversed();
  });

const hasActivityBefore = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
  ordinal: number,
): Effect.Effect<boolean, SemanticActivityQueryError> =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found
    FROM orchestration_v2_projection_turn_items AS item
    WHERE ${groupScope(sql, group)}
      AND item.ordinal < ${ordinal}
      AND ${activityItem(sql)}
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.mapError(readError),
  );

const hasActivityAfter = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
  ordinal: number,
): Effect.Effect<boolean, SemanticActivityQueryError> =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found
    FROM orchestration_v2_projection_turn_items AS item
    WHERE ${groupScope(sql, group)}
      AND item.ordinal > ${ordinal}
      AND ${activityItem(sql)}
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.mapError(readError),
  );

type WindowMode =
  | { readonly kind: "group" }
  | { readonly kind: "anchor"; readonly ordinal: number }
  | { readonly kind: "cursor"; readonly cursor: ThreadActivityCursorPayload };

const loadWindow = (
  sql: SqlClient.SqlClient,
  group: ActivityGroup,
  mode: WindowMode,
  limit: number,
): Effect.Effect<ReadonlyArray<ItemRow>, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    if (mode.kind === "group") {
      return yield* activityFrom(sql, group, group.head.ordinal, limit);
    }
    if (mode.kind === "cursor") {
      if (mode.cursor.direction === "previous") {
        return yield* activityBefore(sql, group, mode.cursor.ordinal, limit);
      }
      return yield* activityFrom(sql, group, mode.cursor.ordinal + 1, limit);
    }
    // Anchor: up to half the window before the anchor, the rest from the anchor onward.
    // Unused "before" budget spills to the rows before the anchor.
    const before = yield* activityBefore(sql, group, mode.ordinal, Math.floor(limit / 2));
    const after = yield* activityFrom(sql, group, mode.ordinal, limit - before.length);
    if (after.length < limit - before.length) {
      const extendedBefore = yield* activityBefore(sql, group, mode.ordinal, limit - after.length);
      return [...extendedBefore, ...after];
    }
    return [...before, ...after];
  });

const loadPayloadItems = (
  threadId: string,
  source: SemanticActivitySource,
  rows: ReadonlyArray<ItemRow>,
): Effect.Effect<ReadonlyArray<OrchestrationV2ThreadActivityRow>, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const sourceId = ThreadId.make(source.threadId);
    const visibility = source.threadId === threadId ? "local" : "inherited";
    const items: Array<OrchestrationV2ThreadActivityRow> = [];
    for (const row of rows) {
      const item = yield* decodeTurnItemPayload(row.payload_json).pipe(Effect.mapError(readError));
      const itemId = TurnItemId.make(row.turn_item_id);
      items.push({
        sourceThreadId: sourceId,
        sourceItemId: itemId,
        visibility,
        ordinal: row.ordinal,
        item,
        orderKey: { sourceThreadId: sourceId, ordinal: row.ordinal, itemId },
      });
    }
    return items;
  });

/**
 * Returns summaries for the visible groups of each source that overlap that source's
 * `ordinalRange`, in source order and group order. Each group is summarized with scalar
 * aggregates over its own range; no source index is loaded.
 *
 * Opens no transaction. The caller owns the transaction and must hold it across this call
 * so the summary reads share the caller's snapshot.
 */
export const getSemanticActivitySummaries = (
  sql: SqlClient.SqlClient,
  input: SemanticActivitySummaryInput,
): Effect.Effect<ReadonlyArray<OrchestrationV2ThreadActivitySummary>, SemanticActivityQueryError> =>
  Effect.gen(function* () {
    const summaries: Array<OrchestrationV2ThreadActivitySummary> = [];
    for (const source of input.sources) {
      for (const group of yield* groupsInRange(sql, source, source.ordinalRange)) {
        summaries.push(yield* summarizeGroup(sql, group));
      }
    }
    return summaries;
  }).pipe(Effect.mapError(normalizeError));

/**
 * Returns one group's summary and a bounded window of its activity rows, read in a
 * single transaction with the thread's snapshot sequence.
 *
 * Targets: `cursor` (adjacent window), `anchorItemId` (window around the anchor),
 * or `groupStartItemId` (first window of that group).
 */
export const getSemanticActivityPage = (
  sql: SqlClient.SqlClient,
  input: SemanticActivityPageInput,
): Effect.Effect<OrchestrationV2ThreadActivityPage, SemanticActivityQueryError> =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        if (input.cursor !== undefined && input.anchorItemId !== undefined) {
          return yield* Effect.fail({
            _tag: "InvalidActivityRequest",
            reason: "cursor and anchorItemId are mutually exclusive",
          } as const);
        }
        if (
          input.cursor === undefined &&
          input.groupStartItemId === undefined &&
          input.anchorItemId === undefined
        ) {
          return yield* Effect.fail({
            _tag: "InvalidActivityRequest",
            reason: "groupStartItemId or anchorItemId is required",
          } as const);
        }
        if (input.sources.length === 0) {
          return yield* Effect.fail({ _tag: "ThreadNotFound", threadId: input.threadId } as const);
        }

        const cursor =
          input.cursor === undefined
            ? undefined
            : yield* Effect.try({
                try: () => decodeThreadActivityCursor(input.cursor as string),
                catch: (): SemanticActivityQueryError => ({ _tag: "InvalidActivityCursor" }),
              });
        if (
          cursor !== undefined &&
          (cursor.threadId !== input.threadId ||
            (input.sourceThreadId !== undefined &&
              input.sourceThreadId !== cursor.sourceThreadId) ||
            (input.groupStartItemId !== undefined &&
              input.groupStartItemId !== cursor.groupStartItemId))
        ) {
          return yield* Effect.fail({ _tag: "InvalidActivityCursor" } as const);
        }

        const snapshotSequence = yield* readSnapshotSequence(sql, input.threadId);
        const limit =
          input.limit === undefined || !Number.isFinite(input.limit)
            ? DEFAULT_LIMIT
            : Math.min(DEFAULT_LIMIT, Math.max(1, Math.floor(input.limit)));

        const candidates =
          cursor !== undefined
            ? input.sources.filter((source) => source.threadId === cursor.sourceThreadId)
            : input.sourceThreadId !== undefined
              ? input.sources.filter((source) => source.threadId === input.sourceThreadId)
              : input.sources;
        const notFound: SemanticActivityQueryError =
          cursor !== undefined
            ? { _tag: "InvalidActivityCursor" }
            : {
                _tag: "ActivityNotFound",
                sourceThreadId: input.sourceThreadId,
                groupStartItemId: input.groupStartItemId,
                anchorItemId: input.anchorItemId,
              };
        if (candidates.length === 0) {
          return yield* Effect.fail(notFound);
        }

        // The target row is the cursor row, the anchor, or the group start itself.
        const targetRowId = cursor?.sourceItemId ?? input.anchorItemId ?? input.groupStartItemId;
        const requiredHeadId = cursor?.groupStartItemId ?? input.groupStartItemId;
        let found: { readonly group: ActivityGroup; readonly row: ItemRow } | undefined;
        if (targetRowId !== undefined) {
          for (const source of candidates) {
            const row = yield* findItemById(sql, source, targetRowId);
            if (row === undefined) continue;
            const group = yield* resolveGroupOf(sql, source, row);
            if (group === undefined) continue;
            if (requiredHeadId !== undefined && group.head.turn_item_id !== requiredHeadId)
              continue;
            if (cursor !== undefined && (row.ordinal !== cursor.ordinal || !isActivityRow(row))) {
              continue;
            }
            found = { group, row };
            break;
          }
        }
        if (found === undefined) {
          return yield* Effect.fail(notFound);
        }

        const { group, row } = found;
        const mode: WindowMode =
          cursor !== undefined
            ? { kind: "cursor", cursor }
            : input.anchorItemId !== undefined
              ? { kind: "anchor", ordinal: row.ordinal }
              : { kind: "group" };
        const pageRows = yield* loadWindow(sql, group, mode, limit);

        const firstInPage = pageRows[0];
        const lastInPage = pageRows.at(-1);
        const hasPrevious =
          firstInPage !== undefined
            ? yield* hasActivityBefore(sql, group, firstInPage.ordinal)
            : cursor?.direction === "next";
        const hasNext =
          lastInPage !== undefined
            ? yield* hasActivityAfter(sql, group, lastInPage.ordinal)
            : cursor?.direction === "previous";

        const groupStartItemId = group.head.turn_item_id;
        const previousCursor =
          hasPrevious && firstInPage !== undefined
            ? yield* Effect.try({
                try: () =>
                  encodeThreadActivityCursor({
                    v: 1,
                    threadId: input.threadId,
                    sourceThreadId: group.source.threadId,
                    groupStartItemId,
                    ordinal: firstInPage.ordinal,
                    sourceItemId: firstInPage.turn_item_id,
                    direction: "previous",
                  } satisfies ThreadActivityCursorPayload),
                catch: readError,
              })
            : null;
        const nextCursor =
          hasNext && lastInPage !== undefined
            ? yield* Effect.try({
                try: () =>
                  encodeThreadActivityCursor({
                    v: 1,
                    threadId: input.threadId,
                    sourceThreadId: group.source.threadId,
                    groupStartItemId,
                    ordinal: lastInPage.ordinal,
                    sourceItemId: lastInPage.turn_item_id,
                    direction: "next",
                  } satisfies ThreadActivityCursorPayload),
                catch: readError,
              })
            : null;

        const items =
          input.summaryOnly === true
            ? []
            : yield* loadPayloadItems(input.threadId, group.source, pageRows);
        const summary = yield* summarizeGroup(sql, group);

        return {
          snapshotSequence,
          sourceThreadId: ThreadId.make(group.source.threadId),
          groupStartItemId: TurnItemId.make(groupStartItemId),
          summary,
          items,
          previousCursor,
          nextCursor,
          hasPrevious,
          hasNext,
        } satisfies OrchestrationV2ThreadActivityPage;
      }),
    )
    .pipe(Effect.mapError(normalizeError));
