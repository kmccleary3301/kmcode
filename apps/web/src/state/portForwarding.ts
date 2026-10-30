import type {
  ClientPortForwardExclusion,
  EnvironmentId,
  ForwardedPort,
  ListeningPort,
  PortForwardConnectionRequest,
  PortForwardHost,
  PortForwardKey,
  PortForwardStart,
} from "@t3tools/contracts";

import { useAtomValue } from "@effect/atom-react";
import {
  fetchListeningPorts,
  resolvePortForwardWebSocketUrl,
  sanitizeConnectionError,
} from "@t3tools/client-runtime/state/portForwarding";
import {
  EnvironmentId as EnvironmentIdSchema,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsUpdate,
} from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  type AutoForwardState,
  absorbListenersIntoBaseline,
  clearAutoForwardErrors,
  clearAutoForwardSuppressionAndErrors,
  createInitialAutoForwardState,
  handleToggleAutoForward,
  recordAutoForwardFailure,
  recordUserStop,
  suppressedPortsForEnvironment,
} from "./portForwardingPolicy";
import { environmentSession, usePreparedConnection } from "./session";

export interface ListeningPortsState {
  readonly ports: readonly ListeningPort[];
  readonly loading: boolean;
  readonly error: string | null;
}

export function isPortForwardingAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.desktopBridge?.portForwarding;
  return (
    typeof bridge?.list === "function" &&
    typeof bridge?.start === "function" &&
    typeof bridge?.stop === "function" &&
    typeof bridge?.stopAll === "function" &&
    typeof bridge?.onChanged === "function" &&
    typeof bridge?.onConnectionRequest === "function" &&
    typeof bridge?.resolveConnection === "function"
  );
}

export function portKey(environmentId: EnvironmentId, host: PortForwardHost, port: number): string {
  return `${environmentId}:${host}:${port}`;
}

export const forwardedPortsAtom = Atom.make<readonly ForwardedPort[]>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-forwarded-ports"),
);

const EMPTY_LISTENING_PORTS: ListeningPortsState = {
  ports: [],
  loading: false,
  error: null,
};

export const listeningPortsStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ListeningPortsState>(EMPTY_LISTENING_PORTS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-listening-ports:${environmentId}`),
  ),
);

/**
 * Session-scoped auto-forwarding toggle per environment.
 * Default is ON for non-local environments and OFF for the primary local environment.
 */
export const autoForwardingEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<boolean>(environmentId !== PRIMARY_LOCAL_ENVIRONMENT_ID).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-auto-forwarding-enabled:${environmentId}`),
  ),
);

/**
 * Error map by exact listener identity for failed automatic or manual attempts.
 */
export const autoForwardErrorsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<Readonly<Record<string, string>>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-auto-forward-errors:${environmentId}`),
  ),
);

// Safe prototype-less dictionaries for arbitrary EnvironmentId keys
const autoForwardStates: Record<string, AutoForwardState> = Object.setPrototypeOf({}, null);
const inFlightPortStarts: Record<string, Record<number, true>> = Object.setPrototypeOf({}, null);
const latestDiscoveryEpoch: Record<string, number> = Object.setPrototypeOf({}, null);
const lifecycleGenerations: Record<string, number> = Object.setPrototypeOf({}, null);

export function getAutoForwardLifecycleGeneration(environmentId: EnvironmentId): number {
  return lifecycleGenerations[environmentId] ?? 0;
}

export function bumpAutoForwardLifecycleGeneration(environmentId: EnvironmentId): number {
  const next = (lifecycleGenerations[environmentId] ?? 0) + 1;
  lifecycleGenerations[environmentId] = next;
  return next;
}

export function getAutoForwardState(environmentId: EnvironmentId): AutoForwardState {
  let state = autoForwardStates[environmentId];
  if (!state) {
    state = createInitialAutoForwardState();
    autoForwardStates[environmentId] = state;
  }
  return state;
}

export function setAutoForwardState(environmentId: EnvironmentId, state: AutoForwardState): void {
  autoForwardStates[environmentId] = state;
  appAtomRegistry.set(autoForwardErrorsAtom(environmentId), state.failedErrors);
}

export function resetAutoForwardState(environmentId: EnvironmentId): void {
  latestDiscoveryEpoch[environmentId] = (latestDiscoveryEpoch[environmentId] ?? 0) + 1;
  bumpAutoForwardLifecycleGeneration(environmentId);
  delete autoForwardStates[environmentId];
  delete inFlightPortStarts[environmentId];
  appAtomRegistry.set(autoForwardErrorsAtom(environmentId), {});
}

export function getTrackedEnvironmentIds(): readonly EnvironmentId[] {
  return Object.keys(autoForwardStates).map((id) => EnvironmentIdSchema.make(id));
}

export function markInFlight(environmentId: EnvironmentId, port: number, inFlight: boolean): void {
  let ports = inFlightPortStarts[environmentId];
  if (!ports) {
    ports = {};
    inFlightPortStarts[environmentId] = ports;
  }
  if (inFlight) {
    ports[port] = true;
  } else {
    delete ports[port];
  }
}

export function getInFlightPorts(environmentId: EnvironmentId): Readonly<Record<number, true>> {
  return inFlightPortStarts[environmentId] ?? {};
}

export function recordAutoForwardError(
  environmentId: EnvironmentId,
  listener: {
    readonly host: PortForwardHost;
    readonly port: number;
    readonly pid: number | null;
  },
  error: string,
): void {
  const currentState = getAutoForwardState(environmentId);
  const nextState = recordAutoForwardFailure(currentState, listener, error);
  setAutoForwardState(environmentId, nextState);
}

export function clearAutoForwardError(environmentId: EnvironmentId, port: number): void {
  const currentState = getAutoForwardState(environmentId);
  const nextState = clearAutoForwardErrors(currentState, port);
  setAutoForwardState(environmentId, nextState);
}

function hasPortForwardExclusion(environmentId: EnvironmentId, port: number): boolean {
  return getClientSettings().portForwardExclusions.some(
    (exclusion) =>
      exclusion.environmentId === environmentId && exclusion.remotePort === port,
  );
}

export function getAutoForwardExcludedPorts(
  environmentId: EnvironmentId,
): Readonly<Record<number, true>> {
  return suppressedPortsForEnvironment(
    getClientSettings().portForwardExclusions,
    environmentId,
  );
}

export function isAutoForwardPortExcluded(environmentId: EnvironmentId, port: number): boolean {
  return (
    getAutoForwardState(environmentId).suppressedPorts[port] === true ||
    hasPortForwardExclusion(environmentId, port)
  );
}

function restoreSuppressedPortState(
  environmentId: EnvironmentId,
  port: number,
  previousState: AutoForwardState,
): void {
  const currentState = getAutoForwardState(environmentId);
  const suppressedPorts: Record<number, true> = { ...currentState.suppressedPorts };
  if (previousState.suppressedPorts[port]) {
    suppressedPorts[port] = true;
  } else {
    delete suppressedPorts[port];
  }
  setAutoForwardState(environmentId, { ...currentState, suppressedPorts });
}

async function persistPortForwardExclusion(
  environmentId: EnvironmentId,
  port: number,
  hidden: boolean,
  createIfMissing: boolean,
): Promise<void> {
  const previousState = getAutoForwardState(environmentId);
  setAutoForwardState(
    environmentId,
    recordUserStop(previousState, [{ host: "localhost", port, pid: null }]),
  );

  try {
    await ensureClientSettingsHydrated();
    const existing = hasPortForwardExclusion(environmentId, port);
    if (!existing && !createIfMissing) {
      restoreSuppressedPortState(environmentId, port, previousState);
      return;
    }
    if (
      existing &&
      getClientSettings().portForwardExclusions.find(
        (exclusion) =>
          exclusion.environmentId === environmentId && exclusion.remotePort === port,
      )?.hidden === hidden
    ) {
      return;
    }

    await persistClientSettingsUpdate((settings) => {
      const current = settings.portForwardExclusions.find(
        (exclusion) =>
          exclusion.environmentId === environmentId && exclusion.remotePort === port,
      );
      const remaining = settings.portForwardExclusions.filter(
        (exclusion) =>
          exclusion.environmentId !== environmentId || exclusion.remotePort !== port,
      );
      if (current) {
        return {
          ...settings,
          portForwardExclusions: [...remaining, { ...current, hidden }],
        };
      }
      if (!createIfMissing) return settings;
      const exclusion: ClientPortForwardExclusion = {
        environmentId,
        remotePort: port,
        hidden,
      };
      return {
        ...settings,
        portForwardExclusions: [...remaining, exclusion],
      };
    });
  } catch (cause) {
    restoreSuppressedPortState(environmentId, port, previousState);
    throw cause;
  }
}

export async function setPortForwardExclusionHidden(
  environmentId: EnvironmentId,
  port: number,
  hidden: boolean,
): Promise<void> {
  await persistPortForwardExclusion(environmentId, port, hidden, hidden);
  if (hidden) clearAutoForwardError(environmentId, port);
}

export async function clearPortForwardExclusion(
  environmentId: EnvironmentId,
  port: number,
): Promise<void> {
  await ensureClientSettingsHydrated();
  const previousState = getAutoForwardState(environmentId);
  setAutoForwardState(
    environmentId,
    clearAutoForwardSuppressionAndErrors(previousState, port),
  );
  if (!hasPortForwardExclusion(environmentId, port)) return;
  try {
    await persistClientSettingsUpdate((settings) => ({
      ...settings,
      portForwardExclusions: settings.portForwardExclusions.filter(
        (exclusion) =>
          exclusion.environmentId !== environmentId || exclusion.remotePort !== port,
      ),
    }));
  } catch (cause) {
    setAutoForwardState(environmentId, previousState);
    throw cause;
  }
}


export function isAutoForwardingEnabled(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(autoForwardingEnabledAtom(environmentId));
}

function updateAutoForwardingPreference(
  environmentId: EnvironmentId,
  enabled: boolean,
  forwards: readonly ForwardedPort[],
) {
  appAtomRegistry.set(autoForwardingEnabledAtom(environmentId), enabled);
  bumpAutoForwardLifecycleGeneration(environmentId);

  const { nextState, actions } = handleToggleAutoForward(
    getAutoForwardState(environmentId),
    enabled,
    forwards,
    environmentId,
  );
  setAutoForwardState(environmentId, nextState);
  return actions;
}

export async function setAutoForwardingEnabled(
  environmentId: EnvironmentId,
  enabled: boolean,
): Promise<void> {
  const actions = updateAutoForwardingPreference(
    environmentId,
    enabled,
    appAtomRegistry.get(forwardedPortsAtom),
  );
  const failures: number[] = [];
  for (const action of actions) {
    if (action.type !== "stop") continue;
    try {
      await stopPortForward({
        environmentId: action.environmentId,
        remoteHost: action.remoteHost,
        remotePort: action.remotePort,
      });
    } catch {
      failures.push(action.remotePort);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not stop automatic forwards on ports ${failures.join(", ")}.`);
  }
}

/**
 * Closes every forward in every environment with one desktop call and writes
 * nothing to settings. Each environment's live listeners are folded into its
 * baseline so auto-forwarding does not reopen what was just closed, while
 * servers started afterwards are still auto-forwarded. Bumping the lifecycle
 * generation also invalidates any auto-forward start already in flight.
 */
export async function stopAllPortForwards(): Promise<number> {
  const bridge = window.desktopBridge?.portForwarding;
  if (!bridge || typeof bridge.stopAll !== "function") {
    throw new Error("Port forwarding is only available in the desktop application.");
  }
  const environmentIds = new Set<EnvironmentId>(getTrackedEnvironmentIds());
  for (const forward of appAtomRegistry.get(forwardedPortsAtom)) {
    environmentIds.add(forward.environmentId);
  }
  for (const environmentId of environmentIds) {
    bumpAutoForwardLifecycleGeneration(environmentId);
    setAutoForwardState(
      environmentId,
      absorbListenersIntoBaseline(
        getAutoForwardState(environmentId),
        appAtomRegistry.get(listeningPortsStateAtom(environmentId)).ports,
      ),
    );
  }
  return bridge.stopAll();
}

export async function refreshListeningPorts(
  environmentId: EnvironmentId,
): Promise<readonly ListeningPort[] | null> {
  const atom = listeningPortsStateAtom(environmentId);
  const current = appAtomRegistry.get(atom);
  appAtomRegistry.set(atom, { ...current, loading: true, error: null });

  const epoch = (latestDiscoveryEpoch[environmentId] ?? 0) + 1;
  latestDiscoveryEpoch[environmentId] = epoch;

  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );

  if (prepared === null) {
    appAtomRegistry.set(atom, {
      ports: current.ports,
      loading: false,
      error: "Environment is not connected.",
    });
    return null;
  }

  const queryAtom = connectionAtomRuntime
    .atom(fetchListeningPorts({ prepared }))
    .pipe(Atom.withLabel(`web-listening-ports-query:${environmentId}:${epoch}`));

  try {
    const ports = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, queryAtom, { suspendOnWaiting: true }).pipe(
        Effect.timeout("10 seconds"),
      ),
    );

    // Epoch guard: do not stomp or return snapshot if epoch changed
    if (latestDiscoveryEpoch[environmentId] !== epoch) {
      return null;
    }

    appAtomRegistry.set(atom, {
      ports,
      loading: false,
      error: null,
    });
    return ports;
  } catch (error) {
    if (latestDiscoveryEpoch[environmentId] !== epoch) {
      return null;
    }
    const sanitized = sanitizeConnectionError(error);
    appAtomRegistry.set(atom, {
      ports: current.ports,
      loading: false,
      error: sanitized,
    });
    return null;
  }
}

export async function handlePortForwardConnectionRequest(
  request: PortForwardConnectionRequest,
): Promise<void> {
  const bridge = window.desktopBridge?.portForwarding;
  if (!bridge || typeof bridge.resolveConnection !== "function") {
    return;
  }

  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(request.environmentId)),
  );

  if (prepared === null) {
    await bridge.resolveConnection({
      requestId: request.requestId,
      error: `Environment ${request.environmentId} is offline or not connected.`,
    });
    return;
  }

  try {
    const resolveAtom = connectionAtomRuntime
      .atom(
        resolvePortForwardWebSocketUrl({
          prepared,
          remotePort: request.remotePort,
          remoteHost: request.remoteHost,
        }),
      )
      .pipe(Atom.withLabel(`web-port-forward-ticket:${request.requestId}`));

    const socketUrl = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, resolveAtom, { suspendOnWaiting: true }).pipe(
        Effect.timeout("8 seconds"),
      ),
    );

    await bridge.resolveConnection({
      requestId: request.requestId,
      socketUrl,
    });
  } catch (error) {
    await bridge.resolveConnection({
      requestId: request.requestId,
      error: sanitizeConnectionError(error),
    });
  }
}

export async function startPortForward(input: PortForwardStart): Promise<ForwardedPort> {
  const bridge = window.desktopBridge?.portForwarding;
  if (!bridge || typeof bridge.start !== "function") {
    throw new Error("Port forwarding is only available in the desktop application.");
  }

  let hadExclusion = false;
  if (input.origin === "user") {
    await ensureClientSettingsHydrated();
    hadExclusion = hasPortForwardExclusion(input.environmentId, input.remotePort);
    await clearPortForwardExclusion(input.environmentId, input.remotePort);
  }

  let result: ForwardedPort;
  try {
    result = await bridge.start(input);
  } catch (cause) {
    if (input.origin === "user" && hadExclusion) {
      const startError =
        cause instanceof Error ? cause.message : "Could not forward this port.";
      try {
        await persistPortForwardExclusion(
          input.environmentId,
          input.remotePort,
          false,
          true,
        );
      } catch (restoreCause) {
        const restoreError =
          restoreCause instanceof Error
            ? restoreCause.message
            : "Could not restore the exclusion.";
        throw new Error(
          `${startError} The stop exclusion could not be restored: ${restoreError}`,
        );
      }
    }
    throw cause;
  }
  clearAutoForwardError(input.environmentId, input.remotePort);
  return result;
}

export async function stopPortForward(
  input: PortForwardKey,
  listeners?: readonly {
    readonly host: PortForwardHost;
    readonly port: number;
    readonly pid: number | null;
  }[],
): Promise<void> {
  const bridge = window.desktopBridge?.portForwarding;
  if (!bridge || typeof bridge.stop !== "function") {
    throw new Error("Port forwarding is only available in the desktop application.");
  }

  try {
    if (listeners && listeners.length > 0) {
      await persistPortForwardExclusion(
        input.environmentId,
        input.remotePort,
        false,
        true,
      );
    }
    await bridge.stop(input);
    clearAutoForwardError(input.environmentId, input.remotePort);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : "Could not stop forwarding.";
    const failedListeners =
      listeners && listeners.length > 0
        ? listeners
        : [{ host: input.remoteHost, port: input.remotePort, pid: null }];
    for (const listener of failedListeners) {
      recordAutoForwardError(input.environmentId, listener, error);
    }
    throw cause;
  }
}

export function useForwardedPorts(): readonly ForwardedPort[] {
  return useAtomValue(forwardedPortsAtom);
}

export function useListeningPorts(environmentId: EnvironmentId): ListeningPortsState & {
  readonly refresh: () => void;
} {
  const state = useAtomValue(listeningPortsStateAtom(environmentId));
  const prepared = usePreparedConnection(environmentId);

  useEffect(() => {
    if (Option.isSome(prepared)) {
      void refreshListeningPorts(environmentId);
    }
  }, [environmentId, prepared]);

  return {
    ...state,
    refresh: () => {
      void refreshListeningPorts(environmentId);
    },
  };
}
