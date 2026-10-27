import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";

const CHECKPOINT_FRAMES = 1000;
const CHECKPOINT_IDLE_MS = 100;
const CHECKPOINT_BACKPRESSURE_FRAMES = 10 * CHECKPOINT_FRAMES;

const readSafeSqliteInteger = (value: unknown) => {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
};

// Evaluated source also works in bundles and single-executable builds.
const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
let db;
let frames;
let checkpoint;
let truncate;
let journalSizeLimit = -1;
let generation = 0;
let nextTruncateId = 0;
let pendingTruncate;
let pendingBarriers = 0;
let idle;
const initialize = () => {
  if (db !== undefined) return;
  // The writer switches to WAL after constructing the client.
  db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout = 5000;");
  const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  // macOS requires F_FULLFSYNC to flush the drive cache.
  db.exec("PRAGMA checkpoint_fullfsync = ON;");
  frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
  checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  truncate = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
};
const atCeiling = (state) => state.log >= workerData.backpressureFrames;
const exceedsSizeLimit = () =>
  journalSizeLimit >= 0 && statSync(workerData.filename + "-wal").size > journalSizeLimit;
const schedule = (state, blocked) => {
  if (blocked || state.log - state.checkpointed >= workerData.frames) {
    idle = setTimeout(() => check(undefined, undefined, true), workerData.idleMs);
  }
};
const check = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  initialize();
  if (Number.isSafeInteger(nextGeneration)) generation = Math.max(generation, nextGeneration);
  if (Number.isSafeInteger(nextJournalSizeLimit)) journalSizeLimit = nextJournalSizeLimit;
  let state = frames.get();
  const oversized = exceedsSizeLimit();
  if (force || state.log - state.checkpointed >= workerData.frames || oversized) {
    checkpoint.get();
    state = frames.get();
  }
  if (state.checkpointed === state.log && (atCeiling(state) || oversized)) {
    pendingTruncate = { truncateId: ++nextTruncateId, checkId: id, generation, state };
    parentPort.postMessage({
      type: "truncate-request",
      truncateId: pendingTruncate.truncateId,
      checkId: id,
      generation,
      ...state,
    });
    return;
  }
  const blocked = (atCeiling(state) || oversized) && state.checkpointed < state.log;
  parentPort.postMessage({ type: "checkpoint", id, generation, ...state, blocked });
  schedule(state, blocked);
};
const finishTruncate = (truncateId) => {
  if (pendingTruncate === undefined || pendingTruncate.truncateId !== truncateId) return;
  const pending = pendingTruncate;
  parentPort.postMessage({ type: "truncate-start", truncateId });
  let busy;
  // Admission is paused here; a pinned reader must not make truncation wait.
  db.exec("PRAGMA busy_timeout = 0;");
  try {
    busy = truncate.get().busy !== 0;
  } finally {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  const state = frames.get();
  const blocked = (atCeiling(state) && (busy || state.checkpointed < state.log)) || exceedsSizeLimit();
  pendingTruncate = undefined;
  parentPort.postMessage({
    type: "checkpoint",
    id: pending.checkId,
    generation: pending.generation,
    truncateId,
    ...state,
    blocked,
  });
  while (pendingBarriers > 0) {
    pendingBarriers--;
    parentPort.postMessage("barrier");
  }
  schedule(state, blocked);
};
parentPort.on("message", (request) => {
  clearTimeout(idle);
  if (request && request.type === "truncate") {
    finishTruncate(request.truncateId);
    return;
  }
  const isBarrier = request === "barrier";
  if (pendingTruncate !== undefined) {
    if (isBarrier) pendingBarriers++;
    else if (request && request.type === "check") {
      // Retire the request without labeling the pending snapshot with a newer generation.
      parentPort.postMessage({
        type: "checkpoint",
        id: request.id,
        generation: pendingTruncate.generation,
        ...pendingTruncate.state,
        blocked: true,
      });
    }
    return;
  }
  const input = request && typeof request === "object" ? request : {};
  check(input.id, input.journalSizeLimit, input.force, input.generation);
  if (isBarrier) {
    if (pendingTruncate !== undefined) pendingBarriers++;
    else parentPort.postMessage("barrier");
  }
});
`;

interface Waiter {
  resume: () => void;
  cancelled: boolean;
}

export interface CheckpointWorker {
  readonly check: () => void;
  readonly runWithAdmission: <A, E>(
    execute: () => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

export const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: NodeSqlite.DatabaseSync,
) {
  const warn = (reason: string) =>
    Effect.logWarning(
      "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
      { reason },
    );
  if (typeof writer.isTransaction !== "boolean" || typeof writer.setAuthorizer !== "function") {
    yield* warn("Node SQLite lacks transaction-state or statement-authorizer support");
    return undefined;
  }
  const version = String(writer.prepare("SELECT sqlite_version() AS version").get()?.version);
  const [major = 0, minor = 0] = version.split(".").map(Number);
  // Older SQLite treats NOOP as PASSIVE, which would checkpoint on the writer.
  if (major < 3 || (major === 3 && minor < 51)) {
    yield* warn(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  const frames = writer.prepare("PRAGMA wal_checkpoint(NOOP)");
  const sizeLimit = writer.prepare("PRAGMA journal_size_limit");
  let worker: NodeWorkerThreads.Worker;
  try {
    worker = new NodeWorkerThreads.Worker(checkpointWorkerSource, {
      eval: true,
      workerData: {
        filename,
        frames: CHECKPOINT_FRAMES,
        backpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
        idleMs: CHECKPOINT_IDLE_MS,
      },
    });
  } catch (cause) {
    yield* warn(String(cause));
    return undefined;
  }
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  let generation = 0;
  let nextId = 0;
  let inFlight: number | undefined;
  let checkAgain = false;
  let blocked = false;
  let log = 0;
  let checkpointed = 0;
  let unknown = false;
  let truncate: { id: number; acknowledged: boolean } | undefined;
  const waiters: Array<Waiter> = [];
  let elected: Waiter | undefined;
  const gated = () =>
    !stopped &&
    !writer.isTransaction &&
    (unknown || blocked || truncate !== undefined || log >= CHECKPOINT_BACKPRESSURE_FRAMES);
  const wake = () => {
    if (!gated() && elected === undefined) {
      elected = waiters.shift();
      elected?.resume();
    }
    if (waiters.length === 0 && elected === undefined) worker.unref();
  };
  const release = (waiter: Waiter) => {
    waiter.cancelled = true;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (elected === waiter) elected = undefined;
    wake();
  };
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    truncate = undefined;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint = ${CHECKPOINT_FRAMES};`);
    } catch {
      // The writer may already be closed.
    }
    wake();
    runFork(warn(reason));
  };
  const send = (message: unknown) => {
    try {
      // Node workers do not accept a target origin.
      worker.postMessage(message);
    } catch (cause) {
      handBack(String(cause));
    }
  };
  const acknowledge = () => {
    if (truncate === undefined || truncate.acknowledged || stopped || writer.isTransaction) return;
    truncate.acknowledged = true;
    send({ type: "truncate", truncateId: truncate.id });
  };
  const observe = () => {
    try {
      const state = frames.get();
      const nextLog = readSafeSqliteInteger(state?.log);
      const nextCheckpointed = readSafeSqliteInteger(state?.checkpointed);
      if (nextLog === undefined || nextCheckpointed === undefined) {
        throw new Error("Invalid WAL frame counts");
      }
      log = nextLog;
      checkpointed = nextCheckpointed;
      unknown = false;
    } catch {
      unknown = true;
    }
  };
  const request = (force = false) => {
    if (stopped || writer.isTransaction) return;
    if (truncate !== undefined) {
      acknowledge();
      return;
    }
    if (inFlight !== undefined) {
      checkAgain = true;
      return;
    }
    if (!force && !gated() && log - checkpointed < CHECKPOINT_FRAMES) return;
    inFlight = ++nextId;
    try {
      send({
        type: "check",
        id: inFlight,
        generation,
        journalSizeLimit: readSafeSqliteInteger(sizeLimit.get()?.journal_size_limit),
        force: force || gated(),
      });
    } catch (cause) {
      handBack(String(cause));
    }
  };
  const check = () => {
    if (stopped || writer.isTransaction) return;
    generation++;
    observe();
    request();
    wake();
  };
  worker.on("error", (cause) => handBack(cause.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  worker.on("message", (message: unknown) => {
    if (stopped || typeof message !== "object" || message === null || !("type" in message)) return;
    if (
      message.type === "truncate-request" &&
      "truncateId" in message &&
      typeof message.truncateId === "number"
    ) {
      truncate = { id: message.truncateId, acknowledged: false };
      blocked = true;
      acknowledge();
      return;
    }
    if (message.type !== "checkpoint") return;
    const completedTruncate =
      truncate !== undefined && "truncateId" in message && message.truncateId === truncate.id;
    if (completedTruncate) truncate = undefined;
    // An acknowledged truncate excludes new writer mutations, so its result is current.
    if (
      (completedTruncate || ("generation" in message && message.generation === generation)) &&
      "log" in message &&
      typeof message.log === "number" &&
      "checkpointed" in message &&
      typeof message.checkpointed === "number" &&
      "blocked" in message &&
      typeof message.blocked === "boolean"
    ) {
      log = message.log;
      checkpointed = message.checkpointed;
      blocked = message.blocked;
      unknown = false;
    }
    // Even a stale snapshot must retire its request so a newer check can run.
    if ("id" in message && message.id === inFlight) inFlight = undefined;
    if (checkAgain && inFlight === undefined) {
      checkAgain = false;
      request(true);
    }
    wake();
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      stopped = true;
      truncate = undefined;
      wake();
      return worker.terminate();
    }),
  );
  writer.exec("PRAGMA wal_autocheckpoint = 0;");
  observe();
  worker.unref();

  const runWithAdmission = <A, E>(
    execute: () => Effect.Effect<A, E>,
    admitted?: Waiter,
  ): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      if (!gated()) {
        // Release the election after execution; its successor must see the new WAL state.
        return admitted === undefined
          ? execute()
          : Effect.ensuring(execute(), Effect.sync(() => release(admitted)));
      }
      if (admitted !== undefined) release(admitted);
      const waiter: Waiter = { resume: () => {}, cancelled: false };
      const wait = Effect.uninterruptibleMask((restore) =>
        restore(
          Effect.callback<void>(function (this: Scheduler.Scheduler, resume) {
            const dispatcher = this.makeDispatcher();
            waiter.resume = () => {
              dispatcher.scheduleTask(() => {
                if (!waiter.cancelled) resume(Effect.void);
              }, 0);
            };
            waiters.push(waiter);
            worker.ref();
            request(true);
            wake();
            return Effect.sync(() => release(waiter));
          }),
        ),
      );
      return wait.pipe(
        Effect.flatMap(() => runWithAdmission(execute, waiter)),
        Effect.onInterrupt(() => Effect.sync(() => release(waiter))),
      );
    });
  return {
    check,
    runWithAdmission: (execute) => runWithAdmission(execute),
  } satisfies CheckpointWorker;
});
