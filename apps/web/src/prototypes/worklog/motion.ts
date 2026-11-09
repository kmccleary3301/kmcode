// PROTOTYPE: throwaway work-log tree demo. Not production code.
//
// Which changes animate, per DESIGN.md (Motion) and Emil's rule that keyboard
// actions never animate: a key press, the transport (scrub, seek, step) and
// reduced motion land at once; clicks and playback glide. The glides
// themselves reuse KM's transcript spring (`createSpringChase`, MOTION_MS),
// critically damped, so a retarget mid-flight keeps its velocity.
import { useEffect } from "react";

import { prefersReducedMotion } from "../../lib/motion";

/** DESIGN.md lands motion for 500 ms after a non-modifier key press. */
const KEY_LAND_MS = 500;
/** Seeks commit after the transport releases the pointer. */
const TRANSPORT_LAND_MS = 300;

let landUntil = 0;
let landTimer: number | undefined;

/** `data-wl-land` on the root lets CSS transitions (chevrons, fades) land too. */
function land(until: number): void {
  landUntil = until;
  window.clearTimeout(landTimer);
  const remaining = until - performance.now();
  document.documentElement.toggleAttribute("data-wl-land", remaining > 0);
  if (remaining > 0 && Number.isFinite(remaining)) {
    landTimer = window.setTimeout(() => land(0), remaining);
  }
}

/** True when a change happening now should land instead of glide. */
export function motionLands(): boolean {
  return performance.now() < landUntil || document.hidden || prefersReducedMotion();
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Tracks the input that precedes each change; mount once per page. */
export function useMotionInputs(): void {
  useEffect(() => {
    let onTransport = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(event.key)) land(performance.now() + KEY_LAND_MS);
    };
    const onPointerDown = (event: PointerEvent) => {
      onTransport =
        event.target instanceof Element && event.target.closest("[data-wl-transport]") !== null;
      // A pointer press ends the key window; the transport lands until release.
      land(onTransport ? Number.POSITIVE_INFINITY : 0);
    };
    const onPointerUp = () => {
      if (onTransport) land(performance.now() + TRANSPORT_LAND_MS);
      onTransport = false;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      land(0);
    };
  }, []);
}
