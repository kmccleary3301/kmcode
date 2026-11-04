import { describe, expect, it } from "vite-plus/test";
import type { ApertureFetchStreamEvent } from "@t3tools/contracts";
import {
  APERTURE_EMBED_PROTOCOL,
  type ApertureEmbedErrorMessage,
  type ApertureEmbedHostMessage,
  type ApertureEmbedMode,
  type ApertureEmbedTheme,
} from "@t3tools/shared/apertureEmbed";

import {
  makeApertureEmbedHost,
  type ApertureEmbedHost,
  type ApertureEmbedHostFetchRequest,
  type ApertureEmbedHostFetchResult,
  type ApertureEmbedHostOptions,
} from "./host.ts";

const THEME: ApertureEmbedTheme = {
  appearance: "light",
  vizTheme: "default",
  tokens: { foreground: "#111" },
};
const DARK_THEME: ApertureEmbedTheme = {
  appearance: "dark",
  vizTheme: "night",
  tokens: { foreground: "#eee" },
};
const LIVE_MODE: ApertureEmbedMode = { kind: "live" };
const PINNED_MODE: ApertureEmbedMode = { kind: "pinned", asOf: "2026-01-02T03:04:05Z" };

interface PendingFetch {
  readonly request: ApertureEmbedHostFetchRequest;
  readonly onEvent: (event: ApertureFetchStreamEvent) => void;
  readonly signal: AbortSignal;
  readonly resolve: (result: ApertureEmbedHostFetchResult) => void;
  readonly reject: (reason: unknown) => void;
}

interface CapturedPost {
  readonly message: ApertureEmbedHostMessage;
  readonly transfer: Transferable[];
}
type CapturedEmbedError = Pick<ApertureEmbedErrorMessage, "code" | "detail" | "message">;

interface ApertureHostHarness {
  readonly host: ApertureEmbedHost;
  readonly posts: CapturedPost[];
  readonly fetches: PendingFetch[];
  readonly readyVersions: string[];
  readonly mismatchedProtocols: unknown[];
  readonly sizes: number[];
  readonly errors: CapturedEmbedError[];
  readonly links: string[];
  readonly openCounts: number[];
  readonly timeline: string[];
}

function makeHarness(input?: {
  readonly content?: ApertureEmbedHostOptions["content"];
  readonly mode?: ApertureEmbedMode;
  readonly visible?: boolean;
}): ApertureHostHarness {
  const posts: CapturedPost[] = [];
  const fetches: PendingFetch[] = [];
  const readyVersions: string[] = [];
  const mismatchedProtocols: unknown[] = [];
  const sizes: number[] = [];
  const errors: CapturedEmbedError[] = [];
  const links: string[] = [];
  const openCounts: number[] = [];
  const timeline: string[] = [];
  const host = makeApertureEmbedHost({
    post: (message, transfer) => {
      posts.push({ message, transfer: transfer ?? [] });
      timeline.push(`post:${message.type}`);
    },
    content: input?.content ?? {
      kind: "figure",
      spec: { mark: "bar" },
      entity: "entity-1",
      project: "project-1",
    },
    size: { width: 640, maxHeight: 320 },
    theme: THEME,
    mode: input?.mode ?? LIVE_MODE,
    visible: input?.visible ?? true,
    fetch: (request, onEvent, signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<ApertureEmbedHostFetchResult>();
      fetches.push({ request, onEvent, signal, resolve, reject });
      return promise;
    },
    onReady: (runtimeVersion) => {
      readyVersions.push(runtimeVersion);
      timeline.push(`ready:${runtimeVersion}`);
    },
    onProtocolMismatch: (protocol) => mismatchedProtocols.push(protocol),
    onSize: (height) => sizes.push(height),
    onError: (error) => errors.push(error),
    onOpenLink: (href) => links.push(href),
    onOpenRequestsChange: (open) => openCounts.push(open),
  });
  return {
    host,
    posts,
    fetches,
    readyVersions,
    mismatchedProtocols,
    sizes,
    errors,
    links,
    openCounts,
    timeline,
  };
}

function ready(host: ApertureEmbedHost, runtimeVersion = "1.2.3") {
  host.receive({
    v: APERTURE_EMBED_PROTOCOL,
    type: "embed/ready",
    protocol: APERTURE_EMBED_PROTOCOL,
    runtimeVersion,
  });
}

function requestAt(fetches: ReadonlyArray<PendingFetch>, index: number): PendingFetch {
  const request = fetches[index];
  if (request === undefined) throw new Error(`Missing fetch request ${index}.`);
  return request;
}

describe("Aperture embed host", () => {
  it("waits for ready and initializes once with the latest settings", () => {
    const harness = makeHarness({
      content: {
        kind: "widget",
        widget: { id: "chart", version: "2", code: "export default 1" },
        entity: "entity-1",
        project: "project-1",
      },
    });
    harness.host.setTheme(DARK_THEME);
    harness.host.setMode(PINNED_MODE);
    harness.host.setWidth(900);
    harness.host.setVisible(false);
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/unknown" });
    expect(harness.posts).toEqual([]);

    ready(harness.host, "runtime-9");
    expect(harness.readyVersions).toEqual(["runtime-9"]);
    expect(harness.timeline.slice(0, 3)).toEqual([
      "ready:runtime-9",
      "post:embed/init",
      "post:embed/visibility",
    ]);
    expect(harness.posts.map(({ message }) => message)).toEqual([
      {
        v: APERTURE_EMBED_PROTOCOL,
        type: "embed/init",
        kind: "widget",
        widget: { id: "chart", version: "2", code: "export default 1" },
        entity: "entity-1",
        project: "project-1",
        theme: DARK_THEME,
        mode: PINNED_MODE,
        size: { width: 900, maxHeight: 320 },
      },
      { v: APERTURE_EMBED_PROTOCOL, type: "embed/visibility", visible: false },
    ]);

    ready(harness.host, "runtime-10");
    harness.host.setTheme(THEME);
    harness.host.setVisible(false);
    harness.host.setVisible(true);
    harness.host.setMode(LIVE_MODE);
    expect(harness.timeline.slice(3)).toEqual([
      "post:embed/theme",
      "post:embed/visibility",
      "post:embed/mode",
    ]);
    expect(harness.readyVersions).toEqual(["runtime-9"]);
    expect(harness.posts.slice(2).map(({ message }) => message.type)).toEqual([
      "embed/theme",
      "embed/visibility",
      "embed/mode",
    ]);
    expect(harness.posts.every(({ message }) => message.v === APERTURE_EMBED_PROTOCOL)).toBe(true);
  });

  it("includes a defined figure spec and omits an undefined widget", () => {
    const harness = makeHarness();
    ready(harness.host);
    const init = harness.posts[0]?.message;
    expect(init?.type).toBe("embed/init");
    if (init?.type === "embed/init") {
      expect(init.spec).toEqual({ mark: "bar" });
      expect("widget" in init).toBe(false);
    }
  });

  it("reports a protocol mismatch once and ignores the rest of the frame", () => {
    const harness = makeHarness();
    harness.host.receive({ type: "embed/ready", protocol: 7, v: 7 });
    ready(harness.host);
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/size", height: 200 });
    expect(harness.mismatchedProtocols).toEqual([7]);
    expect(harness.readyVersions).toEqual([]);
    expect(harness.sizes).toEqual([]);
    expect(harness.posts).toEqual([]);
  });

  it("relays fetch events in order with an exact transferable chunk copy", async () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch",
      id: "request-1",
      method: "POST",
      path: "/api/run",
      body: "{}",
      accept: "text/event-stream",
    });
    const fetch = requestAt(harness.fetches, 0);
    expect(fetch.request).toEqual({
      method: "POST",
      path: "/api/run",
      body: "{}",
      accept: "text/event-stream",
      mode: "live",
    });
    const source = new Uint8Array([90, 4, 5, 91]);
    fetch.onEvent({
      type: "head",
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/event-stream"]],
    });
    fetch.onEvent({ type: "chunk", data: source.subarray(1, 3) });
    fetch.onEvent({ type: "end" });

    expect(harness.posts.map(({ message }) => message.type)).toEqual([
      "embed/fetch-head",
      "embed/fetch-chunk",
      "embed/fetch-end",
    ]);
    expect(harness.posts.every(({ message }) => message.v === APERTURE_EMBED_PROTOCOL)).toBe(true);
    const chunk = harness.posts[1]?.message;
    expect(chunk?.type).toBe("embed/fetch-chunk");
    if (chunk?.type === "embed/fetch-chunk") {
      expect([...new Uint8Array(chunk.bytes)]).toEqual([4, 5]);
      expect(chunk.bytes).not.toBe(source.buffer);
      expect(harness.posts[1]?.transfer[0]).toBe(chunk.bytes);
    }
    expect(harness.openCounts).toEqual([1, 0]);
    fetch.resolve({ _tag: "end" });
    await Promise.resolve();
  });

  it("aborts a fetch on frame cancellation and posts no later stream result", async () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch",
      id: "cancel-me",
      method: "GET",
      path: "/api/run",
      body: null,
      accept: null,
    });
    const fetch = requestAt(harness.fetches, 0);
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch-abort",
      id: "cancel-me",
    });
    expect(fetch.signal.aborted).toBe(true);
    fetch.onEvent({ type: "end" });
    fetch.resolve({ _tag: "end" });
    await Promise.resolve();
    expect(harness.posts).toEqual([]);
    expect(harness.openCounts).toEqual([1, 0]);
  });

  it("sends a fetch error returned by the bridged request", async () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch",
      id: "denied",
      method: "GET",
      path: "/api/run",
      body: null,
      accept: null,
    });
    requestAt(harness.fetches, 0).resolve({
      _tag: "error",
      code: "forbidden",
      message: "Not permitted.",
    });
    await Promise.resolve();
    expect(harness.posts.map(({ message }) => message)).toEqual([
      {
        v: APERTURE_EMBED_PROTOCOL,
        type: "embed/fetch-error",
        id: "denied",
        code: "forbidden",
        message: "Not permitted.",
      },
    ]);
  });

  it("ends the frame's response once when the stream completes without an end event", async () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    for (const id of ["silent", "explicit"]) {
      harness.host.receive({
        v: APERTURE_EMBED_PROTOCOL,
        type: "embed/fetch",
        id,
        method: "GET",
        path: "/api/run",
        body: null,
        accept: null,
      });
    }
    requestAt(harness.fetches, 0).resolve({ _tag: "end" });
    requestAt(harness.fetches, 1).onEvent({ type: "end" });
    requestAt(harness.fetches, 1).resolve({ _tag: "end" });
    await Promise.resolve();
    expect(harness.posts.map(({ message }) => message)).toEqual([
      { v: APERTURE_EMBED_PROTOCOL, type: "embed/fetch-end", id: "explicit" },
      { v: APERTURE_EMBED_PROTOCOL, type: "embed/fetch-end", id: "silent" },
    ]);
  });

  it("maps a rejected bridged request to unreachable", async () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch",
      id: "offline",
      method: "GET",
      path: "/api/run",
      body: null,
      accept: null,
    });
    requestAt(harness.fetches, 0).reject(new Error("connection closed"));
    await Promise.resolve();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]?.message).toMatchObject({
      type: "embed/fetch-error",
      id: "offline",
      code: "unreachable",
    });
  });

  it("aborts live requests on pinning but keeps pinned requests open", () => {
    const harness = makeHarness({ mode: PINNED_MODE });
    ready(harness.host);
    harness.posts.length = 0;
    const fetchMessage = (id: string) => ({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch",
      id,
      method: "GET",
      path: "/api/run",
      body: null,
      accept: null,
    });
    harness.host.receive(fetchMessage("pinned"));
    harness.host.setMode(LIVE_MODE);
    harness.host.receive(fetchMessage("live"));
    harness.host.setMode(PINNED_MODE);

    const pinned = requestAt(harness.fetches, 0);
    const live = requestAt(harness.fetches, 1);
    expect(pinned.request.mode).toBe("pinned");
    expect(pinned.signal.aborted).toBe(false);
    expect(live.request.mode).toBe("live");
    expect(live.signal.aborted).toBe(true);
    expect(harness.posts.map(({ message }) => message.type)).toEqual([
      "embed/mode",
      "embed/mode",
      "embed/fetch-error",
    ]);
    expect(harness.posts[2]?.message).toMatchObject({
      type: "embed/fetch-error",
      id: "live",
      code: "aborted",
    });
    pinned.onEvent({ type: "head", status: 200, statusText: "OK", headers: [] });
    expect(harness.posts[3]?.message).toMatchObject({ type: "embed/fetch-head", id: "pinned" });
  });

  it("disposes by aborting requests, reporting zero, and silencing later work", async () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    for (const id of ["first", "second"]) {
      harness.host.receive({
        v: APERTURE_EMBED_PROTOCOL,
        type: "embed/fetch",
        id,
        method: "GET",
        path: "/api/run",
        body: null,
        accept: null,
      });
    }
    harness.host.dispose();
    expect(requestAt(harness.fetches, 0).signal.aborted).toBe(true);
    expect(requestAt(harness.fetches, 1).signal.aborted).toBe(true);
    expect(harness.openCounts).toEqual([1, 2, 0]);
    requestAt(harness.fetches, 0).onEvent({ type: "end" });
    requestAt(harness.fetches, 0).resolve({ _tag: "end" });
    harness.host.setTheme(DARK_THEME);
    harness.host.setMode(PINNED_MODE);
    harness.host.setVisible(false);
    harness.host.setWidth(100);
    ready(harness.host);
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/size", height: 200 });
    await Promise.resolve();
    expect(harness.posts).toEqual([]);
    expect(harness.readyVersions).toEqual(["1.2.3"]);
    expect(harness.sizes).toEqual([]);
  });

  it("clamps finite heights and forwards frame errors and link requests", () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/size", height: Number.NaN });
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/size",
      height: Number.POSITIVE_INFINITY,
    });
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/size", height: -3 });
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/size", height: 99.6 });
    harness.host.receive({ v: APERTURE_EMBED_PROTOCOL, type: "embed/size", height: 1000 });
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/error",
      code: "widget_runtime",
      message: "Failed to draw.",
      detail: "runtime stack",
    });
    harness.host.receive({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/open-link",
      href: "https://example.test",
    });
    expect(harness.sizes).toEqual([80, 100, 320]);
    expect(harness.errors).toEqual([
      { code: "widget_runtime", message: "Failed to draw.", detail: "runtime stack" },
    ]);
    expect(harness.links).toEqual(["https://example.test"]);
  });

  it("rejects a duplicate in-flight id without disturbing its original request", () => {
    const harness = makeHarness();
    ready(harness.host);
    harness.posts.length = 0;
    const fetchMessage = {
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/fetch",
      id: "same-id",
      method: "GET",
      path: "/api/run",
      body: null,
      accept: null,
    };
    harness.host.receive(fetchMessage);
    const original = requestAt(harness.fetches, 0);
    harness.host.receive(fetchMessage);
    expect(harness.fetches).toHaveLength(1);
    expect(original.signal.aborted).toBe(false);
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]?.message).toMatchObject({
      type: "embed/fetch-error",
      id: "same-id",
      code: "bad_response",
    });
    original.onEvent({ type: "end" });
    expect(harness.posts[1]?.message).toMatchObject({ type: "embed/fetch-end", id: "same-id" });
  });
});
