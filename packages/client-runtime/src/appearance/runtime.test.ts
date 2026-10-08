import { describe, expect, it } from "@effect/vitest";
import type { DesktopAppearanceWatchEvent } from "@t3tools/contracts";

import { appearanceSha256, normalizeAppearance } from "@t3tools/shared/appearance";
import { GROVE_THEME, T3_CHAT_THEME, type ThemeDefinition } from "@t3tools/shared/themePalettes";

import { DesktopBridgeAppearanceStorage } from "./desktopBridgeStorage.ts";
import { migrateAppearanceState, type AppearanceLegacyInputAdapter } from "./migration.ts";
import { resolveAppearancePrecedence } from "./precedence.ts";
import {
  APPEARANCE_COMMAND_TYPES,
  APPEARANCE_COMMAND_TYPES_EXHAUSTIVE,
  decodeAppearancePersistedState,
  ENVIRONMENT_PALETTE_TRUST,
  type AppearanceBroadcastAdapter,
  type AppearanceBroadcastEvent,
  type AppearanceCommand,
  type AppearanceCompiledOutput,
  type AppearanceCompilerAdapter,
  type AppearancePersistedState,
  type AppearanceStorageAdapter,
} from "./model.ts";
import { createAppearanceRuntime, createEmptyAppearanceState } from "./runtime.ts";

function compilerThatNormalizes(): AppearanceCompilerAdapter {
  return {
    normalize: (input) => normalizeAppearance(input),
    compile: async (input) => ({ input, artifact: input.resolved.css }),
  };
}

function themeCanvas(theme: ThemeDefinition, appearance: "light" | "dark"): string {
  const normalized = normalizeAppearance(theme);
  if (normalized.status === "failure") throw new Error(normalized.diagnostic.message);
  const variant = normalized.profile.variants.find(
    (candidate) => candidate.appearance === appearance,
  );
  if (variant === undefined) throw new Error(`Missing ${appearance} variant.`);
  return variant.colors.canvas;
}

class MemoryStorage implements AppearanceStorageAdapter {
  state: AppearancePersistedState;
  commits = 0;
  loads = 0;
  subscriptions = 0;
  failCommits = false;
  readonly listeners = new Set<(state: AppearancePersistedState) => void>();

  constructor(state = createEmptyAppearanceState()) {
    this.state = state;
  }

  readonly load = async (): Promise<AppearancePersistedState> => {
    this.loads += 1;
    return this.state;
  };
  readonly commit = async (
    expectedRevision: number,
    state: AppearancePersistedState,
  ): Promise<void> => {
    if (expectedRevision !== this.state.revision) throw new Error("revision conflict");
    if (this.failCommits) throw new Error("commit failed");
    this.state = state;
    this.commits += 1;
  };
  readonly subscribe = (listener: (state: AppearancePersistedState) => void): (() => void) => {
    this.subscriptions += 1;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(state: AppearancePersistedState): void {
    for (const listener of this.listeners) listener(state);
  }
}

class RecoveringMemoryStorage extends MemoryStorage {
  recoveries = 0;
  readonly recover = async (state: AppearancePersistedState): Promise<AppearancePersistedState> => {
    this.recoveries += 1;
    this.state = state;
    this.commits += 1;
    return state;
  };
}

class MemoryBroadcast implements AppearanceBroadcastAdapter {
  readonly listeners = new Set<(event: AppearanceBroadcastEvent) => void>();
  readonly events: AppearanceBroadcastEvent[] = [];
  readonly publish = (event: AppearanceBroadcastEvent): void => {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  };
  readonly subscribe = (listener: (event: AppearanceBroadcastEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(event: AppearanceBroadcastEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function packageCommand(type: "install" | "environment-packages"): AppearanceCommand {
  const packageInput = { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id };
  return type === "install"
    ? { type, package: packageInput, activate: true }
    : { type, packages: [packageInput] };
}

describe("appearance command contract", () => {
  it("enumerates every command type exactly once", () => {
    expect(APPEARANCE_COMMAND_TYPES_EXHAUSTIVE).toBe(true);
    expect(new Set(APPEARANCE_COMMAND_TYPES).size).toBe(APPEARANCE_COMMAND_TYPES.length);
    expect(APPEARANCE_COMMAND_TYPES).toContain("typography-preference");
  });
});

describe("appearance precedence", () => {
  it("uses documented order and retains only a caller-supplied built-in variant in safe mode", () => {
    const layers = {
      variant: { color: "variant", base: "yes" },
      packageCss: { color: "package" },
      preference: { color: "preference" },
      ordinarySnippet: { color: "ordinary" },
      preview: { color: "preview" },
      accessibility: { color: "accessibility" },
      advancedSnippet: { color: "advanced" },
    } as const;
    expect(resolveAppearancePrecedence(layers)).toEqual({ color: "advanced", base: "yes" });
    expect(resolveAppearancePrecedence(layers, true)).toEqual({
      color: "variant",
      base: "yes",
    });
  });
});

describe("desktop bridge appearance storage", () => {
  it("delivers a watch revision after another consumer has already loaded it", async () => {
    let durable = createEmptyAppearanceState();
    let emitWatch: ((event: DesktopAppearanceWatchEvent) => void) | undefined;
    const storage = new DesktopBridgeAppearanceStorage({
      readAppearanceState: async () => ({
        stateJson: JSON.stringify(durable),
        revision: durable.revision,
        safeMode: durable.safeMode,
        checksum: appearanceSha256(durable),
      }),
      commitAppearanceState: async () => ({
        revision: durable.revision,
        safeMode: durable.safeMode,
        checksum: appearanceSha256(durable),
      }),
      onAppearanceWatchEvent: (listener) => {
        emitWatch = listener;
        return () => undefined;
      },
    });
    await storage.load();
    const observed: number[] = [];
    storage.subscribe((next) => observed.push(next.revision));
    durable = { ...durable, revision: 1 };
    await storage.load();
    if (emitWatch === undefined) throw new Error("appearance watch listener was not registered");
    emitWatch({
      reason: "external-change",
      state: {
        revision: durable.revision,
        safeMode: durable.safeMode,
        checksum: appearanceSha256(durable),
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(observed).toEqual([1]);
  });
});

describe("appearance runtime transactions", () => {
  it("catches up a storage revision that changed before subscription", async () => {
    const initial = createEmptyAppearanceState();
    const latest: AppearancePersistedState = {
      ...initial,
      revision: 1,
      preference: { mode: "dark" },
    };
    let loads = 0;
    const storage: AppearanceStorageAdapter = {
      load: async () => (++loads === 1 ? initial : latest),
      commit: async () => undefined,
      subscribe: () => () => undefined,
    };
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    expect(loads).toBe(2);
    expect(runtime.getSnapshot().revision).toBe(1);
    expect(runtime.getSnapshot().preference.mode).toBe("dark");
  });
  it("refreshes durable state before a persistent command", async () => {
    const storage = new MemoryStorage();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    storage.state = {
      ...storage.state,
      revision: 1,
      preference: { mode: "light" },
    };
    const result = await runtime.execute({
      type: "preference",
      preference: { mode: "dark" },
    });
    expect(result.status).toBe("applied");
    expect(storage.state.revision).toBe(2);
    expect(storage.state.preference.mode).toBe("dark");
  });
  it("retries once when durable state advances during a persistent command", async () => {
    let durable = createEmptyAppearanceState();
    let raceCommit = true;
    const storage: AppearanceStorageAdapter = {
      load: async () => durable,
      commit: async (expectedRevision, candidate) => {
        if (expectedRevision !== durable.revision) throw new Error("revision conflict");
        if (raceCommit) {
          raceCommit = false;
          durable = {
            ...durable,
            revision: durable.revision + 1,
            preference: { mode: "light" },
          };
          throw new Error("revision conflict");
        }
        durable = candidate;
      },
      subscribe: () => () => undefined,
    };
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    const result = await runtime.execute({
      type: "preference",
      preference: { mode: "dark" },
    });
    expect(result.status).toBe("applied");
    expect(durable.revision).toBe(2);
    expect(durable.preference.mode).toBe("dark");
  });

  it("quarantines a package after initial compilation failure and does not retry it", async () => {
    const seed = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await seed.execute(packageCommand("install"));
    const storage = new RecoveringMemoryStorage(seed.getSnapshot());
    const compileSafeModes: boolean[] = [];
    const compiler = compilerThatNormalizes();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: {
        ...compiler,
        compile: async (input) => {
          compileSafeModes.push(input.state.safeMode);
          if (!input.state.safeMode) throw new Error("malicious stylesheet");
          return compiler.compile(input);
        },
      },
      apply: { apply: async () => undefined },
    });
    expect(compileSafeModes).toEqual([false, true]);
    expect(storage.recoveries).toBe(1);
    expect(runtime.getSnapshot().safeMode).toBe(true);
    expect(runtime.getSnapshot().diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "startup-failure" })]),
    );

    await createAppearanceRuntime({
      storage,
      compiler,
      apply: { apply: async () => undefined },
    });
    expect(storage.recoveries).toBe(1);
  });

  it("quarantines a package after initial apply failure and applies only safe recovery", async () => {
    const seed = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await seed.execute(packageCommand("install"));
    const storage = new RecoveringMemoryStorage(seed.getSnapshot());
    const appliedSafeModes: boolean[] = [];
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: {
        apply: async (compiled) => {
          appliedSafeModes.push(compiled.input.state.safeMode);
          if (!compiled.input.state.safeMode) throw new Error("renderer startup failed");
        },
      },
    });
    expect(appliedSafeModes).toEqual([false, true]);
    expect(storage.recoveries).toBe(1);
    expect(runtime.getSnapshot().safeMode).toBe(true);
    expect(runtime.getSnapshot().diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "startup-failure" })]),
    );
  });

  it("cancels before mutation and rolls back a failed apply", async () => {
    const storage = new MemoryStorage();
    let failApply = false;
    const compiler = compilerThatNormalizes();
    const apply = {
      apply: async (compiled: AppearanceCompiledOutput): Promise<void> => {
        if (failApply && compiled.input.state.revision > 0) throw new Error("apply failed");
      },
    };
    const runtime = await createAppearanceRuntime({ storage, compiler, apply });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runtime.execute(
      { type: "safe-mode", enabled: true },
      controller.signal,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(runtime.getSnapshot().safeMode).toBe(false);

    failApply = true;
    const rejected = await runtime.execute({ type: "safe-mode", enabled: true });
    expect(rejected.status).toBe("rejected");
    expect(runtime.getSnapshot().safeMode).toBe(false);
    expect(storage.commits).toBe(0);
  });
  it("commits every package mutation and restores last-good state on commit failure", async () => {
    const storage = new MemoryStorage();
    const appliedRevisions: number[] = [];
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: {
        apply: async (compiled) => {
          appliedRevisions.push(compiled.input.state.revision);
        },
      },
    });
    expect((await runtime.execute(packageCommand("install"))).status).toBe("applied");
    expect(
      (
        await runtime.execute({
          type: "install",
          package: { input: GROVE_THEME, sourceId: GROVE_THEME.id },
          activate: true,
        })
      ).status,
    ).toBe("applied");
    const updatedGrove = { ...GROVE_THEME, label: "Grove Updated" };
    expect(
      (
        await runtime.execute({
          type: "update",
          id: GROVE_THEME.id,
          package: { input: updatedGrove, sourceId: updatedGrove.id },
        })
      ).status,
    ).toBe("applied");
    expect((await runtime.execute({ type: "disable", id: GROVE_THEME.id })).status).toBe("applied");
    expect((await runtime.execute({ type: "enable", id: GROVE_THEME.id })).status).toBe("applied");
    expect(
      (
        await runtime.execute({
          type: "reorder",
          order: [GROVE_THEME.id, T3_CHAT_THEME.id],
        })
      ).status,
    ).toBe("applied");
    expect((await runtime.execute({ type: "delete", id: GROVE_THEME.id })).status).toBe("applied");

    storage.failCommits = true;
    const before = runtime.getSnapshot();
    const rejected = await runtime.execute({ type: "disable", id: T3_CHAT_THEME.id });
    expect(rejected.status).toBe("rejected");
    expect(runtime.getSnapshot()).toBe(before);
    expect(runtime.getSnapshot().packages[T3_CHAT_THEME.id]?.enabled).toBe(true);
    expect(storage.state.packages[T3_CHAT_THEME.id]?.enabled).toBe(true);
    expect(appliedRevisions.at(-1)).toBe(before.revision);
  });

  it("resolves mode-only and stale variant preferences through one deterministic fallback", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    expect((await runtime.execute(packageCommand("install"))).status).toBe("applied");
    expect(
      (
        await runtime.execute({
          type: "preference",
          preference: { mode: "dark", packageId: T3_CHAT_THEME.id },
        })
      ).status,
    ).toBe("applied");
    expect(runtime.getSnapshot().resolved.variant?.appearance).toBe("dark");

    expect(
      (
        await runtime.execute({
          type: "preference",
          preference: {
            mode: "light",
            packageId: T3_CHAT_THEME.id,
            variantId: "removed-variant",
          },
        })
      ).status,
    ).toBe("applied");
    expect(runtime.getSnapshot().resolved.variant?.appearance).toBe("light");
  });
  it("skips enabled packages that reject an unavailable appearance variant", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await runtime.execute(packageCommand("install"));
    const installed = runtime.getSnapshot().packages[T3_CHAT_THEME.id];
    if (installed === undefined) throw new Error("Expected the built-in appearance package.");
    const lightVariant = installed.manifest.variants.find(
      (variant) => variant.appearance === "light",
    );
    if (lightVariant === undefined) throw new Error("Expected a light appearance variant.");
    const rejectManifest = {
      ...installed.manifest,
      metadata: { ...installed.manifest.metadata, id: "reject-package", name: "Reject Package" },
      fallback: { light: "default-variant", dark: "reject" } as const,
      defaultVariant: lightVariant.id,
      variants: [lightVariant],
    };
    const installedReject = await runtime.execute({
      type: "install",
      package: { input: rejectManifest, sourceId: "reject-package" },
      activate: true,
    });
    expect(installedReject.status).toBe("applied");

    const selected = await runtime.execute({
      type: "preference",
      preference: { mode: "dark", packageId: "reject-package" },
    });
    expect(selected.status).toBe("applied");
    expect(selected.snapshot.resolved.basePackageId).toBe(T3_CHAT_THEME.id);
    expect(selected.snapshot.resolved.baseVariant?.appearance).toBe("dark");
  });

  it("normalizes installs and handles environment package disappearance", async () => {
    const storage = new MemoryStorage();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    const installed = await runtime.execute(packageCommand("install"));
    expect(installed.status).toBe("applied");
    const environment = await runtime.execute({
      type: "environment-packages",
      packages: [{ input: GROVE_THEME, sourceId: GROVE_THEME.id }],
    });
    expect(environment.status).toBe("applied");
    expect(runtime.getSnapshot().revision).toBe(1);
    expect(storage.commits).toBe(1);
    await runtime.execute({
      type: "preference",
      preference: { mode: "dark", packageId: GROVE_THEME.id, variantId: "dark" },
    });
    expect(storage.state.environmentPackages).toHaveLength(0);
    expect(runtime.getSnapshot().resolved.variant?.colors.canvas).toBe(
      GROVE_THEME.variants?.dark?.canvas,
    );
    const disappeared = await runtime.execute({ type: "environment-packages", packages: [] });
    expect(disappeared.status).toBe("applied");
    expect(runtime.getSnapshot().environmentPackages).toHaveLength(0);
    expect(runtime.getSnapshot().resolved.variant?.colors.canvas).toBe(
      T3_CHAT_THEME.variants?.dark?.canvas,
    );
  });
  it("assigns environment-palette trust regardless of caller-supplied trust", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
    });
    const result = await runtime.execute({
      type: "environment-packages",
      packages: [
        {
          input: GROVE_THEME,
          sourceId: GROVE_THEME.id,
          trust: {
            class: "local-package",
            allowSharedCss: true,
            allowDesktopCss: true,
            allowAdvancedSnippet: true,
          },
        },
      ],
    });
    expect(result.status).toBe("applied");
    expect(runtime.getSnapshot().environmentPackages[0]?.profile.trust).toEqual(
      ENVIRONMENT_PALETTE_TRUST,
    );
  });

  it("rejects persisted environment packages with forged trust", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
    });
    await runtime.execute({
      type: "environment-packages",
      packages: [{ input: GROVE_THEME, sourceId: GROVE_THEME.id }],
    });
    const environmentPackage = runtime.getSnapshot().environmentPackages[0];
    if (environmentPackage === undefined) throw new Error("missing environment package fixture");
    const forged = {
      ...environmentPackage,
      profile: {
        ...environmentPackage.profile,
        trust: {
          class: "local-package" as const,
          allowSharedCss: false,
          allowDesktopCss: false,
          allowAdvancedSnippet: false,
        },
      },
    };
    expect(
      decodeAppearancePersistedState({
        ...createEmptyAppearanceState(),
        environmentPackages: [forged],
      }),
    ).toBeNull();
  });

  it("drops stale persisted environment palettes before initial compilation", async () => {
    const seed = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await seed.execute({
      type: "environment-packages",
      packages: [{ input: GROVE_THEME, sourceId: GROVE_THEME.id }],
    });
    const seeded = seed.getSnapshot();
    const stale: AppearancePersistedState = {
      revision: 4,
      packages: {},
      order: [],
      preference: { mode: "dark", packageId: GROVE_THEME.id, variantId: "dark" },
      snippets: [],
      accessibility: {},
      safeMode: false,
      environmentPackages: seeded.environmentPackages,
      diagnostics: [],
      migration: { completed: true, sourceVersion: 2 },
    };
    const storage = new MemoryStorage(stale);
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    expect(runtime.getSnapshot().environmentPackages).toHaveLength(0);
    expect(runtime.getSnapshot().resolved.variant).toBeNull();
    expect(storage.commits).toBe(0);
  });

  it("suppresses duplicate broadcast revisions and does not notify twice", async () => {
    const storage = new MemoryStorage();
    const broadcast = new MemoryBroadcast();
    const runtime = await createAppearanceRuntime({
      storage,
      broadcast,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    let notifications = 0;
    runtime.subscribe(() => {
      notifications += 1;
      runtime.getSnapshot();
    });
    const result = await runtime.execute({ type: "safe-mode", enabled: true });
    expect(result.status).toBe("applied");
    expect(notifications).toBe(1);
    const event = broadcast.events[0];
    if (event === undefined) throw new Error("missing broadcast event");
    broadcast.emit(event);
    await Promise.resolve();
    expect(notifications).toBe(1);
  });
  it("does not compile, commit, or notify for an identical persistent command", async () => {
    const storage = new MemoryStorage();
    let compilations = 0;
    let notifications = 0;
    const compiler = compilerThatNormalizes();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: {
        ...compiler,
        compile: async (input) => {
          compilations += 1;
          return { input, artifact: "" };
        },
      },
      apply: { apply: async () => undefined },
    });
    runtime.subscribe(() => {
      notifications += 1;
    });
    const result = await runtime.execute({ type: "safe-mode", enabled: false });
    expect(result.status).toBe("applied");
    expect(result.snapshot.revision).toBe(0);
    expect(compilations).toBe(1);
    expect(storage.commits).toBe(0);
    expect(notifications).toBe(0);
  });
  it("serializes racing commands in call order", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    const [light, dark] = await Promise.all([
      runtime.execute({ type: "preference", preference: { mode: "light" } }),
      runtime.execute({ type: "preference", preference: { mode: "dark" } }),
    ]);
    expect(light.status).toBe("applied");
    expect(dark.status).toBe("applied");
    expect(runtime.getSnapshot().preference.mode).toBe("dark");
    expect(runtime.getSnapshot().revision).toBe(2);
  });

  it("resolves package-id previews without requiring a duplicate profile payload", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await runtime.execute(packageCommand("install"));
    await runtime.execute({
      type: "install",
      package: { input: GROVE_THEME, sourceId: GROVE_THEME.id },
      activate: true,
    });
    await runtime.execute({
      type: "snippet-upsert",
      snippet: {
        id: "preview-companion",
        css: ":root{--preview-companion:1}",
        enabled: true,
        advanced: false,
      },
    });
    await runtime.execute({
      type: "preference",
      preference: { mode: "dark", packageId: T3_CHAT_THEME.id },
    });
    const preview = await runtime.execute({
      type: "preview",
      preview: { packageId: GROVE_THEME.id, variantId: "dark" },
    });
    expect(preview.status).toBe("applied");
    expect(preview.snapshot.resolved.baseVariant?.colors.canvas).toBe(
      T3_CHAT_THEME.variants?.dark?.canvas,
    );
    expect(preview.snapshot.resolved.previewVariant?.colors.canvas).toBe(
      GROVE_THEME.variants?.dark?.canvas,
    );
    expect(preview.snapshot.resolved.values.canvas).toBe(GROVE_THEME.variants?.dark?.canvas);
    expect(preview.snapshot.resolved.css).toContain("--preview-companion");
    const isolated = await runtime.execute({
      type: "preview",
      preview: {
        packageId: GROVE_THEME.id,
        variantId: "dark",
        includeSnippets: false,
      },
    });
    expect(isolated.status).toBe("applied");
    expect(isolated.snapshot.resolved.css).not.toContain("--preview-companion");
  });

  it("returns typed diagnostics for a malformed preview boundary value", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    const result = await runtime.execute({
      type: "preview",
      preview: { profile: {} },
    } as unknown as AppearanceCommand);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("malformed preview was accepted");
    expect(result.diagnostics[0]?.message).toContain("normalized contract");
    expect(result.snapshot.preview).toBeNull();
    const inert = await runtime.execute({
      type: "preview",
      preview: {},
    } as unknown as AppearanceCommand);
    expect(inert.status).toBe("rejected");
  });

  it("keeps previews transient while applying preference and accessibility precedence", async () => {
    const storage = new MemoryStorage();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    const normalized = normalizeAppearance(T3_CHAT_THEME);
    if (normalized.status === "failure") throw new Error(normalized.diagnostic.message);
    const preview = await runtime.execute({
      type: "preview",
      preview: { profile: normalized.profile, variantId: "dark" },
    });
    expect(preview.status).toBe("applied");
    expect(preview.snapshot.revision).toBe(0);
    expect(preview.snapshot.preview?.variantId).toBe("dark");
    expect(preview.snapshot.resolved.baseVariant).toBeNull();
    expect(preview.snapshot.resolved.previewVariant?.id).toBe("dark");
    expect(preview.snapshot.resolved.variant?.id).toBe("dark");
    expect(storage.commits).toBe(0);

    await runtime.execute({
      type: "preference",
      preference: { mode: "dark", overrides: { canvas: "#111111" } },
    });
    const accessible = await runtime.execute({
      type: "accessibility",
      values: { canvas: "#222222" },
    });
    expect(accessible.snapshot.resolved.values.canvas).toBe("#222222");
  });

  it("keeps migration finalized across reset and restart", async () => {
    const initial = {
      ...createEmptyAppearanceState(),
      migration: { completed: true, sourceVersion: 1 },
    } satisfies AppearancePersistedState;
    const storage = new MemoryStorage(initial);
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await runtime.execute(packageCommand("install"));
    expect((await runtime.execute({ type: "reset" })).status).toBe("applied");
    expect(storage.state.migration).toEqual({ completed: true, sourceVersion: 1 });

    let legacyReads = 0;
    await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      legacy: {
        read: async () => {
          legacyReads += 1;
          return [T3_CHAT_THEME];
        },
      },
    });
    expect(legacyReads).toBe(0);
    expect(storage.state.packages).toEqual({});
  });

  it("cannot leave forced safe mode or resolve installed package content", async () => {
    const storage = new MemoryStorage({ ...createEmptyAppearanceState(), safeMode: true });
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      forceSafeMode: true,
    });
    expect(storage.loads).toBe(0);
    expect(storage.subscriptions).toBe(0);
    const installed = await runtime.execute(packageCommand("install"));
    expect(installed.status).toBe("rejected");
    expect(installed.snapshot.safeMode).toBe(true);
    expect(installed.snapshot.resolved.variant).toBeNull();
    const unsafe = await runtime.execute({ type: "safe-mode", enabled: false });
    expect(unsafe.status).toBe("rejected");
    const reset = await runtime.execute({ type: "reset" });
    expect(reset.status).toBe("applied");
    expect(reset.snapshot.safeMode).toBe(true);
    expect(reset.snapshot.packages).toEqual({});
    const refreshed = await runtime.execute({ type: "refresh" });
    expect(refreshed.status).toBe("applied");
    expect(refreshed.snapshot.safeMode).toBe(true);
    expect(storage.loads).toBe(2);
    expect(storage.commits).toBe(1);
    expect(storage.state.safeMode).toBe(false);
  });
  it("manages snippets by stable ID without losing explicit order", async () => {
    const storage = new MemoryStorage();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    await runtime.execute({
      type: "snippet-upsert",
      snippet: { id: "first", css: ":root{--one:1}", enabled: true, advanced: false },
    });
    await runtime.execute({
      type: "snippet-upsert",
      snippet: { id: "second", css: ":root{--two:2}", enabled: true, advanced: true },
    });
    await runtime.execute({ type: "snippet-reorder", order: ["second", "first"] });
    await runtime.execute({ type: "snippet-enable", id: "first", enabled: false });
    expect(runtime.getSnapshot().snippets).toEqual([
      { id: "second", css: ":root{--two:2}", enabled: true, advanced: true },
      { id: "first", css: ":root{--one:1}", enabled: false, advanced: false },
    ]);
    await runtime.execute({ type: "snippet-delete", id: "second" });
    expect(runtime.getSnapshot().snippets.map((snippet) => snippet.id)).toEqual(["first"]);
  });

  it("resolves system preferences from the current platform appearance", async () => {
    let systemAppearance: "light" | "dark" = "dark";
    const storage = new MemoryStorage();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      systemAppearance: () => systemAppearance,
    });
    expect((await runtime.execute(packageCommand("install"))).status).toBe("applied");
    expect(
      (
        await runtime.execute({
          type: "install",
          package: { input: GROVE_THEME, sourceId: GROVE_THEME.id },
          activate: true,
        })
      ).status,
    ).toBe("applied");
    await runtime.execute({
      type: "preference",
      preference: {
        mode: "system",
        packageId: T3_CHAT_THEME.id,
        lightPackageId: T3_CHAT_THEME.id,
        darkPackageId: GROVE_THEME.id,
        variantId: "light",
      },
    });
    expect(runtime.getSnapshot().resolved.baseVariant?.colors.canvas).toBe(
      themeCanvas(GROVE_THEME, "dark"),
    );

    const commitsBeforeRefresh = storage.commits;
    systemAppearance = "light";
    const refreshed = await runtime.execute({ type: "refresh" });
    expect(refreshed.status).toBe("applied");
    expect(storage.commits).toBe(commitsBeforeRefresh);
    expect(runtime.getSnapshot().resolved.baseVariant?.colors.canvas).toBe(
      themeCanvas(T3_CHAT_THEME, "light"),
    );
  });
});

describe("appearance migration", () => {
  it("is idempotent after the one-time marker is set", async () => {
    const adapter: AppearanceLegacyInputAdapter = {
      read: async (): Promise<ReadonlyArray<ThemeDefinition>> => [T3_CHAT_THEME],
    };
    const compiler = compilerThatNormalizes();
    const first = await migrateAppearanceState(createEmptyAppearanceState(), adapter, compiler);
    const second = await migrateAppearanceState(first, adapter, compiler);
    expect(first.migration.completed).toBe(true);
    expect(Object.keys(first.packages)).toHaveLength(1);
    expect(second.packages).toEqual(first.packages);
    expect(second.revision).toBe(first.revision);
  });
  it("caps oversized legacy libraries and finalizes migration once", async () => {
    const themes = Array.from({ length: 300 }, (_, index): ThemeDefinition => ({
      ...T3_CHAT_THEME,
      id: `legacy-theme-${index}`,
      label: `Legacy Theme ${index}`,
    }));
    const migrated = await migrateAppearanceState(
      createEmptyAppearanceState(),
      { read: async () => themes },
      compilerThatNormalizes(),
    );
    expect(Object.keys(migrated.packages)).toHaveLength(256);
    expect(migrated.order).toHaveLength(256);
    expect(migrated.migration.completed).toBe(true);
    expect(migrated.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("package limit is 256") }),
      ]),
    );
  });
  it("preserves light and dark half package selection across restart", async () => {
    const storage = new MemoryStorage();
    const legacy: AppearanceLegacyInputAdapter = {
      read: async () => [T3_CHAT_THEME, GROVE_THEME],
      readPreference: async () => ({
        mode: "system",
        packageId: T3_CHAT_THEME.id,
        lightPackageId: T3_CHAT_THEME.id,
        darkPackageId: GROVE_THEME.id,
        variantId: "light",
      }),
    };
    const shared = {
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      legacy,
    } as const;
    const darkRuntime = await createAppearanceRuntime({
      ...shared,
      systemAppearance: () => "dark",
    });
    expect(darkRuntime.getSnapshot().resolved.baseVariant?.colors.canvas).toBe(
      themeCanvas(GROVE_THEME, "dark"),
    );

    const lightRuntime = await createAppearanceRuntime({
      ...shared,
      systemAppearance: () => "light",
    });
    expect(lightRuntime.getSnapshot().resolved.baseVariant?.colors.canvas).toBe(
      themeCanvas(T3_CHAT_THEME, "light"),
    );
  });

  it("commits the legacy preference before finalizing and never reruns", async () => {
    const storage = new MemoryStorage();
    let reads = 0;
    let finalizations = 0;
    const legacy: AppearanceLegacyInputAdapter = {
      read: async () => {
        reads += 1;
        return [T3_CHAT_THEME];
      },
      readPreference: async () => ({
        mode: "dark" as const,
        packageId: T3_CHAT_THEME.id,
        variantId: "dark",
      }),
      finalize: async () => {
        finalizations += 1;
      },
    };
    const options = {
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      legacy,
    } as const;
    const first = await createAppearanceRuntime(options);
    expect(first.getSnapshot().preference).toMatchObject({
      mode: "dark",
      packageId: T3_CHAT_THEME.id,
    });
    expect(storage.state.migration.completed).toBe(true);
    await createAppearanceRuntime(options);
    expect(reads).toBe(1);
    expect(finalizations).toBe(1);
  });
  it("falls back from an invalid legacy preference and records a migration diagnostic", async () => {
    const storage = new MemoryStorage();
    let preferenceReads = 0;
    let finalizations = 0;
    const legacy: AppearanceLegacyInputAdapter = {
      read: async () => [],
      readPreference: async () => {
        preferenceReads += 1;
        return { mode: "sepia" };
      },
      finalize: async () => {
        finalizations += 1;
      },
    };
    const options = {
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      legacy,
    } as const;

    const first = await createAppearanceRuntime(options);

    expect(first.getSnapshot().preference).toEqual(createEmptyAppearanceState().preference);
    expect(storage.state.preference).toEqual(createEmptyAppearanceState().preference);
    expect(storage.state.diagnostics).toHaveLength(1);
    expect(storage.state.diagnostics[0]).toMatchObject({
      code: "invalid-version-1-theme",
      severity: "warning",
      path: ["preference"],
    });
    expect(storage.state.migration.completed).toBe(true);
    expect(finalizations).toBe(1);

    await createAppearanceRuntime(options);

    expect(preferenceReads).toBe(1);
    expect(finalizations).toBe(1);
  });

  it("keeps migration pending after a failed commit and retries before finalizing", async () => {
    const storage = new MemoryStorage();
    storage.failCommits = true;
    let reads = 0;
    let finalizations = 0;
    const legacy: AppearanceLegacyInputAdapter = {
      read: async () => {
        reads += 1;
        return [T3_CHAT_THEME];
      },
      readPreference: async () => ({
        mode: "dark" as const,
        packageId: T3_CHAT_THEME.id,
        variantId: "dark",
      }),
      finalize: async () => {
        finalizations += 1;
      },
    };
    const options = {
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
      legacy,
    } as const;

    const failed = await createAppearanceRuntime(options);

    expect(failed.getSnapshot().migration.completed).toBe(false);
    expect(storage.state.migration.completed).toBe(false);
    expect(storage.state.packages).toEqual({});
    expect(storage.commits).toBe(0);
    expect(finalizations).toBe(0);

    storage.failCommits = false;
    await createAppearanceRuntime(options);

    expect(storage.state.migration.completed).toBe(true);
    expect(Object.keys(storage.state.packages)).toHaveLength(1);
    expect(storage.commits).toBe(1);
    expect(reads).toBe(2);
    expect(finalizations).toBe(1);

    await createAppearanceRuntime(options);

    expect(reads).toBe(2);
    expect(finalizations).toBe(1);
    expect(storage.commits).toBe(1);
  });
});

describe("persisted appearance compatibility", () => {
  it("retains an incompatible package disabled with a diagnostic after app upgrade", async () => {
    const storage = new MemoryStorage();
    const initial = await createAppearanceRuntime({
      storage,
      compiler: compilerThatNormalizes(),
      apply: { apply: async () => undefined },
    });
    expect((await initial.execute(packageCommand("install"))).status).toBe("applied");
    const installed = storage.state.packages[T3_CHAT_THEME.id];
    if (installed === undefined) throw new Error("Expected installed package.");
    const manifest = {
      ...installed.manifest,
      compatibility: {
        ...installed.manifest.compatibility,
        maximumAppVersion: "1.0.0",
      },
    };
    const compatible = normalizeAppearance(manifest, { appVersion: "1.0.0" });
    if (compatible.status === "failure") throw new Error(compatible.diagnostic.message);
    storage.state = {
      ...storage.state,
      packages: {
        ...storage.state.packages,
        [T3_CHAT_THEME.id]: {
          ...installed,
          manifest,
          manifestHash: appearanceSha256(manifest),
          profile: compatible.profile,
        },
      },
    };
    const beforeRevision = storage.state.revision;

    const runtime = await createAppearanceRuntime({
      storage,
      compiler: {
        normalize: (input, options) =>
          normalizeAppearance(input, { ...options, appVersion: "2.0.0" }),
        compile: async (input) => ({ input, artifact: input.resolved.css }),
      },
      apply: { apply: async () => undefined },
    });

    expect(runtime.getSnapshot().packages[T3_CHAT_THEME.id]?.enabled).toBe(false);
    expect(runtime.getSnapshot().packages[T3_CHAT_THEME.id]?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "incompatible-app-version" })]),
    );
    expect(storage.state.revision).toBe(beforeRevision + 1);
  });
});
