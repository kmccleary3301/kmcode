import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createAppearanceRuntime,
  createEmptyAppearanceState,
  resolveAppearanceState,
  type AppearancePersistedState,
  type AppearanceResolved,
  type AppearanceStorageAdapter,
} from "@t3tools/client-runtime/appearance";
import { normalizeAppearance } from "@t3tools/shared/appearance";
import type { ThemeAppearance } from "@t3tools/shared/themePalettes";
import { EMBER_THEME, IRIS_THEME, OCEAN_THEME } from "../themePalette";
import type * as AppearanceRuntimeModule from "../appearanceRuntime";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

class FakeHTMLStyleElement {
  setAttribute = vi.fn();
  removeAttribute = vi.fn();
  textContent = "";
  style: Record<string, string> = {};
  id = "";
  nonce = "";
  remove = vi.fn();
  replaceWith = vi.fn();
  dataset: Record<string, string> = {};
}

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

function setupDomHarness(initialDataset: Record<string, string> = {}) {
  const styleProperties: Record<string, string> = {};
  const dataset: Record<string, string> = { ...initialDataset };
  const classNames = new Set<string>();

  const rootStyle = {
    setProperty: (name: string, value: string) => {
      styleProperties[name] = value;
    },
    removeProperty: (name: string) => {
      delete styleProperties[name];
    },
    item: (index: number) => Object.keys(styleProperties)[index] ?? "",
    get length() {
      return Object.keys(styleProperties).length;
    },
  };

  const classList = {
    add: (cls: string) => classNames.add(cls),
    remove: (cls: string) => classNames.delete(cls),
    toggle: (cls: string, force?: boolean) => {
      if (force !== undefined) {
        if (force) classNames.add(cls);
        else classNames.delete(cls);
        return force;
      }
      if (classNames.has(cls)) {
        classNames.delete(cls);
        return false;
      }
      classNames.add(cls);
      return true;
    },
    contains: (cls: string) => classNames.has(cls),
  };

  const documentElement = {
    dataset,
    classList,
    style: rootStyle,
    offsetHeight: 0,
  };
  const styleElement = new FakeHTMLStyleElement();
  const themeColor = { setAttribute: vi.fn(), name: "", dataset: {} };
  const body = { style: { backgroundColor: "" } };

  vi.stubGlobal("HTMLStyleElement", FakeHTMLStyleElement);
  vi.stubGlobal("document", {
    body,
    head: {
      append: vi.fn(),
      appendChild: vi.fn(),
    },
    createElement: (tag: string) => (tag === "style" ? new FakeHTMLStyleElement() : themeColor),
    getElementById: (id: string) => (id === "appearance-runtime-order" ? styleElement : null),
    documentElement,
    querySelector: (sel: string) => (sel.includes("style") ? styleElement : themeColor),
    querySelectorAll: (sel: string) => (sel.includes("style") ? [styleElement] : [themeColor]),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    backgroundColor: "#ffffff",
    getPropertyValue: (prop: string) => styleProperties[prop] ?? "",
  }));

  return { documentElement, classList, styleProperties, styleElement, themeColor, body };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "t3code:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "t3code:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "t3-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("does not apply a legacy theme during module evaluation before runtime recovery", async () => {
    const getItem = vi.fn(() => "unsafe-custom");
    const toggle = vi.fn();
    vi.stubGlobal("window", {
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
        classList: { toggle },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();
    expect(getItem).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("leaves the startup appearance runtime authoritative on hook mount", async () => {
    const useEffect = vi.fn();
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: createStorage(),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();

    expect(useEffect).not.toHaveBeenCalled();
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "t3code:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });

  it("prevents stale async runtime failure from rolling back a newer theme selection", async () => {
    let rejectFirstUpdate!: (reason: unknown) => void;
    const firstUpdatePromise = new Promise<void>((_, reject) => {
      rejectFirstUpdate = reject;
    });
    let callCount = 0;
    const applyAppearanceTheme = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return firstUpdatePromise;
      }
      return undefined;
    });
    const setAppearanceModePreference = vi.fn(async () => undefined);
    const actualAppearanceRuntime =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");
    vi.doMock("../appearanceRuntime", () => ({
      ...actualAppearanceRuntime,
      applyAppearanceTheme,
      setAppearanceModePreference,
    }));
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));
    const storage = createStorage();
    storage.setItem("t3code:theme", "km-code");
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    const themeColor = { setAttribute: vi.fn(), name: "" };
    vi.stubGlobal("document", {
      body: { style: {} },
      head: { appendChild: vi.fn() },
      createElement: () => themeColor,
      documentElement: {
        dataset: {},
        classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        offsetHeight: 0,
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      },
      querySelector: () => themeColor,
      querySelectorAll: () => [themeColor],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "#ffffff",
      getPropertyValue: () => "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const { useTheme } = await import("./useTheme");
    const theme = useTheme();

    expect(theme.setTheme("ocean")).toBe(true);
    expect(theme.setTheme("iris")).toBe(true);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    rejectFirstUpdate(new Error("ocean async update rejected"));
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.getItem("t3code:theme")).toBe("iris");
    consoleError.mockRestore();
  });

  it("synchronously updates theme palette when changing appearance mode with preserved runtime selection", async () => {
    const actualAppearanceRuntime =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");
    vi.doMock("../appearanceRuntime", () => ({
      ...actualAppearanceRuntime,
      applyAppearanceTheme: vi.fn(async () => undefined),
      setAppearanceModePreference: vi.fn(async () => undefined),
    }));
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));
    const storage = createStorage();
    storage.setItem("t3code:theme", "km-code");
    const styleProperties: Record<string, string> = {};
    const classNames = new Set<string>();
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    const themeColor = { setAttribute: vi.fn(), name: "" };
    vi.stubGlobal("document", {
      body: { style: {} },
      head: { appendChild: vi.fn() },
      createElement: () => themeColor,
      documentElement: {
        dataset: {},
        classList: {
          add: (cls: string) => classNames.add(cls),
          remove: (cls: string) => classNames.delete(cls),
          toggle: (cls: string, force?: boolean) => {
            if (force !== undefined) {
              if (force) classNames.add(cls);
              else classNames.delete(cls);
              return force;
            }
            if (classNames.has(cls)) {
              classNames.delete(cls);
              return false;
            }
            classNames.add(cls);
            return true;
          },
          contains: (cls: string) => classNames.has(cls),
        },
        offsetHeight: 0,
        style: {
          setProperty: (name: string, value: string) => {
            styleProperties[name] = value;
          },
          removeProperty: (name: string) => {
            delete styleProperties[name];
          },
        },
      },
      querySelector: () => themeColor,
      querySelectorAll: () => [themeColor],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "#ffffff",
      getPropertyValue: (prop: string) => styleProperties[prop] ?? "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const { useTheme } = await import("./useTheme");
    const theme = useTheme();

    expect(theme.setAppearanceMode("dark")).toBe(true);
    expect(classNames.has("dark")).toBe(true);
    expect(storage.getItem("t3code:theme-appearance-mode")).toBe("dark");
  });

  it("rapid A -> B -> C theme changes settle on C without stale intermediate overwrite in the DOM", async () => {
    let resolveOcean!: () => void;
    let resolveEmber!: () => void;
    let resolveIris!: () => void;
    const oceanPromise = new Promise<void>((resolve) => {
      resolveOcean = resolve;
    });
    const emberPromise = new Promise<void>((resolve) => {
      resolveEmber = resolve;
    });
    const irisPromise = new Promise<void>((resolve) => {
      resolveIris = resolve;
    });

    const { documentElement } = setupDomHarness();
    const storage = createStorage();
    storage.setItem("t3code:theme", "km-code");
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });

    const actualAppearanceRuntime =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");
    const { compileWebAppearance, applyWebAppearance } = actualAppearanceRuntime;

    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => compileWebAppearance(input),
      },
      apply: {
        apply: async (compiled) => applyWebAppearance(compiled),
      },
    });

    const applyAppearanceTheme = vi.fn(
      async (
        themeDef: { id: string },
        _appearance: string,
        _mode: string,
        _systems: unknown,
        generation?: number,
      ) => {
        const deferred =
          themeDef.id === "ocean"
            ? oceanPromise
            : themeDef.id === "ember"
              ? emberPromise
              : irisPromise;
        await deferred;

        const themeInput =
          themeDef.id === "ocean"
            ? OCEAN_THEME
            : themeDef.id === "ember"
              ? EMBER_THEME
              : IRIS_THEME;
        await runtime.execute({
          type: "install",
          package: {
            input: themeInput,
            sourceId: themeDef.id,
          },
          activate: true,
          ...(generation !== undefined ? { generation } : {}),
        });
      },
    );

    vi.doMock("../appearanceRuntime", () => ({
      ...actualAppearanceRuntime,
      applyAppearanceTheme,
    }));
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));

    const { useTheme } = await import("./useTheme");
    const theme = useTheme();

    expect(theme.setTheme("ocean")).toBe(true);
    expect(theme.setTheme("ember")).toBe(true);
    expect(theme.setTheme("iris")).toBe(true);

    resolveIris();
    await Promise.resolve();
    await Promise.resolve();

    expect(documentElement.dataset.themeId).toBe("iris");

    resolveOcean();
    resolveEmber();
    await Promise.resolve();
    await Promise.resolve();

    expect(documentElement.dataset.themeId).toBe("iris");
  });

  it("selecting theme followed by mode change preserves desired theme and does not fall back to KM", async () => {
    let resolveIrisPackage!: () => void;
    const irisPackagePromise = new Promise<void>((resolve) => {
      resolveIrisPackage = resolve;
    });

    const { documentElement, classList, styleProperties } = setupDomHarness({
      themeId: "user-custom-active",
    });
    const storage = createStorage();
    storage.setItem("t3code:theme", "km-code");
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const actualAppearanceRuntime =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");
    const { compileWebAppearance, applyWebAppearance } = actualAppearanceRuntime;

    const customThemeDef = {
      ...EMBER_THEME,
      id: "user-custom-active",
      label: "User Custom Active",
    };
    const customRuntime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => compileWebAppearance(input),
      },
      apply: { apply: async () => undefined },
    });
    await customRuntime.execute({
      type: "install",
      package: { input: customThemeDef, sourceId: customThemeDef.id },
      activate: true,
    });
    const resolveCustomAppearance = vi.fn(
      (
        appearance: ThemeAppearance,
        _mode: "system" | ThemeAppearance = appearance,
      ): AppearanceResolved | null =>
        resolveAppearanceState(customRuntime.getSnapshot(), null, () =>
          appearance === "dark" ? "dark" : "light",
        ),
    );
    const appliedThemeCalls: Array<{ themeId: string; mode: string; generation?: number }> = [];

    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => compileWebAppearance(input),
      },
      apply: {
        apply: async (compiled) => applyWebAppearance(compiled),
      },
    });

    const applyAppearanceTheme = vi.fn(
      async (
        themeDef: { id: string },
        appearance: string,
        preferenceMode: string,
        _systems: unknown,
        generation?: number,
      ) => {
        appliedThemeCalls.push({
          themeId: themeDef.id,
          mode: preferenceMode,
          ...(generation !== undefined ? { generation } : {}),
        });
        if (themeDef.id === "iris" && preferenceMode === "light") {
          await irisPackagePromise;
        }

        await runtime.execute({
          type: "install",
          package: { input: IRIS_THEME, sourceId: themeDef.id },
          activate: true,
          ...(generation !== undefined ? { generation } : {}),
        });
        await runtime.execute({
          type: "preference",
          preference: {
            mode:
              preferenceMode === "system" ? "system" : preferenceMode === "dark" ? "dark" : "light",
            packageId: themeDef.id,
            variantId: appearance,
          },
          ...(generation !== undefined ? { generation } : {}),
        });
      },
    );

    vi.doMock("../appearanceRuntime", () => ({
      ...actualAppearanceRuntime,
      applyAppearanceTheme,
      resolveAppearanceForMode: resolveCustomAppearance,
    }));
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));

    const { useTheme } = await import("./useTheme");
    const theme = useTheme();

    theme.setTheme("iris");
    theme.setAppearanceMode("dark");

    resolveIrisPackage();
    await Promise.resolve();
    await Promise.resolve();

    expect(documentElement.dataset.themeId).toBe("iris");
    expect(documentElement.dataset.themeId).not.toBe("user-custom-active");
    expect(classList.contains("dark")).toBe(true);
  });

  it("mode change with active custom package preserves custom package id and updates variant colors", async () => {
    const { documentElement, classList, styleProperties } = setupDomHarness({
      themeId: "my-custom-theme",
    });
    const storage = createStorage();
    storage.setItem("t3code:theme", "km-code");
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const { compileWebAppearance } =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");

    const customThemeDef = {
      ...EMBER_THEME,
      id: "my-custom-theme",
      label: "My Custom Theme",
      variants: {
        ...EMBER_THEME.variants,
        dark: {
          ...EMBER_THEME.variants?.dark,
          canvas: "#0a0a0a",
        },
      },
    };
    const customRuntime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => compileWebAppearance(input),
      },
      apply: { apply: async () => undefined },
    });
    await customRuntime.execute({
      type: "install",
      package: { input: customThemeDef, sourceId: customThemeDef.id },
      activate: true,
    });
    const resolveMyCustomAppearance = vi.fn(
      (
        appearance: ThemeAppearance,
        _mode: "system" | ThemeAppearance = appearance,
      ): AppearanceResolved | null =>
        appearance === "dark"
          ? resolveAppearanceState(customRuntime.getSnapshot(), null, () => "dark")
          : null,
    );

    const setAppearanceModePreference = vi.fn(async () => undefined);
    const actualAppearanceRuntime =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");

    vi.doMock("../appearanceRuntime", () => ({
      ...actualAppearanceRuntime,
      setAppearanceModePreference,
      resolveAppearanceForMode: resolveMyCustomAppearance,
    }));
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));

    const { useTheme } = await import("./useTheme");
    const theme = useTheme();

    theme.setAppearanceMode("dark");

    expect(styleProperties["--app-theme-canvas"]).toBe("#0a0a0a");
    expect(classList.contains("dark")).toBe(true);
    expect(documentElement.dataset.themeId).toBe("my-custom-theme");
  });
});

describe("stored theme versus a stale runtime package", () => {
  // Settings show T3 Chat for both appearances while the appearance runtime
  // still holds Ayu Dark (picked from the command palette or a stale persisted
  // preference). Ayu Dark has no light variant.
  async function setup(storedMode: "light" | "dark", runtimeAppearance: ThemeAppearance) {
    const { classList } = setupDomHarness();
    const storage = createStorage();
    storage.setItem("t3code:theme", "dark");
    storage.setItem(
      "t3code:theme-halves:v1",
      JSON.stringify({ light: "t3-chat", dark: "t3-chat" }),
    );
    storage.setItem("t3code:theme-appearance-mode", storedMode);
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const actualAppearanceRuntime =
      await vi.importActual<typeof AppearanceRuntimeModule>("../appearanceRuntime");
    const { getThemeDefinition } =
      await vi.importActual<typeof import("../themePalette")>("../themePalette");
    const runtime = await createAppearanceRuntime({
      storage: new MemoryStorage(),
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => actualAppearanceRuntime.compileWebAppearance(input),
      },
      apply: { apply: async () => undefined },
    });
    const runtimeTheme = getThemeDefinition(runtimeAppearance === "dark" ? "ayu-dark" : "t3-chat");
    if (runtimeTheme === null) throw new Error("library theme missing");
    await runtime.execute({
      type: "install",
      package: { input: runtimeTheme, sourceId: runtimeTheme.id },
      activate: true,
    });
    const resolved = resolveAppearanceState(runtime.getSnapshot(), null, () => runtimeAppearance);
    const applyAppearanceTheme = vi.fn(async () => undefined);
    const setAppearanceModePreference = vi.fn(async () => undefined);
    vi.doMock("../appearanceRuntime", () => ({
      ...actualAppearanceRuntime,
      applyAppearanceTheme,
      setAppearanceModePreference,
      resolveAppearanceForMode: () => resolved,
    }));
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));
    const module = await import("./useTheme");
    return { module, classList, applyAppearanceTheme, setAppearanceModePreference };
  }

  it("paints the stored theme in Light instead of keeping the dark-only runtime package", async () => {
    const { module, classList, applyAppearanceTheme, setAppearanceModePreference } = await setup(
      "dark",
      "dark",
    );

    expect(module.useTheme().setAppearanceMode("light")).toBe(true);

    expect(setAppearanceModePreference).not.toHaveBeenCalled();
    expect(applyAppearanceTheme).toHaveBeenCalledTimes(1);
    expect(applyAppearanceTheme).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t3-chat" }),
      "light",
      "light",
      expect.anything(),
      expect.any(Number),
    );
    expect(classList.contains("dark")).toBe(false);
  });

  it("repaints the stored selection at startup when the runtime restored another library theme", async () => {
    const { module, classList, applyAppearanceTheme } = await setup("light", "dark");

    module.reconcileStoredTheme();

    expect(applyAppearanceTheme).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t3-chat" }),
      "light",
      "light",
      expect.anything(),
      expect.any(Number),
    );
    expect(classList.contains("dark")).toBe(false);
  });

  it("leaves the runtime alone at startup when it already shows the stored selection", async () => {
    const { module, applyAppearanceTheme } = await setup("light", "light");

    module.reconcileStoredTheme();

    expect(applyAppearanceTheme).not.toHaveBeenCalled();
  });
});
