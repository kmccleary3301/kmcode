import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundConfiguredLocalServerUrls,
  isDiscoveredLocalServerOwnedByThread,
} from "./portDiscoveryState";

const threadId = ThreadId.make("thread-1");
const discoveredServer = {
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  processName: "node",
  pid: 42,
  terminal: null,
} satisfies DiscoveredLocalServer;

describe("boundConfiguredLocalServerUrls", () => {
  it("keeps subscription payloads within the discovery RPC bounds", () => {
    const urls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
      (_, index) => `http://localhost:${3_000 + index}`,
    );
    urls.unshift(
      "https://example.com",
      "not a URL",
      `http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`,
    );

    const bounded = boundConfiguredLocalServerUrls(urls);

    expect(bounded).toHaveLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS);
    expect(bounded.every((url) => url.startsWith("http://localhost:"))).toBe(true);
  });

  it("does not let fragment-only variants crowd out another server", () => {
    const fragments = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:3000/docs#section-${index}`,
    );

    expect(boundConfiguredLocalServerUrls([...fragments, "http://localhost:4000/app"])).toEqual([
      "http://localhost:3000/docs#section-0",
      "http://localhost:4000/app",
    ]);
  });
});

describe("discovered server ownership", () => {
  it("matches terminal owners", () => {
    expect(
      isDiscoveredLocalServerOwnedByThread(
        {
          ...discoveredServer,
          terminal: { threadId, terminalId: "terminal-1" },
        },
        threadId,
      ),
    ).toBe(true);
  });

  it("matches agent owners", () => {
    expect(
      isDiscoveredLocalServerOwnedByThread({ ...discoveredServer, agent: { threadId } }, threadId),
    ).toBe(true);
  });

  it("rejects servers owned by another thread or no thread", () => {
    expect(
      isDiscoveredLocalServerOwnedByThread(
        { ...discoveredServer, agent: { threadId: ThreadId.make("thread-2") } },
        threadId,
      ),
    ).toBe(false);
    expect(isDiscoveredLocalServerOwnedByThread(discoveredServer, threadId)).toBe(false);
  });
});
