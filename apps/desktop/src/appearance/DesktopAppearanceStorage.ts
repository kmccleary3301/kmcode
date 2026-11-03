// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Desktop appearance storage is intentionally filesystem-backed and uses host time for persisted metadata.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  AppearanceCssValidationError,
  AppearancePersistedStateSchema,
  decodeAppearancePersistedState,
  validateAppearancePackageCss,
  validateAppearanceSnippetCss,
} from "@t3tools/client-runtime/appearance";
import type {
  AppearancePackageInput,
  AppearancePersistedState,
  AppearanceStorageAdapter,
  AppearanceStoredAsset,
  AppearanceStoredPackage,
} from "@t3tools/client-runtime/appearance";
import {
  AppearanceDiagnosticSchema,
  AppearanceManifestV2Schema,
  AppearanceSha256Schema,
  DEFAULT_APPEARANCE_TRUST,
  NormalizedAppearanceProfileSchema,
  appearanceSha256,
  normalizeAppearance,
  matchesAppearanceAssetSignature,
} from "@t3tools/shared/appearance";
import type { AppearanceDiagnostic, AppearanceManifestV2 } from "@t3tools/shared/appearance";
import * as Schema from "effect/Schema";
import JSZip from "jszip";
const { createHash, randomUUID } = NodeCrypto;
const { constants: FsConstants, watch: watchFileSystem } = NodeFS;
const FileSystem = NodeFSP;
const Path = NodePath;
type FSWatcher = NodeFS.FSWatcher;
type FileHandle = NodeFSP.FileHandle;

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CSS_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_FILES = 256;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_STATE_DIAGNOSTICS = 1024;
const MAX_PATH_DEPTH = 8;
const WATCH_DEBOUNCE_MS = 80;
const STABILITY_INTERVAL_MS = 25;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_200, 6_400] as const;
const STORAGE_SCHEMA = "t3.appearance/storage/v1";
const PACKAGE_SCHEMA = "t3.appearance/package/v1";

const StoredAssetSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  sha256: AppearanceSha256Schema,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/avif", "font/woff2"]),
  sizeBytes: Schema.Int,
  dataBase64: Schema.String,
});
const StoredPackageSchema = Schema.Struct({
  manifest: AppearanceManifestV2Schema,
  profile: NormalizedAppearanceProfileSchema,
  manifestHash: AppearanceSha256Schema,
  sharedCss: Schema.optionalKey(Schema.String),
  desktopCss: Schema.optionalKey(Schema.String),
  assets: Schema.Array(StoredAssetSchema),
  diagnostics: Schema.Array(AppearanceDiagnosticSchema),
  enabled: Schema.Boolean,
});
const PackageDocumentSchema = Schema.Struct({
  schema: Schema.Literal(PACKAGE_SCHEMA),
  package: StoredPackageSchema,
  sha256: AppearanceSha256Schema,
});
const StateDocumentSchema = Schema.Struct({
  schema: Schema.Literal(STORAGE_SCHEMA),
  state: AppearancePersistedStateSchema,
  sha256: AppearanceSha256Schema,
});
const decodePackageDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageDocumentSchema),
);
const decodeStateDocument = Schema.decodeUnknownSync(Schema.fromJsonString(StateDocumentSchema));
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(AppearanceManifestV2Schema));
const decodeDiagnostics = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(AppearanceDiagnosticSchema)),
);

export type DesktopAppearanceStorageErrorCode =
  | "invalid-root"
  | "invalid-state"
  | "revision-conflict"
  | "unsafe-path"
  | "unsafe-package"
  | "write-failed"
  | "not-found"
  | "cancelled";

export class DesktopAppearanceStorageError extends Error {
  readonly code: DesktopAppearanceStorageErrorCode;
  readonly path: string;

  constructor(code: DesktopAppearanceStorageErrorCode, message: string, path: string) {
    super(message);
    this.name = "DesktopAppearanceStorageError";
    this.code = code;
    this.path = path;
  }
}

interface PackageDocument {
  readonly schema: typeof PACKAGE_SCHEMA;
  readonly package: AppearanceStoredPackage;
  readonly sha256: string;
}
interface StateDocument {
  readonly schema: typeof STORAGE_SCHEMA;
  readonly state: AppearancePersistedState;
  readonly sha256: string;
}
type PackageFile = Readonly<{ readonly relativePath: string; readonly bytes: Uint8Array }>;
type InspectableZipEntry = JSZip.JSZipObject & {
  readonly _data?: { readonly uncompressedSize?: unknown };
  readonly unsafeOriginalName?: string;
  readonly unixPermissions?: number | string | null;
  readonly internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
};
type WatchedPackageFiles = Readonly<{
  readonly byId: Readonly<Record<string, ReadonlyArray<PackageFile>>>;
  readonly checksums: Readonly<Record<string, string>>;
  readonly invalidIds: ReadonlySet<string>;
}>;

function packageContentChecksum(value: AppearanceStoredPackage): string {
  const { enabled: _enabled, ...content } = value;
  return appearanceSha256(content);
}

function packageFilesChecksum(files: ReadonlyArray<PackageFile>): string {
  return appearanceSha256(
    [...files]
      .map((file) => ({
        path: file.relativePath,
        sizeBytes: file.bytes.byteLength,
        sha256: sha256Bytes(file.bytes),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  );
}

function packageChecksums(
  packages: Readonly<Record<string, AppearanceStoredPackage>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(packages).map(([id, value]) => [id, packageContentChecksum(value)]),
  );
}

function sameChecksums(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length && leftIds.every((id) => left[id] === right[id]);
}

const EMPTY_STATE: AppearancePersistedState = {
  revision: 0,
  packages: {},
  order: [],
  preference: { mode: "system" },
  snippets: [],
  accessibility: {},
  safeMode: false,
  environmentPackages: [],
  diagnostics: [],
  migration: { completed: false },
};

function isExplicitRecoveryReset(state: AppearancePersistedState): boolean {
  return (
    Object.keys(state.packages).length === 0 &&
    state.order.length === 0 &&
    state.preference.mode === "system" &&
    Object.keys(state.preference).length === 1 &&
    state.typographyPreference === undefined &&
    state.snippets.length === 0 &&
    Object.keys(state.accessibility).length === 0 &&
    !state.safeMode &&
    state.environmentPackages.length === 0 &&
    state.diagnostics.length === 0 &&
    state.migration.completed
  );
}
export function isNarrowSafeRecoveryMutation(
  current: AppearancePersistedState,
  candidate: AppearancePersistedState,
): boolean {
  if (candidate.revision !== current.revision + 1 || !candidate.safeMode) return false;
  for (const [id, value] of Object.entries(candidate.packages)) {
    const previous = current.packages[id];
    if (previous === undefined) return false;
    if (
      appearanceSha256(value) !==
      appearanceSha256(value.enabled ? previous : { ...previous, enabled: false })
    ) {
      return false;
    }
  }
  if (
    appearanceSha256(candidate.order) !==
    appearanceSha256(current.order.filter((id) => candidate.packages[id] !== undefined))
  ) {
    return false;
  }
  const previousSnippets = new Map(current.snippets.map((snippet) => [snippet.id, snippet]));
  for (const snippet of candidate.snippets) {
    const previous = previousSnippets.get(snippet.id);
    if (previous === undefined) return false;
    if (
      appearanceSha256(snippet) !==
      appearanceSha256(snippet.enabled ? previous : { ...previous, enabled: false })
    ) {
      return false;
    }
  }
  if (
    appearanceSha256(candidate.snippets.map((snippet) => snippet.id)) !==
    appearanceSha256(
      current.snippets
        .filter((snippet) => candidate.snippets.some((next) => next.id === snippet.id))
        .map((snippet) => snippet.id),
    )
  ) {
    return false;
  }
  const expectedPreference = { ...current.preference };
  if (
    expectedPreference.packageId !== undefined &&
    candidate.packages[expectedPreference.packageId] === undefined
  ) {
    delete expectedPreference.packageId;
  }
  if (
    expectedPreference.lightPackageId !== undefined &&
    candidate.packages[expectedPreference.lightPackageId] === undefined
  ) {
    delete expectedPreference.lightPackageId;
  }
  if (
    expectedPreference.darkPackageId !== undefined &&
    candidate.packages[expectedPreference.darkPackageId] === undefined
  ) {
    delete expectedPreference.darkPackageId;
  }
  if (appearanceSha256(candidate.preference) !== appearanceSha256(expectedPreference)) return false;
  const {
    revision: _currentRevision,
    packages: _currentPackages,
    preference: _currentPreference,
    order: _currentOrder,
    snippets: _currentSnippets,
    safeMode: _currentSafeMode,
    ...currentRest
  } = current;
  const {
    revision: _candidateRevision,
    packages: _candidatePackages,
    order: _candidateOrder,
    preference: _candidatePreference,
    snippets: _candidateSnippets,
    safeMode: _candidateSafeMode,
    ...candidateRest
  } = candidate;
  return appearanceSha256(currentRest) === appearanceSha256(candidateRest);
}

function stateWithinAggregateBounds(state: AppearancePersistedState): boolean {
  const packageIds = Object.keys(state.packages);
  const orderedIds = new Set(state.order);
  return (
    packageIds.length <= MAX_PACKAGE_FILES &&
    state.order.length === packageIds.length &&
    orderedIds.size === state.order.length &&
    packageIds.every((id) => orderedIds.has(id)) &&
    state.environmentPackages.length <= MAX_PACKAGE_FILES &&
    state.snippets.length <= MAX_PACKAGE_FILES &&
    state.diagnostics.length <= MAX_STATE_DIAGNOSTICS &&
    Buffer.byteLength(JSON.stringify(stateDocument(state)) + "\n", "utf8") <= MAX_STATE_BYTES
  );
}

const storageTailsByRoot = new Map<string, Promise<void>>();

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DesktopAppearanceStorageError(
      "cancelled",
      "Appearance storage operation cancelled.",
      "",
    );
  }
}

function bytesFor(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashAppearanceProfileContent(profile: AppearanceStoredPackage["profile"]): string {
  const { migration: _migration, ...content } = profile;
  return appearanceSha256(content);
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return null;
  return new Uint8Array(bytes);
}

function stateDocument(state: AppearancePersistedState): StateDocument {
  return {
    schema: STORAGE_SCHEMA,
    state,
    sha256: appearanceSha256(state),
  };
}

function packageDocument(value: AppearanceStoredPackage): PackageDocument {
  return {
    schema: PACKAGE_SCHEMA,
    package: value,
    sha256: appearanceSha256(value),
  };
}

function packageId(value: AppearanceStoredPackage): string {
  return value.manifest.metadata.id;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isTransientWindowsRenameError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (
    error.code === "EACCES" ||
    error.code === "EBUSY" ||
    error.code === "ENOTEMPTY" ||
    error.code === "EPERM"
  );
}

function desktopPlatform(
  platform: NodeJS.Platform,
): "desktop-macos" | "desktop-windows" | "desktop-linux" {
  if (platform === "darwin") return "desktop-macos";
  if (platform === "win32") return "desktop-windows";
  return "desktop-linux";
}
function storedProfileMatchesManifest(
  manifest: AppearanceManifestV2,
  profile: AppearanceStoredPackage["profile"],
): boolean {
  for (const platform of [
    "web",
    "desktop-macos",
    "desktop-windows",
    "desktop-linux",
    "ios",
    "android",
  ] as const) {
    const normalized = normalizeAppearance(manifest, { trust: profile.trust, platform });
    if (
      normalized.status === "success" &&
      hashAppearanceProfileContent(normalized.profile) === hashAppearanceProfileContent(profile)
    ) {
      return true;
    }
  }
  return false;
}

function isSafeId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]{0,63})$/.test(id);
}

function wait(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
function readBoundedZipEntry(
  entry: InspectableZipEntry,
  remainingBytes: number,
  source: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  checkAbort(signal);
  const expectedBytes = entry._data?.uncompressedSize;
  const sizeError = () =>
    new DesktopAppearanceStorageError(
      "unsafe-package",
      "Package archive expands beyond its declared or safe size bound.",
      source,
    );
  if (
    typeof expectedBytes !== "number" ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > remainingBytes ||
    entry.internalStream === undefined
  ) {
    throw sizeError();
  }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = entry.internalStream!("uint8array");
    const cleanup = () => signal?.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(
        new DesktopAppearanceStorageError(
          "cancelled",
          "Appearance storage operation cancelled.",
          source,
        ),
      );
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > expectedBytes || byteLength > remainingBytes) {
          settled = true;
          stream.pause();
          cleanup();
          reject(sizeError());
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new DesktopAppearanceStorageError(
            "unsafe-package",
            `Package archive could not be safely decompressed: ${errorMessage(cause)}`,
            source,
          ),
        );
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (byteLength !== expectedBytes) {
          reject(sizeError());
          return;
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(bytes);
      })
      .resume();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Filesystem operation failed.";
}

export class DesktopAppearanceStorage implements AppearanceStorageAdapter {
  readonly root: string;
  readonly appearanceRoot: string;
  readonly statePath: string;
  readonly packagesRoot: string;
  readonly quarantineRoot: string;
  readonly quarantineStatePath: string;
  readonly quarantinePackagesPath: string;

  private readonly appVersion: string | undefined;
  private readonly hostPlatform: NodeJS.Platform;
  private currentState: AppearancePersistedState | null = null;
  private currentDigest: string | null = null;
  private currentPackageChecksums: Readonly<Record<string, string>> = {};
  private readonly listeners = new Set<(state: AppearancePersistedState) => void>();
  private readonly watchListeners = new Set<(state: AppearancePersistedState) => void>();
  private readonly watchers = new Set<FSWatcher>();
  private watchTimer: NodeJS.Timeout | null = null;
  private watchRetryTimer: NodeJS.Timeout | null = null;
  private watchReadTail: Promise<void> = Promise.resolve();
  private watchRunning = false;
  private watchGeneration = 0;
  private invalidRetryGeneration = -1;

  constructor(userDataRoot: string, appVersion: string | undefined, hostPlatform: NodeJS.Platform) {
    this.root = Path.resolve(userDataRoot);
    this.appVersion = appVersion;
    this.hostPlatform = hostPlatform;
    this.appearanceRoot = this.contained("appearance");
    this.statePath = this.contained("appearance", "state.json");
    this.packagesRoot = this.contained("appearance", "packages");
    this.quarantineRoot = this.contained("appearance", "quarantine");
    this.quarantineStatePath = this.contained("appearance", "quarantine", "reset-state.json");
    this.quarantinePackagesPath = this.contained("appearance", "quarantine", "reset-packages");
  }
  async readSafeModeForBoot(): Promise<boolean> {
    const candidates = [
      this.statePath,
      this.contained("appearance", "state.last-good.json"),
    ] as const;
    let foundPersistedState = false;
    for (const path of candidates) {
      try {
        const entry = await FileSystem.lstat(path);
        foundPersistedState = true;
        if (!entry.isFile()) {
          throw new DesktopAppearanceStorageError(
            "invalid-state",
            "Appearance boot state must be a regular file.",
            path,
          );
        }
      } catch (error: unknown) {
        if (isNotFound(error)) continue;
        throw error;
      }
      const loaded = await this.readStateFile(path, false);
      if (loaded !== null) return loaded.state.safeMode;
    }
    if (foundPersistedState) {
      throw new DesktopAppearanceStorageError(
        "invalid-state",
        "No valid appearance recovery state is readable.",
        this.statePath,
      );
    }
    return false;
  }

  async load(signal?: AbortSignal): Promise<AppearancePersistedState> {
    return this.withStorageLock(() => this.loadUnlocked(signal));
  }

  private async loadUnlocked(signal?: AbortSignal): Promise<AppearancePersistedState> {
    checkAbort(signal);
    await this.ensureLayout();
    const loaded = await this.readStateFile(this.statePath, true);
    checkAbort(signal);
    if (loaded !== null) {
      const sanitized = await this.sanitizePackages(loaded.state);
      this.setCurrentState(sanitized, loaded.digest);
      return sanitized;
    }

    const lastGoodPath = this.contained("appearance", "state.last-good.json");
    const lastGood = await this.readStateFile(lastGoodPath, false);
    if (lastGood !== null) {
      const sanitized = await this.sanitizePackages(lastGood.state);
      this.setCurrentState(sanitized, lastGood.digest);
      await this.writeStateFile(sanitized, this.statePath).catch(() => undefined);
      return sanitized;
    }

    const sanitized = await this.sanitizePackages(EMPTY_STATE);
    this.setCurrentState(sanitized, appearanceSha256(sanitized));
    return sanitized;
  }

  async commit(
    expectedRevision: number,
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withStorageLock(() => this.commitUnlocked(expectedRevision, state, signal));
  }

  private async commitUnlocked(
    expectedRevision: number,
    state: AppearancePersistedState,
    signal?: AbortSignal,
    currentState?: AppearancePersistedState,
    mutation: "ordinary" | "quarantine-restore" = "ordinary",
  ): Promise<void> {
    checkAbort(signal);
    const current = currentState ?? (await this.loadUnlocked(signal));
    if (current.revision !== expectedRevision) {
      throw new DesktopAppearanceStorageError(
        "revision-conflict",
        `Appearance revision ${expectedRevision} is stale; current revision is ${current.revision}.`,
        this.statePath,
      );
    }
    if (
      current.safeMode &&
      mutation !== "quarantine-restore" &&
      !isExplicitRecoveryReset(state) &&
      !isNarrowSafeRecoveryMutation(current, state)
    ) {
      throw new DesktopAppearanceStorageError(
        "invalid-state",
        "Appearance mutation is disabled while safe mode is active.",
        this.statePath,
      );
    }
    if (state.revision <= expectedRevision || decodeAppearancePersistedState(state) === null) {
      throw new DesktopAppearanceStorageError(
        "invalid-state",
        "Appearance state must decode and advance the revision.",
        this.statePath,
      );
    }
    if (!stateWithinAggregateBounds(state)) {
      throw new DesktopAppearanceStorageError(
        "invalid-state",
        "Appearance state exceeds aggregate count, order, diagnostic, or size bounds.",
        this.statePath,
      );
    }
    for (const snippet of state.snippets) {
      if (bytesFor(snippet.css).byteLength > MAX_CSS_BYTES) {
        throw new DesktopAppearanceStorageError(
          "invalid-state",
          `Snippet ${snippet.id} exceeds 1 MiB.`,
          snippet.id,
        );
      }
      try {
        validateAppearanceSnippetCss(snippet.css);
      } catch (error) {
        throw new DesktopAppearanceStorageError("invalid-state", errorMessage(error), snippet.id);
      }
    }
    await this.persistPackageTransaction(current, state, signal);
    this.setCurrentState(state, appearanceSha256(state));
    this.emit(state);
  }
  subscribe(listener: (state: AppearancePersistedState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(signal?: AbortSignal): Promise<ReadonlyArray<AppearanceStoredPackage>> {
    const state = await this.load(signal);
    return Object.values(state.packages);
  }

  async read(id: string, signal?: AbortSignal): Promise<AppearanceStoredPackage | null> {
    if (!isSafeId(id))
      throw new DesktopAppearanceStorageError("unsafe-path", "Invalid package id.", id);
    const state = await this.load(signal);
    return state.packages[id] ?? null;
  }

  async install(
    input: AppearancePackageInput | string,
    signal?: AbortSignal,
  ): Promise<AppearanceStoredPackage> {
    checkAbort(signal);
    const value =
      typeof input === "string"
        ? await this.packageFromSource(input, signal)
        : await this.packageFromInput(input);
    const id = packageId(value);
    if (!isSafeId(id))
      throw new DesktopAppearanceStorageError("unsafe-package", "Invalid package id.", id);
    const current = await this.load(signal);
    if (current.safeMode) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Appearance package installation is disabled while safe mode is active.",
        id,
      );
    }
    const installed = {
      ...value,
      enabled: false,
    };
    const nextPackages: Record<string, AppearanceStoredPackage> = {
      ...current.packages,
      [id]: installed,
    };
    const nextOrder = current.order.includes(id) ? [...current.order] : [...current.order, id];
    const next: AppearancePersistedState = {
      ...current,
      revision: current.revision + 1,
      packages: nextPackages,
      order: nextOrder,
    };
    await this.commit(current.revision, next, signal);
    return installed;
  }

  export(id: string, signal?: AbortSignal): Promise<AppearanceStoredPackage>;
  export(id: string, destinationPath: string, signal?: AbortSignal): Promise<string>;
  async export(
    id: string,
    destinationPathOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
  ): Promise<AppearanceStoredPackage | string> {
    const destinationPath =
      typeof destinationPathOrSignal === "string" ? destinationPathOrSignal : undefined;
    const operationSignal =
      typeof destinationPathOrSignal === "string" ? signal : destinationPathOrSignal;
    const value = await this.read(id, operationSignal);
    if (value === null)
      throw new DesktopAppearanceStorageError("not-found", "Appearance package not found.", id);
    if (destinationPath === undefined) return value;
    const destination = Path.resolve(destinationPath);
    await this.writeExportAtomic(
      destination,
      bytesFor(JSON.stringify(packageDocument(value)) + "\n"),
      operationSignal,
    );
    return destination;
  }

  revealPath(id?: string): string {
    return id === undefined ? this.appearanceRoot : this.packagePath(id);
  }

  watch(listener?: (state: AppearancePersistedState) => void): () => void {
    if (listener !== undefined) this.watchListeners.add(listener);
    this.startWatcher();
    return () => {
      if (listener !== undefined) this.watchListeners.delete(listener);
      if (listener === undefined || this.watchListeners.size === 0) this.closeWatchers();
    };
  }

  private startWatcher(): void {
    if (this.watchRunning) return;
    for (const root of [this.appearanceRoot, this.packagesRoot]) {
      try {
        const watcher = watchFileSystem(root, { recursive: true }, () => this.scheduleWatchRead());
        const retire = (): void => {
          watcher.close();
          this.watchers.delete(watcher);
          if (this.watchers.size === 0) {
            this.watchRunning = false;
            this.scheduleWatcherRetry();
          }
        };
        watcher.on("error", retire);
        watcher.on("close", () => {
          this.watchers.delete(watcher);
          if (this.watchers.size === 0) {
            this.watchRunning = false;
            this.scheduleWatcherRetry();
          }
        });
        this.watchers.add(watcher);
      } catch {
        // A parent watcher may still cover this path; retry only if neither root succeeded.
      }
    }
    this.watchRunning = this.watchers.size > 0;
    if (!this.watchRunning) this.scheduleWatcherRetry();
  }

  private scheduleWatcherRetry(): void {
    if (this.watchRetryTimer !== null || this.watchListeners.size === 0) return;
    this.watchRetryTimer = setTimeout(() => {
      this.watchRetryTimer = null;

      void this.ensureLayout()
        .then(() => this.startWatcher())
        .catch(() => this.scheduleWatcherRetry());
    }, WATCH_DEBOUNCE_MS);
  }
  async setSafeMode(enabled: boolean, signal?: AbortSignal): Promise<AppearancePersistedState> {
    const current = await this.load(signal);
    if (!enabled) {
      throw new DesktopAppearanceStorageError(
        "invalid-state",
        "Reset appearance to leave safe mode.",
        this.statePath,
      );
    }
    if (current.safeMode) return current;
    const next: AppearancePersistedState = {
      ...current,
      revision: current.revision + 1,
      safeMode: true,
    };
    await this.commit(current.revision, next, signal);
    return next;
  }

  async reset(signal?: AbortSignal): Promise<AppearancePersistedState> {
    return this.withStorageLock(async () => {
      const current = await this.loadUnlocked(signal);
      const token = `${Date.now()}-${randomUUID()}`;
      const stagedPackages = this.contained("appearance", "quarantine", `reset-packages-${token}`);
      const stagedState = this.contained("appearance", "quarantine", `reset-state-${token}.json`);
      await this.ensureDirectory(this.quarantineRoot);
      let moved = false;
      let committed: AppearancePersistedState | null = null;
      try {
        await this.assertOwned(this.packagesRoot, true);
        await this.renamePath(this.packagesRoot, stagedPackages);
        moved = true;
        await this.ensureDirectory(this.packagesRoot);
        await this.writeStateFile(current, stagedState, signal);
        const next: AppearancePersistedState = {
          ...EMPTY_STATE,
          revision: Math.max(current.revision + 1, Date.now()),
          migration: { completed: true },
        };
        await this.commitUnlocked(current.revision, next, signal, current);
        committed = next;

        const priorPackages = this.contained("appearance", "quarantine", `prior-packages-${token}`);
        const priorState = this.contained("appearance", "quarantine", `prior-state-${token}.json`);
        let priorPackagesMoved = false;
        let priorStateMoved = false;
        let stagedPackagesPublished = false;
        let stagedStatePublished = false;
        try {
          await this.renamePath(this.quarantinePackagesPath, priorPackages)
            .then(() => {
              priorPackagesMoved = true;
            })
            .catch((error: unknown) => {
              if (!isMissing(error)) throw error;
            });
          await this.renamePath(this.quarantineStatePath, priorState)
            .then(() => {
              priorStateMoved = true;
            })
            .catch((error: unknown) => {
              if (!isMissing(error)) throw error;
            });
          await this.renamePath(stagedPackages, this.quarantinePackagesPath);
          stagedPackagesPublished = true;
          await this.renamePath(stagedState, this.quarantineStatePath);
          stagedStatePublished = true;
        } catch (publishError) {
          if (stagedStatePublished) {
            await this.renamePath(this.quarantineStatePath, stagedState);
          }
          if (stagedPackagesPublished) {
            await this.renamePath(this.quarantinePackagesPath, stagedPackages);
          }
          if (priorStateMoved) await this.renamePath(priorState, this.quarantineStatePath);
          if (priorPackagesMoved) {
            await this.renamePath(priorPackages, this.quarantinePackagesPath);
          }
          await FileSystem.rm(this.packagesRoot, { recursive: true, force: true });
          await this.renamePath(stagedPackages, this.packagesRoot);
          await FileSystem.rm(stagedState, { force: true }).catch(() => undefined);
          const rollbackState: AppearancePersistedState = {
            ...current,
            revision: next.revision + 1,
          };
          await this.commitUnlocked(next.revision, rollbackState, signal, next);
          throw publishError;
        }
        await FileSystem.rm(priorPackages, { recursive: true, force: true }).catch(() => undefined);
        await FileSystem.rm(priorState, { force: true }).catch(() => undefined);
        return next;
      } catch (error) {
        if (moved && committed === null) {
          await FileSystem.rm(this.packagesRoot, { recursive: true, force: true }).catch(
            () => undefined,
          );
          await this.renamePath(stagedPackages, this.packagesRoot).catch(() => undefined);
          await FileSystem.rm(stagedState, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    });
  }
  async readQuarantinedState(): Promise<AppearancePersistedState | null> {
    const document = await this.readStateFile(this.quarantineStatePath, false);
    return document?.state ?? null;
  }

  async restoreQuarantinedState(signal?: AbortSignal): Promise<AppearancePersistedState> {
    return this.withStorageLock(async () => {
      const current = await this.loadUnlocked(signal);
      const recovery = await this.readStateFile(this.quarantineStatePath, false);
      if (recovery === null) {
        throw new DesktopAppearanceStorageError(
          "invalid-state",
          "No desktop appearance recovery state is available.",
          this.quarantineStatePath,
        );
      }
      await this.assertOwned(this.quarantinePackagesPath, true);
      const discarded = this.contained(
        "appearance",
        "quarantine",
        `discarded-${Date.now()}-${randomUUID()}`,
      );
      let movedCurrent = false;
      let committed = false;
      try {
        await this.assertOwned(this.packagesRoot, true);
        await this.renamePath(this.packagesRoot, discarded);
        movedCurrent = true;
        await this.renamePath(this.quarantinePackagesPath, this.packagesRoot);
        const next: AppearancePersistedState = {
          ...recovery.state,
          revision: Math.max(current.revision + 1, Date.now()),
          safeMode: false,
        };
        await this.commitUnlocked(current.revision, next, signal, current, "quarantine-restore");
        committed = true;
        await FileSystem.rm(this.quarantineStatePath, { force: true }).catch(() => undefined);
        await FileSystem.rm(discarded, { recursive: true, force: true }).catch(() => undefined);
        return next;
      } catch (error) {
        if (movedCurrent && !committed) {
          await this.renamePath(this.packagesRoot, this.quarantinePackagesPath).catch(
            () => undefined,
          );
          await this.renamePath(discarded, this.packagesRoot).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  close(): void {
    this.closeWatchers();
  }

  private contained(...parts: ReadonlyArray<string>): string {
    const candidate = Path.resolve(this.root, ...parts);
    const prefix = this.root.endsWith(Path.sep) ? this.root : `${this.root}${Path.sep}`;
    if (candidate !== this.root && !candidate.startsWith(prefix)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Path escapes the appearance storage root.",
        candidate,
      );
    }
    return candidate;
  }
  private async withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storageTailsByRoot.get(this.root) ?? Promise.resolve();
    const gate = Promise.withResolvers<void>();
    const next = previous.catch(() => undefined).then(() => gate.promise);
    storageTailsByRoot.set(this.root, next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      gate.resolve();
      void next.then(() => {
        if (storageTailsByRoot.get(this.root) === next) storageTailsByRoot.delete(this.root);
      });
    }
  }

  private packagePath(id: string): string {
    if (!isSafeId(id))
      throw new DesktopAppearanceStorageError("unsafe-path", "Invalid package id.", id);
    return this.contained("appearance", "packages", id);
  }

  private async ensureDirectory(path: string): Promise<void> {
    await FileSystem.mkdir(path, { recursive: true, mode: 0o700 });
    await this.assertOwned(path, true);
    await FileSystem.chmod(path, 0o700);
  }

  private async ensureLayout(): Promise<void> {
    await this.ensureRoot();
    await this.ensureDirectory(this.appearanceRoot);
    await this.ensureDirectory(this.packagesRoot);
    await this.ensureDirectory(this.quarantineRoot);
  }

  private async ensureRoot(): Promise<void> {
    await FileSystem.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await FileSystem.lstat(this.root).catch((error: unknown) => {
      throw new DesktopAppearanceStorageError("invalid-root", errorMessage(error), this.root);
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DesktopAppearanceStorageError(
        "invalid-root",
        "User-data root must be a real directory.",
        this.root,
      );
    }
    await FileSystem.chmod(this.root, 0o700);
  }

  private async assertOwned(path: string, allowDirectory: boolean): Promise<void> {
    const candidate = Path.resolve(path);
    const prefix = this.root.endsWith(Path.sep) ? this.root : `${this.root}${Path.sep}`;
    if (candidate !== this.root && !candidate.startsWith(prefix)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Path escapes the appearance storage root.",
        candidate,
      );
    }
    const relative = Path.relative(this.root, candidate);
    const components = relative.length === 0 ? [] : relative.split(Path.sep);
    let current = this.root;
    for (const component of components) {
      current = Path.join(current, component);
      const stat = await FileSystem.lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
        throw new DesktopAppearanceStorageError(
          "unsafe-path",
          "Links are not allowed in appearance storage.",
          current,
        );
      }
    }
    const finalStat = await FileSystem.lstat(candidate);
    if (allowDirectory && !finalStat.isDirectory()) {
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Expected an appearance directory.",
        candidate,
      );
    }
    if (!allowDirectory && !finalStat.isFile()) {
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Expected an appearance file.",
        candidate,
      );
    }
  }

  private async readBytes(path: string, maxBytes = MAX_PACKAGE_BYTES): Promise<Uint8Array | null> {
    try {
      await this.assertOwned(path, false);
      const before = await FileSystem.lstat(path);
      const realBefore = await FileSystem.realpath(path);
      const realRoot = await FileSystem.realpath(this.root);
      const rootPrefix = realRoot.endsWith(Path.sep) ? realRoot : `${realRoot}${Path.sep}`;
      if (
        before.size > maxBytes ||
        (realBefore !== realRoot && !realBefore.startsWith(rootPrefix))
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-path",
          "Appearance file exceeds its bound or resolves outside storage.",
          path,
        );
      }
      const handle = await FileSystem.open(path, FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size > maxBytes
        ) {
          throw new DesktopAppearanceStorageError(
            "unsafe-path",
            "Appearance file changed during discovery.",
            path,
          );
        }
        const bytes = new Uint8Array(await handle.readFile());
        const after = await FileSystem.lstat(path);
        const realAfter = await FileSystem.realpath(path);
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          realAfter !== realBefore ||
          bytes.byteLength !== opened.size
        ) {
          throw new DesktopAppearanceStorageError(
            "unsafe-path",
            "Appearance file changed during discovery.",
            path,
          );
        }
        return bytes;
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async writeBytesAtomic(
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const parent = Path.dirname(path);
    await this.ensureDirectory(parent);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await FileSystem.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await FileSystem.chmod(temporaryPath, 0o600);
      await this.renamePath(temporaryPath, path);
      await FileSystem.chmod(path, 0o600);
      await this.syncDirectory(parent);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await FileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async writeExportAtomic(
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const parent = Path.dirname(path);
    const parentStat = await FileSystem.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Export destination must have a real parent directory.",
        parent,
      );
    }
    const temporaryPath = Path.join(parent, `.${Path.basename(path)}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await FileSystem.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      checkAbort(signal);
      await this.renamePath(temporaryPath, path);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await FileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await FileSystem.open(path, "r");
      await handle.sync();
      await handle.close();
    } catch {
      // Some platforms do not permit fsync on directory handles.
    }
  }

  private async renamePath(source: string, target: string, signal?: AbortSignal): Promise<void> {
    const retryDelays =
      this.hostPlatform === "win32" ? WINDOWS_RENAME_RETRY_DELAYS_MS : ([] as const);
    let retryIndex = 0;
    while (true) {
      checkAbort(signal);
      try {
        await FileSystem.rename(source, target);
        return;
      } catch (error) {
        const delay = retryDelays[retryIndex];
        retryIndex += 1;
        if (delay === undefined || !isTransientWindowsRenameError(error)) throw error;
        await wait(delay);
      }
    }
  }

  private async persistPackageTransaction(
    current: AppearancePersistedState,
    next: AppearancePersistedState,
    signal?: AbortSignal,
  ): Promise<void> {
    const changed = Object.entries(next.packages).filter(([id, value]) => {
      const previous = current.packages[id];
      return previous === undefined || appearanceSha256(previous) !== appearanceSha256(value);
    });
    const removed = Object.keys(current.packages).filter((id) => next.packages[id] === undefined);
    if (changed.length === 0 && removed.length === 0) {
      await this.persistStateFiles(next, signal);
      return;
    }
    for (const [, value] of changed) this.validatePackageData(value);
    const transactionRoot = this.contained(
      "appearance",
      `.package-transaction.${process.pid}.${randomUUID()}`,
    );
    const stagedRoot = Path.join(transactionRoot, "staged");
    const backupRoot = Path.join(transactionRoot, "backup");
    await this.ensureDirectory(stagedRoot);
    await this.ensureDirectory(backupRoot);
    const affected = [...new Set([...changed.map(([id]) => id), ...removed])].sort();
    const moved: Array<{ readonly id: string; readonly hadPrevious: boolean }> = [];
    try {
      for (const [id, value] of changed) {
        await this.stagePackageDirectory(value, Path.join(stagedRoot, id), signal);
      }
      for (const id of affected) {
        checkAbort(signal);
        const target = this.packagePath(id);
        const backup = Path.join(backupRoot, id);
        let hadPrevious = false;
        try {
          await this.assertOwned(target, true);
          await this.renamePath(target, backup);
          hadPrevious = true;
        } catch (error: unknown) {
          if (!isNotFound(error)) throw error;
        }
        moved.push({ id, hadPrevious });
        if (next.packages[id] !== undefined) {
          await this.renamePath(Path.join(stagedRoot, id), target);
        }
      }
      await this.syncDirectory(this.packagesRoot);
      await this.persistStateFiles(next, signal);
    } catch (error) {
      for (const entry of moved.toReversed()) {
        const target = this.packagePath(entry.id);
        await FileSystem.rm(target, { recursive: true, force: true }).catch(() => undefined);
        if (entry.hadPrevious) {
          await this.renamePath(Path.join(backupRoot, entry.id), target).catch(() => undefined);
        }
      }
      await this.syncDirectory(this.packagesRoot);
      throw error;
    } finally {
      await FileSystem.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async writeStateFile(
    state: AppearancePersistedState,
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const document = stateDocument(state);
    await this.writeBytesAtomic(path, bytesFor(JSON.stringify(document) + "\n"), signal);
  }

  private async persistStateFiles(
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureLayout();
    const oldBytes = await this.readBytes(this.statePath, MAX_STATE_BYTES);
    const backupPath = this.contained("appearance", "state.last-good.json");
    try {
      await this.writeStateFile(state, this.statePath, signal);
      try {
        await this.writeStateFile(state, backupPath, signal);
      } catch (error) {
        if (oldBytes === null) {
          await FileSystem.rm(this.statePath, { force: true }).catch(() => undefined);
        } else {
          await this.writeBytesAtomic(this.statePath, oldBytes).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      throw new DesktopAppearanceStorageError("write-failed", errorMessage(error), this.statePath);
    }
  }

  private async readStateFile(
    path: string,
    quarantineMalformed: boolean,
  ): Promise<Readonly<{
    readonly state: AppearancePersistedState;
    readonly digest: string;
  }> | null> {
    const bytes = await this.readBytes(path, MAX_STATE_BYTES);
    if (bytes === null) return null;
    if (bytes.byteLength > MAX_STATE_BYTES) {
      if (quarantineMalformed) await this.quarantineFile(path).catch(() => undefined);
      return null;
    }
    const raw = new TextDecoder().decode(bytes);
    try {
      const document = decodeStateDocument(raw);
      const state = decodeAppearancePersistedState(document.state);
      if (
        state === null ||
        !stateWithinAggregateBounds(state) ||
        appearanceSha256(state) !== document.sha256
      )
        throw new Error("state checksum or invariant mismatch");
      return { state, digest: document.sha256 };
    } catch {
      if (quarantineMalformed) await this.quarantineFile(path).catch(() => undefined);
      return null;
    }
  }

  private async quarantineFile(path: string): Promise<void> {
    const stat = await FileSystem.lstat(path);
    if (stat.isSymbolicLink() || stat.nlink > 1) {
      await FileSystem.rm(path, { force: true });
      return;
    }
    await this.ensureDirectory(this.quarantineRoot);
    const target = this.contained(
      "appearance",
      "quarantine",
      `${Path.basename(path)}-${Date.now()}-${randomUUID()}`,
    );
    await this.renamePath(path, target);
    await FileSystem.chmod(target, 0o600);
  }

  private async sanitizePackages(
    state: AppearancePersistedState,
  ): Promise<AppearancePersistedState> {
    const packages: Record<string, AppearanceStoredPackage> = {};
    for (const id of Object.keys(state.packages)) {
      const packagePath = this.packagePath(id);
      const persisted = state.packages[id];
      if (persisted === undefined) continue;
      try {
        this.validatePackageData(persisted);
      } catch {
        await this.quarantineDirectory(packagePath).catch(() => undefined);
        continue;
      }
      const value = await this.readPackageDirectory(packagePath).catch(() => null);
      if (
        value === null ||
        packageId(value) !== id ||
        appearanceSha256(value) !== appearanceSha256(persisted)
      ) {
        await this.quarantineDirectory(packagePath).catch(() => undefined);
        try {
          await this.writePackageDirectory(persisted, packagePath);
        } catch {
          continue;
        }
      }
      packages[id] = persisted;
    }
    const entries = await FileSystem.readdir(this.packagesRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!isSafeId(entry.name)) {
        const temporaryPath = this.contained("appearance", "packages", entry.name);
        await this.quarantineDirectory(temporaryPath).catch(() => undefined);
        continue;
      }
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        packages[entry.name] !== undefined ||
        state.packages[entry.name] !== undefined
      )
        continue;
      const orphanPath = this.packagePath(entry.name);
      const value = await this.readPackageDirectory(orphanPath).catch(() => null);
      if (value === null) await this.quarantineDirectory(orphanPath).catch(() => undefined);
    }
    const order = state.order.filter((id) => packages[id] !== undefined);
    return { ...state, packages, order };
  }

  private async scanWatchedPackages(
    _state: AppearancePersistedState,
  ): Promise<WatchedPackageFiles | null> {
    const entries = await FileSystem.readdir(this.packagesRoot, { withFileTypes: true }).catch(
      () => null,
    );
    if (entries === null) return null;
    const byId: Record<string, ReadonlyArray<PackageFile>> = {};
    const checksums: Record<string, string> = {};
    const invalidIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const files = await this.scanDirectory(this.packagePath(entry.name)).catch(() => null);
      if (files === null) {
        invalidIds.add(entry.name);
        continue;
      }
      byId[entry.name] = files;
      checksums[entry.name] = packageFilesChecksum(files);
    }
    return { byId, checksums, invalidIds };
  }

  private async readStableWatchedPackages(state: AppearancePersistedState): Promise<Readonly<{
    readonly packages: Readonly<Record<string, AppearanceStoredPackage>>;
    readonly checksums: Readonly<Record<string, string>>;
    readonly order: ReadonlyArray<string>;
    readonly diagnostics: ReadonlyArray<AppearanceDiagnostic>;
  }> | null> {
    const first = await this.scanWatchedPackages(state);
    if (first === null) {
      this.scheduleInvalidWatchRetry();
      return null;
    }
    await wait(STABILITY_INTERVAL_MS);
    const second = await this.scanWatchedPackages(state);
    if (second === null) {
      this.scheduleInvalidWatchRetry();
      return null;
    }
    if (!sameChecksums(first.checksums, second.checksums)) {
      this.scheduleWatchRead(false);
      return null;
    }
    const watchRecovery = "Fix or reinstall this package; its last-good content was disabled.";
    const watcherDiagnostic = (id: string): AppearanceDiagnostic => ({
      code: "invalid-manifest",
      severity: "error",
      message: `Package ${id} could not be reloaded from its watched files.`,
      path: ["packages", id],
      recovery: watchRecovery,
      file: id,
    });
    const isWatcherDiagnostic = (diagnostic: AppearanceDiagnostic): boolean =>
      diagnostic.recovery === watchRecovery;
    const diagnostics = state.diagnostics.filter((diagnostic) => !isWatcherDiagnostic(diagnostic));
    const watcherDiagnosticFiles = new Set<string>();
    const appendWatcherDiagnostic = (diagnostic: AppearanceDiagnostic): void => {
      const file = diagnostic.file ?? "";
      if (watcherDiagnosticFiles.has(file)) return;
      watcherDiagnosticFiles.add(file);
      diagnostics.push(diagnostic);
    };
    const disablePrevious = (
      id: string,
      previous: AppearanceStoredPackage | undefined,
    ): AppearanceStoredPackage | undefined => {
      const diagnostic = watcherDiagnostic(id);
      appendWatcherDiagnostic(diagnostic);
      if (previous === undefined) return undefined;
      return {
        ...previous,
        enabled: false,
        diagnostics: [
          ...previous.diagnostics.filter((entry) => !isWatcherDiagnostic(entry)),
          diagnostic,
        ].slice(-MAX_STATE_DIAGNOSTICS),
      };
    };
    const packages: Record<string, AppearanceStoredPackage> = {};
    const ids = new Set([...Object.keys(state.packages), ...Object.keys(second.byId)]);
    for (const id of [...ids].sort()) {
      const previous = state.packages[id];
      const files = second.byId[id];
      if (second.invalidIds.has(id)) {
        const disabled = disablePrevious(id, previous);
        if (disabled !== undefined) packages[id] = disabled;
        continue;
      }
      if (files === undefined) continue;
      const value = await (
        previous === undefined
          ? this.packageFromNewWatchedFiles(id, files)
          : this.packageFromWatchedFiles(files, previous)
      ).catch(() => null);
      if (value === null || packageId(value) !== id) {
        const disabled = disablePrevious(id, previous);
        if (disabled !== undefined) packages[id] = disabled;
        continue;
      }
      packages[id] = previous === undefined ? { ...value, enabled: false } : value;
    }
    for (const value of Object.values(packages)) {
      const diagnostic = value.diagnostics.find(isWatcherDiagnostic);
      if (diagnostic !== undefined) appendWatcherDiagnostic(diagnostic);
    }
    const retainedOrder = state.order.filter((id) => packages[id] !== undefined);
    const added = Object.keys(packages)
      .filter((id) => !retainedOrder.includes(id))
      .sort();
    return {
      packages,
      checksums: packageChecksums(packages),
      order: [...retainedOrder, ...added],
      diagnostics: diagnostics.slice(-MAX_STATE_DIAGNOSTICS),
    };
  }
  private async packageFromNewWatchedFiles(
    id: string,
    files: ReadonlyArray<PackageFile>,
  ): Promise<AppearanceStoredPackage> {
    const storedFile = files.find((file) => file.relativePath === "package.json");
    if (storedFile === undefined) return this.packageFromFiles(this.packagePath(id), files);
    const document = decodePackageDocument(new TextDecoder().decode(storedFile.bytes));
    if (appearanceSha256(document.package) !== document.sha256) {
      throw new Error("copied package checksum differs");
    }
    return this.packageFromWatchedFiles(files, { ...document.package, enabled: false });
  }

  private async packageFromWatchedFiles(
    files: ReadonlyArray<PackageFile>,
    previous: AppearanceStoredPackage,
  ): Promise<AppearanceStoredPackage> {
    const packageDocument = files.find((file) => file.relativePath === "package.json");
    const manifestFile = files.find((file) => file.relativePath === "manifest.json");
    const diagnosticsFile = files.find((file) => file.relativePath === "diagnostics.json");
    if (
      packageDocument === undefined ||
      manifestFile === undefined ||
      diagnosticsFile === undefined
    )
      throw new Error("incomplete package files");
    const stored = decodePackageDocument(new TextDecoder().decode(packageDocument.bytes)).package;
    const diagnostics = decodeDiagnostics(new TextDecoder().decode(diagnosticsFile.bytes));
    if (appearanceSha256(diagnostics) !== appearanceSha256(previous.diagnostics))
      throw new Error("package diagnostics changed");
    const manifest = decodeManifest(new TextDecoder().decode(manifestFile.bytes));
    const sharedCss = await this.readDeclaredCss(
      files,
      manifest.styles?.web?.path,
      manifest.styles?.web?.sha256,
      manifest.styles?.web?.sizeBytes,
    );
    const desktopCss = await this.readDeclaredCss(
      files,
      manifest.styles?.desktop?.path,
      manifest.styles?.desktop?.sha256,
      manifest.styles?.desktop?.sizeBytes,
    );
    const declaredPaths = new Set<string>(["package.json", "manifest.json", "diagnostics.json"]);
    if (manifest.styles?.web !== undefined) declaredPaths.add(manifest.styles.web.path);
    if (manifest.styles?.desktop !== undefined) declaredPaths.add(manifest.styles.desktop.path);
    for (const asset of manifest.assets) declaredPaths.add(asset.path);
    for (const file of files) {
      if (!declaredPaths.has(file.relativePath)) throw new Error("undeclared package file");
    }
    const assets = manifest.assets.map((declaration) => {
      const file = files.find((candidate) => candidate.relativePath === declaration.path);
      if (
        file === undefined ||
        file.bytes.byteLength !== declaration.sizeBytes ||
        sha256Bytes(file.bytes) !== declaration.sha256
      )
        throw new Error("asset checksum or size mismatch");
      return {
        id: declaration.id,
        path: declaration.path,
        sha256: declaration.sha256,
        mimeType: declaration.mimeType,
        sizeBytes: declaration.sizeBytes,
        dataBase64: Buffer.from(file.bytes).toString("base64"),
      } satisfies AppearanceStoredAsset;
    });
    const rebuilt = await this.packageFromInput({
      input: manifest,
      trust: previous.profile.trust,
      ...(sharedCss === undefined ? {} : { sharedCss }),
      ...(desktopCss === undefined ? {} : { desktopCss }),
      assets,
    });
    // Manifests cannot carry migration provenance (a version 1 theme re-normalizes as version 2),
    // so unchanged profile content keeps the provenance recorded in package.json.
    const migration =
      hashAppearanceProfileContent(rebuilt.profile) === hashAppearanceProfileContent(stored.profile)
        ? stored.profile.migration
        : rebuilt.profile.migration;
    return {
      ...rebuilt,
      profile: { ...rebuilt.profile, migration },
      diagnostics: previous.diagnostics,
      enabled: previous.enabled,
    };
  }

  private async quarantineDirectory(path: string): Promise<void> {
    try {
      const candidate = Path.resolve(path);
      const prefix = this.root.endsWith(Path.sep) ? this.root : `${this.root}${Path.sep}`;
      if (candidate !== this.root && !candidate.startsWith(prefix))
        throw new DesktopAppearanceStorageError(
          "unsafe-path",
          "Path escapes the appearance storage root.",
          candidate,
        );
      const stat = await FileSystem.lstat(candidate);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) {
        await FileSystem.rm(candidate, { force: true });
        return;
      }
      await this.ensureDirectory(this.quarantineRoot);
      const target = this.contained(
        "appearance",
        "quarantine",
        `${Path.basename(candidate)}-${Date.now()}-${randomUUID()}`,
      );
      await this.renamePath(candidate, target);
      if (stat.isDirectory()) await this.chmodTree(target);
      else await FileSystem.chmod(target, 0o600);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async readPackageDirectory(path: string): Promise<AppearanceStoredPackage | null> {
    await this.assertOwned(path, true);
    const packageJson = Path.join(path, "package.json");
    const bytes = await this.readBytes(packageJson);
    if (bytes === null) return null;
    const document = decodePackageDocument(new TextDecoder().decode(bytes));
    if (appearanceSha256(document.package) !== document.sha256) return null;
    if (appearanceSha256(document.package.manifest) !== document.package.manifestHash) return null;
    const manifestBytes = await this.readBytes(Path.join(path, "manifest.json"));
    if (manifestBytes === null) return null;
    const onDiskManifest = decodeManifest(new TextDecoder().decode(manifestBytes));
    if (appearanceSha256(document.package.manifest) !== appearanceSha256(onDiskManifest))
      return null;
    if (!storedProfileMatchesManifest(onDiskManifest, document.package.profile)) return null;
    await this.verifyStoredPackageFiles(path, document.package);
    return document.package;
  }

  private async verifyStoredPackageFiles(
    path: string,
    value: AppearanceStoredPackage,
  ): Promise<void> {
    const files = await this.scanDirectory(path, undefined, {
      maxFiles: MAX_PACKAGE_FILES + 2,
      maxBytes: MAX_PACKAGE_BYTES * 3,
    });
    const allowedPaths = new Set<string>(["package.json", "manifest.json", "diagnostics.json"]);
    const sharedCssPath = value.manifest.styles?.web?.path;
    const desktopCssPath = value.manifest.styles?.desktop?.path;
    if (
      (value.sharedCss === undefined) !== (sharedCssPath === undefined) ||
      (value.desktopCss === undefined) !== (desktopCssPath === undefined)
    )
      throw new Error("stylesheet declaration mismatch");
    if (value.sharedCss !== undefined && sharedCssPath !== undefined)
      allowedPaths.add(sharedCssPath);
    if (value.desktopCss !== undefined && desktopCssPath !== undefined)
      allowedPaths.add(desktopCssPath);
    for (const asset of value.assets) allowedPaths.add(asset.path);
    for (const file of files) {
      if (!allowedPaths.has(file.relativePath)) throw new Error("undeclared package file");
    }
    const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    const packageFileCount = files.length;
    if (value.sharedCss !== undefined && sharedCssPath !== undefined) {
      const bytes = await this.readBytes(this.containedRelative(path, sharedCssPath));
      if (
        bytes === null ||
        new TextDecoder().decode(bytes) !== value.sharedCss ||
        bytes.byteLength > MAX_CSS_BYTES
      )
        throw new Error("invalid shared CSS");
    }
    if (value.desktopCss !== undefined && desktopCssPath !== undefined) {
      const bytes = await this.readBytes(this.containedRelative(path, desktopCssPath));
      if (
        bytes === null ||
        new TextDecoder().decode(bytes) !== value.desktopCss ||
        bytes.byteLength > MAX_CSS_BYTES
      )
        throw new Error("invalid desktop CSS");
    }
    const diagnosticsBytes = await this.readBytes(Path.join(path, "diagnostics.json"));
    if (
      diagnosticsBytes === null ||
      new TextDecoder().decode(diagnosticsBytes) !== JSON.stringify(value.diagnostics) + "\n"
    )
      throw new Error("invalid diagnostics");
    for (const asset of value.assets) {
      const assetPath = this.containedRelative(path, asset.path);
      const bytes = await this.readBytes(assetPath);
      if (
        bytes === null ||
        bytes.byteLength !== asset.sizeBytes ||
        sha256Bytes(bytes) !== asset.sha256
      )
        throw new Error("invalid asset");
    }
    if (packageFileCount > MAX_PACKAGE_FILES) throw new Error("package exceeds file bound");
    if (total > MAX_PACKAGE_BYTES) throw new Error("package exceeds size bound");
  }

  private containedRelative(base: string, relativePath: string): string {
    if (Path.isAbsolute(relativePath))
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Absolute package paths are not allowed.",
        relativePath,
      );
    const segments = relativePath.split(/[\\/]/u);
    if (
      segments.length > MAX_PATH_DEPTH ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new DesktopAppearanceStorageError("unsafe-path", "Unsafe package path.", relativePath);
    }
    const candidate = Path.resolve(base, ...segments);
    const prefix = base.endsWith(Path.sep) ? base : `${base}${Path.sep}`;
    if (!candidate.startsWith(prefix))
      throw new DesktopAppearanceStorageError(
        "unsafe-path",
        "Package path escapes its root.",
        relativePath,
      );
    return candidate;
  }

  private async writePackageDirectoryContents(
    value: AppearanceStoredPackage,
    target: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.writeBytesAtomic(
      Path.join(target, "package.json"),
      bytesFor(JSON.stringify(packageDocument(value)) + "\n"),
      signal,
    );
    await this.writeBytesAtomic(
      Path.join(target, "manifest.json"),
      bytesFor(JSON.stringify(value.manifest) + "\n"),
      signal,
    );
    await this.writeBytesAtomic(
      Path.join(target, "diagnostics.json"),
      bytesFor(JSON.stringify(value.diagnostics) + "\n"),
      signal,
    );
    const sharedCssPath = value.manifest.styles?.web?.path;
    if (value.sharedCss !== undefined && sharedCssPath !== undefined)
      await this.writeBytesAtomic(
        this.containedRelative(target, sharedCssPath),
        bytesFor(value.sharedCss),
        signal,
      );
    const desktopCssPath = value.manifest.styles?.desktop?.path;
    if (value.desktopCss !== undefined && desktopCssPath !== undefined)
      await this.writeBytesAtomic(
        this.containedRelative(target, desktopCssPath),
        bytesFor(value.desktopCss),
        signal,
      );
    for (const asset of value.assets) {
      const assetPath = this.containedRelative(target, asset.path);
      const data = decodeBase64(asset.dataBase64);
      if (
        data === null ||
        data.byteLength !== asset.sizeBytes ||
        sha256Bytes(data) !== asset.sha256
      )
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Asset checksum does not match its bytes.",
          asset.path,
        );
      if (data.byteLength > MAX_PACKAGE_BYTES)
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Asset exceeds package bounds.",
          asset.path,
        );
      await this.writeBytesAtomic(assetPath, data, signal);
    }
    await this.chmodTree(target);
  }

  private async stagePackageDirectory(
    value: AppearanceStoredPackage,
    target: string,
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    await this.ensureDirectory(target);
    await this.writePackageDirectoryContents(value, target, signal);
  }

  private async writePackageDirectory(
    value: AppearanceStoredPackage,
    target: string,
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const targetParent = this.containedRelative(
      this.appearanceRoot,
      Path.relative(this.appearanceRoot, Path.dirname(target)),
    );
    await this.ensureDirectory(targetParent);
    const temporaryPath = this.containedRelative(
      targetParent,
      `.${Path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await this.ensureDirectory(temporaryPath);
    try {
      await this.writePackageDirectoryContents(value, temporaryPath, signal);
      let backupPath: string | null = null;
      try {
        await this.assertOwned(target, true);
        backupPath = `${target}.previous-${randomUUID()}`;
        await this.renamePath(target, backupPath);
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
      }
      try {
        await this.renamePath(temporaryPath, target);
        await this.syncDirectory(targetParent);
      } catch (error) {
        if (backupPath !== null) await this.renamePath(backupPath, target).catch(() => undefined);
        throw error;
      }
      if (backupPath !== null) await FileSystem.rm(backupPath, { recursive: true, force: true });
    } finally {
      await FileSystem.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async chmodTree(path: string): Promise<void> {
    await FileSystem.chmod(path, 0o700);
    const entries = await FileSystem.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = Path.join(path, entry.name);
      const stat = await FileSystem.lstat(child);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new DesktopAppearanceStorageError(
          "unsafe-path",
          "Links are not allowed in packages.",
          child,
        );
      if (entry.isDirectory()) {
        await this.chmodTree(child);
      } else if (entry.isFile()) {
        await FileSystem.chmod(child, 0o600);
      } else {
        throw new DesktopAppearanceStorageError(
          "unsafe-path",
          "Special files are not allowed in packages.",
          child,
        );
      }
    }
  }

  private async packageFromInput(input: AppearancePackageInput): Promise<AppearanceStoredPackage> {
    let manifest: AppearanceManifestV2;
    try {
      manifest = decodeManifest(JSON.stringify(input.input));
    } catch (cause) {
      throw new DesktopAppearanceStorageError("unsafe-package", errorMessage(cause), "manifest");
    }
    const normalized = normalizeAppearance(input.input, {
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      trust: input.trust ?? DEFAULT_APPEARANCE_TRUST,
      platform: desktopPlatform(this.hostPlatform),
      ...(this.appVersion === undefined ? {} : { appVersion: this.appVersion }),
    });
    if (normalized.status === "failure")
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        normalized.diagnostic.message,
        "manifest",
      );
    const assets = input.assets ?? [];
    const value: AppearanceStoredPackage = {
      manifest,
      profile: normalized.profile,
      manifestHash: appearanceSha256(manifest),
      ...(input.sharedCss === undefined ? {} : { sharedCss: input.sharedCss }),
      ...(input.desktopCss === undefined ? {} : { desktopCss: input.desktopCss }),
      assets,
      diagnostics: [],
      enabled: true,
    };
    this.validatePackageData(value);
    return value;
  }

  private validatePackageData(value: AppearanceStoredPackage): void {
    const { manifest, profile, sharedCss, desktopCss, assets } = value;
    if (value.manifestHash !== appearanceSha256(manifest)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Manifest hash does not match the submitted manifest.",
        manifest.metadata.id,
      );
    }
    if (!storedProfileMatchesManifest(manifest, profile)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Manifest and normalized profile content differ.",
        "manifest",
      );
    }
    if (manifest.metadata.id !== profile.metadata.id)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Manifest and normalized profile ids differ.",
        "manifest",
      );
    if (bytesFor(JSON.stringify(manifest)).byteLength > MAX_MANIFEST_BYTES)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Manifest exceeds size bound.",
        "manifest.json",
      );
    const styles = manifest.styles;
    const claimedPaths = new Set(["package.json", "manifest.json", "diagnostics.json"]);
    const declaredPaths = [
      styles?.web?.path,
      styles?.desktop?.path,
      ...manifest.assets.map((asset) => asset.path),
    ];
    for (const path of declaredPaths) {
      if (path === undefined) continue;
      const folded = path.toLowerCase();
      if (claimedPaths.has(folded)) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package file paths must be distinct under case-insensitive filesystems.",
          path,
        );
      }
      claimedPaths.add(folded);
    }
    if ((sharedCss === undefined) !== (styles?.web === undefined)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Shared CSS checksum or declaration mismatch.",
        styles?.web?.path ?? "shared.css",
      );
    }
    if (sharedCss !== undefined) {
      if (
        styles?.web === undefined ||
        bytesFor(sharedCss).byteLength > MAX_CSS_BYTES ||
        sha256Bytes(bytesFor(sharedCss)) !== styles.web.sha256 ||
        bytesFor(sharedCss).byteLength !== styles.web.sizeBytes
      )
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Shared CSS checksum or declaration mismatch.",
          styles?.web?.path ?? "shared.css",
        );
    }
    if ((desktopCss === undefined) !== (styles?.desktop === undefined)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Desktop CSS checksum or declaration mismatch.",
        styles?.desktop?.path ?? "desktop.css",
      );
    }
    if (desktopCss !== undefined) {
      if (
        styles?.desktop === undefined ||
        bytesFor(desktopCss).byteLength > MAX_CSS_BYTES ||
        sha256Bytes(bytesFor(desktopCss)) !== styles.desktop.sha256 ||
        bytesFor(desktopCss).byteLength !== styles.desktop.sizeBytes
      )
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Desktop CSS checksum or declaration mismatch.",
          styles?.desktop?.path ?? "desktop.css",
        );
    }
    const assetPaths = new Set(assets.map((asset) => asset.path));
    for (const [path, source] of [
      [styles?.web?.path ?? "shared.css", sharedCss],
      [styles?.desktop?.path ?? "desktop.css", desktopCss],
    ] as const) {
      if (source === undefined) continue;
      try {
        validateAppearancePackageCss(source, assetPaths, path);
      } catch (error) {
        const message =
          error instanceof AppearanceCssValidationError
            ? error.diagnostics
                .map(
                  (diagnostic) =>
                    `error: ${diagnostic.file ?? path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
                )
                .join(" — ") + " Fix the reported CSS and retry the package import."
            : errorMessage(error);
        throw new DesktopAppearanceStorageError("unsafe-package", message, path);
      }
    }
    const packageFileCount =
      3 + (sharedCss === undefined ? 0 : 1) + (desktopCss === undefined ? 0 : 1) + assets.length;
    if (packageFileCount > MAX_PACKAGE_FILES)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package has too many files.",
        manifest.metadata.id,
      );
    if (assets.length > 256)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package has too many assets.",
        "assets",
      );
    const declarations = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    const ids = new Set<string>();
    let total =
      bytesFor(JSON.stringify(packageDocument(value)) + "\n").byteLength +
      bytesFor(JSON.stringify(manifest) + "\n").byteLength +
      bytesFor(JSON.stringify(value.diagnostics) + "\n").byteLength +
      bytesFor(sharedCss ?? "").byteLength +
      bytesFor(desktopCss ?? "").byteLength;
    for (const asset of assets) {
      if (ids.has(asset.id))
        throw new DesktopAppearanceStorageError("unsafe-package", "Duplicate asset id.", asset.id);
      ids.add(asset.id);
      const declaration = declarations.get(asset.id);
      const bytes = decodeBase64(asset.dataBase64);
      if (
        declaration === undefined ||
        bytes === null ||
        declaration.path !== asset.path ||
        declaration.sha256 !== asset.sha256 ||
        declaration.sizeBytes !== asset.sizeBytes ||
        bytes.byteLength !== asset.sizeBytes ||
        sha256Bytes(bytes) !== asset.sha256 ||
        !matchesAppearanceAssetSignature(asset.mimeType, bytes)
      )
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Asset declaration does not match bytes.",
          asset.path,
        );
      total += bytes.byteLength;
    }
    if (ids.size !== declarations.size)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Every declared asset must have matching bytes.",
        "assets",
      );
    if (total > MAX_PACKAGE_BYTES)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package exceeds aggregate size bound.",
        manifest.metadata.id,
      );
  }

  private async packageFromSource(
    source: string,
    signal?: AbortSignal,
  ): Promise<AppearanceStoredPackage> {
    const sourcePath = Path.resolve(source);
    const sourceStat = await FileSystem.lstat(sourcePath);
    if (sourceStat.isSymbolicLink() || (sourceStat.isFile() && sourceStat.nlink !== 1)) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package source must not be a link.",
        sourcePath,
      );
    }
    const files = sourceStat.isDirectory()
      ? await this.scanDirectory(sourcePath, signal)
      : sourceStat.isFile()
        ? await this.scanArchive(sourcePath, sourceStat.size, signal)
        : null;
    if (files === null) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package source must be a directory or ZIP archive.",
        sourcePath,
      );
    }
    return this.packageFromFiles(sourcePath, files);
  }

  private async packageFromFiles(
    sourcePath: string,
    files: ReadonlyArray<PackageFile>,
  ): Promise<AppearanceStoredPackage> {
    const exported = files.filter((file) => file.relativePath.endsWith(".t3appearance.json"));
    const exportFile = exported[0];
    if (exportFile !== undefined && exported.length === 1 && files.length === 1) {
      const document = decodePackageDocument(new TextDecoder().decode(exportFile.bytes));
      if (appearanceSha256(document.package) !== document.sha256) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Exported package checksum does not match.",
          exportFile.relativePath,
        );
      }
      const value = document.package;
      return this.packageFromInput({
        input: value.manifest,
        trust: {
          class: "local-package",
          allowSharedCss: value.sharedCss !== undefined,
          allowDesktopCss: value.desktopCss !== undefined,
          allowAdvancedSnippet: false,
        },
        ...(value.sharedCss === undefined ? {} : { sharedCss: value.sharedCss }),
        ...(value.desktopCss === undefined ? {} : { desktopCss: value.desktopCss }),
        assets: value.assets,
      });
    }
    const manifestFile = files.find((file) => file.relativePath === "manifest.json");
    if (manifestFile === undefined || manifestFile.bytes.byteLength > MAX_MANIFEST_BYTES)
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package manifest is missing or too large.",
        sourcePath,
      );
    const manifest = decodeManifest(new TextDecoder().decode(manifestFile.bytes));
    const sharedCss = await this.readDeclaredCss(
      files,
      manifest.styles?.web?.path,
      manifest.styles?.web?.sha256,
      manifest.styles?.web?.sizeBytes,
    );
    const desktopCss = await this.readDeclaredCss(
      files,
      manifest.styles?.desktop?.path,
      manifest.styles?.desktop?.sha256,
      manifest.styles?.desktop?.sizeBytes,
    );
    const declaredPaths = new Set<string>(["manifest.json"]);
    if (manifest.styles?.web !== undefined) declaredPaths.add(manifest.styles.web.path);
    if (manifest.styles?.desktop !== undefined) declaredPaths.add(manifest.styles.desktop.path);
    for (const asset of manifest.assets) declaredPaths.add(asset.path);
    for (const file of files) {
      if (!declaredPaths.has(file.relativePath)) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Undeclared package file.",
          file.relativePath,
        );
      }
    }
    const assets = manifest.assets.map((declaration) => {
      const file = files.find((candidate) => candidate.relativePath === declaration.path);
      if (
        file === undefined ||
        file.bytes.byteLength !== declaration.sizeBytes ||
        sha256Bytes(file.bytes) !== declaration.sha256
      )
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Asset checksum or size mismatch.",
          declaration.path,
        );
      return {
        id: declaration.id,
        path: declaration.path,
        sha256: declaration.sha256,
        mimeType: declaration.mimeType,
        sizeBytes: declaration.sizeBytes,
        dataBase64: Buffer.from(file.bytes).toString("base64"),
      } satisfies AppearanceStoredAsset;
    });
    return this.packageFromInput({
      input: manifest,
      trust: {
        class: "local-package",
        allowSharedCss: sharedCss !== undefined,
        allowDesktopCss: desktopCss !== undefined,
        allowAdvancedSnippet: false,
      },
      ...(sharedCss === undefined ? {} : { sharedCss }),
      ...(desktopCss === undefined ? {} : { desktopCss }),
      assets,
    });
  }

  private async readDeclaredCss(
    files: ReadonlyArray<PackageFile>,
    path: string | undefined,
    hash: string | undefined,
    size: number | undefined,
  ): Promise<string | undefined> {
    if (path === undefined || hash === undefined || size === undefined) return undefined;
    const file = files.find((candidate) => candidate.relativePath === path);
    if (
      file === undefined ||
      file.bytes.byteLength > MAX_CSS_BYTES ||
      file.bytes.byteLength !== size ||
      sha256Bytes(file.bytes) !== hash
    )
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Stylesheet checksum or size mismatch.",
        path,
      );
    return new TextDecoder().decode(file.bytes);
  }

  private async scanArchive(
    source: string,
    compressedSize: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<PackageFile>> {
    if (!/\.(?:zip|t3appearance)$/iu.test(source) || compressedSize > MAX_PACKAGE_BYTES) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package archive must be a bounded .zip or .t3appearance file.",
        source,
      );
    }
    checkAbort(signal);
    const before = await FileSystem.lstat(source);
    const realBefore = await FileSystem.realpath(source);
    const handle = await FileSystem.open(source, FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== compressedSize
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package archive changed during discovery.",
          source,
        );
      }
      bytes = new Uint8Array(await handle.readFile());
      const after = await FileSystem.lstat(source);
      const realAfter = await FileSystem.realpath(source);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        realAfter !== realBefore ||
        bytes.byteLength !== opened.size
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package archive changed during discovery.",
          source,
        );
      }
    } finally {
      await handle.close();
    }
    checkAbort(signal);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
    let endOffset = bytes.byteLength - 22;
    while (
      endOffset >= minimumOffset &&
      (endOffset < 0 ||
        view.getUint32(endOffset, true) !== 0x06054b50 ||
        endOffset + 22 + view.getUint16(endOffset + 20, true) !== bytes.byteLength)
    ) {
      endOffset -= 1;
    }
    if (endOffset < minimumOffset) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package archive has no valid ZIP directory.",
        source,
      );
    }
    const directorySize = view.getUint32(endOffset + 12, true);
    const directoryOffset = view.getUint32(endOffset + 16, true);
    const directoryEnd = directoryOffset + directorySize;
    if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package archive has an invalid ZIP directory.",
        source,
      );
    }
    let entryCount = 0;
    let totalUncompressed = 0;
    let offset = directoryOffset;
    while (offset < directoryEnd) {
      if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package archive has an invalid ZIP entry.",
          source,
        );
      }
      entryCount += 1;
      const flags = view.getUint16(offset + 8, true);
      const compressed = view.getUint32(offset + 20, true);
      const uncompressed = view.getUint32(offset + 24, true);
      if (
        entryCount > MAX_PACKAGE_FILES ||
        (flags & 1) !== 0 ||
        compressed === 0xffffffff ||
        uncompressed === 0xffffffff ||
        (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > 100))
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package archive entry exceeds safety bounds.",
          source,
        );
      }
      totalUncompressed += uncompressed;
      if (totalUncompressed > MAX_PACKAGE_BYTES) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package archive expands beyond the safe size bound.",
          source,
        );
      }
      offset +=
        46 +
        view.getUint16(offset + 28, true) +
        view.getUint16(offset + 30, true) +
        view.getUint16(offset + 32, true);
    }
    if (offset !== directoryEnd) {
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package archive has an invalid ZIP directory.",
        source,
      );
    }
    const archive = await JSZip.loadAsync(bytes);
    const files: PackageFile[] = [];
    const paths = new Set<string>();
    let totalInflatedBytes = 0;
    for (const rawEntry of Object.values(archive.files)) {
      checkAbort(signal);
      const entry = rawEntry as InspectableZipEntry;
      if (entry.dir) continue;
      const original = entry.unsafeOriginalName ?? entry.name;
      const path = original.replaceAll("\\", "/");
      const segments = path.split("/");
      const permissions =
        typeof entry.unixPermissions === "string"
          ? Number.parseInt(entry.unixPermissions, 8)
          : entry.unixPermissions;
      if (
        path.startsWith("/") ||
        segments.length > MAX_PATH_DEPTH + 1 ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
        !/\.(?:json|css|png|jpe?g|webp|avif|woff2)$/iu.test(path) ||
        (typeof permissions === "number" &&
          (((permissions & 0o170000) !== 0 && (permissions & 0o170000) !== 0o100000) ||
            (permissions & 0o111) !== 0)) ||
        paths.has(path.toLowerCase())
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package archive contains an unsafe or duplicate path.",
          path,
        );
      }
      paths.add(path.toLowerCase());
      const entryBytes = await readBoundedZipEntry(
        entry,
        MAX_PACKAGE_BYTES - totalInflatedBytes,
        source,
        signal,
      );
      totalInflatedBytes += entryBytes.byteLength;
      files.push({ relativePath: path, bytes: entryBytes });
    }
    if (files.some((file) => file.relativePath === "manifest.json")) return files;
    const roots = new Set(files.map((file) => file.relativePath.split("/")[0]));
    const root =
      roots.size === 1 && files.every((file) => file.relativePath.includes("/"))
        ? roots.values().next().value
        : undefined;
    return root === undefined
      ? files
      : files.map((file) => ({
          relativePath: file.relativePath.slice(root.length + 1),
          bytes: file.bytes,
        }));
  }

  private async scanDirectory(
    source: string,
    signal?: AbortSignal,
    limits: Readonly<{ maxFiles: number; maxBytes: number }> = {
      maxFiles: MAX_PACKAGE_FILES,
      maxBytes: MAX_PACKAGE_BYTES,
    },
  ): Promise<ReadonlyArray<PackageFile>> {
    const rootStat = await FileSystem.lstat(source).catch((error: unknown) => {
      throw new DesktopAppearanceStorageError("unsafe-package", errorMessage(error), source);
    });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new DesktopAppearanceStorageError(
        "unsafe-package",
        "Package source must be a real directory.",
        source,
      );
    const sourceReal = await FileSystem.realpath(source);
    const containsRealPath = (path: string): boolean =>
      path === sourceReal || path.startsWith(`${sourceReal}${Path.sep}`);
    const files: PackageFile[] = [];
    let totalBytes = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      checkAbort(signal);
      if (depth > MAX_PATH_DEPTH)
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package path is too deep.",
          directory,
        );
      const directoryBefore = await FileSystem.lstat(directory);
      const directoryRealBefore = await FileSystem.realpath(directory);
      if (
        !directoryBefore.isDirectory() ||
        directoryBefore.isSymbolicLink() ||
        !containsRealPath(directoryRealBefore)
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package directory changed during discovery.",
          directory,
        );
      }
      const entries = await FileSystem.readdir(directory, { withFileTypes: true });
      const directoryAfter = await FileSystem.lstat(directory);
      const directoryRealAfter = await FileSystem.realpath(directory);
      if (
        directoryAfter.dev !== directoryBefore.dev ||
        directoryAfter.ino !== directoryBefore.ino ||
        directoryRealAfter !== directoryRealBefore ||
        !containsRealPath(directoryRealAfter)
      ) {
        throw new DesktopAppearanceStorageError(
          "unsafe-package",
          "Package directory changed during discovery.",
          directory,
        );
      }
      for (const entry of entries) {
        const child = Path.join(directory, entry.name);
        const stat = await FileSystem.lstat(child);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
          throw new DesktopAppearanceStorageError(
            "unsafe-package",
            "Package links are not allowed.",
            child,
          );
        if (stat.isDirectory()) {
          await visit(child, depth + 1);
        } else if (stat.isFile()) {
          if ((stat.mode & 0o111) !== 0)
            throw new DesktopAppearanceStorageError(
              "unsafe-package",
              "Executable package files are not allowed.",
              child,
            );
          if (files.length >= limits.maxFiles || totalBytes + stat.size > limits.maxBytes)
            throw new DesktopAppearanceStorageError(
              "unsafe-package",
              "Package exceeds file or size bounds.",
              child,
            );
          const relativePath = Path.relative(source, child).split(Path.sep).join("/");
          if (
            relativePath.split("/").length > MAX_PATH_DEPTH ||
            relativePath
              .split("/")
              .some((segment) => segment === ".." || segment === "." || segment === "")
          )
            throw new DesktopAppearanceStorageError(
              "unsafe-package",
              "Unsafe package path.",
              relativePath,
            );
          if (/\.(?:html?|(?:m|c)?js)$/iu.test(relativePath))
            throw new DesktopAppearanceStorageError(
              "unsafe-package",
              "HTML and JavaScript package files are not allowed.",
              relativePath,
            );
          const handle = await FileSystem.open(
            child,
            FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW,
          );
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              opened.dev !== stat.dev ||
              opened.ino !== stat.ino
            ) {
              throw new DesktopAppearanceStorageError(
                "unsafe-package",
                "Package file changed during discovery.",
                child,
              );
            }
            const bytes = new Uint8Array(await handle.readFile());
            const after = await FileSystem.lstat(child);
            const real = await FileSystem.realpath(child);
            if (
              after.dev !== opened.dev ||
              after.ino !== opened.ino ||
              !containsRealPath(real) ||
              bytes.byteLength !== opened.size
            ) {
              throw new DesktopAppearanceStorageError(
                "unsafe-package",
                "Package file changed during discovery.",
                child,
              );
            }
            files.push({ relativePath, bytes });
            totalBytes += bytes.byteLength;
          } finally {
            await handle.close();
          }
        } else {
          throw new DesktopAppearanceStorageError(
            "unsafe-package",
            "Special package files are not allowed.",
            child,
          );
        }
      }
    };
    await visit(source, 0);
    return files;
  }

  private setCurrentState(state: AppearancePersistedState, digest: string): void {
    this.currentState = state;
    this.currentDigest = digest;
    this.currentPackageChecksums = packageChecksums(state.packages);
  }

  private emit(state: AppearancePersistedState, external = false): void {
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A consumer cannot turn a durable commit into an apparent failure.
      }
    }
    if (!external) return;
    for (const listener of this.watchListeners) {
      try {
        listener(state);
      } catch {
        // Watch consumers are isolated from persistence and each other.
      }
    }
  }

  private scheduleWatchRead(externalEvent = true): void {
    if (externalEvent) this.watchGeneration += 1;
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.watchReadTail = this.watchReadTail
        .then(
          () => this.readStableExternalState(),
          () => this.readStableExternalState(),
        )
        .catch(() => undefined);
    }, WATCH_DEBOUNCE_MS);
  }

  private scheduleInvalidWatchRetry(): void {
    if (this.invalidRetryGeneration === this.watchGeneration) return;
    this.invalidRetryGeneration = this.watchGeneration;
    this.scheduleWatchRead(false);
  }

  private async readStableExternalState(): Promise<void> {
    await this.withStorageLock(() => this.readStableExternalStateUnlocked());
  }

  private async restorePackageDirectories(
    authoritative: AppearancePersistedState,
    previous: AppearancePersistedState | null,
  ): Promise<void> {
    const affected = new Set([
      ...Object.keys(previous?.packages ?? {}),
      ...Object.keys(authoritative.packages),
    ]);
    for (const id of affected) {
      const value = authoritative.packages[id];
      if (value === undefined) {
        await FileSystem.rm(this.packagePath(id), { recursive: true, force: true });
      } else {
        this.validatePackageData(value);
        await this.writePackageDirectory(value, this.packagePath(id));
      }
    }
    await this.syncDirectory(this.packagesRoot);
  }

  private async readStableExternalStateUnlocked(): Promise<void> {
    const loaded = await this.readStateFile(this.statePath, false);
    const current = this.currentState;
    const observed =
      current === null || (loaded !== null && loaded.state.revision > current.revision)
        ? loaded?.state
        : current;
    if (observed === undefined) return;
    if (current === null) {
      this.setCurrentState(observed, loaded?.digest ?? appearanceSha256(observed));
    }
    const externalRevision =
      current !== null && loaded !== null && loaded.state.revision > current.revision;
    if (observed.safeMode) {
      if (externalRevision && loaded !== null) {
        this.setCurrentState(observed, loaded.digest);
        this.emit(observed, true);
      }
      return;
    }
    const watched = await this.readStableWatchedPackages(observed);
    if (externalRevision) {
      if (
        watched === null ||
        !sameChecksums(packageChecksums(observed.packages), watched.checksums)
      ) {
        try {
          await this.restorePackageDirectories(observed, current);
        } catch {
          return;
        }
      }
      this.setCurrentState(observed, loaded.digest);
      this.emit(observed, true);
      return;
    }
    if (watched === null) return;
    const packageChanged =
      !sameChecksums(this.currentPackageChecksums, watched.checksums) ||
      appearanceSha256(observed.diagnostics) !== appearanceSha256(watched.diagnostics);
    if (!packageChanged) return;
    if (packageChanged) {
      const next: AppearancePersistedState = {
        ...observed,
        revision: Math.max(current?.revision ?? observed.revision, observed.revision) + 1,
        packages: watched.packages,
        order: watched.order,
        diagnostics: watched.diagnostics,
      };
      const previousPackages = (current ?? observed).packages;
      const affected = new Set([
        ...Object.keys(previousPackages),
        ...Object.keys(watched.packages),
      ]);
      const latest = await this.readStateFile(this.statePath, false);
      if (
        (latest === null && observed.revision !== 0) ||
        (latest !== null &&
          (latest.state.revision !== observed.revision ||
            appearanceSha256(latest.state) !== appearanceSha256(observed)))
      ) {
        if (latest !== null) this.setCurrentState(latest.state, latest.digest);
        this.scheduleInvalidWatchRetry();
        return;
      }
      try {
        for (const id of affected) {
          if (this.currentPackageChecksums[id] === watched.checksums[id]) continue;
          const value = watched.packages[id];
          if (value === undefined) {
            await FileSystem.rm(this.packagePath(id), { recursive: true, force: true });
          } else {
            await this.writePackageDirectory(value, this.packagePath(id));
          }
        }
        await this.persistStateFiles(next);
      } catch {
        for (const id of affected) {
          if (this.currentPackageChecksums[id] === watched.checksums[id]) continue;
          const previous = previousPackages[id];
          if (previous === undefined) {
            await FileSystem.rm(this.packagePath(id), { recursive: true, force: true }).catch(
              () => undefined,
            );
          } else {
            await this.writePackageDirectory(previous, this.packagePath(id)).catch(() => undefined);
          }
        }
        await this.syncDirectory(this.packagesRoot);
        return;
      }
      this.setCurrentState(next, appearanceSha256(next));
      this.emit(next, true);
      return;
    }
    this.setCurrentState(
      observed,
      loaded?.digest ?? this.currentDigest ?? appearanceSha256(observed),
    );
    this.emit(observed, true);
  }

  private closeWatchers(): void {
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    if (this.watchRetryTimer !== null) clearTimeout(this.watchRetryTimer);
    this.watchTimer = null;
    this.watchRetryTimer = null;
    this.watchRunning = false;
    this.watchListeners.clear();
    for (const watcher of this.watchers) watcher.close();
    this.watchers.clear();
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export const desktopAppearanceStorageConstants = {
  MAX_MANIFEST_BYTES,
  MAX_CSS_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_PATH_DEPTH,
};
