import { describe, expect, it } from "vite-plus/test";

import {
  APERTURE_REQUESTS_PER_THREAD,
  acquireApertureRequestSlot,
  registerApertureLiveFrame,
} from "./apertureEmbedSlots";

describe("Aperture request slots", () => {
  it("queues requests past the server's per-thread cap and starts them as slots free", async () => {
    const thread = "env:thread-queue";
    const held = await Promise.all(
      Array.from({ length: APERTURE_REQUESTS_PER_THREAD }, () =>
        acquireApertureRequestSlot(thread, new AbortController().signal),
      ),
    );
    let started = false;
    const queued = acquireApertureRequestSlot(thread, new AbortController().signal).then(
      (release) => {
        started = true;
        return release;
      },
    );
    await Promise.resolve();
    expect(started).toBe(false);
    // Another thread has its own slots.
    expect(await acquireApertureRequestSlot("env:other", new AbortController().signal)).not.toBe(
      null,
    );

    held[0]?.();
    held[0]?.(); // A double release must not free a second slot.
    const release = await queued;
    expect(started).toBe(true);
    let fifthStarted = false;
    void acquireApertureRequestSlot(thread, new AbortController().signal).then(() => {
      fifthStarted = true;
    });
    await Promise.resolve();
    expect(fifthStarted).toBe(false);
    release?.();
    await Promise.resolve();
    expect(fifthStarted).toBe(true);
  });

  it("drops a queued request whose frame aborted, without taking a slot", async () => {
    const thread = "env:thread-abort";
    const held = await Promise.all(
      Array.from({ length: APERTURE_REQUESTS_PER_THREAD }, () =>
        acquireApertureRequestSlot(thread, new AbortController().signal),
      ),
    );
    const abort = new AbortController();
    const abandoned = acquireApertureRequestSlot(thread, abort.signal);
    const next = acquireApertureRequestSlot(thread, new AbortController().signal);
    abort.abort();
    expect(await abandoned).toBe(null);
    held[0]?.();
    expect(await next).not.toBe(null);
  });
});

describe("Aperture live cap", () => {
  const frames = (thread: string, ids: ReadonlyArray<string>) => {
    const streaming = new Map<string, boolean>();
    const handles = new Map(
      ids.map((id) => [
        id,
        registerApertureLiveFrame(thread, id, (next) => streaming.set(id, next)),
      ]),
    );
    return { streaming, handles };
  };

  it("streams the two most recently opened visible live frames and pauses the oldest", () => {
    const { streaming, handles } = frames("env:live-cap", ["a", "b", "c"]);
    handles.get("a")?.update({ live: true, visible: true });
    handles.get("b")?.update({ live: true, visible: true });
    expect(streaming).toEqual(
      new Map([
        ["a", true],
        ["b", true],
      ]),
    );
    handles.get("c")?.update({ live: true, visible: true });
    expect(streaming.get("a")).toBe(false);
    expect(streaming.get("c")).toBe(true);

    // Scrolling the newest away frees its stream for the paused one.
    handles.get("c")?.update({ live: true, visible: false });
    expect(streaming.get("c")).toBe(false);
    expect(streaming.get("a")).toBe(true);

    // A pinned frame never counts, and a removed frame frees its stream.
    handles.get("c")?.update({ live: false, visible: true });
    handles.get("b")?.dispose();
    handles.get("c")?.update({ live: true, visible: true });
    expect(streaming.get("a")).toBe(true);
    expect(streaming.get("c")).toBe(true);
  });
});
