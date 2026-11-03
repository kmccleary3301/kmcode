import { normalizeThemeDefinition } from "@t3tools/shared/appearance";
import { GROVE_THEME, T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter, registerCustomTheme } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
  registerCustomTheme: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
  registerCustomTheme,
}));

import {
  activeSyntaxTheme,
  clearNormalizedSyntaxTheme,
  getSyntaxHighlighterPromise,
  registerNormalizedSyntaxTheme,
} from "./syntaxHighlighting";
import { resolveDiffThemeName, setActiveAppearanceDiffTheme } from "./diffRendering";

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
});

it("clears custom syntax and diff themes for safe-mode recovery", () => {
  setActiveAppearanceDiffTheme("custom-theme");
  expect(resolveDiffThemeName("dark")).toBe("custom-theme");

  clearNormalizedSyntaxTheme();

  expect(activeSyntaxTheme("pierre-dark")).toBe("pierre-dark");
  expect(resolveDiffThemeName("dark")).toBe("pierre-dark");
});

const KEYWORD_TOKENS = {
  tokens: [{ scopes: ["keyword"], foreground: "#ff0000", fontStyle: [] }],
} as const;

it("registers each content-addressed syntax theme only once across preview rollback", () => {
  const t3 = normalizeThemeDefinition(T3_CHAT_THEME);
  const grove = normalizeThemeDefinition(GROVE_THEME);
  const t3Dark = t3.variants.find((variant) => variant.appearance === "dark");
  const groveDark = grove.variants.find((variant) => variant.appearance === "dark");
  if (t3Dark === undefined || groveDark === undefined) throw new Error("Expected dark variants.");
  const t3Tokens = { ...t3Dark, syntax: KEYWORD_TOKENS };
  const groveTokens = { ...groveDark, syntax: KEYWORD_TOKENS };

  registerNormalizedSyntaxTheme(t3, t3Tokens);
  registerNormalizedSyntaxTheme(grove, groveTokens);
  clearNormalizedSyntaxTheme();
  registerNormalizedSyntaxTheme(t3, t3Tokens);

  expect(registerCustomTheme).toHaveBeenCalledTimes(2);
});

it("uses the bundled palette for its appearance when a theme has no token colors", () => {
  registerCustomTheme.mockClear();
  const grove = normalizeThemeDefinition(GROVE_THEME);
  for (const variant of grove.variants) {
    expect(registerNormalizedSyntaxTheme(grove, variant)).toBe(
      variant.appearance === "dark" ? "github-dark" : "github-light",
    );
  }
  expect(registerCustomTheme).not.toHaveBeenCalled();
  clearNormalizedSyntaxTheme();
});
