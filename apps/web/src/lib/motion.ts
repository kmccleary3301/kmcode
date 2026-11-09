import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * One length for transcript motion: opening, closing, glides, swaps, rolls.
 * Mirrors `--motion-duration` in index.css for motion that JS drives.
 */
export const MOTION_MS = 250;

// Critically damped: no overshoot, ~99% settled at MOTION_MS (e^-6.5 * 7.5).
const SPRING_OMEGA = 6.5 / (MOTION_MS / 1000);
const SETTLE_DISTANCE_PX = 0.5;
const SETTLE_VELOCITY_PX_S = 20;
const MAX_FRAME_S = 0.064;

export interface SpringChase {
  readonly running: boolean;
  readonly value: number;
  /** Chase `target`; an idle chase starts from `from`, already moving. */
  readonly to: (from: number, target: number) => void;
  /** Move a running chase's position and target together, keeping its velocity. */
  readonly shift: (by: number) => void;
  readonly stop: () => void;
}

/**
 * A spring that follows a moving target one frame at a time. Retargeting keeps
 * the current velocity, so a stream of small changes (streamed lines, growing
 * output) reads as one continuous roll instead of a curve restarting per chunk.
 * An idle start launches at ω·distance, which makes the critically damped
 * curve a pure exponential: an ease-out that moves on the first frame, where a
 * spring released from rest would linger like ease-in.
 */
export function createSpringChase(
  write: (value: number) => void,
  onSettle: () => void,
): SpringChase {
  let value = 0;
  let velocity = 0;
  let target = 0;
  let last = 0;
  let frame: number | null = null;
  const step = (now: number) => {
    const dt = Math.min(MAX_FRAME_S, Math.max(0, (now - last) / 1000));
    last = now;
    const offset = value - target;
    const decay = Math.exp(-SPRING_OMEGA * dt);
    const pull = velocity + SPRING_OMEGA * offset;
    const nextOffset = (offset + pull * dt) * decay;
    velocity = (velocity - SPRING_OMEGA * pull * dt) * decay;
    value = target + nextOffset;
    if (Math.abs(nextOffset) < SETTLE_DISTANCE_PX && Math.abs(velocity) < SETTLE_VELOCITY_PX_S) {
      value = target;
      velocity = 0;
      frame = null;
      write(value);
      onSettle();
      return;
    }
    write(value);
    frame = requestAnimationFrame(step);
  };
  return {
    get running() {
      return frame !== null;
    },
    get value() {
      return value;
    },
    to(from, nextTarget) {
      target = nextTarget;
      if (frame !== null) return;
      value = from;
      velocity = SPRING_OMEGA * (nextTarget - from);
      last = performance.now();
      frame = requestAnimationFrame(step);
    },
    shift(by) {
      value += by;
      target += by;
    },
    stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      velocity = 0;
    },
  };
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Glide an element's height when its content grows or shrinks, instead of
 * letting rows teleport. Attach `outerRef` to a clipping box and `contentRef`
 * to the content inside it; they are callback refs, so content that mounts
 * later (a panel opened after first render) still attaches.
 *
 * - The glide is a spring chase, so streamed growth rolls continuously.
 * - The target respects the box's padding and max-height: a capped box stops
 *   growing and its scroller takes over (see `useBottomStick`).
 * - While growing, the box carries `data-glide="grow"`, which fades its bottom
 *   edge so new lines come up through the fade.
 * - The box rests pinned at its settled height while gliding is allowed, so
 *   a content change never resizes it before the observer runs: the glide
 *   starts from the held height and only moves in animation frames. Resizing
 *   the box from inside a ResizeObserver callback would resize the list row
 *   after the list measured it (an RO loop error and a frame of rows painted
 *   over a gap).
 * - One animator per ancestor chain. A glide unpins resting ancestors, which
 *   then follow its live layout instead of chasing it, so nested glides never
 *   compound into a lagging double ease. A box already mid-glide keeps
 *   retargeting instead, so it never snaps.
 * - A box rendered with `data-arriving` (collapsed by CSS) glides open from 0
 *   on mount; `collapsed` glides it to 0 for an exit, and back if un-collapsed.
 * `disabled` covers closed panels, keyboard toggles, and offscreen rows; a
 * disabled box rests unpinned and takes changes at once.
 */
export function useSmoothHeight<Outer extends HTMLElement, Content extends HTMLElement>(
  disabled: boolean,
  { collapsed = false }: { collapsed?: boolean } = {},
) {
  // Ref objects, not state setters: a setter ref schedules a synchronous re-render
  // from the commit phase on every mount, and a virtualized list mounting rows in
  // successive layout passes chains those into React's nested-update limit (#185).
  const outerRef = useRef<Outer | null>(null);
  const contentRef = useRef<Content | null>(null);
  const attachedRef = useRef<{
    readonly outer: Outer;
    readonly content: Content;
    readonly detach: () => void;
  } | null>(null);
  const disabledRef = useRef(disabled);
  const collapsedRef = useRef(collapsed);
  const glideRef = useRef<(() => void) | null>(null);
  const restRef = useRef<(() => void) | null>(null);
  // Layout effect: the resize that a render causes is observed before paint,
  // and must already see that render's gate. Enabling pins the box at the
  // height it showed before this render, so the change glides from there.
  useLayoutEffect(() => {
    disabledRef.current = disabled;
    restRef.current?.();
  });

  // Runs after every commit and reattaches only when either element changed.
  useEffect(() => {
    const outer = outerRef.current;
    const content = contentRef.current;
    const attached = attachedRef.current;
    if (attached !== null && attached.outer === outer && attached.content === content) return;
    attached?.detach();
    attachedRef.current = null;
    if (outer === null || content === null || typeof ResizeObserver === "undefined") {
      outer?.removeAttribute("data-arriving");
      return;
    }
    const style = getComputedStyle(outer);
    const chrome =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    // The observer passes the content's exact border-box height; elsewhere
    // offsetHeight (rounded) stands in, outside any observer callback.
    const naturalHeight = (contentHeight = content.offsetHeight) => {
      if (collapsedRef.current) return 0;
      const max = parseFloat(getComputedStyle(outer).maxHeight);
      const height = contentHeight + chrome;
      return Number.isFinite(max) ? Math.min(height, max) : height;
    };
    const still = () => disabledRef.current || document.hidden || prefersReducedMotion();
    const followingDescendant = () =>
      content.querySelector('[data-glide="grow"], [data-glide="shrink"]') !== null;
    let settleTimer: number | undefined;
    let settledHeight = naturalHeight();
    const release = () => {
      window.clearTimeout(settleTimer);
      outer.style.height = "";
      delete outer.dataset.glide;
    };
    // Resting: pinned at the settled height when gliding is allowed, unpinned
    // (following layout) when still or while a descendant glides.
    const rest = () => {
      if (chase.running || collapsedRef.current) return;
      outer.style.height = still() || followingDescendant() ? "" : `${settledHeight}px`;
    };
    // Landed: the edge fade eases out so the last line settles to full
    // contrast instead of popping. A collapsed box holds 0 until its owner
    // unmounts it.
    const settle = () => {
      if (collapsedRef.current) return;
      rest();
      outer.dataset.glide = "settle";
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        delete outer.dataset.glide;
      }, MOTION_MS);
    };
    const chase = createSpringChase((height) => {
      outer.style.height = `${height}px`;
    }, settle);
    const glideTo = (fromHeight: number, nextHeight: number) => {
      window.clearTimeout(settleTimer);
      // Resting ancestors stop holding and follow this glide live. They hold
      // the same height they show, so unpinning them resizes nothing.
      for (
        let ancestor = outer.parentElement?.closest<HTMLElement>("[data-smooth-height]");
        ancestor;
        ancestor = ancestor.parentElement?.closest<HTMLElement>("[data-smooth-height]")
      ) {
        if (ancestor.dataset.glide !== "grow" && ancestor.dataset.glide !== "shrink") {
          ancestor.style.height = "";
        }
      }
      outer.dataset.glide = nextHeight > fromHeight ? "grow" : "shrink";
      outer.style.height = `${fromHeight}px`;
      chase.to(fromHeight, nextHeight);
    };
    outer.dataset.smoothHeight = "";
    if (outer.hasAttribute("data-arriving")) {
      outer.removeAttribute("data-arriving");
      if (!still()) glideTo(0, settledHeight);
    }
    rest();

    // Runs inside the ResizeObserver callback, so it must not change the box's
    // size: a held box glides from the height it already shows, and an
    // unpinned box already shows the change, so it adopts it and rests there.
    const glide = (entries?: readonly ResizeObserverEntry[]) => {
      const nextHeight = naturalHeight(entries?.at(-1)?.borderBoxSize[0]?.blockSize);
      if (Math.abs(nextHeight - settledHeight) < 1) return;
      const fromHeight = chase.running ? chase.value : settledHeight;
      settledHeight = nextHeight;
      // Collapsing comes from a layout effect, not the observer, so an
      // unpinned box may still glide to 0.
      const holding = chase.running || outer.style.height !== "" || collapsedRef.current;
      const followDescendant = !collapsedRef.current && !chase.running && followingDescendant();
      if (!holding || followDescendant || still()) {
        chase.stop();
        release();
        rest();
        return;
      }
      glideTo(fromHeight, nextHeight);
    };
    glideRef.current = glide;
    restRef.current = rest;
    const observer = new ResizeObserver(glide);
    observer.observe(content);
    attachedRef.current = {
      outer,
      content,
      detach: () => {
        glideRef.current = null;
        restRef.current = null;
        observer.disconnect();
        chase.stop();
        release();
        delete outer.dataset.smoothHeight;
      },
    };
  });
  useEffect(
    () => () => {
      attachedRef.current?.detach();
      attachedRef.current = null;
    },
    [],
  );

  // Collapsing changes the target, not the content, so no resize reports it.
  useLayoutEffect(() => {
    collapsedRef.current = collapsed;
    glideRef.current?.();
  }, [collapsed]);

  return { outerRef, contentRef };
}

/**
 * True once `value` has differed from what it was at mount. Status glyphs key
 * on their status and take a swap animation only when this is true, so history
 * and virtualized remounts render still while live transitions read clearly.
 */
export function useChangedSinceMount<T>(value: T): boolean {
  const [seen, setSeen] = useState({ value, changed: false });
  if (!Object.is(seen.value, value)) {
    setSeen({ value, changed: true });
    return true;
  }
  return seen.changed;
}

/**
 * Keeps an element mounted through its exit. `shown` turns on a frame after
 * mount, so the entrance transitions from the closed state, and turns off
 * immediately on close; `mounted` drops MOTION_MS after the first frame that
 * paints the exit, so a busy commit (a turn folding away) cannot use up the
 * exit before it shows. Something open at first render shows at once: history
 * never animates in.
 */
export function usePresence(open: boolean): { readonly mounted: boolean; readonly shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!open && shown) setShown(false);
  useEffect(() => {
    if (open && !shown) {
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    if (!open && mounted) {
      let timer: number | undefined;
      const frame = requestAnimationFrame(() => {
        timer = window.setTimeout(() => setMounted(false), MOTION_MS);
      });
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
      };
    }
    return undefined;
  }, [open, shown, mounted]);
  return { mounted, shown };
}

export interface PresentItem<T> {
  readonly item: T;
  readonly key: string;
  /** Removed from the source list; render it collapsing until it drops. */
  readonly exiting: boolean;
}

/**
 * A list whose removed entries stay in place for MOTION_MS so they can collapse
 * out instead of vanishing and yanking the rows below them upward. With
 * `animate` off, removals drop at once and pending exits clear.
 */
export function usePresentList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  animate = true,
): readonly PresentItem<T>[] {
  const [previous, setPrevious] = useState(items);
  const [exiting, setExiting] = useState<ReadonlyMap<string, { item: T; index: number }>>(
    () => new Map(),
  );
  if (previous !== items) {
    setPrevious(items);
    if (animate) {
      const live = new Set(items.map(keyOf));
      const next = new Map(exiting);
      for (const key of live) next.delete(key);
      previous.forEach((item, index) => {
        const key = keyOf(item);
        if (!live.has(key)) next.set(key, { item, index });
      });
      if (next.size > 0 || exiting.size > 0) setExiting(next);
    }
  }
  if (!animate && exiting.size > 0) setExiting(new Map());
  useEffect(() => {
    if (exiting.size === 0) return;
    const timer = window.setTimeout(() => setExiting(new Map()), MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  return useMemo(() => {
    const present: PresentItem<T>[] = items.map((item) => ({
      item,
      key: keyOf(item),
      exiting: false,
    }));
    for (const [key, { item, index }] of exiting) {
      present.splice(Math.min(index, present.length), 0, { item, key, exiting: true });
    }
    return present;
  }, [items, exiting, keyOf]);
}
