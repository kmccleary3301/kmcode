/**
 * PiProvider — snapshot/probe layer for the Pi coding agent.
 *
 * Health is probed with `pi --version`. Models, the user's default model, and
 * the user's commands (extension slash commands, prompt templates, skills)
 * are discovered through a short-lived ephemeral RPC session
 * (`pi --mode rpc --no-session`), so everything the user configured in
 * `~/.pi/agent` — custom providers, models.json entries, extensions, skills —
 * shows up in T3 without any hardcoded catalog.
 */
import {
  type CustomModelSetting,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../orchestration-v2/Adapters/piT3McpInjection.ts";
import {
  makePiRpcConnection,
  piRecordField as recordField,
  piRecordString as recordString,
} from "../orchestration-v2/Adapters/PiRpc.ts";
import { type PiDialect } from "./piDialect.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "./PiCommands.ts";

const PI_PRESENTATION = {
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // The adapter reports context usage from Pi's streaming usage while a
  // turn runs, so clients can reserve the meter before the first settle.
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 15_000;
interface PiDiscovery extends PiDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
}

function piModelsFromSettings(
  dialect: PiDialect,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  // "default" defers to the user's own settings.json default model.
  const defaultModel: ServerProviderModel = {
    slug: "default",
    name: `${dialect.displayName} default`,
    isCustom: false,
    capabilities: EMPTY_PI_MODEL_CAPABILITIES,
  };
  return providerModelsFromSettings(
    [defaultModel, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

function parseDiscoveredModels(
  data: unknown,
  defaultThinkingLevel: unknown,
): ReadonlyArray<ServerProviderModel> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: thinkingCapabilitiesForPiModel(model, defaultThinkingLevel),
    });
  }
  return parsed;
}

const discoverPiViaRpc = (
  dialect: PiDialect,
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const launch = buildPiRpcLaunch({
      launchArgs,
      environment,
      mcpSession: undefined,
      extensionPath: undefined,
      ephemeral: true,
    });
    const connection = yield* makePiRpcConnection({
      command: piSettings.binaryPath || dialect.binary,
      args: launch.args,
      cwd,
      env: launch.env,
      dialect,
    });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    const stateData = yield* connection.request({ type: "get_state" });
    const modelsData = yield* connection.request({ type: "get_available_models" });
    // OMP has no get_commands; it pushes the same payload as
    // available_commands_update right after ready.
    const commandsData =
      dialect.binary === "omp"
        ? connection.getAvailableCommands()
        : yield* connection
            .request({ type: "get_commands" })
            .pipe(Effect.orElseSucceed(() => undefined));
    const discoveredModels = parseDiscoveredModels(
      modelsData,
      recordString(stateData, "thinkingLevel"),
    );
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return {
      models: discoveredModels,
      slashCommands: withPiBuiltinSlashCommands(slashCommands),
      skills,
      authenticated: discoveredModels.length > 0,
    } satisfies PiDiscovery;
  }).pipe(Effect.scoped);

const runPiVersionCommand = (
  dialect: PiDialect,
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || dialect.binary;
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialPiProviderSnapshot(
  dialect: PiDialect,
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const presentation = { ...PI_PRESENTATION, displayName: dialect.displayName };
    const models = piModelsFromSettings(dialect, piSettings.customModels);
    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${dialect.displayName} is disabled in KM Code settings.`,
        },
      });
    }
    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `Checking ${dialect.displayName} CLI availability...`,
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  dialect: PiDialect,
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const presentation = { ...PI_PRESENTATION, displayName: dialect.displayName };
  const { displayName: name, binary, minimumVersion } = dialect;
  const fallbackModels = piModelsFromSettings(dialect, piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `${name} is disabled in KM Code settings.`,
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(dialect, piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning(`${name} CLI health check failed.`, { errorTag: error._tag });
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `${name} CLI (\`${binary}\`) is not installed or not on PATH. Install with \`npm install -g ${dialect.npmPackage}\`.`
          : `Failed to execute ${name} CLI health check.`,
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `${name} CLI is installed but timed out while running \`${binary} --version\`.`,
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `${name} CLI is installed but failed to run.`,
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `KM Code could not determine the ${name} version. ${name} ${minimumVersion} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, minimumVersion) < 0) {
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `${name} ${version} is unsupported. Update to ${name} ${minimumVersion} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: resolvedLaunchArgs.message,
      },
    });
  }

  const discoveryExit = yield* discoverPiViaRpc(
    dialect,
    piSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
  ).pipe(Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning(`${name} RPC discovery failed.`, {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message: `${name} is available, but KM Code could not refresh its models and commands. The live session will retry startup.`,
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message: `${name} is available, but model and command discovery needs interactive input. The live session will handle it.`,
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = piModelsFromSettings(dialect, piSettings.customModels, discovery.models);
  return buildServerProvider({
    presentation,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "pi" },
      ...(discovery.authenticated
        ? {}
        : {
            message: `${name} has no usable models. Run \`${binary}\` in a terminal and use /login, or configure an API key in ${dialect.agentDir}.`,
          }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
