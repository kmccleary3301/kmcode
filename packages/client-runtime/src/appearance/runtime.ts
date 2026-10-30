import {
  appearanceBytesSha256,
  appearanceSha256,
  hashNormalizedAppearanceProfile,
  matchesAppearanceAssetSignature,
  type AppearanceDiagnostic,
  type AppearanceManifestV2,
  type NormalizedAppearanceProfile,
  type NormalizedAppearanceVariant,
} from "@t3tools/shared/appearance";

import { AppearanceCssValidationError } from "./css.ts";
import { migrateAppearanceState } from "./migration.ts";
import { resolveAppearancePrecedence } from "./precedence.ts";
import {
  decodeAppearancePersistedState,
  decodeAppearancePreview,
  ENVIRONMENT_PALETTE_TRUST,
  type AppearanceApplyAdapter,
  type AppearanceBroadcastAdapter,
  type AppearanceCommand,
  type AppearanceCommandResult,
  type AppearanceCompiledOutput,
  type AppearanceCompilerAdapter,
  type AppearanceLayer,
  type AppearancePackageInput,
  type AppearancePersistedState,
  type AppearancePreview,
  type AppearanceResolved,
  type AppearanceRuntime,
  type AppearanceRuntimeOptions,
  type AppearanceSnapshot,
  type AppearanceStoredPackage,
  type AppearanceStorageAdapter,
} from "./model.ts";

const EMPTY_MIGRATION = Object.freeze({ completed: false });

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function diagnostic(
  message: string,
  path: ReadonlyArray<string | number> = [],
  code: AppearanceDiagnostic["code"] = "invalid-manifest",
): AppearanceDiagnostic {
  return {
    code,
    severity: "error",
    message,
    path,
    recovery: "Correct the appearance package or restore the last valid appearance state.",
  };
}

function startupFailureDiagnostic(): AppearanceDiagnostic {
  return diagnostic(
    "Appearance startup failed; custom appearance was disabled for safe recovery.",
    [],
    "startup-failure",
  );
}

function compilationDiagnostics(error: unknown): ReadonlyArray<AppearanceDiagnostic> {
  if (error instanceof AppearanceCssValidationError) {
    return error.diagnostics.map((entry) => ({
      code: "invalid-manifest",
      severity: "error",
      message: entry.message,
      path: entry.file === undefined ? [] : [entry.file],
      recovery: "Correct or disable this stylesheet; the last valid appearance remains active.",
      ...(entry.file === undefined ? {} : { file: entry.file }),
      line: entry.line,
      column: entry.column,
    }));
  }
  return [diagnostic("Appearance compilation, application, or storage commit failed.")];
}

function cancellation(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function emptyState(): AppearancePersistedState {
  return {
    revision: 0,
    packages: {},
    order: [],
    preference: { mode: "system" },
    snippets: [],
    accessibility: {},
    safeMode: false,
    environmentPackages: [],
    diagnostics: [],
    migration: EMPTY_MIGRATION,
  };
}

function profileManifest(profile: NormalizedAppearanceProfile): AppearanceManifestV2 {
  return {
    schema: profile.schema,
    version: 2,
    metadata: profile.metadata,
    compatibility: profile.compatibility,
    capabilities: profile.requestedCapabilities,
    fallback: profile.fallback,
    defaultVariant: profile.defaultVariant,
    variants: profile.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      appearance: variant.appearance,
      colors: variant.colors,
      typography: variant.typography,
      metrics: variant.metrics,
      motion: variant.motion,
      artwork: variant.artwork,
      terminal: variant.terminal,
      syntax: variant.syntax,
      diff: variant.diff,
    })),
    assets: profile.assets,
    styles: profile.styles,
    presentation: profile.presentation,
  };
}

function packageFromProfile(
  profile: NormalizedAppearanceProfile,
  input: AppearancePackageInput,
  enabled: boolean,
): AppearanceStoredPackage {
  const manifest = profileManifest(profile);
  return {
    manifest,
    profile,
    manifestHash: appearanceSha256(manifest),
    ...(input.sharedCss === undefined ? {} : { sharedCss: input.sharedCss }),
    ...(input.desktopCss === undefined ? {} : { desktopCss: input.desktopCss }),
    assets: input.assets === undefined ? [] : [...input.assets],
    diagnostics: [],
    enabled,
  };
}

function variantFor(
  profile: NormalizedAppearanceProfile,
  variantId: string | undefined,
  appearance: AppearancePersistedState["preference"]["mode"],
  ignoreVariantId = false,
): NormalizedAppearanceVariant | null {
  const requested =
    ignoreVariantId || variantId === undefined
      ? undefined
      : profile.variants.find((variant) => variant.id === variantId);
  if (requested !== undefined) return requested;
  if (appearance !== "system") {
    const matching = profile.variants.find((variant) => variant.appearance === appearance);
    if (matching !== undefined) return matching;
    if (profile.fallback[appearance] === "reject") return null;
  }
  return profile.variants.find((variant) => variant.id === profile.defaultVariant) ?? null;
}

function packageById(
  state: AppearancePersistedState,
  id: string,
): AppearanceStoredPackage | undefined {
  return (
    state.packages[id] ??
    state.environmentPackages.find((candidate) => candidate.profile.metadata.id === id)
  );
}

function selectedPackage(
  state: AppearancePersistedState,
  appearance: AppearancePersistedState["preference"]["mode"],
): AppearanceStoredPackage | null {
  const systemPackageId =
    state.preference.mode === "system" && appearance === "light"
      ? state.preference.lightPackageId
      : state.preference.mode === "system" && appearance === "dark"
        ? state.preference.darkPackageId
        : undefined;
  const preferredId = systemPackageId ?? state.preference.packageId;
  const ignoreVariantId = state.preference.mode === "system" && appearance !== "system";
  const canResolve = (candidate: AppearanceStoredPackage): boolean =>
    candidate.enabled &&
    variantFor(candidate.profile, state.preference.variantId, appearance, ignoreVariantId) !== null;
  if (preferredId !== undefined) {
    const preferred = packageById(state, preferredId);
    if (preferred !== undefined && canResolve(preferred)) return preferred;
  }
  for (const id of state.order) {
    const candidate = state.packages[id];
    if (candidate !== undefined && canResolve(candidate)) return candidate;
  }
  return state.environmentPackages.find(canResolve) ?? null;
}

function colorsLayer(variant: NormalizedAppearanceVariant | null): AppearanceLayer {
  if (variant === null) return {};
  const values: Record<string, string> = {};
  for (const [role, value] of Object.entries(variant.colors)) values[role] = value;
  return values;
}

export function resolveAppearanceState(
  state: AppearancePersistedState,
  preview: AppearancePreview | null,
  systemAppearance: (() => "light" | "dark") | undefined,
): AppearanceResolved {
  let effectiveAppearance: AppearancePersistedState["preference"]["mode"] = state.preference.mode;
  if (effectiveAppearance === "system" && systemAppearance !== undefined) {
    try {
      effectiveAppearance = systemAppearance();
    } catch {
      // Fall back to the package default until the platform appearance is readable.
    }
  }
  const packageValue = state.safeMode ? null : selectedPackage(state, effectiveAppearance);
  const previewPackage =
    state.safeMode || preview === null
      ? undefined
      : (preview.package ??
        (preview.packageId === undefined ? undefined : packageById(state, preview.packageId)));
  const previewProfile = state.safeMode ? undefined : (previewPackage?.profile ?? preview?.profile);
  const baseVariant =
    packageValue === null
      ? null
      : variantFor(
          packageValue.profile,
          state.preference.variantId,
          effectiveAppearance,
          state.preference.mode === "system" && effectiveAppearance !== "system",
        );
  const previewVariant =
    previewProfile === undefined
      ? null
      : variantFor(previewProfile, preview?.variantId, effectiveAppearance);
  const selectedVariant = previewVariant ?? baseVariant;
  const packageCss: Record<string, string> = {};
  if (!state.safeMode && packageValue !== null) {
    if (packageValue.sharedCss !== undefined) packageCss.shared = packageValue.sharedCss;
    if (packageValue.desktopCss !== undefined) packageCss.desktop = packageValue.desktopCss;
  }
  const ordinarySnippet: Record<string, string> = {};
  const advancedSnippet: Record<string, string> = {};
  const ordinaryCss: string[] = [];
  const advancedCss: string[] = [];
  const includeSnippets = preview === null || preview.includeSnippets !== false;
  if (!state.safeMode && includeSnippets) {
    for (const snippet of state.snippets) {
      if (!snippet.enabled) continue;
      if (snippet.advanced) {
        advancedSnippet[snippet.id] = snippet.css;
        advancedCss.push(snippet.css);
      } else {
        ordinarySnippet[snippet.id] = snippet.css;
        ordinaryCss.push(snippet.css);
      }
    }
  }
  const previewLayer = colorsLayer(previewVariant);
  const layers = {
    variant: colorsLayer(baseVariant),
    packageCss,
    preference: state.preference.overrides ?? {},
    ordinarySnippet,
    preview: previewLayer,
    accessibility: state.accessibility,
    advancedSnippet,
  } as const;
  const values = resolveAppearancePrecedence(layers, state.safeMode);
  const css = [
    ...(state.safeMode ? [] : Object.values(packageCss)),
    ...(state.safeMode ? [] : ordinaryCss),
    ...(state.safeMode ? [] : advancedCss),
  ].join("\n");
  return {
    variant: selectedVariant,
    baseVariant,
    previewVariant,
    basePackageId: packageValue?.profile.metadata.id ?? null,
    previewPackageId: previewProfile?.metadata.id ?? null,
    values,
    css,
  };
}

function snapshotFor(
  state: AppearancePersistedState,
  preview: AppearancePreview | null,
  systemAppearance: (() => "light" | "dark") | undefined,
): AppearanceSnapshot {
  const frozenState = immutable(state);
  return immutable({
    ...frozenState,
    preview,
    resolved: resolveAppearanceState(frozenState, preview, systemAppearance),
  });
}

function normalizePackage(
  compiler: AppearanceCompilerAdapter,
  input: AppearancePackageInput,
  enabled: boolean,
): { readonly package: AppearanceStoredPackage } | { readonly diagnostic: AppearanceDiagnostic } {
  try {
    const result = compiler.normalize(input.input, {
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.trust === undefined ? {} : { trust: input.trust }),
    });
    if (result.status === "failure") return { diagnostic: result.diagnostic };
    return { package: packageFromProfile(result.profile, input, enabled) };
  } catch {
    return { diagnostic: diagnostic("Appearance package normalization failed.") };
  }
}

function copyState(state: AppearancePersistedState): {
  packages: Record<string, AppearanceStoredPackage>;
  order: string[];
  preference: AppearancePersistedState["preference"];
  typographyPreference?: NonNullable<AppearancePersistedState["typographyPreference"]>;
  snippets: AppearancePersistedState["snippets"][number][];
  accessibility: AppearancePersistedState["accessibility"];
  safeMode: boolean;
  environmentPackages: AppearanceStoredPackage[];
  diagnostics: AppearanceDiagnostic[];
  migration: AppearancePersistedState["migration"];
} {
  return {
    packages: { ...state.packages },
    order: [...state.order],
    preference: { ...state.preference },
    ...(state.typographyPreference === undefined
      ? {}
      : { typographyPreference: { ...state.typographyPreference } }),
    snippets: [...state.snippets],
    safeMode: state.safeMode,
    accessibility: { ...state.accessibility },
    environmentPackages: [...state.environmentPackages],
    diagnostics: [...state.diagnostics],
    migration: { ...state.migration },
  };
}

function previewPackageIntegrityDiagnostic(
  packageValue: AppearanceStoredPackage,
  compiler: AppearanceCompilerAdapter,
): AppearanceDiagnostic | null {
  const id = packageValue.profile.metadata.id;
  if (appearanceSha256(packageValue.manifest) !== packageValue.manifestHash) {
    return diagnostic(`Appearance preview package '${id}' has an invalid manifest checksum.`);
  }
  const normalized = compiler.normalize(packageValue.manifest, {
    sourceId: id,
    trust: packageValue.profile.trust,
  });
  if (
    normalized.status === "failure" ||
    hashNormalizedAppearanceProfile(normalized.profile) !==
      hashNormalizedAppearanceProfile(packageValue.profile)
  ) {
    return diagnostic(`Appearance preview package '${id}' does not match its manifest.`);
  }
  for (const [name, source, declaration] of [
    ["shared CSS", packageValue.sharedCss, packageValue.manifest.styles?.web],
    ["desktop CSS", packageValue.desktopCss, packageValue.manifest.styles?.desktop],
  ] as const) {
    if ((source === undefined) !== (declaration === undefined)) {
      return diagnostic(`Appearance preview package '${id}' has inconsistent ${name}.`);
    }
    if (source === undefined || declaration === undefined) continue;
    const bytes = new TextEncoder().encode(source);
    if (
      bytes.byteLength !== declaration.sizeBytes ||
      appearanceBytesSha256(bytes) !== declaration.sha256
    ) {
      return diagnostic(`Appearance preview package '${id}' has invalid ${name} content.`);
    }
  }
  const declarations = new Map(packageValue.manifest.assets.map((asset) => [asset.id, asset]));
  for (const asset of packageValue.assets) {
    const declaration = declarations.get(asset.id);
    if (
      declaration === undefined ||
      declaration.path !== asset.path ||
      declaration.sizeBytes !== asset.sizeBytes ||
      declaration.sha256 !== asset.sha256 ||
      declaration.mimeType !== asset.mimeType
    ) {
      return diagnostic(`Appearance preview package '${id}' has inconsistent asset '${asset.id}'.`);
    }
    try {
      const decoded = globalThis.atob(asset.dataBase64);
      const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      if (
        bytes.byteLength !== asset.sizeBytes ||
        appearanceBytesSha256(bytes) !== asset.sha256 ||
        !matchesAppearanceAssetSignature(asset.mimeType, bytes)
      ) {
        return diagnostic(`Appearance preview package '${id}' has invalid asset '${asset.id}'.`);
      }
    } catch {
      return diagnostic(`Appearance preview package '${id}' has invalid asset '${asset.id}'.`);
    }
  }
  return null;
}

type Candidate =
  | Readonly<{
      status: "success";
      state: AppearancePersistedState;
      preview: AppearancePreview | null;
    }>
  | Readonly<{ status: "failure"; diagnostics: ReadonlyArray<AppearanceDiagnostic> }>;

async function candidateFor(
  command: AppearanceCommand,
  state: AppearancePersistedState,
  preview: AppearancePreview | null,
  compiler: AppearanceCompilerAdapter,
  defaultState: AppearancePersistedState,
  signal: AbortSignal | undefined,
): Promise<Candidate> {
  if (cancellation(signal)) return { status: "failure", diagnostics: [] };
  if (command.type === "external-reconcile") {
    const external = decodeAppearancePersistedState(command.state);
    if (external === null) {
      return {
        status: "failure",
        diagnostics: [diagnostic("External appearance state is invalid.")],
      };
    }
    if (external.revision <= state.revision) {
      return {
        status: "failure",
        diagnostics: [diagnostic("Appearance revision was already reconciled.")],
      };
    }
    return { status: "success", state: external, preview: null };
  }
  if (command.type === "preview") {
    const decodedPreview =
      command.preview === null ? null : decodeAppearancePreview(command.preview);
    if (command.preview !== null && decodedPreview === null) {
      return {
        status: "failure",
        diagnostics: [diagnostic("Appearance preview does not match the normalized contract.")],
      };
    }
    if (decodedPreview?.package !== undefined) {
      const invalid = previewPackageIntegrityDiagnostic(decodedPreview.package, compiler);
      if (invalid !== null) return { status: "failure", diagnostics: [invalid] };
    }
    return { status: "success", state, preview: decodedPreview };
  }

  const next = copyState(state);
  const original = copyState(state);
  let nextPreview = preview;
  if (command.type === "install" || command.type === "update") {
    const existing = next.packages[command.type === "update" ? command.id : ""];
    const enabled = command.type === "install" ? command.activate : (existing?.enabled ?? true);
    const normalized = normalizePackage(compiler, command.package, enabled);
    if ("diagnostic" in normalized)
      return { status: "failure", diagnostics: [normalized.diagnostic] };
    const id = normalized.package.profile.metadata.id;
    if (command.type === "install" && next.packages[id] !== undefined) {
      return {
        status: "failure",
        diagnostics: [diagnostic(`Appearance package '${id}' is already installed.`)],
      };
    }
    if (command.type === "update" && (existing === undefined || id !== command.id)) {
      return {
        status: "failure",
        diagnostics: [diagnostic(`Appearance package '${command.id}' is unavailable.`)],
      };
    }
    next.packages[id] = normalized.package;
    if (command.type === "install") next.order.push(id);
  } else if (command.type === "enable" || command.type === "disable") {
    const packageValue = next.packages[command.id];
    if (packageValue === undefined) {
      return {
        status: "failure",
        diagnostics: [diagnostic(`Appearance package '${command.id}' is unavailable.`)],
      };
    }
    next.packages[command.id] = { ...packageValue, enabled: command.type === "enable" };
  } else if (command.type === "reorder") {
    const expected = new Set(Object.keys(next.packages));
    const actual = new Set(command.order);
    if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
      return {
        status: "failure",
        diagnostics: [diagnostic("Appearance order must contain every package exactly once.")],
      };
    }
    next.order = [...command.order];
  } else if (command.type === "delete") {
    if (next.packages[command.id] === undefined) {
      return {
        status: "failure",
        diagnostics: [diagnostic(`Appearance package '${command.id}' is unavailable.`)],
      };
    }
    delete next.packages[command.id];
    next.order = next.order.filter((id) => id !== command.id);
    const preference = { ...next.preference };
    if (preference.packageId === command.id) delete preference.packageId;
    if (preference.lightPackageId === command.id) delete preference.lightPackageId;
    if (preference.darkPackageId === command.id) delete preference.darkPackageId;
    next.preference = preference;
    if (nextPreview?.packageId === command.id) nextPreview = null;
  } else if (command.type === "preference") {
    next.preference = { ...command.preference };
  } else if (command.type === "typography-preference") {
    next.typographyPreference = { ...command.preference };
  } else if (command.type === "accessibility") {
    next.accessibility = { ...command.values };
  } else if (command.type === "snippet-upsert") {
    const installed = next.snippets.some((snippet) => snippet.id === command.snippet.id);
    next.snippets = installed
      ? next.snippets.map((snippet) =>
          snippet.id === command.snippet.id ? { ...command.snippet } : snippet,
        )
      : [...next.snippets, { ...command.snippet }];
  } else if (command.type === "snippet-enable") {
    if (!next.snippets.some((snippet) => snippet.id === command.id)) {
      return {
        status: "failure",
        diagnostics: [diagnostic(`Appearance snippet '${command.id}' is not installed.`)],
      };
    }
    next.snippets = next.snippets.map((snippet) =>
      snippet.id === command.id ? { ...snippet, enabled: command.enabled } : snippet,
    );
  } else if (command.type === "snippet-reorder") {
    const installedIds = new Set(next.snippets.map((snippet) => snippet.id));
    if (
      command.order.length !== next.snippets.length ||
      new Set(command.order).size !== command.order.length ||
      command.order.some((id) => !installedIds.has(id))
    ) {
      return {
        status: "failure",
        diagnostics: [
          diagnostic("Snippet order must contain every installed snippet exactly once."),
        ],
      };
    }
    const snippets = new Map(next.snippets.map((snippet) => [snippet.id, snippet]));
    next.snippets = command.order.flatMap((id) => {
      const snippet = snippets.get(id);
      return snippet === undefined ? [] : [snippet];
    });
  } else if (command.type === "snippet-delete") {
    if (!next.snippets.some((snippet) => snippet.id === command.id)) {
      return {
        status: "failure",
        diagnostics: [diagnostic(`Appearance snippet '${command.id}' is not installed.`)],
      };
    }
    next.snippets = next.snippets.filter((snippet) => snippet.id !== command.id);
  } else if (command.type === "snippets") {
    const ids = new Set<string>();
    for (const snippet of command.snippets) {
      if (ids.has(snippet.id)) {
        return {
          status: "failure",
          diagnostics: [diagnostic(`Appearance snippet '${snippet.id}' is duplicated.`)],
        };
      }
      ids.add(snippet.id);
    }
    next.snippets = [...command.snippets];
  } else if (command.type === "safe-mode") {
    next.safeMode = command.enabled;
  } else if (command.type === "reset") {
    const reset = copyState(defaultState);
    next.packages = reset.packages;
    next.order = reset.order;
    next.preference = reset.preference;
    if (reset.typographyPreference === undefined) {
      delete next.typographyPreference;
    } else {
      next.typographyPreference = { ...reset.typographyPreference };
    }
    next.snippets = reset.snippets;
    next.accessibility = reset.accessibility;
    next.safeMode = reset.safeMode;
    next.environmentPackages = reset.environmentPackages;
    next.diagnostics = reset.diagnostics;
    next.migration = { ...next.migration, completed: true };
    nextPreview = null;
  } else if (command.type === "environment-packages") {
    const environment: AppearanceStoredPackage[] = [];
    for (const packageInput of command.packages) {
      const normalized = normalizePackage(
        compiler,
        { ...packageInput, trust: ENVIRONMENT_PALETTE_TRUST },
        true,
      );
      if ("diagnostic" in normalized)
        return { status: "failure", diagnostics: [normalized.diagnostic] };
      const packageValue: AppearanceStoredPackage = {
        ...normalized.package,
        profile: {
          ...normalized.package.profile,
          trust: ENVIRONMENT_PALETTE_TRUST,
        },
      };
      if (
        packageValue.profile.capabilities.includes("shared-css") ||
        packageValue.profile.capabilities.includes("desktop-css") ||
        packageValue.sharedCss !== undefined ||
        packageValue.desktopCss !== undefined ||
        packageValue.assets.length > 0 ||
        packageValue.profile.assets.length > 0 ||
        Object.keys(packageValue.profile.styles).length > 0
      ) {
        return {
          status: "failure",
          diagnostics: [diagnostic("Environment appearance packages may contain data only.")],
        };
      }
      environment.push(packageValue);
    }
    next.environmentPackages = environment;
  }
  const changed = appearanceSha256(next) !== appearanceSha256(original);
  return {
    status: "success",
    state: !changed
      ? state
      : immutable({
          ...next,
          revision: command.type === "environment-packages" ? state.revision : state.revision + 1,
        }),
    preview: nextPreview,
  };
}

interface RuntimeInternals {
  readonly storage: AppearanceStorageAdapter;
  readonly compiler: AppearanceCompilerAdapter;
  readonly apply: AppearanceApplyAdapter;
  readonly broadcast: AppearanceBroadcastAdapter | undefined;
}

function revalidatePersistedCompatibility(
  state: AppearancePersistedState,
  compiler: AppearanceCompilerAdapter,
): AppearancePersistedState {
  let changed = false;
  const packages: Record<string, AppearanceStoredPackage> = {};
  const compatibilityCodes = new Set(["incompatible-app-version", "unsupported-platform"]);
  const diagnostics = state.diagnostics.filter(
    (entry) => !(entry.file !== undefined && compatibilityCodes.has(entry.code)),
  );
  for (const [id, packageValue] of Object.entries(state.packages)) {
    const normalized = compiler.normalize(packageValue.manifest, {
      sourceId: id,
      trust: packageValue.profile.trust,
    });
    const priorDiagnostics = packageValue.diagnostics.filter(
      (entry) => !compatibilityCodes.has(entry.code),
    );
    if (normalized.status === "failure" && compatibilityCodes.has(normalized.diagnostic.code)) {
      const issue: AppearanceDiagnostic = { ...normalized.diagnostic, file: id };
      diagnostics.push(issue);
      packages[id] = {
        ...packageValue,
        enabled: false,
        diagnostics: [...priorDiagnostics, issue].slice(-128),
      };
      if (
        packageValue.enabled ||
        appearanceSha256(packageValue.diagnostics) !== appearanceSha256(packages[id]?.diagnostics)
      ) {
        changed = true;
      }
    } else {
      packages[id] = {
        ...packageValue,
        diagnostics: priorDiagnostics,
      };
      if (
        appearanceSha256(packageValue.diagnostics) !== appearanceSha256(packages[id]?.diagnostics)
      ) {
        changed = true;
      }
    }
  }
  if (!changed && appearanceSha256(diagnostics) === appearanceSha256(state.diagnostics)) {
    return state;
  }
  return {
    ...state,
    packages,
    diagnostics: diagnostics.slice(-1024),
  };
}

async function enterStartupRecovery(
  storage: AppearanceStorageAdapter,
  state: AppearancePersistedState,
): Promise<AppearancePersistedState> {
  const recoveryState = immutable({
    ...state,
    revision: state.revision + 1,
    safeMode: true,
    environmentPackages: [],
    diagnostics: [...state.diagnostics, startupFailureDiagnostic()].slice(-1024),
  });
  let recovered: AppearancePersistedState;
  if (storage.recover !== undefined) {
    recovered = await storage.recover(recoveryState);
  } else {
    await storage.commit(state.revision, recoveryState);
    recovered = recoveryState;
  }
  const decoded = decodeAppearancePersistedState(recovered);
  if (decoded === null) throw new Error("Appearance startup recovery returned invalid state.");
  if (decoded.safeMode) return immutable({ ...decoded, environmentPackages: [] });
  const durableSafeState = immutable({
    ...decoded,
    revision: decoded.revision + 1,
    safeMode: true,
    environmentPackages: [],
  });
  await storage.commit(decoded.revision, durableSafeState);
  return durableSafeState;
}

/** Create a serialized, cancellation-aware appearance runtime. */
export async function createAppearanceRuntime(
  options: AppearanceRuntimeOptions,
): Promise<AppearanceRuntime> {
  const internals: RuntimeInternals = {
    storage: options.storage,
    compiler: options.compiler,
    apply: options.apply,
    broadcast: options.broadcast,
  };
  const defaultState = immutable(options.defaultState ?? emptyState());
  let loaded = options.forceSafeMode ? defaultState : options.initialState;
  if (loaded === undefined) {
    try {
      loaded = await options.storage.load();
    } catch {
      try {
        loaded = await enterStartupRecovery(options.storage, defaultState);
      } catch {
        loaded = immutable({
          ...defaultState,
          safeMode: true,
          diagnostics: [...defaultState.diagnostics, startupFailureDiagnostic()].slice(-1024),
        });
      }
    }
  }
  const decoded = decodeAppearancePersistedState(loaded);
  const durableInitialState: AppearancePersistedState = immutable({
    ...(decoded ?? defaultState),
    environmentPackages: [],
  });
  let persistedSafeMode = durableInitialState.safeMode;
  let state: AppearancePersistedState = immutable({
    ...durableInitialState,
    ...(!options.forceSafeMode ? {} : { safeMode: true }),
  });
  if (options.legacy !== undefined && !options.forceSafeMode && !state.migration.completed) {
    try {
      const migrated = await migrateAppearanceState(state, options.legacy, options.compiler);
      if (migrated.revision !== state.revision) {
        await options.storage.commit(state.revision, migrated);
        state = immutable(migrated);
        try {
          await options.legacy.finalize?.();
        } catch {
          // The committed marker guarantees idempotency if legacy-key cleanup is unavailable.
        }
      }
    } catch {
      // A failed migration must not displace the last valid state.
    }
  }
  const compatibilityChecked = revalidatePersistedCompatibility(state, options.compiler);
  if (appearanceSha256(compatibilityChecked) !== appearanceSha256(state)) {
    if (options.forceSafeMode) {
      state = immutable({ ...compatibilityChecked, safeMode: true });
    } else {
      const next = immutable({
        ...compatibilityChecked,
        revision: state.revision + 1,
      });
      try {
        await options.storage.commit(state.revision, next);
        state = next;
      } catch {
        // The session still disables incompatible content even when persistence races.
        state = immutable(compatibilityChecked);
      }
    }
  }
  let preview: AppearancePreview | null = null;
  let currentSnapshot = snapshotFor(state, preview, options.systemAppearance);
  const compileStartup = async (): Promise<AppearanceCompiledOutput> => {
    let compiled = await internals.compiler.compile({
      state: currentSnapshot,
      resolved: currentSnapshot.resolved,
    });
    if (compiled.diagnostics !== undefined) {
      state = immutable({ ...state, diagnostics: [...compiled.diagnostics] });
      currentSnapshot = snapshotFor(state, preview, options.systemAppearance);
      compiled = {
        ...compiled,
        input: { state: currentSnapshot, resolved: currentSnapshot.resolved },
      };
    }
    return compiled;
  };
  let startupCompiled: AppearanceCompiledOutput | undefined;
  try {
    startupCompiled = await compileStartup();
    await internals.apply.apply(startupCompiled);
  } catch {
    startupCompiled?.dispose?.();
    try {
      state = await enterStartupRecovery(internals.storage, state);
    } catch {
      state = immutable({
        ...state,
        safeMode: true,
        environmentPackages: [],
        diagnostics: [...state.diagnostics, startupFailureDiagnostic()].slice(-1024),
      });
    }
    currentSnapshot = snapshotFor(state, preview, options.systemAppearance);
    startupCompiled = await compileStartup();
    await internals.apply.apply(startupCompiled);
  }
  if (startupCompiled === undefined) throw new Error("Appearance startup produced no artifact.");
  let currentCompiled: AppearanceCompiledOutput = startupCompiled;

  const listeners = new Set<() => void>();
  let tail: Promise<void> = Promise.resolve();
  let latestDispatchedGeneration = 0;
  let pendingCommitRevision: number | null = null;
  let isLocalOperationInProgress = false;
  let isResetRecoveryInProgress = false;

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One listener cannot prevent other listeners from observing a committed snapshot.
      }
    }
  };

  const reconcile = async (
    external: AppearancePersistedState,
    source: "storage" | "broadcast",
    capturedGeneration?: number,
    shouldApply = true,
  ): Promise<void> => {
    if (
      isResetRecoveryInProgress ||
      isLocalOperationInProgress ||
      external.revision <= state.revision ||
      (pendingCommitRevision !== null && external.revision === pendingCommitRevision)
    ) {
      return;
    }
    const compatibilityExternal = revalidatePersistedCompatibility(
      { ...external, environmentPackages: state.environmentPackages },
      internals.compiler,
    );
    const reconciledExternal = {
      ...compatibilityExternal,
      ...(!options.forceSafeMode ? {} : { safeMode: true }),
    };
    const result = await candidateFor(
      { type: "external-reconcile", state: reconciledExternal },
      state,
      preview,
      internals.compiler,
      defaultState,
      undefined,
    );
    if (result.status === "failure") return;
    let reconciledState = result.state;
    let nextSnapshot = snapshotFor(reconciledState, result.preview, options.systemAppearance);
    let compiled: AppearanceCompiledOutput | undefined;
    const reconcileGeneration = capturedGeneration;
    if (reconcileGeneration !== undefined && reconcileGeneration < latestDispatchedGeneration) {
      return;
    }
    try {
      compiled = await internals.compiler.compile({
        state: nextSnapshot,
        resolved: nextSnapshot.resolved,
        ...(reconcileGeneration !== undefined ? { generation: reconcileGeneration } : {}),
      });
      if (reconcileGeneration !== undefined && reconcileGeneration < latestDispatchedGeneration) {
        compiled.dispose?.();
        return;
      }
      if (compiled.diagnostics !== undefined) {
        reconciledState = immutable({
          ...reconciledState,
          diagnostics: [...compiled.diagnostics],
        });
        nextSnapshot = snapshotFor(reconciledState, result.preview, options.systemAppearance);
        compiled = {
          ...compiled,
          input: { state: nextSnapshot, resolved: nextSnapshot.resolved },
        };
      }
      if (shouldApply) {
        await internals.apply.apply(compiled);
        if (reconcileGeneration !== undefined && reconcileGeneration < latestDispatchedGeneration) {
          await internals.apply.apply(currentCompiled);
          compiled.dispose?.();
          return;
        }
      }
      const replaced = currentCompiled;
      state = immutable(reconciledState);
      preview = result.preview;
      currentSnapshot = nextSnapshot;
      if (shouldApply) {
        currentCompiled = compiled;
        replaced.dispose?.();
      } else {
        compiled.dispose?.();
      }
      notify();
    } catch {
      compiled?.dispose?.();
      try {
        if (shouldApply) await internals.apply.apply(currentCompiled);
      } catch {
        // External failures retain the current last-good snapshot even if repaint also fails.
      }
      if (source === "storage" || source === "broadcast") return;
    }
  };

  const enqueueReconcile = (
    external: AppearancePersistedState,
    source: "storage" | "broadcast",
    capturedGeneration?: number,
  ): Promise<void> => {
    if (
      isResetRecoveryInProgress ||
      isLocalOperationInProgress ||
      external.revision <= state.revision ||
      (pendingCommitRevision !== null && external.revision === pendingCommitRevision)
    ) {
      return Promise.resolve();
    }
    const work = tail.then(
      () => reconcile(external, source, capturedGeneration),
      () => reconcile(external, source, capturedGeneration),
    );
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };

  if (!options.forceSafeMode) {
    options.storage.subscribe((external) => {
      if (
        isResetRecoveryInProgress ||
        isLocalOperationInProgress ||
        external.revision <= state.revision ||
        (pendingCommitRevision !== null && external.revision === pendingCommitRevision)
      ) {
        return;
      }
      const captured = options.allocateGeneration?.();
      if (captured !== undefined) {
        latestDispatchedGeneration = Math.max(latestDispatchedGeneration, captured);
      }
      void enqueueReconcile(external, "storage", captured);
    });
    options.broadcast?.subscribe((event) => {
      if (
        isResetRecoveryInProgress ||
        isLocalOperationInProgress ||
        event.revision <= state.revision ||
        (pendingCommitRevision !== null && event.revision === pendingCommitRevision)
      ) {
        return;
      }
      const captured = options.allocateGeneration?.();
      if (captured !== undefined) {
        latestDispatchedGeneration = Math.max(latestDispatchedGeneration, captured);
      }
      void enqueueReconcile(event.state, "broadcast", captured);
    });
    try {
      // Subscribe before loading so a revision written during startup is
      // observed either by the event or by this authoritative catch-up read.
      await enqueueReconcile(await options.storage.load(), "storage");
    } catch {
      // Startup already applied the last valid snapshot; a failed catch-up
      // must not turn a transient storage read into recovery mode.
    }
  }

  const execute = (
    command: AppearanceCommand,
    signal?: AbortSignal,
  ): Promise<AppearanceCommandResult> => {
    if (command.generation !== undefined) {
      if (command.generation < latestDispatchedGeneration) {
        return Promise.resolve({
          status: "cancelled",
          command: command.type,
          snapshot: currentSnapshot,
        });
      }
      latestDispatchedGeneration = Math.max(latestDispatchedGeneration, command.generation);
    }
    const run = async (retryConflict = true): Promise<AppearanceCommandResult> => {
      const commandType = command.type;
      const commandGeneration =
        typeof command === "object" &&
        command !== null &&
        "generation" in command &&
        typeof command.generation === "number"
          ? command.generation
          : undefined;
      if (cancellation(signal))
        return { status: "cancelled", command: commandType, snapshot: currentSnapshot };
      if (commandGeneration !== undefined && commandGeneration < latestDispatchedGeneration) {
        return {
          status: "cancelled",
          command: commandType,
          snapshot: currentSnapshot,
        };
      }
      const persists =
        command.type !== "preview" &&
        command.type !== "environment-packages" &&
        command.type !== "refresh";
      if (!options.forceSafeMode && persists) {
        try {
          await reconcile(await internals.storage.load(), "storage", commandGeneration, false);
        } catch {
          // The existing snapshot remains usable; the ensuing optimistic
          // commit still rejects rather than overwriting unknown durable state.
        }
        if (commandGeneration !== undefined && commandGeneration < latestDispatchedGeneration) {
          return {
            status: "cancelled",
            command: commandType,
            snapshot: currentSnapshot,
          };
        }
      }
      const oldState = state;
      const oldPreview = preview;
      const oldSnapshot = currentSnapshot;
      const oldCompiled = currentCompiled;
      let candidateSourceState = oldState;
      let candidateSourcePreview = oldPreview;
      if (options.forceSafeMode && (command.type === "reset" || command.type === "refresh")) {
        try {
          const durable = decodeAppearancePersistedState(await internals.storage.load());
          if (durable === null) {
            return {
              status: "rejected",
              command: commandType,
              diagnostics: immutable([diagnostic("Durable appearance state is invalid.")]),
              snapshot: oldSnapshot,
            };
          }
          candidateSourceState = immutable({
            ...durable,
            safeMode: true,
            environmentPackages: [],
          });
          candidateSourcePreview = null;
        } catch {
          if (command.type === "refresh" || internals.storage.recover === undefined) {
            return {
              status: "rejected",
              command: commandType,
              diagnostics: immutable([diagnostic("Durable appearance state could not be loaded.")]),
              snapshot: oldSnapshot,
            };
          }
          candidateSourceState = immutable({
            ...defaultState,
            safeMode: true,
            environmentPackages: [],
          });
          candidateSourcePreview = null;
        }
      }
      if (
        options.forceSafeMode &&
        command.type !== "refresh" &&
        command.type !== "reset" &&
        command.type !== "external-reconcile"
      ) {
        return {
          status: "rejected",
          command: commandType,
          diagnostics: immutable([
            diagnostic("Appearance mutations are unavailable during forced safe recovery."),
          ]),
          snapshot: oldSnapshot,
        };
      }
      const candidate = await candidateFor(
        command,
        candidateSourceState,
        candidateSourcePreview,
        internals.compiler,
        defaultState,
        signal,
      );
      if (cancellation(signal))
        return { status: "cancelled", command: commandType, snapshot: currentSnapshot };
      if (candidate.status === "failure") {
        if (candidate.diagnostics.length === 0) {
          return { status: "cancelled", command: commandType, snapshot: currentSnapshot };
        }
        return {
          status: "rejected",
          command: commandType,
          diagnostics: immutable(candidate.diagnostics),
          snapshot: currentSnapshot,
        };
      }
      const decodedCandidateState =
        command.type === "preview"
          ? candidate.state
          : decodeAppearancePersistedState(candidate.state);
      if (decodedCandidateState === null) {
        return {
          status: "rejected",
          command: commandType,
          diagnostics: immutable([
            diagnostic("Appearance state exceeds the persisted storage contract."),
          ]),
          snapshot: currentSnapshot,
        };
      }
      let candidateState: AppearancePersistedState = options.forceSafeMode
        ? immutable({ ...decodedCandidateState, safeMode: true })
        : decodedCandidateState;
      if (
        command.type !== "refresh" &&
        command.type !== "preview" &&
        appearanceSha256(candidateState) === appearanceSha256(oldState) &&
        appearanceSha256(candidate.preview) === appearanceSha256(oldPreview)
      ) {
        return {
          status: "applied",
          command: commandType,
          revision: oldState.revision,
          snapshot: oldSnapshot,
        };
      }
      let nextSnapshot = snapshotFor(candidateState, candidate.preview, options.systemAppearance);
      let compiled = oldCompiled;
      if (commandGeneration !== undefined && commandGeneration < latestDispatchedGeneration) {
        return {
          status: "cancelled",
          command: commandType,
          snapshot: currentSnapshot,
        };
      }
      try {
        compiled = await internals.compiler.compile(
          {
            state: nextSnapshot,
            resolved: nextSnapshot.resolved,
            ...(commandGeneration !== undefined ? { generation: commandGeneration } : {}),
          },
          signal,
        );
        if (compiled.diagnostics !== undefined) {
          candidateState = immutable({
            ...candidateState,
            diagnostics: [...compiled.diagnostics],
          });
          nextSnapshot = snapshotFor(candidateState, candidate.preview, options.systemAppearance);
          compiled = {
            ...compiled,
            input: {
              state: nextSnapshot,
              resolved: nextSnapshot.resolved,
              ...(commandGeneration !== undefined ? { generation: commandGeneration } : {}),
            },
          };
        }
        if (cancellation(signal)) {
          compiled.dispose?.();
          return { status: "cancelled", command: commandType, snapshot: oldSnapshot };
        }
        if (commandGeneration !== undefined && commandGeneration < latestDispatchedGeneration) {
          compiled.dispose?.();
          return { status: "cancelled", command: commandType, snapshot: oldSnapshot };
        }
        if (command.apply !== false) {
          await internals.apply.apply(compiled, signal);
          if (cancellation(signal)) {
            await internals.apply.apply(oldCompiled);
            compiled.dispose?.();
            return { status: "cancelled", command: commandType, snapshot: oldSnapshot };
          }
          if (commandGeneration !== undefined && commandGeneration < latestDispatchedGeneration) {
            await internals.apply.apply(oldCompiled);
            compiled.dispose?.();
            return { status: "cancelled", command: commandType, snapshot: oldSnapshot };
          }
        }
        if (commandGeneration !== undefined && commandGeneration < latestDispatchedGeneration) {
          compiled.dispose?.();
          return { status: "cancelled", command: commandType, snapshot: oldSnapshot };
        }
        if (persists) {
          // Cancellation ends before commit. Recovery and environment inputs are session-only.
          const persistedCandidate = {
            ...candidateState,
            safeMode:
              options.forceSafeMode && command.type === "reset"
                ? false
                : options.forceSafeMode
                  ? persistedSafeMode
                  : candidateState.safeMode,
            environmentPackages: [],
          };
          if (command.type === "reset" && internals.storage.recover !== undefined) {
            isResetRecoveryInProgress = true;
            isLocalOperationInProgress = true;
            let recovered: AppearancePersistedState;
            try {
              recovered = await internals.storage.recover(persistedCandidate, signal);
              pendingCommitRevision = recovered.revision;
            } finally {
              isResetRecoveryInProgress = false;
              isLocalOperationInProgress = false;
            }
            candidateState = immutable(
              options.forceSafeMode ? { ...recovered, safeMode: true } : recovered,
            );
            nextSnapshot = snapshotFor(candidateState, candidate.preview, options.systemAppearance);
            const recoveredCompiled = await internals.compiler.compile(
              {
                state: nextSnapshot,
                resolved: nextSnapshot.resolved,
                ...(commandGeneration !== undefined ? { generation: commandGeneration } : {}),
              },
              signal,
            );
            try {
              if (command.apply !== false) {
                await internals.apply.apply(recoveredCompiled, signal);
              }
            } catch (error) {
              recoveredCompiled.dispose?.();
              throw error;
            }
            compiled.dispose?.();
            compiled = recoveredCompiled;
          } else {
            isLocalOperationInProgress = true;
            pendingCommitRevision = persistedCandidate.revision;
            try {
              await internals.storage.commit(
                candidateSourceState.revision,
                persistedCandidate,
                signal,
              );
            } catch (error) {
              isLocalOperationInProgress = false;
              pendingCommitRevision = null;
              if (!retryConflict) throw error;
              let durable: AppearancePersistedState;
              try {
                durable = await internals.storage.load();
              } catch {
                throw error;
              }
              if (durable.revision <= candidateSourceState.revision) throw error;
              if (compiled !== oldCompiled) compiled.dispose?.();
              await reconcile(durable, "storage", commandGeneration, false);
              return run(false);
            } finally {
              isLocalOperationInProgress = false;
              pendingCommitRevision = null;
            }
          }
        }
      } catch (error) {
        isResetRecoveryInProgress = false;
        isLocalOperationInProgress = false;
        pendingCommitRevision = null;
        try {
          await internals.apply.apply(oldCompiled);
        } catch {
          // Best-effort restoration leaves the old immutable state as the observable snapshot.
        }
        if (compiled !== oldCompiled) compiled.dispose?.();
        if (cancellation(signal))
          return { status: "cancelled", command: commandType, snapshot: oldSnapshot };
        return {
          status: "rejected",
          command: commandType,
          diagnostics: immutable(compilationDiagnostics(error)),
          snapshot: oldSnapshot,
        };
      }
      const replaced = currentCompiled;
      state = immutable(candidateState);
      pendingCommitRevision = null;
      currentSnapshot = nextSnapshot;
      if (command.apply !== false) {
        currentCompiled = compiled;
        if (replaced !== compiled) replaced.dispose?.();
      } else if (compiled !== currentCompiled) {
        compiled.dispose?.();
      }
      if (options.forceSafeMode && command.type === "reset") {
        persistedSafeMode = false;
      }
      notify();
      if (persists) {
        try {
          const broadcastState = {
            ...state,
            safeMode: options.forceSafeMode ? persistedSafeMode : state.safeMode,
            environmentPackages: [],
          };
          internals.broadcast?.publish({ revision: state.revision, state: broadcastState });
        } catch {
          // Broadcast transport failure does not invalidate a committed local revision.
        }
      }
      return {
        status: "applied",
        command: commandType,
        revision: state.revision,
        snapshot: currentSnapshot,
      };
    };
    const work = tail.then(
      () => run(),
      () => run(),
    );
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };

  return {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    execute,
  };
}

export { emptyState as createEmptyAppearanceState };
