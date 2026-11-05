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
import * as ApertureWidgetStore from "./ApertureWidgetStore.ts";

const widgetModule = `export const defineWidget = (input) => input;\nexport default defineWidget({ id: "demo-widget" });\n`;
const widgetDiagnostics: ReadonlyArray<ApertureWidgetStore.ApertureWidgetDiagnostic> = [
  {
    file: "demo-widget.tsx",
    line: 3,
    column: 8,
    severity: "error" as const,
    text: "Expected an expression",
  },
];

const makeStore = (respond: (path: string) => Response) => {
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      return HttpClientResponse.fromWeb(request, respond(`${url.pathname}${url.search}`));
    }),
  );
  return ApertureWidgetStore.make.pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provide(
      ServerSettings.layerTest({
        aperture: { enabled: true, webUrl: "https://aperture.invalid" },
      }),
    ),
  );
};

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
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-aperture-widgets-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

const widgetVersion = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(widgetModule)));
});

describe("Aperture widget store", () => {
  it("maps successful pushes and compile diagnostics", () =>
    runInStateDir(
      Effect.gen(function* () {
        const compiled = yield* makeStore(() =>
          Response.json(
            {
              widget: { id: "demo-widget", version: "a".repeat(64) },
              diagnostics: [],
            },
            { status: 201 },
          ),
        );
        expect(yield* compiled.push({ id: "demo-widget", source: "valid source" })).toEqual({
          id: "demo-widget",
          version: "a".repeat(64),
          diagnostics: [],
        });

        const rejected = yield* makeStore(() =>
          Response.json({ diagnostics: widgetDiagnostics }, { status: 400 }),
        );
        expect(yield* rejected.push({ id: "demo-widget", source: "invalid source" })).toEqual({
          id: "demo-widget",
          version: null,
          diagnostics: widgetDiagnostics,
        });
      }),
    ));

  it("loads and verifies a widget module, keeps it available after restart, and rejects tampering", () =>
    runInStateDir(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const version = yield* widgetVersion;
        const modulePath = path.join(stateDir, "aperture-widgets", `demo-widget.${version}.js`);
        let requestedPath = "";
        const online = yield* makeStore((url) => {
          requestedPath = url;
          return new Response(widgetModule, { status: 200 });
        });
        expect(yield* online.module({ id: "demo-widget", version })).toBe(widgetModule);
        expect(requestedPath).toBe(`/api/dev/widgets/demo-widget.js?v=${version}`);
        expect(yield* fs.readFileString(modulePath)).toBe(widgetModule);

        const restarted = yield* makeStore(() => new Response("offline", { status: 503 }));
        expect(yield* restarted.module({ id: "demo-widget", version })).toBe(widgetModule);

        yield* fs.writeFileString(modulePath, `${widgetModule}tampered`);
        const tampered = yield* makeStore(
          () => new Response(`${widgetModule}tampered`, { status: 200 }),
        );
        const error = yield* tampered.module({ id: "demo-widget", version }).pipe(Effect.flip);
        expect(error.code).toBe("integrity");
        expect(yield* fs.exists(modulePath)).toBe(false);
      }),
    ));

  it("rejects invalid widget ids before making a request", () =>
    runInStateDir(
      Effect.gen(function* () {
        let requests = 0;
        const store = yield* makeStore(() => {
          requests += 1;
          return new Response("unavailable", { status: 503 });
        });
        const error = yield* store
          .module({ id: "../outside", version: "a".repeat(64) })
          .pipe(Effect.flip);
        expect(error.code).toBe("invalid");
        expect(requests).toBe(0);
      }),
    ));
});
