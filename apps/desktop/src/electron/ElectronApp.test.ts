import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  autoUpdaterOnMock,
  autoUpdaterRemoveListenerMock,
  exitMock,
  getAppPathMock,
  getSystemLocaleMock,
  getUserDefaultMock,
  getVersionMock,
  onMock,
  quitMock,
  relaunchMock,
  removeListenerMock,
  removeSwitchMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setAsDefaultProtocolClientMock,
  setDesktopNameMock,
  setDockIconMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  autoUpdaterOnMock: vi.fn(),
  autoUpdaterRemoveListenerMock: vi.fn(),
  exitMock: vi.fn(),
  getAppPathMock: vi.fn(() => "/app"),
  getSystemLocaleMock: vi.fn(() => "en-GB"),
  getUserDefaultMock: vi.fn((_key: string, _type?: string) => false),
  getVersionMock: vi.fn(() => "1.2.3"),
  onMock: vi.fn(),
  quitMock: vi.fn(),
  relaunchMock: vi.fn(),
  removeListenerMock: vi.fn(),
  removeSwitchMock: vi.fn(),
  setAboutPanelOptionsMock: vi.fn(),
  setAppUserModelIdMock: vi.fn(),
  setAsDefaultProtocolClientMock: vi.fn(() => true),
  setDesktopNameMock: vi.fn(),
  setDockIconMock: vi.fn(),
  setNameMock: vi.fn(),
  setPathMock: vi.fn(),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  autoUpdater: {
    on: autoUpdaterOnMock,
    removeListener: autoUpdaterRemoveListenerMock,
  },
  systemPreferences: {
    getUserDefault: getUserDefaultMock,
  },
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
      removeSwitch: removeSwitchMock,
    },
    dock: {
      setIcon: setDockIconMock,
    },
    getAppPath: getAppPathMock,
    getSystemLocale: getSystemLocaleMock,
    getVersion: getVersionMock,
    isPackaged: true,
    name: "T3 Code",
    on: onMock,
    quit: quitMock,
    relaunch: relaunchMock,
    removeListener: removeListenerMock,
    runningUnderARM64Translation: false,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
    exit: exitMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    autoUpdaterOnMock.mockClear();
    autoUpdaterRemoveListenerMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    removeListenerMock.mockClear();
    removeSwitchMock.mockClear();
    setPathMock.mockClear();
    getSystemLocaleMock.mockReset();
    getSystemLocaleMock.mockReturnValue("en-GB");
    getUserDefaultMock.mockReset();
    getUserDefaultMock.mockReturnValue(false);
  });

  it.effect("reads app metadata through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.deepEqual(metadata, {
        appVersion: "1.2.3",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: process.resourcesPath,
        runningUnderArm64Translation: false,
      });
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("reads the OS locale through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;

      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.HostProcessPlatform, "win32"),
      );
      assert.strictEqual(systemLocale, "en-GB");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("normalizes POSIX-style locale identifiers that Intl rejects", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "en_GB");
      const electronApp = yield* ElectronApp.ElectronApp;

      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.HostProcessPlatform, "win32"),
      );
      assert.strictEqual(systemLocale, "en-GB");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it("keeps macOS region overrides and hour cycles in the locale tag", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_GB"), "en-GB");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-US@rg=nlzzzz", "h12"), "en-NL-u-hc-h12");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_US@rg=nlzzzz"), "en-NL");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-GB", "h23"), "en-GB-u-hc-h23");
  });

  it("drops ICU keywords Intl cannot read instead of losing the locale", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("de_DE@calendar=buddhist"), "de-DE");
  });

  it.effect("follows LC_TIME on Linux when it differs from the language", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.HostProcessPlatform, "linux"),
        Effect.provideService(HostProcess.HostProcessEnvironment, {
          LANG: "en_US.UTF-8",
          LC_TIME: "de_DE.UTF-8",
        }),
      );

      assert.strictEqual(systemLocale, "de-DE");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("falls back to Chromium's locale on Linux when the time locale is C", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "fr-FR");
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.HostProcessPlatform, "linux"),
        Effect.provideService(HostProcess.HostProcessEnvironment, { LANG: "C.UTF-8" }),
      );

      assert.strictEqual(systemLocale, "fr-FR");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("reads macOS region and hour preferences", () =>
    Effect.gen(function* () {
      for (const [preference, expected] of [
        ["AppleICUForce12HourTime", "en-NL-u-hc-h12"],
        ["AppleICUForce24HourTime", "en-NL-u-hc-h23"],
        ["", "en-NL"],
      ]) {
        getSystemLocaleMock.mockReturnValue("en_US@rg=nlzzzz");
        getUserDefaultMock.mockImplementation((key) => key === preference);
        const locale = yield* ElectronApp.make.systemLocale.pipe(
          Effect.provideService(HostProcess.HostProcessPlatform, "darwin"),
        );
        assert.strictEqual(locale, expected);
        for (const hour12 of [true, false]) {
          assert.strictEqual(
            new Intl.DateTimeFormat(locale, { hour: "numeric", hour12 }).resolvedOptions().hour12,
            hour12,
          );
        }
      }
    }),
  );
  it.effect("reports which app metadata property failed", () =>
    Effect.gen(function* () {
      const cause = new Error("version unavailable");
      getVersionMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.metadata.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppMetadataReadError);
      assert.strictEqual(error.property, "app-version");
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        'Failed to read Electron app metadata property "app-version".',
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("preserves Electron readiness failures", () =>
    Effect.gen(function* () {
      const cause = new Error("ready failed");
      whenReadyMock.mockRejectedValueOnce(cause);

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.whenReady.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppWhenReadyError);
      assert.strictEqual(error.isPackaged, true);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        "Failed to wait for the Electron app to become ready (packaged: true).",
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes app event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.on("activate", listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["activate", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["activate", listener]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes native updater quit listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.onBeforeQuitForUpdate(listener);
        }),
      );

      assert.deepEqual(autoUpdaterOnMock.mock.calls, [["before-quit-for-update", listener]]);
      assert.deepEqual(autoUpdaterRemoveListenerMock.mock.calls, [
        ["before-quit-for-update", listener],
      ]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("removes command-line switches through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp.removeCommandLineSwitch("password-store");

      assert.deepEqual(removeSwitchMock.mock.calls, [["password-store"]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
