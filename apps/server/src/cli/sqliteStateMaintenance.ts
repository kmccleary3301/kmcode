import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as StateDirectoryLock from "../persistence/StateDirectoryLock.ts";

export class SqliteStateDatabaseMissingError extends Schema.TaggedError<SqliteStateDatabaseMissingError>()(
  "SqliteStateDatabaseMissingError",
  { databasePath: Schema.String },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'. Start T3 once to run migrations.`;
  }
}

export class SqliteStateOfflineMaintenanceRequiredError extends Schema.TaggedError<SqliteStateOfflineMaintenanceRequiredError>()(
  "SqliteStateOfflineMaintenanceRequiredError",
  {},
) {
  override get message(): string {
    return "Offline database compaction requires the explicit --offline-maintenance option.";
  }
}

export class SqliteStateMaintenanceDatabaseError extends Schema.TaggedError<SqliteStateMaintenanceDatabaseError>()(
  "SqliteStateMaintenanceDatabaseError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to compact SQLite database at '${this.databasePath}'.`;
  }
}

export class SqliteStateMaintenanceError extends Schema.TaggedError<SqliteStateMaintenanceError>()(
  "SqliteStateMaintenanceError",
  {
    databasePath: Schema.String,
    backupPath: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not safely compact '${this.databasePath}' (${this.reason}). The original backup is preserved at '${this.backupPath}'.`;
  }
}

const isSqliteStateMaintenanceError = Schema.is(SqliteStateMaintenanceError);

export interface SqliteStateMaintenanceResult {
  readonly operation: "compact";
  readonly database: string;
  readonly backup: string;
  readonly scannedEventCount: number;
  readonly deletedEventCount: number;
  readonly deletedReceiptCount: number;
  readonly reclaimableBytes: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export const compactStateDatabase = Effect.fn("compactStateDatabase")(function* (input: {
  readonly baseDir: string;
  readonly offlineMaintenance: boolean;
}) {
  if (!input.offlineMaintenance) return yield* new SqliteStateOfflineMaintenanceRequiredError();

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = path.resolve(input.baseDir);
  const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");
  if (!(yield* fs.exists(databasePath))) {
    return yield* new SqliteStateDatabaseMissingError({ databasePath });
  }

  const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
  const crypto = yield* Crypto.Crypto;
  const backupId = yield* crypto.randomUUIDv4;
  const backupPath = `${databasePath}.backup-${timestamp}-${backupId}`;
  const database = NodeSqliteClient.layer({ filename: databasePath });
  const layerMaintenanceDependencies = Layer.mergeAll(
    database,
    EventStore.layer.pipe(Layer.provide(database)),
    ProjectionStore.layer.pipe(Layer.provide(database)),
  );
  const layerDatabase = Layer.mergeAll(
    database,
    ProjectionMaintenance.layer.pipe(Layer.provide(layerMaintenanceDependencies)),
  );
  let backupCreated = false;
  const compactProgram = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;
    yield* sql`VACUUM INTO ${backupPath}`;
    backupCreated = true;
    yield* fs.chmod(backupPath, 0o600);
    const bytesBefore = Number((yield* fs.stat(databasePath)).size);

    const validateIntegrity = (stage: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
        if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
          return yield* new SqliteStateMaintenanceError({
            databasePath,
            backupPath,
            reason: `SQLite integrity validation failed ${stage}`,
          });
        }
      });
    const validateProjection = (stage: string) =>
      maintenance.verify.pipe(
        Effect.flatMap((verification) =>
          verification.valid
            ? Effect.void
            : Effect.fail(
                new SqliteStateMaintenanceError({
                  databasePath,
                  backupPath,
                  reason: `projection validation failed ${stage}`,
                }),
              ),
        ),
      );

    yield* validateIntegrity("before compaction");
    yield* validateProjection("before compaction");
    const summary = yield* maintenance.compactEventStore({ paceBetweenPages: false });
    yield* sql`VACUUM`;
    const checkpoint = yield* sql<{ readonly busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`;
    if (checkpoint[0]?.busy !== 0) {
      return yield* new SqliteStateMaintenanceError({
        databasePath,
        backupPath,
        reason: "WAL checkpoint could not complete while offline",
      });
    }
    yield* validateIntegrity("after compaction");
    yield* validateProjection("after compaction");

    return {
      operation: "compact",
      database: databasePath,
      backup: backupPath,
      scannedEventCount: summary.scannedEventCount,
      deletedEventCount: summary.deletedEventCount,
      deletedReceiptCount: summary.deletedReceiptCount,
      reclaimableBytes: summary.reclaimableBytes,
      bytesBefore,
      bytesAfter: Number((yield* fs.stat(databasePath)).size),
    } satisfies SqliteStateMaintenanceResult;
  });
  const databaseEffect = compactProgram.pipe(
    Effect.provide(layerDatabase),
    Effect.mapError((cause) => {
      if (!backupCreated) return new SqliteStateMaintenanceDatabaseError({ databasePath, cause });
      if (isSqliteStateMaintenanceError(cause)) return cause;
      return new SqliteStateMaintenanceError({
        databasePath,
        backupPath,
        reason: "compaction failed; restore the preserved backup if needed",
        cause,
      });
    }),
  );

  return yield* StateDirectoryLock.withStateDirectoryLock(
    path.dirname(databasePath),
    databaseEffect,
  );
});
