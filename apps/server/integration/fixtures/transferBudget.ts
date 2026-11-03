import type { ProviderDriverKind } from "@t3tools/contracts";
export const TRANSFER_HISTORY_TURN_COUNT = 10;
export const TRANSFER_HISTORY_TOOLS_PER_TURN = 5;
export const TRANSFER_MEASURED_TOOLS = 20;
export const TRANSFER_HISTORY_MCP_RESULT_BYTES = 900_000;
export const TRANSFER_MEASURED_MCP_RESULT_BYTES = 1_100_000;

type FixtureProviderProfile = {
  readonly label: string;
  readonly seed: number;
  readonly model: string;
  readonly effort: string;
  readonly command: (toolIndex: number) => string;
};

const providerFixtureProfiles: Readonly<Record<string, FixtureProviderProfile>> = {
  codex: {
    label: "Codex",
    seed: 0x43_4f_44_45,
    model: "gpt-5.4",
    effort: "high",
    command: (toolIndex) => `vp test transfer-budget-${toolIndex + 1}`,
  },
  claudeAgent: {
    label: "Claude",
    seed: 0x43_4c_41_55,
    model: "claude-opus-4-1",
    effort: "default",
    command: (toolIndex) => `review transfer budget ${toolIndex + 1}`,
  },
  pi: {
    label: "Pi",
    seed: 0x50_49_46_58,
    model: "pi-transfer-fixture",
    effort: "medium",
    command: (toolIndex) => `pi inspect transfer-budget-${toolIndex + 1}`,
  },
  omp: {
    label: "Oh My Pi",
    seed: 0x4f_4d_50_46,
    model: "omp-transfer-fixture",
    effort: "low",
    command: (toolIndex) => `omp inspect transfer-budget-${toolIndex + 1}`,
  },
};

const defaultFixtureProviderProfile: FixtureProviderProfile = {
  label: "Provider",
  seed: 0x46_49_58_54,
  model: "provider-transfer-fixture",
  effort: "default",
  command: (toolIndex) => `inspect transfer-budget-${toolIndex + 1}`,
};

function providerFixtureProfile(provider: ProviderDriverKind): FixtureProviderProfile {
  return providerFixtureProfiles[provider] ?? defaultFixtureProviderProfile;
}

const sourceModules = [
  "connection/session.ts",
  "connection/supervisor.ts",
  "rpc/client.ts",
  "rpc/protocol.ts",
  "state/threads.ts",
  "state/threadReducer.ts",
  "state/threadSnapshotHttp.ts",
  "orchestration/http.ts",
  "orchestration/Normalizer.ts",
  "orchestration/ActivityPayloadProjection.ts",
  "provider/ProviderService.ts",
  "provider/ProviderRuntimeIngestion.ts",
  "persistence/ProjectionSnapshotQuery.ts",
  "persistence/OrchestrationEventStore.ts",
  "checkpointing/CheckpointStore.ts",
  "checkpointing/CheckpointDiffQuery.ts",
  "server.ts",
] as const;

function mix(value: number): number {
  let mixed = value | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function digest(seed: number): string {
  return [0, 1, 2, 3]
    .map((offset) =>
      mix(seed + offset * 0x9e3779b9)
        .toString(16)
        .padStart(8, "0"),
    )
    .join("");
}

/** Produces safe, deterministic output with enough entropy to exercise gzip. */
export function diagnosticOutput(input: {
  readonly provider: ProviderDriverKind;
  readonly turnIndex: number;
  readonly toolIndex: number;
  readonly targetBytes: number;
}): string {
  const chunks: string[] = [];
  const providerSeed = providerFixtureProfile(input.provider).seed;
  let length = 0;
  let lineIndex = 0;

  while (length < input.targetBytes) {
    const modulePath = sourceModules[(input.toolIndex + lineIndex) % sourceModules.length];
    const seed =
      providerSeed + input.turnIndex * 100_003 + input.toolIndex * 10_007 + lineIndex * 101;
    const line =
      `${String(lineIndex + 1).padStart(6, "0")} ${modulePath} ` +
      `operation=project-transfer-${input.turnIndex + 1}-${input.toolIndex + 1} ` +
      `cursor=${mix(seed)} digest=${digest(seed)} status=completed\n`;
    chunks.push(line);
    length += line.length;
    lineIndex += 1;
  }

  return chunks.join("").slice(0, input.targetBytes);
}
