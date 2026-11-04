interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
  running: boolean;
  onVisibilityChange?: ((running: boolean) => void) | undefined;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;
const unaligned = new Set<Element>();
let alignFrame: number | null = null;

/**
 * Loops share one phase, the document timeline's origin. Stepped sweeps then
 * change on the same frames; out of phase, a few of them interleave into a
 * change on nearly every display frame. Seeking `currentTime` leaves
 * `animation-play-state` with CSS, where setting `startTime` would take it over.
 */
function alignPhase(animation: Animation) {
  if (animation.effect?.getTiming().iterations !== Infinity) return;
  animation.ready.then(
    () => {
      const now = animation.timeline?.currentTime;
      if (animation.playState === "running" && now != null) animation.currentTime = now;
    },
    // A cancelled loop has no phase left to keep.
    () => {},
  );
}

function alignUnaligned() {
  alignFrame = null;
  for (const element of unaligned) {
    for (const animation of element.getAnimations({ subtree: true })) alignPhase(animation);
  }
  unaligned.clear();
}

function alignStartedAnimation(event: AnimationEvent) {
  if (!(event.target instanceof Element)) return;
  for (const animation of event.target.getAnimations()) {
    if (animation instanceof CSSAnimation && animation.animationName === event.animationName) {
      alignPhase(animation);
    }
  }
}

function updateAnimation(animation: ObservedAnimation) {
  const running =
    animation.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches;
  // A resumed loop picks up where it paused, off the shared phase.
  if (running && !animation.running) {
    unaligned.add(animation.element);
    alignFrame ??= requestAnimationFrame(alignUnaligned);
  }
  animation.running = running;
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto",
  );
  animation.onVisibilityChange?.(running);
}

function updateAnimations() {
  for (const animation of animations.values()) updateAnimation(animation);
}

/** Attach to a stable animation container. All refs share visibility and motion listeners. */
export function observeVisibleAnimation(
  element: HTMLElement | SVGElement | null,
  onVisibilityChange?: ((running: boolean) => void) | undefined,
) {
  if (element === null) return;
  if (typeof IntersectionObserver === "undefined") {
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    onVisibilityChange?.(false);
    return;
  }
  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAnimations);
    document.addEventListener("visibilitychange", updateAnimations);
    document.addEventListener("animationstart", alignStartedAnimation, true);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const rect = element.getBoundingClientRect();
  const animation: ObservedAnimation = {
    element,
    intersecting:
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth,
    running: false,
    onVisibilityChange,
  };
  animations.set(element, animation);
  updateAnimation(animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    unaligned.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    animation.onVisibilityChange?.(false);
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAnimations);
      document.removeEventListener("animationstart", alignStartedAnimation, true);
      if (alignFrame !== null) cancelAnimationFrame(alignFrame);
      alignFrame = null;
    }
  };
}
