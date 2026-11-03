import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";

interface SwapState {
  readonly state: string;
  readonly from: string | null;
  readonly version: number;
}

/**
 * A status glyph that crossfades when its state changes: the old glyph (a
 * loader, say) fades out in place while the new one (its check) fades in, so
 * neither pops. It renders still at mount, so history and virtualized
 * remounts do not animate; `enterFrom` names the state a remount replaces
 * when the glyph was on screen a moment ago, and crossfades from it. `render`
 * draws the glyph for a state; it draws the leaving one too, which is why it
 * takes the state instead of children.
 */
export function GlyphSwap({
  state,
  enterFrom = null,
  render,
  className,
  ...props
}: {
  readonly state: string;
  readonly enterFrom?: string | null;
  readonly render: (state: string) => ReactNode;
} & Omit<ComponentProps<"span">, "children">) {
  const [swap, setSwap] = useState<SwapState>(() =>
    enterFrom === null || enterFrom === state
      ? { state, from: null, version: 0 }
      : { state, from: enterFrom, version: 1 },
  );
  if (swap.state !== state) {
    setSwap({ state, from: swap.state, version: swap.version + 1 });
  }
  return (
    <span className={cn("glyph-swap", className)} {...props}>
      <span key={`in-${swap.version}`} className={swap.version > 0 ? "glyph-swap-in" : undefined}>
        {render(state)}
      </span>
      {swap.from === null ? null : (
        <span
          key={`out-${swap.version}`}
          className="glyph-swap-out"
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            setSwap((current) =>
              current.version === swap.version ? { ...current, from: null } : current,
            );
          }}
        >
          {render(swap.from)}
        </span>
      )}
    </span>
  );
}
