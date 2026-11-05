import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { ApertureEmbedTokenIssueInput } from "@t3tools/shared/apertureEmbed";
import { signApertureEmbedToken, verifyApertureEmbedToken } from "./ApertureEmbedToken.ts";

const secret = new TextEncoder().encode("aperture embed test key");
const payload = {
  refId: "embed-ref",
  threadId: "thread-1",
  entity: "acme",
  project: "widgets",
  asOf: "2025-01-02T03:04:05Z",
} satisfies ApertureEmbedTokenIssueInput;

const token = signApertureEmbedToken(payload, secret);

describe("Aperture embed token verification", () => {
  it("accepts a correctly signed token for its bound thread", () => {
    expect(Option.isSome(verifyApertureEmbedToken(token, payload.threadId, secret))).toBe(true);
  });

  it("rejects an invalid token", () => {
    expect(Option.isNone(verifyApertureEmbedToken("not-a-token", payload.threadId, secret))).toBe(
      true,
    );
  });

  it("rejects a token whose signature has been tampered with", () => {
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    expect(Option.isNone(verifyApertureEmbedToken(tamperedToken, payload.threadId, secret))).toBe(
      true,
    );
  });

  it("rejects a valid token when used by a different thread", () => {
    expect(Option.isNone(verifyApertureEmbedToken(token, "thread-2", secret))).toBe(true);
  });
});
