/**
 * A small globe, seen in orthographic projection: five longitude arcs sweep
 * across its face at even intervals, with the far-side arcs dimmer. Their
 * non-scaling strokes keep the rotation legible at the 14px step size.
 */
export function SpinningGlobe({ className }: { readonly className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path className="spinning-globe-latitude" d="M3.1 8.2c5.2 1.7 12.6 1.7 17.8 0" />
      <path d="M2 12h20" />
      <path className="spinning-globe-latitude" d="M3.1 15.8c5.2-1.7 12.6-1.7 17.8 0" />
      <path className="spinning-globe-meridian" data-meridian="1" d="M12 2a10 10 0 0 1 0 20" />
      <path className="spinning-globe-meridian" data-meridian="2" d="M12 2a10 10 0 0 1 0 20" />
      <path className="spinning-globe-meridian" data-meridian="3" d="M12 2a10 10 0 0 1 0 20" />
      <path className="spinning-globe-meridian" data-meridian="4" d="M12 2a10 10 0 0 1 0 20" />
      <path className="spinning-globe-meridian" data-meridian="5" d="M12 2a10 10 0 0 1 0 20" />
    </svg>
  );
}
