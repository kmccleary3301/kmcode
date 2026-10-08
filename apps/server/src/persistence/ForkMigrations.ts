/**
 * KM Code schema changes live outside upstream's numbered migration ids.
 *
 * Upstream's migrator keys on `migration_id` and skips every id at or below
 * the latest recorded one. Fork builds used to record their own migrations in
 * that id space, and upstream later claimed the same ids, so those databases
 * silently skipped upstream migrations. Fork migrations now run from their own
 * name-keyed ledger, and `reconcileForkMigrationLedger` removes the fork
 * records older builds left in upstream's ledger before the migrator runs.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionTurnNativeCheckpoint from "./ForkMigrations/ProjectionTurnNativeCheckpoint.ts";
import AuthSessionClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import ClearAutomaticProjectModelDefaults from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import ProjectionProjectsAutoPull from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import RepairAutomaticSettlementTimestamps from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";

/** Names fork builds recorded in upstream's ledger, at ids upstream also uses. */
const FORK_LEDGER_NAMES: ReadonlyArray<string> = [
  "ProjectionTurnNativeCheckpoint",
  "RepairAuthSessionClientConnection",
  "ProjectionThreadMessageCreatedSequence",
  "ReplayForkSkippedUpstreamMigrations",
];

/**
 * Upstream migrations at ids fork records displaced. Removing a fork record can
 * leave its id below the latest recorded one, where the migrator never looks,
 * so these run here instead. Each is idempotent: 41 and 45 guard their
 * columns, 44 clears only defaults no project update configured, and 46
 * matches only settlements still stamped with the sweep time.
 */
const DISPLACED_UPSTREAM_MIGRATIONS: Readonly<Record<number, typeof AuthSessionClientConnection>> =
  {
    41: AuthSessionClientConnection,
    44: ClearAutomaticProjectModelDefaults,
    45: ProjectionProjectsAutoPull,
    46: RepairAutomaticSettlementTimestamps,
  };

const forkMigrations = [
  ["ProjectionTurnNativeCheckpoint", ProjectionTurnNativeCheckpoint],
] as const;

export const reconcileForkMigrationLedger = Effect.fn("reconcileForkMigrationLedger")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const manifestNames = new Map(manifest);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
      `;
      const forkIds = history
        .filter(
          (row) =>
            FORK_LEDGER_NAMES.includes(row.name) &&
            manifestNames.get(row.migration_id) !== row.name,
        )
        .map((row) => row.migration_id);
      if (forkIds.length === 0) return [];

      yield* sql`DELETE FROM effect_sql_migrations WHERE ${sql.in("migration_id", forkIds)}`;
      const recordedIds = history
        .map((row) => row.migration_id)
        .filter((id) => !forkIds.includes(id));
      const latestId = Math.max(0, ...recordedIds);
      const executed: Array<readonly [number, string]> = [];
      for (const [id, name] of manifest) {
        if (id > latestId || recordedIds.includes(id)) continue;
        const migration = DISPLACED_UPSTREAM_MIGRATIONS[id];
        if (migration === undefined) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot reconcile KM Code migration history: migration ${id}_${name} was skipped.`,
          });
        }
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        executed.push([id, name]);
      }
      return executed;
    }),
  );
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kmcode_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  const recorded = yield* sql<{ readonly name: string }>`SELECT name FROM kmcode_migrations`;
  const executed: Array<string> = [];
  for (const [name, migration] of forkMigrations) {
    if (recorded.some((row) => row.name === name)) continue;
    yield* sql.withTransaction(
      migration.pipe(Effect.andThen(sql`INSERT INTO kmcode_migrations (name) VALUES (${name})`)),
    );
    executed.push(name);
  }
  return executed;
});
