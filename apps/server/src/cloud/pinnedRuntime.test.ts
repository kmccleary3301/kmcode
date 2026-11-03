// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  type RuntimeFetch,
  PinnedRuntimeInstallError,
  type PinnedRuntimeProgress,
  resolveRuntimePackageName,
  resolveRuntimeReleaseRepository,
  resolveRuntimeProductProfile,
} from "./pinnedRuntime.ts";

it("resolves the fork runtime package from explicit identity", () => {
  assert.equal(
    resolveRuntimePackageName({ env: { T3_PRODUCT_PROFILE: "pi-omp" }, argv: [] }),
    "t3-pi-omp",
  );
  assert.equal(
    resolveRuntimeProductProfile({
      env: {},
      argv: ["/usr/bin/node", "/home/me/node_modules/t3-pi-omp/dist/bin.mjs"],
    }),
    "pi-omp",
  );
  assert.equal(
    resolveRuntimeProductProfile({
      env: {},
      argv: ["/usr/bin/node", "/opt/t3-pi-omp/bin/t3-pi-omp"],
    }),
    "pi-omp",
  );
  assert.equal(
    resolveRuntimeProductProfile({
      env: {},
      argv: ["C:/Program Files/nodejs/node.exe", "C:/t3-pi-omp/t3-pi-omp.cmd"],
    }),
    "pi-omp",
  );
  assert.equal(
    resolveRuntimeReleaseRepository({
      env: { T3_PI_OMP_RELEASE_REPOSITORY: "https://github.com/owner/fork.git" },
      argv: [],
    }),
    "owner/fork",
  );
  assert.equal(
    resolveRuntimeReleaseRepository({
      env: { T3_PI_OMP_RELEASE_REPOSITORY: "https://example.com/owner/fork" },
      argv: [],
    }),
    undefined,
  );
});

// Every install fetches the release archive, checks it against SHA256SUMS,
// and unpacks it with tar. The fake client serves both files; the fake runner
// stands in for tar and drops the executable where extraction would.
const version = "1.2.3";
const archiveName = `t3-${version}-linux-x64.tar.gz`;
const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveHex = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
const validChecksums = archiveHex(archiveBytes).pipe(
  Effect.map((hex) => `${hex}  ${archiveName}\n`),
);
const releaseHttpClient = (checksums: string, requests: string[] = []) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    const body = request.url.endsWith("/SHA256SUMS") ? checksums : archiveBytes;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
  });
// Fork releases install the verified npm tarball; the archive client must stay unused.
const unusedArchiveHttpClient = HttpClient.make(() =>
  Effect.die("fork release installs must not request CLI archives"),
);
const extractingRunner = (fs: FileSystem.FileSystem, path: Path.Path, commands: string[] = []) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input.command);
        const targetIndex = input.args.indexOf("-C");
        const stagingDir = input.args[targetIndex + 1];
        if (input.command !== "tar" || stagingDir === undefined) {
          return yield* Effect.die(`unexpected command ${input.command}`);
        }
        yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
const digest = (value: Uint8Array | string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const forkReleaseFetch = (
  packageBytes: Uint8Array,
  downloadedBytes: Uint8Array = packageBytes,
): RuntimeFetch => {
  const filename = "t3-pi-omp-1.2.3.tgz";
  const packageHash = digest(packageBytes);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      profile: "pi-omp",
      version: "1.2.3",
      packageName: "t3-pi-omp",
      repository: "owner/fork",
      tag: "fork-v1.2.3",
      package: { name: "t3-pi-omp", version: "1.2.3" },
      artifacts: [{ name: filename, kind: "cli", sha256: packageHash }],
    }),
  );
  const sums = `${digest(manifestBytes)}  RELEASE-MANIFEST.json\n${packageHash}  ${filename}\n`;
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/SHA256SUMS")) return new Response(sums);
    if (url.endsWith("/RELEASE-MANIFEST.json")) return new Response(manifestBytes);
    if (url.endsWith(`/${filename}`)) return new Response(downloadedBytes);
    return new Response("not found", { status: 404 });
  };
};

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("installs the verified release archive as the runtime executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-" });
      const requests: string[] = [];
      const commands: string[] = [];
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        releaseBaseUrl: "https://releases.example/download",
        runner: extractingRunner(fs, path, commands),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.equal(paths.entryPath, path.join(paths.versionDir, "t3"));
      assert.deepEqual(pinnedRuntimeCommand(paths), { command: paths.entryPath, args: [] });
      assert.deepEqual(requests, [
        `https://releases.example/download/v${version}/SHA256SUMS`,
        `https://releases.example/download/v${version}/${archiveName}`,
      ]);
      assert.deepEqual(commands, ["tar"]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));
    }),
  );

  it.effect.each([true, false])(
    "reports bytes before completion, then verifies and extracts (known size: %s)",
    (knownSize) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-" });
        const firstChunk = yield* Deferred.make<void>();
        let archiveController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const checksums = yield* validChecksums;
        const progress: PinnedRuntimeProgress[] = [];
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.endsWith("/SHA256SUMS")
                ? new Response(checksums)
                : new Response(
                    new ReadableStream({
                      start(controller) {
                        archiveController = controller;
                        controller.enqueue(archiveBytes.slice(0, 4));
                      },
                    }),
                    { headers: knownSize ? { "content-length": String(archiveBytes.length) } : {} },
                  ),
            ),
          ),
        );
        const install = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: client,
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
          onProgress: (event) => {
            progress.push(event);
            if (event.stage === "download" && event.received === 4) {
              Deferred.doneUnsafe(firstChunk, Effect.void);
            }
          },
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstChunk);
        assert.deepEqual(progress.at(-1), {
          stage: "download",
          received: 4,
          total: knownSize ? archiveBytes.length : undefined,
        });
        assert.isFalse(progress.some((event) => event.stage === "extract"));
        assert.isDefined(archiveController);
        archiveController!.enqueue(archiveBytes.slice(4));
        archiveController!.close();
        const installed = yield* Fiber.join(install);
        assert.deepEqual(progress.slice(-4), [
          { stage: "download", received: archiveBytes.length, total: archiveBytes.length },
          { stage: "verify" },
          { stage: "extract" },
          { stage: "validate" },
        ]);
        assert.equal(yield* fs.readFileString(installed.sentinelPath), `${version}\n`);
      }),
  );

  it.effect("cleans up an interrupted download without reporting verification or extraction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-failed-" });
      const checksums = yield* validChecksums;
      const progress: PinnedRuntimeProgress[] = [];
      let cancelled = false;
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/SHA256SUMS")
              ? new Response(checksums)
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(archiveBytes.slice(0, 4));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
          ),
        ),
      );
      const firstChunk = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: client,
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not validate an interrupted archive"),
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "download" && event.received === 4)
            Deferred.doneUnsafe(firstChunk, Effect.void);
        },
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(install);
      assert.deepEqual(progress.at(-1), { stage: "download", received: 4, total: undefined });
      assert.isTrue(progress.every((event) => event.stage === "download"));
      assert.isTrue(cancelled);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("refuses an archive whose checksum does not match the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-bad-" });
      const commands: string[] = [];
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(`${"0".repeat(64)}  ${archiveName}\n`),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.die("must not validate an unverified archive"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(error.step, "verifying the t3 release archive checksum");
      assert.deepEqual(commands, []);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), `${version}\n`);
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, `${version}\n`);

      let validations = 0;
      const requests: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        runner: extractingRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.deepEqual(requests, []);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );

  it.effect("installs a checksum-verified fork release package without npm registry access", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-fork-" });
      const packageBytes = Buffer.from("verified fork package");
      let installSource = "";
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            installSource = input.args.at(-1) ?? "";
            assert.match(installSource, /t3-pi-omp-1\.2\.3\.tgz$/u);
            assert.isTrue(yield* fs.exists(installSource));
            const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
            const entry = path.join(prefix, "node_modules", "t3-pi-omp", "dist", "bin.mjs");
            yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
            yield* fs.writeFileString(entry, "export {};\n");
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      });

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        packageName: "t3-pi-omp",
        releaseRepository: "owner/fork",
        fetch: forkReleaseFetch(packageBytes),
        fs,
        path,
        runner,
        validate: () => Effect.void,
        platform: "linux",
        arch: "x64",
        httpClient: unusedArchiveHttpClient,
      });

      assert.isTrue(yield* fs.exists(installed.entryPath));
      assert.isFalse(yield* fs.exists(installSource));
    }),
  );

  it.effect(
    "rejects a fork release package whose downloaded bytes fail checksum verification",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-fork-" });
        let ranInstaller = false;
        const result = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version: "1.2.3",
          packageName: "t3-pi-omp",
          releaseRepository: "owner/fork",
          fetch: forkReleaseFetch(
            Buffer.from("expected fork package"),
            Buffer.from("tampered fork package"),
          ),
          fs,
          path,
          runner: ProcessRunner.ProcessRunner.of({
            run: () => {
              ranInstaller = true;
              return Effect.die("installer must not run");
            },
          }),
          validate: () => Effect.void,
          platform: "linux",
          arch: "x64",
          httpClient: unusedArchiveHttpClient,
        }).pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        assert.isFalse(ranInstaller);
      }),
  );
});
