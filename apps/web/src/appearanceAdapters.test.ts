import { afterEach, describe, expect, it } from "vite-plus/test";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import { normalizeThemeDefinition } from "@t3tools/shared/appearance";
import {
  appearanceVariantCss,
  appearanceVariantDeclarations,
  diffAppearanceVariables,
  syntaxAppearanceVariables,
  terminalAppearanceVariables,
} from "./lib/appearanceAdapters";
import {
  clearNormalizedSyntaxTheme,
  getSyntaxHighlighterPromise,
  registerNormalizedSyntaxTheme,
} from "./lib/syntaxHighlighting";
import { clerkAppearance, CLERK_PORTAL_RENDERER_OWNER } from "./components/clerk/clerkAppearance";
import {
  PREVIEW_ANNOTATION_THEME_CHANNEL,
  PREVIEW_ANNOTATION_THEME_OWNER,
} from "./browser/annotationTheme";
import { WEB_RENDERER_OWNERSHIP } from "./lib/webRendererOwnership";

const profile = normalizeThemeDefinition(T3_CHAT_THEME, { platform: "web" });
const variant =
  profile.variants.find((candidate) => candidate.id === "dark") ?? profile.variants[0];
if (variant === undefined) throw new Error("Conformance fixture has no variant.");
const lightVariant = profile.variants.find((candidate) => candidate.appearance === "light");
if (lightVariant === undefined) throw new Error("Conformance fixture has no light variant.");

describe("normalized web appearance adapters", () => {
  afterEach(() => {
    clearNormalizedSyntaxTheme();
  });
  it("feeds every renderer adapter from terminal, syntax, and diff roles", () => {
    const declarations = appearanceVariantDeclarations(variant);
    expect(declarations).toContain(`--terminal-background:${variant.terminal.background};`);
    expect(declarations).toContain(
      `--terminal-ansi-brightWhite:${variant.terminal.ansi.brightWhite};`,
    );
    expect(declarations).toContain(`--diffs-bg-addition:${variant.diff.additionBackground};`);
    expect(appearanceVariantCss(variant)).toBe(`:root{${declarations}}`);
    expect(terminalAppearanceVariables(variant.terminal)["--terminal-cursor"]).toBe(
      variant.terminal.cursor,
    );
    expect(diffAppearanceVariables(variant.diff)["--diffs-header-bg"]).toBe(
      variant.diff.headerBackground,
    );
    expect(Object.keys(syntaxAppearanceVariables(variant.syntax))).toHaveLength(
      variant.syntax.tokens.length * 3,
    );
  });

  it("keeps keyword, string, and comment colors when syntax scopes are absent", async () => {
    for (const candidate of [variant, lightVariant]) {
      const themeName = registerNormalizedSyntaxTheme(profile, candidate);
      const highlighter = await getSyntaxHighlighterPromise("typescript", themeName);
      const tokens = highlighter
        .codeToTokens("const value = 'hello'; // comment", {
          lang: "typescript",
          theme: themeName,
        })
        .tokens.flat();
      const keywordColor = tokens.find((token) => token.content.includes("const"))?.color;
      const stringColor = tokens.find((token) => token.content.includes("'hello'"))?.color;
      const commentColor = tokens.find((token) => token.content.includes("// comment"))?.color;
      const colors = [keywordColor, stringColor, commentColor];

      expect(colors.every((color) => typeof color === "string")).toBe(true);
      expect(new Set(colors).size).toBe(3);
    }
  });

  it("keeps third-party and isolated preview bridges on explicit ownership boundaries", () => {
    expect(CLERK_PORTAL_RENDERER_OWNER).toBe(WEB_RENDERER_OWNERSHIP.clerkPortal);
    expect(clerkAppearance.variables?.colorBackground).toBe("var(--card)");
    expect(PREVIEW_ANNOTATION_THEME_OWNER).toBe(WEB_RENDERER_OWNERSHIP.previewIsolatedDocument);
    expect(PREVIEW_ANNOTATION_THEME_CHANNEL).toBe("desktop-preview-annotation");
  });
});
