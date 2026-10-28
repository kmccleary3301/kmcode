import { describe, expect, it } from "vite-plus/test";

import { sanitizeConnectionError } from "./portForwarding.ts";

describe("port forwarding error privacy", () => {
  it.each([
    "Failed wss://spark.example/api/ports/ws?port=1455&wsTicket=secret-token&host=localhost",
    "Authorization: Bearer secret-token rejected",
    "Authorization: DPoP secret-token rejected",
  ])("does not expose a credential in %s", (message) => {
    const sanitized = sanitizeConnectionError(new Error(message));
    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).toContain("[REDACTED]");
  });
});
