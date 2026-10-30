import type {
  ClientPortForwardExclusion,
  EnvironmentId,
  ForwardedPort,
  ListeningPort,
  PortForwardHost,
} from "@t3tools/contracts";

export interface AutoForwardState {
  readonly baselineEstablished: boolean;
  readonly baselineIdentities: Readonly<Record<string, true>>;
  /**
   * New listeners seen by exactly one scan so far. A listener is forwarded only
   * once a second scan still sees it, so short-lived servers (test harnesses,
   * probes) that come and go between scans never get a local listener.
   */
  readonly pendingIdentities: Readonly<Record<string, true>>;
  readonly suppressedPorts: Readonly<Record<number, true>>;
  readonly failedErrors: Readonly<Record<string, string>>;
}

export type AutoForwardAction =
  | {
      readonly type: "start";
      readonly environmentId: EnvironmentId;
      readonly remotePort: number;
      readonly remoteHost: PortForwardHost;
      readonly localPort: number;
      readonly origin: "auto";
      readonly pid: number | null;
      readonly processName: string | null;
      readonly lifecycleToken: number;
    }
  | {
      readonly type: "stop";
      readonly environmentId: EnvironmentId;
      readonly remotePort: number;
      readonly remoteHost: PortForwardHost;
    };

export const HOST_PREFERENCE: Readonly<Record<PortForwardHost, number>> = {
  "127.0.0.1": 1,
  localhost: 2,
  "::1": 3,
};

export function listenerIdentityKey(
  host: PortForwardHost,
  port: number,
  pid: number | null,
): string {
  return `${host}:${port}:${pid ?? "none"}`;
}

export function createInitialAutoForwardState(): AutoForwardState {
  return {
    baselineEstablished: false,
    baselineIdentities: {},
    pendingIdentities: {},
    suppressedPorts: {},
    failedErrors: {},
  };
}

/**
 * Treats every listener alive right now as pre-existing, as a fresh connect
 * would. Used after stopping all forwards so the listeners whose forwards were
 * just closed are not immediately auto-forwarded again; listeners that start
 * later still are.
 */
export function absorbListenersIntoBaseline(
  state: AutoForwardState,
  listeners: readonly ListeningPort[],
): AutoForwardState {
  const baselineIdentities: Record<string, true> = { ...state.baselineIdentities };
  for (const listener of listeners) {
    baselineIdentities[listenerIdentityKey(listener.host, listener.port, listener.pid)] = true;
  }
  return {
    ...state,
    baselineEstablished: true,
    baselineIdentities,
    pendingIdentities: {},
    failedErrors: {},
  };
}

export function suppressedPortsForEnvironment(
  exclusions: readonly ClientPortForwardExclusion[],
  environmentId: EnvironmentId,
): Readonly<Record<number, true>> {
  const ports: Record<number, true> = {};
  for (const exclusion of exclusions) {
    if (exclusion.environmentId === environmentId) {
      ports[exclusion.remotePort] = true;
    }
  }
  return ports;
}

export function deduplicateListeningPortsByPort(
  ports: readonly ListeningPort[],
): readonly ListeningPort[] {
  const bestByPort: Record<number, ListeningPort> = {};
  for (const port of ports) {
    const existing = bestByPort[port.port];
    if (!existing) {
      bestByPort[port.port] = port;
    } else {
      const prefNew = HOST_PREFERENCE[port.host] ?? 99;
      const prefExisting = HOST_PREFERENCE[existing.host] ?? 99;
      if (prefNew < prefExisting) {
        bestByPort[port.port] = port;
      }
    }
  }
  return Object.values(bestByPort);
}

export interface PlanDiscoveryParams {
  readonly state: AutoForwardState;
  readonly environmentId: EnvironmentId;
  readonly isLocal: boolean;
  readonly isConnected: boolean;
  readonly isEnabled: boolean;
  readonly hasOperateGrant: boolean;
  readonly isAutoForwardEnabled: boolean;
  readonly discoveredPorts: readonly ListeningPort[];
  readonly forwardedPorts: readonly ForwardedPort[];
  /** Most auto-origin forwards this environment may hold at once. */
  readonly autoForwardLimit: number;
  readonly inFlightPorts?: Readonly<Record<number, true>>;
  readonly excludedPorts?: Readonly<Record<number, true>>;
  readonly lifecycleToken?: number;
}

export interface PlanDiscoveryResult {
  readonly nextState: AutoForwardState;
  readonly actions: readonly AutoForwardAction[];
}

/**
 * One discovery scan's worth of auto-forwarding decisions, modelled on VS
 * Code's process-based port forwarding:
 * - listeners present on the first scan after connecting are pre-existing
 *   and never auto-forwarded;
 * - a new listener is forwarded once two consecutive scans have seen it;
 * - an auto-origin forward closes as soon as a scan no longer sees anything
 *   listening on its remote port (VS Code's `AutoForwardEnd`), so forwards
 *   track live listeners instead of accumulating;
 * - at most `autoForwardLimit` auto-origin forwards exist per environment.
 * User-origin forwards are never started or stopped here.
 */
export function planDiscoveryActions(params: PlanDiscoveryParams): PlanDiscoveryResult {
  const {
    state,
    environmentId,
    isLocal,
    isConnected,
    isEnabled,
    hasOperateGrant,
    isAutoForwardEnabled,
    discoveredPorts,
    forwardedPorts,
    autoForwardLimit,
    inFlightPorts = {},
    excludedPorts = {},
    lifecycleToken = 0,
  } = params;
  if (isLocal) {
    return { nextState: state, actions: [] };
  }

  if (!isConnected || !isEnabled) {
    return {
      nextState: createInitialAutoForwardState(),
      actions: [],
    };
  }

  const currentIdentities: Record<string, true> = {};
  const listeningPortNumbers: Record<number, true> = {};
  for (const p of discoveredPorts) {
    currentIdentities[listenerIdentityKey(p.host, p.port, p.pid)] = true;
    listeningPortNumbers[p.port] = true;
  }

  if (!state.baselineEstablished) {
    return {
      nextState: {
        baselineEstablished: true,
        baselineIdentities: currentIdentities,
        pendingIdentities: {},
        suppressedPorts: state.suppressedPorts,
        failedErrors: {},
      },
      actions: [],
    };
  }

  // Prune disappeared listeners from baseline
  const nextBaselineIdentities: Record<string, true> = {};
  for (const identity in state.baselineIdentities) {
    if (currentIdentities[identity]) {
      nextBaselineIdentities[identity] = true;
    }
  }

  const nextFailedErrors: Record<string, string> = {};
  for (const [identity, error] of Object.entries(state.failedErrors)) {
    if (currentIdentities[identity]) {
      nextFailedErrors[identity] = error;
    }
  }

  // If permission revoked or auto-forwarding toggled off:
  // Absorb all current listeners into baseline so they are not auto-forwarded later if re-enabled.
  if (!hasOperateGrant || !isAutoForwardEnabled) {
    for (const identity in currentIdentities) {
      nextBaselineIdentities[identity] = true;
    }
    return {
      nextState: {
        baselineEstablished: true,
        baselineIdentities: nextBaselineIdentities,
        pendingIdentities: {},
        suppressedPorts: state.suppressedPorts,
        failedErrors: nextFailedErrors,
      },
      actions: [],
    };
  }

  const actions: AutoForwardAction[] = [];
  const forwardedPortNumbers: Record<number, true> = {};
  let liveAutoForwards = 0;
  for (const f of forwardedPorts) {
    if (f.environmentId !== environmentId) continue;
    forwardedPortNumbers[f.remotePort] = true;
    if (f.origin !== "auto") continue;
    if (listeningPortNumbers[f.remotePort] || inFlightPorts[f.remotePort]) {
      liveAutoForwards += 1;
    } else {
      actions.push({
        type: "stop",
        environmentId,
        remotePort: f.remotePort,
        remoteHost: f.remoteHost,
      });
    }
  }

  const candidates: ListeningPort[] = [];
  const nextPendingIdentities: Record<string, true> = {};
  for (const port of discoveredPorts) {
    const identity = listenerIdentityKey(port.host, port.port, port.pid);
    if (nextBaselineIdentities[identity]) {
      continue;
    }
    if (state.suppressedPorts[port.port] || excludedPorts[port.port]) {
      continue;
    }
    if (nextFailedErrors[identity]) {
      continue;
    }
    if (forwardedPortNumbers[port.port]) {
      continue;
    }
    if (inFlightPorts[port.port]) {
      continue;
    }
    nextPendingIdentities[identity] = true;
    if (state.pendingIdentities[identity]) {
      candidates.push(port);
    }
  }

  let inFlightCount = 0;
  for (const port in inFlightPorts) {
    if (!forwardedPortNumbers[Number(port)]) inFlightCount += 1;
  }
  const startSlots = Math.max(0, autoForwardLimit - liveAutoForwards - inFlightCount);
  for (const candidate of deduplicateListeningPortsByPort(candidates).slice(0, startSlots)) {
    actions.push({
      type: "start",
      environmentId,
      remotePort: candidate.port,
      remoteHost: candidate.host,
      localPort: candidate.port,
      origin: "auto",
      pid: candidate.pid,
      processName: candidate.processName,
      lifecycleToken,
    });
  }

  return {
    nextState: {
      baselineEstablished: true,
      baselineIdentities: nextBaselineIdentities,
      pendingIdentities: nextPendingIdentities,
      suppressedPorts: state.suppressedPorts,
      failedErrors: nextFailedErrors,
    },
    actions,
  };
}

export function isStartActionValid(
  action: AutoForwardAction,
  currentLifecycleToken: number,
  isAutoForwardEnabled: boolean,
): boolean {
  if (action.type !== "start") return false;
  if (!isAutoForwardEnabled) return false;
  if (action.lifecycleToken !== currentLifecycleToken) return false;
  return true;
}

export function recordUserStop(
  state: AutoForwardState,
  listeners: readonly {
    readonly host: PortForwardHost;
    readonly port: number;
    readonly pid: number | null;
  }[],
): AutoForwardState {
  const suppressedPorts: Record<number, true> = { ...state.suppressedPorts };
  for (const listener of listeners) {
    suppressedPorts[listener.port] = true;
  }
  return { ...state, suppressedPorts };
}

export function recordAutoForwardFailure(
  state: AutoForwardState,
  listener: {
    readonly host: PortForwardHost;
    readonly port: number;
    readonly pid: number | null;
  },
  error: string,
): AutoForwardState {
  const identity = listenerIdentityKey(listener.host, listener.port, listener.pid);
  return {
    ...state,
    failedErrors: {
      ...state.failedErrors,
      [identity]: error,
    },
  };
}

export function clearAutoForwardErrors(state: AutoForwardState, port: number): AutoForwardState {
  const nextFailed: Record<string, string> = {};
  for (const [identity, error] of Object.entries(state.failedErrors)) {
    if (!identity.includes(`:${port}:`)) {
      nextFailed[identity] = error;
    }
  }
  return { ...state, failedErrors: nextFailed };
}

export function clearAutoForwardSuppressionAndErrors(
  state: AutoForwardState,
  port: number,
): AutoForwardState {
  const suppressedPorts: Record<number, true> = { ...state.suppressedPorts };
  delete suppressedPorts[port];
  return {
    ...clearAutoForwardErrors(state, port),
    suppressedPorts,
  };
}

export function handleToggleAutoForward(
  state: AutoForwardState,
  enabled: boolean,
  forwards: readonly ForwardedPort[],
  environmentId: EnvironmentId,
): {
  readonly nextState: AutoForwardState;
  readonly actions: readonly AutoForwardAction[];
} {
  if (!enabled) {
    const actions: AutoForwardAction[] = forwards
      .filter((f) => f.environmentId === environmentId && f.origin === "auto")
      .map((f) => ({
        type: "stop",
        environmentId: f.environmentId,
        remotePort: f.remotePort,
        remoteHost: f.remoteHost,
      }));
    return {
      nextState: state,
      actions,
    };
  }

  // When re-enabling, keep baseline intact (do not wipe baseline on every tick)
  return {
    nextState: state,
    actions: [],
  };
}
