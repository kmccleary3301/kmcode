import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { ThemeDefinition } from "../../themePalette";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const themeState = vi.hoisted(() => ({ themes: [] as ThemeDefinition[] }));

function makeTheme(name: string): ThemeDefinition {
  return {
    id: name.toLowerCase(),
    label: name,
    appearance: "dark",
    colors: T3_CODE_DARK_THEME_COLORS,
  };
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: () => undefined,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", async () => ({ c: hooks.useMemoCache }));

vi.mock("../../themePalette", () => ({
  THEME_FILE_VERSION: 1,
  getCustomThemes: () => themeState.themes,
  installCustomTheme: (theme: ThemeDefinition) => {
    themeState.themes.push(theme);
    return theme;
  },
  parseThemeFile: (value: unknown) => {
    if (typeof value !== "object" || value === null) throw new Error("invalid theme");
    const name = Reflect.get(value, "name");
    if (typeof name !== "string") throw new Error("invalid theme");
    return makeTheme(name);
  },
  removeCustomTheme: vi.fn(),
  updateCustomTheme: vi.fn(),
}));

vi.mock("../../vscodeThemeImport", () => ({
  humanizeThemeName: (name: string) => name,
  isVsCodeThemeFile: () => false,
  pairVsCodeThemes: (themes: ReadonlyArray<ThemeDefinition>) => themes,
  parseVsCodeThemeFile: () => {
    throw new Error("VS Code themes are not used by this test.");
  },
  resolveThemeLabelCollisions: (
    entries: ReadonlyArray<{ sourceName: string; theme: ThemeDefinition }>,
  ) => entries.map((entry) => entry.theme),
}));

import { ThemeImportDialog } from "./ThemeImportDialog";

function renderDialog(onImportedMany: () => void) {
  hooks.beginRender();
  return ThemeImportDialog({
    open: true,
    onOpenChange: vi.fn(),
    onImported: () => true,
    onImportedMany,
  });
}

function hasText(view: unknown, text: string) {
  return (
    visitElements(view, (element) => {
      const children = element.props.children;
      return (
        (typeof children === "string" && children.includes(text)) ||
        (Array.isArray(children) &&
          children.some((child) => typeof child === "string" && child.includes(text)))
      );
    }) !== null
  );
}

beforeEach(() => {
  hooks.reset();
  themeState.themes = [makeTheme("Dusk")];
  vi.stubGlobal("window", { desktopBridge: undefined });
});

it("keeps the conflict warning visible alongside another file's import error", async () => {
  let resolveRead: (() => void) | null = null;
  const readDone = new Promise<void>((resolve) => {
    resolveRead = () => resolve();
  });
  const onImportedMany = vi.fn(() => resolveRead?.());
  const view = renderDialog(onImportedMany);
  const fileInput = visitElements(
    view,
    (element) => element.type === "input" && element.props.type === "file",
  );
  if (!fileInput || typeof fileInput.props.onChange !== "function") {
    throw new Error("Missing theme file input.");
  }
  const files = [
    { name: "Dawn.json", size: 16, text: () => Promise.resolve('{"name":"Dawn"}') },
    { name: "Dusk.json", size: 16, text: () => Promise.resolve('{"name":"Dusk"}') },
    { name: "broken.json", size: 1, text: () => Promise.resolve("{") },
  ];
  Reflect.apply(fileInput.props.onChange, undefined, [{ currentTarget: { files, value: "" } }]);
  await readDone;

  const updatedView = renderDialog(onImportedMany);
  expect(hasText(updatedView, "Already installed")).toBe(true);
  expect(hasText(updatedView, "broken.json:")).toBe(true);
  expect(onImportedMany).toHaveBeenCalledOnce();
});
