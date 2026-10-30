const TERMINAL_SPINNER_FRAMES = "⣾\n⣽\n⣻\n⢿\n⡿\n⣟\n⣯\n⣷";
const THINKING_PULSE_FRAMES = "✻\n✼\n❉\n❊\n✺\n✹\n✸\n✶";

/** OMP's terminal status spinner: eight frames, 80ms per frame in CSS. */
export function TerminalSpinner({ className }: { readonly className?: string | undefined }) {
  return (
    <span aria-hidden="true" data-terminal-spinner className={className}>
      <span>{TERMINAL_SPINNER_FRAMES}</span>
    </span>
  );
}

/** OMP's thinking pulse: eight frames with a raised-cosine dwell in CSS. */
export function ThinkingPulse({ className }: { readonly className?: string | undefined }) {
  return (
    <span aria-hidden="true" data-thinking-pulse className={className}>
      <span>{THINKING_PULSE_FRAMES}</span>
    </span>
  );
}
