import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  type ApertureConnectionError as ApertureConnectionErrorType,
  type ApertureFetchError as ApertureFetchErrorType,
  type ApertureFetchErrorCode,
  type ApertureFetchInput,
  type ApertureFetchStreamEvent,
} from "@t3tools/contracts";
import * as ApertureConnection from "./ApertureConnection.ts";
import * as ApertureEmbedToken from "./ApertureEmbedToken.ts";
import { authorizeApertureEmbedRequest } from "./ApertureEmbedPolicy.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_STREAMS_PER_THREAD = 4;

export class ApertureEmbedBridge extends Context.Service<
  ApertureEmbedBridge,
  {
    readonly fetch: (
      input: ApertureFetchInput,
    ) => Stream.Stream<ApertureFetchStreamEvent, ApertureFetchErrorType>;
  }
>()("t3/aperture/ApertureEmbedBridge") {}

const fetchError = (code: ApertureFetchErrorCode, message: string): ApertureFetchErrorType => ({
  _tag: "ApertureFetchError",
  code,
  message,
});

const connectionFetchError = (error: ApertureConnectionErrorType) =>
  fetchError(error.code, error.message);

const make = Effect.gen(function* () {
  const connection = yield* ApertureConnection.ApertureConnection;
  const embedToken = yield* ApertureEmbedToken.ApertureEmbedToken;
  const activeStreams = yield* Ref.make(new Map<string, number>());

  const acquireStream = (threadId: string) =>
    Ref.modify(activeStreams, (active): readonly [boolean, Map<string, number>] => {
      const count = active.get(threadId) ?? 0;
      if (count >= MAX_CONCURRENT_STREAMS_PER_THREAD) return [false, active];
      const next = new Map(active);
      next.set(threadId, count + 1);
      return [true, next];
    }).pipe(
      Effect.flatMap((acquired) =>
        acquired
          ? Effect.void
          : Effect.fail(
              fetchError(
                "too_many_streams",
                "This thread already has the maximum number of Aperture streams open.",
              ),
            ),
      ),
    );

  const releaseStream = (threadId: string) =>
    Ref.update(activeStreams, (active) => {
      const count = active.get(threadId) ?? 0;
      if (count <= 1) {
        const next = new Map(active);
        next.delete(threadId);
        return next;
      }
      const next = new Map(active);
      next.set(threadId, count - 1);
      return next;
    });

  const fetch = (input: ApertureFetchInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tokenOption = yield* embedToken
          .verify({ token: input.embedToken, threadId: input.threadId })
          .pipe(
            Effect.mapError(() =>
              fetchError("bad_response", "Aperture embed reference could not be verified."),
            ),
          );
        if (Option.isNone(tokenOption)) {
          return yield* Effect.fail(
            fetchError("invalid_ref", "Aperture embed token is invalid for this thread."),
          );
        }
        const token = tokenOption.value;
        const policy = authorizeApertureEmbedRequest({ request: input, token });
        if (!policy.allowed) return yield* Effect.fail(fetchError(policy.code, policy.message));

        yield* Effect.acquireRelease(acquireStream(input.threadId), () =>
          releaseStream(input.threadId),
        );
        const response = yield* connection
          .request({
            method: input.method,
            path: policy.path,
            body: policy.body,
            accept: input.accept,
          })
          .pipe(Effect.mapError(connectionFetchError));

        const contentLength = response.headers["content-length"];
        if (contentLength !== undefined) {
          const declaredBytes = Number(contentLength);
          if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
            return yield* Effect.fail(
              fetchError("bad_response", "Aperture response has an invalid content length."),
            );
          }
          if (declaredBytes > MAX_RESPONSE_BYTES) {
            return yield* Effect.fail(
              fetchError("too_large", "Aperture response exceeds the embed size limit."),
            );
          }
        }

        const headers: Array<readonly [string, string]> = [];
        for (const name of ["content-type", "cache-control"]) {
          const value = response.headers[name];
          if (value !== undefined) headers.push([name, value]);
        }
        const head: ApertureFetchStreamEvent = {
          type: "head",
          status: response.status,
          statusText: `HTTP ${response.status}`,
          headers,
        };
        const end: ApertureFetchStreamEvent = { type: "end" };
        const bytesSent = yield* Ref.make(0);
        const chunks = response.stream.pipe(
          Stream.mapError(() =>
            fetchError("unreachable", "Aperture response stream was interrupted."),
          ),
          Stream.mapEffect((data) =>
            Ref.modify(bytesSent, (current): readonly [boolean, number] => {
              const next = current + data.byteLength;
              return next > MAX_RESPONSE_BYTES ? [false, current] : [true, next];
            }).pipe(
              Effect.flatMap((withinLimit) =>
                withinLimit
                  ? Effect.succeed<ApertureFetchStreamEvent>({ type: "chunk", data })
                  : Effect.fail(
                      fetchError("too_large", "Aperture response exceeds the embed size limit."),
                    ),
              ),
            ),
          ),
        );
        return Stream.concat(Stream.make(head), Stream.concat(chunks, Stream.make(end)));
      }),
    );

  return ApertureEmbedBridge.of({ fetch });
});

export const layer = Layer.effect(ApertureEmbedBridge, make);
