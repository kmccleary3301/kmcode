import { useEffect, useState } from "react";

import { AsciiLoader } from "../ui/ascii-loader";
import { FaviconStack } from "../ui/favicon-stack";
import { SpinningGlobe } from "../ui/spinning-globe";
import { TerminalSpinner, ThinkingPulse } from "../ui/terminal-spinner";
import { WaitClockGlyph } from "./NativeWaitingPane";

const GALLERY_SEARCH_SOURCES: ReadonlyArray<{ readonly url: string; readonly domain: string }> = [
  { url: "https://github.com", domain: "github.com" },
  { url: "https://developer.mozilla.org", domain: "developer.mozilla.org" },
  { url: "https://wikipedia.org", domain: "wikipedia.org" },
  { url: "https://npmjs.com", domain: "npmjs.com" },
  { url: "https://stackoverflow.com", domain: "stackoverflow.com" },
  { url: "https://www.rust-lang.org", domain: "rust-lang.org" },
];

/** A small live preview of the glyphs used by the transcript. */
export function LoaderGallery({ className }: { readonly className?: string | undefined }) {
  const [sourceCount, setSourceCount] = useState(1);

  useEffect(() => {
    let disposed = false;
    let timerId: number | null = null;
    const scheduleNext = () => {
      timerId = window.setTimeout(() => {
        if (disposed) return;
        setSourceCount((current) => (current >= GALLERY_SEARCH_SOURCES.length ? 1 : current + 1));
        scheduleNext();
      }, 700);
    };
    scheduleNext();
    return () => {
      disposed = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, []);

  return (
    <section className={className} aria-label="Loader gallery">
      <div className="loader-gallery-grid">
        <div className="loader-gallery-item">
          <span className="loader-gallery-label">Running step · braille</span>
          <div className="loader-gallery-preview text-sm">
            <AsciiLoader />
          </div>
        </div>
        <div className="loader-gallery-item">
          <span className="loader-gallery-label">Web search · globe</span>
          <div className="loader-gallery-preview loader-gallery-globe-preview">
            <SpinningGlobe className="size-3.5" />
            <SpinningGlobe className="size-7" />
          </div>
        </div>
        <div className="loader-gallery-item">
          <span className="loader-gallery-label">Web search · favicons</span>
          <div className="loader-gallery-preview">
            <FaviconStack sources={GALLERY_SEARCH_SOURCES.slice(0, sourceCount)} active />
          </div>
        </div>
        <div className="loader-gallery-item">
          <span className="loader-gallery-label">Waiting · clock</span>
          <div className="loader-gallery-preview">
            <WaitClockGlyph className="size-4" />
          </div>
        </div>
        <div className="loader-gallery-item">
          <span className="loader-gallery-label">Terminal spinner</span>
          <div className="loader-gallery-preview text-base">
            <TerminalSpinner />
          </div>
        </div>
        <div className="loader-gallery-item">
          <span className="loader-gallery-label">Thinking pulse</span>
          <div className="loader-gallery-preview text-base">
            <ThinkingPulse />
          </div>
        </div>
      </div>
    </section>
  );
}
