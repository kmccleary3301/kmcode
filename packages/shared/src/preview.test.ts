import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHost,
  newPreviewTabId,
  normalizePreviewUrl,
  previewUrlWithoutCredentials,
  PreviewUrlNormalizationError,
} from "./preview.ts";

describe("newPreviewTabId", () => {
  it("returns a unique tab id every call", () => {
    const a = newPreviewTabId();
    const b = newPreviewTabId();
    expect(a).not.toBe(b);
    expect(a.startsWith("tab_")).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["example.com", "192.168.1.10", "10.0.0.1", ""])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("normalizePreviewUrl", () => {
  it("treats bare loopback hosts as http", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("treats bare public hosts as https", () => {
    expect(normalizePreviewUrl("example.com")).toBe("https://example.com/");
  });

  it("respects explicit schemes", () => {
    expect(normalizePreviewUrl("https://localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizePreviewUrl("http://example.com/path?q=1")).toBe("http://example.com/path?q=1");
  });

  it("rejects empty input", () => {
    try {
      normalizePreviewUrl("   ");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect("cause" in (error as object)).toBe(false);
    }
  });

  it.each([
    ["ftp://example.com", "ftp:"],
    ["mailto:alice@example.com", "mailto:"],
  ])("rejects unsupported protocol %s", (url, protocol) => {
    try {
      normalizePreviewUrl(url);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: url.length,
        reason: "unsupported-protocol",
        protocol,
      });
    }
  });

  it("rejects unparseable input without retaining credentials or tokens", () => {
    const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect((error as PreviewUrlNormalizationError).cause).toBeInstanceOf(Error);
      expect((error as PreviewUrlNormalizationError).message).not.toContain(
        ((error as PreviewUrlNormalizationError).cause as Error).message,
      );
      expect((error as PreviewUrlNormalizationError).message).not.toMatch(
        /user|password|access_token|secret|fragment/,
      );
    }
  });
});

describe("previewUrlWithoutCredentials", () => {
  it("strips userinfo while preserving a loopback port, path, query, and hash", () => {
    expect(
      previewUrlWithoutCredentials("http://user:secret@localhost:3773/__preview/path?tab=1#/route"),
    ).toBe("http://localhost:3773/__preview/path?tab=1#/route");
  });

  it("does not return an unparseable URL that could contain credentials", () => {
    expect(previewUrlWithoutCredentials("http://user:secret@localhost:bad/path")).toBe("");
  });
});
