// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  awaitNativeRun,
  configuredNativeRuntimes,
  lastAssistantText,
  launchNativeThread,
  makeNativeRoot,
  prepareNativeHome,
  startKmCodeServer,
  startNativeModelServer,
} from "./NativeLiveRuntime.integration.ts";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

it.live.skipIf(process.env.T3_INSTALLED_CLI === undefined)(
  "runs installed release artifact through Pi and OMP root turns",
  () =>
    Effect.gen(function* () {
      const installedCli = requiredEnvironment("T3_INSTALLED_CLI");
      const reportPath = requiredEnvironment("T3_INSTALLED_NATIVE_REPORT");
      const runtimes = configuredNativeRuntimes();
      assert.deepEqual(
        runtimes.map((binary) => binary.runtime),
        ["pi", "omp"],
        "Both exact native binaries must be configured",
      );
      const modelServer = yield* Effect.acquireRelease(
        Effect.promise(startNativeModelServer),
        (server) => Effect.promise(server.close),
      );
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => makeNativeRoot("km-installed-native-")),
        (directory) =>
          Effect.promise(() =>
            NodeFS.promises.rm(directory, { recursive: true, force: true, maxRetries: 50 }),
          ),
      );
      const home = yield* prepareNativeHome({ root, runtimes, modelServer });
      const server = yield* startKmCodeServer({ command: installedCli, prefixArgs: [], home });

      const completed: Array<string> = [];
      for (const { runtime } of runtimes) {
        const threadId = yield* launchNativeThread(server, {
          runtime,
          workspaceRoot: NodePath.join(root, `workspace-${runtime}`),
          text: `Installed artifact ${runtime} root turn.`,
        });
        const { run, projection } = yield* awaitNativeRun(server, { threadId, ordinal: 1 });
        assert.equal(run.status, "completed", `${runtime} root turn`);
        assert.include(lastAssistantText(projection), "NATIVE-MATRIX-OK");
        completed.push(runtime);
      }
      assert.deepEqual(completed, ["pi", "omp"]);
      const platform = yield* HostProcessPlatform;
      const architecture = yield* HostProcessArchitecture;
      yield* Effect.promise(() =>
        NodeFS.promises.writeFile(
          reportPath,
          `${JSON.stringify(
            {
              schemaVersion: 3,
              installedCli: { name: NodePath.basename(installedCli) },
              platform,
              architecture,
              runtimes: completed.map((runtime) => ({ runtime, rootTurn: "completed" })),
            },
            null,
            2,
          )}\n`,
        ),
      );
    }).pipe(Effect.scoped),
  240_000,
);
