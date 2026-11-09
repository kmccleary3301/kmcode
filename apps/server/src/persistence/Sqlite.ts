import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as StateDirectoryLock from "./StateDirectoryLock.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // WAL + NORMAL fsyncs only at checkpoints. The default (FULL) fsyncs every commit: ~150/s
    // on km-dev 10-28, which saturated the disk and blocked this synchronous connection for
    // seconds (event-loop stalls, client disconnects). A power loss can drop the newest
    // commits; the database stays consistent and a process crash loses nothing.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // Keep statement journals and sort spills off the main thread's disk path.
    // Large statements and open savepoints can increase peak memory use.
    yield* sql`PRAGMA temp_store = MEMORY;`;
    // Retain the VPS tuning: this is a lazy 1 GiB page-cache ceiling, not a reservation.
    yield* sql`PRAGMA cache_size = -1048576;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    // Older builds ran ANALYZE/optimize at startup. Discard stale stats collected while
    // projection tables were small so SQLite plans for their current size. This runs in a
    // transaction, before any plain read, so the reader connection (opened on the first plain
    // read) never loads the stale stats.
    const clearedStats = yield* sql.withTransaction(
      Effect.gen(function* () {
        const statsTable = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
        if (statsTable.length === 0) return false;
        yield* sql`DELETE FROM sqlite_stat1`;
        return true;
      }),
    );
    if (clearedStats) yield* sql`ANALYZE sqlite_schema`;
    yield* runMigrations();
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layer({
      filename: dbPath,
      checkpointWorker: true,
      readerConnection: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

/**
 * Database for CLI commands that share state with a running server (`auth`, `project`).
 * WAL lets them read and write alongside it, so they never take the state-directory lock.
 */
export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);

/**
 * Database for the serving process. Holds the state-directory lock for the layer's lifetime, so
 * a second server on the same state directory fails before startup recovery touches the database.
 */
export const layerConfigExclusive = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    yield* StateDirectoryLock.acquireStateDirectoryLock(path.dirname(dbPath));
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
