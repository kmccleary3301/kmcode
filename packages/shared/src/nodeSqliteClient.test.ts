import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";
const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(
          ...((failingWorkers.message === undefined
            ? args
            : [
                `throw new Error(${JSON.stringify(failingWorkers.message)});`,
                { eval: true },
              ]) as ConstructorParameters<typeof actual.Worker>),
        );
        startedWorkers.push(this);
      }
    },
  };
});

const sqliteVersionDatabase = new NodeSqlite.DatabaseSync(":memory:");
const sqliteVersion = String(
  sqliteVersionDatabase.prepare("SELECT sqlite_version() AS version").get()?.version,
);
sqliteVersionDatabase.close();
const [sqliteMajor = 0, sqliteMinor = 0] = sqliteVersion.split(".").map(Number);
const supportsNoopCheckpoint = sqliteMajor > 3 || (sqliteMajor === 3 && sqliteMinor >= 51);
const largeText = "x".repeat(64 * 1024 + 1);

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );

  it.effect("uses caller safe-integer settings for cached and uncached value queries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const value of ["small", largeText]) {
        const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
        assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
          [1n, BigInt(value.length)],
        ]);
        assert.deepEqual(yield* values, [[1, value.length]]);
      }
    }),
  );

  it.effect("does not evaluate named parameter getters while choosing the statement cache", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const throwing = {
        get $value(): string {
          throw new Error("unreadable");
        },
      };
      const error = yield* sql
        .unsafe("SELECT length($value) AS size", [throwing])
        .pipe(Effect.flip);
      assert.equal(error.reason.operation, "execute");

      let reads = 0;
      const counting = {
        get $value(): number {
          return ++reads;
        },
      };
      assert.deepEqual(yield* sql.unsafe("SELECT $value AS value", [counting]), [{ value: 1 }]);
      assert.equal(reads, 1);
    }),
  );
});
it.effect("keeps large text and blob parameters off cached statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
    const preparedStatements = new Map<string, number>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: NodeSqlite.DatabaseSync,
          ...args
        ) {
          const statement = prepare.apply(this, args);
          const query = args[0];
          preparedStatements.set(query, (preparedStatements.get(query) ?? 0) + 1);
          return statement;
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const queries = [
      (value: string | Uint8Array) => sql`SELECT length(${value}) AS size`,
      (value: string | Uint8Array) =>
        sql.unsafe("SELECT length($value) AS size", [{ $value: value }]),
      (value: string | Uint8Array) =>
        sql.unsafe("SELECT length($value) AS callable", [
          Object.assign(() => {}, { $value: value }),
        ]),
    ];
    const largeBlobs = [new Uint8Array(64 * 1024 + 1)];
    for (const value of ["small", largeText, ...largeBlobs, "small"]) {
      const expected = typeof value === "string" ? value.length : value.byteLength;
      for (const query of queries) {
        assert.deepEqual(yield* query(value).values, [[expected]]);
      }
    }

    assert.equal(preparedStatements.size, queries.length);
    assert.deepEqual([...preparedStatements.values()], [3, 3, 3]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("cancels a transaction waiting for connection ownership", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ownership_probe(value INTEGER)`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);
      const entered = yield* Deferred.make<void>();
      const waiter = yield* Effect.forkChild(
        sql.withTransaction(
          sql`INSERT INTO ownership_probe VALUES (1)`.pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
          ),
        ),
        { startImmediately: true },
      );
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(waiter), {
        startImmediately: true,
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      assert.isFalse(yield* Deferred.isDone(entered));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(interrupted);
      assert.isFalse(yield* Deferred.isDone(entered));

      yield* sql.withTransaction(sql`INSERT INTO ownership_probe VALUES (2)`);
      assert.deepEqual(yield* sql`SELECT value FROM ownership_probe`.values, [[2]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serves plain reads while another fiber holds the writer", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          sql`UPDATE counters SET value = 1 WHERE id = 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);

      // Sees the last committed value instead of waiting for the open transaction.
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[0]]);
      // Connection-state reads must come from the writer, so they still wait for it.
      const rowid = yield* Effect.forkChild(sql`SELECT last_insert_rowid() AS id`.values, {
        startImmediately: true,
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      assert.isUndefined(rowid.pollUnsafe());

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(rowid);
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[1]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerConnection: true })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!supportsNoopCheckpoint)("checkpoints and truncates the WAL on its worker", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const worker = startedWorkers.at(-1)!;
      const limit = 1024 * 1024;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`);
      yield* sql`CREATE TABLE pages(payload BLOB)`;
      yield* sql.withTransaction(sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
      `);

      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 0);
      assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 2 }]);

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const onMessage = (message: unknown) => {
              if (message !== "barrier") return;
              worker.off("message", onMessage);
              worker.off("error", onError);
              worker.off("exit", onExit);
              resolve();
            };
            const onError = (cause: Error) => {
              worker.off("message", onMessage);
              worker.off("exit", onExit);
              reject(cause);
            };
            const onExit = (code: number) => {
              worker.off("message", onMessage);
              worker.off("error", onError);
              reject(new Error(`checkpoint worker exited with code ${code}`));
            };
            worker.on("message", onMessage);
            worker.once("error", onError);
            worker.once("exit", onExit);
            worker.postMessage("barrier");
          }),
      );
      const state = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAtMost((state[0]?.log ?? 0) - (state[0]?.checkpointed ?? 0), 1000);
      assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), limit);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "warns and restores automatic checkpoints when the worker fails to start",
  () => {
    const warnings: Array<string> = [];
    const logger = Logger.formatSimple.pipe(Logger.map((output) => void warnings.push(output)));
    const reason = "SQLite checkpoint worker failed to start";
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        failingWorkers.message = reason;
      }),
      () =>
        Effect.gen(function* () {
          const { filename } = yield* makeTempDatabase;
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const worker = startedWorkers.at(-1)!;
            if (worker.threadId !== -1) {
              yield* Effect.promise(
                () => new Promise<void>((resolve) => worker.once("exit", () => resolve())),
              );
            }
            const autocheckpoint = yield* sql<{
              readonly wal_autocheckpoint: number;
            }>`PRAGMA wal_autocheckpoint`;
            assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
            yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
            assert.equal(
              warnings.filter((warning) =>
                warning.includes(
                  "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
                ),
              ).length,
              1,
            );
          }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
        }).pipe(Effect.provide(NodeServices.layer)),
      () =>
        Effect.sync(() => {
          failingWorkers.message = undefined;
        }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  },
);

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
