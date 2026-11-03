import type { ServerConfig, ServerHostHealthSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionTarget, SupervisorConnectionState } from "./model.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";
const LOCAL_CLOCK_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}
export interface EnvironmentHostHealthObservation {
  readonly snapshot: ServerHostHealthSnapshot;
  readonly receivedAt: number;
  readonly previousSnapshot: ServerHostHealthSnapshot | null;
}

export type DesktopSshTunnelState = "running" | "stopped" | "unknown";

export type EnvironmentConnectionDiagnosisCategory =
  | "offline"
  | "transport"
  | "server-unresponsive"
  | "host-rebooted"
  | "server-restarted"
  | "stall"
  | "pressure"
  | "connected";

export interface EnvironmentConnectionDiagnosis {
  readonly category: EnvironmentConnectionDiagnosisCategory;
  readonly headline: string;
  readonly evidence: ReadonlyArray<string>;
  readonly timestamp: number | null;
}

function pressureEvidence(snapshot: ServerHostHealthSnapshot): ReadonlyArray<string> {
  const evidence: Array<string> = [];
  const ioPressure = snapshot.pressure.io.someAvg10Percent;
  if (ioPressure !== null) {
    evidence.push(`I/O pressure: ${Math.round(ioPressure)}% (some avg10)`);
  }
  if (snapshot.eventLoopDelayP99Ms !== null) {
    evidence.push(`Event-loop p99: ${formatDuration(snapshot.eventLoopDelayP99Ms)}`);
  }
  const writer = snapshot.diskWriters[0];
  if (writer !== undefined) {
    evidence.push(
      `Top writer: ${diskActorLabel(writer)} · ${formatThroughput(
        writer.bytes,
        snapshot.sampleWindowMs,
      )}`,
    );
  }
  const reader = snapshot.diskReaders[0];
  if (reader !== undefined) {
    evidence.push(
      `Top reader: ${diskActorLabel(reader)} · ${formatThroughput(
        reader.bytes,
        snapshot.sampleWindowMs,
      )}`,
    );
  }
  evidence.push(`D-state tasks: ${snapshot.dStateTasks}`);
  const stall = snapshot.currentStall;
  if (stall !== null) {
    evidence.push(
      `Main-thread stall: ${stall.wchan ?? stall.state ?? "blocked"} · ${formatDuration(stall.durationMs)}`,
    );
  }
  return evidence;
}

function hostEvidence(
  observation: EnvironmentHostHealthObservation | null,
  now: number,
  state: SupervisorConnectionState,
): ReadonlyArray<string> {
  const connectionDetails = [`Connection phase: ${state.phase}`, `Attempt: ${state.attempt}`];
  if (observation === null) {
    return ["No host-health beacon has arrived.", ...connectionDetails];
  }
  const ageSeconds = Math.max(0, Math.floor((now - observation.receivedAt) / 1_000));
  const sampledAt = LOCAL_CLOCK_TIME_FORMATTER.format(observation.snapshot.sampledAt);
  const lines = [
    `Sampled at ${sampledAt} · beacon received ${ageSeconds}s ago`,
    ...pressureEvidence(observation.snapshot),
    ...connectionDetails,
  ];
  return lines.slice(0, 6);
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(1)} s`
    : `${Math.round(milliseconds)} ms`;
}

function formatThroughput(bytes: number, sampleWindowMs: number): string {
  if (sampleWindowMs <= 0) return `${bytes} B`;
  const kibibytesPerSecond = Math.round((bytes * 1_000) / sampleWindowMs / 1_024);
  return `${kibibytesPerSecond} KiB/s`;
}

function diskActorLabel(
  item: ServerHostHealthSnapshot["diskWriters"][number],
): string {
  if (item.unit !== null) {
    return item.pid === null ? item.unit : `${item.unit} · ${item.comm}`;
  }
  return item.pid === null ? item.comm : `${item.comm} (pid ${item.pid})`;
}

function isNetworkFailure(state: SupervisorConnectionState): boolean {
  const failure = state.lastFailure;
  return (
    failure !== null &&
    failure._tag === "ConnectionTransientError" &&
    [
      "network",
      "timeout",
      "transport",
      "endpoint-unavailable",
      "relay-unavailable",
      "remote-unavailable",
    ].includes(failure.reason)
  );
}

function isServerNotRespondingFailure(state: SupervisorConnectionState): boolean {
  const detail = state.lastFailure?.message.toLowerCase() ?? "";
  return (
    detail.includes("stopped responding") ||
    detail.includes("did not respond to a connection health check")
  );
}

function completedStallAfter(
  observation: EnvironmentHostHealthObservation,
): ServerHostHealthSnapshot["completedStalls"][number] | null {
  const previousStalls = observation.previousSnapshot?.completedStalls ?? [];
  return (
    observation.snapshot.completedStalls.find(
      (stall) =>
        !previousStalls.some(
          (previous) =>
            previous.startedAt === stall.startedAt && previous.durationMs === stall.durationMs,
        ),
    ) ?? null
  );
}

function isPressure(snapshot: ServerHostHealthSnapshot): boolean {
  return (
    (snapshot.pressure.io.someAvg10Percent ?? 0) > 40 ||
    (snapshot.eventLoopDelayP99Ms ?? 0) > 1_000
  );
}

export function diagnoseEnvironmentConnection(input: {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  readonly hostHealth?: EnvironmentHostHealthObservation | null;
  readonly browserOnline?: boolean;
  readonly desktopTunnelState?: DesktopSshTunnelState | null;
  readonly now: number;
}): EnvironmentConnectionDiagnosis {
  const now = input.now;
  const observation = input.hostHealth ?? null;
  const snapshot = observation?.snapshot ?? null;
  const timestamp = snapshot?.sampledAt ?? null;
  const evidence = hostEvidence(observation, now, input.state);
  const phaseUnavailable =
    input.state.phase === "connecting" ||
    input.state.phase === "backoff" ||
    input.state.phase === "offline";

  if (input.browserOnline === false || input.state.network === "offline") {
    return {
      category: "offline",
      headline: "Your network is offline",
      evidence: ["The device reports no network connection.", ...evidence].slice(0, 6),
      timestamp,
    };
  }

  if (
    phaseUnavailable &&
    (input.desktopTunnelState === "stopped" ||
      (input.state.lastFailureConnection === "before-open" && isNetworkFailure(input.state)))
  ) {
    return {
      category: "transport",
      headline: `Can't reach ${input.hostLabel}: network or Tailscale path; the server may be fine`,
      evidence: [
        ...(input.desktopTunnelState === null || input.desktopTunnelState === undefined
          ? []
          : [`Desktop SSH tunnel: ${input.desktopTunnelState}`]),
        ...(input.state.lastFailure === null
          ? []
          : [`Last error: ${input.state.lastFailure.message}`]),
        ...evidence,
      ].slice(0, 6),
      timestamp,
    };
  }

  const beaconAgeMs = observation === null ? null : now - observation.receivedAt;
  const staleBeacon =
    input.state.phase === "connected" && beaconAgeMs !== null && beaconAgeMs > 12_000;
  const activeStall = snapshot?.currentStall !== null && snapshot?.currentStall !== undefined;
  if (
    activeStall ||
    staleBeacon ||
    (phaseUnavailable &&
      input.state.lastFailureConnection === "open" &&
      isServerNotRespondingFailure(input.state))
  ) {
    return {
      category: "server-unresponsive",
      headline: `${input.hostLabel} is reachable but the KM server is not responding`,
      evidence: evidence.slice(0, 6),
      timestamp,
    };
  }

  if (
    input.state.phase === "connected" &&
    observation !== null &&
    observation.previousSnapshot !== null &&
    observation.previousSnapshot.hostBootId !== null &&
    observation.snapshot.hostBootId !== null &&
    observation.previousSnapshot.hostBootId !== observation.snapshot.hostBootId
  ) {
    return {
      category: "host-rebooted",
      headline: `${input.hostLabel} rebooted at ${LOCAL_CLOCK_TIME_FORMATTER.format(observation.snapshot.sampledAt)}`,
      evidence: evidence.slice(0, 6),
      timestamp,
    };
  }

  if (
    input.state.phase === "connected" &&
    observation !== null &&
    observation.previousSnapshot !== null &&
    observation.previousSnapshot.serverInstanceId !== observation.snapshot.serverInstanceId
  ) {
    return {
      category: "server-restarted",
      headline: `KM server restarted at ${LOCAL_CLOCK_TIME_FORMATTER.format(observation.snapshot.sampledAt)}`,
      evidence: evidence.slice(0, 6),
      timestamp,
    };
  }

  const completedStall =
    input.state.phase === "connected" && observation !== null
      ? completedStallAfter(observation)
      : null;
  if (completedStall !== null) {
    const writer = snapshot?.diskWriters[0];
    const writerLabel = writer === undefined ? "disk activity" : diskActorLabel(writer);
    const waitChannel = completedStall.wchan ?? completedStall.state;
    return {
      category: "stall",
      headline: `Server was blocked ${Math.round(completedStall.durationMs / 1_000)} s${
        waitChannel === null ? "" : ` (disk: ${waitChannel})`
      } while ${writerLabel} was writing`,
      evidence: evidence.slice(0, 6),
      timestamp: completedStall.startedAt,
    };
  }

  if (input.state.phase === "connected" && snapshot !== null && isPressure(snapshot)) {
    return {
      category: "pressure",
      headline: "Host under pressure",
      evidence: evidence.slice(0, 6),
      timestamp,
    };
  }

  return {
    category: "connected",
    headline:
      input.state.phase === "connected"
        ? `Connected to ${input.hostLabel}`
        : `Waiting to connect to ${input.hostLabel}`,
    evidence,
    timestamp,
  };
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

/**
 * The address an agent outside T3 (Claude Code, Codex) uses to reach this
 * environment's MCP server: the route this device is connected over, since an
 * agent beside this client can reach it too, else the first route in
 * preference order that has an address. SSH connections ride a local forward
 * that disappears with the client, so they have no stable address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl =
      route.target._tag === "RelayConnectionTarget"
        ? (input.relayHttpBaseUrl ?? null)
        : routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
