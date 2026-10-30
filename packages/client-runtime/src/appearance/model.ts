import * as Schema from "effect/Schema";

import type {
  AppearanceCapability,
  AppearanceDiagnostic,
  AppearanceManifestV2,
  AppearanceNormalizationResult,
  AppearancePlatform,
  AppearanceTrust,
  NormalizedAppearanceProfile,
  NormalizedAppearanceVariant,
} from "@t3tools/shared/appearance";
import {
  AppearanceColorValueSchema,
  AppearanceDiagnosticSchema,
  AppearanceIdSchema,
  AppearanceManifestV2Schema,
  AppearancePackagePathSchema,
  AppearanceSha256Schema,
  NormalizedAppearanceProfileSchema,
  STRICT_APPEARANCE_PARSE_OPTIONS,
} from "@t3tools/shared/appearance";

import type { AppearanceLegacyInputAdapter } from "./migration.ts";
export const ENVIRONMENT_PALETTE_TRUST = {
  class: "environment-palette",
  allowSharedCss: false,
  allowDesktopCss: false,
  allowAdvancedSnippet: false,
} as const satisfies AppearanceTrust;

export type AppearanceId = string;
export type AppearanceVariant = "light" | "dark";

export interface AppearanceStoredAsset {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/avif" | "font/woff2";
  readonly sizeBytes: number;
  readonly dataBase64: string;
}

export interface AppearanceStoredPackage {
  readonly manifest: AppearanceManifestV2;
  readonly profile: NormalizedAppearanceProfile;
  readonly manifestHash: string;
  readonly sharedCss?: string;
  readonly desktopCss?: string;
  readonly assets: ReadonlyArray<AppearanceStoredAsset>;
  readonly diagnostics: ReadonlyArray<AppearanceDiagnostic>;
  readonly enabled: boolean;
}

export interface AppearanceSnippet {
  readonly id: string;
  readonly css: string;
  readonly enabled: boolean;
  readonly advanced: boolean;
}

export type AppearancePreference = Readonly<{
  readonly mode: "system" | AppearanceVariant;
  readonly packageId?: AppearanceId;
  readonly lightPackageId?: AppearanceId;
  readonly darkPackageId?: AppearanceId;
  readonly variantId?: string;
  readonly overrides?: AppearanceLayer;
}>;
export interface AppearanceTypographyPreference {
  readonly sans: string;
  readonly code: string;
  readonly composer: string;
  readonly terminal: string;
  readonly sizeInterface: number;
  readonly sizePrompt: number;
  readonly sizeCode: number;
  readonly sizeTerminal: number;
  readonly smoothing: boolean;
}

export interface AppearancePreview {
  readonly packageId?: AppearanceId;
  readonly profile?: NormalizedAppearanceProfile;
  readonly package?: AppearanceStoredPackage;
  readonly variantId?: string;
  readonly includeSnippets?: boolean;
  readonly expiresAt?: number;
}

export interface AppearancePersistedState {
  readonly revision: number;
  readonly packages: Readonly<Record<AppearanceId, AppearanceStoredPackage>>;
  readonly order: ReadonlyArray<AppearanceId>;
  readonly preference: AppearancePreference;
  readonly typographyPreference?: AppearanceTypographyPreference;
  readonly snippets: ReadonlyArray<AppearanceSnippet>;
  readonly accessibility: AppearanceLayer;
  readonly safeMode: boolean;
  readonly environmentPackages: ReadonlyArray<AppearanceStoredPackage>;
  readonly diagnostics: ReadonlyArray<AppearanceDiagnostic>;
  readonly migration: Readonly<{
    readonly completed: boolean;
    readonly sourceVersion?: number;
  }>;
}

export interface AppearanceLayer {
  readonly [property: string]: string;
}

export interface AppearancePrecedenceLayers {
  readonly variant: AppearanceLayer;
  readonly packageCss: AppearanceLayer;
  readonly preference: AppearanceLayer;
  readonly ordinarySnippet: AppearanceLayer;
  readonly preview: AppearanceLayer;
  readonly accessibility: AppearanceLayer;
  readonly advancedSnippet: AppearanceLayer;
}

export interface AppearanceResolved {
  readonly variant: NormalizedAppearanceVariant | null;
  readonly baseVariant: NormalizedAppearanceVariant | null;
  readonly previewVariant: NormalizedAppearanceVariant | null;
  readonly basePackageId: AppearanceId | null;
  readonly previewPackageId: AppearanceId | null;
  readonly values: AppearanceLayer;
  readonly css: string;
}

export interface AppearanceSnapshot extends AppearancePersistedState {
  readonly preview: AppearancePreview | null;
  readonly resolved: AppearanceResolved;
}

export type AppearancePackageInput = Readonly<{
  readonly input: unknown;
  readonly sourceId?: string;
  readonly trust?: AppearanceTrust;
  readonly sharedCss?: string;
  readonly desktopCss?: string;
  readonly assets?: ReadonlyArray<AppearanceStoredAsset>;
}>;

export type AppearanceCommand = (
  | Readonly<{
      readonly type: "install";
      readonly package: AppearancePackageInput;
      readonly activate: boolean;
    }>
  | Readonly<{
      readonly type: "update";
      readonly id: AppearanceId;
      readonly package: AppearancePackageInput;
    }>
  | Readonly<{ readonly type: "enable"; readonly id: AppearanceId }>
  | Readonly<{ readonly type: "disable"; readonly id: AppearanceId }>
  | Readonly<{
      readonly type: "reorder";
      readonly order: ReadonlyArray<AppearanceId>;
    }>
  | Readonly<{ readonly type: "delete"; readonly id: AppearanceId }>
  | Readonly<{ readonly type: "preference"; readonly preference: AppearancePreference }>
  | Readonly<{
      readonly type: "typography-preference";
      readonly preference: AppearanceTypographyPreference;
    }>
  | Readonly<{ readonly type: "accessibility"; readonly values: AppearanceLayer }>
  | Readonly<{ readonly type: "preview"; readonly preview: AppearancePreview | null }>
  | Readonly<{ readonly type: "snippets"; readonly snippets: ReadonlyArray<AppearanceSnippet> }>
  | Readonly<{ readonly type: "snippet-upsert"; readonly snippet: AppearanceSnippet }>
  | Readonly<{
      readonly type: "snippet-enable";
      readonly id: AppearanceId;
      readonly enabled: boolean;
    }>
  | Readonly<{ readonly type: "snippet-reorder"; readonly order: ReadonlyArray<AppearanceId> }>
  | Readonly<{ readonly type: "snippet-delete"; readonly id: AppearanceId }>
  | Readonly<{ readonly type: "safe-mode"; readonly enabled: boolean }>
  | Readonly<{ readonly type: "reset" }>
  | Readonly<{
      readonly type: "environment-packages";
      readonly packages: ReadonlyArray<AppearancePackageInput>;
    }>
  | Readonly<{ readonly type: "refresh" }>
  | Readonly<{
      readonly type: "external-reconcile";
      readonly state: AppearancePersistedState;
    }>
) &
  Readonly<{
    readonly generation?: number;
    readonly apply?: boolean;
  }>;

export type AppearanceCommandResult =
  | Readonly<{
      readonly status: "applied";
      readonly command: AppearanceCommand["type"];
      readonly revision: number;
      readonly snapshot: AppearanceSnapshot;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly command: AppearanceCommand["type"];
      readonly diagnostics: ReadonlyArray<AppearanceDiagnostic>;
      readonly snapshot: AppearanceSnapshot;
    }>
  | Readonly<{
      readonly status: "cancelled";
      readonly command: AppearanceCommand["type"];
      readonly snapshot: AppearanceSnapshot;
    }>;

export interface AppearanceStorageAdapter {
  readonly load: (signal?: AbortSignal) => Promise<AppearancePersistedState>;
  readonly commit: (
    expectedRevision: number,
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly subscribe: (listener: (state: AppearancePersistedState) => void) => () => void;
  readonly recover?: (
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ) => Promise<AppearancePersistedState>;
  readonly readQuarantinedState?: () => Promise<AppearancePersistedState | null>;
  readonly restoreQuarantinedState?: (signal?: AbortSignal) => Promise<AppearancePersistedState>;
}

export interface AppearanceCompilationInput {
  readonly state: AppearanceSnapshot;
  readonly resolved: AppearanceResolved;
  readonly generation?: number;
}

export interface AppearanceCompiledOutput {
  readonly input: AppearanceCompilationInput;
  readonly artifact: string;
  readonly dispose?: () => void;
  readonly diagnostics?: ReadonlyArray<AppearanceDiagnostic>;
  readonly generation?: number;
}

export interface AppearanceCompilerAdapter {
  readonly normalize: (
    input: unknown,
    options?: Readonly<{
      readonly sourceId?: string;
      readonly trust?: AppearanceTrust;
      readonly appVersion?: string;
      readonly platform?: AppearancePlatform;
      readonly supportedCapabilities?: ReadonlySet<AppearanceCapability>;
    }>,
  ) => AppearanceNormalizationResult;
  readonly compile: (
    input: AppearanceCompilationInput,
    signal?: AbortSignal,
  ) => Promise<AppearanceCompiledOutput>;
}

export interface AppearanceApplyAdapter {
  readonly apply: (compiled: AppearanceCompiledOutput, signal?: AbortSignal) => Promise<void>;
}

export interface AppearanceBroadcastEvent {
  readonly revision: number;
  readonly state: AppearancePersistedState;
}

export interface AppearanceBroadcastAdapter {
  readonly publish: (event: AppearanceBroadcastEvent) => void;
  readonly subscribe: (listener: (event: AppearanceBroadcastEvent) => void) => () => void;
}

export interface AppearanceRuntime {
  readonly getSnapshot: () => AppearanceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly execute: (
    command: AppearanceCommand,
    signal?: AbortSignal,
  ) => Promise<AppearanceCommandResult>;
}

export interface AppearanceRuntimeOptions {
  readonly storage: AppearanceStorageAdapter;
  readonly compiler: AppearanceCompilerAdapter;
  readonly apply: AppearanceApplyAdapter;
  readonly broadcast?: AppearanceBroadcastAdapter;
  readonly initialState?: AppearancePersistedState;
  readonly forceSafeMode?: boolean;
  readonly defaultState?: AppearancePersistedState;
  readonly legacy?: AppearanceLegacyInputAdapter;
  readonly systemAppearance?: () => "light" | "dark";
  readonly allocateGeneration?: () => number;
}

export const APPEARANCE_COMMAND_TYPES = [
  "install",
  "update",
  "enable",
  "disable",
  "reorder",
  "delete",
  "preference",
  "typography-preference",
  "preview",
  "accessibility",
  "snippets",
  "snippet-upsert",
  "snippet-enable",
  "snippet-reorder",
  "snippet-delete",
  "safe-mode",
  "reset",
  "environment-packages",
  "refresh",
  "external-reconcile",
] as const satisfies ReadonlyArray<AppearanceCommand["type"]>;
export const APPEARANCE_COMMAND_TYPES_EXHAUSTIVE: Exclude<
  AppearanceCommand["type"],
  (typeof APPEARANCE_COMMAND_TYPES)[number]
> extends never
  ? true
  : false = true;

const AppearanceStoredAssetSchema = Schema.Struct({
  id: AppearanceIdSchema,
  path: AppearancePackagePathSchema,
  sha256: AppearanceSha256Schema,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/avif", "font/woff2"]),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 * 1024 * 1024 })),
  dataBase64: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/u),
    Schema.isMaxLength(28 * 1024 * 1024),
  ),
});

const AppearanceStoredPackageSchema = Schema.Struct({
  manifest: AppearanceManifestV2Schema,
  profile: NormalizedAppearanceProfileSchema,
  manifestHash: AppearanceSha256Schema,
  sharedCss: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024 * 1024))),
  desktopCss: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024 * 1024))),
  assets: Schema.Array(AppearanceStoredAssetSchema).check(Schema.isMaxLength(256)),
  diagnostics: Schema.Array(AppearanceDiagnosticSchema).check(Schema.isMaxLength(128)),
  enabled: Schema.Boolean,
});
const decodeStoredPackage = Schema.decodeUnknownSync(AppearanceStoredPackageSchema);
export const AppearancePreviewSchema = Schema.Struct({
  packageId: Schema.optionalKey(AppearanceIdSchema),
  profile: Schema.optionalKey(NormalizedAppearanceProfileSchema),
  package: Schema.optionalKey(Schema.suspend(() => AppearanceStoredPackageSchema)),
  variantId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  includeSnippets: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
});
const decodePreview = Schema.decodeUnknownSync(AppearancePreviewSchema);

export function decodeAppearanceStoredPackage(input: unknown): AppearanceStoredPackage | null {
  try {
    return decodeStoredPackage(input, STRICT_APPEARANCE_PARSE_OPTIONS);
  } catch {
    return null;
  }
}

const AppearanceSnippetSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(128)),
  css: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  enabled: Schema.Boolean,
  advanced: Schema.Boolean,
});
const AppearanceLayerSchema = Schema.Record(
  Schema.String.check(
    Schema.isPattern(/^(?:--[a-z][a-z0-9-]{0,126}|[a-z][A-Za-z0-9]{0,63})(?![\s\S])/u),
  ),
  AppearanceColorValueSchema,
);

const AppearancePreferenceSchema = Schema.Struct({
  mode: Schema.Literals(["system", "light", "dark"]),
  packageId: Schema.optionalKey(AppearanceIdSchema),
  lightPackageId: Schema.optionalKey(AppearanceIdSchema),
  darkPackageId: Schema.optionalKey(AppearanceIdSchema),
  variantId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  overrides: Schema.optionalKey(AppearanceLayerSchema),
});

const AppearanceMigrationMarkerSchema = Schema.Struct({
  completed: Schema.Boolean,
  sourceVersion: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
});

const AppearanceTypographyPreferenceSchema = Schema.Struct({
  sans: Schema.String.check(Schema.isMaxLength(512)),
  code: Schema.String.check(Schema.isMaxLength(512)),
  composer: Schema.String.check(Schema.isMaxLength(512)),
  terminal: Schema.String.check(Schema.isMaxLength(512)),
  sizeInterface: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 8, maximum: 72 }),
  ),
  sizePrompt: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 8, maximum: 72 })),
  sizeCode: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 8, maximum: 72 })),
  sizeTerminal: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 8, maximum: 72 }),
  ),
  smoothing: Schema.Boolean,
});

export const AppearancePersistedStateSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  packages: Schema.Record(AppearanceIdSchema, AppearanceStoredPackageSchema),
  order: Schema.Array(AppearanceIdSchema),
  preference: AppearancePreferenceSchema,
  typographyPreference: Schema.optionalKey(AppearanceTypographyPreferenceSchema),
  snippets: Schema.Array(AppearanceSnippetSchema),
  accessibility: AppearanceLayerSchema,
  safeMode: Schema.Boolean,
  environmentPackages: Schema.Array(AppearanceStoredPackageSchema),
  diagnostics: Schema.Array(AppearanceDiagnosticSchema),
  migration: AppearanceMigrationMarkerSchema,
});
function isEnvironmentPalettePackage(value: AppearanceStoredPackage): boolean {
  const trust = value.profile.trust;
  return (
    trust.class === ENVIRONMENT_PALETTE_TRUST.class &&
    trust.allowSharedCss === ENVIRONMENT_PALETTE_TRUST.allowSharedCss &&
    trust.allowDesktopCss === ENVIRONMENT_PALETTE_TRUST.allowDesktopCss &&
    trust.allowAdvancedSnippet === ENVIRONMENT_PALETTE_TRUST.allowAdvancedSnippet
  );
}

const decodePersistedState = Schema.decodeUnknownSync(AppearancePersistedStateSchema);

export function decodeAppearancePreview(input: unknown): AppearancePreview | null {
  try {
    const decoded = decodePreview(input, STRICT_APPEARANCE_PARSE_OPTIONS);
    return decoded.packageId === undefined &&
      decoded.profile === undefined &&
      decoded.package === undefined
      ? null
      : decoded;
  } catch {
    return null;
  }
}

export function decodeAppearancePersistedState(input: unknown): AppearancePersistedState | null {
  try {
    const state = decodePersistedState(input, STRICT_APPEARANCE_PARSE_OPTIONS);
    const packageIds = Object.keys(state.packages);
    const orderedIds = new Set(state.order);
    if (
      orderedIds.size !== packageIds.length ||
      state.order.length !== packageIds.length ||
      packageIds.some((id) => !orderedIds.has(id))
    ) {
      return null;
    }
    if (
      Object.entries(state.packages).some(
        ([id, value]) => value.manifest.metadata.id !== id || value.profile.metadata.id !== id,
      )
    ) {
      return null;
    }
    const snippetIds = new Set(state.snippets.map((snippet) => snippet.id));
    if (snippetIds.size !== state.snippets.length) return null;
    const environmentIds = state.environmentPackages.map((value) => value.profile.metadata.id);
    if (new Set(environmentIds).size !== environmentIds.length) return null;
    if (state.environmentPackages.some((value) => !isEnvironmentPalettePackage(value))) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}
