import { DesktopThemeSchema, type DesktopTheme } from "@t3tools/contracts";
import type { AppearanceResolved } from "@t3tools/client-runtime/appearance";
import { themeColorToNativeColor } from "@t3tools/shared/themePalettes";
import * as HostProcess from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";
import { watchLinuxColorScheme, type LinuxColorScheme } from "./LinuxColorScheme.ts";

const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#0a0a0a";
const LIGHT_SYMBOL_COLOR = "#1f2937";
const DARK_SYMBOL_COLOR = "#f8fafc";

// BrowserWindow's native color parser accepts the legacy CSS color forms
// below. Appearance colors may contain renderer-only functions such as
// `oklch()` or `var()`, so never pass an unvalidated value to Electron.
const ELECTRON_HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu;
const ELECTRON_FUNCTION_COLOR =
  /^(?:rgba?|hsla?)\(\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?(?:\s*,\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?){2}(?:\s*,\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?)?\s*\)$/iu;
const ELECTRON_NAMED_COLORS: Readonly<Record<string, true>> = {
  black: true,
  blue: true,
  gray: true,
  green: true,
  lime: true,
  maroon: true,
  navy: true,
  olive: true,
  orange: true,
  purple: true,
  red: true,
  silver: true,
  teal: true,
  transparent: true,
  white: true,
  yellow: true,
};

export type ElectronNativeAppearance = Readonly<{
  readonly appearance: "light" | "dark";
  readonly backgroundColor: string;
  readonly symbolColor: string;
}>;

export function isSupportedElectronColor(value: string): boolean {
  const normalized = value.trim();
  return (
    ELECTRON_HEX_COLOR.test(normalized) ||
    ELECTRON_FUNCTION_COLOR.test(normalized) ||
    ELECTRON_NAMED_COLORS[normalized.toLowerCase()] === true
  );
}

export function normalizeElectronColor(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const normalized = themeColorToNativeColor(value.trim());
  return isSupportedElectronColor(normalized) ? normalized : fallback;
}

export function resolveNativeAppearance(
  resolved: AppearanceResolved,
  systemAppearance: "light" | "dark",
): ElectronNativeAppearance {
  const appearance = resolved.variant?.appearance ?? systemAppearance;
  const fallbackBackground = appearance === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND;
  const fallbackSymbol = appearance === "dark" ? DARK_SYMBOL_COLOR : LIGHT_SYMBOL_COLOR;
  return {
    appearance,
    backgroundColor: normalizeElectronColor(resolved.values.canvas, fallbackBackground),
    symbolColor: normalizeElectronColor(
      resolved.values.toolbarForeground ?? resolved.values.text,
      fallbackSymbol,
    ),
  };
}

export class ElectronThemeSetSourceError extends Schema.TaggedError<ElectronThemeSetSourceError>()(
  "ElectronThemeSetSourceError",
  {
    source: DesktopThemeSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set the Electron theme source to ${this.source}.`;
  }
}

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly setSource: (theme: DesktopTheme) => Effect.Effect<void, ElectronThemeSetSourceError>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

type WatchSystemColorScheme = (onChange: (scheme: LinuxColorScheme) => void) => {
  readonly stop: () => void;
};

export const makeWith = Effect.fn("ElectronTheme.make")(function* (
  watchSystemColorScheme: WatchSystemColorScheme | undefined,
) {
  let source: DesktopTheme = Electron.nativeTheme.themeSource;
  let systemScheme: LinuxColorScheme = null;
  // On Linux, Electron reads the desktop color scheme once and ignores portal changes.
  const apply = () => {
    Electron.nativeTheme.themeSource = source === "system" ? (systemScheme ?? source) : source;
  };

  if (watchSystemColorScheme) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          return watchSystemColorScheme((scheme) => {
            systemScheme = scheme;
            apply();
          });
        } catch {
          return undefined;
        }
      }),
      (watcher) => Effect.sync(() => watcher?.stop()),
    );
  }

  return ElectronTheme.of({
    shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
    setSource: (theme) =>
      Effect.try({
        try: () => {
          source = theme;
          apply();
        },
        catch: (cause) => new ElectronThemeSetSourceError({ source: theme, cause }),
      }),
    onUpdated: (listener) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          Electron.nativeTheme.on("updated", listener);
          return Effect.void;
        }),
        () =>
          Effect.suspend(() => {
            Electron.nativeTheme.removeListener("updated", listener);
            return Effect.void;
          }),
      ),
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.HostProcessPlatform;
  return yield* makeWith(platform === "linux" ? watchLinuxColorScheme : undefined);
});

export const layer = Layer.effect(ElectronTheme, make);
