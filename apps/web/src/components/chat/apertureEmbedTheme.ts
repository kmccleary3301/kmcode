import {
  APERTURE_EMBED_THEME_COLOR_ROLES,
  type ApertureEmbedTheme,
  type ApertureEmbedThemeColorRole,
} from "@t3tools/shared/apertureEmbed";
import { themeColorToNativeColor } from "@t3tools/shared/themePalettes";

/** KM Code themes that ship an Aperture twin per appearance, as `<id>` and `<id>-dark`. */
const PAIRED_THEME_IDS: ReadonlySet<string> = new Set([
  "km-code",
  "grove",
  "ocean",
  "ember",
  "iris",
  "parchment",
]);

/** KM Code themes that ship one Aperture theme, under a different id where the names differ. */
const SINGLE_THEME_IDS: Readonly<Record<string, string>> = {
  "ayu-light": "ayu-light",
  "ayu-dark": "ayu-dark",
  "ayu-mirage": "ayu-mirage",
  "tokyo-night": "tokyo-night",
  "catppuccin-mocha": "catppuccin-mocha",
  "one-dark-pro": "one-dark-pro",
  "dracula-official": "dracula",
  nord: "nord",
  "ros-pine": "rose-pine",
  "gruvbox-material-dark": "gruvbox-material-dark",
  "monoline-void": "monoline-void",
};

/** Where each Aperture color role comes from in the host's shared theme variables. */
const COLOR_ROLE_VARIABLES: Readonly<Record<ApertureEmbedThemeColorRole, string>> = {
  page: "--background",
  card: "--card",
  inset: "--background",
  raised: "--popover",
  border: "--border",
  borderStrong: "--input",
  text: "--foreground",
  textSecondary: "--muted-foreground",
  textMuted: "--muted-foreground",
  textFaint: "--muted-foreground",
  accent: "--accent",
  warning: "--warning",
  danger: "--destructive",
};

/** The registered Aperture theme that matches a KM Code theme, or null when none does. */
export function apertureVizThemeForKmTheme(
  themeId: string | null,
  appearance: "light" | "dark",
): string | null {
  if (themeId === null) return null;
  if (PAIRED_THEME_IDS.has(themeId)) return appearance === "dark" ? `${themeId}-dark` : themeId;
  return SINGLE_THEME_IDS[themeId] ?? null;
}

/**
 * What the embed paints with. An agent's `override` wins and is shown as chosen. Otherwise the
 * Aperture twin of the active KM Code theme is used, and a theme with no twin sends its own
 * palette. The transcript's background and fonts stay in `tokens` unless the agent chose a look.
 */
export function apertureEmbedTheme(input: {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
  readonly themeId: string | null;
  readonly override: string | undefined;
}): ApertureEmbedTheme {
  const { appearance, variables, themeId, override } = input;
  if (override !== undefined) return { appearance, vizTheme: override, tokens: {} };
  const colors: Partial<Record<ApertureEmbedThemeColorRole, string>> = {};
  for (const role of APERTURE_EMBED_THEME_COLOR_ROLES) {
    const value = variables[COLOR_ROLE_VARIABLES[role]];
    if (value !== undefined) colors[role] = themeColorToNativeColor(value);
  }
  const tokens: Record<string, string> = {};
  for (const [token, variable] of [
    ["--plot-page", "--background"],
    ["--plot-font-ui", "--font-sans"],
    ["--plot-font-mono", "--font-mono"],
  ] as const) {
    const value = variables[variable];
    if (value !== undefined) tokens[token] = value;
  }
  return {
    appearance,
    vizTheme: apertureVizThemeForKmTheme(themeId, appearance) ?? "",
    colors,
    tokens,
  };
}
