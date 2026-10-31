import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

import * as RelayClient from "./relayClient.ts";

// The suite runs the linux code path against the real filesystem, checking
// POSIX exec bits that NTFS never reports; the win32 branch skips that check.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const layerHostRuntime = (env: Record<string, string> = {}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessArchitecture, "x64"),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerHttpClient = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const layerSpawner = (commands: Array<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped-command");
        // The pinned Windows executable rejects --version but accepts the version subcommand.
        return makeHandle(
          ChildProcess.isStandardCommand(command) && command.args.includes("--version") ? 1 : 0,
        );
      }),
    ),
  );
const testBinary = new TextEncoder().encode("test-cloudflared-binary");
const testReleaseAsset = {
  url: "https://example.test/cloudflared",
  sha256: Hex.encode(sha256(testBinary)),
  archive: "binary",
} as const;

const layerInstallRuntime = () =>
  Layer.mergeAll(
    NodeServices.layer,
    layerHttpClient(testBinary),
    layerSpawner([]),
    layerHostRuntime({ PATH: "" }),
  );

describe("RelayClient", () => {
  it.effect.skipIf(windowsHost)(
    "resolves explicit overrides before managed and PATH executables",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const overridePath = `${baseDir}/override-cloudflared`;
        yield* fileSystem.writeFileString(overridePath, "override");
        yield* fileSystem.chmod(overridePath, 0o755);
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
        });

        expect(
          yield* manager.resolve.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({
                env: { PATH: "", T3CODE_CLOUDFLARED_PATH: overridePath },
              }),
            ),
          ),
        ).toEqual({
          status: "available",
          executablePath: overridePath,
          source: "override",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "downloads, verifies, validates, and atomically installs the managed executable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const bytes = new TextEncoder().encode("test-cloudflared-binary");
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: {
            url: "https://example.test/cloudflared",
            sha256: Hex.encode(sha256(bytes)),
            archive: "binary",
          },
        });

        const progress: Array<string> = [];
        const installed = yield* manager.installWithProgress((event) =>
          Effect.sync(() => {
            if (event.type === "progress") {
              progress.push(event.stage);
            }
          }),
        );
        const managedPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared`;
        expect(installed).toEqual({
          status: "available",
          executablePath: managedPath,
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
        expect(new TextDecoder().decode(yield* fileSystem.readFile(managedPath))).toBe(
          "test-cloudflared-binary",
        );
        expect(progress).toEqual([
          "checking",
          "waiting_for_lock",
          "downloading",
          "verifying",
          "installing",
          "validating",
          "activating",
        ]);
        expect(yield* manager.resolve).toEqual(installed);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new TextEncoder().encode("test-cloudflared-binary")),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect("rejects downloads whose checksum does not match the pinned manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
      });

      const error = yield* manager.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClient.RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new TextEncoder().encode("tampered")),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(bytes)),
          archive: "binary",
        },
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      expect(commands).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(bytes),
          layerSpawner(commands),
          layerHostRuntime(),
        ),
      ),
    );
  });
  it.effect.each(["live owner", "recent legacy"] as const)("keeps a lock with a %s", (kind) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const owner = `${process.pid}-still-running`;
      yield* fileSystem.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), {
        recursive: true,
      });
      if (kind === "live owner") {
        yield* fileSystem.makeDirectory(lockPath);
        yield* fileSystem.writeFileString(`${lockPath}/${owner}`, "");
      } else {
        yield* fileSystem.writeFileString(lockPath, "");
      }
      const written = yield* fileSystem.stat(lockPath);
      yield* TestClock.setTime(
        Option.getOrThrow(written.mtime).getTime() + (kind === "live owner" ? 3_600_000 : 6_000),
      );
      const waiting = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });
      const installing = yield* manager.install.pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(installing);
      if (kind === "live owner") {
        expect(yield* fileSystem.readDirectory(lockPath)).toEqual([owner]);
      } else {
        expect(yield* fileSystem.readFileString(lockPath)).toBe("");
      }
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime())),
  );

  it.effect.skipIf(windowsHost)("replaces a lock left by an exited installer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      yield* fileSystem.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(lockPath);
      yield* fileSystem.writeFileString(`${lockPath}/2147483647-exited-installer`, "");
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });

      expect(yield* manager.install).toMatchObject({ status: "available" });
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime())),
  );

  it.effect.skipIf(windowsHost)("replaces an old legacy lock file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      yield* fileSystem.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(lockPath, "");
      const written = yield* fileSystem.stat(lockPath);
      const mtime = Option.getOrThrow(written.mtime).getTime();
      yield* TestClock.setTime(mtime + 60 * 60 * 1_000);
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });

      expect(yield* manager.install).toMatchObject({ status: "available" });
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime())),
  );

  it.effect("keeps a replacement lock when stale-owner cleanup resumes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const abandoned = "2147483647-exited-installer";
      const replacement = `${process.pid}-replacement`;
      yield* fileSystem.makeDirectory(lockPath, { recursive: true });
      yield* fileSystem.writeFileString(`${lockPath}/${abandoned}`, "");
      const checked = yield* Deferred.make<void>();
      let replaced = false;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readDirectory: (path) =>
            fileSystem.readDirectory(path).pipe(
              Effect.tap((entries) =>
                Effect.gen(function* () {
                  if (path !== lockPath) return;
                  if (replaced) {
                    expect(entries).toEqual([replacement]);
                    yield* Deferred.succeed(checked, undefined);
                    return;
                  }
                  replaced = true;
                  yield* fileSystem.rename(lockPath, `${lockPath}.old`);
                  yield* fileSystem.makeDirectory(lockPath);
                  yield* fileSystem.writeFileString(`${lockPath}/${replacement}`, "");
                }),
              ),
            ),
        }),
      );
      const installing = yield* manager.install.pipe(Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Fiber.interrupt(installing);
      expect(yield* fileSystem.readDirectory(lockPath)).toEqual([replacement]);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime())),
  );

  it.effect("releases its lock when a download is cancelled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const downloading = yield* Deferred.make<void>();
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });
      const installing = yield* manager
        .installWithProgress((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(downloading);
      expect(yield* fileSystem.exists(lockPath)).toBe(true);
      yield* Fiber.interrupt(installing);
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime())),
  );

  it.effect.skipIf(windowsHost)(
    "observes PATH changes after the manager has been constructed",
    () => {
      const env = { PATH: "" };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const binDir = `${baseDir}/bin`;
        const executablePath = `${binDir}/cloudflared`;
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
        });

        expect(yield* manager.resolve).toEqual({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        });

        yield* fileSystem.makeDirectory(binDir);
        yield* fileSystem.writeFileString(executablePath, "cloudflared");
        yield* fileSystem.chmod(executablePath, 0o755);
        env.PATH = binDir;

        expect(yield* manager.resolve).toEqual({
          status: "available",
          executablePath,
          source: "path",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([]),
            layerHostRuntime(env),
          ),
        ),
      );
    },
  );
});
