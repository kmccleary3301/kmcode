import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { compactStateDatabase } from "./sqliteStateMaintenance.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const compactDatabaseCommand = Command.make("compact", {
  baseDir: baseDirFlag,
  offlineMaintenance: Flag.Boolean("offline-maintenance").pipe(
    Flag.withDescription("Required opt-in; stop the KM Code server before compacting its database."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Prune old state and reclaim database space while the server is stopped."),
  Command.withHandler(({ baseDir, offlineMaintenance }) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveBaseDir(Option.getOrUndefined(baseDir));
      const result = yield* compactStateDatabase({
        baseDir: resolvedBaseDir,
        offlineMaintenance,
      });
      yield* Console.log(encodeJson(result));
    }),
  ),
);

export const databaseCommand = Command.make("database").pipe(
  Command.withDescription("Inspect and maintain the local SQLite state database."),
  Command.withSubcommands([compactDatabaseCommand]),
);
