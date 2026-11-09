import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createSpringChase, prefersReducedMotion } from "./motion";

/**
 * Freed space at the end holds this long before gliding shut, so a step
 * that settles and the next that arrives in the same burst meet in the slack
 * instead of the view dropping and then climbing back. Longer holds leave a
 * visible empty gap above the composer for no benefit.
 */
const END_SLACK_HOLD_MS = 200;
const END_SLACK_RELEASE_MS = 400;
/** The slack never takes more than this share of the viewport. */
const END_SLACK_MAX_SHARE = 0.5;
/** A scroll this soon after the reader's own input is theirs. */
const READER_INTENT_MS = 1000;
/**
 * Growth up to this share of the viewport glides up instead of jumping; a
 * larger move (a load, a thread switch) lands at once. While the turn runs,
 * any growth glides: a tall excerpt opening is still the end moving.
 */
const END_GLIDE_MAX_SHARE = 0.5;

/**
 * The single owner of a virtualized transcript's live end, after shadcn's
 * Message Scroller and use-stick-to-bottom: one mode (attached or not), one
 * place that writes the scroll offset, and every resize re-pinning while
 * attached. Reaching the end re-attaches; an upward scroll detaches only
 * right after the reader's own input, so the list moving the offset itself
 * never counts as the reader leaving.
 *
 * Settling happens after LegendList commits a measurement and before paint:
 * it writes item sizes from its ResizeObserver callback and React commits
 * the resulting store update in a microtask, so `settle` waits two microtask
 * hops. Observing the list's content box instead would be a frame late (it
 * resizes inside that callback, below the observer depth already delivered).
 *
 * Slack: when rows at the end shrink (a live card settling, an exit glide),
 * a margin above the footer grows by the same amount in the same commit, so
 * the scroll height holds and nothing on screen drops; rows that grow again
 * fill it before pushing anything up. Leftover slack glides shut once the
 * list is still, or as soon as the turn ends: a finished turn folding its
 * work away has nothing coming to refill the space, so the end takes the
 * shrink. It sits on LegendList's footer box as a margin, which no
 * observer sees, and it measures rows only, so a composer inset change
 * moves the end instead of being absorbed.
 *
 * Above the view: a row above the top of the viewport changing size (an
 * excerpt folding away, a measurement correcting) moves everything on screen
 * by the same amount. That is not the end moving, so it is neither slack nor
 * glide: the offset moves with it in the same frame and nothing on screen
 * does. The row at the top of the viewport is the reference; its offset in
 * the content shifts only when rows above it resize.
 *
 * Glide: while attached, growth at the end scrolls up on a spring chase
 * instead of in one frame, so arriving lines slide in from under the composer.
 * Growth arriving mid-glide retargets it without losing speed. The glide is
 * the scroll offset itself: a transform on the content would count as
 * scrollable overflow, grow the list, and pin again. Reader input stops it.
 *
 * `footer` is the element rendered as the list's footer component.
 */
export function useEndFollow({
  scroller,
  footer,
  follows,
  live,
}: {
  readonly scroller: HTMLElement | null;
  readonly footer: HTMLElement | null;
  readonly follows: boolean;
  /** The turn is running, so freed space at the end may be refilled. */
  readonly live: boolean;
}) {
  const followsRef = useRef(follows);
  const liveRef = useRef(live);
  const attachedRef = useRef(true);
  const scheduleRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    followsRef.current = follows;
    liveRef.current = live;
  });
  useEffect(() => {
    const content = scroller?.firstElementChild;
    const footerBox = footer?.parentElement ?? null;
    if (!scroller || !(content instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
      return;
    }
    let previousTop = scroller.scrollTop;
    let intentAt = Number.NEGATIVE_INFINITY;
    let pointerHeld = false;
    let rowsEnd: number | undefined;
    let releaseTimer: number | undefined;
    let queued = false;
    let anchor: { readonly row: Element; readonly offset: number } | undefined;
    const contentOffset = (row: Element) =>
      row.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const markAnchor = () => {
      const box = scroller.getBoundingClientRect();
      let row = scroller.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + 1);
      // LegendList positions each row as a child of the box inside `content`.
      while (row !== null && row.parentElement?.parentElement !== content) row = row.parentElement;
      anchor = row === null ? undefined : { row, offset: contentOffset(row) };
    };
    const following = () => attachedRef.current && followsRef.current;
    const chase = createSpringChase(
      (value) => {
        scroller.scrollTop = value;
        previousTop = scroller.scrollTop;
      },
      () => pin(),
    );
    const pin = () => {
      if (!following()) return;
      const end = scroller.scrollHeight - scroller.clientHeight;
      const from = scroller.scrollTop;
      if (end - from <= 0.5 && !chase.running) return;
      // Only the end growing under the offset this hook last wrote glides; an
      // offset something else moved (a clamp, a list correction) snaps back.
      const grew = Math.abs(from - previousTop) <= 1;
      if (
        grew &&
        (chase.running ||
          ((liveRef.current || end - from <= scroller.clientHeight * END_GLIDE_MAX_SHARE) &&
            !prefersReducedMotion()))
      ) {
        chase.to(from, end);
        return;
      }
      chase.stop();
      scroller.scrollTop = end;
      previousTop = scroller.scrollTop;
    };
    const setSlack = (height: number, release: boolean) => {
      if (!footerBox) return;
      footerBox.style.transition = release
        ? `margin-top ${END_SLACK_RELEASE_MS}ms var(--ease-disclosure)`
        : "";
      footerBox.style.marginTop = height > 0 ? `${height}px` : "";
    };
    const absorb = () => {
      if (!footerBox) return;
      // The computed margin is the live value mid-release.
      const slack = Number.parseFloat(getComputedStyle(footerBox).marginTop) || 0;
      const end =
        footerBox.getBoundingClientRect().top - content.getBoundingClientRect().top - slack;
      const delta = rowsEnd === undefined ? 0 : end - rowsEnd;
      rowsEnd = end;
      // Once the turn ends nothing arrives to refill freed space: the end
      // takes the shrink and leftover slack glides shut now.
      if (!liveRef.current) {
        if (slack > 0) {
          window.clearTimeout(releaseTimer);
          setSlack(0, !prefersReducedMotion());
        }
        return;
      }
      if (!following()) return;
      const above =
        anchor !== undefined && anchor.row.isConnected
          ? contentOffset(anchor.row) - anchor.offset
          : 0;
      const endDelta = delta - above;
      if (Math.abs(endDelta) >= 0.5) {
        const next = Math.min(
          Math.max(0, slack - endDelta),
          scroller.clientHeight * END_SLACK_MAX_SHARE,
        );
        setSlack(next, false);
        window.clearTimeout(releaseTimer);
        if (next > 0) {
          releaseTimer = window.setTimeout(
            () => setSlack(0, !prefersReducedMotion()),
            END_SLACK_HOLD_MS,
          );
        }
      }
      if (Math.abs(above) >= 0.5) {
        // `previousTop` is the offset before this commit; a shrink above may
        // already have clamped the live one.
        if (chase.running) chase.shift(above);
        scroller.scrollTop = previousTop + above;
        previousTop = scroller.scrollTop;
      }
    };
    const settle = () => {
      absorb();
      pin();
      markAnchor();
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() =>
        queueMicrotask(() => {
          queued = false;
          settle();
        }),
      );
    };
    const onIntent = () => {
      intentAt = performance.now();
      chase.stop();
    };
    const onPointerDown = () => {
      pointerHeld = true;
      onIntent();
    };
    const onPointerUp = () => {
      if (!pointerHeld) return;
      pointerHeld = false;
      onIntent();
    };
    const onKeyIntent = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        target === scroller.ownerDocument.body ||
        (target instanceof Node && scroller.contains(target))
      ) {
        onIntent();
      }
    };
    // A scroll is the reader's when it follows their input (a scrollbar drag
    // holds intent until release); any other scroll is the list's own.
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (scroller.scrollHeight - scroller.clientHeight - top <= 2) {
        attachedRef.current = true;
      } else if (pointerHeld || performance.now() - intentAt < READER_INTENT_MS) {
        if (top < previousTop - 1) attachedRef.current = false;
      } else {
        pin();
      }
      previousTop = scroller.scrollTop;
      markAnchor();
    };
    // The viewport and the footer (composer inset, status line) resize
    // outside LegendList's measurement; neither is written to here.
    const observer = new ResizeObserver(settle);
    observer.observe(scroller);
    if (footer) observer.observe(footer);
    const doc = scroller.ownerDocument;
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onIntent, { passive: true });
    scroller.addEventListener("touchmove", onIntent, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    doc.addEventListener("pointerup", onPointerUp);
    doc.addEventListener("pointercancel", onPointerUp);
    doc.addEventListener("keydown", onKeyIntent);
    scheduleRef.current = schedule;
    return () => {
      scheduleRef.current = null;
      observer.disconnect();
      window.clearTimeout(releaseTimer);
      chase.stop();
      setSlack(0, false);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onIntent);
      scroller.removeEventListener("touchmove", onIntent);
      scroller.removeEventListener("pointerdown", onPointerDown);
      doc.removeEventListener("pointerup", onPointerUp);
      doc.removeEventListener("pointercancel", onPointerUp);
      doc.removeEventListener("keydown", onKeyIntent);
    };
  }, [scroller, footer]);
  /** Re-measure and re-pin once the list has committed its next layout. */
  const settle = useCallback(() => scheduleRef.current?.(), []);
  return { attachedRef, settle };
}
