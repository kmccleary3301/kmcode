/**
 * The server bridges at most this many Aperture requests per thread at once
 * (`MAX_CONCURRENT_STREAMS_PER_THREAD` in `ApertureEmbedBridge.ts`) and refuses
 * the next with `too_many_streams`. Frames queue here instead, so a thread that
 * opens with many figures loads them in turn rather than failing some.
 */
export const APERTURE_REQUESTS_PER_THREAD = 4;

/**
 * Live frames that may stream at once in a thread. A live stream holds its
 * request slot for as long as it runs, so the rest stay free for pinned loads.
 */
export const APERTURE_LIVE_FRAMES_PER_THREAD = 2;

interface ThreadSlots {
  active: number;
  readonly waiting: Array<() => void>;
}

interface LiveFrame {
  /** Order the frame last became visible and live in; the oldest pauses first. */
  activatedAt: number;
  candidate: boolean;
  streaming: boolean;
  readonly onStreamingChange: (streaming: boolean) => void;
}

const slotsByThread = new Map<string, ThreadSlots>();
const liveFramesByThread = new Map<string, Map<string, LiveFrame>>();
let activations = 0;

/**
 * Waits for one of the thread's request slots. Resolves with the release, or
 * with `null` when `signal` aborts first; a queued request never takes a slot
 * after its frame gave up on it.
 */
export function acquireApertureRequestSlot(
  threadKey: string,
  signal: AbortSignal,
): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  let slots = slotsByThread.get(threadKey);
  if (slots === undefined) {
    slots = { active: 0, waiting: [] };
    slotsByThread.set(threadKey, slots);
  }
  const thread = slots;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    thread.active -= 1;
    const next = thread.waiting.shift();
    if (next !== undefined) next();
    else if (thread.active === 0) slotsByThread.delete(threadKey);
  };
  if (thread.active < APERTURE_REQUESTS_PER_THREAD) {
    thread.active += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    const start = () => {
      signal.removeEventListener("abort", abandon);
      thread.active += 1;
      resolve(release);
    };
    const abandon = () => {
      const index = thread.waiting.indexOf(start);
      if (index !== -1) thread.waiting.splice(index, 1);
      resolve(null);
    };
    thread.waiting.push(start);
    signal.addEventListener("abort", abandon, { once: true });
  });
}

function rebalanceLiveFrames(threadKey: string): void {
  const frames = liveFramesByThread.get(threadKey);
  if (frames === undefined) return;
  const streaming = new Set(
    [...frames.values()]
      .filter((frame) => frame.candidate)
      .toSorted((a, b) => b.activatedAt - a.activatedAt)
      .slice(0, APERTURE_LIVE_FRAMES_PER_THREAD),
  );
  for (const frame of frames.values()) {
    const next = streaming.has(frame);
    if (frame.streaming === next) continue;
    frame.streaming = next;
    frame.onStreamingChange(next);
  }
}

/**
 * Tracks one frame against the thread's live cap. A frame is a candidate while
 * it is live and on screen; the newest candidates stream and older ones are
 * told to pause, so the cap never closes the stream the reader just opened.
 */
export function registerApertureLiveFrame(
  threadKey: string,
  frameId: string,
  onStreamingChange: (streaming: boolean) => void,
): {
  readonly update: (state: { readonly live: boolean; readonly visible: boolean }) => void;
  readonly dispose: () => void;
} {
  let frames = liveFramesByThread.get(threadKey);
  if (frames === undefined) {
    frames = new Map();
    liveFramesByThread.set(threadKey, frames);
  }
  const frame: LiveFrame = {
    activatedAt: 0,
    candidate: false,
    streaming: false,
    onStreamingChange,
  };
  frames.set(frameId, frame);
  const thread = frames;
  return {
    update: ({ live, visible }) => {
      const candidate = live && visible;
      if (candidate === frame.candidate) return;
      frame.candidate = candidate;
      if (candidate) frame.activatedAt = ++activations;
      rebalanceLiveFrames(threadKey);
    },
    dispose: () => {
      if (thread.get(frameId) !== frame) return;
      thread.delete(frameId);
      if (thread.size === 0) liveFramesByThread.delete(threadKey);
      else rebalanceLiveFrames(threadKey);
    },
  };
}
