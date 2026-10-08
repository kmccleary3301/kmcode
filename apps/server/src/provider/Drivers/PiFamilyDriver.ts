import {
  OmpSettings,
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { parseSemver, satisfiesSemverRange } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ProviderDriverCreateInput } from "../ProviderDriver.ts";
import { DEFAULT_TIMEOUT_MS, isCommandMissingCause, spawnAndCollect } from "../providerSnapshot.ts";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makePiFamilyAdapter } from "../piFamily/NativeAdapter.ts";
import {
  discoverPiFamilyModels,
  modelDiscoverySnapshotMessage,
} from "../piFamily/ModelDiscovery.ts";
import { makePiFamilyTextGeneration } from "../../textGeneration/PiFamilyTextGeneration.ts";

const SUPPORTED_PI_RANGE = ">=0.84.2 <0.85.0";
const SUPPORTED_OMP_RANGE = ">=17.3.7 <19.0.0";

export function parsePiFamilyCliVersion(output: string): string | null {
  const match = output.match(
    /(?<![\d.])v?(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?(?![0-9A-Za-z.])/u,
  );
  const version = match?.[1];
  if (version === undefined) return null;
  const prerelease = match?.[2];
  const parsed = prerelease === undefined ? version : `${version}-${prerelease}`;
  return parseSemver(parsed) === null ? null : parsed;
}

export function piFamilyVersionCompatibilityError(
  provider: "pi" | "omp",
  version: string | null,
): string | undefined {
  const supportedRange = provider === "omp" ? SUPPORTED_OMP_RANGE : SUPPORTED_PI_RANGE;
  if (version === null) {
    return `${provider} native version could not be parsed. Configure a supported ${provider} release (${supportedRange}) and refresh provider health.`;
  }
  const parsed = parseSemver(version);
  if (parsed === null || parsed.prerelease.length > 0) {
    return `${provider} native version '${version}' is malformed or unsupported. Configure a stable ${provider} release in ${supportedRange} and refresh provider health.`;
  }
  if (!satisfiesSemverRange(version, supportedRange)) {
    return `${provider} native version '${version}' is unsupported. KM Code supports ${provider} releases in ${supportedRange}; configure a compatible binary and refresh provider health.`;
  }
  return undefined;
}
export type PiFamilySettings = typeof PiSettings.Type | typeof OmpSettings.Type;

const maintenance = (provider: ProviderDriverKind): ProviderMaintenanceCapabilities => ({
  provider,
  packageName: null,
  update: null,
});

function makeSnapshot(
  input: ProviderDriverCreateInput<PiFamilySettings>,
  provider: ProviderDriverKind,
  dependencies: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly cwd: string;
  },
): ServerProviderShape {
  const config = input.config;
  const cwd = resolvePiFamilyWorkingDirectory(config.workingDirectory, dependencies.cwd);
  const environment = resolvePiFamilyEnvironment(
    {
      ...process.env,
      ...config.environment,
      ...(config.agentDirectory ? { PI_CODING_AGENT_DIR: config.agentDirectory } : {}),
    },
    input.environment,
  );
  const check = Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const base = {
      instanceId: input.instanceId,
      driver: provider,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: `${provider}:instance:${input.instanceId}` },
      enabled: input.enabled,
      models: [],
      slashCommands: [],
      skills: [],
      availability: "available" as const,
    };
    if (!input.enabled) {
      return {
        ...base,
        installed: false,
        version: null,
        status: "disabled" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: "Provider is disabled in settings.",
      } satisfies ServerProvider;
    }
    const probe = yield* Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(config.binaryPath, ["--version"], {
        env: environment,
      });
      return yield* spawnAndCollect(
        config.binaryPath,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd,
          env: environment,
          extendEnv: false,
          shell: spawnCommand.shell,
        }),
      );
    }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(probe)) {
      const cause = probe.failure;
      return {
        ...base,
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: isCommandMissingCause(cause)
          ? `${provider} binary is not installed or not on PATH.`
          : `${provider} version probe failed.`,
      } satisfies ServerProvider;
    }
    if (probe.success._tag === "None") {
      return {
        ...base,
        installed: true,
        version: null,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: `${provider} version probe timed out.`,
      } satisfies ServerProvider;
    }
    const result = probe.success.value;
    const version = parsePiFamilyCliVersion(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0) {
      return {
        ...base,
        installed: true,
        version,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: `${provider} version probe exited unsuccessfully.`,
      } satisfies ServerProvider;
    }
    const compatibilityError = piFamilyVersionCompatibilityError(
      provider === "omp" ? "omp" : "pi",
      version,
    );
    if (compatibilityError !== undefined) {
      return {
        ...base,
        installed: true,
        version,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: compatibilityError,
      } satisfies ServerProvider;
    }
    const discovery = yield* discoverPiFamilyModels({
      runtime: provider === "omp" ? "omp" : "pi",
      provider,
      binaryPath: config.binaryPath,
      cwd,
      ...(config.agentDirectory ? { agentDirectory: config.agentDirectory } : {}),
      environment,
      launchArguments: config.launchArguments,
      trustMode: config.trustMode,
      requestTimeoutMs: config.requestTimeoutMs,
      startupTimeoutMs: config.startupTimeoutMs,
      maxLineBytes: config.maxLineBytes,
      maxMessageBytes: config.maxMessageBytes,
    }).pipe(Effect.result);
    if (Result.isFailure(discovery)) {
      return {
        ...base,
        installed: true,
        version,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: modelDiscoverySnapshotMessage(provider, discovery.failure),
      } satisfies ServerProvider;
    }
    return {
      ...base,
      models: discovery.success.models,
      slashCommands: discovery.success.slashCommands,
      installed: true,
      version,
      status: "ready" as const,
      auth: { status: "unknown" as const },
      checkedAt,
    } satisfies ServerProvider;
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, dependencies.spawner));
  return {
    resolveMaintenance: () => Effect.succeed(maintenance(provider)),
    getSnapshot: check,
    refresh: check,
    streamChanges: Stream.empty,
    // Pi and OMP publish no provider rate-limit windows to merge.
    applyUsageLimits: () => Effect.void,
  };
}
export function resolvePiFamilyEnvironment(
  configEnvironment: Readonly<Record<string, string | undefined>>,
  instanceEnvironment: ProviderDriverCreateInput<PiFamilySettings>["environment"],
): NodeJS.ProcessEnv {
  return mergeProviderInstanceEnvironment(instanceEnvironment, {
    ...process.env,
    ...configEnvironment,
  });
}
export function resolvePiFamilyWorkingDirectory(
  configuredWorkingDirectory: string,
  serverWorkingDirectory: string,
): string {
  return configuredWorkingDirectory || serverWorkingDirectory;
}

function makeAdapter(
  input: ProviderDriverCreateInput<PiFamilySettings>,
  provider: ProviderDriverKind,
  noSession = false,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | ServerConfig
> {
  const config = input.config;
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const processEnvironment = resolvePiFamilyEnvironment(
      {
        ...config.environment,
        ...(config.agentDirectory ? { PI_CODING_AGENT_DIR: config.agentDirectory } : {}),
      },
      input.environment,
    );
    return yield* makePiFamilyAdapter({
      provider,
      runtime: provider === "omp" ? "omp" : "pi",
      binaryPath: config.binaryPath,
      cwd: resolvePiFamilyWorkingDirectory(config.workingDirectory, serverConfig.cwd),
      ...(config.agentDirectory ? { agentDirectory: config.agentDirectory } : {}),
      attachmentsDir: serverConfig.attachmentsDir,
      environment: processEnvironment,
      launchArguments: noSession
        ? [...(config.launchArguments ?? []), "--no-session"]
        : config.launchArguments,
      trustMode: config.trustMode,
      requestTimeoutMs: config.requestTimeoutMs,
      startupTimeoutMs: config.startupTimeoutMs,
      maxLineBytes: config.maxLineBytes,
      maxMessageBytes: config.maxMessageBytes,
      stderrLimitBytes: 256 * 1024,
      instanceId: input.instanceId,
    });
  });
}

function makeTextGeneration(
  provider: ProviderDriverKind,
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): ProviderInstance["textGeneration"] {
  return makePiFamilyTextGeneration({ provider, adapter });
}

export function makePiFamilyDriver<Config extends PiFamilySettings>(input: {
  readonly provider: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly displayName: string;
}): ProviderDriver<Config, ChildProcessSpawner.ChildProcessSpawner | ServerConfig> {
  return {
    driverKind: input.provider,
    metadata: { displayName: input.displayName, supportsMultipleInstances: true },
    configSchema: input.configSchema,
    defaultConfig: input.defaultConfig,
    create: (createInput) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const serverConfig = yield* ServerConfig;
        const adapter = yield* makeAdapter(createInput, input.provider);
        const textGenerationAdapter = yield* makeAdapter(createInput, input.provider, true);
        return {
          instanceId: createInput.instanceId,
          driverKind: input.provider,
          continuationIdentity: defaultProviderContinuationIdentity({
            driverKind: input.provider,
            instanceId: createInput.instanceId,
          }),
          displayName: createInput.displayName,
          accentColor: createInput.accentColor,
          enabled: createInput.enabled,
          snapshot: makeSnapshot(createInput, input.provider, {
            spawner,
            cwd: serverConfig.cwd,
          }),
          adapter,
          textGeneration: makeTextGeneration(input.provider, textGenerationAdapter),
        } satisfies ProviderInstance;
      }),
  };
}
