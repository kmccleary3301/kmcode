import type { AppearanceResolved } from "@t3tools/client-runtime/appearance";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { onMock, removeListenerMock, themeState } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  themeState: {
    shouldUseDarkColors: true,
    themeSource: "system",
    setSourceError: null as unknown,
  },
}));

vi.mock("electron", () => ({
  nativeTheme: {
    get shouldUseDarkColors() {
      return themeState.shouldUseDarkColors;
    },
    set themeSource(value: string) {
      if (themeState.setSourceError !== null) {
        throw themeState.setSourceError;
      }
      themeState.themeSource = value;
    },
    on: onMock,
    removeListener: removeListenerMock,
  },
}));

import * as ElectronTheme from "./ElectronTheme.ts";
import type { LinuxColorScheme } from "./LinuxColorScheme.ts";

function setupSystemColorScheme() {
  const portal: {
    report: (scheme: LinuxColorScheme) => void;
    stopped: boolean;
  } = {
    report: () => undefined,
    stopped: false,
  };
  const watch = (onChange: (scheme: LinuxColorScheme) => void) => {
    portal.report = onChange;
    return {
      stop: () => {
        portal.stopped = true;
      },
    };
  };
  return { portal, watch };
}
describe("ElectronTheme", () => {
  beforeEach(() => {
    onMock.mockClear();
    removeListenerMock.mockClear();
    themeState.shouldUseDarkColors = true;
    themeState.themeSource = "system";
    themeState.setSourceError = null;
  });
  it("maps resolved semantic colors to native-safe sRGB and rejects variable references", () => {
    const resolved = {
      variant: null,
      baseVariant: null,
      previewVariant: null,
      basePackageId: null,
      previewPackageId: null,
      values: {
        canvas: "#123456",
        toolbarForeground: "oklch(0.9 0.02 240)",
      },
      css: "",
    } satisfies AppearanceResolved;

    assert.deepEqual(ElectronTheme.resolveNativeAppearance(resolved, "dark"), {
      appearance: "dark",
      backgroundColor: "#123456",
      symbolColor: "#d3e0ea",
    });
    assert.isTrue(ElectronTheme.isSupportedElectronColor("rgba(1, 2, 3, 0.5)"));
    assert.isFalse(ElectronTheme.isSupportedElectronColor("var(--app-theme-canvas)"));
  });

  it.effect("scopes native theme update listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronTheme = yield* ElectronTheme.ElectronTheme;
          yield* electronTheme.onUpdated(listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["updated", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["updated", listener]]);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("preserves the requested source and cause when setting the theme fails", () =>
    Effect.gen(function* () {
      const cause = new Error("theme source failed");
      themeState.setSourceError = cause;
      const electronTheme = yield* ElectronTheme.ElectronTheme;

      const error = yield* Effect.flip(electronTheme.setSource("dark"));

      assert.instanceOf(error, ElectronTheme.ElectronThemeSetSourceError);
      assert.strictEqual(error.source, "dark");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "dark");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("follows the system color scheme when the requested theme is system", () =>
    Effect.gen(function* () {
      const { portal, watch } = setupSystemColorScheme();
      const theme = yield* ElectronTheme.makeWith(watch);
      yield* theme.setSource("system");

      portal.report("dark");
      assert.equal(themeState.themeSource, "dark");
      portal.report("light");
      assert.equal(themeState.themeSource, "light");
      portal.report(null);
      assert.equal(themeState.themeSource, "system");
    }).pipe(Effect.scoped),
  );

  it.effect("preserves explicit appearance over system color-scheme changes", () =>
    Effect.gen(function* () {
      const { portal, watch } = setupSystemColorScheme();
      const theme = yield* ElectronTheme.makeWith(watch);
      portal.report("dark");

      yield* theme.setSource("light");
      portal.report("dark");
      assert.equal(themeState.themeSource, "light");

      yield* theme.setSource("system");
      assert.equal(themeState.themeSource, "dark");
    }).pipe(Effect.scoped),
  );

  it.effect("stops following system color scheme when its scope closes", () =>
    Effect.gen(function* () {
      const { portal, watch } = setupSystemColorScheme();
      yield* ElectronTheme.makeWith(watch).pipe(Effect.scoped);
      assert.isTrue(portal.stopped);
    }),
  );

  it.effect("keeps Electron system theme when the portal is unavailable", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.makeWith(() => {
        throw new Error("no session bus");
      });
      yield* theme.setSource("system");
      assert.equal(themeState.themeSource, "system");
    }).pipe(Effect.scoped),
  );
});
