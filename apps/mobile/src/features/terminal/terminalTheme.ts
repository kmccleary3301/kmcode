import {
  getMobileThemeColors,
  getMobileThemeVariables,
  isLegacyMobileThemeId,
  themeColorToNativeColor,
  type MobileThemeId,
} from "../../lib/mobileTheme";
import type { NormalizedAppearanceProfile } from "@t3tools/shared/appearance";
import {
  buildGhosttyTypographyConfig,
  compileMobileAppearance,
} from "../../lib/mobileAppearanceAdapter";
export type TerminalAppearanceScheme = "light" | "dark";

export interface TerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly cursorForeground: string;
  readonly cursorBackground: string;
  readonly selection?: string;
  readonly scrollbar?: string;
  readonly scrollbarHover?: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly lineHeight?: number;
  readonly letterSpacingEm?: number;
  readonly ligatures?: boolean;
  readonly featureSettings?: Readonly<Record<string, number>>;
  readonly variableAxes?: Readonly<Record<string, number>>;
  /** The 16 ANSI colors, in order. A fixed tuple so indexed reads are never undefined. */
  readonly palette: TerminalPalette;
}

type TerminalPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const PIERRE_LIGHT_THEME: TerminalTheme = {
  // Pierre terminal palette with the app's shared screen background.
  background: "#fcfcfc",
  foreground: "#6C6C71",
  mutedForeground: "#8E8E95",
  border: "#eeeeef",
  cursorForeground: "#009fff",
  cursorBackground: "#fcfcfc",
  palette: [
    "#1F1F21",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#1F1F21",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
};

const PIERRE_DARK_THEME: TerminalTheme = {
  // Pierre terminal palette with the app's shared screen background.
  background: "#0a0a0a",
  foreground: "#adadb1",
  mutedForeground: "#8E8E95",
  border: "#2e2e30",
  cursorForeground: "#009fff",
  cursorBackground: "#0a0a0a",
  palette: [
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
};

function getPierreTerminalTheme(scheme: TerminalAppearanceScheme): TerminalTheme {
  return scheme === "light" ? PIERRE_LIGHT_THEME : PIERRE_DARK_THEME;
}

export function getMobileTerminalTheme(
  themeId: MobileThemeId,
  scheme: TerminalAppearanceScheme,
): TerminalTheme {
  const base = getPierreTerminalTheme(scheme);
  const paletteId = themeId === "material-you" ? "t3-code" : themeId;
  const palette = getMobileThemeColors(paletteId, scheme);
  const colors = getMobileThemeVariables(paletteId, scheme);
  const background = themeColorToNativeColor(palette.terminalBackground);
  return {
    ...base,
    background,
    foreground: themeColorToNativeColor(palette.terminalForeground),
    mutedForeground: colors["--color-foreground-muted"],
    border: colors["--color-border"],
    cursorForeground: themeColorToNativeColor(palette.terminalCursor),
    cursorBackground: background,
  };
}

export function getProfileTerminalTheme(
  profile: NormalizedAppearanceProfile,
  scheme: TerminalAppearanceScheme,
): TerminalTheme {
  const theme = compileMobileAppearance(profile, scheme).rendererPalettes.terminal;
  return {
    background: theme.background,
    foreground: theme.foreground,
    mutedForeground: theme.foreground,
    border: theme.scrollbar,
    cursorForeground: theme.cursor,
    cursorBackground: theme.background,
    selection: theme.selection,
    scrollbar: theme.scrollbar,
    scrollbarHover: theme.scrollbarHover,
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize,
    fontWeight: theme.fontWeight,
    lineHeight: theme.lineHeight,
    letterSpacingEm: theme.letterSpacingEm,
    ligatures: theme.ligatures,
    featureSettings: theme.featureSettings,
    variableAxes: theme.variableAxes,
    palette: theme.palette as unknown as TerminalPalette,
  };
}

export function buildGhosttyThemeConfig(theme: TerminalTheme): string {
  const lines = [
    `background = ${theme.background}`,
    `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursorForeground}`,
    `cursor-text = ${theme.cursorBackground}`,
  ];
  if (theme.selection !== undefined) lines.push(`selection-background = ${theme.selection}`);
  lines.push(
    ...buildGhosttyTypographyConfig({
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      ligatures: theme.ligatures,
      featureSettings: theme.featureSettings,
      variableAxes: theme.variableAxes,
    }),
  );
  for (const [index, color] of theme.palette.entries()) {
    lines.push(`palette = ${index}=${color}`);
  }

  return `${lines.join("\n")}\n`;
}
