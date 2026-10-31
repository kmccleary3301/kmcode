import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { TextPreviewRequest, TextPreviewResult } from "./largeTextProtocol";

describe("large text worker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches an unknown-size signed source and indexes its lines", async () => {
    const results: TextPreviewResult[] = [];
    const handlers: {
      receive: ((event: MessageEvent<TextPreviewRequest>) => void) | null;
      finish: (() => void) | null;
    } = { receive: null, finish: null };
    let requestedRange: string | null = null;
    let hasCompleteMeta = false;
    let hasCompletePage = false;
    const indexed = new Promise<void>((resolve) => {
      handlers.finish = () => resolve();
    });
    vi.stubGlobal("self", {
      addEventListener: (
        _type: "message",
        listener: (event: MessageEvent<TextPreviewRequest>) => void,
      ) => {
        handlers.receive = listener;
      },
      postMessage: (value: TextPreviewResult) => {
        results.push(value);
        if (value.type === "meta" && value.complete) hasCompleteMeta = true;
        if (value.type === "page" && value.index === 0 && value.rows.length === 2)
          hasCompletePage = true;
        if (hasCompleteMeta && hasCompletePage) handlers.finish?.();
      },
    });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedRange = new Headers(init?.headers).get("Range");
      const text = "line one\nline two";
      const length = new TextEncoder().encode(text).byteLength;
      return new Response(text, {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-${length - 1}/${length}`,
          "Content-Length": String(length),
        },
      });
    });

    // The worker registers its message listener at module evaluation, so stub self before importing it.
    await import("./largeText.worker");
    handlers.receive?.(
      new MessageEvent<TextPreviewRequest>("message", {
        data: {
          type: "open",
          src: "https://assets.example/signed-token",
          sizeBytes: 0,
          delimiter: null,
        },
      }),
    );
    await indexed;

    expect(requestedRange).toBe("bytes=0-268435456");
    expect(results).toContainEqual({
      type: "meta",
      count: 2,
      columns: 1,
      complete: true,
      sizeBytes: 17,
    });
    expect(results).toContainEqual({
      type: "page",
      index: 0,
      rows: [["line one"], ["line two"]],
    });
  });
});
