import {
  AppearanceCssValidationError,
  BrowserAppearanceStorage,
  createAppearanceRuntime,
  createEmptyAppearanceState,
  DesktopBridgeAppearanceStorage,
  rewriteAppearancePackageCss,
  validateAppearanceSnippetCss,
  type AppearanceCompilationInput,
  type AppearanceCompiledOutput,
  type AppearanceCompilerAdapter,
  type AppearancePackageInput,
  type AppearancePersistedState,
  type AppearanceRuntime,
  type AppearanceStorageAdapter,
  type AppearanceStoredPackage,
  type AppearanceTypographyPreference,
} from "@t3tools/client-runtime/appearance";
import {
  APPEARANCE_TYPOGRAPHY_ROLES,
  hashNormalizedAppearanceProfile,
  normalizeAppearance,
  type AppearancePlatform,
  type AppearanceTrust,
  type AppearanceDiagnostic,
  type NormalizedAppearanceVariant,
} from "@t3tools/shared/appearance";
import {
  BUILT_IN_THEMES,
  KM_CODE_THEME,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@t3tools/shared/themePalettes";

import {
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  canonicalThemePreference,
  getCustomThemes,
  getEnvironmentThemes,
  getThemeColorVariable,
  getThemeDefinition,
  parseThemeHalves,
  resolveThemeHalf,
  subscribeToCustomThemes,
} from "./themePalette";
import {
  AppearanceFontLoadCache,
  setAppearanceFontLoadDiagnostics,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  clampCodeFontSize,
  clampInterfaceFontSize,
  clampPromptFontSize,
  cssFontFamilies,
} from "./appearanceFonts";
import { appearanceVariantCss } from "./lib/appearanceAdapters";
import {
  clearNormalizedSyntaxTheme,
  registerNormalizedSyntaxTheme,
} from "./lib/syntaxHighlighting";
import { APP_VERSION } from "./branding";
import { AppearanceAssetRegistry, type AppearanceAssetLease } from "./appearanceAssetRegistry";

const APPEARANCE_STYLE_ID = "t3-appearance-runtime";
const APPEARANCE_LAYER_ATTRIBUTE = "data-t3-appearance-layer";
const APPEARANCE_STARTUP_TIMEOUT_MS = 10_000;
const APPEARANCE_MANAGED_SHEET_PROPERTY = "__t3AppearanceManaged";
const APPEARANCE_ROOT_LAYER_ATTRIBUTE = "data-t3-appearance-root-layer";
type AppearancePerformanceKind = "compile" | "stylesheet-replacement";
declare global {
  interface Window {
    readonly __T3_APPEARANCE_PERFORMANCE__?: {
      readonly begin: (kind: AppearancePerformanceKind) => () => void;
    };
  }
}
function measureAppearanceOperation<T>(kind: AppearancePerformanceKind, operation: () => T): T {
  const sink = typeof window === "undefined" ? undefined : window.__T3_APPEARANCE_PERFORMANCE__;
  const finish = sink?.begin(kind);
  try {
    return operation();
  } finally {
    finish?.();
  }
}
type WebAppearanceLayerId =
  | "order"
  | "theme"
  | "preferences"
  | "snippets"
  | "preview"
  | "accessibility"
  | "advanced";
interface WebAppearanceLayer {
  readonly id: WebAppearanceLayerId;
  readonly css: string;
  readonly declarations: string;
  readonly rawCss: string;
  readonly rawBeforeDeclarations: boolean;
}
const WEB_APPEARANCE_LAYERS = Symbol("webAppearanceLayers");
interface WebAppearanceCompiledOutput extends AppearanceCompiledOutput {
  readonly [WEB_APPEARANCE_LAYERS]: ReadonlyArray<WebAppearanceLayer>;
}
function isWebAppearanceCompiledOutput(
  value: AppearanceCompiledOutput,
): value is WebAppearanceCompiledOutput {
  return WEB_APPEARANCE_LAYERS in value;
}
const LEGACY_THEME_STORAGE_KEY = "t3code:theme";
const appearanceFontLoads = new AppearanceFontLoadCache();
const appearanceAssets = new AppearanceAssetRegistry();
let suppressPendingStartupApply = false;
let appearanceFontLoadGeneration = 0;
const COLOR_ROLE_SET = new Set<string>(THEME_COLOR_ROLES);

const BUILTIN_TRUST: AppearanceTrust = {
  class: "builtin",
  allowSharedCss: false,
  allowDesktopCss: false,
  allowAdvancedSnippet: false,
};
const LOCAL_THEME_TRUST: AppearanceTrust = {
  class: "local-package",
  allowSharedCss: false,
  allowDesktopCss: false,
  allowAdvancedSnippet: false,
};
const ENVIRONMENT_TRUST: AppearanceTrust = {
  class: "environment-palette",
  allowSharedCss: false,
  allowDesktopCss: false,
  allowAdvancedSnippet: false,
};

function selectedPackage(input: AppearanceCompilationInput): AppearanceStoredPackage | undefined {
  const id = input.resolved.basePackageId;
  if (id === null) return undefined;
  return (
    input.state.packages[id] ??
    input.state.environmentPackages.find((candidate) => candidate.profile.metadata.id === id)
  );
}

function previewPackage(input: AppearanceCompilationInput): AppearanceStoredPackage | undefined {
  if (input.state.safeMode || input.resolved.previewVariant === null) return undefined;
  const fromPreview = input.state.preview?.package;
  if (fromPreview !== undefined) return fromPreview;
  const id = input.state.preview?.packageId;
  if (id === undefined) return undefined;
  return (
    input.state.packages[id] ??
    input.state.environmentPackages.find((candidate) => candidate.profile.metadata.id === id)
  );
}

function cssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\n\r\f]/gu, " ")}"`;
}

function colorDeclarations(values: Readonly<Record<string, string>> | undefined): string {
  if (values === undefined) return "";
  const declarations: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const variable = COLOR_ROLE_SET.has(key)
      ? getThemeColorVariable(key as (typeof THEME_COLOR_ROLES)[number])
      : /^--[a-z][a-z0-9-]{0,126}$/u.test(key)
        ? key
        : /^[a-z][A-Za-z0-9]{0,63}$/u.test(key)
          ? `--t3-${key.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)}`
          : null;
    if (variable !== null) declarations.push(`${variable}:${value};`);
  }
  return declarations.length === 0 ? "" : `:root{${declarations.join("")}}`;
}

function typographyDeclarations(variant: NormalizedAppearanceVariant | undefined): string {
  if (variant === undefined) return "";
  const familyVariables: Readonly<Record<string, string>> = {
    interface: "--font-interface",
    composer: "--font-composer",
    code: "--font-code",
    terminal: "--font-terminal",
    markdown: "--font-markdown",
    label: "--font-label",
    heading: "--font-heading",
  };
  const declarations: string[] = [];
  for (const role of APPEARANCE_TYPOGRAPHY_ROLES) {
    const typography = variant.typography[role];
    const fallback =
      role === "code" || role === "terminal" ? DEFAULT_CODE_FONT_STACK : DEFAULT_SANS_FONT_STACK;
    const families = [...typography.families.map(cssString), fallback].join(",");
    const featureSettings = Object.entries(typography.featureSettings ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([tag, value]) => `${cssString(tag)} ${value}`)
      .join(",");
    const variableAxes = Object.entries(typography.variableAxes)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([axis, value]) => `${cssString(axis)} ${value}`)
      .join(",");
    declarations.push(`${familyVariables[role]}:${families};`);
    declarations.push(`--font-${role}:${families};`);
    declarations.push(`--font-size-${role}:${typography.sizePx}px;`);
    declarations.push(`--font-weight-${role}:${typography.weight};`);
    declarations.push(`--line-height-${role}:${typography.lineHeight};`);
    declarations.push(`--letter-spacing-${role}:${typography.letterSpacingEm}em;`);
    declarations.push(
      `--font-variant-ligatures-${role}:${typography.ligatures ? "normal" : "none"};`,
    );
    declarations.push(`--font-feature-settings-${role}:${featureSettings || "normal"};`);
    declarations.push(`--font-variation-settings-${role}:${variableAxes || "normal"};`);
  }
  declarations.push(`--font-sans:var(--font-interface);`);
  declarations.push(`--font-mono:var(--font-code);`);
  declarations.push(`--font-size-prompt:${variant.typography.composer.sizePx}px;`);
  return `:root{${declarations.join("")}}`;
}

function metricsDeclarations(variant: NormalizedAppearanceVariant | undefined): string {
  if (variant === undefined) return "";
  const metrics = variant.metrics;
  const densityScale = { compact: "0.875", comfortable: "1", spacious: "1.125" }[metrics.density];
  const declarations: string[] = [
    `--t3-density:${metrics.density};`,
    `--t3-density-scale:${densityScale};`,
  ];
  for (const [name, value] of Object.entries(metrics.spacing))
    declarations.push(`--t3-space-${name}:${value}px;`);
  for (const [name, value] of Object.entries(metrics.radius))
    declarations.push(`--t3-radius-${name}:${value}px;`);
  for (const [name, value] of Object.entries(metrics.border)) {
    if (name === "style") declarations.push(`--t3-border-style:${value};`);
    else declarations.push(`--t3-border-${name}:${value}px;`);
  }
  const outline = metrics.outline ?? { width: 2, offset: 2, style: "solid" as const };
  declarations.push(`--t3-outline-width:${outline.width}px;`);
  declarations.push(`--t3-outline-offset:${outline.offset}px;`);
  declarations.push(`--t3-outline-style:${outline.style};`);
  const elevation = metrics.elevation ?? { none: 0, low: 1, medium: 2, high: 3 };
  for (const [name, value] of Object.entries(elevation))
    declarations.push(`--t3-elevation-${name}:${value};`);
  for (const [name, value] of Object.entries(metrics.shadow))
    declarations.push(`--t3-shadow-${name}:${value};`);
  for (const [role, range] of Object.entries(metrics.sizing)) {
    declarations.push(`--t3-size-${role}-min:${range.minimumPx}px;`);
    declarations.push(`--t3-size-${role}:${range.preferredPx}px;`);
    declarations.push(`--t3-size-${role}-max:${range.maximumPx}px;`);
  }
  declarations.push(`--t3-content-max-width:${metrics.layout.contentMaxWidthPx}px;`);
  declarations.push(`--t3-content-gutter:${metrics.layout.contentGutterPx}px;`);
  declarations.push(`--t3-panel-gap:${metrics.layout.panelGapPx}px;`);
  declarations.push(`--t3-sidebar-position:${metrics.layout.sidebarPosition};`);
  return `:root{${declarations.join("")}}`;
}

function motionDeclarations(variant: NormalizedAppearanceVariant | undefined): string {
  if (variant === undefined) return "";
  const motion = variant.motion;
  const declarations: string[] = [];
  for (const [name, value] of Object.entries(motion.durationsMs))
    declarations.push(`--t3-motion-duration-${name}:${value}ms;`);
  for (const [name, value] of Object.entries(motion.easing))
    declarations.push(`--t3-motion-easing-${name}:${value};`);
  for (const [name, transition] of Object.entries(motion.transitions)) {
    const properties = transition.properties.filter((property) =>
      /^[a-z][a-z-]{0,63}$/u.test(property),
    );
    const duration = motion.durationsMs[transition.duration];
    const easing = motion.easing[transition.easing];
    declarations.push(`--t3-transition-${name}:${properties.join(",")} ${duration}ms ${easing};`);
  }
  declarations.push(`--t3-motion-enabled:${motion.animationsEnabled ? "1" : "0"};`);
  declarations.push(`--t3-reduced-motion:${motion.reducedMotion};`);
  return `:root{${declarations.join("")}}`;
}

function artworkDeclarations(
  variant: NormalizedAppearanceVariant | undefined,
  packageValue: AppearanceStoredPackage | undefined,
  resolveAsset: (path: string) => string | null,
): string {
  if (variant === undefined) return "";
  const assetById = new Map(packageValue?.profile.assets.map((asset) => [asset.id, asset]) ?? []);
  const storedByPath = new Set(packageValue?.assets.map((asset) => asset.path) ?? []);
  const assetUrl = (id: string | undefined): string | null => {
    if (id === undefined) return null;
    const declaration = assetById.get(id);
    if (declaration?.kind !== "image" || !storedByPath.has(declaration.path)) return null;
    const url = resolveAsset(declaration.path);
    return url === null ? null : `url(${cssString(url)})`;
  };
  const artwork = variant.artwork;
  const declarations: string[] = [
    "--t3-artwork-background-image:var(--surface-grain);",
    "--t3-artwork-sidebar-artwork:none;",
    "--t3-artwork-icon:none;",
    "--t3-artwork-cursor:auto;",
  ];
  const images: ReadonlyArray<readonly [string, string | undefined]> = [
    ["background-image", artwork.background],
    ["sidebar-artwork", artwork.sidebar],
    ["icon", artwork.icon],
    ["cursor", artwork.cursor],
  ];
  for (const [name, id] of images) {
    const url = assetUrl(id);
    if (url !== null) {
      const value = name === "cursor" ? `${url},auto` : url;
      declarations.push(`--t3-artwork-${name}:${value};`);
    }
  }
  if (artwork.selection !== undefined) declarations.push(`--t3-selection:${artwork.selection};`);
  if (artwork.scrollbar !== undefined) declarations.push(`--t3-scrollbar:${artwork.scrollbar};`);
  if (artwork.scrollbarHover !== undefined)
    declarations.push(`--t3-scrollbar-hover:${artwork.scrollbarHover};`);
  return `:root{${declarations.join("")}}`;
}
function typographyPreferenceDeclarations(
  preference: AppearanceTypographyPreference | undefined,
): string {
  if (preference === undefined) return "";
  const declarations: string[] = [
    `font-size:${clampInterfaceFontSize(preference.sizeInterface)}px;`,
    `--font-size-prompt:${clampPromptFontSize(preference.sizePrompt)}px;`,
    `--font-size-code:${clampCodeFontSize(preference.sizeCode)}px;`,
    `--diffs-font-size:${clampCodeFontSize(preference.sizeCode)}px;`,
    `--font-size-terminal:${clampCodeFontSize(preference.sizeTerminal)}px;`,
    `-webkit-font-smoothing:${preference.smoothing ? "antialiased" : "auto"};`,
  ];
  const families: ReadonlyArray<readonly [string, string, string]> = [
    ["--font-sans", preference.sans, DEFAULT_SANS_FONT_STACK],
    ["--font-mono", preference.code, DEFAULT_CODE_FONT_STACK],
    ["--font-composer", preference.composer, "var(--font-sans)"],
    ["--font-terminal", preference.terminal, "var(--font-mono)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list !== null) declarations.push(`${variable}:${list}, ${fallback};`);
  }
  return `:root{${declarations.join("")}}`;
}

function fontFaces(
  packageValue: AppearanceStoredPackage | undefined,
  resolveAsset: (path: string) => string | null,
  diagnostics?: AppearanceDiagnostic[],
): string {
  if (packageValue === undefined) return "";
  const declarations = new Map(packageValue.profile.assets.map((asset) => [asset.id, asset]));
  return [...packageValue.assets]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .flatMap((asset) => {
      const declaration = declarations.get(asset.id);
      if (asset.mimeType !== "font/woff2" || declaration?.family === undefined) return [];
      const url = resolveAsset(asset.path);
      if (url === null) {
        diagnostics?.push({
          code: "asset-load-failed",
          severity: "warning",
          message: `Appearance font asset '${asset.id}' could not be loaded.`,
          path: ["assets", asset.id],
          recovery: "Use a valid local WOFF2 asset or disable the appearance package.",
        });
        return [];
      }
      return [
        `@font-face{font-family:${cssString(declaration.family)};src:url(${cssString(url)}) format("woff2");font-style:${declaration.style ?? "normal"};font-weight:${declaration.weight ?? 400};font-display:swap;}`,
      ];
    })
    .join("\n");
}

function reducedMotionCss(variant: NormalizedAppearanceVariant | undefined): string {
  if (variant === undefined) return "";
  const protectedMotion =
    variant.motion.reducedMotion === "always-reduce" || variant.motion.animationsEnabled === false;
  const selector =
    "body, body *, body *::before, body *::after, [data-t3-app], [data-t3-app] *, [data-t3-app] *::before, [data-t3-app] *::after";
  if (protectedMotion) {
    return `${selector}{animation:none !important;transition:none !important;scroll-behavior:auto !important;}`;
  }
  return `@media (prefers-reduced-motion: reduce){${selector}{animation-duration:0s !important;transition-duration:0s !important;scroll-behavior:auto !important;}}`;
}

function cssLayer(name: string, parts: ReadonlyArray<string>): string {
  const content = parts.filter((part) => part.length > 0).join("\n");
  return content.length === 0 ? "" : `@layer ${name}{${content}}`;
}
function rootDeclarationBody(
  id: Exclude<WebAppearanceLayerId, "order">,
  rules: ReadonlyArray<string>,
): string {
  return rules
    .filter((rule) => rule.length > 0)
    .map((rule) => {
      if (!rule.startsWith(":root{") || !rule.endsWith("}")) {
        throw new Error(`Appearance layer '${id}' received a non-root declaration rule.`);
      }
      return rule.slice(6, -1);
    })
    .join("");
}

function declarationValues(declarations: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const declaration of declarations.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    values.set(declaration.slice(0, separator), declaration.slice(separator + 1));
  }
  return values;
}

function differingDeclarations(declarations: string, inherited: string): string {
  if (inherited.length === 0) return declarations;
  const inheritedValues = declarationValues(inherited);
  return [...declarationValues(declarations)]
    .filter(([name, value]) => inheritedValues.get(name) !== value)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
}

function appearanceLayer(
  id: Exclude<WebAppearanceLayerId, "order">,
  rootRules: ReadonlyArray<string>,
  rawRules: ReadonlyArray<string> = [],
  rawBeforeDeclarations = false,
  inheritedRootRules: ReadonlyArray<string> = [],
): WebAppearanceLayer {
  const declarations = differingDeclarations(
    rootDeclarationBody(id, rootRules),
    rootDeclarationBody(id, inheritedRootRules),
  );
  const rawCss = rawRules.filter((rule) => rule.length > 0).join("\n");
  return {
    id,
    declarations,
    rawCss,
    rawBeforeDeclarations,
    css: cssLayer(
      `t3.${id}`,
      rawBeforeDeclarations
        ? [rawCss, declarations.length === 0 ? "" : `:root{${declarations}}`]
        : [declarations.length === 0 ? "" : `:root{${declarations}}`, rawCss],
    ),
  };
}

function appendCssDiagnostics(
  target: AppearanceDiagnostic[],
  error: AppearanceCssValidationError,
): void {
  for (const entry of error.diagnostics) {
    target.push({
      code: "invalid-manifest",
      severity: "error",
      message: entry.message,
      path: entry.file === undefined ? [] : [entry.file],
      recovery: "Correct or disable this stylesheet; other appearance layers remain active.",
      ...(entry.file === undefined ? {} : { file: entry.file }),
      line: entry.line,
      column: entry.column,
    });
  }
}
export function compileWebAppearance(
  input: AppearanceCompilationInput,
  options: { readonly includeDesktopCss?: boolean } = {},
): AppearanceCompiledOutput {
  const packageValue = input.state.safeMode ? undefined : selectedPackage(input);
  const previewValue = input.state.safeMode ? undefined : previewPackage(input);
  const lease = appearanceAssets.acquire(packageValue);
  const previewLease = appearanceAssets.acquire(previewValue);
  try {
    const diagnostics: AppearanceDiagnostic[] = [];
    const compilePackageCss = (
      packageSource: AppearanceStoredPackage | undefined,
      packageLease: AppearanceAssetLease,
      source: string | undefined,
      file: string | undefined,
    ): string => {
      if (source === undefined || packageSource === undefined) return "";
      try {
        const assetPaths = new Set(packageSource.profile.assets.map((asset) => asset.path));
        const diagnosticFile =
          file === undefined
            ? packageSource.profile.metadata.id
            : `${packageSource.profile.metadata.id}/${file}`;
        return rewriteAppearancePackageCss(
          source,
          packageLease.resolve,
          assetPaths,
          diagnosticFile,
        );
      } catch (error) {
        if (!(error instanceof AppearanceCssValidationError)) throw error;
        appendCssDiagnostics(diagnostics, error);
        return "";
      }
    };
    const sharedCss = compilePackageCss(
      packageValue,
      lease,
      packageValue?.sharedCss,
      packageValue?.manifest.styles?.web?.path,
    );
    const desktopCss =
      options.includeDesktopCss === true
        ? compilePackageCss(
            packageValue,
            lease,
            packageValue?.desktopCss,
            packageValue?.manifest.styles?.desktop?.path,
          )
        : "";
    const previewSharedCss = compilePackageCss(
      previewValue,
      previewLease,
      previewValue?.sharedCss,
      previewValue?.manifest.styles?.web?.path,
    );
    const previewDesktopCss =
      options.includeDesktopCss === true
        ? compilePackageCss(
            previewValue,
            previewLease,
            previewValue?.desktopCss,
            previewValue?.manifest.styles?.desktop?.path,
          )
        : "";
    const baseVariant = input.resolved.baseVariant ?? undefined;
    const previewVariant = input.resolved.previewVariant ?? undefined;
    const enabledSnippets =
      input.state.safeMode || input.state.preview?.includeSnippets === false
        ? []
        : input.state.snippets.filter((snippet) => snippet.enabled);
    const validSnippets = enabledSnippets.filter((snippet) => {
      try {
        validateAppearanceSnippetCss(snippet.css, snippet.id);
        return true;
      } catch (error) {
        if (!(error instanceof AppearanceCssValidationError)) throw error;
        appendCssDiagnostics(diagnostics, error);
        return false;
      }
    });
    const ordinary = validSnippets.filter((snippet) => !snippet.advanced);
    const advanced = validSnippets.filter((snippet) => snippet.advanced);
    const baseRootRules = [
      colorDeclarations(baseVariant?.colors),
      baseVariant === undefined ? "" : appearanceVariantCss(baseVariant),
      typographyDeclarations(baseVariant),
      metricsDeclarations(baseVariant),
      motionDeclarations(baseVariant),
      artworkDeclarations(baseVariant, packageValue, lease.resolve),
    ];
    const previewRootRules = input.state.safeMode
      ? []
      : [
          typographyDeclarations(previewVariant),
          previewVariant === undefined ? "" : appearanceVariantCss(previewVariant),
          metricsDeclarations(previewVariant),
          motionDeclarations(previewVariant),
          artworkDeclarations(previewVariant, previewValue, previewLease.resolve),
          colorDeclarations(previewVariant?.colors),
        ];
    const orderCss =
      "@layer t3.reset,t3.base,t3.components,t3.theme,t3.preferences,t3.snippets,t3.preview,t3.accessibility,t3.advanced;";
    const layers: ReadonlyArray<WebAppearanceLayer> = [
      {
        id: "order",
        css: orderCss,
        declarations: "",
        rawCss: orderCss,
        rawBeforeDeclarations: false,
      },
      appearanceLayer(
        "theme",
        baseRootRules,
        input.state.safeMode
          ? []
          : [fontFaces(packageValue, lease.resolve, diagnostics), sharedCss, desktopCss],
      ),
      appearanceLayer(
        "preferences",
        input.state.safeMode
          ? []
          : [
              colorDeclarations(input.state.preference.overrides),
              typographyPreferenceDeclarations(input.state.typographyPreference),
            ],
      ),
      appearanceLayer(
        "snippets",
        [],
        input.state.safeMode ? [] : ordinary.map((snippet) => snippet.css),
      ),
      appearanceLayer(
        "preview",
        previewRootRules,
        input.state.safeMode
          ? []
          : [
              fontFaces(previewValue, previewLease.resolve, diagnostics),
              previewSharedCss,
              previewDesktopCss,
              reducedMotionCss(previewVariant),
            ],
        true,
        baseRootRules,
      ),
      appearanceLayer(
        "accessibility",
        [input.state.safeMode ? "" : colorDeclarations(input.state.accessibility)],
        [reducedMotionCss(baseVariant)],
      ),
      appearanceLayer(
        "advanced",
        [],
        input.state.safeMode ? [] : advanced.map((snippet) => snippet.css),
      ),
    ];
    const output: WebAppearanceCompiledOutput = {
      input,
      artifact: layers
        .map((layer) => layer.css)
        .filter((css) => css.length > 0)
        .join("\n"),
      dispose: () => {
        lease.dispose();
        previewLease.dispose();
      },
      diagnostics,
      [WEB_APPEARANCE_LAYERS]: layers,
    };
    return output;
  } catch (error) {
    lease.dispose();
    previewLease.dispose();
    throw error;
  }
}
function runtimeAppearancePlatform(): AppearancePlatform {
  const platform =
    typeof window === "undefined" ? undefined : window.desktopBridge?.getClientPlatform?.();
  if (platform === "darwin") return "desktop-macos";
  if (platform === "win32") return "desktop-windows";
  if (platform === "linux") return "desktop-linux";
  return "web";
}

const webCompiler: AppearanceCompilerAdapter = {
  normalize: (input, options) =>
    normalizeAppearance(input, {
      ...options,
      appVersion: APP_VERSION,
      platform: runtimeAppearancePlatform(),
    }),
  compile: async (input) =>
    measureAppearanceOperation("compile", () =>
      compileWebAppearance(input, {
        includeDesktopCss: typeof window !== "undefined" && window.desktopBridge !== undefined,
      }),
    ),
};

let appearanceAdoptedSheet: CSSStyleSheet | null = null;
let appearanceAdoptedRawSignature: string | null = null;
let appearanceAdoptedRootLayerIds: ReadonlyArray<WebAppearanceLayerId> = [];

function legacyAppearanceStyles(): ReadonlyArray<HTMLStyleElement> {
  return [
    ...document.querySelectorAll<HTMLStyleElement>(
      `style[${APPEARANCE_LAYER_ATTRIBUTE}], style[${APPEARANCE_ROOT_LAYER_ATTRIBUTE}]`,
    ),
  ];
}

function removeLegacyAppearanceStyles(): void {
  for (const style of legacyAppearanceStyles()) style.remove();
}

function appearanceRawSignature(layers: ReadonlyArray<WebAppearanceLayer>): string {
  return layers
    .slice(1)
    .map(
      (layer) =>
        `${layer.id}\u0000${layer.rawBeforeDeclarations ? "before" : "after"}\u0000${layer.rawCss}`,
    )
    .join("\u0001");
}

function appearanceRootLayerIds(
  layers: ReadonlyArray<WebAppearanceLayer>,
): ReadonlyArray<WebAppearanceLayerId> {
  return layers
    .slice(1)
    .filter((layer) => layer.declarations.length > 0)
    .map((layer) => layer.id);
}

function appearanceRootRules(sheet: CSSStyleSheet): ReadonlyArray<CSSStyleRule> {
  const roots: CSSStyleRule[] = [];
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) {
        visit(rule.cssRules);
      }
      if (rule instanceof CSSStyleRule && rule.selectorText === ":root") roots.push(rule);
    }
  };
  visit(sheet.cssRules);
  return roots;
}

function updateAppearanceRootRules(
  sheet: CSSStyleSheet,
  layers: ReadonlyArray<WebAppearanceLayer>,
): boolean {
  if (layers.slice(1).some((layer) => layer.rawCss.includes(":root"))) return false;
  const nextRootLayerIds = appearanceRootLayerIds(layers);
  if (
    appearanceAdoptedRawSignature === null ||
    appearanceAdoptedRawSignature !== appearanceRawSignature(layers) ||
    nextRootLayerIds.length !== appearanceAdoptedRootLayerIds.length ||
    nextRootLayerIds.some((id, index) => id !== appearanceAdoptedRootLayerIds[index])
  ) {
    return false;
  }
  const roots = appearanceRootRules(sheet);
  if (roots.length !== nextRootLayerIds.length) return false;
  let rootIndex = 0;
  for (const layer of layers.slice(1)) {
    if (layer.declarations.length === 0) continue;
    const root = roots[rootIndex];
    if (root === undefined) return false;
    if (root.style.cssText !== layer.declarations) root.style.cssText = layer.declarations;
    rootIndex += 1;
  }
  return true;
}

function applyConstructableAppearanceSheet(
  css: string,
  layers: ReadonlyArray<WebAppearanceLayer>,
): boolean {
  if (
    typeof CSSStyleSheet === "undefined" ||
    typeof CSSStyleSheet.prototype.replaceSync !== "function" ||
    !("adoptedStyleSheets" in document)
  ) {
    return false;
  }
  if (
    appearanceAdoptedSheet !== null &&
    updateAppearanceRootRules(appearanceAdoptedSheet, layers)
  ) {
    return true;
  }
  const nextSheet = new CSSStyleSheet();
  Object.defineProperty(nextSheet, APPEARANCE_MANAGED_SHEET_PROPERTY, { value: true });
  nextSheet.replaceSync(css);
  const adopted = document.adoptedStyleSheets.filter((sheet) => sheet !== appearanceAdoptedSheet);
  if (css.length > 0) adopted.push(nextSheet);
  document.adoptedStyleSheets = adopted;
  appearanceAdoptedSheet = css.length > 0 ? nextSheet : null;
  appearanceAdoptedRawSignature = css.length > 0 ? appearanceRawSignature(layers) : null;
  appearanceAdoptedRootLayerIds = css.length > 0 ? appearanceRootLayerIds(layers) : [];
  return true;
}

function applyFallbackAppearanceSheet(css: string, nonce: string): void {
  const current = document.querySelector<HTMLStyleElement>("style[data-t3-appearance-atomic]");
  const replacement =
    css.length === 0
      ? null
      : (() => {
          const style = document.createElement("style");
          style.dataset.t3AppearanceAtomic = "true";
          if (nonce.length > 0) style.nonce = nonce;
          style.textContent = css;
          return style;
        })();
  if (replacement === null) current?.remove();
  else if (current === null) document.head.append(replacement);
  else current.replaceWith(replacement);
  if (appearanceAdoptedSheet !== null && "adoptedStyleSheets" in document) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== appearanceAdoptedSheet,
    );
  }
  appearanceAdoptedSheet = null;
  appearanceAdoptedRawSignature = null;
  appearanceAdoptedRootLayerIds = [];
}

function applyWebAppearanceLayersUnmeasured(compiled: AppearanceCompiledOutput): void {
  const layers = isWebAppearanceCompiledOutput(compiled)
    ? compiled[WEB_APPEARANCE_LAYERS]
    : ([
        {
          id: "order",
          css: compiled.artifact,
          declarations: "",
          rawCss: compiled.artifact,
          rawBeforeDeclarations: false,
        },
      ] satisfies ReadonlyArray<WebAppearanceLayer>);
  const order = layers[0];
  if (order === undefined) return;
  let orderStyle = document.getElementById(APPEARANCE_STYLE_ID);
  if (!(orderStyle instanceof HTMLStyleElement)) {
    orderStyle = document.createElement("style");
    orderStyle.id = APPEARANCE_STYLE_ID;
    document.head.append(orderStyle);
  }
  const dynamicCss = layers
    .slice(1)
    .map((layer) => layer.css)
    .filter((css) => css.length > 0)
    .join("\n");
  if (!applyConstructableAppearanceSheet(dynamicCss, layers)) {
    applyFallbackAppearanceSheet(dynamicCss, orderStyle.nonce);
  }
  orderStyle.removeAttribute(APPEARANCE_LAYER_ATTRIBUTE);
  orderStyle.removeAttribute(APPEARANCE_ROOT_LAYER_ATTRIBUTE);
  if (orderStyle.textContent !== order.css) orderStyle.textContent = order.css;
  removeLegacyAppearanceStyles();
}
function applyWebAppearanceLayers(compiled: AppearanceCompiledOutput): void {
  measureAppearanceOperation("stylesheet-replacement", () =>
    applyWebAppearanceLayersUnmeasured(compiled),
  );
}

async function applyWebAppearance(compiled: AppearanceCompiledOutput): Promise<void> {
  if (typeof document === "undefined") return;
  if (suppressPendingStartupApply) return;
  const fontLoadGeneration = ++appearanceFontLoadGeneration;
  const root = document.documentElement;
  const bootVariables = Array.from({ length: root.style.length }, (_, index) =>
    root.style.item(index),
  ).filter((name) => name.startsWith("--app-theme-") || name.startsWith("--t3-"));
  const packageValue = selectedPackage(compiled.input);
  const previewPackageValue = previewPackage(compiled.input);
  const activeProfile =
    compiled.input.state.preview?.package?.profile ??
    previewPackageValue?.profile ??
    compiled.input.state.preview?.profile ??
    packageValue?.profile;
  const variant = compiled.input.resolved.variant;
  if (activeProfile !== undefined && variant !== null && !compiled.input.state.safeMode) {
    registerNormalizedSyntaxTheme(activeProfile, variant);
  }
  if (activeProfile === undefined || variant === null || compiled.input.state.safeMode) {
    clearNormalizedSyntaxTheme();
    delete root.dataset.themeId;
    delete root.dataset.t3AppearanceActive;
  } else {
    root.dataset.themeId = activeProfile.metadata.id;
    root.dataset.t3AppearanceActive = "true";
  }
  if (compiled.input.state.safeMode) {
    root.dataset.appearanceSafeMode = "true";
  } else {
    delete root.dataset.appearanceSafeMode;
  }
  const dark =
    compiled.input.state.safeMode && typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : variant?.appearance === "dark";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  const canvas = compiled.input.resolved.values.canvas;
  const chromeColor = typeof canvas === "string" ? canvas : dark ? "#0a0a0a" : "#ffffff";
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", chromeColor);
  }
  if (document.body !== null) document.body.style.backgroundColor = chromeColor;
  applyWebAppearanceLayers(compiled);
  for (const variable of bootVariables) root.style.removeProperty(variable);
  if (activeProfile !== undefined && !compiled.input.state.safeMode) {
    const requests = activeProfile.assets
      .filter((asset) => asset.kind === "font" && asset.family !== undefined)
      .map((asset) => ({
        family: asset.family ?? "",
        ...(asset.style === undefined ? {} : { style: asset.style }),
        ...(asset.weight === undefined ? {} : { weight: asset.weight }),
      }));
    void appearanceFontLoads.load(requests).then(
      (result) => {
        if (fontLoadGeneration === appearanceFontLoadGeneration) {
          setAppearanceFontLoadDiagnostics(result.diagnostics);
        }
      },
      (error: unknown) => {
        if (fontLoadGeneration !== appearanceFontLoadGeneration) return;
        setAppearanceFontLoadDiagnostics([
          {
            family: "appearance",
            code: "font-load-failed",
            message: `Appearance font loading failed unexpectedly: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
            recovery: "Retry appearance font loading; fallback stacks remain available.",
          },
        ]);
      },
    );
  } else {
    setAppearanceFontLoadDiagnostics([]);
  }
}

/**
 * Keep the initial document hidden until the complete compiled profile (or
 * builtin recovery) is installed. The inline document boot only has enough
 * information for a bounded color hint; this gate prevents that hint from
 * becoming a visible partial profile.
 */
export function revealAppearanceStartup(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.appearanceStartup = "ready";
  document.documentElement.removeAttribute("data-appearance-startup");
}

export function applyBuiltinAppearanceForStartup(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  appearanceFontLoadGeneration += 1;
  let dark = false;
  try {
    dark =
      typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    dark = false;
  }
  clearNormalizedSyntaxTheme();
  delete root.dataset.themeId;
  delete root.dataset.t3AppearanceActive;
  delete root.dataset.themeSelected;
  root.dataset.appearanceSafeMode = "true";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  const background = dark ? "#0a0a0a" : "#ffffff";
  root.style.backgroundColor = background;
  if (document.body !== null) document.body.style.backgroundColor = background;
  for (const name of Array.from({ length: root.style.length }, (_, index) =>
    root.style.item(index),
  )) {
    if (name.startsWith("--app-theme-") || name.startsWith("--boot-") || name.startsWith("--t3-")) {
      root.style.removeProperty(name);
    }
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", background);
  }
  document.querySelector<HTMLStyleElement>("style[data-t3-appearance-atomic]")?.remove();
  removeLegacyAppearanceStyles();
  if (appearanceAdoptedSheet !== null && "adoptedStyleSheets" in document) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== appearanceAdoptedSheet,
    );
  }
  appearanceAdoptedSheet = null;
  appearanceAdoptedRawSignature = null;
  appearanceAdoptedRootLayerIds = [];
  setAppearanceFontLoadDiagnostics([]);
}
export async function initializeAppearanceStartup(): Promise<"profile" | "recovery"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const runtime = getAppearanceRuntime();
  try {
    const result = await Promise.race([
      runtime.then(() => "profile" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => {
          suppressPendingStartupApply = true;
          resolve("timeout");
        }, APPEARANCE_STARTUP_TIMEOUT_MS);
      }),
    ]);
    if (result === "profile") return result;
    void runtime.then(
      () => {
        suppressPendingStartupApply = false;
      },
      () => {
        suppressPendingStartupApply = false;
      },
    );
    applyBuiltinAppearanceForStartup();
    console.error(
      `Appearance startup exceeded ${APPEARANCE_STARTUP_TIMEOUT_MS}ms; showing builtin recovery.`,
    );
    return "recovery";
  } catch (error: unknown) {
    applyBuiltinAppearanceForStartup();
    console.error("Appearance startup failed; showing builtin recovery.", error);
    return "recovery";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    revealAppearanceStartup();
  }
}

function browserAppearanceRecoveryRequest(): "safe" | "reset" | null {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get("t3-appearance");
  return value === "safe" || value === "reset" ? value : null;
}

async function desktopSafeModeRequested(): Promise<boolean> {
  if (typeof window === "undefined" || window.desktopBridge === undefined) return false;
  try {
    return (await window.desktopBridge.startAppearanceWatch()).safeMode;
  } catch {
    return false;
  }
}

function readLegacyPreference(): {
  mode: "system" | ThemeAppearance;
  packageId?: string;
  lightPackageId?: string;
  darkPackageId?: string;
  variantId?: string;
} {
  if (typeof localStorage === "undefined") return { mode: "system" };
  try {
    const storedTheme = localStorage.getItem(LEGACY_THEME_STORAGE_KEY)?.trim() || "system";
    const canonicalTheme = canonicalThemePreference(storedTheme);
    const storedMode = localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
    const followSystem = localStorage.getItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY);
    const inferredMode =
      storedTheme === "t3-chat-dark"
        ? "dark"
        : canonicalTheme === "light" || canonicalTheme === "dark"
          ? canonicalTheme
          : canonicalTheme === "system"
            ? "system"
            : (getThemeDefinition(canonicalTheme)?.appearance ?? "system");
    const mode =
      storedMode === "light" || storedMode === "dark" || storedMode === "system"
        ? storedMode
        : followSystem === "true"
          ? "system"
          : inferredMode;
    const actualAppearance: ThemeAppearance =
      mode === "system"
        ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    const halves = parseThemeHalves(localStorage.getItem(THEME_HALVES_STORAGE_KEY));
    const requestedTheme = canonicalThemePreference(
      resolveThemeHalf(canonicalTheme, halves, actualAppearance),
    );
    const selectedTheme =
      requestedTheme === "system" ||
      requestedTheme === "light" ||
      requestedTheme === "dark" ||
      getThemeDefinition(requestedTheme) !== null
        ? requestedTheme
        : canonicalTheme;
    const packageForAppearance = (appearance: ThemeAppearance): ThemeDefinition => {
      const half = canonicalThemePreference(resolveThemeHalf(canonicalTheme, halves, appearance));
      return getThemeDefinition(half) ?? KM_CODE_THEME;
    };
    const packageId = getThemeDefinition(selectedTheme)?.id ?? KM_CODE_THEME.id;
    const lightPackageId = packageForAppearance("light").id;
    const darkPackageId = packageForAppearance("dark").id;
    return {
      mode,
      packageId,
      variantId: actualAppearance,
      ...(mode === "system" ? { lightPackageId, darkPackageId } : {}),
    };
  } catch {
    return { mode: "system" };
  }
}

let runtimePromise: Promise<AppearanceRuntime> | null = null;
let appearanceStorage: AppearanceStorageAdapter | null = null;
let removeLibrarySubscription: (() => void) | null = null;
let librarySync: Promise<void> = Promise.resolve();

async function syncEnvironmentPackages(runtime: AppearanceRuntime): Promise<void> {
  await runtime.execute({
    type: "environment-packages",
    packages: getEnvironmentThemes().map((theme): AppearancePackageInput => ({
      input: theme,
      sourceId: theme.id,
      trust: ENVIRONMENT_TRUST,
    })),
  });
}

export function deferredAppearanceStorage(
  create: () => AppearanceStorageAdapter,
): AppearanceStorageAdapter {
  let storage: AppearanceStorageAdapter | undefined;
  const get = (): AppearanceStorageAdapter => {
    storage ??= create();
    return storage;
  };
  return {
    load: (signal) => get().load(signal),
    commit: (expectedRevision, state, signal) => get().commit(expectedRevision, state, signal),
    recover: (state, signal) => {
      const resolved = get();
      if (resolved.recover === undefined) {
        throw new Error("Appearance storage recovery is unavailable.");
      }
      return resolved.recover(state, signal);
    },
    readQuarantinedState: () => get().readQuarantinedState?.() ?? Promise.resolve(null),
    restoreQuarantinedState: (signal) => {
      const resolved = get();
      if (resolved.restoreQuarantinedState === undefined) {
        throw new Error("Appearance quarantine restore is unavailable.");
      }
      return resolved.restoreQuarantinedState(signal);
    },
    subscribe: (listener) => get().subscribe(listener),
  };
}

async function createWebAppearanceRuntime(): Promise<AppearanceRuntime> {
  const defaultState = createEmptyAppearanceState();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const recoveryRequest = browserAppearanceRecoveryRequest();
  const forceSafeMode = recoveryRequest !== null || (await desktopSafeModeRequested());
  const createStorage = (): AppearanceStorageAdapter =>
    bridge === undefined
      ? new BrowserAppearanceStorage({ initialState: defaultState })
      : new DesktopBridgeAppearanceStorage(bridge);
  const storage = forceSafeMode ? deferredAppearanceStorage(createStorage) : createStorage();
  appearanceStorage = storage;
  const runtime = await createAppearanceRuntime({
    storage,
    compiler: webCompiler,
    apply: { apply: applyWebAppearance },
    defaultState,
    forceSafeMode,
    systemAppearance: () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    legacy: {
      read: async () => [...BUILT_IN_THEMES, ...getCustomThemes()],
      readPreference: async () => readLegacyPreference(),
    },
  });
  if (
    recoveryRequest === "reset" &&
    typeof window !== "undefined" &&
    window.confirm(
      "Reset all appearance packages, snippets, and preferences? A quarantined recovery copy will be kept where the platform supports it.",
    )
  ) {
    const reset = await runtime.execute({ type: "reset" });
    if (reset.status === "applied" && typeof history !== "undefined") {
      const url = new URL(location.href);
      url.searchParams.delete("t3-appearance");
      history.replaceState(history.state, "", url);
    }
  }
  if (!forceSafeMode) {
    await syncEnvironmentPackages(runtime);
    if (removeLibrarySubscription === null) {
      removeLibrarySubscription = subscribeToCustomThemes(() => {
        librarySync = librarySync
          .then(() => syncEnvironmentPackages(runtime))
          .catch(() => undefined);
      });
    }
  }
  return runtime;
}

export function getAppearanceRuntime(): Promise<AppearanceRuntime> {
  runtimePromise ??= createWebAppearanceRuntime();
  return runtimePromise;
}
export async function getAppearanceRecoveryInventory(): Promise<AppearancePersistedState | null> {
  await getAppearanceRuntime();
  try {
    return (await appearanceStorage?.load()) ?? null;
  } catch {
    return null;
  }
}

export async function getQuarantinedAppearanceState(): Promise<AppearancePersistedState | null> {
  await getAppearanceRuntime();
  return (await appearanceStorage?.readQuarantinedState?.()) ?? null;
}

export async function restoreQuarantinedAppearanceState(): Promise<AppearancePersistedState> {
  await getAppearanceRuntime();
  const restore = appearanceStorage?.restoreQuarantinedState;
  if (restore === undefined) throw new Error("Appearance quarantine restore is unavailable.");
  return restore();
}

type AppearanceRecoveryCommand =
  | Readonly<{ type: "disable"; id: string }>
  | Readonly<{ type: "delete"; id: string }>
  | Readonly<{ type: "snippet-toggle"; id: string; enabled: false }>
  | Readonly<{ type: "snippet-delete"; id: string }>;

export async function executeAppearanceRecoveryCommand(
  command: AppearanceRecoveryCommand,
): Promise<AppearancePersistedState> {
  const runtime = await getAppearanceRuntime();
  const storage = appearanceStorage;
  if (storage === null) throw new Error("Appearance recovery storage is unavailable.");
  const current = await storage.load();
  let packages = current.packages;
  let order = current.order;
  let snippets = current.snippets;
  let preference = current.preference;
  if (command.type === "disable") {
    const packageValue = packages[command.id];
    if (packageValue === undefined) throw new Error("Appearance package was not found.");
    packages = { ...packages, [command.id]: { ...packageValue, enabled: false } };
  } else if (command.type === "delete") {
    if (packages[command.id] === undefined) throw new Error("Appearance package was not found.");
    const { [command.id]: _deleted, ...remaining } = packages;
    packages = remaining;
    order = order.filter((id) => id !== command.id);
    const nextPreference = { ...preference };
    if (nextPreference.packageId === command.id) delete nextPreference.packageId;
    if (nextPreference.lightPackageId === command.id) delete nextPreference.lightPackageId;
    if (nextPreference.darkPackageId === command.id) delete nextPreference.darkPackageId;
    preference = nextPreference;
  } else if (command.type === "snippet-toggle") {
    if (!snippets.some((snippet) => snippet.id === command.id)) {
      throw new Error("Appearance snippet was not found.");
    }
    snippets = snippets.map((snippet) =>
      snippet.id === command.id ? { ...snippet, enabled: false } : snippet,
    );
  } else {
    if (!snippets.some((snippet) => snippet.id === command.id)) {
      throw new Error("Appearance snippet was not found.");
    }
    snippets = snippets.filter((snippet) => snippet.id !== command.id);
  }
  const next: AppearancePersistedState = {
    ...current,
    revision: current.revision + 1,
    packages,
    order,
    snippets,
    preference,
    safeMode: true,
  };
  await storage.commit(current.revision, next);
  const reconciled = await runtime.execute({ type: "external-reconcile", state: next });
  if (reconciled.status !== "applied") {
    throw new Error(
      reconciled.status === "rejected"
        ? (reconciled.diagnostics[0]?.message ?? "Appearance recovery reconcile was rejected.")
        : "Appearance recovery reconcile was cancelled.",
    );
  }
  return next;
}

export async function setAppearanceModePreference(mode: "system" | ThemeAppearance): Promise<void> {
  const runtime = await getAppearanceRuntime();
  const current = runtime.getSnapshot();
  const preference = { ...current.preference, mode };
  // An explicit mode must not keep a stale variant from the other appearance.
  // Preserve a deliberately selected variant when it already belongs to the
  // requested mode; otherwise let the runtime resolve that mode normally.
  if (
    current.preference.mode !== mode ||
    (mode !== "system" && current.resolved.baseVariant?.appearance !== mode)
  ) {
    delete preference.variantId;
  }
  const result = await runtime.execute({ type: "preference", preference });
  if (result.status === "rejected") {
    throw new Error(result.diagnostics[0]?.message ?? "Appearance mode preference was rejected.");
  }
}

export async function setAppearanceTypographyPreference(
  preference: AppearanceTypographyPreference,
): Promise<void> {
  const runtime = await getAppearanceRuntime();
  const result = await runtime.execute({ type: "typography-preference", preference });
  if (result.status === "rejected") {
    throw new Error(
      result.diagnostics[0]?.message ?? "Appearance typography preference was rejected.",
    );
  }
}

function trustForTheme(theme: ThemeDefinition): AppearanceTrust {
  if (getEnvironmentThemes().some((candidate) => candidate.id === theme.id))
    return ENVIRONMENT_TRUST;
  if (getCustomThemes().some((candidate) => candidate.id === theme.id)) return LOCAL_THEME_TRUST;
  return BUILTIN_TRUST;
}

async function ensureAppearanceThemePackage(
  runtime: AppearanceRuntime,
  theme: ThemeDefinition,
): Promise<void> {
  const trust = trustForTheme(theme);
  if (trust.class === "environment-palette") {
    await syncEnvironmentPackages(runtime);
    return;
  }
  const normalized = webCompiler.normalize(theme, { sourceId: theme.id, trust });
  if (normalized.status === "failure") throw new Error(normalized.diagnostic.message);
  const existing = runtime.getSnapshot().packages[theme.id];
  const packageInput = { input: theme, sourceId: theme.id, trust };
  if (
    existing !== undefined &&
    hashNormalizedAppearanceProfile(existing.profile) ===
      hashNormalizedAppearanceProfile(normalized.profile)
  ) {
    if (!existing.enabled) {
      const enabled = await runtime.execute({ type: "enable", id: theme.id });
      if (enabled.status !== "applied") {
        throw new Error(
          enabled.status === "rejected"
            ? (enabled.diagnostics[0]?.message ?? "Appearance package enable was rejected.")
            : "Appearance package enable was cancelled.",
        );
      }
    }
    return;
  }
  const result =
    existing === undefined
      ? await runtime.execute({ type: "install", package: packageInput, activate: false })
      : await runtime.execute({ type: "update", id: theme.id, package: packageInput });
  if (result.status === "rejected") {
    throw new Error(result.diagnostics[0]?.message ?? "Appearance package update was rejected.");
  }
  if (runtime.getSnapshot().packages[theme.id]?.enabled === false) {
    const enabled = await runtime.execute({ type: "enable", id: theme.id });
    if (enabled.status !== "applied") {
      throw new Error(
        enabled.status === "rejected"
          ? (enabled.diagnostics[0]?.message ?? "Appearance package enable was rejected.")
          : "Appearance package enable was cancelled.",
      );
    }
  }
}

export async function applyAppearanceTheme(
  theme: ThemeDefinition,
  appearance: ThemeAppearance,
  preferenceMode: "system" | ThemeAppearance = appearance,
  systemThemes?: Readonly<{ light: ThemeDefinition; dark: ThemeDefinition }>,
): Promise<void> {
  const runtime = await getAppearanceRuntime();
  const themes = [
    theme,
    ...(preferenceMode === "system" && systemThemes !== undefined
      ? [systemThemes.light, systemThemes.dark]
      : []),
  ];
  for (const candidate of new Map(themes.map((value) => [value.id, value])).values()) {
    await ensureAppearanceThemePackage(runtime, candidate);
  }
  const result = await runtime.execute({
    type: "preference",
    preference: {
      mode: preferenceMode,
      packageId: theme.id,
      variantId: appearance,
      ...(preferenceMode === "system" && systemThemes !== undefined
        ? {
            lightPackageId: systemThemes.light.id,
            darkPackageId: systemThemes.dark.id,
          }
        : {}),
    },
  });
  if (result.status === "rejected") {
    throw new Error(result.diagnostics[0]?.message ?? "Appearance preference was rejected.");
  }
  if (preferenceMode === "system") {
    const refreshed = await runtime.execute({ type: "refresh" });
    if (refreshed.status === "rejected") {
      throw new Error(
        refreshed.diagnostics[0]?.message ?? "System appearance refresh was rejected.",
      );
    }
  }
}
