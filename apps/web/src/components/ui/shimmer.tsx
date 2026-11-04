import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The layers of a live label's sweep, rendered inside the label's own element.
 * That element carries a sweep class while live (`live-tool-shine`,
 * `cursor-subagent-shimmer`, `minimal-text-shimmer`), and CSS draws the look
 * from it.
 *
 * The children render again as an aria-hidden copy in a window that slides
 * one way while the copy slides back, so the band crosses text that holds
 * still. Only transforms animate, so the compositor draws the sweep without a
 * main-thread frame. `copyClassName` repeats the label element's layout classes
 * so each copy lays out exactly like the label. `underlay` adds the still copy
 * that `live-tool-shine`'s own look tints beneath the label's text (the minimal
 * look hides it).
 *
 * The label keeps its wrapper while idle (`display: contents`), so a row that
 * goes live or settles keeps its children mounted.
 */
export function ShimmerLayers({
  active,
  underlay = false,
  copyClassName,
  children,
}: {
  active: boolean;
  underlay?: boolean;
  copyClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <>
      <span className="shimmer-base" data-live={active ? "" : undefined}>
        {children}
      </span>
      {active ? (
        <span aria-hidden="true" inert className="shimmer-clip">
          {underlay ? (
            <span className={cn("shimmer-underlay", copyClassName)}>{children}</span>
          ) : null}
          <span className="shimmer-window">
            <span className={cn("shimmer-copy", copyClassName)}>{children}</span>
          </span>
        </span>
      ) : null}
    </>
  );
}
