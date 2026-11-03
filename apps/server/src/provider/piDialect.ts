import { ProviderDriverKind } from "@t3tools/contracts";

/**
 * What differs between upstream Pi and Oh My Pi when both run through the Pi
 * provider, adapter, and RPC transport. `binary` doubles as the RPC flavor:
 * OMP negotiates protocol v2 and frames large payloads as `rpc_chunk`.
 */
export interface PiDialect {
  readonly driverKind: ProviderDriverKind;
  readonly binary: "pi" | "omp";
  readonly displayName: string;
  readonly minimumVersion: string;
  readonly npmPackage: string;
  readonly agentDir: string;
}

export const PI_DIALECT: PiDialect = {
  driverKind: ProviderDriverKind.make("pi"),
  binary: "pi",
  displayName: "Pi",
  // get_entries arrived in 0.80.3 and agent_settled in 0.80.4; 0.80.5 was the
  // first published package with both. Rollback boundaries and turn
  // terminalization depend on them.
  minimumVersion: "0.80.5",
  npmPackage: "@earendil-works/pi-coding-agent",
  agentDir: "~/.pi/agent",
};

export const OMP_DIALECT: PiDialect = {
  driverKind: ProviderDriverKind.make("omp"),
  binary: "omp",
  displayName: "Oh My Pi",
  // First release verified against RPC protocol v2 negotiation and
  // `rpc_chunk` framing for get_available_models.
  minimumVersion: "18.8.3",
  npmPackage: "@oh-my-pi/pi-coding-agent",
  agentDir: "~/.omp/agent",
};
