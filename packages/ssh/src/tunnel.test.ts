import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises real POSIX shells and HTTP processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import { remoteStateKey } from "./command.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  REMOTE_PICK_PORT_SCRIPT,
  SshInvalidArchiveVersionError,
  SshInvalidInstalledCliCommandError,
  SshMissingRunnerError,
} from "./remote-scripts.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RuntimeInfo {
  readonly version: 1;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRuntimeInfo(home: string): RuntimeInfo | undefined {
  try {
    const runtimePath = NodePath.join(home, ".t3", "userdata", "server-runtime.json");
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
    if (
      !isRecordValue(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.origin !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    return {
      version: 1,
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      origin: parsed.origin,
      startedAt: parsed.startedAt,
    };
  } catch {
    return undefined;
  }
}

function parseLaunchResult(stdout: string): {
  readonly remotePort: number;
  readonly serverKind: "external" | "managed";
} {
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  if (line === undefined) {
    throw new Error("The remote launch script returned no output.");
  }
  const parsed: unknown = JSON.parse(line);
  if (
    !isRecordValue(parsed) ||
    typeof parsed.remotePort !== "number" ||
    !Number.isInteger(parsed.remotePort) ||
    parsed.remotePort <= 0 ||
    (parsed.serverKind !== "external" && parsed.serverKind !== "managed")
  ) {
    throw new Error(`Invalid remote launch output: ${line}`);
  }
  return {
    remotePort: parsed.remotePort,
    serverKind: parsed.serverKind,
  };
}

function runPosixScript(
  home: string,
  script: string,
  args: ReadonlyArray<string> = [],
): Promise<ShellResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ShellResult>();
  const child = NodeChildProcess.spawn("/bin/sh", ["-l", "-s", "--", ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  // A real shell integration test cannot use fake timers; bound a broken script's lifetime.
  const timeout = NodeTimers.setTimeout(() => {
    child.kill("SIGKILL");
  }, 10_000);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    NodeTimers.clearTimeout(timeout);
    reject(error);
  });
  child.once("close", (exitCode) => {
    NodeTimers.clearTimeout(timeout);
    resolve({ exitCode: exitCode ?? -1, stdout, stderr });
  });
  child.stdin?.end(script);
  return promise;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requestStatus(origin: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = NodeHttp.get(new URL(origin), (response) => {
    response.resume();
    response.once("end", () => resolve(response.statusCode ?? 0));
  });
  request.setTimeout(2_000, () => {
    request.destroy(new Error("HTTP readiness request timed out."));
  });
  request.once("error", reject);
  return promise;
}

function writeServerFixture(fixturePath: string): void {
  NodeFS.writeFileSync(
    fixturePath,
    `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const args = process.argv.slice(2);
const hostIndex = args.indexOf("--host");
const portIndex = args.indexOf("--port");
const baseDirIndex = args.indexOf("--base-dir");
if (
  args[0] !== "serve" ||
  hostIndex < 0 ||
  portIndex < 0 ||
  baseDirIndex < 0 ||
  args[hostIndex + 1] !== "127.0.0.1"
) {
  process.exit(2);
}
const host = args[hostIndex + 1];
const configuredPort = Number(args[portIndex + 1]);
const baseDir = args[baseDirIndex + 1];
if (!Number.isInteger(configuredPort) || configuredPort <= 0 || !baseDir) {
  process.exit(2);
}

const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("ready");
});
const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.once("error", () => process.exit(1));
server.listen(configuredPort, host, () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.exit(1);
  }
  const runtime = {
    version: 1,
    pid: process.pid,
    host,
    port: address.port,
    origin: "http://127.0.0.1:" + address.port,
    startedAt: new Date().toISOString(),
  };
  const userdataPath = path.join(baseDir, "userdata");
  fs.mkdirSync(userdataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userdataPath, "server-runtime.json"),
    JSON.stringify(runtime) + "\\n",
  );
});
`,
    { encoding: "utf8", mode: 0o600 },
  );
}

describe("ssh tunnel scripts", () => {
  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/pingdotgg/t3code/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    // Concurrent launches serialize on a per-version mkdir lock and recheck
    // the completion marker after acquiring it.
    assert.include(
      script,
      'T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    // mkdir is the exclusive create; the pid follows atomically. A dead owner
    // is reclaimed at once, a never-published owner after a short grace.
    assert.include(script, 'while ! mkdir "$T3_LOCK" 2>/dev/null; do');
    assert.include(script, 'mv "$T3_LOCK/pid.tmp" "$T3_LOCK/pid"');
    assert.include(script, 'if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/t3" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it("refuses to build a runner with neither an archive version nor a node script", () => {
    for (const input of [undefined, {}, { archiveVersion: "  " }, { nodeScriptPath: null }]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript(input),
        SshTunnel.SshMissingRunnerError,
      );
    }
    assert.throws(() => SshTunnel.buildRemoteLaunchScript(), SshTunnel.SshMissingRunnerError);
  });

  it("runs a named installed CLI and rejects anything but a bare command name", () => {
    assert.include(buildRemoteT3RunnerScript({ installedCli: true }), "T3_INSTALLED_CLI='t3'");
    assert.include(
      buildRemoteT3RunnerScript({ installedCli: true, installedCliCommand: "t3-pi-omp" }),
      "T3_INSTALLED_CLI='t3-pi-omp'",
    );
    for (const installedCliCommand of ["../t3", "/usr/bin/t3", "t3 serve", "t3;id", "-t3"]) {
      assert.throws(
        () => buildRemoteT3RunnerScript({ installedCli: true, installedCliCommand }),
        SshInvalidInstalledCliCommandError,
        undefined,
        installedCliCommand,
      );
    }
  });

  it("does not hard-code a remote node engine range", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(NODE_SCRIPT);

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
    assert.include(script, "T3_ARCHIVE_VERSION=''");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"');
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
    assert.notInclude(script, "npx");
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const stateKey = "711bc738002d72fd";
    const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
    const devLaunch = SshTunnel.buildRemoteLaunchScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      launch,
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && server_running "$REMOTE_PID"',
    );
    assert.include(launch, "server_running()");
    assert.include(launch, "RUNNER_CHANGED=1");
    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "if ! ensure_remote_node_path; then");
    assert.include(devLaunch, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(devLaunch, "does not satisfy required range ");
    assert.include(launch, 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(launch, "wait_ready");
    assert.include(launch, '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(launch, "server-home");
    assert.include(launch, "Remote T3 server did not become ready");
    assert.include(launch, 'wait_ready "60000"');
    assert.include(launch, "the server was left running");
    assert.include(launch, 'if [ -s "$LOG_FILE" ]; then');
    assert.include(launch, "It wrote nothing to %s");
    assert.include(launch, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"',
    );
    assert.notInclude(SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE), "server-home");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'kill "$REMOTE_PID" 2>/dev/null || true',
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(
      launch,
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(launch, "resolve_default_runtime_port()");
    assert.include(launch, 'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port');
    assert.include(launch, "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))");
    assert.include(
      launch,
      'if [ -n "$DEFAULT_REMOTE_PORT" ] && [ "$REMOTE_MANAGED" = "managed" ] && [ "$DEFAULT_RUNTIME_PID" = "$REMOTE_PID" ]; then',
    );
    assert.include(launch, 'elif [ -n "$DEFAULT_REMOTE_PORT" ]; then');
    assert.notInclude(launch, "PID_TO_STOP");
    assert.include(launch, 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(launch, 'rm -f "$PID_FILE"');
    assert.include(launch, "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(launch, 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      launch.indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      launch.indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      launch.indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      launch.indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it.live("reuses an owned server and preserves an adopted external server", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-launch-test-"));
    const fixturePath = NodePath.join(home, "server-fixture.cjs");
    const ownedTarget = {
      alias: "managed-target",
      hostname: "managed.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const externalTarget = {
      alias: "stale-target",
      hostname: "stale.example.com",
      username: "julius",
      port: 2223,
    } as const;
    const runner = {
      nodeScriptPath: fixturePath,
    } as const;
    return Effect.gen(function* () {
      const ownedKey = yield* remoteStateKey(ownedTarget);
      const externalKey = yield* remoteStateKey(externalTarget);
      yield* Effect.promise(async () => {
        let ownedPid: number | undefined;
        try {
          writeServerFixture(fixturePath);
          const ownedStateDir = NodePath.join(home, ".t3", "ssh-launch", ownedKey);
          const externalStateDir = NodePath.join(home, ".t3", "ssh-launch", externalKey);

          const firstLaunch = await runPosixScript(home, buildRemoteLaunchScript(runner), [
            ownedKey,
          ]);
          if (firstLaunch.exitCode !== 0) {
            throw new Error(`Initial remote launch failed: ${firstLaunch.stderr}`);
          }
          const firstResult = parseLaunchResult(firstLaunch.stdout);
          assert.equal(firstResult.serverKind, "managed");

          const firstRuntime = readRuntimeInfo(home);
          if (firstRuntime === undefined) {
            throw new Error("The fixture did not write a valid server runtime state.");
          }
          ownedPid = firstRuntime.pid;
          assert.equal(firstResult.remotePort, firstRuntime.port);
          assert.equal(firstRuntime.host, "127.0.0.1");
          assert.equal(firstRuntime.origin, `http://127.0.0.1:${firstRuntime.port}`);
          assert.isTrue(isProcessAlive(firstRuntime.pid));
          assert.equal(await requestStatus(firstRuntime.origin), 200);
          assert.equal(
            NodeFS.readFileSync(NodePath.join(ownedStateDir, "pid"), "utf8"),
            `${firstRuntime.pid}\n`,
          );
          assert.equal(
            NodeFS.readFileSync(NodePath.join(ownedStateDir, "managed"), "utf8"),
            "managed\n",
          );

          const secondLaunch = await runPosixScript(home, buildRemoteLaunchScript(runner), [
            ownedKey,
          ]);
          if (secondLaunch.exitCode !== 0) {
            throw new Error(`Repeated remote launch failed: ${secondLaunch.stderr}`);
          }
          const secondResult = parseLaunchResult(secondLaunch.stdout);
          assert.equal(secondResult.serverKind, "managed");
          assert.equal(secondResult.remotePort, firstRuntime.port);
          assert.equal(
            NodeFS.readFileSync(NodePath.join(ownedStateDir, "managed"), "utf8"),
            "managed\n",
          );
          assert.equal(
            NodeFS.readFileSync(NodePath.join(ownedStateDir, "pid"), "utf8"),
            `${firstRuntime.pid}\n`,
          );
          const secondRuntime = readRuntimeInfo(home);
          if (secondRuntime === undefined) {
            throw new Error("The repeated launch removed the fixture runtime state.");
          }
          assert.equal(secondRuntime.pid, firstRuntime.pid);
          assert.equal(secondRuntime.port, firstRuntime.port);
          assert.isTrue(isProcessAlive(firstRuntime.pid));
          assert.equal(await requestStatus(firstRuntime.origin), 200);

          NodeFS.mkdirSync(externalStateDir, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(externalStateDir, "managed"), "managed\n", "utf8");
          assert.isFalse(NodeFS.existsSync(NodePath.join(externalStateDir, "pid")));

          const adoptedLaunch = await runPosixScript(home, buildRemoteLaunchScript(runner), [
            externalKey,
          ]);
          if (adoptedLaunch.exitCode !== 0) {
            throw new Error(`External adoption launch failed: ${adoptedLaunch.stderr}`);
          }
          const adoptedResult = parseLaunchResult(adoptedLaunch.stdout);
          assert.equal(adoptedResult.serverKind, "external");
          assert.equal(adoptedResult.remotePort, firstRuntime.port);
          assert.isTrue(isProcessAlive(firstRuntime.pid));
          assert.equal(await requestStatus(firstRuntime.origin), 200);
          assert.equal(
            NodeFS.readFileSync(NodePath.join(externalStateDir, "managed"), "utf8"),
            "external\n",
          );
          assert.isFalse(NodeFS.existsSync(NodePath.join(externalStateDir, "pid")));

          const externalStop = await runPosixScript(home, buildRemoteStopScript(externalKey));
          if (externalStop.exitCode !== 0) {
            throw new Error(`External stop failed: ${externalStop.stderr}`);
          }
          assert.isTrue(isProcessAlive(firstRuntime.pid));
          assert.equal(await requestStatus(firstRuntime.origin), 200);
        } finally {
          for (const targetKey of [externalKey, ownedKey]) {
            try {
              await runPosixScript(home, buildRemoteStopScript(targetKey));
            } catch {
              // Fall through to direct cleanup when a launch failed before its state files existed.
            }
          }
          const runtimePid = readRuntimeInfo(home)?.pid;
          for (const pid of new Set([ownedPid, runtimePid])) {
            if (pid === undefined || !isProcessAlive(pid)) {
              continue;
            }
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The process may have exited between the liveness check and kill.
            }
          }
          NodeFS.rmSync(home, { recursive: true, force: true });
        }
      });
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.live.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "does not launch beside a live default-home server that stays unready",
    () => {
      const home = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "km-ssh-stalled-default-server-test-"),
      );
      const fixturePath = NodePath.join(home, "server-fixture.cjs");
      const target = {
        alias: "stalled-default",
        hostname: "stalled-default.example.com",
        username: null,
        port: null,
      } as const;
      const runner = { nodeScriptPath: fixturePath } as const;

      return Effect.gen(function* () {
        const stateKey = yield* remoteStateKey(target);
        yield* Effect.promise(async () => {
          let serverPid: number | undefined;
          try {
            writeServerFixture(fixturePath);
            const initial = await runPosixScript(home, buildRemoteLaunchScript(runner), [stateKey]);
            assert.equal(initial.exitCode, 0, initial.stderr);
            const runtime = readRuntimeInfo(home);
            if (runtime === undefined) {
              throw new Error("The fixture did not write a valid server runtime state.");
            }
            serverPid = runtime.pid;

            const stateDir = NodePath.join(home, ".t3", "ssh-launch", stateKey);
            NodeFS.writeFileSync(NodePath.join(stateDir, "managed"), "external\n", "utf8");
            NodeFS.rmSync(NodePath.join(stateDir, "pid"), { force: true });
            process.kill(serverPid, "SIGSTOP");

            const launch = buildRemoteLaunchScript(runner);
            assert.include(launch, 'wait_ready "60000"');
            const stalledLaunch = launch.replaceAll('wait_ready "60000"', 'wait_ready "1500"');
            const reconnect = await runPosixScript(home, stalledLaunch, [stateKey]);

            assert.equal(reconnect.exitCode, 1, reconnect.stdout);
            assert.include(
              reconnect.stderr,
              "Remote T3 server is still running but did not become ready",
            );
            assert.isTrue(isProcessAlive(serverPid));
            const runtimeAfter = readRuntimeInfo(home);
            if (runtimeAfter === undefined) {
              throw new Error("The stalled launch removed the default server runtime state.");
            }
            assert.equal(runtimeAfter.pid, runtime.pid);
            assert.equal(runtimeAfter.port, runtime.port);
            assert.equal(
              NodeFS.readFileSync(NodePath.join(stateDir, "managed"), "utf8"),
              "external\n",
            );
            assert.isFalse(NodeFS.existsSync(NodePath.join(stateDir, "pid")));

            process.kill(serverPid, "SIGCONT");
            assert.equal(await requestStatus(runtime.origin), 200);
          } finally {
            const runtimePid = readRuntimeInfo(home)?.pid;
            for (const pid of new Set([serverPid, runtimePid])) {
              if (pid === undefined || !isProcessAlive(pid)) {
                continue;
              }
              try {
                process.kill(pid, "SIGCONT");
                process.kill(pid, "SIGKILL");
              } catch {
                // The server may have exited during test cleanup.
              }
            }
            NodeFS.rmSync(home, { recursive: true, force: true });
          }
        });
      }).pipe(Effect.provide(NodeServices.layer));
    },
  );

  it.live.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "does not relaunch a stalled default runtime when its runner changes",
    () => {
      const home = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "km-ssh-stalled-changed-runner-test-"),
      );
      const fixturePath = NodePath.join(home, "server-fixture.cjs");
      const changedFixturePath = NodePath.join(home, "changed-server-fixture.cjs");
      const target = {
        alias: "stalled-changed-runner",
        hostname: "stalled-changed-runner.example.com",
        username: null,
        port: null,
      } as const;
      const runner = { nodeScriptPath: fixturePath } as const;
      const changedRunner = { nodeScriptPath: changedFixturePath } as const;

      return Effect.gen(function* () {
        const stateKey = yield* remoteStateKey(target);
        yield* Effect.promise(async () => {
          let serverPid: number | undefined;
          try {
            writeServerFixture(fixturePath);
            writeServerFixture(changedFixturePath);
            const initial = await runPosixScript(home, buildRemoteLaunchScript(runner), [stateKey]);
            assert.equal(initial.exitCode, 0, initial.stderr);
            const runtime = readRuntimeInfo(home);
            if (runtime === undefined) {
              throw new Error("The fixture did not write a valid server runtime state.");
            }
            serverPid = runtime.pid;
            process.kill(serverPid, "SIGSTOP");

            const launch = buildRemoteLaunchScript(changedRunner);
            assert.include(launch, 'wait_ready "60000"');
            const stalledLaunch = launch.replaceAll('wait_ready "60000"', 'wait_ready "1500"');
            const reconnect = await runPosixScript(home, stalledLaunch, [stateKey]);

            assert.equal(reconnect.exitCode, 1, reconnect.stdout);
            assert.include(
              reconnect.stderr,
              "Remote T3 server is still running but did not become ready",
            );
            assert.isTrue(isProcessAlive(serverPid));
            const runtimeAfter = readRuntimeInfo(home);
            if (runtimeAfter === undefined) {
              throw new Error("The stalled launch removed the default server runtime state.");
            }
            assert.equal(runtimeAfter.pid, runtime.pid);
            assert.equal(runtimeAfter.port, runtime.port);
            const stateDir = NodePath.join(home, ".t3", "ssh-launch", stateKey);
            assert.equal(
              NodeFS.readFileSync(NodePath.join(stateDir, "pid"), "utf8"),
              `${serverPid}\n`,
            );
            assert.equal(
              NodeFS.readFileSync(NodePath.join(stateDir, "managed"), "utf8"),
              "managed\n",
            );
          } finally {
            const runtimePid = readRuntimeInfo(home)?.pid;
            for (const pid of new Set([serverPid, runtimePid])) {
              if (pid === undefined || !isProcessAlive(pid)) {
                continue;
              }
              try {
                process.kill(pid, "SIGCONT");
                process.kill(pid, "SIGKILL");
              } catch {
                // The server may have exited during test cleanup.
              }
            }
            NodeFS.rmSync(home, { recursive: true, force: true });
          }
        });
      }).pipe(Effect.provide(NodeServices.layer));
    },
  );

  it.live.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "leaves a live managed server running when it does not become ready",
    () => {
      const home = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "km-ssh-stalled-server-test-"),
      );
      const fixturePath = NodePath.join(home, "server-fixture.cjs");
      const target = {
        alias: "stalled-managed",
        hostname: "stalled.example.com",
        username: null,
        port: null,
      } as const;
      const runner = { nodeScriptPath: fixturePath } as const;

      return Effect.gen(function* () {
        const stateKey = yield* remoteStateKey(target);
        yield* Effect.promise(async () => {
          let serverPid: number | undefined;
          try {
            writeServerFixture(fixturePath);
            const initial = await runPosixScript(home, buildRemoteLaunchScript(runner), [stateKey]);
            assert.equal(initial.exitCode, 0, initial.stderr);
            const runtime = readRuntimeInfo(home);
            if (runtime === undefined) {
              throw new Error("The fixture did not write a valid server runtime state.");
            }
            serverPid = runtime.pid;

            const launch = buildRemoteLaunchScript(runner);
            assert.include(launch, 'wait_ready "60000"');
            const reconnectScript = launch.replaceAll('wait_ready "60000"', 'wait_ready "1500"');
            process.kill(serverPid, "SIGSTOP");
            const reconnect = await runPosixScript(home, reconnectScript, [stateKey]);

            assert.equal(reconnect.exitCode, 1, reconnect.stdout);
            assert.include(reconnect.stderr, "the server was left running");
            assert.isTrue(isProcessAlive(serverPid));
            const stateDir = NodePath.join(home, ".t3", "ssh-launch", stateKey);
            assert.equal(
              NodeFS.readFileSync(NodePath.join(stateDir, "pid"), "utf8"),
              `${serverPid}\n`,
            );
            assert.equal(
              NodeFS.readFileSync(NodePath.join(stateDir, "managed"), "utf8"),
              "managed\n",
            );

            process.kill(serverPid, "SIGCONT");
            assert.equal(await requestStatus(runtime.origin), 200);
            const stopped = await runPosixScript(home, buildRemoteStopScript(stateKey));
            assert.equal(stopped.exitCode, 0, stopped.stderr);
          } finally {
            if (serverPid !== undefined && isProcessAlive(serverPid)) {
              try {
                process.kill(serverPid, "SIGCONT");
                process.kill(serverPid, "SIGKILL");
              } catch {
                // The server may have exited during test cleanup.
              }
            }
            NodeFS.rmSync(home, { recursive: true, force: true });
          }
        });
      }).pipe(Effect.provide(NodeServices.layer));
    },
  );
  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, NODE_SCRIPT),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("gives cold archive launches a larger budget than node-script launches", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 800_000)),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(800));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(SshTunnel.REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "skips remote ports that already answer on loopback",
    () => {
      const linuxHost = HostProcessPlatform.defaultValue() === "linux";
      const preload = `const net = require("node:net");
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") {
    return originalListen.apply(this, arguments);
  }
  return originalListen.call(this, { port, host, reusePort: true }, callback);
};
`;
      const holdWildcardPort = Effect.acquireRelease(
        Effect.callback<NodeNet.Server>((resume) => {
          const server = NodeNet.createServer((socket) => socket.destroy());
          server.once("error", (error) => resume(Effect.die(error)));
          server.listen({ port: 0, host: "0.0.0.0", reusePort: linuxHost }, () =>
            resume(Effect.succeed(server)),
          );
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "km-pick-port-test-" });
        yield* fs.writeFileString(`${root}/preload.cjs`, preload);
        yield* fs.writeFileString(`${root}/pick-port.cjs`, REMOTE_PICK_PORT_SCRIPT);
        const holder = yield* holdWildcardPort;
        const address = holder.address();
        if (address === null || typeof address === "string") {
          throw new Error("The wildcard port fixture did not expose a TCP port.");
        }
        const heldPort = address.port;

        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            ...(linuxHost ? ["--require", `${root}/preload.cjs`] : []),
            `${root}/pick-port.cjs`,
            "",
            String(heldPort),
            "20",
          ]),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0);
        const pickedPort = Number(stdout);
        assert.isAbove(pickedPort, heldPort);
        assert.isBelow(pickedPort, heldPort + 20);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    },
  );

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          SshTunnel.waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let tunnelKillCount = 0;
      let stopCommandCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          spawnedCommands.push(args);
          if (args.includes("-N")) {
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            });
          }
          if (args.includes("sh") && args.includes("--")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            stopCommandCount += 1;
            if (mode === "failed stop" && stopCommandCount === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(
                  new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                ),
              };
            }
            return makeSuccessfulProcess('{"stopped":true}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;

        const first = yield* manager.ensureEnvironment(target);
        assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
        const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
        assert.isDefined(firstTunnelArgs);
        assert.include(firstTunnelArgs, "ControlMaster=no");
        assert.include(firstTunnelArgs, "ControlPath=none");
        assert.include(firstTunnelArgs, "ControlPersist=no");

        const disconnected = yield* Effect.result(manager.disconnectEnvironment(target));
        if (mode === "failed stop") {
          assert.isTrue(Result.isFailure(disconnected));
          if (Result.isFailure(disconnected)) {
            assert.instanceOf(disconnected.failure, SshCommandError);
            assert.equal(
              disconnected.failure.message,
              "Remote T3 server did not stop within 2 seconds.",
            );
          }
        } else {
          assert.isTrue(Result.isSuccess(disconnected));
        }
        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 1);

        if (mode === "failed stop") {
          yield* manager.disconnectEnvironment(target);
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 2);
        }

        yield* manager.ensureEnvironment(target);

        assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
        assert.equal(tunnelKillCount, 1);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(tunnelKillCount, 2);
            assert.equal(stopCommandCount, mode === "failed stop" ? 3 : 2);
          }),
        ),
      );
    },
  );

  it.effect("keeps the stderr reader alive until disconnect", () =>
    Effect.gen(function* () {
      const readerStarted = yield* Deferred.make<void>();
      let readers = 0;
      let finalized = 0;
      const stderr = Stream.fromEffect(
        Effect.sync(() => {
          readers += 1;
        }).pipe(Effect.andThen(Deferred.succeed(readerStarted, undefined))),
      ).pipe(
        Stream.flatMap(() => Stream.fromEffect(Effect.never)),
        Stream.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? { ...makeRunningProcess(() => undefined), stderr }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.await(readerStarted).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        assert.equal(readers, 1);
        assert.equal(finalized, 0, "readiness must not release the stderr reader");
        yield* manager.disconnectEnvironment(target);
        assert.equal(finalized, 1, "disconnect must release the stderr reader");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        `old diagnostics\n${"x".repeat(32_768)}\n${diagnostic}`,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real tunnel exit when reading stderr fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.live("drains diagnostics beyond pipe capacity after readiness", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const input = yield* Queue.unbounded<Uint8Array>();
      const readerStarted = yield* Deferred.make<void>();
      const tunnelSpawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      let finalized = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!commandArgs(command).includes("-N")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          const child = yield* nodeSpawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                `process.stdin.once("data", () => {
                  process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), () => {
                    process.stdout.write("diagnostics complete\\n");
                  });
                });`,
              ],
              { stdin: { stream: Stream.fromQueue(input) } },
            ),
          );
          yield* Deferred.succeed(tunnelSpawned, child);
          return {
            ...child,
            stderr: Stream.fromEffect(Deferred.succeed(readerStarted, undefined)).pipe(
              Stream.flatMap(() => child.stderr),
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            ),
          };
        }),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.await(readerStarted).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        yield* manager.ensureEnvironment(target);
        const child = yield* Deferred.await(tunnelSpawned);
        const progress = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Queue.offer(input, new TextEncoder().encode("write diagnostics"));
        assert.deepEqual(yield* Fiber.join(progress).pipe(Effect.timeout("5 seconds")), [
          "diagnostics complete",
        ]);
        assert.isTrue(yield* child.isRunning);
        yield* manager.disconnectEnvironment(target);
        assert.equal(finalized, 1);
        assert.isFalse(yield* child.isRunning);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rebuilds an exited SSH tunnel without probing its stale forward", () =>
    Effect.gen(function* () {
      let forwards = 0;
      let readinessProbes = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            return makeSuccessfulProcess("");
          }
          if (args.includes("--")) return makeSuccessfulProcess('{"remotePort":3773}\n');
          return makeSuccessfulProcess("");
        }),
      );
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          readinessProbes += 1;
          return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };

      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        const probesBeforeReconnect = readinessProbes;
        yield* manager.ensureEnvironment(target);

        assert.equal(forwards, 2);
        assert.equal(readinessProbes, probesBeforeReconnect + 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("drops unresponsive SSH tunnels and keeps responsive ones", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      let unresponsive = false;
      let forwards = 0;
      let kills = 0;
      let stops = 0;
      let nextLocalPort = 41_773;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            return makeRunningProcess(() => {
              kills += 1;
            });
          }
          if (args.includes("--")) return makeSuccessfulProcess('{"remotePort":3773}\n');
          if (args.includes("sh")) stops += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const httpClient = HttpClient.make((request) =>
        new URL(request.url).port === "41773" && unresponsive
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const netService = NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        hasListenerOnHost: () => Effect.succeed(false),
        reserveLoopbackPort: () => Effect.sync(() => nextLocalPort++),
        findAvailablePort: (preferred) => Effect.succeed(preferred),
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, netService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        TestClock.layer(),
      );
      const unresponsiveTarget = {
        alias: "offline",
        hostname: "offline",
        username: null,
        port: null,
      };
      const responsiveTarget = {
        alias: "online",
        hostname: "online",
        username: null,
        port: null,
      };

      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(unresponsiveTarget);
        yield* manager.ensureEnvironment(responsiveTarget);

        unresponsive = true;
        const drop = yield* Effect.forkChild(manager.dropUnresponsiveTunnels);
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Fiber.join(drop);
        assert.equal(kills, 1);
        assert.equal(stops, 0);

        unresponsive = false;
        yield* manager.ensureEnvironment(unresponsiveTarget);
        yield* manager.ensureEnvironment(responsiveTarget);

        assert.equal(forwards, 3);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("replaces a stale SSH forward without stopping the remote server", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      let stale = false;
      let forwards = 0;
      let stops = 0;
      let kills = 0;
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-N")) {
            forwards += 1;
            stale = false;
            return makeRunningProcess(() => {
              kills += 1;
            });
          }
          if (args.includes("--")) return makeSuccessfulProcess('{"remotePort":3773}\n');
          if (args.includes("sh")) stops += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const httpClient = HttpClient.make((request) =>
        stale
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        TestClock.layer(),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        stale = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(reconnect);
        assert.equal(forwards, 2);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
        yield* manager.disconnectEnvironment(target);
        assert.equal(stops, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.includes("--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// The archive runner is generated shell; string assertions cannot prove the
// lock excludes concurrent installers. Run the real script against a tiny
// fake archive served from a file:// mirror.
describe("archive runner script", () => {
  const hostPlatform = HostProcessPlatform.defaultValue();
  const hostArch = HostProcessArchitecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runRunner = (home: string, runner: string, path = process.env.PATH ?? "") =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", [runner, "--version"], {
          env: { PATH: path, HOME: home },
          extendEnv: false,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  // A fake "executable" that answers --version, packed the way the release
  // workflow packs the real archive: one top-level directory named after the
  // stem, checksummed in SHA256SUMS.
  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `t3-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${stage}/t3'`,
      `chmod +x '${stage}/t3'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)(
    "installs once when several launches race, and reclaims stale locks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });

        const results = yield* Effect.all(
          [runRunner(home, runner), runRunner(home, runner), runRunner(home, runner)],
          { concurrency: "unbounded" },
        );
        for (const result of results) {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `t3 v${archiveVersion}`);
        }
        const versionsDir = `${home}/.t3/runtime/versions`;
        assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
        assert.equal(
          (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
          archiveVersion,
        );

        // A lock left by a crashed installer (dead pid) must not block the
        // next launch, and neither must one that never published a pid.
        const lock = `${versionsDir}/.${archiveVersion}.install.lock`;
        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        yield* fs.writeFileString(`${lock}/pid`, "999999\n");
        const afterDead = yield* runRunner(home, runner);
        assert.equal(afterDead.exitCode, 0, afterDead.stderr);

        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        const afterUnowned = yield* runRunner(home, runner);
        assert.equal(afterUnowned.exitCode, 0, afterUnowned.stderr);
        assert.isFalse(yield* fs.exists(lock));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  // Installers put fork CLIs (Node scripts) in ~/.local/bin, which Ubuntu's
  // non-interactive ssh shell does not have on PATH.
  it.effect.skipIf(windowsHost)(
    "finds an installed CLI in ~/.local/bin from a bare non-interactive PATH",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-installed-runner-" });
        const home = `${root}/home`;
        const cli = `${home}/.local/bin/t3-pi-omp`;
        yield* fs.makeDirectory(`${home}/.local/bin`, { recursive: true });
        yield* fs.writeFileString(cli, "#!/bin/sh\necho t3-pi-omp 9.9.9\n");
        yield* fs.chmod(cli, 0o755);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({
            installedCli: true,
            installedCliCommand: "t3-pi-omp",
          }),
        );
        const result = yield* runRunner(home, runner, "/usr/bin:/bin");
        assert.equal(result.exitCode, 0, result.stderr);
        assert.include(result.stdout, "t3-pi-omp 9.9.9");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
