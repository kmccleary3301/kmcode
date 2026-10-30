import { faviconUrlForOrigin } from "@t3tools/shared/favicon";

import { cn } from "~/lib/utils";
import { SpinningGlobe } from "./spinning-globe";

interface FaviconSource {
  readonly url: string;
  readonly domain: string;
}

interface FaviconStackProps {
  readonly sources: ReadonlyArray<FaviconSource>;
  readonly active: boolean;
  readonly className?: string | undefined;
  readonly max?: number | undefined;
}

/** A compact, ordered stack of unique public-site favicons for web search. */
export function FaviconStack({ sources, active, className, max = 4 }: FaviconStackProps) {
  const seenDomains = new Set<string>();
  const uniqueSources: Array<{ readonly domain: string; readonly faviconUrl: string }> = [];

  for (const source of sources) {
    const domain = source.domain.trim().toLowerCase();
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    const faviconUrl = faviconUrlForOrigin(source.url, 64);
    if (faviconUrl !== null) uniqueSources.push({ domain, faviconUrl });
  }

  if (uniqueSources.length === 0 && !active) return null;
  if (uniqueSources.length === 0) {
    return (
      <>
        <span className={cn("favicon-stack", className)} data-active="true" aria-hidden="true">
          <SpinningGlobe className="size-3.5" />
        </span>
        <span className="sr-only">Searching the web</span>
      </>
    );
  }

  const visibleCount = Math.max(0, Math.floor(max));
  const visibleSources = uniqueSources.slice(0, visibleCount);
  const overflowCount = uniqueSources.length - visibleSources.length;

  return (
    <>
      <span
        className={cn("favicon-stack", className)}
        data-active={active ? "true" : "false"}
        aria-hidden="true"
      >
        {visibleSources.map((source, index) => (
          <span
            key={source.domain}
            className="favicon-stack-item"
            data-latest={index === visibleSources.length - 1 ? "true" : undefined}
            style={{ animationDelay: `${index * 70}ms` }}
          >
            <img
              src={source.faviconUrl}
              alt=""
              draggable={false}
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          </span>
        ))}
        {overflowCount > 0 ? (
          <span className="favicon-stack-overflow">+{overflowCount}</span>
        ) : null}
      </span>
      <span className="sr-only">
        {uniqueSources.length} search result {uniqueSources.length === 1 ? "source" : "sources"}
      </span>
    </>
  );
}
