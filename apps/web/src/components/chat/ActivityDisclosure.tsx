/**
 * ActivityDisclosure
 * Selective progressive disclosure hooks, animated panel, and motion integration for KM Code.
 * Inspired by official Trace and Task source from shadcn / ai-elements.
 * Upstream sources:
 * - https://ui.shadcn.com/docs/components/base/trace
 * - https://ui.shadcn.com/docs/ai-elements/base/task.md
 * - https://ui.shadcn.com/r/styles/base-rhea/trace.json
 * Under MIT License: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md
 */

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import { MOTION_MS, useSmoothHeight } from "~/lib/motion";
/**
 * Derives the explicit collapsed cache key from a given disclosure key.
 * Follows the dual-key convention used across KM Code (e.g. `tool-collapsed:${id}`, `tool-output-collapsed:${id}`).
 */
export function toCollapsedKey(disclosureKey: string): string {
  const colonIndex = disclosureKey.indexOf(":");
  if (colonIndex !== -1) {
    const prefix = disclosureKey.slice(0, colonIndex);
    const rest = disclosureKey.slice(colonIndex + 1);
    if (prefix.endsWith("-expanded")) {
      return `${prefix.slice(0, -"-expanded".length)}-collapsed:${rest}`;
    }
    return `${prefix}-collapsed:${rest}`;
  }
  return `${disclosureKey}-collapsed`;
}

/**
 * Checks whether an interaction event was initiated by keyboard activation
 * (e.g. Enter or Space on a button, where event.detail === 0 or pointerType is empty).
 */
function isKeyboardActivation(event?: React.SyntheticEvent | Event | null): boolean {
  if (!event) return false;
  if ("key" in event || ("nativeEvent" in event && "key" in (event.nativeEvent as object))) {
    return true;
  }
  if ("detail" in event && typeof event.detail === "number" && event.detail === 0) {
    return true;
  }
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  if (
    native &&
    "detail" in native &&
    typeof (native as UIEvent).detail === "number" &&
    (native as UIEvent).detail === 0
  ) {
    return true;
  }
  if (
    native &&
    "pointerType" in native &&
    typeof (native as PointerEvent).pointerType === "string" &&
    (native as PointerEvent).pointerType === ""
  ) {
    return true;
  }
  return false;
}

export interface UseActivityDisclosureOptions {
  /** Optional cache set storing disclosure states (e.g. thread/timeline cache). */
  readonly cache?: Set<string> | undefined;
  /** Primary positive disclosure key (e.g. `tool:${id}` or `tool-output:${id}`). */
  readonly disclosureKey: string;
  /** Explicit collapsed key. If omitted, derived via toCollapsedKey(disclosureKey). */
  readonly collapsedKey?: string | undefined;
  /** Default open state when neither positive nor collapsed key is in cache. */
  readonly defaultOpen: boolean;
}

export interface UseActivityDisclosureResult {
  readonly open: boolean;
  readonly toggle: (event?: React.MouseEvent<HTMLElement> | React.SyntheticEvent) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly instant: boolean;
}

/**
 * Hook coordinating controlled progressive disclosure state with cache overrides,
 * instant keyboard toggling, and reduced-motion guards.
 */
export function useActivityDisclosure(
  options: UseActivityDisclosureOptions,
): UseActivityDisclosureResult {
  const { cache, disclosureKey, defaultOpen } = options;
  const explicitCollapsedKey = options.collapsedKey ?? toCollapsedKey(disclosureKey);
  const positiveKey = disclosureKey;

  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const [localOverrides, setLocalOverrides] = useState<{
    readonly cache: Set<string> | undefined;
    readonly values: ReadonlyMap<string, boolean>;
  } | null>(null);

  // Track key and defaultOpen changes to clear manual keyboard instant mode
  const [prevKey, setPrevKey] = useState(disclosureKey);
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  const [manualInstant, setManualInstant] = useState(false);

  const isKeyChanged = disclosureKey !== prevKey;
  if (isKeyChanged) {
    setPrevKey(disclosureKey);
    setManualInstant(false);
  }

  if (defaultOpen !== prevDefaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    setManualInstant(false);
  }

  const localOverride =
    localOverrides?.cache === cache ? localOverrides?.values.get(disclosureKey) : undefined;
  const override =
    localOverride ??
    (cache?.has(positiveKey) ? true : cache?.has(explicitCollapsedKey) ? false : undefined);

  const open = override ?? defaultOpen;

  const updateOverride = useCallback(
    (nextOpen: boolean, isKeyboard: boolean) => {
      setManualInstant(isKeyboard);
      if (cache !== undefined) {
        if (nextOpen) {
          cache.delete(explicitCollapsedKey);
          cache.add(positiveKey);
        } else {
          cache.delete(positiveKey);
          cache.add(explicitCollapsedKey);
        }
      }
      setLocalOverrides((previous) => {
        const values = new Map(previous?.cache === cache ? previous?.values : undefined);
        values.set(disclosureKey, nextOpen);
        return { cache, values };
      });
    },
    [cache, explicitCollapsedKey, positiveKey, disclosureKey],
  );

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      updateOverride(nextOpen, prefersReducedMotion);
    },
    [updateOverride, prefersReducedMotion],
  );

  const toggle = useCallback(
    (event?: React.MouseEvent<HTMLElement> | React.SyntheticEvent) => {
      const isKeyboard = isKeyboardActivation(event);
      updateOverride(!open, isKeyboard || prefersReducedMotion);
    },
    [open, updateOverride, prefersReducedMotion],
  );

  const instant = prefersReducedMotion || isKeyChanged || manualInstant;

  return {
    open,
    toggle,
    onOpenChange,
    instant,
  };
}

export interface ActivityDisclosurePanelProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly open: boolean;
  readonly instant?: boolean | undefined;
  readonly id?: string | undefined;
  readonly children?: React.ReactNode | undefined;
}

/**
 * Animated collapsible panel using cross-browser grid-template-rows: 0fr ↔ 1fr
 * over --motion-duration in both directions, instant keyboard toggles, reduced-motion
 * bypass, immediate closed/closing inertness, and a glide for content that changes
 * while open.
 */
export const ActivityDisclosurePanel = React.forwardRef<
  HTMLDivElement,
  ActivityDisclosurePanelProps
>(function ActivityDisclosurePanel(
  { open, instant, id, children, className, ...divProps },
  forwardedRef,
) {
  const internalPanelRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const panel = internalPanelRef.current;
    if (!panel) return;
    // Observe the stable activity wrapper:
    // BaseUI Root is display:contents, so its direct parentElement is the per-activity wrapper
    // containing this specific disclosure and its external summary button.
    const rootElement = panel.parentElement;
    const stableContainer = rootElement?.parentElement ?? rootElement ?? panel;
    return observeVisibleAnimation(stableContainer, setIsVisible);
  }, []);

  const effectiveInstant = instant || !isVisible;
  // The open/close itself is a glide: opening reveals through the bottom fade,
  // and enclosing glide boxes follow the track instead of chasing it.
  const [glide, setGlide] = useState<{
    readonly open: boolean;
    readonly phase: "grow" | "shrink" | "settle" | null;
  }>({ open, phase: null });
  if (glide.open !== open) setGlide({ open, phase: open ? "grow" : "shrink" });
  // Content changes while open glide too, but not while the track itself is
  // opening: content that mounts with the panel would otherwise spring inside
  // the growing track, two eases compounding into a slow start.
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLDivElement>(
    effectiveInstant || !open || glide.phase === "grow",
  );
  useEffect(() => {
    if (glide.phase === null) return;
    const timer = setTimeout(
      () => setGlide({ open: glide.open, phase: glide.phase === "settle" ? null : "settle" }),
      MOTION_MS,
    );
    return () => clearTimeout(timer);
  }, [glide]);

  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalPanelRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  return (
    <CollapsiblePrimitive.Root open={open} className="contents" style={{ display: "contents" }}>
      <CollapsiblePrimitive.Panel
        ref={mergedRef}
        id={id}
        inert={!open ? true : undefined}
        aria-hidden={!open ? "true" : undefined}
        data-instant={effectiveInstant ? "" : undefined}
        data-open={open ? "" : undefined}
        data-glide={!effectiveInstant && glide.phase !== null ? glide.phase : undefined}
        className={cn("activity-disclosure-panel", className)}
        {...divProps}
      >
        <div ref={outerRef} className="activity-disclosure-inner">
          <div ref={contentRef} className="activity-disclosure-content">
            {children}
          </div>
        </div>
      </CollapsiblePrimitive.Panel>
    </CollapsiblePrimitive.Root>
  );
});
