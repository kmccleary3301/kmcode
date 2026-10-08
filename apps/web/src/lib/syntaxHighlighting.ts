import {
  getSharedHighlighter,
  registerCustomTheme,
  type DiffsHighlighter,
  type HighlighterTypes,
  type SupportedLanguages,
} from "@pierre/diffs";
import {
  hashNormalizedAppearanceProfile,
  type NormalizedAppearanceProfile,
  type NormalizedAppearanceVariant,
} from "@t3tools/shared/appearance";
import { setActiveAppearanceDiffTheme } from "./diffRendering";

/**
 * Always highlight with the Oniguruma WASM engine — the JS regex engine can
 * backtrack catastrophically and hang the tokenizing thread. The shared
 * highlighter is a first-caller-wins singleton, so every creation site must
 * pass this value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const registeredSyntaxThemeNames = new Set<string>();
let activeSyntaxThemeName: string | null = null;
let activeSyntaxThemeKey: string | null = null;

function syntaxThemeRegistration(name: string, variant: NormalizedAppearanceVariant) {
  return {
    name,
    type: variant.appearance,
    colors: {
      "editor.background": variant.diff.background,
      "editor.foreground": variant.diff.foreground,
    },
    tokenColors: variant.syntax.tokens.map((token) => ({
      scope: [...token.scopes],
      settings: {
        foreground: token.foreground,
        ...(token.background === undefined ? {} : { background: token.background }),
        ...(token.fontStyle.length === 0 ? {} : { fontStyle: token.fontStyle.join(" ") }),
      },
    })),
  };
}
export function registerNormalizedSyntaxTheme(
  profile: NormalizedAppearanceProfile,
  variant: NormalizedAppearanceVariant,
): string {
  const profileHash = hashNormalizedAppearanceProfile(profile);
  const key = `${profileHash}:${variant.id}`;
  const name = `t3-appearance-${profileHash.slice(0, 16)}-${variant.id}`;
  if (activeSyntaxThemeKey === key && activeSyntaxThemeName === name) return name;
  if (!registeredSyntaxThemeNames.has(name)) {
    registerCustomTheme(name, () => Promise.resolve(syntaxThemeRegistration(name, variant)));
    registeredSyntaxThemeNames.add(name);
  }
  activeSyntaxThemeKey = key;
  activeSyntaxThemeName = name;
  highlighterPromiseCache.clear();
  setActiveAppearanceDiffTheme(name);
  return name;
}

export function clearNormalizedSyntaxTheme(): void {
  activeSyntaxThemeKey = null;
  activeSyntaxThemeName = null;
  highlighterPromiseCache.clear();
  setActiveAppearanceDiffTheme(null);
}

export function activeSyntaxTheme(fallback: string): string {
  return activeSyntaxThemeName ?? fallback;
}

export function getSyntaxHighlighterPromise(
  language: string,
  themeName = activeSyntaxTheme("pierre-dark"),
): Promise<DiffsHighlighter> {
  const cacheKey = `${themeName}:${language}`;
  const cached = highlighterPromiseCache.get(cacheKey);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [themeName],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(cacheKey);
      throw error;
    }
    return getSyntaxHighlighterPromise("text", themeName);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  return promise;
}
