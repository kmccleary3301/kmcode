import { ArrowDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { createSpringChase, MOTION_MS, prefersReducedMotion, useSmoothHeight } from "~/lib/motion";
import { cn } from "~/lib/utils";
import { Button } from "./button";

/**
 * Stick-to-bottom for nested scrollables, ported from stream-mdx's
 * BottomStickScrollArea (packages/markdown-v2-react). A live region grows in
 * two phases: below its max-height the box itself glides taller and the text
 * stays put (useSmoothHeight); once capped, it follows its tail with a spring
 * roll. Either way new lines come up through a bottom fade, so nothing pops.
 *
 * Three modes:
 * - sticky: content growth keeps the viewport pinned to the end;
 * - detached: the reader scrolled up, growth leaves them in place;
 * - returning: an eased scroll back to the end after "Scroll to latest".
 * Reaching the end re-attaches. Unlike the original, only reader input
 * (wheel, touch, keys, scrollbar drag) detaches: virtualized lists move
 * scrollTop themselves while re-measuring rows, and a sticky viewport
 * re-pins after such moves instead of treating them as the reader leaving.
 *
 * The viewport carries `data-stick-fade` ("top", "bottom", both, or empty):
 * an edge fades while content lies beyond it or the roll is still moving.
 */
export type BottomStickMode = "sticky" | "detached" | "returning";

const BOTTOM_EPSILON_PX = 2;
const OVERFLOW_EPSILON_PX = 1;
const OWN_WRITE_WINDOW_MS = 60;
const READER_INPUT_WINDOW_MS = 400;
const RETURN_MAX_MS = 520;
const RETURN_PX_PER_MS = 2.2;
const RETURN_SETTLE_FRAMES = 2;

/**
 * Drives `viewport` (the element that scrolls) and watches `content` (its
 * growing child). `initialMode` applies once, at mount: live content starts
 * sticky; settled content opened for reading starts detached at the top.
 */
export function useBottomStick(
  viewport: HTMLElement | null,
  content: Element | null,
  initialMode: "sticky" | "detached",
) {
  const modeRef = useRef<BottomStickMode>(initialMode);
  const [mode, setMode] = useState<BottomStickMode>(initialMode);
  const [overflowing, setOverflowing] = useState(false);
  const jumpRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    if (!viewport) return;
    let lastWrite: { at: number; top: number } | null = null;
    let readerInputAt = Number.NEGATIVE_INFINITY;
    let readerDragging = false;
    let previousTop = viewport.scrollTop;
    let stickFrame: number | null = null;
    let returnFrame: number | null = null;
    let fadeState: string | null = null;
    const enter = (next: BottomStickMode) => {
      modeRef.current = next;
      setMode(next);
    };
    const measure = () => {
      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      return {
        maxTop,
        distance: Math.max(0, maxTop - viewport.scrollTop),
        overflowing: viewport.scrollHeight > viewport.clientHeight + OVERFLOW_EPSILON_PX,
      };
    };
    const write = (top: number) => {
      viewport.scrollTop = top;
      lastWrite = { at: performance.now(), top };
    };
    const updateFades = () => {
      const { distance, overflowing } = measure();
      const top = overflowing && viewport.scrollTop > 1;
      const bottom = overflowing && (roll.running || distance > 1);
      const next = top && bottom ? "top bottom" : top ? "top" : bottom ? "bottom" : "";
      if (next === fadeState) return;
      fadeState = next;
      viewport.dataset.stickFade = next;
    };
    // The follow: a spring toward the end that keeps its velocity when more
    // content lands mid-roll, so a stream reads as one continuous roll.
    const roll = createSpringChase(write, updateFades);
    // A box still gliding taller keeps its text in place; follow once it settles.
    const boxGliding = () =>
      viewport.dataset.glide === "grow" || viewport.dataset.glide === "shrink";

    // Coalesce growth bursts into one write per frame, after layout settles.
    const stick = () => {
      if (stickFrame !== null) return;
      stickFrame = requestAnimationFrame(() => {
        stickFrame = null;
        if (modeRef.current !== "sticky") return;
        if (boxGliding()) {
          stick();
          return;
        }
        const { maxTop } = measure();
        if (prefersReducedMotion() || Math.abs(maxTop - viewport.scrollTop) <= BOTTOM_EPSILON_PX) {
          roll.stop();
          write(maxTop);
        } else {
          roll.to(viewport.scrollTop, maxTop);
        }
        updateFades();
      });
    };
    const cancelFrames = () => {
      if (stickFrame !== null) cancelAnimationFrame(stickFrame);
      if (returnFrame !== null) cancelAnimationFrame(returnFrame);
      stickFrame = null;
      returnFrame = null;
      roll.stop();
    };

    const onScroll = () => {
      const metrics = measure();
      setOverflowing(metrics.overflowing);
      const delta = viewport.scrollTop - previousTop;
      previousTop = viewport.scrollTop;
      const ownWrite =
        lastWrite !== null &&
        performance.now() - lastWrite.at < OWN_WRITE_WINDOW_MS &&
        Math.abs(viewport.scrollTop - lastWrite.top) <= 2;
      const movedUp = !ownWrite && delta < -1;
      const byReader = readerDragging || performance.now() - readerInputAt < READER_INPUT_WINDOW_MS;
      if (movedUp && byReader && metrics.distance > BOTTOM_EPSILON_PX) {
        if (modeRef.current !== "detached") {
          cancelFrames();
          enter("detached");
        }
      } else if (movedUp && modeRef.current === "sticky") {
        stick();
      } else if (modeRef.current === "detached" && metrics.distance <= BOTTOM_EPSILON_PX) {
        enter("sticky");
        stick();
      }
      updateFades();
    };
    const markReaderInput = () => {
      readerInputAt = performance.now();
    };
    const startDrag = () => {
      readerDragging = true;
      markReaderInput();
    };
    const endDrag = () => {
      readerDragging = false;
    };

    jumpRef.current = () => {
      cancelFrames();
      // The jump is the reader's latest intent: only input after it may cancel the return.
      readerInputAt = Number.NEGATIVE_INFINITY;
      readerDragging = false;
      const start = measure();
      if (start.distance <= BOTTOM_EPSILON_PX || prefersReducedMotion()) {
        enter("sticky");
        write(start.maxTop);
        updateFades();
        return;
      }
      const startTop = viewport.scrollTop;
      const startedAt = performance.now();
      // Long returns scale with distance so far jumps stay legible, not a teleport.
      const duration = Math.min(
        RETURN_MAX_MS,
        Math.max(MOTION_MS, start.distance / RETURN_PX_PER_MS),
      );
      let settledFrames = 0;
      enter("returning");
      const tick = (now: number) => {
        returnFrame = null;
        if (modeRef.current !== "returning") return;
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - (1 - progress) ** 3;
        // Chase a moving end, but never pull the reader backwards.
        write(Math.max(viewport.scrollTop, startTop + (measure().maxTop - startTop) * eased));
        settledFrames = measure().distance <= BOTTOM_EPSILON_PX ? settledFrames + 1 : 0;
        if (progress >= 1 && settledFrames >= RETURN_SETTLE_FRAMES) {
          enter("sticky");
          stick();
          return;
        }
        returnFrame = requestAnimationFrame(tick);
      };
      returnFrame = requestAnimationFrame(tick);
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            setOverflowing(measure().overflowing);
            updateFades();
            if (modeRef.current === "sticky") stick();
          });
    observer?.observe(viewport);
    if (content) observer?.observe(content);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", markReaderInput, { passive: true });
    viewport.addEventListener("touchmove", markReaderInput, { passive: true });
    viewport.addEventListener("keydown", markReaderInput);
    viewport.addEventListener("pointerdown", startDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    const initial = measure();
    if (modeRef.current === "sticky") write(initial.maxTop);
    previousTop = viewport.scrollTop;
    setOverflowing(initial.overflowing);
    updateFades();

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", markReaderInput);
      viewport.removeEventListener("touchmove", markReaderInput);
      viewport.removeEventListener("keydown", markReaderInput);
      viewport.removeEventListener("pointerdown", startDrag);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      observer?.disconnect();
      cancelFrames();
      delete viewport.dataset.stickFade;
    };
  }, [viewport, content]);

  const jumpToBottom = useCallback(() => jumpRef.current(), []);
  return { mode, canJump: overflowing && mode === "detached", jumpToBottom };
}

/** Appears only while detached from overflowing content. Place inside a `relative` wrapper. */
export function BottomStickJumpButton(props: { visible: boolean; onJump: () => void }) {
  return (
    <div
      className={cn(
        "bottom-stick-jump pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center",
        props.visible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      aria-hidden={!props.visible}
      data-bottom-stick-jump
    >
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        aria-label="Scroll to latest"
        tabIndex={props.visible ? 0 : -1}
        className={cn("shadow-sm", props.visible && "pointer-events-auto")}
        onClick={props.onJump}
      >
        <ArrowDownIcon />
      </Button>
    </div>
  );
}

/**
 * A live region that follows its own growth; `live` picks the initial mode.
 * Bound it from a parent: `[data-bottom-stick-viewport]` takes the max-height,
 * and the box glides up to it before scrolling takes over.
 */
export function BottomStickScrollArea(props: { children: ReactNode; live: boolean }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLDivElement>(false);
  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      setViewport(node);
      outerRef.current = node;
    },
    [outerRef],
  );
  const contentNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setContent(node);
      contentRef.current = node;
    },
    [contentRef],
  );
  const { canJump, jumpToBottom } = useBottomStick(
    viewport,
    content,
    props.live ? "sticky" : "detached",
  );
  return (
    <div className="relative min-w-0">
      {/* No overscroll containment: at either edge the wheel chains on to the
          timeline instead of stopping dead inside a step. */}
      <div ref={viewportRef} className="min-w-0 overflow-auto" data-bottom-stick-viewport>
        <div ref={contentNodeRef} className="min-w-0 flow-root">
          {props.children}
        </div>
      </div>
      <BottomStickJumpButton visible={canJump} onJump={jumpToBottom} />
    </div>
  );
}
