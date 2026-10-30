import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const STATE_DIRECTORY_LOCK_FILE_NAME = ".t3-state-directory-lock.sqlite";

export class StateDirectoryLockError extends Schema.TaggedError<StateDirectoryLockError>()(
  "StateDirectoryLockError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not acquire the exclusive lock for state directory ${this.stateDir}; another KM Code process may already be using it. Stop that process or use a different --base-dir.`;
  }
}

export const acquireStateDirectoryLock = Effect.fn("acquireStateDirectoryLock")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(stateDir, { recursive: true });

  const lockPath = path.join(stateDir, STATE_DIRECTORY_LOCK_FILE_NAME);
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(lockPath);
        try {
          database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
          return database;
        } catch (cause) {
          try {
            database.close();
          } catch {
            // Keep the acquisition error as the cause reported to the caller.
          }
          throw cause;
        }
      },
      catch: (cause) => new StateDirectoryLockError({ stateDir, cause }),
    }),
    (database) => Effect.sync(() => database.close()),
  );
});

export const withStateDirectoryLock = <A, E, R>(
  stateDir: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* acquireStateDirectoryLock(stateDir);
      return yield* effect;
    }),
  );
