import * as Schema from "effect/Schema";

import { THEME_COLOR_ROLES } from "../themePalettes.ts";

export const APPEARANCE_MANIFEST_VERSION = 2 as const;
export const APPEARANCE_SCHEMA_ID = "t3.appearance/v2" as const;

const NonEmptyString = Schema.String.check(Schema.isPattern(/\S/u));
const ShortString = NonEmptyString.check(Schema.isMaxLength(128));
const SafeCssTokenValue = NonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(
    /^(?![\s\S]*(?:[{};'"\\@!]|\/\*|(?:url|image|image-set|cross-fade)\s*\())[\s\S]+$/iu,
  ),
);
export const AppearanceColorValueSchema = SafeCssTokenValue.check(
  Schema.isPattern(
    /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\([a-z0-9#%.,+\-*/\s()]+\))$/iu,
  ),
);
const CssValue = SafeCssTokenValue;
const FiniteNumber = Schema.Number.check(Schema.isFinite());
const PositiveLength = FiniteNumber.check(Schema.isBetween({ minimum: 0, maximum: 4096 }));
const DurationMs = FiniteNumber.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }));
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const AppearanceIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]{0,63})(?![\s\S])/u),
);
export const AppearanceVariantIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,47})(?![\s\S])/u),
);
export const AppearanceCollectionIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,127}(?![\s\S])/u),
);
export const AppearanceVersionSchema = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(
    /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-(?:(?:0|[1-9]\d{0,8})|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d{0,8})|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?![\s\S])/u,
  ),
);
export const AppearancePlatformSchema = Schema.Literals([
  "web",
  "desktop-macos",
  "desktop-windows",
  "desktop-linux",
  "ios",
  "android",
]);
export type AppearancePlatform = typeof AppearancePlatformSchema.Type;

export const AppearanceCapabilitySchema = Schema.Literals([
  "colors",
  "typography",
  "layout-metrics",
  "motion",
  "terminal",
  "syntax",
  "diff",
  "images",
  "fonts",
  "shared-css",
  "desktop-css",
]);
export type AppearanceCapability = typeof AppearanceCapabilitySchema.Type;

export const AppearancePackageMetadataSchema = Schema.Struct({
  id: AppearanceIdSchema,
  name: ShortString,
  version: AppearanceVersionSchema,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  author: Schema.optionalKey(ShortString),
  license: Schema.optionalKey(ShortString),
  homepage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type AppearancePackageMetadata = typeof AppearancePackageMetadataSchema.Type;

export const AppearanceCompatibilitySchema = Schema.Struct({
  minimumAppVersion: Schema.optionalKey(AppearanceVersionSchema),
  maximumAppVersion: Schema.optionalKey(AppearanceVersionSchema),
  platforms: Schema.Array(AppearancePlatformSchema),
  requiredCapabilities: Schema.Array(AppearanceCapabilitySchema),
});
export type AppearanceCompatibility = typeof AppearanceCompatibilitySchema.Type;

export const AppearanceTrustSchema = Schema.Struct({
  class: Schema.Literals([
    "builtin",
    "local-package",
    "local-snippet",
    "environment-palette",
    "community-reviewed",
  ]),
  allowSharedCss: Schema.Boolean,
  allowDesktopCss: Schema.Boolean,
  allowAdvancedSnippet: Schema.Boolean,
});
export type AppearanceTrust = typeof AppearanceTrustSchema.Type;

export const DEFAULT_APPEARANCE_TRUST: AppearanceTrust = {
  class: "local-package",
  allowSharedCss: false,
  allowDesktopCss: false,
  allowAdvancedSnippet: false,
};

export const ThemeColorRoleSchema = Schema.Literals(THEME_COLOR_ROLES);
export const AppearanceColorsSchema = Schema.Record(ThemeColorRoleSchema, CssValue);
export type AppearanceColors = typeof AppearanceColorsSchema.Type;

export const APPEARANCE_TYPOGRAPHY_ROLES = [
  "interface",
  "composer",
  "code",
  "terminal",
  "markdown",
  "label",
  "heading",
] as const;
export const AppearanceTypographyRoleSchema = Schema.Literals(APPEARANCE_TYPOGRAPHY_ROLES);
export type AppearanceTypographyRole = typeof AppearanceTypographyRoleSchema.Type;
const fontFeatureTagName = /^[A-Za-z0-9]{4}(?![\s\S])/u;
export const FontFeatureSettingsSchema = Schema.Record(
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
).check(
  Schema.makeFilter(
    (features) =>
      Object.keys(features).every((feature) => fontFeatureTagName.test(feature)) ||
      "Font feature tags must contain exactly four ASCII letters or digits.",
  ),
);
const fontVariableAxisName = /^[ -~]{4}(?![\s\S])/u;
export const FontVariableAxisSchema = Schema.Record(
  Schema.String,
  FiniteNumber.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
).check(
  Schema.makeFilter(
    (axes) =>
      Object.keys(axes).every((axis) => fontVariableAxisName.test(axis)) ||
      "Variable font axis names must contain exactly four printable ASCII characters.",
  ),
);
export const TypographyValueSchema = Schema.Struct({
  families: Schema.Array(ShortString).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  sizePx: FiniteNumber.check(Schema.isBetween({ minimum: 8, maximum: 96 })),
  weight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  lineHeight: FiniteNumber.check(Schema.isBetween({ minimum: 0.8, maximum: 3 })),
  letterSpacingEm: FiniteNumber.check(Schema.isBetween({ minimum: -0.25, maximum: 1 })),
  ligatures: Schema.Boolean,
  featureSettings: Schema.optionalKey(FontFeatureSettingsSchema),
  variableAxes: FontVariableAxisSchema,
});
export type TypographyValue = typeof TypographyValueSchema.Type;

export const AppearanceTypographySchema = Schema.Struct({
  interface: TypographyValueSchema,
  composer: TypographyValueSchema,
  code: TypographyValueSchema,
  terminal: TypographyValueSchema,
  markdown: TypographyValueSchema,
  label: TypographyValueSchema,
  heading: TypographyValueSchema,
});
export type AppearanceTypography = typeof AppearanceTypographySchema.Type;

const SpacingScaleSchema = Schema.Struct({
  xs: PositiveLength,
  sm: PositiveLength,
  md: PositiveLength,
  lg: PositiveLength,
  xl: PositiveLength,
});
const RadiusScaleSchema = Schema.Struct({
  none: PositiveLength,
  sm: PositiveLength,
  md: PositiveLength,
  lg: PositiveLength,
  full: PositiveLength,
});
const BorderScaleSchema = Schema.Struct({
  thin: PositiveLength,
  regular: PositiveLength,
  thick: PositiveLength,
  style: Schema.Literals(["solid", "dashed", "dotted", "double"]),
});
const OutlineSchema = Schema.Struct({
  width: PositiveLength,
  offset: PositiveLength,
  style: Schema.Literals(["solid", "dashed", "dotted", "double"]),
});
const ShadowScaleSchema = Schema.Struct({
  none: CssValue,
  low: CssValue,
  medium: CssValue,
  high: CssValue,
});
const ElevationScaleSchema = Schema.Struct({
  none: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  low: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  medium: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  high: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
});
const SizingRangeSchema = Schema.Struct({
  minimumPx: PositiveLength,
  preferredPx: PositiveLength,
  maximumPx: PositiveLength,
});
export const AppearanceMetricsSchema = Schema.Struct({
  density: Schema.Literals(["compact", "comfortable", "spacious"]),
  spacing: SpacingScaleSchema,
  radius: RadiusScaleSchema,
  border: BorderScaleSchema,
  outline: Schema.optionalKey(OutlineSchema),
  elevation: Schema.optionalKey(ElevationScaleSchema),
  shadow: ShadowScaleSchema,
  sizing: Schema.Struct({
    sidebar: SizingRangeSchema,
    composer: SizingRangeSchema,
    terminal: SizingRangeSchema,
    tab: SizingRangeSchema,
    panel: SizingRangeSchema,
  }),
  layout: Schema.Struct({
    contentMaxWidthPx: PositiveLength,
    contentGutterPx: PositiveLength,
    panelGapPx: PositiveLength,
    sidebarPosition: Schema.Literals(["left", "right"]),
  }),
});
export type AppearanceMetrics = typeof AppearanceMetricsSchema.Type;

const TransitionSchema = Schema.Struct({
  duration: Schema.Literals(["instant", "fast", "normal", "slow"]),
  easing: Schema.Literals(["linear", "standard", "enter", "exit"]),
  properties: Schema.Array(ShortString).check(Schema.isMaxLength(32)),
});
export const AppearanceMotionSchema = Schema.Struct({
  durationsMs: Schema.Struct({
    instant: DurationMs,
    fast: DurationMs,
    normal: DurationMs,
    slow: DurationMs,
  }),
  easing: Schema.Struct({
    linear: CssValue,
    standard: CssValue,
    enter: CssValue,
    exit: CssValue,
  }),
  transitions: Schema.Struct({
    color: TransitionSchema,
    surface: TransitionSchema,
    layout: TransitionSchema,
    opacity: TransitionSchema,
  }),
  animationsEnabled: Schema.Boolean,
  reducedMotion: Schema.Literals(["respect-system", "always-reduce"]),
});
export type AppearanceMotion = typeof AppearanceMotionSchema.Type;

export const APPEARANCE_ANSI_ROLES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export const AppearanceAnsiSchema = Schema.Struct({
  black: CssValue,
  red: CssValue,
  green: CssValue,
  yellow: CssValue,
  blue: CssValue,
  magenta: CssValue,
  cyan: CssValue,
  white: CssValue,
  brightBlack: CssValue,
  brightRed: CssValue,
  brightGreen: CssValue,
  brightYellow: CssValue,
  brightBlue: CssValue,
  brightMagenta: CssValue,
  brightCyan: CssValue,
  brightWhite: CssValue,
});
export type AppearanceAnsi = typeof AppearanceAnsiSchema.Type;

export const AppearanceTerminalSchema = Schema.Struct({
  background: CssValue,
  foreground: CssValue,
  cursor: CssValue,
  selection: CssValue,
  scrollbar: CssValue,
  scrollbarHover: CssValue,
  ansi: AppearanceAnsiSchema,
});
export type AppearanceTerminal = typeof AppearanceTerminalSchema.Type;

export const AppearanceSyntaxTokenSchema = Schema.Struct({
  scopes: Schema.Array(ShortString).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  foreground: CssValue,
  background: Schema.optionalKey(CssValue),
  fontStyle: Schema.Array(Schema.Literals(["bold", "italic", "underline", "strikethrough"])),
});
export const AppearanceSyntaxSchema = Schema.Struct({
  tokens: Schema.Array(AppearanceSyntaxTokenSchema).check(Schema.isMaxLength(4096)),
});
export type AppearanceSyntax = typeof AppearanceSyntaxSchema.Type;

export const AppearanceDiffSchema = Schema.Struct({
  background: CssValue,
  foreground: CssValue,
  additionBackground: CssValue,
  additionForeground: CssValue,
  deletionBackground: CssValue,
  deletionForeground: CssValue,
  modificationBackground: CssValue,
  modificationForeground: CssValue,
  gutterBackground: CssValue,
  gutterForeground: CssValue,
  lineNumberForeground: CssValue,
  hunkBackground: CssValue,
  hunkForeground: CssValue,
  selectionBackground: CssValue,
  commentBackground: CssValue,
  headerBackground: CssValue,
  headerForeground: CssValue,
});
export type AppearanceDiff = typeof AppearanceDiffSchema.Type;

export const AppearancePackagePathSchema = Schema.String.check(
  Schema.isMaxLength(240),
  Schema.isPattern(
    /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?![\s\S])/u,
  ),
);
export const AppearanceSha256Schema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}(?![\s\S])/u),
);
export const AppearanceAssetSchema = Schema.Struct({
  id: AppearanceIdSchema,
  kind: Schema.Literals(["image", "font"]),
  path: AppearancePackagePathSchema,
  sha256: AppearanceSha256Schema,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/avif", "font/woff2"]),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 * 1024 * 1024 })),
  platforms: Schema.Array(AppearancePlatformSchema).check(Schema.isMinLength(1)),
  family: Schema.optionalKey(ShortString),
  style: Schema.optionalKey(Schema.Literals(["normal", "italic", "oblique"])),
  weight: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
}).check(
  Schema.makeFilter(
    (asset) =>
      (asset.kind === "font"
        ? asset.mimeType === "font/woff2" && asset.family !== undefined
        : asset.mimeType.startsWith("image/") &&
          asset.family === undefined &&
          asset.style === undefined &&
          asset.weight === undefined) ||
      "Font assets require font/woff2 and a family; image assets require an image MIME type.",
  ),
);
export type AppearanceAsset = typeof AppearanceAssetSchema.Type;
const AppearanceCssPathSchema = AppearancePackagePathSchema.check(
  Schema.isPattern(/\.css(?![\s\S])/iu),
);
export const AppearanceStyleEntrypointSchema = Schema.Struct({
  path: AppearanceCssPathSchema,
  sha256: AppearanceSha256Schema,
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 })),
});
export const AppearanceStylesSchema = Schema.Struct({
  web: Schema.optionalKey(AppearanceStyleEntrypointSchema),
  desktop: Schema.optionalKey(AppearanceStyleEntrypointSchema),
});
export type AppearanceStyles = typeof AppearanceStylesSchema.Type;

export const AppearanceFallbackSchema = Schema.Struct({
  light: Schema.Literals(["default-variant", "reject"]),
  dark: Schema.Literals(["default-variant", "reject"]),
});
export type AppearanceFallback = typeof AppearanceFallbackSchema.Type;

export const AppearancePresentationSchema = Schema.Struct({
  sidebarArtwork: Schema.Boolean,
  managed: Schema.Boolean,
  collection: Schema.optionalKey(
    Schema.Struct({
      id: AppearanceCollectionIdSchema,
      label: ShortString,
    }),
  ),
});
export type AppearancePresentation = typeof AppearancePresentationSchema.Type;
export const DEFAULT_APPEARANCE_PRESENTATION: AppearancePresentation = {
  sidebarArtwork: false,
  managed: false,
};

export const AppearanceArtworkSchema = Schema.Struct({
  background: Schema.optionalKey(AppearanceIdSchema),
  sidebar: Schema.optionalKey(AppearanceIdSchema),
  icon: Schema.optionalKey(AppearanceIdSchema),
  cursor: Schema.optionalKey(AppearanceIdSchema),
  selection: Schema.optionalKey(AppearanceColorValueSchema),
  scrollbar: Schema.optionalKey(AppearanceColorValueSchema),
  scrollbarHover: Schema.optionalKey(AppearanceColorValueSchema),
});
export type AppearanceArtwork = typeof AppearanceArtworkSchema.Type;
export const DEFAULT_APPEARANCE_ARTWORK: AppearanceArtwork = {};

export const AppearanceVariantManifestSchema = Schema.Struct({
  id: AppearanceVariantIdSchema,
  label: ShortString,
  appearance: Schema.Literals(["light", "dark"]),
  colors: AppearanceColorsSchema,
  typography: Schema.optionalKey(AppearanceTypographySchema),
  metrics: Schema.optionalKey(AppearanceMetricsSchema),
  motion: Schema.optionalKey(AppearanceMotionSchema),
  artwork: Schema.optionalKey(AppearanceArtworkSchema),
  terminal: Schema.optionalKey(AppearanceTerminalSchema),
  syntax: Schema.optionalKey(AppearanceSyntaxSchema),
  diff: Schema.optionalKey(AppearanceDiffSchema),
});
export type AppearanceVariantManifest = typeof AppearanceVariantManifestSchema.Type;

export const AppearanceManifestV2Schema = Schema.Struct({
  schema: Schema.Literal(APPEARANCE_SCHEMA_ID),
  version: Schema.Literal(APPEARANCE_MANIFEST_VERSION),
  metadata: AppearancePackageMetadataSchema,
  compatibility: AppearanceCompatibilitySchema,
  capabilities: Schema.Array(AppearanceCapabilitySchema),
  fallback: AppearanceFallbackSchema,
  defaultVariant: AppearanceVariantIdSchema,
  variants: Schema.Array(AppearanceVariantManifestSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  assets: Schema.Array(AppearanceAssetSchema).check(Schema.isMaxLength(256)),
  styles: Schema.optionalKey(AppearanceStylesSchema),
  presentation: Schema.optionalKey(AppearancePresentationSchema),
});
export type AppearanceManifestV2 = typeof AppearanceManifestV2Schema.Type;

export const AppearanceMigrationSchema = Schema.Struct({
  sourceVersion: Schema.Literals([1, 2]),
  targetVersion: Schema.Literal(2),
  migrated: Schema.Boolean,
  notes: Schema.Array(ShortString),
});
export type AppearanceMigration = typeof AppearanceMigrationSchema.Type;

export const AppearanceDiagnosticCodeSchema = Schema.Literals([
  "invalid-manifest",
  "unsupported-version",
  "duplicate-variant",
  "missing-default-variant",
  "duplicate-asset",
  "incompatible-app-version",
  "unsupported-platform",
  "unsupported-capability",
  "invalid-version-1-theme",
  "font-load-failed",
  "font-load-timeout",
  "asset-load-failed",
  "startup-failure",
]);
export type AppearanceDiagnosticCode = typeof AppearanceDiagnosticCodeSchema.Type;
const DiagnosticText = NonEmptyString.check(Schema.isMaxLength(500));
export const AppearanceDiagnosticSchema = Schema.Struct({
  code: AppearanceDiagnosticCodeSchema,
  severity: Schema.Literals(["error", "warning"]),
  message: DiagnosticText,
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  recovery: DiagnosticText,
  file: Schema.optionalKey(ShortString),
  line: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000_000 }))),
  column: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000_000 })),
  ),
});
export type AppearanceDiagnostic = typeof AppearanceDiagnosticSchema.Type;
export const NormalizedAppearanceVariantSchema = Schema.Struct({
  id: AppearanceVariantIdSchema,
  label: ShortString,
  appearance: Schema.Literals(["light", "dark"]),
  colors: AppearanceColorsSchema,
  typography: AppearanceTypographySchema,
  metrics: AppearanceMetricsSchema,
  motion: AppearanceMotionSchema,
  artwork: AppearanceArtworkSchema,
  terminal: AppearanceTerminalSchema,
  syntax: AppearanceSyntaxSchema,
  diff: AppearanceDiffSchema,
});
export type NormalizedAppearanceVariant = typeof NormalizedAppearanceVariantSchema.Type;

export const NormalizedAppearanceProfileSchema = Schema.Struct({
  schema: Schema.Literal(APPEARANCE_SCHEMA_ID),
  metadata: AppearancePackageMetadataSchema,
  compatibility: AppearanceCompatibilitySchema,
  requestedCapabilities: Schema.Array(AppearanceCapabilitySchema),
  capabilities: Schema.Array(AppearanceCapabilitySchema),
  trust: AppearanceTrustSchema,
  fallback: AppearanceFallbackSchema,
  defaultVariant: AppearanceVariantIdSchema,
  variants: Schema.Array(NormalizedAppearanceVariantSchema),
  assets: Schema.Array(AppearanceAssetSchema),
  styles: AppearanceStylesSchema,
  presentation: AppearancePresentationSchema,
  migration: AppearanceMigrationSchema,
});
export type NormalizedAppearanceProfile = typeof NormalizedAppearanceProfileSchema.Type;

export type AppearanceNormalizationResult =
  | Readonly<{ status: "success"; profile: NormalizedAppearanceProfile }>
  | Readonly<{ status: "failure"; diagnostic: AppearanceDiagnostic }>;

export const DEFAULT_APPEARANCE_TYPOGRAPHY: AppearanceTypography = {
  interface: {
    families: ["system-ui"],
    sizePx: 16,
    weight: 400,
    lineHeight: 1.5,
    letterSpacingEm: 0,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
  composer: {
    families: ["system-ui"],
    sizePx: 14,
    weight: 400,
    lineHeight: 1.5,
    letterSpacingEm: 0,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
  code: {
    families: ["ui-monospace"],
    sizePx: 13,
    weight: 400,
    lineHeight: 1.5,
    letterSpacingEm: 0,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
  terminal: {
    families: ["ui-monospace"],
    sizePx: 12,
    weight: 400,
    lineHeight: 1.4,
    letterSpacingEm: 0,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
  markdown: {
    families: ["Inter"],
    sizePx: 16,
    weight: 400,
    lineHeight: 1.6,
    letterSpacingEm: 0,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
  label: {
    families: ["system-ui"],
    sizePx: 12,
    weight: 500,
    lineHeight: 1.3,
    letterSpacingEm: 0,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
  heading: {
    families: ["system-ui"],
    sizePx: 20,
    weight: 600,
    lineHeight: 1.25,
    letterSpacingEm: -0.01,
    ligatures: true,
    featureSettings: {},
    variableAxes: {},
  },
};

export const DEFAULT_APPEARANCE_METRICS: AppearanceMetrics = {
  density: "comfortable",
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { none: 0, sm: 4, md: 8, lg: 12, full: 999 },
  border: { thin: 1, regular: 1, thick: 2, style: "solid" },
  outline: { width: 2, offset: 2, style: "solid" },
  elevation: { none: 0, low: 1, medium: 2, high: 3 },
  shadow: {
    none: "none",
    low: "0 1px 2px rgb(0 0 0 / 0.08)",
    medium: "0 4px 12px rgb(0 0 0 / 0.12)",
    high: "0 12px 32px rgb(0 0 0 / 0.18)",
  },
  sizing: {
    sidebar: { minimumPx: 192, preferredPx: 256, maximumPx: 480 },
    composer: { minimumPx: 240, preferredPx: 720, maximumPx: 1200 },
    terminal: { minimumPx: 120, preferredPx: 320, maximumPx: 1200 },
    tab: { minimumPx: 32, preferredPx: 40, maximumPx: 64 },
    panel: { minimumPx: 240, preferredPx: 480, maximumPx: 1600 },
  },
  layout: { contentMaxWidthPx: 1200, contentGutterPx: 24, panelGapPx: 8, sidebarPosition: "left" },
};

export const DEFAULT_APPEARANCE_MOTION: AppearanceMotion = {
  durationsMs: { instant: 0, fast: 100, normal: 200, slow: 350 },
  easing: {
    linear: "linear",
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    enter: "cubic-bezier(0, 0, 0.2, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
  },
  transitions: {
    color: {
      duration: "fast",
      easing: "standard",
      properties: ["color", "background-color", "border-color"],
    },
    surface: {
      duration: "normal",
      easing: "standard",
      properties: ["box-shadow", "background-color"],
    },
    layout: {
      duration: "normal",
      easing: "standard",
      properties: ["transform", "width", "height"],
    },
    opacity: { duration: "fast", easing: "linear", properties: ["opacity"] },
  },
  animationsEnabled: true,
  reducedMotion: "respect-system",
};

export const DEFAULT_APPEARANCE_ANSI: AppearanceAnsi = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

export function defaultTerminal(colors: AppearanceColors): AppearanceTerminal {
  return {
    background: colors.terminalBackground,
    foreground: colors.terminalForeground,
    cursor: colors.terminalCursor,
    selection: colors.terminalSelection,
    scrollbar: colors.terminalScrollbar,
    scrollbarHover: colors.terminalScrollbarHover,
    ansi: DEFAULT_APPEARANCE_ANSI,
  };
}

export function defaultDiff(colors: AppearanceColors): AppearanceDiff {
  return {
    background: colors.canvas,
    foreground: colors.text,
    additionBackground: colors.accentSurface,
    additionForeground: colors.accentSurfaceForeground,
    deletionBackground: colors.errorSurface,
    deletionForeground: colors.errorForeground,
    modificationBackground: colors.warningSurface,
    modificationForeground: colors.warningForeground,
    gutterBackground: colors.chrome,
    gutterForeground: colors.textMuted,
    lineNumberForeground: colors.mutedForeground,
    hunkBackground: colors.secondary,
    hunkForeground: colors.secondaryForeground,
    selectionBackground: colors.terminalSelection,
    commentBackground: colors.messageSurface,
    headerBackground: colors.toolbar,
    headerForeground: colors.toolbarForeground,
  };
}

export const DEFAULT_APPEARANCE_SYNTAX: AppearanceSyntax = { tokens: [] };
export const DEFAULT_APPEARANCE_COMPATIBILITY: AppearanceCompatibility = {
  platforms: ["web", "desktop-macos", "desktop-windows", "desktop-linux", "ios", "android"],
  requiredCapabilities: ["colors"],
};
for (const defaults of [
  DEFAULT_APPEARANCE_TRUST,
  DEFAULT_APPEARANCE_PRESENTATION,
  DEFAULT_APPEARANCE_ARTWORK,
  DEFAULT_APPEARANCE_TYPOGRAPHY,
  DEFAULT_APPEARANCE_METRICS,
  DEFAULT_APPEARANCE_MOTION,
  DEFAULT_APPEARANCE_ANSI,
  DEFAULT_APPEARANCE_SYNTAX,
  DEFAULT_APPEARANCE_COMPATIBILITY,
]) {
  deepFreeze(defaults);
}

export const STRICT_APPEARANCE_PARSE_OPTIONS = {
  errors: "all",
  onExcessProperty: "error",
} as const;
