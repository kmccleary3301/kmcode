// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as StateDirectoryLock from "./StateDirectoryLock.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );
const stateDirectoryLockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
process.stdout.write("locked\\n");
process.stdin.once("data", () => process.exit(0));
process.stdin.resume();
`;

const spawnStateDirectoryLockHolder = (lockPath: string) =>
  Effect.promise(
    () =>
      new Promise<NodeChildProcess.ChildProcessWithoutNullStreams>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", stateDirectoryLockHolderSource, lockPath],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let acquired = false;
        holder.stdout.once("data", () => {
          acquired = true;
          resolve(holder);
        });
        holder.once("error", reject);
        holder.once("exit", (code, signal) => {
          if (!acquired) {
            reject(new Error(`State lock holder exited before acquiring the lock (${code ?? signal}).`));
          }
        });
      }),
  );

const releaseStateDirectoryLockHolder = (
  holder: NodeChildProcess.ChildProcessWithoutNullStreams,
) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        if (holder.exitCode !== null || holder.signalCode !== null) {
          resolve();
          return;
        }
        holder.once("exit", () => resolve());
        holder.stdin.write("release", (error) => {
          if (error) reject(error);
        });
      }),
  );

it.effect("rejects a second state database layer before initializing the database", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-state-lock-"));
  const stateDir = NodePath.join(baseDir, "userdata");
  const dbPath = NodePath.join(stateDir, "statev2.sqlite");
  const lockPath = NodePath.join(stateDir, StateDirectoryLock.STATE_DIRECTORY_LOCK_FILE_NAME);
  NodeFS.mkdirSync(stateDir, { recursive: true });

  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const databaseLayer = SqlitePersistence.layerConfigExclusive.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(ServerConfig.layer({ ...config, dbPath })),
      );
      const openDatabase = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1`;
      }).pipe(Effect.provide(databaseLayer));
      const holder = yield* Effect.acquireRelease(
        spawnStateDirectoryLockHolder(lockPath),
        releaseStateDirectoryLockHolder,
      );

      const error = yield* Effect.flip(openDatabase);
      assert.instanceOf(error, StateDirectoryLock.StateDirectoryLockError);
      assert.include(error.message, stateDir);
      assert.isFalse(NodeFS.existsSync(dbPath));

      yield* releaseStateDirectoryLockHolder(holder);
      yield* openDatabase;
      assert.isTrue(NodeFS.existsSync(dbPath));
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(baseDir, baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("lets CLI commands use the database while a server holds the state lock", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-state-shared-"));
  const stateDir = NodePath.join(baseDir, "userdata");
  const dbPath = NodePath.join(stateDir, "statev2.sqlite");
  const lockPath = NodePath.join(stateDir, StateDirectoryLock.STATE_DIRECTORY_LOCK_FILE_NAME);
  NodeFS.mkdirSync(stateDir, { recursive: true });

  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const sharedLayer = SqlitePersistence.layerConfig.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(ServerConfig.layer({ ...config, dbPath })),
      );
      const writeRow = (id: number) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE IF NOT EXISTS cli_probe(id INTEGER PRIMARY KEY)`;
          yield* sql`INSERT INTO cli_probe(id) VALUES (${id})`;
          return yield* sql<{ readonly id: number }>`SELECT id FROM cli_probe ORDER BY id`;
        }).pipe(Effect.provide(sharedLayer));
      yield* writeRow(1);
      yield* Effect.acquireRelease(
        spawnStateDirectoryLockHolder(lockPath),
        releaseStateDirectoryLockHolder,
      );

      const rows = yield* writeRow(2);
      assert.deepEqual([...rows], [{ id: 1 }, { id: 2 }]);
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(baseDir, baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});


it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("shrinks the WAL file back to the size limit after a large write", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-wal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
  // About 25% more 4 KB rows than the limit holds, in one transaction.
  const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
      INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
    `;
    assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);

    // The checkpoint after this large commit copies every frame. A later commit
    // resets the WAL and applies the configured size limit.
    yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
    assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("clears stale planner statistics on database open", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
