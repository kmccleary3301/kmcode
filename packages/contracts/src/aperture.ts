import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ApertureConnectionErrorCode = Schema.Literals([
  "unreachable",
  "unauthorized",
  "forbidden",
  "bad_response",
]);
export type ApertureConnectionErrorCode = typeof ApertureConnectionErrorCode.Type;

export const ApertureConnectionError = Schema.TaggedStruct("ApertureConnectionError", {
  code: ApertureConnectionErrorCode,
  message: Schema.String,
});
export type ApertureConnectionError = typeof ApertureConnectionError.Type;

export const ApertureTestConnectionInput = Schema.Struct({});
export type ApertureTestConnectionInput = typeof ApertureTestConnectionInput.Type;

export const ApertureTestConnectionResult = Schema.Struct({
  viewer: Schema.Struct({
    id: Schema.String,
    email: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
  }),
  projects: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      displayName: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type ApertureTestConnectionResult = typeof ApertureTestConnectionResult.Type;

export const ApertureFetchErrorCode = Schema.Literals([
  "unreachable",
  "unauthorized",
  "forbidden",
  "policy_denied",
  "pinned_live_denied",
  "too_large",
  "too_many_streams",
  "aborted",
  "bad_response",
  "invalid_ref",
]);
export type ApertureFetchErrorCode = typeof ApertureFetchErrorCode.Type;

export const ApertureFetchError = Schema.TaggedStruct("ApertureFetchError", {
  code: ApertureFetchErrorCode,
  message: Schema.String,
});
export type ApertureFetchError = typeof ApertureFetchError.Type;

export const ApertureFetchInput = Schema.Struct({
  threadId: ThreadId,
  embedToken: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  mode: Schema.Literals(["pinned", "live"]),
  method: Schema.Literals(["GET", "POST"]),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  body: Schema.NullOr(Schema.String),
  accept: Schema.NullOr(Schema.String),
});
export type ApertureFetchInput = typeof ApertureFetchInput.Type;

export const ApertureFetchStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("head"),
    status: Schema.Number,
    statusText: Schema.String,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  }),
  Schema.Struct({
    type: Schema.Literal("chunk"),
    data: Schema.Uint8Array,
  }),
  Schema.Struct({ type: Schema.Literal("end") }),
]);
export type ApertureFetchStreamEvent = typeof ApertureFetchStreamEvent.Type;
