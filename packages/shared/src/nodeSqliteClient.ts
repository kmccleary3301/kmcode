/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeSqliteCheckpoint from "./nodeSqliteCheckpoint.ts";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import * as Statement from "effect/sql/Statement";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
const TransactionAcquire = Context.Reference<
  { restore: typeof Effect.interruptible | undefined } | undefined
>("@t3tools/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

const ATTR_DB_SYSTEM_NAME = "db.system.name";
type StatementMode = "rows" | "raw" | "values";
type StatementResult<Mode extends StatementMode> = Mode extends "raw"
  ? unknown
  : Mode extends "values"
    ? ReadonlyArray<ReadonlyArray<unknown>>
    : ReadonlyArray<object>;

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  readonly checkpointWorker?: boolean | undefined;
  /**
   * Run statements outside transactions that only read on a second, query-only connection.
   * WAL readers never wait for the writer, so reads no longer queue behind a write that is
   * waiting on the disk or on checkpoint admission. File databases only.
   */
  readonly readerConnection?: boolean | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

/**
 * SQLite keeps bound text and blobs until a cached statement is rebound or
 * finalized. Large payloads and parameters with getters therefore use a
 * throwaway statement instead of entering the cache.
 */
const LARGE_BINDING_SIZE = 64 * 1024;

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      const isBlob = ArrayBuffer.isView(param) || NodeUtil.types.isAnyArrayBuffer(param);
      if ((typeof param === "object" || typeof param === "function") && param !== null && !isBlob) {
        // Named parameters are objects; don't evaluate getters twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          const value: unknown = property.value;
          if (typeof value === "string") {
            size += value.length;
          } else if (ArrayBuffer.isView(value)) {
            size += value.byteLength;
          } else if (NodeUtil.types.isAnyArrayBuffer(value)) {
            size += value.byteLength;
          }
        }
      } else if (typeof param === "string") {
        size += param.length;
      } else if (ArrayBuffer.isView(param)) {
        size += param.byteLength;
      } else if (NodeUtil.types.isAnyArrayBuffer(param)) {
        size += param.byteLength;
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    // Let SQLite report parameters that cannot be measured safely.
    return true;
  }
};

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";

  const makeConnection = (role: "writer" | "reader") =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const db = yield* Effect.try({
        try: () =>
          new NodeSqlite.DatabaseSync(options.filename, {
            readOnly: options.readonly ?? false,
            allowExtension: options.allowExtension ?? false,
          }),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to open database", "open"),
          }),
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.try({
          try: () => db.close(),
          catch: (cause) =>
            new SqlError({
              reason: classifyError(cause, "Failed to close database", "close"),
            }),
        }).pipe(Effect.orDie),
      );
      if (role === "reader") {
        db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
      }
      // Stop the worker before closing the writer connection.
      const checkpoint =
        role === "writer" && options.checkpointWorker && isFileDatabase
          ? yield* NodeSqliteCheckpoint.startCheckpointWorker(options.filename, db)
          : undefined;

      const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
      const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
        const cached = statementReaderCache.get(statement);
        if (cached !== undefined) {
          return cached;
        }
        const value = statement.columns().length > 0;
        statementReaderCache.set(statement, value);
        return value;
      };
      interface CheckpointClassification {
        backpressure: boolean;
        check: boolean;
        /**
         * Anything beyond a plain read: pragmas, transactions, writes, or functions that report
         * this connection's own state. Only statements without it may run on the reader.
         */
        notPlainRead: boolean;
      }
      const checkpointClassifications = new WeakMap<
        NodeSqlite.StatementSync,
        CheckpointClassification
      >();
      const mutatingPragmasWithValues: Record<string, true> = {
        application_id: true,
        auto_vacuum: true,
        journal_mode: true,
        schema_version: true,
        user_version: true,
      };
      let activeClassification: CheckpointClassification | undefined;
      const withClassification = <A>(
        classification: CheckpointClassification | undefined,
        f: () => A,
      ): A => {
        if (classification === undefined) return f();
        const previous = activeClassification;
        activeClassification = classification;
        try {
          return f();
        } finally {
          activeClassification = previous;
        }
      };
      const connectionStateFunctions = new Set(["changes", "last_insert_rowid", "total_changes"]);
      // The writer classifies statements for checkpoint backpressure and for reader routing.
      const classifies =
        role === "writer" && (checkpoint !== undefined || options.readerConnection);
      if (classifies) {
        // Collect statement effects across prepare and automatic reprepare.
        db.setAuthorizer((actionCode, action, argument) => {
          const classification = activeClassification;
          if (classification === undefined) return NodeSqlite.constants.SQLITE_OK;
          const constants = NodeSqlite.constants;
          if (
            !(
              actionCode === constants.SQLITE_READ ||
              actionCode === constants.SQLITE_SELECT ||
              actionCode === constants.SQLITE_RECURSIVE ||
              (actionCode === constants.SQLITE_FUNCTION &&
                !connectionStateFunctions.has(argument?.toLowerCase() ?? ""))
            )
          ) {
            classification.notPlainRead = true;
          }
          if (actionCode === constants.SQLITE_TRANSACTION) {
            classification.backpressure ||= action === "BEGIN";
            classification.check ||= action === "COMMIT" || action === "ROLLBACK";
          } else if (actionCode === constants.SQLITE_SAVEPOINT) {
            classification.backpressure ||= action === "BEGIN";
            classification.check = true;
          } else if (actionCode === constants.SQLITE_PRAGMA) {
            const pragma = action?.toLowerCase();
            const value = argument?.toLowerCase();
            if (
              pragma === "incremental_vacuum" ||
              pragma === "optimize" ||
              (pragma === "wal_checkpoint" && value !== "noop") ||
              (value !== undefined && Object.hasOwn(mutatingPragmasWithValues, pragma ?? ""))
            ) {
              classification.backpressure = true;
              classification.check = true;
            }
          } else if (
            actionCode !== constants.SQLITE_READ &&
            actionCode !== constants.SQLITE_SELECT &&
            actionCode !== constants.SQLITE_FUNCTION &&
            actionCode !== constants.SQLITE_RECURSIVE
          ) {
            classification.backpressure = true;
            classification.check = true;
          }
          return constants.SQLITE_OK;
        });
      }

      const prepare = (sql: string) =>
        Effect.try({
          try: () => {
            const classification = { backpressure: false, check: false, notPlainRead: false };
            const statement = withClassification(classification, () => db.prepare(sql));
            if (classifies) checkpointClassifications.set(statement, classification);
            return statement;
          },
          catch: (cause) =>
            new SqlError({
              reason: classifyError(cause, "Failed to prepare statement", "prepare"),
            }),
        });

      const prepareCache = yield* Cache.makeWith(prepare, {
        capacity: options.prepareCacheSize ?? 200,
        // A transient prepare failure must not outlive the lock or missing schema.
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
      });
      const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
        hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

      const runStatement = <Mode extends StatementMode = "rows">(
        statement: NodeSqlite.StatementSync,
        params: ReadonlyArray<unknown>,
        mode: Mode = "rows" as Mode,
      ): Effect.Effect<StatementResult<Mode>, SqlError> =>
        Effect.withFiber<StatementResult<Mode>, SqlError>((fiber) => {
          const classification = checkpointClassifications.get(statement);
          const bindings = params as Parameters<typeof statement.all>;
          const execute = () => {
            let arrays = false;
            let result: Effect.Effect<StatementResult<Mode>, SqlError>;
            try {
              const value: unknown = withClassification(classification, () => {
                statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
                if (hasRows(statement)) {
                  arrays = mode === "values";
                  if (arrays) statement.setReturnArrays(true);
                  return statement.all(...bindings);
                }
                const nativeResult = statement.run(...bindings);
                return mode === "raw" ? nativeResult : [];
              });
              result = Effect.succeed(value as StatementResult<Mode>);
            } catch (cause) {
              result = Effect.fail(
                new SqlError({
                  reason: classifyError(cause, "Failed to execute statement", "execute"),
                }),
              );
            } finally {
              // OR FAIL may have committed earlier rows even when execution throws.
              if (classification?.check) checkpoint?.check();
            }
            if (arrays) {
              try {
                statement.setReturnArrays(false);
              } catch (cause) {
                return Effect.die(
                  new SqlError({
                    reason: classifyError(
                      cause,
                      "Failed to reset statement result mode",
                      "resetResultMode",
                    ),
                  }),
                );
              }
            }
            return result;
          };
          return checkpoint !== undefined && classification?.backpressure
            ? checkpoint.runWithAdmission(execute)
            : execute();
        });

      return {
        connection: identity<Connection>({
          execute(sql, params, rowTransform) {
            const effect = Effect.flatMap(statementFor(sql, params), (statement) =>
              runStatement(statement, params),
            );
            return rowTransform ? Effect.map(effect, rowTransform) : effect;
          },
          executeRaw(sql, params) {
            return Effect.flatMap(statementFor(sql, params), (statement) =>
              runStatement(statement, params, "raw"),
            );
          },
          executeValues(sql, params) {
            return Effect.flatMap(statementFor(sql, params), (statement) =>
              runStatement(statement, params, "values"),
            );
          },
          executeValuesUnprepared(sql, params) {
            return Effect.flatMap(prepare(sql), (statement) =>
              runStatement(statement, params ?? [], "values"),
            );
          },
          executeUnprepared(sql, params, rowTransform) {
            const effect = prepare(sql).pipe(
              Effect.flatMap((statement) => runStatement(statement, params ?? [])),
            );
            return rowTransform ? Effect.map(effect, rowTransform) : effect;
          },
          executeStream(_sql, _params) {
            return Stream.die(new UnsupportedNodeSqliteOperationError());
          },
        }),
        checkpoint,
        /**
         * Whether `sql` is a plain read, classified on the writer. A statement that fails to
         * prepare is not, so the writer reports the real error.
         */
        isPlainRead: (sql: string) =>
          Cache.get(prepareCache, sql).pipe(
            Effect.map(
              (statement) => checkpointClassifications.get(statement)?.notPlainRead === false,
            ),
            Effect.orElseSucceed(() => false),
          ),
        statementFor,
        runStatement,
      };
    });

  const semaphore = yield* Semaphore.make(1);
  const { connection, checkpoint, isPlainRead } = yield* makeConnection("writer");
  // Opened on the first plain read. Layer setup that must precede it (e.g. clearing planner
  // statistics) runs as pragmas or in transactions, which stay on the writer, so the reader
  // loads the schema and stats as they are afterwards. A reader that fails to open leaves
  // every statement on the writer.
  const clientScope = yield* Effect.scope;
  const openReader =
    options.readerConnection && isFileDatabase && options.readonly !== true
      ? yield* Effect.cached(
          makeConnection("reader").pipe(
            Effect.provideService(Scope.Scope, clientScope),
            Effect.tapError((error) =>
              Effect.logWarning("SQLite reader connection unavailable", error),
            ),
            Effect.orElseSucceed(() => undefined),
          ),
        )
      : undefined;

  let writerBorrowsSinceYield = 0;
  const writerBorrower: Borrower = (use) => {
    const useConnection = Effect.suspend(() => use(connection));
    if (checkpoint === undefined) return semaphore.withPermits(1)(useConnection);
    const writerUse = Effect.onExit(useConnection, (exit) =>
      Effect.sync(() => {
        writerBorrowsSinceYield = Exit.hasInterrupts(exit)
          ? 0
          : Math.min(writerBorrowsSinceYield + 1, 16);
      }),
    );
    return Effect.flatMap(semaphore.withPermitsIfAvailable(1)(writerUse), (result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : semaphore.withPermits(1)(
            Effect.andThen(
              Effect.suspend(() => {
                if (writerBorrowsSinceYield < 16) return Effect.void;
                writerBorrowsSinceYield = 0;
                return Effect.callback<void>((resume) => {
                  const immediate = setImmediate(() => resume(Effect.void));
                  return Effect.sync(() => clearImmediate(immediate));
                });
              }),
              writerUse,
            ),
          ),
    );
  };
  // Borrowed statements never run inside a transaction (the client routes those to the
  // transaction's connection), so a plain read can use the reader's latest committed snapshot.
  const routed = <A>(
    sql: string,
    params: ReadonlyArray<unknown>,
    onRead: (
      run: <Mode extends StatementMode>(
        mode: Mode,
      ) => Effect.Effect<StatementResult<Mode>, SqlError>,
    ) => Effect.Effect<A, SqlError>,
    onWrite: (writer: Connection) => Effect.Effect<A, SqlError>,
  ): Effect.Effect<A, SqlError> =>
    openReader === undefined
      ? writerBorrower(onWrite)
      : Effect.flatMap(isPlainRead(sql), (plain) =>
          !plain
            ? writerBorrower(onWrite)
            : Effect.flatMap(openReader, (reader) =>
                reader === undefined
                  ? writerBorrower(onWrite)
                  : Effect.flatMap(
                      reader.statementFor(sql, params).pipe(Effect.orElseSucceed(() => undefined)),
                      (statement) =>
                        statement === undefined
                          ? writerBorrower(onWrite)
                          : onRead((mode) => reader.runStatement(statement, params, mode)),
                    ),
              ),
        );
  const borrower: Borrower =
    openReader === undefined
      ? writerBorrower
      : (use) =>
          use(
            identity<Connection>({
              execute: (sql, params, rowTransform) =>
                routed(
                  sql,
                  params,
                  (run) => (rowTransform ? Effect.map(run("rows"), rowTransform) : run("rows")),
                  (writer) => writer.execute(sql, params, rowTransform),
                ),
              executeRaw: (sql, params) =>
                routed(
                  sql,
                  params,
                  (run) => run("raw"),
                  (writer) => writer.executeRaw(sql, params),
                ),
              executeValues: (sql, params) =>
                routed(
                  sql,
                  params,
                  (run) => run("values"),
                  (writer) => writer.executeValues(sql, params),
                ),
              executeValuesUnprepared: (sql, params) =>
                writerBorrower((writer) => writer.executeValuesUnprepared(sql, params)),
              executeUnprepared: (sql, params, rowTransform) =>
                writerBorrower((writer) => writer.executeUnprepared(sql, params, rowTransform)),
              executeStream: (sql, params, rowTransform) =>
                connection.executeStream(sql, params, rowTransform),
            }),
          );
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    const pending = fiber.getRef(TransactionAcquire);
    const acquire = Effect.tap((pending?.restore ?? restore)(semaphore.take(1)), () =>
      Scope.addFinalizer(scope, semaphore.release(1)),
    );
    return Effect.as(
      Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
      connection,
    );
  });

  const client = yield* Client.make({
    acquirer: transactionAcquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // BEGIN IMMEDIATE waits for other writers before a read can make later writes fail with
    // SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot resolve.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        const pending: { restore: typeof Effect.interruptible | undefined } = { restore };
        const body = Effect.withFiber<A, E, R>(() => {
          pending.restore = undefined;
          return effect;
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
