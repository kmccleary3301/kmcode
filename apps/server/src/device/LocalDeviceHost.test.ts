import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessIsExecutable,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  agentDeviceStateDir,
  DEVICE_HUB_VERSION,
} from "./DeviceToolchain.ts";

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest) are missing");
    }),
  );

  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("recognizes legacy command-line tools on Windows", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "C:\\Android\\Sdk\\platform-tools\\adb.exe",
          "C:\\Android\\Sdk\\emulator\\emulator.exe",
          "C:\\Android\\Sdk\\tools\\bin\\avdmanager.bat",
        ],
        { ANDROID_HOME: "C:\\Android\\Sdk" },
        "win32",
      );
      expect(reason).toContain("older, unsupported version");
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
  }).pipe(Effect.provide(NodePath.layer)),
);

it.effect(
  "recovers an owned Linux runtime directory without overriding explicit environments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const stat = yield* fs.stat(directory);
      for (const [platform, uid, runtimeDir, type, owner, expected] of [
        ["linux", 1000, undefined, "Directory", 1000, "/run/user/1000"],
        ["linux", 1000, "/custom/runtime", "Directory", 1000, "/custom/runtime"],
        ["linux", 1000, "", "Directory", 1000, ""],
        ["linux", 1000, undefined, "Directory", 1001, undefined],
        ["linux", 1000, undefined, "File", 1000, undefined],
        ["linux", undefined, undefined, "Directory", 1000, undefined],
        ["darwin", 1000, undefined, "Directory", 1000, undefined],
        ["win32", 1000, undefined, "Directory", 1000, undefined],
      ] as const) {
        const environment = { PATH: "/usr/bin", XDG_RUNTIME_DIR: runtimeDir };
        const result = yield* LocalDeviceHost.__testing.hubEnvironment(environment).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(HostProcessUserId, uid),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              stat: (path) => {
                expect(path).toBe("/run/user/1000");
                return Effect.succeed({ ...stat, type, uid: Option.some(owner) });
              },
            }),
          ),
        );
        expect(result.XDG_RUNTIME_DIR).toBe(expected);
        expect(result.PATH).toBe("/usr/bin");
        expect(result.FORCE_COLOR).toBe("0");
        expect(result.NO_COLOR).toBe("1");
        expect(environment.XDG_RUNTIME_DIR).toBe(runtimeDir);
      }
      const missing = yield* LocalDeviceHost.__testing
        .hubEnvironment({})
        .pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessUserId, 1000),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
      expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcessIsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "restarts an unhealthy agent daemon and keeps releasing sessions when hub restart fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-agent-release-" });
      for (const tool of [
        {
          name: "expo-device-hub",
          version: DEVICE_HUB_VERSION,
          entry: ["dist", "server", "cli.mjs"],
        },
        {
          name: "agent-device",
          version: AGENT_DEVICE_VERSION,
          entry: ["bin", "agent-device.mjs"],
        },
      ] as const) {
        const installDir = path.join(baseDir, "tools", tool.name, tool.version);
        const entryPath = path.join(installDir, "node_modules", tool.name, ...tool.entry);
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fs.writeFileString(entryPath, "");
        yield* fs.writeFileString(path.join(installDir, ".install-complete"), tool.version);
      }
      const stateDir = agentDeviceStateDir(path, path.join(baseDir, "userdata"));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "daemon.json"),
        JSON.stringify({ httpPort: 12345, token: "test-token" }),
      );

      const hub = { running: true, spawnFails: false };
      const daemonHealthy = yield* Ref.make(true);
      let daemonStarts = 0;
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() => {
        if (hub.spawnFails)
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "Hub entry missing",
            }),
          );
        const id = ++spawnCount;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123 + id),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.sync(() => (id === 1 ? hub.running : true)),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      });
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.gen(function* () {
            if (input.args.includes("devices")) {
              daemonStarts++;
              yield* fs.writeFileString(
                path.join(stateDir, "daemon.json"),
                JSON.stringify({
                  httpPort: 12345 + daemonStarts,
                  token: `test-token-${daemonStarts}`,
                }),
              );
            }
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
      };
      const releases: string[] = [];
      const http = HttpClient.make((request) =>
        request.url.endsWith("/rpc")
          ? Effect.sync(() => {
              releases.push(request.url);
              return HttpClientResponse.fromWeb(request, Response.json({ result: { ok: true } }));
            })
          : request.url.endsWith("/health")
            ? Ref.get(daemonHealthy).pipe(
                Effect.map((healthy) =>
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("ok", { status: healthy ? 200 : 503 }),
                  ),
                ),
              )
            : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
      );
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { ...process.env, HOME: baseDir }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const first = yield* host.ensureAgentReady(() => Effect.void);
      const cached = yield* host.ensureAgentReady(() => Effect.void);
      expect(cached.agentDevice).toEqual(first.agentDevice);
      expect(daemonStarts).toBe(0);
      yield* Ref.set(daemonHealthy, false);
      const restarted = yield* host.ensureAgentReady(() => Effect.void);
      expect(daemonStarts).toBe(1);
      expect(restarted.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12346",
        token: "test-token-1",
      });
      hub.running = false;
      hub.spawnFails = true;
      const failed = yield* host.ensureReady(() => Effect.void).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");

      const afterFailure = yield* host.current;
      if (!afterFailure?.releaseAgentSession)
        return yield* Effect.die("Agent session release is unavailable after hub restart failure");
      yield* afterFailure.releaseAgentSession("fixture-session", "fixture-device");
      expect(releases).toEqual(["http://127.0.0.1:12346/rpc"]);

      hub.spawnFails = false;
      yield* host.ensureReady(() => Effect.void);
      const afterRestart = yield* host.current;
      if (!afterRestart?.releaseAgentSession)
        return yield* Effect.die("Agent session release is unavailable after hub restart");
      yield* afterRestart.releaseAgentSession("fixture-session", "fixture-device");
      expect(releases).toEqual(["http://127.0.0.1:12346/rpc", "http://127.0.0.1:12346/rpc"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
