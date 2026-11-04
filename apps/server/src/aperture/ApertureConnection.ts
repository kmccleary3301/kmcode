import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  type ApertureConnectionError as ApertureConnectionErrorType,
  type ApertureConnectionErrorCode,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const API_KEY_SECRET_NAME = "aperture-api-key";
const REQUEST_TIMEOUT = Duration.seconds(15);

const ApertureViewerDto = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    username: Schema.String,
    email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  memberships: Schema.Array(
    Schema.Struct({
      entity: Schema.Struct({ name: Schema.String }),
    }),
  ),
});
export type ApertureViewer = typeof ApertureViewerDto.Type;

const ApertureProjectDto = Schema.Struct({
  name: Schema.String,
  display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ApertureProject = typeof ApertureProjectDto.Type;

const HealthResponse = Schema.Struct({ status: Schema.String });

export interface ApertureRequestInput {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: string | null;
  readonly accept: string | null;
}

export class ApertureConnection extends Context.Service<
  ApertureConnection,
  {
    readonly viewer: Effect.Effect<ApertureViewer, ApertureConnectionErrorType>;
    readonly projects: (
      entity: string,
    ) => Effect.Effect<ReadonlyArray<ApertureProject>, ApertureConnectionErrorType>;
    readonly health: Effect.Effect<boolean, ApertureConnectionErrorType>;
    readonly ready: Effect.Effect<boolean, ApertureConnectionErrorType>;
    readonly request: (
      input: ApertureRequestInput,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      ApertureConnectionErrorType,
      Scope.Scope
    >;
  }
>()("t3/aperture/ApertureConnection") {}

const connectionError = (
  code: ApertureConnectionErrorCode,
  message: string,
): ApertureConnectionErrorType => ({ _tag: "ApertureConnectionError", code, message });

const make = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const apiUrl = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() =>
        connectionError("unreachable", "Aperture API settings could not be read."),
      ),
    );
    const baseUrl = settings.aperture.apiUrl.trim().replace(/\/+$/u, "");
    if (baseUrl.length === 0) {
      return yield* Effect.fail(
        connectionError("unreachable", "Aperture API URL is not configured."),
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      return yield* Effect.fail(connectionError("bad_response", "Aperture API URL is invalid."));
    }
    if (
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.username.length > 0 ||
      parsedUrl.password.length > 0 ||
      parsedUrl.search.length > 0 ||
      parsedUrl.hash.length > 0
    ) {
      return yield* Effect.fail(connectionError("bad_response", "Aperture API URL is invalid."));
    }
    return baseUrl;
  });

  const apiToken = Effect.gen(function* () {
    const storedKey = yield* secretStore
      .get(API_KEY_SECRET_NAME)
      .pipe(
        Effect.mapError(() =>
          connectionError("unreachable", "Aperture API credentials could not be read."),
        ),
      );
    if (storedKey._tag === "None") {
      return yield* Effect.fail(
        connectionError("unauthorized", "Aperture API key is not configured."),
      );
    }
    try {
      const token = new TextDecoder("utf-8", { fatal: true }).decode(storedKey.value);
      if (token.trim().length === 0) {
        return yield* Effect.fail(
          connectionError("unauthorized", "Aperture API key is not configured."),
        );
      }
      return token;
    } catch {
      return yield* Effect.fail(connectionError("unauthorized", "Aperture API key is invalid."));
    }
  });

  const request = (input: ApertureRequestInput) =>
    Effect.gen(function* () {
      const [baseUrl, token] = yield* Effect.all([apiUrl, apiToken]);
      let url: URL;
      try {
        const base = new URL(baseUrl);
        url = new URL(input.path, `${base.origin}/`);
        if (url.origin !== base.origin || url.hash.length > 0) {
          return yield* Effect.fail(
            connectionError("bad_response", "Aperture request path is invalid."),
          );
        }
      } catch {
        return yield* Effect.fail(
          connectionError("bad_response", "Aperture API URL or request path is invalid."),
        );
      }

      let upstreamRequest = HttpClientRequest.make(input.method)(url).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "accept-encoding": "identity",
          ...(input.accept === null ? {} : { accept: input.accept }),
        }),
      );
      if (input.body !== null) {
        upstreamRequest = upstreamRequest.pipe(
          HttpClientRequest.bodyText(input.body, "application/json"),
        );
      }
      return yield* httpClient.execute(upstreamRequest).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() =>
          connectionError("unreachable", "Aperture could not be reached in time."),
        ),
        Effect.flatMap((response) => {
          if (response.status === 401) {
            return Effect.fail(connectionError("unauthorized", "Aperture rejected the API key."));
          }
          if (response.status === 403) {
            return Effect.fail(
              connectionError("forbidden", "The Aperture API key does not have read access."),
            );
          }
          return Effect.succeed(response);
        }),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
    });

  const decodeJson = <A, I>(
    response: HttpClientResponse.HttpClientResponse,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, ApertureConnectionErrorType> =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() =>
        connectionError("bad_response", "Aperture returned an invalid response."),
      ),
    );

  const readJson = <A, I>(input: ApertureRequestInput, schema: Schema.Codec<A, I>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* request(input);
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            connectionError("bad_response", `Aperture returned HTTP ${response.status}.`),
          );
        }
        return yield* decodeJson(response, schema);
      }),
    );

  const health = Effect.scoped(
    Effect.gen(function* () {
      const baseUrl = yield* apiUrl;
      let url: URL;
      try {
        url = new URL("/healthz", `${baseUrl}/`);
      } catch {
        return yield* Effect.fail(connectionError("bad_response", "Aperture API URL is invalid."));
      }
      const response = yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() =>
          connectionError("unreachable", "Aperture health check timed out or could not connect."),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
      if (response.status < 200 || response.status >= 300) return false;
      const status = yield* decodeJson(response, HealthResponse);
      return status.status === "ok";
    }),
  );

  const ready = Effect.scoped(
    Effect.gen(function* () {
      const baseUrl = yield* apiUrl;
      let url: URL;
      try {
        url = new URL("/readyz", `${baseUrl}/`);
      } catch {
        return yield* Effect.fail(connectionError("bad_response", "Aperture API URL is invalid."));
      }
      const response = yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() =>
          connectionError(
            "unreachable",
            "Aperture readiness check timed out or could not connect.",
          ),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
      return response.status >= 200 && response.status < 300;
    }),
  );

  return ApertureConnection.of({
    request,
    viewer: readJson(
      { method: "GET", path: "/api/v1/viewer", body: null, accept: "application/json" },
      ApertureViewerDto,
    ),
    projects: (entity) =>
      readJson(
        {
          method: "GET",
          path: `/api/v1/entities/${encodeURIComponent(entity)}/projects`,
          body: null,
          accept: "application/json",
        },
        Schema.Array(ApertureProjectDto),
      ),
    health,
    ready,
  });
});

export const layer = Layer.effect(ApertureConnection, make);
