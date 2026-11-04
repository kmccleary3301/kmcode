import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ApertureRuntime from "./ApertureRuntime.ts";

const PLACEHOLDER = "__APERTURE_RUNTIME_VERSION__";

const runtimeDocument = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const template = `<!doctype html><script>window.version="${PLACEHOLDER}"</script>`;
  const version = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(template)));
  return { version, html: template.replaceAll(PLACEHOLDER, version) };
});

/** Builds a runtime service whose Aperture web server answers with `files`, or is down when null. */
const makeRuntime = (files: Readonly<Record<string, string>> | null) => {
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = files === null ? undefined : files[new URL(request.url).pathname];
      return HttpClientResponse.fromWeb(
        request,
        new Response(body ?? "unavailable", { status: body === undefined ? 503 : 200 }),
      );
    }),
  );
  return ApertureRuntime.make.pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provide(ServerSettings.layerTest({ aperture: { webUrl: "https://aperture.invalid" } })),
  );
};

/** Runs `effect` against a fresh state directory shared by every runtime it builds. */
const runInStateDir = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-aperture-runtime-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

describe("Aperture runtime store", () => {
  it("serves a verified runtime version after a restart while Aperture is down", () =>
    runInStateDir(
      Effect.gen(function* () {
        const { version, html } = yield* runtimeDocument;
        const first = yield* makeRuntime({
          "/embed/runtime.version": `${version}\n`,
          "/embed/runtime.html": html,
        });
        expect((yield* first.getLatest).version).toBe(version);

        const restarted = yield* makeRuntime(null);
        const cached = yield* restarted.getCached(version);
        expect(cached === null ? null : new TextDecoder().decode(cached)).toBe(html);
        expect(yield* restarted.getCached("0".repeat(64))).toBeNull();
      }),
    ));

  it("drops a stored runtime whose contents no longer match its version", () =>
    runInStateDir(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const { version, html } = yield* runtimeDocument;
        const first = yield* makeRuntime({
          "/embed/runtime.version": version,
          "/embed/runtime.html": html,
        });
        yield* first.getLatest;
        yield* fs.writeFileString(
          path.join(stateDir, "aperture-runtime", `${version}.html`),
          html.replace("window", "parent"),
        );

        const restarted = yield* makeRuntime(null);
        expect(yield* restarted.getCached(version)).toBeNull();
      }),
    ));

  it("rejects and does not store a runtime whose contents do not match its version", () =>
    runInStateDir(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const { version, html } = yield* runtimeDocument;
        const runtime = yield* makeRuntime({
          "/embed/runtime.version": version,
          "/embed/runtime.html": html.replace("window", "parent"),
        });
        const error = yield* Effect.flip(runtime.getLatest);
        expect(error.code).toBe("bad_response");
        expect(yield* runtime.getCached(version)).toBeNull();
        expect(yield* fs.exists(path.join(stateDir, "aperture-runtime", `${version}.html`))).toBe(
          false,
        );
      }),
    ));
});
