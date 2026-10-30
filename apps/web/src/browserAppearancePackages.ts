import {
  decodeAppearanceStoredPackage,
  type AppearancePackageInput,
  type AppearanceRuntime,
  type AppearanceSnippet,
  type AppearanceStoredAsset,
  type AppearanceStoredPackage,
} from "@t3tools/client-runtime/appearance";
import {
  appearanceBytesSha256,
  appearanceSha256,
  matchesAppearanceAssetSignature,
  normalizeAppearance,
  APPEARANCE_MANIFEST_VERSION,
  APPEARANCE_SCHEMA_ID,
  type AppearanceDiagnostic,
  type AppearanceManifestV2,
  type AppearancePlatform,
  type AppearanceTrust,
  type NormalizedAppearanceProfile,
} from "@t3tools/shared/appearance";
import { APP_VERSION } from "./branding";
import JSZip from "jszip";

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_DOCUMENT_BYTES = 30 * 1024 * 1024;
const MAX_PACKAGE_FILES = 256;
const MAX_PATH_DEPTH = 8;
const MAX_COMPRESSION_RATIO = 100;
function packageInspectionPlatform(): AppearancePlatform {
  const platform =
    typeof window === "undefined" ? undefined : window.desktopBridge?.getClientPlatform?.();
  if (platform === "darwin") return "desktop-macos";
  if (platform === "win32") return "desktop-windows";
  if (platform === "linux") return "desktop-linux";
  return "web";
}

const PACKAGE_DOCUMENT_SCHEMA = "t3.appearance/package/v1";
const SNIPPET_BUNDLE_SCHEMA = "t3.appearance/snippets/v1";

type InspectableZipEntry = JSZip.JSZipObject & {
  readonly _data?: { readonly uncompressedSize?: unknown };
  readonly unsafeOriginalName?: string;
  readonly internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
};

export interface BrowserAppearancePackageReview {
  readonly manifest: AppearanceManifestV2;
  readonly input: AppearancePackageInput;
  readonly profile: NormalizedAppearanceProfile;
  readonly diagnostics: ReadonlyArray<AppearanceDiagnostic>;
  readonly capabilities: ReadonlyArray<string>;
  readonly trust: AppearanceTrust;
  readonly replacing: boolean;
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Appearance package JSON is malformed.");
  }
}

function normalizedPath(raw: string): string {
  const path = raw.replaceAll("\\", "/");
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    segments.length > MAX_PATH_DEPTH + 1 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe package path: ${raw}`);
  }
  return segments.join("/");
}

function inspectZipDirectory(bytes: Uint8Array): void {
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
  if (endOffset < minimumOffset) throw new Error("Appearance archive has no valid ZIP directory.");
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
    throw new Error("Appearance archive has an invalid ZIP directory.");
  }
  let offset = directoryOffset;
  let entries = 0;
  let total = 0;
  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Appearance archive has an invalid ZIP entry.");
    }
    entries += 1;
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    total += uncompressed;
    if (
      entries > MAX_PACKAGE_FILES ||
      total > MAX_PACKAGE_BYTES ||
      (flags & 1) !== 0 ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO))
    ) {
      throw new Error("Appearance archive exceeds count, size, encryption, or compression bounds.");
    }
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  if (offset !== directoryEnd) throw new Error("Appearance archive has an invalid ZIP directory.");
}
function readBoundedZipEntry(
  entry: InspectableZipEntry,
  remainingBytes: number,
): Promise<Uint8Array> {
  const expectedBytes = entry._data?.uncompressedSize;
  if (
    typeof expectedBytes !== "number" ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > remainingBytes ||
    entry.internalStream === undefined
  ) {
    throw new Error("Appearance archive expands beyond its declared or safe size bound.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = entry.internalStream!("uint8array");
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > expectedBytes || byteLength > remainingBytes) {
          settled = true;
          stream.pause();
          reject(new Error("Appearance archive expands beyond its declared or safe size bound."));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        reject(cause);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        if (byteLength !== expectedBytes) {
          reject(new Error("Appearance archive expands beyond its declared or safe size bound."));
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function archiveFiles(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  inspectZipDirectory(bytes);
  const archive = await JSZip.loadAsync(bytes);
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const rawEntry of Object.values(archive.files)) {
    const entry = rawEntry as InspectableZipEntry;
    if (entry.dir) continue;
    const path = normalizedPath(entry.unsafeOriginalName ?? entry.name);
    if (
      !/\.(?:json|css|png|jpe?g|webp|avif|woff2)$/iu.test(path) ||
      files.has(path.toLowerCase())
    ) {
      throw new Error(`Appearance archive contains an unsafe or duplicate file: ${path}`);
    }
    const value = await readBoundedZipEntry(entry, MAX_PACKAGE_BYTES - totalBytes);
    totalBytes += value.byteLength;
    files.set(path.toLowerCase(), value);
  }
  if (files.has("manifest.json")) return files;
  const paths = [...files.keys()];
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  if (roots.size !== 1 || paths.some((path) => !path.includes("/"))) return files;
  const root = roots.values().next().value;
  if (root === undefined) return files;
  const stripped = new Map<string, Uint8Array>();
  for (const path of paths) {
    const value = files.get(path);
    if (value === undefined) throw new Error("Appearance archive changed during inspection.");
    stripped.set(path.slice(root.length + 1), value);
  }
  return stripped;
}

function trustFor(sharedCss: string | undefined, desktopCss: string | undefined): AppearanceTrust {
  return {
    class: "local-package",
    allowSharedCss: sharedCss !== undefined,
    allowDesktopCss: desktopCss !== undefined,
    allowAdvancedSnippet: false,
  };
}

function manifestFromProfile(profile: NormalizedAppearanceProfile): AppearanceManifestV2 {
  return {
    schema: APPEARANCE_SCHEMA_ID,
    version: APPEARANCE_MANIFEST_VERSION,
    metadata: profile.metadata,
    compatibility: profile.compatibility,
    capabilities: profile.capabilities,
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
      terminal: variant.terminal,
      syntax: variant.syntax,
      diff: variant.diff,
      artwork: variant.artwork,
    })),
    assets: profile.assets,
    styles: profile.styles,
    presentation: profile.presentation,
  };
}

function inputFromStored(value: AppearanceStoredPackage): AppearancePackageInput {
  return {
    input: value.manifest,
    trust: trustFor(value.sharedCss, value.desktopCss),
    ...(value.sharedCss === undefined ? {} : { sharedCss: value.sharedCss }),
    ...(value.desktopCss === undefined ? {} : { desktopCss: value.desktopCss }),
    assets: value.assets,
  };
}
function verifyStoredPackageContents(value: AppearanceStoredPackage): void {
  for (const [name, source, declaration] of [
    ["shared CSS", value.sharedCss, value.manifest.styles?.web],
    ["desktop CSS", value.desktopCss, value.manifest.styles?.desktop],
  ] as const) {
    if ((source === undefined) !== (declaration === undefined)) {
      throw new Error(`Stored package has an incomplete ${name} declaration.`);
    }
    if (source === undefined || declaration === undefined) continue;
    const bytes = new TextEncoder().encode(source);
    if (
      bytes.byteLength !== declaration.sizeBytes ||
      appearanceBytesSha256(bytes) !== declaration.sha256
    ) {
      throw new Error(`Stylesheet checksum or size differs for ${declaration.path}.`);
    }
  }
  const declarations = new Map(value.manifest.assets.map((asset) => [asset.id, asset]));
  if (declarations.size !== value.assets.length) {
    throw new Error("Stored package asset declarations do not match stored assets.");
  }
  for (const asset of value.assets) {
    const declaration = declarations.get(asset.id);
    if (
      declaration === undefined ||
      declaration.path !== asset.path ||
      declaration.sizeBytes !== asset.sizeBytes ||
      declaration.sha256 !== asset.sha256 ||
      declaration.mimeType !== asset.mimeType
    ) {
      throw new Error(`Asset declaration differs for ${asset.path}.`);
    }
    let bytes: Uint8Array;
    try {
      const decoded = globalThis.atob(asset.dataBase64);
      bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } catch {
      throw new Error(`Asset data is not valid base64 for ${asset.path}.`);
    }
    if (
      bytes.byteLength !== declaration.sizeBytes ||
      appearanceBytesSha256(bytes) !== declaration.sha256 ||
      !matchesAppearanceAssetSignature(declaration.mimeType, bytes)
    ) {
      throw new Error(`Asset checksum, size, or MIME signature differs for ${asset.path}.`);
    }
  }
}

async function inputFromZip(bytes: Uint8Array): Promise<AppearancePackageInput> {
  const files = await archiveFiles(bytes);
  const manifestBytes = files.get("manifest.json");
  if (manifestBytes === undefined || manifestBytes.byteLength > 256 * 1024) {
    throw new Error("Appearance archive has no bounded manifest.json.");
  }

  const manifest = parseJson(new TextDecoder().decode(manifestBytes));
  if (typeof manifest !== "object" || manifest === null) throw new Error("Manifest is invalid.");
  const normalized = normalizeAppearance(manifest, {
    trust: {
      class: "local-package",
      allowSharedCss: true,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    },
    appVersion: APP_VERSION,
    platform: packageInspectionPlatform(),
  });
  if (normalized.status === "failure") throw new Error(normalized.diagnostic.message);
  const style = normalized.profile.styles;
  const readCss = (
    path: string | undefined,
    hash: string | undefined,
    size: number | undefined,
  ) => {
    if (path === undefined || hash === undefined || size === undefined) return undefined;
    const value = files.get(path.toLowerCase());
    if (value === undefined || value.byteLength !== size || appearanceBytesSha256(value) !== hash) {
      throw new Error(`Stylesheet checksum or size differs for ${path}.`);
    }
    return new TextDecoder().decode(value);
  };
  const sharedCss = readCss(style?.web?.path, style?.web?.sha256, style?.web?.sizeBytes);
  const desktopCss = readCss(
    style?.desktop?.path,
    style?.desktop?.sha256,
    style?.desktop?.sizeBytes,
  );
  const assets: AppearanceStoredAsset[] = normalized.profile.assets.map((declaration) => {
    const value = files.get(declaration.path.toLowerCase());
    if (
      value === undefined ||
      value.byteLength !== declaration.sizeBytes ||
      appearanceBytesSha256(value) !== declaration.sha256 ||
      !matchesAppearanceAssetSignature(declaration.mimeType, value)
    ) {
      throw new Error(`Asset checksum, size, or MIME signature differs for ${declaration.path}.`);
    }
    return {
      id: declaration.id,
      path: declaration.path,
      sha256: declaration.sha256,
      mimeType: declaration.mimeType,
      sizeBytes: declaration.sizeBytes,
      dataBase64: bytesToBase64(value),
    };
  });
  const declared = new Set([
    "manifest.json",
    ...(style?.web === undefined ? [] : [style.web.path.toLowerCase()]),
    ...(style?.desktop === undefined ? [] : [style.desktop.path.toLowerCase()]),
    ...assets.map((asset) => asset.path.toLowerCase()),
  ]);
  if ([...files.keys()].some((path) => !declared.has(path))) {
    throw new Error("Appearance archive contains an undeclared file.");
  }
  return {
    input: manifest,
    trust: trustFor(sharedCss, desktopCss),
    ...(sharedCss === undefined ? {} : { sharedCss }),
    ...(desktopCss === undefined ? {} : { desktopCss }),
    assets,
  };
}

export async function inspectBrowserAppearancePackage(
  name: string,
  bytes: Uint8Array,
  installedIds: ReadonlySet<string> = new Set(),
): Promise<BrowserAppearancePackageReview> {
  const maxBytes = name.toLowerCase().endsWith(".t3appearance.json")
    ? MAX_PACKAGE_DOCUMENT_BYTES
    : MAX_PACKAGE_BYTES;
  if (bytes.byteLength > maxBytes) throw new Error("Appearance package exceeds its size bound.");
  let input: AppearancePackageInput;
  if (/\.(?:zip|t3appearance)$/iu.test(name)) {
    input = await inputFromZip(bytes);
  } else {
    const document = parseJson(new TextDecoder().decode(bytes));
    if (
      typeof document !== "object" ||
      document === null ||
      !("schema" in document) ||
      document.schema !== PACKAGE_DOCUMENT_SCHEMA ||
      !("package" in document) ||
      !("sha256" in document) ||
      typeof document.sha256 !== "string"
    ) {
      throw new Error("Appearance package document is invalid.");
    }
    const stored = decodeAppearanceStoredPackage(document.package);
    if (stored === null || appearanceSha256(stored) !== document.sha256) {
      throw new Error("Appearance package document checksum or schema is invalid.");
    }
    verifyStoredPackageContents(stored);
    input = inputFromStored(stored);
  }
  const trust = input.trust ?? trustFor(input.sharedCss, input.desktopCss);
  const normalized = normalizeAppearance(input.input, {
    trust,
    platform: packageInspectionPlatform(),
    appVersion: APP_VERSION,
  });
  if (normalized.status === "failure") throw new Error(normalized.diagnostic.message);
  return {
    input,
    profile: normalized.profile,
    manifest: manifestFromProfile(normalized.profile),
    diagnostics: [],
    capabilities: normalized.profile.capabilities,
    trust,
    replacing: installedIds.has(normalized.profile.metadata.id),
  };
}

export async function installBrowserAppearancePackage(
  runtime: AppearanceRuntime,
  review: BrowserAppearancePackageReview,
  activate: boolean,
  generation?: number,
) {
  const id = review.profile.metadata.id;
  const result = review.replacing
    ? await runtime.execute({
        type: "update",
        id,
        package: review.input,
        apply: false,
        ...(generation !== undefined ? { generation } : {}),
      })
    : await runtime.execute({
        type: "install",
        package: review.input,
        activate: false,
        apply: false,
        ...(generation !== undefined ? { generation } : {}),
      });
  if (result.status !== "applied" || !activate) return result;
  return runtime.execute({
    type: "enable",
    id,
    ...(generation !== undefined ? { generation } : {}),
  });
}

export function previewBrowserAppearancePackage(
  runtime: AppearanceRuntime,
  review: BrowserAppearancePackageReview,
  generation?: number,
) {
  return runtime.execute({
    type: "preview",
    ...(generation !== undefined ? { generation } : {}),
    preview: {
      profile: review.profile,
      package: {
        manifest: review.manifest,
        profile: review.profile,
        manifestHash: appearanceSha256(review.manifest),
        ...(review.input.sharedCss === undefined ? {} : { sharedCss: review.input.sharedCss }),
        ...(review.input.desktopCss === undefined ? {} : { desktopCss: review.input.desktopCss }),
        assets: review.input.assets ?? [],
        diagnostics: review.diagnostics,
        enabled: false,
      },
    },
  });
}

export function serializeBrowserAppearancePackage(value: AppearanceStoredPackage): string {
  return `${JSON.stringify({ schema: PACKAGE_DOCUMENT_SCHEMA, package: value, sha256: appearanceSha256(value) })}\n`;
}

export function serializeAppearanceSnippetBundle(
  snippets: ReadonlyArray<AppearanceSnippet>,
): string {
  return `${JSON.stringify({ schema: SNIPPET_BUNDLE_SCHEMA, snippets })}\n`;
}

export function parseAppearanceSnippetBundle(source: string): ReadonlyArray<AppearanceSnippet> {
  const value = parseJson(source);
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== SNIPPET_BUNDLE_SCHEMA ||
    !("snippets" in value) ||
    !Array.isArray(value.snippets) ||
    value.snippets.length > MAX_PACKAGE_FILES
  ) {
    throw new Error("Appearance snippet bundle is invalid.");
  }
  const snippets: AppearanceSnippet[] = [];
  const ids = new Set<string>();
  for (const snippet of value.snippets) {
    if (
      typeof snippet !== "object" ||
      snippet === null ||
      !("id" in snippet) ||
      typeof snippet.id !== "string" ||
      snippet.id.length === 0 ||
      snippet.id.length > 128 ||
      ids.has(snippet.id) ||
      !("css" in snippet) ||
      typeof snippet.css !== "string" ||
      new TextEncoder().encode(snippet.css).byteLength > 256 * 1024 ||
      !("enabled" in snippet) ||
      typeof snippet.enabled !== "boolean" ||
      !("advanced" in snippet) ||
      typeof snippet.advanced !== "boolean"
    ) {
      throw new Error("Appearance snippet bundle contains an invalid or duplicate snippet.");
    }
    ids.add(snippet.id);
    snippets.push({
      id: snippet.id,
      css: snippet.css,
      enabled: snippet.enabled,
      advanced: snippet.advanced,
    });
  }
  return snippets;
}
