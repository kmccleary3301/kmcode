import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const WIDGET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const WIDGET_VERSION_PATTERN = /^[a-f0-9]{64}$/u;
const STORED_WIDGET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}\.[a-f0-9]{64}\.js$/u;
const WIDGET_MODULE_MAX_BYTES = 8 * 1024 * 1024;
const WIDGET_STORE_MAX_MODULES = 64;
const WIDGET_REQUEST_TIMEOUT = Duration.seconds(30);

export interface ApertureWidgetDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning";
  readonly text: string;
  readonly lineText?: string;
}

export interface ApertureWidgetRecord {
  readonly id: string;
  readonly version: string;
  readonly updatedAt: string;
}

export interface ApertureWidgetPushResult {
  readonly id: string;
  readonly version: string | null;
  readonly diagnostics: ReadonlyArray<ApertureWidgetDiagnostic>;
}

export class ApertureWidgetError extends Schema.TaggedError<ApertureWidgetError>()(
  "ApertureWidgetError",
  {
    code: Schema.Literals(["unavailable", "not_found", "integrity", "invalid", "unreachable"]),
    message: Schema.String,
  },
) {}

const WidgetDiagnosticSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
  severity: Schema.Literals(["error", "warning"]),
  text: Schema.String,
  lineText: Schema.optionalKey(Schema.String),
});
const PushWidgetResponseSchema = Schema.Struct({
  widget: Schema.Struct({ id: Schema.String, version: Schema.String }),
  diagnostics: Schema.Array(WidgetDiagnosticSchema),
});
const PushWidgetDiagnosticsSchema = Schema.Struct({
  diagnostics: Schema.Array(WidgetDiagnosticSchema),
});
const ListWidgetResponseJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
);
const DeleteWidgetResponseJson = Schema.fromJsonString(Schema.Struct({ deleted: Schema.String }));
const PushWidgetRequestJson = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, source: Schema.String }),
);
const PushWidgetResponseJson = Schema.fromJsonString(PushWidgetResponseSchema);
const PushWidgetDiagnosticsJson = Schema.fromJsonString(PushWidgetDiagnosticsSchema);
const encodePushWidgetRequest = Schema.encodeSync(PushWidgetRequestJson);

interface WidgetBytesAccumulator {
  readonly chunks: Array<Uint8Array<ArrayBufferLike>>;
  readonly byteLength: number;
}

const widgetError = (code: ApertureWidgetError["code"], message: string): ApertureWidgetError =>
  new ApertureWidgetError({ code, message });

export class ApertureWidgetStore extends Context.Service<
  ApertureWidgetStore,
  {
    readonly push: (input: {
      readonly id: string;
      readonly source: string;
    }) => Effect.Effect<ApertureWidgetPushResult, ApertureWidgetError>;
    readonly module: (input: {
      readonly id: string;
      readonly version: string;
    }) => Effect.Effect<string, ApertureWidgetError>;
    readonly list: (input: {
      readonly prefix: string;
    }) => Effect.Effect<ReadonlyArray<ApertureWidgetRecord>, ApertureWidgetError>;
    readonly delete: (input: { readonly id: string }) => Effect.Effect<void, ApertureWidgetError>;
  }
>()("t3/aperture/ApertureWidgetStore") {}

export const make = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const storeDirectory = path.join(config.stateDir, "aperture-widgets");

  const webBaseUrl = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => widgetError("unavailable", "Aperture web settings could not be read.")),
    );
    if (!settings.aperture.enabled) {
      return yield* Effect.fail(widgetError("unavailable", "Aperture is disabled."));
    }
    const configuredUrl = settings.aperture.webUrl.trim();
    if (configuredUrl.length === 0) {
      return yield* Effect.fail(widgetError("unavailable", "Aperture web URL is not configured."));
    }
    let url: URL;
    try {
      url = new URL(configuredUrl);
    } catch {
      return yield* Effect.fail(widgetError("unavailable", "Aperture web URL is invalid."));
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return yield* Effect.fail(widgetError("unavailable", "Aperture web URL is invalid."));
    }
    return url;
  });

  const storedPath = (id: string, version: string) =>
    path.join(storeDirectory, `${id}.${version}.js`);

  const isStoredSource = (version: string, source: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(source)).pipe(
      Effect.map((digest) => Hex.encode(digest) === version),
      Effect.orElseSucceed(() => false),
    );

  const readStored = (id: string, version: string) =>
    Effect.gen(function* () {
      const bytes = yield* fs.readFile(storedPath(id, version));
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
      return (yield* isStoredSource(version, source)) ? source : null;
    }).pipe(Effect.orElseSucceed(() => null));

  const store = (id: string, version: string, source: string) =>
    Effect.gen(function* () {
      yield* writeFileStringAtomically({
        filePath: storedPath(id, version),
        contents: source,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(() =>
          widgetError("unavailable", "The Aperture widget module could not be stored."),
        ),
      );
      yield* fs.readDirectory(storeDirectory).pipe(
        Effect.flatMap((entries) => {
          const modules = entries.filter((entry) => STORED_WIDGET_PATTERN.test(entry));
          if (modules.length <= WIDGET_STORE_MAX_MODULES) return Effect.void;
          return Effect.forEach(
            modules,
            (entry) =>
              fs.stat(path.join(storeDirectory, entry)).pipe(
                Effect.map((info) => ({
                  entry,
                  mtimeMs: Option.match(info.mtime, {
                    onNone: () => 0,
                    onSome: (mtime) => mtime.getTime(),
                  }),
                })),
              ),
            { concurrency: 4 },
          ).pipe(
            Effect.flatMap((aged) => {
              aged.sort((left, right) => left.mtimeMs - right.mtimeMs);
              return Effect.forEach(
                aged.slice(0, aged.length - WIDGET_STORE_MAX_MODULES),
                ({ entry }) => fs.remove(path.join(storeDirectory, entry)),
                { discard: true },
              );
            }),
          );
        }),
        Effect.ignoreCause({ log: true }),
      );
    });

  const fetchWidgetResponse = (request: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(request).pipe(
      Effect.timeout(WIDGET_REQUEST_TIMEOUT),
      Effect.mapError(() =>
        widgetError("unreachable", "Aperture widget service could not be reached."),
      ),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
  const list = Effect.fn("ApertureWidgetStore.list")(function* (input: {
    readonly prefix: string;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const baseUrl = yield* webBaseUrl;
        const response = yield* fetchWidgetResponse(
          HttpClientRequest.get(new URL("/api/dev/widgets", baseUrl).toString()),
        );
        if (response.status === 404) {
          return yield* Effect.fail(
            widgetError("not_found", "Aperture widget route was not found."),
          );
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            widgetError("unavailable", `Aperture widget list returned HTTP ${response.status}.`),
          );
        }
        const responseText = yield* response.text.pipe(
          Effect.mapError(() =>
            widgetError("unreachable", "Aperture widget list response could not be read."),
          ),
        );
        const result = Schema.decodeUnknownOption(ListWidgetResponseJson)(responseText);
        if (Option.isNone(result)) {
          return yield* Effect.fail(
            widgetError("invalid", "Aperture returned an invalid widget list."),
          );
        }
        return result.value.filter(
          (widget) =>
            WIDGET_ID_PATTERN.test(widget.id) &&
            WIDGET_VERSION_PATTERN.test(widget.version) &&
            widget.id.startsWith(input.prefix),
        );
      }),
    );
  });

  const deleteWidget = Effect.fn("ApertureWidgetStore.delete")(function* (input: {
    readonly id: string;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        if (!WIDGET_ID_PATTERN.test(input.id)) {
          return yield* Effect.fail(
            widgetError(
              "invalid",
              "Widget id must contain lowercase letters, numbers, hyphens, or underscores.",
            ),
          );
        }
        const baseUrl = yield* webBaseUrl;
        const url = new URL("/api/dev/widgets", baseUrl);
        url.searchParams.set("id", input.id);
        const response = yield* fetchWidgetResponse(HttpClientRequest.delete(url.toString()));
        if (response.status === 404) {
          return yield* Effect.fail(widgetError("not_found", "Aperture widget was not found."));
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            widgetError(
              "unavailable",
              `Aperture widget deletion returned HTTP ${response.status}.`,
            ),
          );
        }
        const responseText = yield* response.text.pipe(
          Effect.mapError(() =>
            widgetError("unreachable", "Aperture widget deletion response could not be read."),
          ),
        );
        const result = Schema.decodeUnknownOption(DeleteWidgetResponseJson)(responseText);
        if (Option.isNone(result) || result.value.deleted !== input.id) {
          return yield* Effect.fail(
            widgetError("invalid", "Aperture returned an invalid widget deletion response."),
          );
        }
      }),
    );
  });

  const push = Effect.fn("ApertureWidgetStore.push")(function* (input: {
    readonly id: string;
    readonly source: string;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        if (!WIDGET_ID_PATTERN.test(input.id)) {
          return yield* Effect.fail(
            widgetError(
              "invalid",
              "Widget id must contain lowercase letters, numbers, hyphens, or underscores.",
            ),
          );
        }
        const baseUrl = yield* webBaseUrl;
        const url = new URL("/api/dev/widgets", baseUrl);
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyText(
            encodePushWidgetRequest({ id: input.id, source: input.source }),
            "application/json",
          ),
        );
        const response = yield* fetchWidgetResponse(request);
        const responseText = yield* response.text.pipe(
          Effect.mapError(() =>
            widgetError("unreachable", "Aperture widget response could not be read."),
          ),
        );
        if (response.status === 201) {
          const result = Schema.decodeUnknownOption(PushWidgetResponseJson)(responseText);
          if (
            Option.isNone(result) ||
            result.value.widget.id !== input.id ||
            !WIDGET_VERSION_PATTERN.test(result.value.widget.version)
          ) {
            return yield* Effect.fail(
              widgetError("invalid", "Aperture returned an invalid widget response."),
            );
          }
          return {
            id: result.value.widget.id,
            version: result.value.widget.version,
            diagnostics: result.value.diagnostics,
          } satisfies ApertureWidgetPushResult;
        }
        if (response.status === 400) {
          const result = Schema.decodeUnknownOption(PushWidgetDiagnosticsJson)(responseText);
          if (Option.isNone(result)) {
            return yield* Effect.fail(
              widgetError("invalid", "Aperture rejected the widget source."),
            );
          }
          return {
            id: input.id,
            version: null,
            diagnostics: result.value.diagnostics,
          } satisfies ApertureWidgetPushResult;
        }
        if (response.status === 404 && responseText.includes("Runtime widgets are disabled")) {
          return yield* Effect.fail(
            widgetError("unavailable", "Aperture runtime widgets are disabled."),
          );
        }
        if (response.status === 404) {
          return yield* Effect.fail(
            widgetError("not_found", "Aperture widget route was not found."),
          );
        }
        return yield* Effect.fail(
          widgetError("unavailable", `Aperture widget push returned HTTP ${response.status}.`),
        );
      }),
    );
  });

  const module = Effect.fn("ApertureWidgetStore.module")(function* (input: {
    readonly id: string;
    readonly version: string;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        if (!WIDGET_ID_PATTERN.test(input.id)) {
          return yield* Effect.fail(
            widgetError(
              "invalid",
              "Widget id must contain lowercase letters, numbers, hyphens, or underscores.",
            ),
          );
        }
        if (!WIDGET_VERSION_PATTERN.test(input.version)) {
          return yield* Effect.fail(
            widgetError("invalid", "Widget version must be a SHA-256 hash."),
          );
        }
        const stored = yield* readStored(input.id, input.version);
        if (stored !== null) return stored;
        yield* fs.remove(storedPath(input.id, input.version), { force: true }).pipe(Effect.ignore);

        const baseUrl = yield* webBaseUrl;
        const url = new URL(`/api/dev/widgets/${input.id}.js`, baseUrl);
        url.searchParams.set("v", input.version);
        const response = yield* fetchWidgetResponse(
          HttpClientRequest.get(url.toString()).pipe(
            HttpClientRequest.setHeaders({
              accept: "text/javascript, application/javascript;q=0.9, */*;q=0.1",
            }),
          ),
        );
        if (response.status === 404) {
          return yield* Effect.fail(
            widgetError("not_found", "Aperture widget version was not found."),
          );
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            widgetError("unavailable", `Aperture widget module returned HTTP ${response.status}.`),
          );
        }
        const contentLength = response.headers["content-length"];
        if (contentLength !== undefined) {
          const declaredLength = Number(contentLength);
          if (
            !Number.isFinite(declaredLength) ||
            declaredLength < 0 ||
            declaredLength > WIDGET_MODULE_MAX_BYTES
          ) {
            return yield* Effect.fail(
              widgetError("invalid", "Aperture widget module exceeds the size limit."),
            );
          }
        }
        const accumulated = yield* response.stream.pipe(
          Stream.mapError(() =>
            widgetError("unreachable", "Aperture widget module download was interrupted."),
          ),
          Stream.runFoldEffect<
            WidgetBytesAccumulator,
            Uint8Array<ArrayBufferLike>,
            ApertureWidgetError,
            never
          >(
            () => ({ chunks: [], byteLength: 0 }),
            (state, chunk) => {
              const byteLength = state.byteLength + chunk.byteLength;
              if (byteLength > WIDGET_MODULE_MAX_BYTES) {
                return Effect.fail(
                  widgetError("invalid", "Aperture widget module exceeds the size limit."),
                );
              }
              state.chunks.push(chunk);
              return Effect.succeed({ chunks: state.chunks, byteLength });
            },
          ),
        );
        const bytes = new Uint8Array(accumulated.byteLength);
        let offset = 0;
        for (const chunk of accumulated.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return yield* Effect.fail(
            widgetError("invalid", "Aperture widget module is not valid UTF-8."),
          );
        }
        if (!(yield* isStoredSource(input.version, source))) {
          return yield* Effect.fail(
            widgetError("integrity", "Aperture widget module hash verification failed."),
          );
        }
        yield* store(input.id, input.version, source);
        return source;
      }),
    );
  });

  return ApertureWidgetStore.of({ push, module, list, delete: deleteWidget });
});

export const layer = Layer.effect(ApertureWidgetStore, make);
