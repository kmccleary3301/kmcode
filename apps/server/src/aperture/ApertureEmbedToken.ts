import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type ApertureEmbedTokenIssueInput,
  ApertureEmbedTokenPayloadSchema,
  type ApertureEmbedTokenPayload,
  type ApertureEmbedTokenVerificationInput,
} from "@t3tools/shared/apertureEmbed";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

const SIGNING_SECRET_NAME = "aperture-embed-signing-key";

const canonicalPayloadJson = (payload: ApertureEmbedTokenPayload): string =>
  JSON.stringify({
    refId: payload.refId,
    threadId: payload.threadId,
    entity: payload.entity,
    project: payload.project,
    asOf: payload.asOf,
  });

export function signApertureEmbedToken(payload: ApertureEmbedTokenIssueInput, secret: Uint8Array) {
  const payloadJson = canonicalPayloadJson(payload);
  const encodedPayload = base64UrlEncode(payloadJson);
  return `${encodedPayload}.${signPayload(payloadJson, secret)}`;
}

export function verifyApertureEmbedToken(
  token: string,
  threadId: string,
  secret: Uint8Array,
): Option.Option<ApertureEmbedTokenPayload> {
  const [encodedPayload, signature, extra] = token.split(".");
  if (encodedPayload === undefined || signature === undefined || extra !== undefined) {
    return Option.none();
  }

  let payloadJson: string;
  let decoded: unknown;
  try {
    payloadJson = base64UrlDecodeUtf8(encodedPayload);
    decoded = JSON.parse(payloadJson);
  } catch {
    return Option.none();
  }

  const payload = Schema.decodeUnknownOption(ApertureEmbedTokenPayloadSchema)(decoded);
  if (Option.isNone(payload)) return Option.none();
  if (payload.value.threadId !== threadId) return Option.none();
  if (canonicalPayloadJson(payload.value) !== payloadJson) return Option.none();
  return timingSafeEqualBase64Url(signature, signPayload(payloadJson, secret))
    ? payload
    : Option.none();
}

export class ApertureEmbedToken extends Context.Service<
  ApertureEmbedToken,
  {
    readonly issue: (
      input: ApertureEmbedTokenIssueInput,
    ) => Effect.Effect<string, ServerSecretStore.SecretStoreError>;
    readonly verify: (
      input: ApertureEmbedTokenVerificationInput,
    ) => Effect.Effect<
      Option.Option<ApertureEmbedTokenPayload>,
      ServerSecretStore.SecretStoreError
    >;
  }
>()("t3/aperture/ApertureEmbedToken") {}

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const key = secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);

  return ApertureEmbedToken.of({
    issue: (input) => Effect.map(key, (secret) => signApertureEmbedToken(input, secret)),
    verify: (input) =>
      Effect.map(key, (secret) => verifyApertureEmbedToken(input.token, input.threadId, secret)),
  });
});

export const layer = Layer.effect(ApertureEmbedToken, make);
