import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { ANTIGRAVITY_AUTH_BROWSER_MARKER } from "./antigravityAuthSupport.ts";
import { type AntigravityReleaseAsset } from "./antigravityRelease.ts";
import * as ModelManifest from "./ModelManifest.ts";

import antigravityInitialize from "../../../../packages/effect-acp/test/fixtures/antigravity-initialize.json" with { type: "json" };

const serverContents = "antigravity runtime\n";
const harnessContents = "local harness\n";
const previousReleaseId = "1".repeat(64);
const previousVersion = "1.3.0";
const withdrawnStatuses: ReadonlyArray<"broken" | "unsupported"> = ["broken", "unsupported"];
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Small ZIPs made with Python's zipfile module. The unsafe entries are intentional.
const zipFixtures = {
  complete:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  missingHarness:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAABAAEAQAAAAEQAAAAAAA==",
  duplicate:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAABhZ3lfYWNwX3NlcnZlci5wYXJLzCvJTC9KLMssqVQoKgVyclO5AFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YFEAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAACAAIAgAAAAIgAAAAAAA==",
  traversal:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAAVAAAALi5cYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABUAAAAAAAAAAAAAAO2BAAAAAC4uXGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUcAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCGAAAAigAAAAAA",
  symlink:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAAD/oUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  oversizedMember:
    "UEsDBBQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuSoAUEsDBBQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsy8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAFQAAAAAAAAAAAAAA7YFFAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsUEsFBgAAAAACAAIAgwAAAIgAAAAAAA==",
  windows:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABkAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhly8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5leGVQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAGQAAAAAAAAAAAAAA7YFEAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZVBLBQYAAAAAAgACAIcAAACLAAAAAAA=",
};

// The installation checks POSIX exec bits off the real filesystem unless the
// platform is win32, so a linux platform mock cannot pass on NTFS. Default to
// the host and let the fixture names follow; the suite is about install
// mechanics, which are the same on every platform.
const hostPlatform: NodeJS.Platform =
  HostProcessPlatform.defaultValue() === "win32" ? "win32" : "linux";
const nativeTestPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "win32" ? ["win32"] : ["win32", hostPlatform];
const completeArchive = Buffer.from(
  hostPlatform === "win32" ? zipFixtures.windows : zipFixtures.complete,
  "base64",
);
const executableName = hostPlatform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
const harnessName =
  hostPlatform === "win32" ? "localharness_external.exe" : "localharness_external";

const releaseAsset = Effect.fn("test.antigravityReleaseAsset")(function* (
  archive: Uint8Array = completeArchive,
  platform: NodeJS.Platform = hostPlatform,
) {
  const crypto = yield* Crypto.Crypto;
  return {
    version: "fixture-new",
    url: "https://dl.google.com/antigravity-test.zip",
    sha256: Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie)),
    archiveBytes: archive.byteLength,
    executable: {
      name: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
      bytes: Buffer.byteLength(serverContents),
    },
    harness: {
      name: platform === "win32" ? "localharness_external.exe" : "localharness_external",
      bytes: Buffer.byteLength(harnessContents),
    },
  } satisfies AntigravityReleaseAsset;
});

const writeRelease = Effect.fn("test.writeAntigravityRelease")(function* (
  managedDirectory: string,
  asset: AntigravityReleaseAsset,
  active = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(managedDirectory, "versions", asset.sha256);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, asset.executable.name), serverContents, {
    mode: 0o755,
  });
  yield* fs.writeFileString(path.join(directory, asset.harness.name), harnessContents, {
    mode: 0o755,
  });
  yield* fs.writeFileString(
    path.join(directory, ".install-complete.json"),
    encodeJsonString({
      releaseId: asset.sha256,
      version: asset.version,
      executable: asset.executable,
      harness: asset.harness,
    }),
  );
  if (active) {
    yield* fs.writeFileString(
      path.join(managedDirectory, "active.json"),
      encodeJsonString({ releaseId: asset.sha256 }),
    );
  }
});

interface HarnessOptions {
  readonly baseDir?: string;
  readonly asset?: AntigravityReleaseAsset | null;
  readonly archive?: Buffer;
  readonly body?: Stream.Stream<Uint8Array> | undefined;
  readonly contentLength?: number;
  readonly contentEncoding?: string;
  readonly platform?: NodeJS.Platform;
  readonly path?: string;
  readonly previous?: boolean;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly validate?: AntigravityInstallation.AntigravityInstallationOptions["validate"];
  readonly useDefaultValidation?: boolean;
  readonly native?: boolean;
  readonly nativeVersion?: string;
  readonly nativeManifest?: (manifest: {
    readonly version: string;
    readonly url: string;
    readonly sha512: string;
  }) => unknown;
  readonly updateChecksEnabled?: Effect.Effect<boolean>;
  readonly manifest?: Effect.Effect<ModelManifest.ModelManifestData>;
}

const makeHarness = Effect.fn("test.makeAntigravityInstallation")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-test-" }));
  const platform = options.platform ?? hostPlatform;
  const archive = options.archive ?? completeArchive;
  const asset = options.native
    ? null
    : options.asset === undefined
      ? yield* releaseAsset(archive, platform)
      : options.asset;
  const managedDirectory = path.join(baseDir, "tools", "antigravity-acp", `${platform}-x64`);
  if (options.previous) {
    yield* writeRelease(managedDirectory, {
      ...(yield* releaseAsset(archive, platform)),
      sha256: previousReleaseId,
      version: previousVersion,
    });
  }
  const stagingReleased = yield* Deferred.make<void>();
  const requests: string[] = [];
  const validations: Array<{
    executable: AntigravityInstallation.AntigravityExecutable;
    version: string;
  }> = [];
  const installationFs = options.fileSystem ?? fs;
  const trackedFs = FileSystem.FileSystem.of({
    ...installationFs,
    makeTempDirectoryScoped: (settings) =>
      settings?.prefix === ".install-"
        ? Effect.acquireRelease(installationFs.makeTempDirectory(settings), (directory) =>
            fs
              .remove(directory, { recursive: true, force: true })
              .pipe(Effect.orDie, Effect.andThen(Deferred.succeed(stagingReleased, undefined))),
          )
        : installationFs.makeTempDirectoryScoped(settings),
  });
  const installation = yield* AntigravityInstallation.makeAntigravityInstallation({
    baseDir,
    ...(options.native ? {} : { releaseAsset: asset }),
    ...(options.updateChecksEnabled === undefined
      ? {}
      : { updateChecksEnabled: options.updateChecksEnabled }),
    ...(options.useDefaultValidation
      ? {}
      : {
          validate: (executable: AntigravityInstallation.AntigravityExecutable, version: string) =>
            Effect.sync(() => validations.push({ executable, version })).pipe(
              Effect.andThen(options.validate?.(executable, version) ?? Effect.void),
            ),
        }),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, trackedFs),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(HostProcessEnvironment, { PATH: options.path ?? "" }),
    Effect.provideService(ModelManifest.ModelManifest, {
      current: options.manifest ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          if (request.url.includes("/manifests/")) {
            const version = options.nativeVersion ?? "1.5.7";
            const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
            const folder = platform === "win32" ? "windows-x64" : `${platform}-x64`;
            const extension = platform === "win32" ? "exe" : "tar.gz";
            const manifest = {
              version,
              url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-123/${folder}/cli_${os}_x64.${extension}`,
              sha512: Hex.encode(yield* crypto.digest("SHA-512", archive).pipe(Effect.orDie)),
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json(options.nativeManifest?.(manifest) ?? manifest),
            );
          }
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              headers: {
                ...(options.contentLength === undefined
                  ? {}
                  : { "content-length": String(options.contentLength) }),
                ...(options.contentEncoding === undefined
                  ? {}
                  : { "content-encoding": options.contentEncoding }),
              },
            }),
          );
          return Object.defineProperty(response, "stream", {
            value:
              options.body ??
              Stream.make(
                archive.subarray(0, 31),
                archive.subarray(31, 149),
                archive.subarray(149),
              ),
          });
        }),
      ),
    ),
  );
  return { installation, fs, path, baseDir, requests, validations, stagingReleased };
});

const terminalState = (installation: AntigravityInstallation.AntigravityInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const expectPreviousRelease = Effect.fn("test.expectPreviousAntigravityRelease")(function* (
  installation: AntigravityInstallation.AntigravityInstallation["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* installation.resolve();
  expect(resolved.version).toBe(previousVersion);
  expect(resolved.managedVersionDirectory).toBe(
    path.join(installation.managedDirectory, "versions", previousReleaseId),
  );
  expect(yield* fs.readFileString(resolved.executablePath)).toBe(serverContents);
  if (resolved.harnessPath === null) {
    return yield* Effect.die("Expected the previous legacy release harness.");
  }
  expect(yield* fs.readFileString(resolved.harnessPath)).toBe(harnessContents);
  expect((yield* installation.state).installedVersion).toBe(previousVersion);
});

it.layer(NodeServices.layer)("Antigravity installation", (it) => {
  it.effect("reports missing Node before downloading the standalone provider runtime", () =>
    Effect.gen(function* () {
      const { installation, requests, validations } = yield* makeHarness();
      yield* installation.start;
      expect(yield* terminalState(installation)).toMatchObject({
        phase: "failed",
        message: expect.stringContaining("Install Node.js"),
      });
      expect(requests).toEqual([]);
      expect(validations).toEqual([]);
    }).pipe(Effect.provideService(HostProcessIsExecutable, true)),
  );

  it.effect("verifies both files before activating a streamed download", () =>
    Effect.gen(function* () {
      const enteredValidation = yield* Deferred.make<void>();
      const finishValidation = yield* Deferred.make<void>();
      const { installation, fs, path, validations, requests, stagingReleased } = yield* makeHarness(
        {
          previous: true,
          validate: () =>
            Deferred.succeed(enteredValidation, undefined).pipe(
              Effect.andThen(Deferred.await(finishValidation)),
            ),
        },
      );
      const initial = yield* installation.changes.pipe(
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(initial).toMatchObject({ phase: "idle", installedVersion: previousVersion });
      const started = yield* installation.start;
      expect(started).toMatchObject({ phase: "downloading", downloadedBytes: 0 });
      yield* Deferred.await(enteredValidation);
      yield* expectPreviousRelease(installation);
      const validation = validations[0];
      expect(validation?.version).toBe("fixture-new");
      if (!validation) return yield* Effect.die("Expected runtime validation.");
      expect(yield* fs.readFileString(validation.executable.executablePath)).toBe(serverContents);
      if (validation.executable.harnessPath === null) {
        return yield* Effect.die("Expected the legacy runtime harness.");
      }
      expect(yield* fs.readFileString(validation.executable.harnessPath)).toBe(harnessContents);

      yield* Deferred.succeed(finishValidation, undefined);
      expect(yield* terminalState(installation)).toMatchObject({
        phase: "succeeded",
        operationId: started.operationId,
        downloadedBytes: completeArchive.byteLength,
        installedVersion: "fixture-new",
      });
      yield* Deferred.await(stagingReleased);
      const selected = yield* installation.resolve();
      expect(selected).toMatchObject({ source: "managed", version: "fixture-new" });
      if (selected.harnessPath === null) {
        return yield* Effect.die("Expected the newly installed legacy runtime harness.");
      }
      expect(path.dirname(selected.harnessPath)).toBe(path.dirname(selected.executablePath));
      expect(yield* fs.readFileString(selected.executablePath)).toBe(serverContents);
      expect(yield* fs.readFileString(selected.harnessPath)).toBe(harnessContents);
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        expect.arrayContaining([previousReleaseId, (yield* releaseAsset()).sha256]),
      );
      expect(requests).toEqual([(yield* releaseAsset()).url]);
    }),
  );

  it.effect.each(nativeTestPlatforms)(
    "migrates legacy installs to the managed agy CLI without removing pinned versions (%s)",
    (platform) =>
      Effect.gen(function* () {
        const tarArchive = Buffer.from(
          "H4sIAAAAAAACE+3RMQ7CQAwEQNe8Ik8wgYj3XIFQCiiOCxK/56CJRA9CYqZZrxsXLpc2n2q5ze0en5LdYZpe2b1n5rhf5+d+m+MuY8j4guXaSu3n4z+V9f9DXXo5HzcBAAAAAAAAAADAz3sA56lbdQAoAAA=",
          "base64",
        );
        const archive = platform === "win32" ? Buffer.from(serverContents) : tarArchive;
        const harness = yield* makeHarness({
          native: true,
          archive,
          platform,
          previous: true,
          updateChecksEnabled: Effect.succeed(false),
        });
        const started = yield* harness.installation.start;
        expect(started.phase).toBe("downloading");
        const completed = yield* terminalState(harness.installation);
        expect(completed).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
          totalBytes: null,
        });
        yield* Deferred.await(harness.stagingReleased);
        const selected = yield* harness.installation.resolve();
        expect(selected).toMatchObject({
          source: "managed",
          version: "1.5.7",
          harnessPath: null,
        });
        expect(selected.executablePath).toMatch(
          platform === "win32" ? /agy\.exe$/u : /antigravity$/u,
        );
        expect(yield* harness.fs.readFileString(selected.executablePath)).toBe(serverContents);
        expect(
          yield* harness.fs.exists(
            harness.path.join(harness.installation.managedDirectory, "versions", previousReleaseId),
          ),
        ).toBe(true);
        expect(harness.validations.map(({ executable }) => executable.harnessPath)).toEqual([null]);

        const olderRelease = yield* makeHarness({
          baseDir: harness.baseDir,
          native: true,
          nativeVersion: "1.5.6",
          archive,
          platform,
          updateChecksEnabled: Effect.succeed(false),
        });
        const revalidated = yield* olderRelease.installation.start;
        expect(revalidated).toMatchObject({
          phase: "verifying",
          version: "1.5.7",
          installedVersion: "1.5.7",
        });
        expect(yield* terminalState(olderRelease.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        expect(olderRelease.requests.some((url) => url.includes("storage.googleapis.com"))).toBe(
          false,
        );
      }),
  );

  it.effect.each([true, false])(
    "checks for CLI updates in the background only when enabled and lets explicit installs bypass the interval (%s)",
    (enabled) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          native: true,
          archive: Buffer.from(serverContents),
          platform: "win32",
          updateChecksEnabled: Effect.succeed(enabled),
        });
        const manifestRequests = () =>
          harness.requests.filter((url) => url.includes("/manifests/")).length;

        yield* harness.installation.checkForUpdate;
        yield* harness.installation.checkForUpdate;
        expect(manifestRequests()).toBe(enabled ? 1 : 0);
        if (enabled) {
          yield* TestClock.adjust("1 hour");
          yield* harness.installation.checkForUpdate;
          expect(manifestRequests()).toBe(2);
        }

        yield* harness.installation.start;
        expect(yield* terminalState(harness.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        expect(manifestRequests()).toBe(enabled ? 3 : 1);
      }),
  );

  it.effect.skipIf(hostPlatform === "win32")(
    "rejects unsafe native CLI tar archives without replacing the legacy installation",
    () =>
      Effect.gen(function* () {
        const archives = [
          "H4sIAAAAAAACE+3OMQqDQBAFUI/iCYxZJPdZMIRtFHQN5PYOKbW2EN5j4P9iYCZPtXyW/C3111ylD69h+Gc45rk/U4r1NnXdI2be6lrG90XPbWvNS5xvAAAAAAAAAAAA4D523kNDtgAoAAA=",
          "H4sIAAAAAAACE+3RMQ7CMBAEQNe8Ii8IBhzxHhcIpYDCcSLxewwNiJ4IiZlmb6+54vp+m691PJe8jPUWviI2x2F4ZvOZMe7Ta37sdzGlQ+hiWME81Vza+fCf3p7flbmVy2kTAAAAAAAAAAAA+Hl3jhn2/wAoAAA=",
          "H4sIAAAAAAACE+3TPQrCQBAG0K09RY4wRoPn2UJCClOsG8Hbu6YJ2CtI3mvmp5li+PJcp7Hkx1Sf6VuiuQzDWpvPGtGft/69P0Z/itRF+oHlXnNp59M+5e3/XVnacLseEnv8v/zLv/wDAAAAAAAAAPyZF/c+VksAKAAA",
        ];
        for (const encodedArchive of archives) {
          const harness = yield* makeHarness({
            native: true,
            archive: Buffer.from(encodedArchive, "base64"),
            platform: "linux",
            previous: true,
            updateChecksEnabled: Effect.succeed(false),
          });
          yield* harness.installation.start;
          expect(yield* terminalState(harness.installation)).toMatchObject({ phase: "failed" });
          expect(harness.validations).toEqual([]);
          yield* expectPreviousRelease(harness.installation);
        }
      }),
  );

  it.effect.each([
    {
      name: "a foreign download URL",
      startsInBackground: false,
      nativeManifest: (manifest: { version: string; url: string; sha512: string }) => ({
        ...manifest,
        url: "https://example.com/antigravity.tar.gz",
      }),
    },
    {
      name: "a malformed checksum",
      startsInBackground: false,
      nativeManifest: (manifest: { version: string; url: string; sha512: string }) => ({
        ...manifest,
        sha512: "not-a-sha512",
      }),
    },
    {
      name: "a checksum that does not match the download",
      startsInBackground: true,
      nativeManifest: (manifest: { version: string; url: string; sha512: string }) => ({
        ...manifest,
        sha512: "0".repeat(128),
      }),
    },
  ])("rejects $name while preserving the legacy installation", (testCase) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        native: true,
        nativeManifest: testCase.nativeManifest,
        archive: Buffer.from(serverContents),
        platform: "win32",
        previous: true,
        updateChecksEnabled: Effect.succeed(false),
      });
      const started = yield* Effect.result(harness.installation.start);
      if (started._tag === "Success") {
        expect(testCase.startsInBackground).toBe(true);
        expect(yield* terminalState(harness.installation)).toMatchObject({ phase: "failed" });
      } else {
        expect(testCase.startsInBackground).toBe(false);
      }
      expect(harness.validations).toEqual([]);
      yield* expectPreviousRelease(harness.installation);
    }),
  );

  it.effect.each(withdrawnStatuses)(
    "blocks newly installed and already active CLI releases marked %s",
    (status) =>
      Effect.gen(function* () {
        let currentManifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
        const withdrawnManifest: ModelManifest.ModelManifestData = {
          ...ModelManifest.BUNDLED_MODEL_MANIFEST,
          compatibility: [
            {
              driver: "antigravity",
              t3CodeRange: ">=0.0.0",
              ranges: [{ range: ">=1.5.7 <2.0.0", status }],
            },
          ],
        };
        const manifest = Effect.sync(() => currentManifest);
        const archive = Buffer.from(serverContents);
        const previous = yield* makeHarness({
          native: true,
          archive,
          platform: "win32",
          previous: true,
          manifest,
          updateChecksEnabled: Effect.succeed(false),
          validate: (_executable, version) =>
            Effect.sync(() => {
              if (version === "1.5.7") currentManifest = withdrawnManifest;
            }),
        });
        yield* previous.installation.start;
        expect(yield* terminalState(previous.installation)).toMatchObject({ phase: "failed" });
        yield* expectPreviousRelease(previous.installation);

        currentManifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
        const replacement = yield* makeHarness({
          baseDir: previous.baseDir,
          native: true,
          archive,
          platform: "win32",
          manifest,
          updateChecksEnabled: Effect.succeed(false),
        });
        yield* replacement.installation.start;
        expect(yield* terminalState(replacement.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });

        currentManifest = withdrawnManifest;
        const resolution = yield* Effect.result(replacement.installation.resolve());
        expect(resolution._tag).toBe("Failure");
        const refresh = yield* Effect.result(replacement.installation.start);
        expect(refresh._tag).toBe("Failure");
      }),
  );

  it.effect.each([
    {
      name: "the expected release with protocol 1",
      protocolVersion: 1,
      agentName: "antigravity-acp",
      version: "fixture-new",
      valid: true,
    },
    {
      name: "the expected release with protocol 2 and legacy fields",
      protocolVersion: 2,
      agentName: "antigravity-acp",
      version: "fixture-new",
      valid: true,
    },
    {
      name: "an unsupported protocol version",
      protocolVersion: 3,
      agentName: "antigravity-acp",
      version: "fixture-new",
      valid: false,
    },
    { name: "a different agent", agentName: "other-agent", version: "fixture-new", valid: false },
    {
      name: "a different version",
      agentName: "antigravity-acp",
      version: "other-version",
      valid: false,
    },
  ])("validates $name with initialize only and removes the disposable profile", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const encoder = new TextEncoder();
      const decodeRequest = Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Union([Schema.String, Schema.Number]),
            method: Schema.String,
          }),
        ),
      );
      const methods: string[] = [];
      const profiles = new Set<string>();
      let closedRuntimes = 0;
      const spawner = ChildProcessSpawner.make(
        Effect.fn("test.spawnAntigravityValidator")(function* (command) {
          if (command._tag !== "StandardCommand") {
            return yield* Effect.die("Expected one validation process.");
          }
          const profile = command.options.env?.GEMINI_HOME;
          if (!profile) return yield* Effect.die("Expected a disposable validation profile.");
          profiles.add(profile);
          const helper = command.args[0] === "-e";
          // The runtime unpacks straight into the disposable profile.
          if (!helper) expect(command.options.env?.TMPDIR).toBe(profile);
          const output = yield* Queue.unbounded<Uint8Array>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const terminate = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
            Effect.asVoid,
          );
          yield* Effect.addFinalizer(() =>
            terminate.pipe(
              Effect.andThen(Queue.shutdown(output)),
              Effect.andThen(
                Effect.sync(() => {
                  if (!helper) closedRuntimes += 1;
                }),
              ),
            ),
          );
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(helper ? 1 : 2),
            exitCode: helper
              ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
              : Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () => terminate,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((bytes: Uint8Array) =>
              Effect.gen(function* () {
                const request = yield* decodeRequest(new TextDecoder().decode(bytes)).pipe(
                  Effect.orDie,
                );
                methods.push(request.method);
                yield* Queue.offer(
                  output,
                  encoder.encode(
                    `${encodeJsonString({
                      jsonrpc: "2.0",
                      id: request.id,
                      ...(request.method === "initialize"
                        ? {
                            result: {
                              ...antigravityInitialize,
                              protocolVersion: testCase.protocolVersion ?? 2,
                              agentInfo: { name: testCase.agentName, version: testCase.version },
                            },
                          }
                        : {
                            error: {
                              code: -32601,
                              message: "Validation must not sign in or create sessions.",
                            },
                          }),
                    })}\n`,
                  ),
                );
              }),
            ),
            stdout: helper ? Stream.empty : Stream.fromQueue(output),
            stderr: helper
              ? Stream.make(
                  encoder.encode(
                    `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeJsonString(command.args.at(-1))}\n`,
                  ),
                )
              : Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const { installation, stagingReleased } = yield* makeHarness({
        previous: true,
        useDefaultValidation: true,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe(
        testCase.valid ? "succeeded" : "failed",
      );
      yield* Deferred.await(stagingReleased);
      expect(methods).toEqual(["initialize"]);
      expect(closedRuntimes).toBe(1);
      expect(profiles.size).toBe(1);
      for (const profile of profiles) {
        expect(yield* fs.exists(profile)).toBe(false);
      }
      if (testCase.valid) {
        expect((yield* installation.resolve()).version).toBe("fixture-new");
      } else {
        yield* expectPreviousRelease(installation);
      }
    }),
  );

  it.effect("accepts an encoded Content-Length when the body is compressed", () =>
    Effect.gen(function* () {
      // dl.google.com gzips the archive and reports the encoded size. The decoded
      // stream is still checked byte for byte and by hash.
      const { installation, validations } = yield* makeHarness({
        contentLength: completeArchive.byteLength - 1_000,
        contentEncoding: "gzip",
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("succeeded");
      expect(validations).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "checksum mismatch", completeAsset: { sha256: "2".repeat(64) } },
    { name: "short download", archive: completeArchive.subarray(0, -1), completeAsset: {} },
    {
      name: "oversized download",
      archive: Buffer.concat([completeArchive, Buffer.from("extra")]),
      completeAsset: {},
    },
    { name: "wrong Content-Length", contentLength: completeArchive.byteLength + 1 },
    { name: "missing harness", archive: Buffer.from(zipFixtures.missingHarness, "base64") },
    { name: "duplicate executable", archive: Buffer.from(zipFixtures.duplicate, "base64") },
    { name: "path traversal", archive: Buffer.from(zipFixtures.traversal, "base64") },
    { name: "symbolic link", archive: Buffer.from(zipFixtures.symlink, "base64") },
    { name: "oversized member", archive: Buffer.from(zipFixtures.oversizedMember, "base64") },
  ])("rejects $name before runtime validation", ({ completeAsset, ...options }) =>
    Effect.gen(function* () {
      // Pin the asset to the complete archive so the download itself is what disagrees.
      const asset =
        completeAsset === undefined ? undefined : { ...(yield* releaseAsset()), ...completeAsset };
      const { installation, validations, stagingReleased, fs, path } = yield* makeHarness({
        ...options,
        ...(asset === undefined ? {} : { asset }),
        previous: true,
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).toBeTruthy();
      expect(validations).toEqual([]);
      yield* Deferred.await(stagingReleased);
      yield* expectPreviousRelease(installation);
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        [previousReleaseId],
      );
    }),
  );

  it.effect.each(["download", "extract", "active pointer"] as const)(
    "preserves the old runtime after an ENOSPC error during %s",
    (stage) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const noSpace = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "write",
          description: "ENOSPC: no space left on device",
        });
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          sink: (target, options) =>
            (stage === "download" && target.endsWith("download.zip")) ||
            (stage === "extract" && target.endsWith(executableName))
              ? fs.sink(target, options).pipe(Sink.mapInputEffect(() => Effect.fail(noSpace)))
              : fs.sink(target, options),
          writeFileString: (target, content, options) =>
            stage === "active pointer" && target.endsWith("contents.tmp")
              ? Effect.fail(noSpace)
              : fs.writeFileString(target, content, options),
        });
        const { installation, stagingReleased, path } = yield* makeHarness({
          previous: true,
          fileSystem,
        });
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("failed");
        yield* Deferred.await(stagingReleased);
        yield* expectPreviousRelease(installation);
        expect(
          (yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).some(
            (name) => name.startsWith(".install-"),
          ),
        ).toBe(false);
        expect(yield* fs.readDirectory(installation.managedDirectory)).toEqual([
          "active.json",
          "versions",
        ]);
      }),
  );

  it.effect.each(["downloading", "extracting", "verifying"] as const)(
    "cancels during %s and waits for open resources to close",
    (phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const barrier = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
        const { installation, stagingReleased, path, validations } = yield* makeHarness({
          previous: true,
          body:
            phase === "downloading"
              ? Stream.concat(
                  Stream.make(completeArchive.subarray(0, 31)),
                  Stream.fromEffect(barrier.pipe(Effect.as(completeArchive.subarray(31)))),
                )
              : undefined,
          validate: phase === "verifying" ? () => barrier : undefined,
          fileSystem: FileSystem.FileSystem.of({
            ...fs,
            sink: (target, options) =>
              phase === "extracting" && target.endsWith(executableName)
                ? fs
                    .sink(target, options)
                    .pipe(
                      Sink.mapInputEffect((chunk: Uint8Array) => barrier.pipe(Effect.as(chunk))),
                    )
                : fs.sink(target, options),
          }),
        });
        const started = yield* installation.start;
        yield* Deferred.await(entered);
        expect((yield* installation.state).phase).toBe(phase);
        expect(
          (yield* installation.cancel(started.operationId ?? "missing-operation-id")).phase,
        ).toBe("cancelled");
        yield* Deferred.await(interrupted);
        yield* Deferred.await(stagingReleased);
        yield* expectPreviousRelease(installation);
        expect(validations).toHaveLength(phase === "verifying" ? 1 : 0);
        expect(
          yield* fs.readDirectory(path.join(installation.managedDirectory, "versions")),
        ).toEqual([previousReleaseId]);
      }),
  );

  it.effect.each([
    { name: "the committed install", restart: false },
    { name: "a newer install", restart: true },
  ])("does not fail $name when old pointer cleanup fails", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const nextValidationStarted = yield* Deferred.make<void>();
      const releaseNextValidation = yield* Deferred.make<void>();
      const firstWorker = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const cleanupError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        description: "EPERM: pointer temp directory is in use",
      });
      let firstPointer = true;
      let validationCount = 0;
      const { installation, stagingReleased } = yield* makeHarness({
        previous: true,
        validate: () => {
          validationCount += 1;
          return validationCount === 2
            ? Deferred.succeed(nextValidationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseNextValidation)),
              )
            : Effect.void;
        },
        fileSystem: FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectoryScoped: (settings) => {
            if (settings?.prefix !== "active.json." || !firstPointer) {
              return fs.makeTempDirectoryScoped(settings);
            }
            firstPointer = false;
            return Effect.fiber.pipe(
              Effect.tap((worker) => Deferred.succeed(firstWorker, worker)),
              Effect.andThen(
                Effect.acquireRelease(fs.makeTempDirectory(settings), () =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCleanup)),
                    Effect.andThen(Effect.die(cleanupError)),
                  ),
                ),
              ),
            );
          },
        }),
      });
      yield* Effect.gen(function* () {
        const first = yield* installation.start;
        yield* Deferred.await(cleanupStarted);
        expect(yield* installation.state).toMatchObject({
          operationId: first.operationId,
          phase: "succeeded",
          installedVersion: "fixture-new",
        });
        const current = testCase.restart ? yield* installation.start : first;
        if (testCase.restart) yield* Deferred.await(nextValidationStarted);

        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.await(yield* Deferred.await(firstWorker));
        yield* Deferred.await(stagingReleased);
        expect(yield* installation.state).toMatchObject({
          operationId: current.operationId,
          phase: testCase.restart ? "verifying" : "succeeded",
          installedVersion: "fixture-new",
        });
        expect((yield* installation.resolve()).version).toBe("fixture-new");

        yield* Deferred.succeed(releaseNextValidation, undefined);
        expect(yield* terminalState(installation)).toMatchObject({
          operationId: current.operationId,
          phase: "succeeded",
          installedVersion: "fixture-new",
        });
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(releaseCleanup, undefined).pipe(
            Effect.andThen(Deferred.succeed(releaseNextValidation, undefined)),
          ),
        ),
      );
    }),
  );

  it.effect(
    "shares one install across callers and keeps it alive after the caller scope closes",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { installation, requests, stagingReleased } = yield* makeHarness({
          body: Stream.fromEffect(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(completeArchive),
            ),
          ),
        });
        const callerScope = yield* Scope.make();
        const started = yield* installation.start.pipe(Scope.provide(callerScope));
        yield* Deferred.await(entered);
        yield* Scope.close(callerScope, Exit.void);
        const concurrent = yield* Effect.all([installation.start, installation.start], {
          concurrency: "unbounded",
        });
        expect(concurrent.map((state) => state.operationId)).toEqual([
          started.operationId,
          started.operationId,
        ]);
        expect(
          yield* installation.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        ).toMatchObject({ phase: "downloading", operationId: started.operationId });
        yield* Deferred.succeed(release, undefined);
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        yield* Deferred.await(stagingReleased);

        const next = yield* installation.start;
        expect(next.operationId).not.toBe(started.operationId);
        expect(
          yield* installation
            .cancel(started.operationId ?? "missing-operation-id")
            .pipe(Effect.flip),
        ).toMatchObject({ operation: "cancel" });
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        expect(requests).toHaveLength(1);
      }),
  );

  // Real posix executables in a real temp dir, resolved by a linux-mocked
  // PATH walk; a Windows temp path cannot be split on `:`.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "honors explicit paths and reports invalid overrides without falling back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-agy-path-test-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const externalDirectory = path.join(baseDir, "external");
        const externalExecutable = path.join(externalDirectory, executableName);
        const externalHarness = path.join(externalDirectory, harnessName);
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.writeFileString(externalExecutable, "external server", { mode: 0o755 });
        yield* fs.writeFileString(externalHarness, "external harness", { mode: 0o755 });
        const { installation } = yield* makeHarness({
          baseDir,
          path: externalDirectory,
          previous: true,
        });
        yield* expectPreviousRelease(installation);
        expect(yield* installation.resolve(undefined, { PATH: externalDirectory })).toMatchObject({
          source: "managed",
          version: previousVersion,
        });
        expect(yield* installation.resolve(externalExecutable)).toMatchObject({
          executablePath: externalExecutable,
          source: "override",
          managedVersionDirectory: null,
        });
        expect(yield* installation.resolve(executableName)).toMatchObject({
          source: "override",
        });
        yield* fs.remove(externalHarness);
        expect(yield* installation.resolve(externalExecutable).pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
        });
        expect(
          yield* installation.resolve(path.join(baseDir, "missing")).pipe(Effect.flip),
        ).toMatchObject({
          operation: "resolve",
        });
        yield* expectPreviousRelease(installation);
        yield* fs.writeFileString(externalHarness, "external harness", { mode: 0o755 });
        yield* installation.remove();
        expect(yield* installation.resolve()).toMatchObject({
          source: "path",
          executablePath: externalExecutable,
        });
        const isolated = yield* makeHarness({ baseDir });
        expect(yield* isolated.installation.resolve().pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
        });
        expect(
          yield* isolated.installation.resolve(undefined, { PATH: externalDirectory }),
        ).toMatchObject({
          source: "path",
          executablePath: externalExecutable,
        });
        expect(
          yield* isolated.installation.resolve(executableName, { PATH: externalDirectory }),
        ).toMatchObject({ source: "override", executablePath: externalExecutable });
      }),
  );

  it.effect("keeps leased releases available while new sessions resolve the new release", () =>
    Effect.gen(function* () {
      const { installation, fs, stagingReleased } = yield* makeHarness({ previous: true });
      const processScope = yield* Scope.make();
      const oldExecutable = yield* installation.acquire().pipe(Scope.provide(processScope));
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      yield* Deferred.await(stagingReleased);
      const current = yield* installation.resolve();
      expect(current.version).toBe("fixture-new");
      expect(current.executablePath).not.toBe(oldExecutable.executablePath);
      expect(yield* fs.readFileString(oldExecutable.executablePath)).toBe(serverContents);
      expect(yield* installation.remove().pipe(Effect.flip)).toMatchObject({ operation: "remove" });
      yield* Scope.close(processScope, Exit.void);
      yield* installation.remove();
      expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    }),
  );

  it.effect(
    "removes an incomplete active release before reinstalling without a PATH fallback",
    () =>
      Effect.gen(function* () {
        const { installation, baseDir, fs, path } = yield* makeHarness({ previous: true });
        const previous = yield* installation.resolve();
        if (previous.harnessPath === null) {
          return yield* Effect.die("Expected the incomplete legacy runtime harness.");
        }
        yield* fs.remove(previous.harnessPath);
        const externalDirectory = path.join(baseDir, "external");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.writeFileString(path.join(externalDirectory, executableName), "external server", {
          mode: 0o755,
        });
        yield* fs.writeFileString(path.join(externalDirectory, harnessName), "external harness", {
          mode: 0o755,
        });
        const restarted = yield* makeHarness({ baseDir, path: externalDirectory });
        expect(yield* restarted.installation.state).toMatchObject({
          phase: "failed",
          installedVersion: null,
          canRemove: true,
        });
        expect(yield* restarted.installation.resolve().pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
        });
        yield* restarted.installation.remove();
        expect(yield* restarted.installation.state).toMatchObject({
          phase: "idle",
          canRemove: false,
        });
        expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
        yield* restarted.installation.start;
        expect(yield* terminalState(restarted.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "fixture-new",
          canRemove: true,
        });
        yield* Deferred.await(restarted.stagingReleased);
        expect((yield* restarted.installation.resolve()).source).toBe("managed");
      }),
  );

  it.effect(
    "blocks removal of custom managed paths and leaves external executables and profiles intact",
    () =>
      Effect.gen(function* () {
        const { installation, fs, path, baseDir } = yield* makeHarness({ previous: true });
        const managed = yield* installation.resolve();
        const externalDirectory = path.join(baseDir, "external");
        const profileDirectory = path.join(baseDir, "providers", "antigravity", "profile");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.makeDirectory(profileDirectory, { recursive: true });
        const externalExecutable = path.join(externalDirectory, executableName);
        const externalHarness = path.join(externalDirectory, harnessName);
        const profilePath = path.join(profileDirectory, "preferences.json");
        yield* fs.writeFileString(externalExecutable, "external server", { mode: 0o755 });
        yield* fs.writeFileString(externalHarness, "external harness", { mode: 0o755 });
        yield* fs.writeFileString(profilePath, "{}");
        expect(
          yield* installation.remove([managed.executablePath]).pipe(Effect.flip),
        ).toMatchObject({
          operation: "remove",
        });
        yield* expectPreviousRelease(installation);
        yield* installation.remove([externalExecutable]);
        expect(yield* installation.state).toMatchObject({
          phase: "idle",
          operationId: null,
          installedVersion: null,
        });
        expect(yield* fs.readFileString(externalExecutable)).toBe("external server");
        expect(yield* fs.readFileString(externalHarness)).toBe("external harness");
        expect(yield* fs.readFileString(profilePath)).toBe("{}");
      }),
  );

  it.effect(
    "reuses an immutable Windows release and preserves the pointer when rename is denied",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const archive = Buffer.from(zipFixtures.windows, "base64");
        const asset = yield* releaseAsset(archive, "win32");
        let denyPointerRename = true;
        const renameTargets: string[] = [];
        const { installation, requests, validations } = yield* makeHarness({
          previous: true,
          platform: "win32",
          archive,
          fileSystem: FileSystem.FileSystem.of({
            ...fs,
            rename: (source, target) => {
              renameTargets.push(target);
              return denyPointerRename
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: target,
                      description: "EPERM: file is in use",
                    }),
                  )
                : fs.rename(source, target);
            },
          }),
        });
        yield* writeRelease(installation.managedDirectory, asset, false);
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("failed");
        yield* expectPreviousRelease(installation);
        expect(renameTargets).toEqual([path.join(installation.managedDirectory, "active.json")]);

        denyPointerRename = false;
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        expect((yield* installation.resolve()).version).toBe("fixture-new");
        expect(requests).toEqual([]);
        expect(validations).toHaveLength(2);
        expect(renameTargets).toEqual([
          path.join(installation.managedDirectory, "active.json"),
          path.join(installation.managedDirectory, "active.json"),
        ]);
      }),
  );

  it.effect("reports unsupported hosts without downloading or changing state", () =>
    Effect.gen(function* () {
      const { installation, requests } = yield* makeHarness({ asset: null, platform: "darwin" });
      expect(yield* installation.start.pipe(Effect.flip)).toMatchObject({ operation: "start" });
      expect(yield* installation.resolve().pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      expect(yield* installation.state).toMatchObject({ phase: "idle", operationId: null });
      expect(requests).toEqual([]);
    }),
  );
});
