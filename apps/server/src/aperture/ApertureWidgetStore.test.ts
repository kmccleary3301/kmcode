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

const widgetModule = `export const defineWidget = (input) => input;\nexport default defineWidget({ id: "km-thread-a-demo-widget" });\n`;
const widgetDiagnostics: ReadonlyArray<ApertureWidgetStore.ApertureWidgetDiagnostic> = [
  {
    file: "km-thread-a-demo-widget.tsx",
    line: 3,
    column: 8,
    severity: "error" as const,
    text: "Expected an expression",
    lineText: "  )",
  },
];

const makeStore = (respond: (path: string, method: string) => Response) => {
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      return HttpClientResponse.fromWeb(
        request,
        respond(`${url.pathname}${url.search}`, request.method),
      );
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
              widget: { id: "km-thread-a-demo-widget", version: "a".repeat(64) },
              diagnostics: [],
            },
            { status: 201 },
          ),
        );
        expect(
          yield* compiled.push({ id: "km-thread-a-demo-widget", source: "valid source" }),
        ).toEqual({
          id: "km-thread-a-demo-widget",
          version: "a".repeat(64),
          diagnostics: [],
        });

        const rejected = yield* makeStore(() =>
          Response.json({ diagnostics: widgetDiagnostics }, { status: 400 }),
        );
        expect(
          yield* rejected.push({ id: "km-thread-a-demo-widget", source: "invalid source" }),
        ).toEqual({
          id: "km-thread-a-demo-widget",
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
        const modulePath = path.join(
          stateDir,
          "aperture-widgets",
          `km-thread-a-demo-widget.${version}.js`,
        );
        let requestedPath = "";
        const online = yield* makeStore((url) => {
          requestedPath = url;
          return new Response(widgetModule, { status: 200 });
        });
        expect(yield* online.module({ id: "km-thread-a-demo-widget", version })).toBe(widgetModule);
        expect(requestedPath).toBe(`/api/dev/widgets/km-thread-a-demo-widget.js?v=${version}`);
        expect(yield* fs.readFileString(modulePath)).toBe(widgetModule);

        const restarted = yield* makeStore(() => new Response("offline", { status: 503 }));
        expect(yield* restarted.module({ id: "km-thread-a-demo-widget", version })).toBe(
          widgetModule,
        );

        yield* fs.writeFileString(modulePath, `${widgetModule}tampered`);
        const tampered = yield* makeStore(
          () => new Response(`${widgetModule}tampered`, { status: 200 }),
        );
        const error = yield* tampered
          .module({ id: "km-thread-a-demo-widget", version })
          .pipe(Effect.flip);
        expect(error.code).toBe("integrity");
        expect(yield* fs.exists(modulePath)).toBe(false);
      }),
    ));

  it("preserves pinned module bytes across re-push and upstream deletion", () =>
    runInStateDir(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const id = "km-thread-a-demo-widget";
        const version = yield* widgetVersion;
        const modulePath = path.join(stateDir, "aperture-widgets", `${id}.${version}.js`);
        const requests: Array<string> = [];
        const store = yield* makeStore((url, method) => {
          requests.push(`${method} ${url}`);
          if (method === "POST" && url === "/api/dev/widgets") {
            return Response.json(
              {
                widget: {
                  id,
                  version: "c".repeat(64),
                  updatedAt: "2026-11-04T00:00:00.000Z",
                },
                diagnostics: [],
              },
              { status: 201 },
            );
          }
          if (method === "GET" && url === "/api/dev/widgets") {
            return Response.json([
              { id, version, updatedAt: "2026-11-04T00:00:00.000Z" },
              {
                id: "km-thread-b-other-widget",
                version: "b".repeat(64),
                updatedAt: "2026-11-04T00:00:00.000Z",
              },
            ]);
          }
          if (method === "DELETE" && url === `/api/dev/widgets?id=${id}`) {
            return Response.json({ deleted: id });
          }
          if (method === "GET" && url === `/api/dev/widgets/${id}.js?v=${version}`) {
            return new Response(widgetModule, { status: 200 });
          }
          return new Response("not found", { status: 404 });
        });

        expect(yield* store.module({ id, version })).toBe(widgetModule);
        expect(yield* store.push({ id, source: "updated source" })).toMatchObject({
          id,
          version: "c".repeat(64),
        });
        expect(yield* fs.readFileString(modulePath)).toBe(widgetModule);
        expect(yield* store.list({ prefix: "km-thread-a-" })).toEqual([
          { id, version, updatedAt: "2026-11-04T00:00:00.000Z" },
        ]);
        yield* store.delete({ id });
        expect(yield* fs.readFileString(modulePath)).toBe(widgetModule);

        const requestCount = requests.length;
        expect(yield* store.module({ id, version })).toBe(widgetModule);
        expect(requests).toEqual([
          `GET /api/dev/widgets/${id}.js?v=${version}`,
          "POST /api/dev/widgets",
          "GET /api/dev/widgets",
          `DELETE /api/dev/widgets?id=${id}`,
        ]);
        expect(requests).toHaveLength(requestCount);
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
