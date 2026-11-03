interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
  onVisibilityChange?: ((running: boolean) => void) | undefined;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function updateAnimation(animation: ObservedAnimation) {
  const running =
    animation.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches;
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
    onVisibilityChange,
  };
  animations.set(element, animation);
  updateAnimation(animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
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
    }
  };
}
