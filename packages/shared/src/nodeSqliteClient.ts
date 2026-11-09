/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeSqliteCheckpoint from "./nodeSqliteCheckpoint.ts";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
   * Run statements outside transactions that only read on a pool of query-only worker connections.
   * WAL readers never wait for the writer, and independent workers avoid read queues.
   * File databases only.
   */
  readonly readerConnection?: boolean | undefined;
  /**
   * Run all SQLite work asynchronously on one worker-owned connection.
   * File databases only; incompatible with the read-only reader pool and checkpoint worker.
   */
  readonly workerConnection?: boolean | undefined;
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
const READER_POOL_SIZE = 4;

const sqliteWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  const next = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readOnly,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  if (workerData.requireWal) {
    next.exec("PRAGMA cache_size = -262144;");
    const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
    if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  }
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({
    type: "unavailable",
    message: String(error && error.message ? error.message : error),
  });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let entry = statements.get(sql);
  const now = Date.now();
  if (
    entry !== undefined &&
    workerData.prepareCacheTtlMs !== undefined &&
    now - entry.lastUsed >= workerData.prepareCacheTtlMs
  ) {
    statements.delete(sql);
    entry = undefined;
  }
  if (entry === undefined) {
    const statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) statements.delete(oldest);
    }
    entry = { statement, lastUsed: now };
  } else {
    statements.delete(sql);
    entry.lastUsed = now;
  }
  statements.set(sql, entry);
  return entry.statement;
};
parentPort.on("message", (message) => {
  if (message.type === "close") {
    try {
      if (db !== undefined && db.isTransaction) db.exec("ROLLBACK");
      parentPort.postMessage({ type: "closed" });
    } catch (error) {
      parentPort.postMessage({
        type: "closeError",
        message: String(error && error.message ? error.message : error),
      });
    }
    return;
  }
  const { id, sql, params, cached, values, raw, safeIntegers } = message;
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database worker is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      parentPort.postMessage({
        id,
        type: values ? "values" : "rows",
        rows: statement.all(...params),
      });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage(
        raw
          ? { id, type: "raw", result }
          : { id, type: values ? "values" : "rows", rows: [] },
      );
    }
  } catch (error) {
    parentPort.postMessage({
      id,
      type: "error",
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

interface SqliteWorkerRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type SqliteWorkerStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string };
type SqliteWorkerControlReply =
  | { readonly type: "closed" }
  | { readonly type: "closeError"; readonly message: string };

type SqliteWorkerError = {
  readonly operation: "open" | "prepare" | "execute";
  readonly message: string;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
};

type SqliteWorkerResult =
  | { readonly type: "rows"; readonly rows: ReadonlyArray<object> }
  | { readonly type: "values"; readonly rows: ReadonlyArray<ReadonlyArray<unknown>> }
  | { readonly type: "raw"; readonly result: unknown };

type SqliteWorkerReply =
  | (SqliteWorkerResult & { readonly id: number })
  | { readonly id: number; readonly type: "error"; readonly error: SqliteWorkerError };

const workerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const workerSqlError = (error: SqliteWorkerError) => {
  const { operation, message, ...codes } = error;
  return new SqlError({
    reason: classifyError(
      Object.assign(new Error(message), codes),
      workerFailureMessages[operation],
      operation,
    ),
  });
};

const unexpectedWorkerResult = () =>
  new SqlError({
    reason: classifyError(
      new Error("SQLite worker returned an unexpected result mode"),
      workerFailureMessages.execute,
      "execute",
    ),
  });

const rowsFromWorker = (
  reply: SqliteWorkerResult,
): Effect.Effect<ReadonlyArray<object>, SqlError> =>
  reply.type === "rows" ? Effect.succeed(reply.rows) : Effect.fail(unexpectedWorkerResult());

const valuesFromWorker = (
  reply: SqliteWorkerResult,
): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError> =>
  reply.type === "values" ? Effect.succeed(reply.rows) : Effect.fail(unexpectedWorkerResult());

const rawFromWorker = (reply: SqliteWorkerResult): Effect.Effect<unknown, SqlError> =>
  reply.type === "raw"
    ? Effect.succeed(reply.result)
    : reply.type === "rows"
      ? Effect.succeed(reply.rows)
      : Effect.fail(unexpectedWorkerResult());

const makeReader = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  pool: { unavailable: boolean },
) {
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<SqliteWorkerStartup>;
      }
    | undefined;
  let nextRequestId = 0;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(sqliteWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        prepareCacheSize: options.prepareCacheSize ?? 200,
        prepareCacheTtlMs: undefined,
        readOnly: true,
        allowExtension: false,
        requireWal: true,
      },
    });
    let announce: (startup: SqliteWorkerStartup) => void = () => {};
    const started = new Promise<SqliteWorkerStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<number, { readonly resume: (reply: SqliteWorkerReply) => void }>();
    const stop = (message: string) => {
      stoppedMessage = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      for (const [id, request] of pending) {
        request.resume({ id, type: "error", error: { operation: "execute", message } });
      }
      pending.clear();
    };
    worker.on("message", (reply: SqliteWorkerReply | SqliteWorkerStartup) => {
      if (!("id" in reply)) {
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      request.resume(reply);
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: SqliteWorkerRequest) =>
      Effect.withFiber<SqliteWorkerResult, SqlError>((fiber) => {
        if (stoppedMessage !== undefined) {
          return Effect.fail(
            workerSqlError({
              operation: "execute",
              message: stoppedMessage,
            }),
          );
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<SqliteWorkerResult, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            resume: (reply) => {
              if (reply.type === "error") {
                resume(Effect.fail(workerSqlError(reply.error)));
              } else {
                resume(Effect.succeed(reply));
              }
            },
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          try {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            worker.postMessage({ id, safeIntegers, ...input, cached });
          } catch (cause) {
            pending.delete(id);
            if (pending.size === 0) worker.unref();
            resume(
              Effect.fail(
                workerSqlError({
                  operation: "execute",
                  message: String(cause),
                }),
              ),
            );
          }
        });
      });

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false }).pipe(
          Effect.flatMap(rowsFromWorker),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true }).pipe(
          Effect.flatMap(rawFromWorker),
        );
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false }).pipe(
          Effect.flatMap(valuesFromWorker),
        );
      },
      executeValuesUnprepared(sql, params) {
        return request({
          sql,
          params: params ?? [],
          cached: false,
          values: true,
          raw: false,
        }).pipe(Effect.flatMap(valuesFromWorker));
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = request({
          sql,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        }).pipe(Effect.flatMap(rowsFromWorker));
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    current = { worker, connection, started };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await current?.worker.terminate();
    }),
  );

  const startupTimeout = Duration.seconds(10);
  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      if (pool.unavailable) return Effect.succeed(undefined);
      pool.unavailable = true;
      return Effect.logWarning("SQLite reader worker unavailable; reads use the writer", {
        reason,
      }).pipe(Effect.as(undefined));
    });

  return Effect.suspend((): Effect.Effect<Connection | undefined> => {
    if (pool.unavailable) return Effect.succeed(undefined);
    let reader: NonNullable<typeof current>;
    try {
      reader = current ?? start();
    } catch (cause) {
      return turnOff(undefined, String(cause));
    }
    return Effect.flatMap(
      Effect.timeoutOption(
        Effect.promise(() => reader.started),
        startupTimeout,
      ),
      (startup): Effect.Effect<Connection | undefined> =>
        pool.unavailable || current !== reader
          ? Effect.succeed(undefined)
          : Option.isSome(startup) && startup.value.type === "ready"
            ? Effect.succeed(reader.connection)
            : turnOff(
                reader,
                Option.isSome(startup) && startup.value.type === "unavailable"
                  ? startup.value.message
                  : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
              ),
    );
  });
});

const makeWorkerConnection = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  const invalidConfiguration =
    options.filename === ":memory:" || options.filename === ""
      ? "workerConnection requires a file-backed database"
      : options.readonly === true
        ? "workerConnection cannot open a read-only database"
        : options.readerConnection === true
          ? "workerConnection cannot be combined with readerConnection"
          : options.checkpointWorker === true
            ? "workerConnection cannot be combined with checkpointWorker"
            : undefined;
  if (invalidConfiguration !== undefined) {
    return yield* Effect.fail(
      workerSqlError({ operation: "open", message: invalidConfiguration }),
    );
  }

  const worker = yield* Effect.try({
    try: () =>
      new NodeWorkerThreads.Worker(sqliteWorkerSource, {
        eval: true,
        workerData: {
          filename: options.filename,
          prepareCacheSize: options.prepareCacheSize ?? 200,
          prepareCacheTtlMs: Duration.toMillis(
            options.prepareCacheTTL ?? Duration.minutes(10),
          ),
          readOnly: false,
          allowExtension: options.allowExtension ?? false,
          requireWal: false,
        },
      }),
    catch: (cause) => workerSqlError({ operation: "open", message: String(cause) }),
  });

  let announce: (startup: SqliteWorkerStartup) => void = () => {};
  const started = new Promise<SqliteWorkerStartup>((resolve) => {
    announce = resolve;
  });
  let stoppedMessage: string | undefined;
  let closing = false;
  let nextRequestId = 0;
  let resolveWhenIdle: (() => void) | undefined;
  let resolveClose: (() => void) | undefined;
  const pending = new Map<number, { readonly complete: (reply: SqliteWorkerReply) => void }>();
  const stop = (message: string) => {
    if (stoppedMessage !== undefined) return;
    stoppedMessage = message;
    announce({ type: "unavailable", message });
    for (const [id, request] of pending) {
      request.complete({ id, type: "error", error: { operation: "execute", message } });
    }
  };
  worker.on(
    "message",
    (reply: SqliteWorkerReply | SqliteWorkerStartup | SqliteWorkerControlReply) => {
      if (reply.type === "closed" || reply.type === "closeError") {
        resolveClose?.();
        resolveClose = undefined;
        return;
      }
      if (!("id" in reply)) {
        announce(reply);
        if (reply.type === "unavailable") stoppedMessage = reply.message;
        if (pending.size === 0) worker.unref();
        return;
      }
      pending.get(reply.id)?.complete(reply);
    },
  );
  worker.on("error", (cause) => {
    if (closing && pending.size === 0) {
      resolveClose?.();
    } else {
      stop(`Database worker connection failed: ${cause.message}`);
    }
  });
  worker.on("exit", (code) => {
    if (closing && pending.size === 0) {
      resolveClose?.();
    } else {
      stop(`Database worker connection exited with code ${code}`);
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      if (pending.size > 0) {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              resolveWhenIdle = resolve;
            }),
        );
      }
      if (stoppedMessage === undefined && worker.threadId !== -1) {
        const closeAcknowledged = new Promise<void>((resolve) => {
          resolveClose = resolve;
        });
        worker.ref();
        yield* Effect.sync(() => {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ type: "close" });
        });
        yield* Effect.timeoutOption(
          Effect.promise(() => closeAcknowledged),
          Duration.seconds(10),
        );
        resolveClose = undefined;
      }
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await worker.terminate();
        }),
      ),
    ),
  );

  const startupTimeout = Duration.seconds(10);
  const startup = yield* Effect.timeoutOption(Effect.promise(() => started), startupTimeout);
  if (Option.isNone(startup)) {
    return yield* Effect.fail(
      workerSqlError({
        operation: "open",
        message: `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
      }),
    );
  }
  if (startup.value.type === "unavailable") {
    return yield* Effect.fail(
      workerSqlError({ operation: "open", message: startup.value.message }),
    );
  }

  const request = (input: SqliteWorkerRequest) =>
    Effect.withFiber<SqliteWorkerResult, SqlError>((fiber) => {
      if (closing) {
        return Effect.fail(
          workerSqlError({
            operation: "execute",
            message: "Database worker connection is closed",
          }),
        );
      }
      if (stoppedMessage !== undefined) {
        return Effect.fail(workerSqlError({ operation: "execute", message: stoppedMessage }));
      }
      const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
      return Effect.callback<SqliteWorkerResult, SqlError>((resume) => {
        const id = nextRequestId++;
        let resolveFinished: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
          resolveFinished = resolve;
        });
        const complete = (reply: SqliteWorkerReply) => {
          if (!pending.delete(id)) return;
          if (pending.size === 0) {
            worker.unref();
            resolveWhenIdle?.();
            resolveWhenIdle = undefined;
          }
          resolveFinished();
          if (reply.type === "error") {
            resume(Effect.fail(workerSqlError(reply.error)));
          } else {
            resume(Effect.succeed(reply));
          }
        };
        pending.set(id, { complete });
        if (pending.size === 1) worker.ref();
        const cached = input.cached && !hasLargeBinding(input.params);
        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
        } catch (cause) {
          complete({
            id,
            type: "error",
            error: { operation: "execute", message: String(cause) },
          });
        }
        return Effect.promise(() => finished);
      });
    });

  const connection = identity<Connection>({
    execute(sql, params, rowTransform) {
      const effect = request({ sql, params, cached: true, values: false, raw: false }).pipe(
        Effect.flatMap(rowsFromWorker),
      );
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return request({ sql, params, cached: true, values: false, raw: true }).pipe(
        Effect.flatMap(rawFromWorker),
      );
    },
    executeValues(sql, params) {
      return request({ sql, params, cached: true, values: true, raw: false }).pipe(
        Effect.flatMap(valuesFromWorker),
      );
    },
    executeValuesUnprepared(sql, params) {
      return request({
        sql,
        params: params ?? [],
        cached: false,
        values: true,
        raw: false,
      }).pipe(Effect.flatMap(valuesFromWorker));
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = request({
        sql,
        params: params ?? [],
        cached: false,
        values: false,
        raw: false,
      }).pipe(Effect.flatMap(rowsFromWorker));
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die(new UnsupportedNodeSqliteOperationError());
    },
  });

  return {
    connection,
    checkpoint: undefined,
  };
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";

  const makeConnection = () =>
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
      // Stop the worker before closing the writer connection.
      const checkpoint =
        options.checkpointWorker && isFileDatabase
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
      const classifies = checkpoint !== undefined || options.readerConnection;
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
      };
    });

  const semaphore = yield* Semaphore.make(1);
  const connectionSetup = options.workerConnection
    ? yield* makeWorkerConnection(options)
    : yield* makeConnection();
  const { connection, checkpoint } = connectionSetup;
  const isPlainRead =
    "isPlainRead" in connectionSetup ? connectionSetup.isPlainRead : undefined;
  const readerPool = { unavailable: false };
  const readers =
    options.readerConnection && isFileDatabase && options.readonly !== true
      ? yield* Effect.forEach(Array.from({ length: READER_POOL_SIZE }), () =>
          Effect.map(makeReader(options, readerPool), (acquire) => ({
            acquire,
            claims: 0,
          })),
        )
      : [];

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
  // transaction's connection), so a plain read can use a worker's latest committed snapshot.
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
    readers.length === 0 || isPlainRead === undefined || readerPool.unavailable
      ? writerBorrower(onWrite)
      : Effect.flatMap(isPlainRead(sql), (plain) => {
          if (!plain) return writerBorrower(onWrite);
          let slot = readers[0]!;
          for (const candidate of readers) {
            if (candidate.claims < slot.claims) slot = candidate;
          }
          slot.claims++;
          return Effect.uninterruptibleMask((restore) =>
            restore(
              Effect.flatMap(slot.acquire, (reader) => {
                if (reader === undefined) return writerBorrower(onWrite);
                const run = <Mode extends StatementMode>(
                  mode: Mode,
                ): Effect.Effect<StatementResult<Mode>, SqlError> => {
                  const effect =
                    mode === "raw"
                      ? reader.executeRaw(sql, params)
                      : mode === "values"
                        ? reader.executeValues(sql, params)
                        : reader.execute(sql, params, undefined);
                  return effect as Effect.Effect<StatementResult<Mode>, SqlError>;
                };
                return onRead(run);
              }),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  slot.claims--;
                }),
              ),
            ),
          );
        });
  const borrower: Borrower =
    readers.length === 0
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
