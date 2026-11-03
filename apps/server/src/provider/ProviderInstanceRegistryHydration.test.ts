import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEV_REPLAY_INSTANCE_ID,
  seedDevReplayInstance,
} from "./ProviderInstanceRegistryHydration.ts";

describe("seedDevReplayInstance", () => {
  const seed = (devUrl: URL | undefined) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* seedDevReplayInstance().pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, devUrl }),
      );
      const settings = yield* ServerSettingsService;
      return (yield* settings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-replay-seed-" }),
          ServerSettingsService.layerTest({
            providerInstances: {
              [DEV_REPLAY_INSTANCE_ID]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName: "My replay",
                enabled: false,
                config: { source: "local", commandPath: "/old/node" },
              },
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

  effectIt.effect("leaves settings alone outside dev", () =>
    seed(undefined).pipe(
      Effect.map((instance) =>
        expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
      ),
    ),
  );

  effectIt.effect("points a dev server at the replay agent and keeps user edits", () =>
    seed(new URL("http://localhost:5733")).pipe(
      Effect.map((instance) => {
        expect(instance?.displayName).toBe("My replay");
        expect(instance?.enabled).toBe(false);
        expect(instance?.config).toMatchObject({
          source: "local",
          commandPath: process.execPath,
          commandArgs: [expect.stringMatching(/scripts[/\\]dev-replay-agent\.ts$/)],
        });
      }),
    ),
  );
});
