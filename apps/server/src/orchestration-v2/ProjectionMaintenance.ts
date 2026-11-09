import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type CompactionOptions = {
  readonly paceBetweenPages?: boolean;
};

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: (options?: CompactionOptions) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly scannedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    /**
     * EventSink commits the event, its projection updates, and projection metadata in one SQL
     * transaction. Startup verification therefore checks that transaction boundary and that every
     * stored projection can be decoded. It intentionally does not replay domain events through a
     * second projector: doing so creates another implementation of projection semantics that must
     * evolve in lockstep with ProjectionStore.
     */
    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
              yield* projectionStore.apply(stored.event);
              if (stored.event.type === "turn-item.updated") {
                yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  run_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.runId},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  run_id = excluded.run_id,
                  ordinal = excluded.ordinal
                `;
              }
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Thread-state events whose payload is the complete thread: only the newest
    // per thread can influence replay. thread.created anchors expected-thread
    // verification and must remain in the log.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.visited",
      "thread.marked-unread",
    ];

    // These event payloads are complete projection snapshots. Other update
    // types can preserve fields from prior events or fan out to more projections.
    const SUPERSEDABLE_SNAPSHOT_EVENT_TYPES = [
      "turn-item.updated",
      "node.updated",
      "message.updated",
      "run-attempt.updated",
      "plan.updated",
      "context-handoff.updated",
      "subagent.updated",
    ];

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const supersedableSnapshotEventTypes = new Set(SUPERSEDABLE_SNAPSHOT_EVENT_TYPES);
    const COMPACTION_PAGE_SIZE = 500;
    const COMPACTION_PAGE_DELAY = Duration.millis(100);
    const COMPACTION_PROGRESS_PAGE_INTERVAL = 100;
    const COMPACTION_SETTLE_HORIZON_MINUTES = 15;
    const COMPACTION_CHECKPOINT_NAME = "event-store-compaction";
    const COMPACTION_CHECKPOINT_SCHEMA_VERSION = 1;

    /**
     * Scan bounded sequence ranges newest-first. The checkpoint skips an event scan
     * only when the log is unchanged; a changed log rescans retained history to
     * rebuild per-entity first/latest state before advancing the settled checkpoint.
     */
    const compactEventStore = (options?: CompactionOptions) => Effect.gen(function* () {
      const checkpointRows = yield* sql<{ readonly last_sequence: number }>`
        SELECT last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = ${COMPACTION_CHECKPOINT_NAME}
        LIMIT 1
      `;
      const compactedThroughSequence = checkpointRows[0]?.last_sequence ?? 0;
      const latestProjectionSequence = yield* eventStore.latestSequence();
      const settledBefore = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, {
          minutes: COMPACTION_SETTLE_HORIZON_MINUTES,
        }),
      );
      const bounds = yield* sql<{
        readonly latest_event_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS latest_event_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `;
      const latestEventSequence = bounds[0]?.latest_event_sequence ?? 0;
      const scanEventLog = latestEventSequence > compactedThroughSequence;
      let scanThroughSequence = latestEventSequence;
      let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedEntityKeys = new Set<string>();
      const retainedSubagentDeliveryKeys = new Set<string>();
      const latestTurnItemSequences = new Map<string, number>();
      const oldestTurnItemSequences = new Map<string, number>();
      let minimumRecentSequence: number | null = null;
      let scannedEventCount = 0;
      let eventPageCount = 0;
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;

      while (scanEventLog && scanThroughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly application_event_version: number;
          readonly aggregate_kind: string;
          readonly stream_id: string;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly imported_legacy_thread: number;
          readonly is_settled: number;
          readonly carries_completion_delivery: number;
        }>`
          SELECT
            event.sequence,
            event.application_event_version,
            event.aggregate_kind,
            event.stream_id,
            event.event_type,
            CASE WHEN event.occurred_at < ${settledBefore} THEN 1 ELSE 0 END AS is_settled,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type IN (
                  'turn-item.updated',
                  'node.updated',
                  'message.updated',
                  'run-attempt.updated',
                  'plan.updated',
                  'context-handoff.updated',
                  'subagent.updated'
                )
              THEN json_extract(event.payload_json, '$.id')
              ELSE NULL
            END AS entity_id,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type = 'subagent.updated'
                AND json_type(event.payload_json, '$.completionDelivery') IS NOT NULL
              THEN 1
              ELSE 0
            END AS carries_completion_delivery,
            CASE
              WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_events AS event
          WHERE event.sequence <= ${scanThroughSequence}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE}
        `;
        if (rows.length === 0) break;
        scannedEventCount += rows.length;
        eventPageCount += 1;

        const obsolete: number[] = [];
        for (const row of rows) {
          if (row.is_settled === 0) {
            minimumRecentSequence =
              minimumRecentSequence === null
                ? row.sequence
                : Math.min(minimumRecentSequence, row.sequence);
            continue;
          }
          if (row.imported_legacy_thread === 1) {
            obsolete.push(row.sequence);
            continue;
          }
          if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              supersedableSnapshotEventTypes.has(row.event_type) &&
              row.entity_id !== null
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              if (row.event_type === "turn-item.updated") {
                const previousOldest = oldestTurnItemSequences.get(key);
                if (previousOldest === undefined) {
                  latestTurnItemSequences.set(key, row.sequence);
                } else if (previousOldest !== latestTurnItemSequences.get(key)) {
                  obsolete.push(previousOldest);
                }
                oldestTurnItemSequences.set(key, row.sequence);
              } else if (row.event_type === "subagent.updated") {
                const isLatest = !retainedEntityKeys.has(key);
                const isLatestDelivery =
                  row.carries_completion_delivery === 1 &&
                  !retainedSubagentDeliveryKeys.has(key);
                if (isLatest) retainedEntityKeys.add(key);
                if (isLatestDelivery) retainedSubagentDeliveryKeys.add(key);
                if (!isLatest && !isLatestDelivery) obsolete.push(row.sequence);
              } else if (retainedEntityKeys.has(key)) {
                obsolete.push(row.sequence);
              } else {
                retainedEntityKeys.add(key);
              }
            }
          }
        }

        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          const deletedRows = yield* sql<{ readonly sequence: number }>`
            DELETE FROM orchestration_events
            WHERE sequence IN ${sql.in(obsolete)}
              AND sequence <> ${latestProjectionSequence}
              AND sequence <> (SELECT MAX(sequence) FROM orchestration_events)
              AND sequence <> (
                SELECT MAX(sequence)
                FROM orchestration_events
                WHERE application_event_version = 2
                  AND aggregate_kind = 'thread'
              )
            RETURNING sequence
          `;
          deletedEventCount += deletedRows.length;
          yield* Effect.yieldNow;
        }
        if (eventPageCount % COMPACTION_PROGRESS_PAGE_INTERVAL === 0) {
          yield* Effect.logInfo("Orchestration event compaction progress", {
            rowsScanned: scannedEventCount,
            rowsDeleted: deletedEventCount,
            currentSequence: rows.at(-1)?.sequence,
          });
        }

        if (rows.length < COMPACTION_PAGE_SIZE) break;
        scanThroughSequence =
          (rows.at(-1)?.sequence ?? 1) - 1;
        if (options?.paceBetweenPages !== false) {
          yield* Effect.sleep(COMPACTION_PAGE_DELAY);
        }
      }

      const settledThroughSequence =
        minimumRecentSequence === null
          ? latestEventSequence
          : Math.max(compactedThroughSequence, minimumRecentSequence - 1);

      if (settledThroughSequence > compactedThroughSequence) {
        const checkpointUpdatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO orchestration_v2_projection_metadata (
            projection_name,
            schema_version,
            last_sequence,
            updated_at
          )
          VALUES (
            ${COMPACTION_CHECKPOINT_NAME},
            ${COMPACTION_CHECKPOINT_SCHEMA_VERSION},
            ${settledThroughSequence},
            ${checkpointUpdatedAt}
          )
          ON CONFLICT(projection_name) DO UPDATE SET
            schema_version = excluded.schema_version,
            last_sequence = excluded.last_sequence,
            updated_at = excluded.updated_at
        `;
      }

      // Legacy receipts are removable only after transcript import completes.
      // Page before LIMIT, and revisit them each pass so interrupted deletes retry.
      while (throughReceiptRowId > 0) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            CASE
              WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = receipt.aggregate_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid DESC
          LIMIT ${COMPACTION_PAGE_SIZE}
        `;
        const obsolete = rows
          .filter((row) => row.imported_legacy_thread === 1)
          .map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughReceiptRowId = (rows.at(-1)?.row_id ?? 1) - 1;
        if (rows.length < COMPACTION_PAGE_SIZE) break;
        if (options?.paceBetweenPages !== false) {
          yield* Effect.sleep(COMPACTION_PAGE_DELAY);
        }
      }

      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return {
        scannedEventCount,
        deletedEventCount,
        deletedReceiptCount,
        reclaimableBytes,
      };
    });
    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore: (options) =>
        mapError("compact event store")(compactEventStore(options)),
    });
  }),
);
export const layerCompactionWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenanceV2;
    const compactOnce = Effect.gen(function* () {
      const exit = yield* Effect.exit(maintenance.compactEventStore());
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
        yield* Effect.logWarning("Orchestration event compaction failed; retrying on next interval", {
          cause: Cause.pretty(exit.cause),
        });
        return;
      }

      yield* Effect.logInfo("Orchestration event compaction completed", {
        rowsScanned: exit.value.scannedEventCount,
        rowsDeleted: exit.value.deletedEventCount,
        receiptsDeleted: exit.value.deletedReceiptCount,
        reclaimableBytes: exit.value.reclaimableBytes,
      });
    });

    yield* forkParked(
      Effect.sleep(Duration.minutes(3)).pipe(
        Effect.andThen(compactOnce.pipe(Effect.repeat(Schedule.spaced(Duration.minutes(10))))),
      ),
    );
  }),
);
