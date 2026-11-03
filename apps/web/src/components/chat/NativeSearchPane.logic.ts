import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";

export const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  parallel: "Parallel",
  perplexity: "Perplexity",
  gemini: "Gemini",
  anthropic: "Anthropic",
  codex: "OpenAI Codex",
  openai: "OpenAI API",
  xai: "xAI",
  openrouter: "OpenRouter",
  zai: "Z.AI",
  exa: "Exa",
  tinyfish: "TinyFish",
  jina: "Jina",
  kagi: "Kagi",
  tavily: "Tavily",
  firecrawl: "Firecrawl",
  brave: "Brave",
  kimi: "Kimi",
  synthetic: "Synthetic",
  ollama: "Ollama",
  searxng: "SearXNG",
  startpage: "Startpage",
  duckduckgo: "DuckDuckGo",
  ecosia: "Ecosia",
  google: "Google",
  mojeek: "Mojeek",
  public: "Public Web",
};

export function getSearchProviderLabel(provider: string | undefined): string | null {
  if (!provider || provider === "none") return null;
  const normalized = provider.toLowerCase();
  return SEARCH_PROVIDER_LABELS[normalized] ?? provider;
}

export interface NativeSearchSource {
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly safeHref: string | null;
  readonly snippet?: string;
  readonly publishedDate?: string;
  readonly ageText?: string;
}

export interface NativeSearchUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly searchRequests?: number;
}

export interface NativeSearchMetadata {
  readonly provider?: string;
  readonly providerLabel?: string;
  readonly model?: string;
  readonly authMode?: string;
  readonly usage?: NativeSearchUsage;
}

export interface NativeSearchData {
  readonly key: string;
  readonly query?: string;
  readonly answer?: string;
  readonly sources: ReadonlyArray<NativeSearchSource>;
  readonly metadata?: NativeSearchMetadata;
  readonly error?: string;
}

export function formatSearchAge(ageSeconds?: number | null): string | null {
  if (
    ageSeconds === undefined ||
    ageSeconds === null ||
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0
  ) {
    return null;
  }
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function extractDomain(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSources(rawSources: unknown): ReadonlyArray<NativeSearchSource> {
  if (!Array.isArray(rawSources)) return [];
  const sources: NativeSearchSource[] = [];
  for (const raw of rawSources) {
    const src = asRecord(raw);
    if (!src) continue;
    const url = typeof src.url === "string" ? src.url.trim() : "";
    const rawTitle = typeof src.title === "string" ? src.title.trim() : "";
    const title = rawTitle || url || "Untitled";
    const domain = url ? extractDomain(url) : "";
    const safeHref = resolveExternalWebLinkHref(url);
    const snippet = typeof src.snippet === "string" && src.snippet.trim() ? src.snippet.trim() : undefined;
    const publishedDate =
      typeof src.publishedDate === "string" && src.publishedDate.trim()
        ? src.publishedDate.trim()
        : undefined;
    const ageSeconds =
      typeof src.ageSeconds === "number" && Number.isFinite(src.ageSeconds)
        ? src.ageSeconds
        : undefined;
    const ageText = formatSearchAge(ageSeconds) ?? undefined;

    sources.push({
      title,
      url,
      domain,
      safeHref,
      ...(snippet !== undefined ? { snippet } : {}),
      ...(publishedDate !== undefined ? { publishedDate } : {}),
      ...(ageText !== undefined ? { ageText } : {}),
    });
  }
  return sources;
}

function parseUsage(rawUsage: unknown): NativeSearchUsage | undefined {
  const record = asRecord(rawUsage);
  if (!record) return undefined;
  const usage: Record<string, number> = {};
  let hasFields = false;

  for (const key of ["inputTokens", "outputTokens", "totalTokens", "searchRequests"] as const) {
    const val = record[key];
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      usage[key] = val;
      hasFields = true;
    }
  }

  return hasFields ? (usage as NativeSearchUsage) : undefined;
}

function parseMetadata(
  response: Record<string, unknown>,
): NativeSearchMetadata | undefined {
  const provider =
    typeof response.provider === "string" && response.provider.trim() && response.provider !== "none"
      ? response.provider.trim()
      : undefined;
  const providerLabel = getSearchProviderLabel(provider) ?? undefined;
  const model =
    typeof response.model === "string" && response.model.trim() ? response.model.trim() : undefined;
  const authMode =
    typeof response.authMode === "string" && response.authMode.trim()
      ? response.authMode.trim() === "oauth"
        ? "OAuth"
        : response.authMode.trim() === "api_key"
          ? "API"
          : response.authMode.trim()
      : undefined;
  const usage = parseUsage(response.usage);

  if (!provider && !model && !authMode && !usage) {
    return undefined;
  }

  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(providerLabel !== undefined ? { providerLabel } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(authMode !== undefined ? { authMode } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Reads native web_search structured data from turn item details.
 * Preserves actual Query/Answer/Sources/Metadata without fabricating sections.
 * Returns null if the item lacks structured web search data so normal ToolCard fallback is preserved.
 */
export function readNativeSearchData(item: OrchestrationV2TurnItem): NativeSearchData | null {
  if (item.type === "dynamic_tool") {
    const toolName = item.toolName?.toLowerCase();
    const title = item.title?.toLowerCase();
    const isSearchTool =
      toolName === "web_search" ||
      toolName === "websearch" ||
      title === "web_search" ||
      title === "websearch";

    if (!isSearchTool) return null;

    const details = asRecord(item.details);
    const input = asRecord(item.input);
    const query =
      typeof input?.query === "string" && input.query.trim()
        ? input.query.trim()
        : Array.isArray(input?.patterns) && typeof input.patterns[0] === "string"
          ? input.patterns[0].trim()
          : undefined;

    // Check if details contains a SearchResponse (either at details.response or details itself)
    const responseCandidate = asRecord(details?.response) ?? details;
    const error =
      typeof details?.error === "string" && details.error.trim() ? details.error.trim() : undefined;

    if (!responseCandidate && !error) {
      return null;
    }

    const answer =
      typeof responseCandidate?.answer === "string" && responseCandidate.answer.trim()
        ? responseCandidate.answer.trim()
        : undefined;

    const sources = parseSources(responseCandidate?.sources);
    const metadata = responseCandidate ? parseMetadata(responseCandidate) : undefined;

    // Only reported structured SearchResponse fields or actual native error select the pane.
    // Input query alone with unknown/empty details must return null for generic fallback.
    const hasStructuredResult = Boolean(
      answer || sources.length > 0 || metadata || error,
    );
    if (!hasStructuredResult) {
      return null;
    }
    return {
      key: JSON.stringify(["native-search", item.threadId, item.id]),
      ...(query !== undefined ? { query } : {}),
      ...(answer !== undefined ? { answer } : {}),
      sources,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  if (item.type === "web_search") {
    const query =
      Array.isArray(item.patterns) && typeof item.patterns[0] === "string"
        ? item.patterns.join(", ").trim()
        : undefined;
    const sources = parseSources(item.results);

    if (!query && sources.length === 0) return null;

    return {
      key: JSON.stringify(["canonical-web-search", item.threadId, item.id]),
      ...(query !== undefined ? { query } : {}),
      sources,
    };
  }

  return null;
}
