import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-worker-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => other.exec("PRAGMA journal_mode = WAL"));
  return { filename, other };
});

it.effect("keeps worker transactions on one connection and rolls back interruption", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = 9_007_199_254_740_993n;
      const value = 9_007_199_254_740_995n;
      const payload = new Uint8Array([0, 127, 255]);
      yield* sql`CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        value INTEGER NOT NULL,
        payload BLOB NOT NULL
      )`;
      yield* sql`INSERT INTO entries VALUES (${id}, ${value}, ${payload})`;

      const select = sql<{
        readonly id: bigint;
        readonly value: bigint;
        readonly stored_payload: Uint8Array;
      }>`SELECT id, value, payload FROM entries`;
      const expected = [{ id, value, stored_payload: payload }];
      assert.deepEqual(
        yield* select.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
        expected,
      );
      assert.deepEqual(
        yield* select.values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
        [[id, value, payload]],
      );
      assert.deepEqual(
        yield* select.raw.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
        [{ id, value, payload }],
      );
      assert.deepEqual(
        yield* select.valuesUnprepared.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
        [[id, value, payload]],
      );

      const inserted = yield* Deferred.make<void>();
      const interrupted = yield* Effect.forkChild(
        sql.withTransaction(
          sql`INSERT INTO entries VALUES (2, 22, ${payload})`.pipe(
            Effect.andThen(Deferred.succeed(inserted, undefined)),
            Effect.andThen(
              sql`WITH RECURSIVE numbers(value) AS (
                SELECT 1
                UNION ALL SELECT value + 1 FROM numbers WHERE value < 1000000
              )
              SELECT SUM(value) AS total FROM numbers`.values,
            ),
          ),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(inserted);
      yield* Effect.callback<void>((resume) => {
        const immediate = setImmediate(() => resume(Effect.void));
        return Effect.sync(() => clearImmediate(immediate));
      });
      assert.isUndefined(interrupted.pollUnsafe());
      yield* Fiber.interrupt(interrupted);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM entries`.values, [[1]]);

      yield* Effect.flip(
        sql.withTransaction(
          sql`INSERT INTO entries VALUES (3, 33, ${payload})`.pipe(
            Effect.andThen(Effect.fail("force rollback")),
          ),
        ),
      );
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM entries`.values, [[1]]);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename,
          workerConnection: true,
          transformResultNames(name) {
            if (name === "payload") return "stored_payload";
            return name;
          },
        }),
      ),
    );
    assert.deepEqual(
      yield* Effect.sync(() => other.prepare("SELECT COUNT(*) AS count FROM entries").get()),
      { count: 1 },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the host event loop responsive during a worker SQL lock wait", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (value INTEGER NOT NULL)`;
      yield* sql`PRAGMA busy_timeout = 3000`;
      yield* Effect.sync(() => other.exec("BEGIN EXCLUSIVE"));

      const insert = yield* Effect.forkChild(sql`INSERT INTO entries VALUES (1)`, {
        startImmediately: true,
      });
      yield* Effect.callback<void>((resume) => {
        const immediate = setImmediate(() => resume(Effect.void));
        return Effect.sync(() => clearImmediate(immediate));
      });
      assert.isUndefined(insert.pollUnsafe());

      yield* Effect.sync(() => other.exec("ROLLBACK"));
      yield* Fiber.join(insert);
      assert.deepEqual(yield* sql`SELECT value FROM entries`.values, [[1]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, workerConnection: true })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed worker-open failure instead of using the synchronous client", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0", workerConnection: true })).pipe(
        Effect.scoped,
      ),
    );
    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect("rolls back an open transaction when closing the worker connection", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (value INTEGER NOT NULL)`;
      yield* sql`BEGIN IMMEDIATE`;
      yield* sql`INSERT INTO entries VALUES (1)`;
    }).pipe(Effect.provide(SqliteClient.layer({ filename, workerConnection: true })));

    assert.deepEqual(
      yield* Effect.sync(() => other.prepare("SELECT COUNT(*) AS count FROM entries").get()),
      { count: 0 },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
