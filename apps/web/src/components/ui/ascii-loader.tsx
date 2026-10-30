import { cn } from "~/lib/utils";

/** Braille spinner frames, stacked one per line and stepped through in CSS. */
const BRAILLE_FRAMES = "⠋\n⠙\n⠹\n⠸\n⠼\n⠴\n⠦\n⠧\n⠇\n⠏";

/**
 * Cursor-style pixel loader. A pure-CSS sprite (cursor-elements.css): no
 * per-frame React renders, compositor-only motion, a still frame under
 * reduced motion.
 */
export function AsciiLoader({ className }: { readonly className?: string | undefined }) {
  return (
    <span aria-hidden="true" data-ascii-loader className={cn("text-muted-foreground", className)}>
      <span>{BRAILLE_FRAMES}</span>
    </span>
  );
}
