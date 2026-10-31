import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkPiProviderStatus } from "./PiProvider.ts";
import { PI_DIALECT } from "./piDialect.ts";

const encoder = new TextEncoder();

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

function piDiscoverySpawner(
  inventory: unknown,
  options: {
    readonly version?: string;
    readonly state?: unknown;
    readonly authCheck?: string | undefined;
  } = {},
) {
  return Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        const request: unknown = JSON.parse(new TextDecoder().decode(chunk));
        if (typeof request !== "object" || request === null || Array.isArray(request)) return;
        const type = "type" in request && typeof request.type === "string" ? request.type : "";
        const id = "id" in request && typeof request.id === "string" ? request.id : "";
        const data =
          type === "get_available_models"
            ? inventory
            : type === "get_state"
              ? (options.state ?? {})
              : type === "get_commands"
                ? { commands: [] }
                : {};
        yield* Queue.offer(
          stdout,
          encoder.encode(`${JSON.stringify({ type: "response", id, success: true, data })}\n`),
        );
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      if (args.includes("--version")) {
        return Effect.succeed(processHandle({ stdout: `pi ${options.version ?? "0.84.3"}\n` }));
      }
      if (args[0] === "auth") {
        const expected = ["auth", "check", "--provider", "openai", "--json", "--no-refresh"];
        return options.authCheck === undefined || args.join(" ") !== expected.join(" ")
          ? Effect.die(`Unexpected pi ${args.join(" ")}`)
          : Effect.succeed(processHandle({ stdout: options.authCheck, exitCode: 1 }));
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          ...processHandle({}),
          stdin,
          stdout: Stream.fromQueue(stdout),
        }),
      );
    });
  });
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(PI_DIALECT, settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(PI_DIALECT, settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      label: "a pinned model without credentials",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: '{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}',
      message: "Pi default (openai/gpt-5) has no credentials configured for openai.",
      launchArgs: "",
    },
    {
      label: "a pinned model with a runtime --api-key",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: undefined,
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
      launchArgs: "--provider openai --model gpt-5 --api-key fake-key",
    },
    {
      label: "a pinned model whose provider auth check cannot find",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: '{"status":"not_ready","provider":"openai","reason":"provider_not_found"}',
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
      launchArgs: "",
    },
    {
      label: "a pinned model on Pi without auth check",
      version: "0.84.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: undefined,
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
      launchArgs: "",
    },
    {
      label: "an uncatalogued model id of a provider with credentials",
      version: "1.4.0",
      activeModel: { provider: "anthropic", id: "claude-next" },
      authCheck: undefined,
      message: undefined,
      launchArgs: "",
    },
    {
      label: "an extension model Pi lists as available",
      version: "1.4.0",
      activeModel: { provider: "router", id: "auto" },
      authCheck: undefined,
      message: undefined,
      launchArgs: "",
    },
  ])("diagnoses Pi active model readiness for $label", (row) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(
        {
          models: [
            { provider: "anthropic", id: "claude-sonnet-4" },
            { provider: "router", id: "auto" },
          ],
        },
        {
          version: row.version,
          state: { model: row.activeModel },
          authCheck: row.authCheck,
        },
      );
      const snapshot = yield* checkPiProviderStatus(PI_DIALECT, {
        ...settings,
        launchArgs: row.launchArgs,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      if (row.message === undefined) assert.isUndefined(snapshot.message);
      else assert.include(snapshot.message ?? "", row.message);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
