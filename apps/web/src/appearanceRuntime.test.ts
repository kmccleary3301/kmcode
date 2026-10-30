import { describe, expect, it } from "@effect/vitest";
import type { DesktopAppearanceCommitInput, DesktopAppearanceWatchEvent } from "@t3tools/contracts";

import {
  createAppearanceRuntime,
  createEmptyAppearanceState,
  DesktopBridgeAppearanceStorage,
  type AppearanceCompilerAdapter,
  type AppearancePersistedState,
  type AppearanceStorageAdapter,
} from "@t3tools/client-runtime/appearance";
import {
  appearanceBytesSha256,
  appearanceSha256,
  normalizeAppearance,
} from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import { compileWebAppearance, deferredAppearanceStorage } from "./appearanceRuntime";

class MemoryStorage implements AppearanceStorageAdapter {
  state: AppearancePersistedState = createEmptyAppearanceState();
  readonly listeners = new Set<(state: AppearancePersistedState) => void>();

  load = async (): Promise<AppearancePersistedState> => this.state;
  commit = async (expectedRevision: number, state: AppearancePersistedState): Promise<void> => {
    if (this.state.revision !== expectedRevision) throw new Error("revision conflict");
    this.state = state;
  };
  subscribe = (listener: (state: AppearancePersistedState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const compiler: AppearanceCompilerAdapter = {
  normalize: (input, options) => normalizeAppearance(input, options),
  compile: async (input) => compileWebAppearance(input),
};

class ReceiverAwareStorage implements AppearanceStorageAdapter {
  readonly calls: string[] = [];
  readonly state = createEmptyAppearanceState();

  async load(): Promise<AppearancePersistedState> {
    return this.state;
  }

  async commit(): Promise<void> {
    this.calls.push("commit");
  }

  async recover(state: AppearancePersistedState): Promise<AppearancePersistedState> {
    this.calls.push("recover");
    return state;
  }

  async readQuarantinedState(): Promise<AppearancePersistedState | null> {
    return this.state;
  }

  async restoreQuarantinedState(): Promise<AppearancePersistedState> {
    this.calls.push("restore");
    return this.state;
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
describe("web appearance runtime adapter", () => {
  it("preserves the storage receiver for deferred recovery operations", async () => {
    const storage = new ReceiverAwareStorage();
    const deferred = deferredAppearanceStorage(() => storage);

    await expect(deferred.recover?.(storage.state)).resolves.toBe(storage.state);
    await expect(deferred.restoreQuarantinedState?.()).resolves.toBe(storage.state);
    expect(storage.calls).toEqual(["recover", "restore"]);
  });

  it("compiles palette, typography, snippets, and overrides in precedence order", async () => {
    const artifacts: string[] = [];
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler,
      apply: {
        apply: async (compiled) => {
          artifacts.push(compiled.artifact);
        },
      },
    });
    await runtime.execute({
      type: "install",
      package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
      activate: true,
    });
    await runtime.execute({
      type: "preference",
      preference: {
        mode: "dark",
        packageId: T3_CHAT_THEME.id,
        variantId: "dark",
        overrides: { canvas: "#111111", customBrand: "#abcdef" },
      },
    });
    await runtime.execute({
      type: "typography-preference",
      preference: {
        sans: "Inter",
        code: "JetBrains Mono",
        composer: "",
        terminal: "SF Mono",
        sizeInterface: 17,
        sizePrompt: 15,
        sizeCode: 14,
        sizeTerminal: 13,
        smoothing: true,
      },
    });
    await runtime.execute({
      type: "snippets",
      snippets: [
        {
          id: "ordinary",
          css: ":root{--ordinary-marker:#123456;}",
          enabled: true,
          advanced: false,
        },
        { id: "advanced", css: ":root{--advanced-marker:#654321;}", enabled: true, advanced: true },
      ],
    });
    await runtime.execute({ type: "accessibility", values: { canvas: "#222222" } });

    const artifact = artifacts.at(-1) ?? "";
    expect(artifact).toContain("--app-theme-canvas:");
    expect(artifact).toContain("--font-sans:");
    expect(artifact).toContain("--font-sans:Inter,");
    expect(artifact).toContain("--t3-custom-brand:#abcdef");
    expect(artifact).toContain("font-size:17px");
    expect(artifact).toContain("--font-size-terminal:13px");
    expect(artifact).toContain("-webkit-font-smoothing:antialiased");
    expect(artifact.indexOf("--ordinary-marker")).toBeLessThan(
      artifact.indexOf("--app-theme-canvas:#222222"),
    );
    expect(artifact.indexOf("--app-theme-canvas:#222222")).toBeLessThan(
      artifact.indexOf("--advanced-marker"),
    );
  });

  it("removes every persisted custom declaration from the safe recovery stylesheet", async () => {
    let artifact = "";
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler,
      apply: {
        apply: async (compiled) => {
          artifact = compiled.artifact;
        },
      },
    });
    await runtime.execute({
      type: "install",
      package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
      activate: true,
    });
    await runtime.execute({
      type: "snippets",
      snippets: [
        { id: "ordinary", css: ":root{--unsafe-marker:#123456;}", enabled: true, advanced: false },
      ],
    });
    await runtime.execute({ type: "accessibility", values: { canvas: "#222222" } });
    await runtime.execute({ type: "safe-mode", enabled: true });

    expect(artifact).not.toContain("--unsafe-marker");
    expect(artifact).not.toContain("--font-sans:");
    expect(artifact).not.toContain("--app-theme-canvas:#222222");
  });
  it("isolates broken CSS and keeps desktop-only rules off browser clients", async () => {
    const artifacts: string[] = [];
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler,
      apply: {
        apply: async (compiled) => {
          artifacts.push(compiled.artifact);
        },
      },
    });
    await runtime.execute({
      type: "install",
      package: {
        input: T3_CHAT_THEME,
        sourceId: T3_CHAT_THEME.id,
        trust: {
          class: "local-package",
          allowSharedCss: true,
          allowDesktopCss: true,
          allowAdvancedSnippet: false,
        },
        sharedCss: ":root{--shared-marker:#123456}",
        desktopCss: ":root{--desktop-marker:#654321}",
      },
      activate: true,
    });
    const result = await runtime.execute({
      type: "snippets",
      snippets: [
        { id: "valid", css: ":root{--valid-marker:#abcdef}", enabled: true, advanced: false },
        {
          id: "broken",
          css: '@import "https://example.com/a.css";',
          enabled: true,
          advanced: false,
        },
      ],
    });

    expect(result.status).toBe("applied");
    expect(artifacts.at(-1)).toContain("--shared-marker");
    expect(artifacts.at(-1)).toContain("--valid-marker");
    expect(artifacts.at(-1)).not.toContain("example.com");
    expect(artifacts.at(-1)).not.toContain("--desktop-marker");
    expect(result.snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          line: 1,
          column: 1,
          recovery: expect.any(String),
        }),
      ]),
    );
    expect(artifacts.at(-1)).toContain(
      "@layer t3.reset,t3.base,t3.components,t3.theme,t3.preferences,t3.snippets",
    );
  });

  it("includes desktop-only package CSS only for the desktop compiler adapter", async () => {
    const storage = new MemoryStorage();
    const runtime = await createAppearanceRuntime({
      storage,
      compiler,
      apply: { apply: async () => undefined },
    });
    await runtime.execute({
      type: "install",
      package: {
        input: T3_CHAT_THEME,
        sourceId: T3_CHAT_THEME.id,
        trust: {
          class: "local-package",
          allowSharedCss: true,
          allowDesktopCss: true,
          allowAdvancedSnippet: false,
        },
        desktopCss: ":root{--desktop-marker:#654321}",
      },
      activate: true,
    });
    const snapshot = runtime.getSnapshot();
    expect(
      compileWebAppearance({ state: snapshot, resolved: snapshot.resolved }).artifact,
    ).not.toContain("--desktop-marker");
    expect(
      compileWebAppearance(
        { state: snapshot, resolved: snapshot.resolved },
        { includeDesktopCss: true },
      ).artifact,
    ).toContain("--desktop-marker");
  });

  it("forwards every desktop watch event to runtime reconciliation", async () => {
    let state = createEmptyAppearanceState();
    const watch: { listener: ((event: DesktopAppearanceWatchEvent) => void) | null } = {
      listener: null,
    };
    const document = () => ({
      stateJson: JSON.stringify(state),
      checksum: appearanceSha256(state),
    });
    const bridge = {
      readAppearanceState: async () => document(),
      commitAppearanceState: async (input: DesktopAppearanceCommitInput) => {
        const parsed = JSON.parse(input.stateJson) as AppearancePersistedState;
        state = parsed;
        const summary = {
          revision: state.revision,
          safeMode: state.safeMode,
          checksum: appearanceSha256(state),
        };
        watch.listener?.({ reason: "transaction", state: summary });
        return summary;
      },
      onAppearanceWatchEvent: (listener: (event: DesktopAppearanceWatchEvent) => void) => {
        watch.listener = listener;
        return () => {
          watch.listener = null;
        };
      },
    };
    const storage = new DesktopBridgeAppearanceStorage(bridge);
    await storage.load();
    const observed: AppearancePersistedState[] = [];
    const unsubscribe = storage.subscribe((next) => observed.push(next));

    state = { ...state, revision: 1, safeMode: true };
    const summary = {
      revision: state.revision,
      safeMode: state.safeMode,
      checksum: appearanceSha256(state),
    };
    watch.listener?.({ reason: "external-change", state: summary });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.safeMode).toBe(true);

    watch.listener?.({ reason: "external-change", state: summary });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toHaveLength(2);
    unsubscribe();
  });
  it("emits semantic typography, geometry, artwork, and protected motion variables", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler,
      apply: { apply: async () => undefined },
    });
    await runtime.execute({
      type: "install",
      package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
      activate: true,
    });
    const snapshot = runtime.getSnapshot();
    const artifact = compileWebAppearance({
      state: snapshot,
      resolved: snapshot.resolved,
    }).artifact;
    expect(artifact).toContain("--font-feature-settings-interface:normal");
    expect(artifact).toContain("--t3-space-md:12px");
    expect(artifact).toContain("--t3-outline-width:2px");
    expect(artifact).toContain("--t3-motion-duration-normal:200ms");
    expect(artifact).toContain("t3.preview");
  });
  it("compiles validated preview package CSS without overriding preference layer order", async () => {
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler,
      apply: { apply: async () => undefined },
    });
    await runtime.execute({
      type: "install",
      package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
      activate: true,
    });
    await runtime.execute({
      type: "snippet-upsert",
      snippet: {
        id: "existing-snippet",
        css: ":root{--existing-snippet-marker:#654321;}",
        enabled: true,
        advanced: false,
      },
    });
    const installed = runtime.getSnapshot().packages[T3_CHAT_THEME.id];
    if (installed === undefined) throw new Error("Expected the built-in appearance package.");
    const sharedCss = ":root{--preview-package-marker:#123456;}";
    const bytes = new TextEncoder().encode(sharedCss);
    const manifest = {
      ...installed.manifest,
      capabilities: [...installed.manifest.capabilities, "shared-css" as const],
      compatibility: {
        ...installed.manifest.compatibility,
        requiredCapabilities: [
          ...installed.manifest.compatibility.requiredCapabilities,
          "shared-css" as const,
        ],
      },
      styles: {
        web: {
          path: "preview.css",
          sha256: appearanceBytesSha256(bytes),
          sizeBytes: bytes.byteLength,
        },
      },
    };
    const trust = {
      class: "local-package" as const,
      allowSharedCss: true,
      allowDesktopCss: false,
      allowAdvancedSnippet: false,
    };
    const normalized = normalizeAppearance(manifest, { trust, platform: "web" });
    if (normalized.status === "failure") throw new Error(normalized.diagnostic.message);
    const result = await runtime.execute({
      type: "preview",
      preview: {
        package: {
          ...installed,
          manifest,
          manifestHash: appearanceSha256(manifest),
          profile: normalized.profile,
          sharedCss,
        },
        includeSnippets: false,
      },
    });
    if (result.status !== "applied") {
      throw new Error(
        result.status === "rejected"
          ? result.diagnostics.map((diagnostic) => diagnostic.message).join(" — ")
          : "Preview was cancelled.",
      );
    }
    const snapshot = runtime.getSnapshot();
    const artifact = compileWebAppearance({
      state: snapshot,
      resolved: snapshot.resolved,
    }).artifact;
    expect(artifact).toContain("--preview-package-marker");
    expect(artifact).not.toContain("--existing-snippet-marker");
    expect(artifact.indexOf("@layer t3.theme")).toBeLessThan(
      artifact.indexOf("--preview-package-marker"),
    );
    expect(artifact).toContain("t3.theme,t3.preferences,t3.snippets,t3.preview");
    expect(artifact).toContain("t3.preview");
  });
});
