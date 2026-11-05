import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  ThreadId,
  type ApertureConnectionError,
  type ApertureFetchInput,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ApertureConnection from "./ApertureConnection.ts";
import * as ApertureEmbedBridge from "./ApertureEmbedBridge.ts";
import * as ApertureEmbedToken from "./ApertureEmbedToken.ts";
import { signApertureEmbedToken, verifyApertureEmbedToken } from "./ApertureEmbedToken.ts";

const secret = new TextEncoder().encode("aperture embed bridge test key");
const threadId = ThreadId.make("thread-1");
const tokenPayload = {
  refId: "embed-ref",
  threadId,
  entity: "acme",
  project: "widgets",
  asOf: "2025-01-02T03:04:05Z",
};
const validToken = signApertureEmbedToken(tokenPayload, secret);
const fetchInput = {
  threadId: tokenPayload.threadId,
  embedToken: validToken,
  mode: "live",
  method: "GET",
  path: "/api/v1/viewer",
  body: null,
  accept: null,
} satisfies ApertureFetchInput;

const tokenService: ApertureEmbedToken.ApertureEmbedToken["Service"] = {
  issue: (input) => Effect.succeed(signApertureEmbedToken(input, secret)),
  verify: ({ token, threadId }) =>
    Effect.succeed(verifyApertureEmbedToken(token, threadId, secret)),
};

const secretStore: ServerSecretStore.ServerSecretStore["Service"] = {
  get: () => Effect.succeed(Option.some(new TextEncoder().encode("upstream-test-key"))),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  remove: () => Effect.void,
};

const upstreamUnauthorized = {
  _tag: "ApertureConnectionError",
  code: "unauthorized",
  message: "Aperture rejected the API key.",
} satisfies ApertureConnectionError;

const unauthorizedConnection: ApertureConnection.ApertureConnection["Service"] = {
  viewer: Effect.fail(upstreamUnauthorized),
  projects: () => Effect.fail(upstreamUnauthorized),
  health: Effect.succeed(false),
  ready: Effect.succeed(false),
  request: () => Effect.fail(upstreamUnauthorized),
};

const makeBridgeLayer = (
  responseBody: ReadableStream<Uint8Array>,
  onRequest: () => void = () => {},
) => {
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      onRequest();
      return HttpClientResponse.fromWeb(
        request,
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    }),
  );
  const connectionDependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
    ServerSettings.layerTest({ aperture: { apiUrl: "https://aperture.invalid" } }),
  );
  const connectionLayer = ApertureConnection.layer.pipe(Layer.provide(connectionDependencies));
  const bridgeDependencies = Layer.mergeAll(
    connectionLayer,
    Layer.succeed(ApertureEmbedToken.ApertureEmbedToken, tokenService),
  );

  return ApertureEmbedBridge.layer.pipe(Layer.provide(bridgeDependencies));
};

const collectBridgeFetch = (input: ApertureFetchInput) =>
  Effect.gen(function* () {
    const bridge = yield* ApertureEmbedBridge.ApertureEmbedBridge;
    return yield* Stream.runCollect(bridge.fetch(input));
  });

describe("Aperture embed bridge", () => {
  it("rejects an invalid embed token before making an upstream request", async () => {
    let requestCount = 0;
    const invalidInput = {
      ...fetchInput,
      embedToken: "invalid-token",
    } satisfies ApertureFetchInput;
    const responseBody = new ReadableStream<Uint8Array>();
    const layer = makeBridgeLayer(responseBody, () => {
      requestCount += 1;
    });
    const result = await Effect.runPromise(
      Effect.provide(Effect.result(collectBridgeFetch(invalidInput)), layer),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("invalid_ref");
    expect(requestCount).toBe(0);
  });

  it("returns the upstream unauthorized error code", async () => {
    const layer = ApertureEmbedBridge.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ApertureConnection.ApertureConnection, unauthorizedConnection),
          Layer.succeed(ApertureEmbedToken.ApertureEmbedToken, tokenService),
        ),
      ),
    );
    const result = await Effect.runPromise(
      Effect.provide(Effect.result(collectBridgeFetch(fetchInput)), layer),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("unauthorized");
  });

  it("cancels the upstream response body when the consumer interrupts the bridge stream", async () => {
    let upstreamCanceled = false;
    let resolveChunkConsumed: () => void = () => {};
    let resolveCanceled: () => void = () => {};
    const chunkConsumed = new Promise<void>((resolve) => {
      resolveChunkConsumed = resolve;
    });
    const canceled = new Promise<void>((resolve) => {
      resolveCanceled = resolve;
    });
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        upstreamCanceled = true;
        resolveCanceled();
      },
    });
    const layer = makeBridgeLayer(responseBody);
    const interruptAfterChunk = Effect.gen(function* () {
      const bridge = yield* ApertureEmbedBridge.ApertureEmbedBridge;
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(bridge.fetch(fetchInput), (event) => {
          if (event.type === "chunk") {
            return Effect.sync(resolveChunkConsumed).pipe(Effect.flatMap(() => Effect.never));
          }
          return Effect.void;
        }),
        { startImmediately: true },
      );

      yield* Effect.promise(() => chunkConsumed);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => canceled);
      expect(upstreamCanceled).toBe(true);
    });

    await Effect.runPromise(Effect.provide(interruptAfterChunk, layer));
  });
});
