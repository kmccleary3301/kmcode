// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Filesystem-backed desktop appearance tests use host fixtures and asynchronous watch timing.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import type { DesktopAppearanceCommitInput, DesktopAppearanceWatchEvent } from "@t3tools/contracts";

import {
  createAppearanceRuntime,
  decodeAppearancePersistedState,
  DesktopBridgeAppearanceStorage,
  type AppearanceCompilerAdapter,
  type AppearancePersistedState,
} from "@t3tools/client-runtime/appearance";
import type { AppearanceManifestV2 } from "@t3tools/shared/appearance";
import {
  APPEARANCE_MANIFEST_VERSION,
  APPEARANCE_SCHEMA_ID,
  appearanceBytesSha256,
  appearanceSha256,
  normalizeThemeDefinition,
  normalizeAppearance,
} from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import JSZip from "jszip";
import { DesktopAppearanceStorage } from "./DesktopAppearanceStorage.ts";
const { cp, link, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } =
  NodeFSP;
const OS = NodeOS;
const Path = NodePath;

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(Path.join(OS.tmpdir(), "t3-appearance-"));
  roots.push(root);
  return root;
}
function waitForFilesystem(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
async function waitForWatchUpdates(
  updates: ReadonlyArray<AppearancePersistedState>,
  expectedLength: number,
  ready: () => boolean = () => true,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (updates.length < expectedLength || !ready()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expectedLength} watcher updates.`);
    }
    await waitForFilesystem(25);
  }
}
function forgeZipUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const forged = bytes.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  const endOffset = forged.byteLength - 22;
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const localOffset = view.getUint32(directoryOffset + 42, true);
  view.setUint32(directoryOffset + 24, size, true);
  view.setUint32(localOffset + 22, size, true);
  return forged;
}

function state(revision: number, safeMode = false): AppearancePersistedState {
  return {
    revision,
    packages: {},
    order: [],
    preference: { mode: "system" },
    snippets: [],
    accessibility: {},
    safeMode,
    environmentPackages: [],
    diagnostics: [],
    migration: { completed: true },
  };
}

function packageManifest(css: string, stylePath = "desktop.css"): AppearanceManifestV2 {
  const profile = normalizeThemeDefinition(T3_CHAT_THEME);
  const cssBytes = new TextEncoder().encode(css);
  return {
    schema: APPEARANCE_SCHEMA_ID,
    version: APPEARANCE_MANIFEST_VERSION,
    metadata: { id: "watch-package", name: "Watch Package", version: "1.0.0" },
    compatibility: {
      platforms: ["desktop-macos"],
      requiredCapabilities: ["colors", "desktop-css"],
    },
    capabilities: ["colors", "desktop-css"],
    fallback: { light: "default-variant", dark: "default-variant" },
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
    })),
    assets: [],
    styles: {
      desktop: {
        path: stylePath,
        sha256: appearanceBytesSha256(cssBytes),
        sizeBytes: cssBytes.byteLength,
      },
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("DesktopAppearanceStorage", () => {
  it("keeps owned paths contained and uses private permissions", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    await storage.commit(0, state(1));
    expect(storage.revealPath()).toBe(Path.join(root, "appearance"));
    expect(() => storage.revealPath("../outside")).toThrow();
    expect((await stat(Path.join(root, "appearance"))).mode & 0o777).toBe(0o700);
    expect((await stat(Path.join(root, "appearance", "state.json"))).mode & 0o777).toBe(0o600);
  });

  it("isolates listener failures after a durable commit", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const revisions: number[] = [];
    storage.subscribe(() => {
      throw new Error("listener failed");
    });
    storage.subscribe((next) => revisions.push(next.revision));

    await expect(storage.commit(0, state(1))).resolves.toBeUndefined();
    expect(revisions).toEqual([1]);
    expect((await new DesktopAppearanceStorage(root, undefined, "darwin").load()).revision).toBe(1);
  });

  it("migrates fresh desktop legacy themes and preferences exactly once", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    expect((await storage.load()).migration.completed).toBe(false);
    let reads = 0;
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
      legacy: {
        read: async () => {
          reads += 1;
          return [T3_CHAT_THEME];
        },
        readPreference: async () => ({
          mode: "dark" as const,
          packageId: T3_CHAT_THEME.id,
          variantId: "dark",
        }),
      },
    });
    expect(runtime.getSnapshot().migration.completed).toBe(true);
    expect(runtime.getSnapshot().preference).toMatchObject({
      mode: "dark",
      packageId: T3_CHAT_THEME.id,
      variantId: "dark",
    });
    const restarted = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(restarted.packages[T3_CHAT_THEME.id]).toBeDefined();
    expect(restarted.migration.completed).toBe(true);

    await createAppearanceRuntime({
      storage: new DesktopAppearanceStorage(root, undefined, "darwin"),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
      legacy: {
        read: async () => {
          reads += 1;
          return [];
        },
      },
    });
    expect(reads).toBe(1);
  });

  it("rejects symlinked owned directories", async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(Path.join(OS.tmpdir(), "t3-appearance-outside-"));
    roots.push(outside);
    await symlink(outside, Path.join(root, "appearance"));
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    await expect(storage.load()).rejects.toThrow();
  });

  it("does not follow hard-linked package entries during quarantine", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const css = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(css),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: css,
    });
    const packagePath = storage.revealPath("watch-package");
    await rm(packagePath, { recursive: true });
    const outside = await makeRoot();
    const outsideFile = Path.join(outside, "outside.txt");
    await writeFile(outsideFile, "outside", { mode: 0o640 });
    const modeBefore = (await stat(outsideFile)).mode & 0o777;
    await link(outsideFile, packagePath);

    const loaded = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(loaded.packages["watch-package"]?.desktopCss).toBe(css);
    expect((await stat(outsideFile)).mode & 0o777).toBe(modeBefore);
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });

  it("restores state-authoritative package bytes after an offline edit", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const firstCss = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(firstCss),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: firstCss,
    });
    const before = await storage.load();
    const packagePath = storage.revealPath("watch-package");
    const nextCss = "body { color: green; }\n";
    await writeFile(Path.join(packagePath, "desktop.css"), nextCss, { mode: 0o600 });
    await writeFile(
      Path.join(packagePath, "manifest.json"),
      JSON.stringify(packageManifest(nextCss)) + "\n",
      { mode: 0o600 },
    );

    const reloaded = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(reloaded.revision).toBe(before.revision);
    expect(reloaded.packages["watch-package"]?.desktopCss).toBe(firstCss);
    expect(await readFile(Path.join(packagePath, "desktop.css"), "utf8")).toBe(firstCss);
  });
  it("quarantines malformed package directories", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    await storage.load();
    const malformedPath = storage.revealPath("broken");
    await mkdir(malformedPath, { recursive: true });
    await writeFile(Path.join(malformedPath, "package.json"), "{malformed", { mode: 0o600 });
    expect(await storage.list()).toEqual([]);
    expect(
      (await readdir(Path.join(root, "appearance", "quarantine"))).some((name) =>
        name.startsWith("broken-"),
      ),
    ).toBe(true);
  });

  it("retains a colors-only package without a styles section after reload", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const { styles: _styles, ...withNoStyles } = packageManifest("");
    const input: AppearanceManifestV2 = {
      ...withNoStyles,
      compatibility: {
        ...withNoStyles.compatibility,
        requiredCapabilities: ["colors"],
      },
      capabilities: ["colors"],
    };
    await storage.install({
      input,
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: false,
        allowAdvancedSnippet: false,
      },
    });

    const reloaded = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(reloaded.packages["watch-package"]?.manifest.styles).toBeUndefined();
    expect(reloaded.packages["watch-package"]?.profile.metadata.id).toBe("watch-package");
  });

  it("rejects full-state package data that diverges from its manifest", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const css = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(css),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: css,
    });
    const current = await storage.load();
    const packageValue = current.packages["watch-package"];
    if (packageValue === undefined) throw new Error("missing installed package");

    const { desktopCss: _desktopCss, ...withoutCss } = packageValue;
    await expect(
      storage.commit(current.revision, {
        ...current,
        revision: current.revision + 1,
        packages: { ...current.packages, "watch-package": withoutCss },
      }),
    ).rejects.toMatchObject({ code: "unsafe-package" });

    const mismatchedProfile = {
      ...packageValue,
      profile: {
        ...packageValue.profile,
        metadata: { ...packageValue.profile.metadata, name: "Forged profile" },
      },
    };
    await expect(
      storage.commit(current.revision, {
        ...current,
        revision: current.revision + 1,

        packages: { ...current.packages, "watch-package": mismatchedProfile },
      }),
    ).rejects.toMatchObject({ code: "unsafe-package" });

    await expect(
      storage.commit(current.revision, {
        ...current,
        revision: current.revision + 1,
        packages: {
          ...current.packages,
          "watch-package": { ...packageValue, manifestHash: appearanceSha256("forged") },
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe-package" });
  });

  it("counts all mandatory package files against the 256-file bound", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const css = "body { color: red; }\n";
    const cssBytes = new TextEncoder().encode(css);
    const assetBytes = new Uint8Array([0]);
    const assetHash = appearanceBytesSha256(assetBytes);
    const assets = Array.from({ length: 252 }, (_, index) => ({
      id: `asset-${index}`,
      kind: "image" as const,
      path: `assets/${index}.png`,
      mimeType: "image/png" as const,
      sha256: assetHash,
      sizeBytes: assetBytes.byteLength,
      platforms: ["desktop-macos"] as const,
      dataBase64: "AA==",
    }));
    const base = packageManifest(css);
    const desktopStyle = base.styles?.desktop;
    if (desktopStyle === undefined) throw new Error("missing desktop style fixture");
    const input: AppearanceManifestV2 = {
      ...base,
      compatibility: {
        ...base.compatibility,
        requiredCapabilities: ["colors", "images", "shared-css", "desktop-css"],
      },
      capabilities: ["colors", "images", "shared-css", "desktop-css"],
      assets: assets.map(({ dataBase64: _dataBase64, ...asset }) => asset),
      styles: {
        web: {
          path: "shared.css",
          sha256: appearanceBytesSha256(cssBytes),
          sizeBytes: cssBytes.byteLength,
        },
        desktop: desktopStyle,
      },
    };

    await expect(
      storage.install({
        input,
        trust: {
          class: "local-package",
          allowSharedCss: true,
          allowDesktopCss: true,
          allowAdvancedSnippet: false,
        },
        sharedCss: css,
        desktopCss: css,
        assets,
      }),
    ).rejects.toMatchObject({ code: "unsafe-package" });
  });

  it("restores package bytes and state when a package transaction cannot commit", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const trust = {
      class: "local-package" as const,
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    };
    const firstCss = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(firstCss),
      trust,
      desktopCss: firstCss,
    });
    const before = await storage.load();
    const backupPath = Path.join(root, "appearance", "state.last-good.json");
    await rm(backupPath);
    await mkdir(backupPath);

    const nextCss = "body { color: blue; }\n";
    await expect(
      storage.install({
        input: packageManifest(nextCss),
        trust,
        desktopCss: nextCss,
      }),
    ).rejects.toMatchObject({ code: "write-failed" });
    await rm(backupPath, { recursive: true });

    const recovered = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(recovered.revision).toBe(before.revision);
    expect(recovered.packages["watch-package"]?.desktopCss).toBe(firstCss);
    expect(
      await readFile(Path.join(storage.revealPath("watch-package"), "desktop.css"), "utf8"),
    ).toBe(firstCss);
  });
  it("serializes reset with package commits without splitting state from package bytes", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const trust = {
      class: "local-package" as const,
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    };
    const firstCss = "body { color: red; }\n";
    await storage.install({ input: packageManifest(firstCss), trust, desktopCss: firstCss });

    const nextCss = "body { color: green; }\n";
    await Promise.all([
      storage.reset(),
      storage.install({
        input: packageManifest(nextCss),
        trust,
        desktopCss: nextCss,
      }),
    ]);

    const reloaded = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(reloaded.packages["watch-package"]?.desktopCss).toBe(nextCss);
    expect(
      await readFile(Path.join(storage.revealPath("watch-package"), "desktop.css"), "utf8"),
    ).toBe(nextCss);
  });

  it("preserves and restores desktop reset state from safe mode with package directories", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const css = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(css),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: css,
    });
    const before = await storage.load();

    await storage.reset();
    expect((await storage.readQuarantinedState())?.revision).toBe(before.revision);
    expect((await storage.load()).packages["watch-package"]).toBeUndefined();
    await storage.setSafeMode(true);
    expect((await storage.load()).safeMode).toBe(true);

    const restored = await storage.restoreQuarantinedState();
    expect(restored.revision).toBeGreaterThan(before.revision);
    expect(restored.safeMode).toBe(false);
    expect(restored.packages["watch-package"]?.desktopCss).toBe(css);
    expect(await storage.readQuarantinedState()).toBeNull();
    expect(
      await readFile(Path.join(storage.revealPath("watch-package"), "desktop.css"), "utf8"),
    ).toBe(css);
    await expect(
      stat(Path.join(root, "appearance", "quarantine", "reset-packages")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the last good state when the state file is malformed", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    await storage.commit(0, state(1));
    await writeFile(Path.join(root, "appearance", "state.json"), "{partial", { mode: 0o600 });
    expect((await storage.load()).revision).toBe(1);
    expect(await readFile(Path.join(root, "appearance", "state.last-good.json"), "utf8")).toContain(
      "revision",
    );
  });

  it("fails closed for malformed boot state and uses a valid recovery copy", async () => {
    const malformedRoot = await makeRoot();
    await mkdir(Path.join(malformedRoot, "appearance"), { recursive: true });
    await writeFile(Path.join(malformedRoot, "appearance", "state.json"), "{partial", {
      mode: 0o600,
    });
    await expect(
      new DesktopAppearanceStorage(malformedRoot, undefined, "darwin").readSafeModeForBoot(),
    ).rejects.toThrow("No valid appearance recovery state");

    const symlinkRoot = await makeRoot();
    await mkdir(Path.join(symlinkRoot, "appearance"), { recursive: true });
    await symlink("missing-state.json", Path.join(symlinkRoot, "appearance", "state.json"));
    await expect(
      new DesktopAppearanceStorage(symlinkRoot, undefined, "darwin").readSafeModeForBoot(),
    ).rejects.toThrow("regular file");

    const recoverableRoot = await makeRoot();
    const recoverable = new DesktopAppearanceStorage(recoverableRoot, undefined, "darwin");
    await recoverable.commit(0, state(1, true));
    await writeFile(Path.join(recoverableRoot, "appearance", "state.json"), "{partial", {
      mode: 0o600,
    });
    expect(await recoverable.readSafeModeForBoot()).toBe(true);
  });

  it("does not reinterpret its own package transaction as an external change", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    await storage.load();
    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((next) => updates.push(next));
    const css = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(css),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: css,
    });
    const committed = await storage.load();
    await waitForFilesystem(220);
    stop();
    expect((await storage.load()).revision).toBe(committed.revision);
    expect(updates).toEqual([]);
  });

  it("keeps legacy theme migration provenance when watching its own package transaction", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const runtime = await createAppearanceRuntime({
      storage: new DesktopBridgeAppearanceStorage({
        readAppearanceState: async () => {
          const current = await storage.load();
          return { stateJson: JSON.stringify(current), checksum: appearanceSha256(current) };
        },
        commitAppearanceState: async (input: DesktopAppearanceCommitInput) => {
          const next = decodeAppearancePersistedState(JSON.parse(input.stateJson));
          if (next === null || appearanceSha256(next) !== input.checksum)
            throw new Error("invalid bridge state");
          await storage.commit(input.expectedRevision, next);
          return { revision: next.revision, safeMode: next.safeMode, checksum: input.checksum };
        },
        onAppearanceWatchEvent: () => () => undefined,
      }),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
    });
    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((next) => updates.push(next));
    const installed = await runtime.execute({
      type: "install",
      package: {
        input: T3_CHAT_THEME,
        sourceId: T3_CHAT_THEME.id,
        trust: {
          class: "builtin",
          allowSharedCss: false,
          allowDesktopCss: false,
          allowAdvancedSnippet: false,
        },
      },
      activate: true,
    });
    expect(installed.status).toBe("applied");
    const committed = await storage.load();
    expect(committed.packages[T3_CHAT_THEME.id]?.profile.migration.sourceVersion).toBe(1);
    await waitForFilesystem(220);
    stop();
    expect(await storage.load()).toEqual(committed);
    expect(updates).toEqual([]);
  });

  it("debounces stable external revisions and suppresses duplicates", async () => {
    const root = await makeRoot();
    const first = new DesktopAppearanceStorage(root, undefined, "darwin");
    const second = new DesktopAppearanceStorage(root, undefined, "darwin");
    await first.commit(0, state(1));
    const revisions: number[] = [];
    const stop = first.watch((next) => revisions.push(next.revision));
    await second.commit(1, state(2, true));
    // This integration test exercises the real fs.watch debounce against filesystem events.
    await waitForFilesystem(220);
    await second.commit(2, state(3, false));
    await waitForFilesystem(220);
    stop();
    expect(revisions).toEqual([2, 3]);

    const restartedRevisions: number[] = [];
    const stopRestarted = first.watch((next) => restartedRevisions.push(next.revision));
    await second.commit(3, state(4, true));
    await waitForFilesystem(220);
    stopRestarted();
    expect(restartedRevisions).toEqual([4]);
  });
  it("persists runtime bridge installs, updates, and deletes across desktop restarts", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const bridge = {
      readAppearanceState: async () => {
        const current = await storage.load();
        return { stateJson: JSON.stringify(current), checksum: appearanceSha256(current) };
      },
      commitAppearanceState: async (input: DesktopAppearanceCommitInput) => {
        const current = decodeAppearancePersistedState(JSON.parse(input.stateJson));
        if (current === null || appearanceSha256(current) !== input.checksum)
          throw new Error("invalid bridge state");
        await storage.commit(input.expectedRevision, current);
        return {
          revision: current.revision,
          safeMode: current.safeMode,
          checksum: appearanceSha256(current),
        };
      },
      onAppearanceWatchEvent: (_listener: (event: DesktopAppearanceWatchEvent) => void) => () =>
        undefined,
    };
    const runtime = await createAppearanceRuntime({
      storage: new DesktopBridgeAppearanceStorage(bridge),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
    });
    const firstCss = "body { color: red; }\n";
    expect(
      (
        await runtime.execute({
          type: "install",
          package: {
            input: packageManifest(firstCss),
            trust: {
              class: "local-package",
              allowSharedCss: false,
              allowDesktopCss: true,
              allowAdvancedSnippet: false,
            },
            desktopCss: firstCss,
          },
          activate: true,
        })
      ).status,
    ).toBe("applied");
    expect(
      (await new DesktopAppearanceStorage(root, undefined, "darwin").load()).packages[
        "watch-package"
      ]?.desktopCss,
    ).toBe(firstCss);

    const nextCss = "body { color: blue; }\n";
    expect(
      (
        await runtime.execute({
          type: "update",
          id: "watch-package",
          package: {
            input: packageManifest(nextCss),
            trust: {
              class: "local-package",
              allowSharedCss: false,
              allowDesktopCss: true,
              allowAdvancedSnippet: false,
            },
            desktopCss: nextCss,
          },
        })
      ).status,
    ).toBe("applied");
    expect(
      (await new DesktopAppearanceStorage(root, undefined, "darwin").load()).packages[
        "watch-package"
      ]?.desktopCss,
    ).toBe(nextCss);

    expect((await runtime.execute({ type: "delete", id: "watch-package" })).status).toBe("applied");
    expect(
      (await new DesktopAppearanceStorage(root, undefined, "darwin").load()).packages[
        "watch-package"
      ],
    ).toBeUndefined();
    await expect(stat(storage.revealPath("watch-package"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rebuilds a changed package tree without a state-file revision", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const firstCss = "body { color: red; }\n";
    const trust = {
      class: "local-package" as const,
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    };
    await storage.install({
      input: packageManifest(firstCss),
      trust,
      desktopCss: firstCss,
    });
    const installed = await storage.load();
    const installedPackage = installed.packages["watch-package"];
    if (installedPackage === undefined) throw new Error("package was not installed");
    const before: AppearancePersistedState = {
      ...installed,
      revision: installed.revision + 1,
      packages: {
        "watch-package": {
          ...installedPackage,
          enabled: false,
        },
      },
      preference: { mode: "dark", packageId: "watch-package" },
    };
    await storage.commit(installed.revision, before);
    let bridgeStop: () => void = () => undefined;
    const bridge = {
      readAppearanceState: async () => {
        const state = await storage.load();
        return { stateJson: JSON.stringify(state), checksum: appearanceSha256(state) };
      },
      commitAppearanceState: async (input: DesktopAppearanceCommitInput) => {
        const state = decodeAppearancePersistedState(JSON.parse(input.stateJson));
        if (state === null || appearanceSha256(state) !== input.checksum)
          throw new Error("invalid bridge state");
        await storage.commit(input.expectedRevision, state);
        return {
          revision: state.revision,
          safeMode: state.safeMode,
          checksum: appearanceSha256(state),
        };
      },
      onAppearanceWatchEvent: (listener: (event: DesktopAppearanceWatchEvent) => void) => {
        bridgeStop = storage.watch((state) =>
          listener({
            reason: "external-change",
            state: {
              revision: state.revision,
              safeMode: state.safeMode,
              checksum: appearanceSha256(state),
            },
          }),
        );
        return () => bridgeStop();
      },
    };
    const compiler: AppearanceCompilerAdapter = {
      normalize: (input, options) => normalizeAppearance(input, options),
      compile: async (input) => ({ input, artifact: input.resolved.css }),
    };
    const runtime = await createAppearanceRuntime({
      storage: new DesktopBridgeAppearanceStorage(bridge),
      compiler,
      apply: { apply: async () => undefined },
    });
    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((next) => updates.push(next));
    const nextCss = "body { color: blue; }\n";
    const packagePath = storage.revealPath("watch-package");
    await writeFile(Path.join(packagePath, "desktop.css"), nextCss, { mode: 0o600 });
    await writeFile(
      Path.join(packagePath, "manifest.json"),
      JSON.stringify(packageManifest(nextCss)) + "\n",
      { mode: 0o600 },
    );
    await waitForWatchUpdates(
      updates,
      1,
      () => runtime.getSnapshot().revision === before.revision + 1,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.revision).toBe(before.revision + 1);
    expect(updates[0]?.packages["watch-package"]?.desktopCss).toBe(nextCss);
    expect(updates[0]?.packages["watch-package"]?.enabled).toBe(false);
    expect(updates[0]?.order).toEqual(before.order);
    expect(updates[0]?.preference).toEqual(before.preference);
    expect(runtime.getSnapshot().revision).toBe(before.revision + 1);
    expect(runtime.getSnapshot().packages["watch-package"]?.desktopCss).toBe(nextCss);
    const restarted = new DesktopAppearanceStorage(root, undefined, "darwin");
    const persisted = await restarted.load();
    expect(persisted.revision).toBe(before.revision + 1);
    expect(persisted.packages["watch-package"]?.desktopCss).toBe(nextCss);

    await writeFile(Path.join(packagePath, "desktop.css"), nextCss, { mode: 0o600 });
    await writeFile(
      Path.join(packagePath, "manifest.json"),
      JSON.stringify(packageManifest(nextCss)) + "\n",
      { mode: 0o600 },
    );
    await waitForFilesystem(1_000);
    stop();
    expect(updates).toHaveLength(1);
    const command = await runtime.execute({ type: "safe-mode", enabled: true });
    expect(command.status).toBe("applied");
    expect((await restarted.load()).revision).toBe(persisted.revision + 1);
    bridgeStop();
  });

  it("restores prior package bytes when an external watcher commit cannot persist state", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const firstCss = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(firstCss),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: firstCss,
    });
    const before = await storage.load();
    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((next) => updates.push(next));
    const backupPath = Path.join(root, "appearance", "state.last-good.json");
    await rm(backupPath);
    await mkdir(backupPath);

    const nextCss = "body { color: green; }\n";
    const packagePath = storage.revealPath("watch-package");
    await writeFile(Path.join(packagePath, "desktop.css"), nextCss, { mode: 0o600 });
    await writeFile(
      Path.join(packagePath, "manifest.json"),
      JSON.stringify(packageManifest(nextCss)) + "\n",
      { mode: 0o600 },
    );
    const rollbackDeadline = Date.now() + 10_000;
    const readCurrentCss = async () => {
      try {
        return await readFile(Path.join(packagePath, "desktop.css"), "utf8");
      } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    };
    while ((await readCurrentCss()) !== firstCss) {
      if (Date.now() >= rollbackDeadline) {
        throw new Error("Timed out waiting for watcher rollback of desktop.css");
      }
      await waitForFilesystem(25);
    }
    stop();
    await rm(backupPath, { recursive: true });

    expect(updates).toEqual([]);
    const reloaded = await new DesktopAppearanceStorage(root, undefined, "darwin").load();
    expect(reloaded.revision).toBe(before.revision);
    expect(reloaded.packages["watch-package"]?.desktopCss).toBe(firstCss);
    expect(await readFile(Path.join(packagePath, "desktop.css"), "utf8")).toBe(firstCss);
  });

  it("leaves partial package writes unapplied until an atomic replacement is complete", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const firstCss = "body { color: red; }\n";
    const trust = {
      class: "local-package" as const,
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    };
    await storage.install({
      input: packageManifest(firstCss),
      trust,
      desktopCss: firstCss,
    });
    const before = await storage.load();
    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((next) => updates.push(next));
    const packagePath = storage.revealPath("watch-package");
    const manifestPath = Path.join(packagePath, "manifest.json");
    const cssPath = Path.join(packagePath, "desktop.css");
    await writeFile(cssPath, "partial", { mode: 0o600 });
    await waitForWatchUpdates(updates, 1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.packages["watch-package"]?.desktopCss).toBe(firstCss);
    expect(updates[0]?.packages["watch-package"]?.enabled).toBe(false);
    expect(updates[0]?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: "watch-package" })]),
    );

    const nextCss = "body { color: green; }\n";
    const nextManifest = JSON.stringify(packageManifest(nextCss)) + "\n";
    const cssTemporaryPath = Path.join(packagePath, ".desktop.css.tmp");
    const manifestTemporaryPath = Path.join(packagePath, ".manifest.json.tmp");
    await writeFile(cssTemporaryPath, nextCss, { mode: 0o600 });
    await rename(cssTemporaryPath, cssPath);
    await writeFile(manifestTemporaryPath, nextManifest, { mode: 0o600 });
    await rename(manifestTemporaryPath, manifestPath);
    await waitForWatchUpdates(updates, 2);
    stop();
    expect(updates).toHaveLength(2);
    expect(updates[1]?.revision).toBe(before.revision + 2);
    expect(updates[1]?.packages["watch-package"]?.desktopCss).toBe(nextCss);
  });
  it("serializes overlapping watcher reads and keeps the newest complete package", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const firstCss = "body { color: red; }\n";
    await storage.install({
      input: packageManifest(firstCss, "styles/theme.css"),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: firstCss,
    });
    const before = await storage.load();
    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((state) => updates.push(state));
    const packagePath = storage.revealPath("watch-package");
    const cssPath = Path.join(packagePath, "styles", "theme.css");
    const manifestPath = Path.join(packagePath, "manifest.json");

    const blueCss = "body { color: blue; }\n";
    await writeFile(cssPath, blueCss, { mode: 0o600 });
    await writeFile(
      manifestPath,
      JSON.stringify(packageManifest(blueCss, "styles/theme.css")) + "\n",
      { mode: 0o600 },
    );
    await waitForFilesystem(90);
    const greenCss = "body { color: green; }\n";
    await writeFile(cssPath, greenCss, { mode: 0o600 });
    await writeFile(
      manifestPath,
      JSON.stringify(packageManifest(greenCss, "styles/theme.css")) + "\n",
      { mode: 0o600 },
    );
    await waitForWatchUpdates(
      updates,
      1,
      () => updates.at(-1)?.packages["watch-package"]?.desktopCss === greenCss,
    );
    stop();

    expect(updates.length).toBeGreaterThan(0);
    const revisions = updates.map((state) => state.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(
      revisions.every((revision, index) => {
        const previous = revisions[index - 1];
        return previous === undefined || revision > previous;
      }),
    ).toBe(true);
    expect(updates.at(-1)?.revision).toBeGreaterThan(before.revision);
    expect(updates.at(-1)?.packages["watch-package"]?.desktopCss).toBe(greenCss);
    expect((await storage.load()).packages["watch-package"]?.desktopCss).toBe(greenCss);
  });
  it("disables a broken watched package without blocking another package update", async () => {
    const root = await makeRoot();
    const storage = new DesktopAppearanceStorage(root, undefined, "darwin");
    const brokenCss = "body { color: red; }\n";
    const healthyCss = "body { color: blue; }\n";
    await storage.load();
    const trust = {
      class: "local-package" as const,
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    };
    await storage.install({
      input: packageManifest(brokenCss),
      trust,
      desktopCss: brokenCss,
    });
    const healthyManifest = {
      ...packageManifest(healthyCss),
      metadata: { id: "healthy-package", name: "Healthy Package", version: "1.0.0" },
    };
    await storage.install({
      input: healthyManifest,
      trust,
      desktopCss: healthyCss,
    });

    const updates: AppearancePersistedState[] = [];
    const stop = storage.watch((next) => updates.push(next));
    const invalidCss = "body { background: url(https://example.invalid/unsafe.png); }";
    const brokenManifest = packageManifest(invalidCss);
    const nextHealthyCss = "body { color: green; }\n";
    const nextHealthyManifest = {
      ...packageManifest(nextHealthyCss),
      metadata: healthyManifest.metadata,
    };
    await writeFile(Path.join(storage.revealPath("watch-package"), "desktop.css"), invalidCss, {
      mode: 0o600,
    });
    await writeFile(
      Path.join(storage.revealPath("watch-package"), "manifest.json"),
      `${JSON.stringify(brokenManifest)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      Path.join(storage.revealPath("healthy-package"), "desktop.css"),
      nextHealthyCss,
      {
        mode: 0o600,
      },
    );
    await writeFile(
      Path.join(storage.revealPath("healthy-package"), "manifest.json"),
      `${JSON.stringify(nextHealthyManifest)}\n`,
      { mode: 0o600 },
    );
    await waitForWatchUpdates(
      updates,
      1,
      () => updates.at(-1)?.packages["healthy-package"]?.desktopCss === nextHealthyCss,
    );
    stop();

    const current = await storage.load();
    expect(current.packages["healthy-package"]?.desktopCss).toBe(nextHealthyCss);
    expect(current.packages["watch-package"]?.desktopCss).toBe(brokenCss);
    expect(current.packages["watch-package"]?.enabled).toBe(false);
    expect(
      current.packages["watch-package"]?.diagnostics.some(
        (diagnostic) =>
          diagnostic.file === "watch-package" && diagnostic.code === "invalid-manifest",
      ),
    ).toBe(true);
  });

  it("discovers copied package directories disabled and removes deleted directories", async () => {
    const sourceRoot = await makeRoot();
    const source = new DesktopAppearanceStorage(sourceRoot, undefined, "darwin");
    const css = "body { color: red; }\n";
    await source.load();
    await source.install({
      input: packageManifest(css),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: css,
    });

    const targetRoot = await makeRoot();
    const target = new DesktopAppearanceStorage(targetRoot, undefined, "darwin");
    await target.load();
    const updates: AppearancePersistedState[] = [];
    const stop = target.watch((next) => updates.push(next));
    await waitForFilesystem(50);
    const targetPackagePath = target.revealPath("watch-package");
    await cp(source.revealPath("watch-package"), targetPackagePath, { recursive: true });
    const copiedManifest = await readFile(Path.join(targetPackagePath, "manifest.json"));
    await writeFile(Path.join(targetPackagePath, "manifest.json"), copiedManifest, { mode: 0o600 });
    await waitForWatchUpdates(
      updates,
      1,
      () => updates.at(-1)?.packages["watch-package"]?.enabled === false,
    );
    expect((await target.load()).packages["watch-package"]?.enabled).toBe(false);

    expect(updates.at(-1)?.packages["watch-package"]?.enabled).toBe(false);
    expect(updates.at(-1)?.order).toContain("watch-package");
    const removalUpdateCount = updates.length + 1;
    await rm(targetPackagePath, { recursive: true });
    await waitForWatchUpdates(
      updates,
      removalUpdateCount,
      () => updates.at(-1)?.packages["watch-package"] === undefined,
    );
    stop();
    expect(updates.at(-1)?.packages["watch-package"]).toBeUndefined();
  });

  it("grants declared CSS only to an explicitly selected local package folder", async () => {
    const source = await makeRoot();
    const root = await makeRoot();
    const css = "body { color: rebeccapurple; }\n";
    await writeFile(
      Path.join(source, "manifest.json"),
      `${JSON.stringify(packageManifest(css))}\n`,
    );
    await writeFile(Path.join(source, "desktop.css"), css);

    const installed = await new DesktopAppearanceStorage(root, undefined, "darwin").install(source);
    expect(installed.desktopCss).toBe(css);
    expect(installed.profile.trust).toEqual({
      class: "local-package",
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    });
  });

  it("imports a checksummed package exported into a selected folder", async () => {
    const sourceRoot = await makeRoot();
    const exportFolder = await makeRoot();
    const destinationRoot = await makeRoot();
    const css = "body { color: teal; }\n";
    const source = new DesktopAppearanceStorage(sourceRoot, undefined, "darwin");
    await source.install({
      input: packageManifest(css),
      trust: {
        class: "local-package",
        allowSharedCss: false,
        allowDesktopCss: true,
        allowAdvancedSnippet: false,
      },
      desktopCss: css,
    });
    await source.export(
      "watch-package",
      Path.join(exportFolder, "watch-package.t3appearance.json"),
    );

    const installed = await new DesktopAppearanceStorage(
      destinationRoot,
      undefined,
      "darwin",
    ).install(exportFolder);
    expect(installed.manifest.metadata.id).toBe("watch-package");
    expect(installed.desktopCss).toBe(css);
  });

  it("rejects colliding and case-folded package file paths", async () => {
    const css = "body { color: red; }\n";
    const storage = new DesktopAppearanceStorage(await makeRoot(), undefined, "darwin");
    const stylesheet = packageManifest(css).styles?.desktop;
    if (stylesheet === undefined) throw new Error("Expected desktop stylesheet fixture.");
    const sharedAndDesktop: AppearanceManifestV2 = {
      ...packageManifest(css),
      compatibility: {
        platforms: ["web", "desktop-macos"],
        requiredCapabilities: ["colors", "shared-css", "desktop-css"],
      },
      capabilities: ["colors", "shared-css", "desktop-css"],
      styles: { web: stylesheet, desktop: stylesheet },
    };
    await expect(
      storage.install({
        input: sharedAndDesktop,
        trust: {
          class: "local-package",
          allowSharedCss: true,
          allowDesktopCss: true,
          allowAdvancedSnippet: false,
        },
        sharedCss: css,
        desktopCss: css,
      }),
    ).rejects.toMatchObject({ code: "unsafe-package" });

    await expect(
      storage.install({
        input: packageManifest(css, "Manifest.json"),
        trust: {
          class: "local-package",
          allowSharedCss: false,
          allowDesktopCss: true,
          allowAdvancedSnippet: false,
        },
        desktopCss: css,
      }),
    ).rejects.toMatchObject({ code: "unsafe-package" });
  });
  it("installs bounded ZIP packages without extracting archive paths", async () => {
    const root = await makeRoot();
    const archivePath = Path.join(await makeRoot(), "theme.zip");
    const css = "body { color: navy; }\n";
    const archive = new JSZip();
    archive.file("theme/manifest.json", JSON.stringify(packageManifest(css)));
    archive.file("theme/desktop.css", css);
    await writeFile(archivePath, await archive.generateAsync({ type: "uint8array" }));

    const installed = await new DesktopAppearanceStorage(root, undefined, "darwin").install(
      archivePath,
    );
    expect(installed.desktopCss).toBe(css);
  });
  it("bounds inflated bytes when ZIP size metadata is forged", async () => {
    const root = await makeRoot();
    const archivePath = Path.join(await makeRoot(), "forged.zip");
    const archive = new JSZip();
    archive.file("manifest.json", "x".repeat(1024 * 1024));
    const bytes = await archive.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    await writeFile(archivePath, forgeZipUncompressedSize(bytes, 1));

    await expect(
      new DesktopAppearanceStorage(root, undefined, "darwin").install(archivePath),
    ).rejects.toMatchObject({
      code: "unsafe-package",
      message: expect.stringContaining("expands beyond"),
    });
  });

  it("rejects archive traversal and undeclared executable extensions", async () => {
    const root = await makeRoot();
    const archivePath = Path.join(await makeRoot(), "unsafe.zip");
    const archive = new JSZip();
    archive.file("../manifest.json", JSON.stringify(packageManifest("")));
    archive.file("payload.js", "alert(1)");
    await writeFile(archivePath, await archive.generateAsync({ type: "uint8array" }));

    await expect(
      new DesktopAppearanceStorage(root, undefined, "darwin").install(archivePath),
    ).rejects.toMatchObject({
      code: "unsafe-package",
    });
  });
});
