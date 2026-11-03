import type { ForwardedPort } from "@t3tools/contracts";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";

import { useEffect, useRef } from "react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  AuthTerminalOperateScope,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  forwardedPortsAtom,
  getAutoForwardExcludedPorts,
  getAutoForwardLifecycleGeneration,
  getAutoForwardState,
  getInFlightPorts,
  getTrackedEnvironmentIds,
  handlePortForwardConnectionRequest,
  isAutoForwardPortExcluded,
  isAutoForwardingEnabled,
  isPortForwardingAvailable,
  markInFlight,
  recordAutoForwardError,
  refreshListeningPorts,
  resetAutoForwardState,
  setAutoForwardState,
  startPortForward,
  stopPortForward,
} from "../../state/portForwarding";
import { isStartActionValid, planDiscoveryActions } from "../../state/portForwardingPolicy";
import { ensureClientSettingsHydrated, getClientSettings } from "../../hooks/useSettings";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { environmentPresentations } from "../../state/presentation";

function isDiscoveryEligible(
  environmentId: EnvironmentId,
  catalog: EnvironmentCatalogState,
): boolean {
  if (environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID) return false;
  if (!catalog.isReady) return false;
  const entry = catalog.entries.get(environmentId);
  if (!entry || !entry.enabled) return false;
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(environmentId),
  );
  if (presentation?.connection.phase !== "connected") return false;
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) return false;
  if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return false;
  return true;
}

function isAutoStartEligible(
  environmentId: EnvironmentId,
  catalog: EnvironmentCatalogState,
): boolean {
  if (!isDiscoveryEligible(environmentId, catalog)) return false;
  if (!isAutoForwardingEnabled(environmentId)) return false;
  return true;
}

function reconcileDisabledEnvironments(
  catalog: EnvironmentCatalogState,
  ports: readonly ForwardedPort[],
  bridge: NonNullable<typeof window.desktopBridge>["portForwarding"],
): void {
  if (!catalog.isReady || !bridge) {
    return;
  }
  const enabledLookup: Record<string, true> = Object.setPrototypeOf({}, null);
  for (const id of enabledEnvironmentIds(catalog)) {
    enabledLookup[id] = true;
  }
  for (const envId of getTrackedEnvironmentIds()) {
    if (!enabledLookup[envId]) {
      resetAutoForwardState(envId);
    }
  }
  if (ports.length === 0) {
    return;
  }
  for (const port of ports) {
    if (!enabledLookup[port.environmentId]) {
      void bridge
        .stop({
          environmentId: port.environmentId,
          remotePort: port.remotePort,
          remoteHost: port.remoteHost,
        })
        .catch(() => undefined);
    }
  }
}

/**
 * Global coordinator mounted at AppRoot.
 * Lives outside thread navigation so port tunnels remain alive across thread switches.
 */
export function PortForwardingCoordinator(): null {
  const currentPortsRef = useRef<readonly ForwardedPort[]>([]);

  useEffect(() => {
    if (!isPortForwardingAvailable()) {
      return;
    }

    const bridge = window.desktopBridge?.portForwarding;
    if (!bridge) {
      return;
    }

    let eventEpoch = 0;
    let isDisposed = false;
    const envPollTimers: Record<string, number | undefined> = Object.setPrototypeOf({}, null);
    const envInFlightPolls: Record<string, boolean> = Object.setPrototypeOf({}, null);
    const envPollGenerations: Record<string, number> = Object.setPrototypeOf({}, null);
    const envLastKnownPhase: Record<string, string | undefined> = Object.setPrototypeOf({}, null);
    const envPresentationUnsubscribes: Record<string, (() => void) | undefined> =
      Object.setPrototypeOf({}, null);

    const stopPollingForEnv = (envId: EnvironmentId) => {
      envPresentationUnsubscribes[envId]?.();
      delete envPresentationUnsubscribes[envId];
      delete envLastKnownPhase[envId];
      window.clearTimeout(envPollTimers[envId]);
      delete envPollTimers[envId];
      // Invalidate running cycle so its results are dropped and it does not reschedule
      envPollGenerations[envId] = (envPollGenerations[envId] ?? 0) + 1;
      resetAutoForwardState(envId);
    };

    // Independent per-environment discovery and auto-forwarding cycle
    const runEnvPollCycle = async (envId: EnvironmentId) => {
      if (isDisposed || envInFlightPolls[envId]) return;
      envInFlightPolls[envId] = true;
      const cycleToken = (envPollGenerations[envId] ?? 0) + 1;
      envPollGenerations[envId] = cycleToken;

      try {
        const initialCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
        const entry = initialCatalog.entries.get(envId);
        if (!initialCatalog.isReady || !entry?.enabled) {
          return;
        }

        if (!isDiscoveryEligible(envId, initialCatalog)) {
          // Do not reset state here; reset on real phase disconnect transition once
          return;
        }

        await ensureClientSettingsHydrated();
        const ports = await refreshListeningPorts(envId);
        if (isDisposed || envPollGenerations[envId] !== cycleToken || ports === null) {
          return;
        }

        // Re-read live catalog and eligibility after discovery fetch
        const postFetchCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
        if (!isDiscoveryEligible(envId, postFetchCatalog)) {
          return;
        }

        const autoStartEligible = isAutoStartEligible(envId, postFetchCatalog);
        const lifecycleToken = getAutoForwardLifecycleGeneration(envId);
        const currentForwards = appAtomRegistry.get(forwardedPortsAtom);

        const plan = planDiscoveryActions({
          state: getAutoForwardState(envId),
          environmentId: envId,
          isLocal: false,
          isConnected: true,
          isEnabled: true,
          hasOperateGrant: autoStartEligible,
          isAutoForwardEnabled: autoStartEligible,
          discoveredPorts: ports,
          forwardedPorts: currentForwards,
          autoForwardLimit: getClientSettings().portAutoForwardLimit,
          inFlightPorts: getInFlightPorts(envId),
          excludedPorts: getAutoForwardExcludedPorts(envId),
          lifecycleToken,
        });

        if (isDisposed || envPollGenerations[envId] !== cycleToken) {
          return;
        }

        setAutoForwardState(envId, plan.nextState);

        for (const action of plan.actions) {
          if (isDisposed || envPollGenerations[envId] !== cycleToken) break;

          if (action.type === "start") {
            const preStartCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
            const preStartLifecycle = getAutoForwardLifecycleGeneration(envId);
            if (
              !isAutoStartEligible(envId, preStartCatalog) ||
              isAutoForwardPortExcluded(action.environmentId, action.remotePort) ||
              !isStartActionValid(action, preStartLifecycle, isAutoForwardingEnabled(envId))
            ) {
              break;
            }

            markInFlight(envId, action.remotePort, true);
            try {
              await startPortForward({
                environmentId: action.environmentId,
                remotePort: action.remotePort,
                remoteHost: action.remoteHost,
                localPort: action.localPort,
                origin: action.origin,
              });

              // Re-check live eligibility and lifecycle token after start completes
              const postStartCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
              const postStartLifecycle = getAutoForwardLifecycleGeneration(action.environmentId);
              const isStillEligible =
                !isDisposed &&
                envPollGenerations[envId] === cycleToken &&
                postStartLifecycle === preStartLifecycle &&
                !isAutoForwardPortExcluded(action.environmentId, action.remotePort) &&
                isAutoStartEligible(action.environmentId, postStartCatalog);
              if (!isStillEligible) {
                await stopPortForward({
                  environmentId: action.environmentId,
                  remoteHost: action.remoteHost,
                  remotePort: action.remotePort,
                });
              }
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : "Auto-forward failed";
              recordAutoForwardError(
                envId,
                {
                  host: action.remoteHost,
                  port: action.remotePort,
                  pid: action.pid,
                },
                errorMessage,
              );
            } finally {
              markInFlight(envId, action.remotePort, false);
            }
          } else if (action.type === "stop") {
            // The listener behind this auto-forward exited. Skip it if the
            // user took the forward over (origin "user") since the scan.
            const stillAuto = appAtomRegistry
              .get(forwardedPortsAtom)
              .some(
                (forward) =>
                  forward.environmentId === action.environmentId &&
                  forward.remoteHost === action.remoteHost &&
                  forward.remotePort === action.remotePort &&
                  forward.origin === "auto",
              );
            if (stillAuto) {
              await stopPortForward({
                environmentId: action.environmentId,
                remoteHost: action.remoteHost,
                remotePort: action.remotePort,
              });
            }
          }
        }
      } catch {
        // Discovery errors handled inside refreshListeningPorts
      } finally {
        delete envInFlightPolls[envId];
        if (!isDisposed) {
          const latestCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
          if (latestCatalog.isReady && latestCatalog.entries.get(envId)?.enabled) {
            if (envPollTimers[envId] === undefined) {
              const delayMs = envPollGenerations[envId] === cycleToken ? 2500 : 100;
              envPollTimers[envId] = window.setTimeout(() => {
                delete envPollTimers[envId];
                void runEnvPollCycle(envId);
              }, delayMs);
            }
          }
        }
      }
    };

    const syncEnvironmentPollers = (catalog: EnvironmentCatalogState) => {
      if (!catalog.isReady) return;
      const enabledLookup: Record<string, true> = Object.setPrototypeOf({}, null);
      for (const id of enabledEnvironmentIds(catalog)) {
        enabledLookup[id] = true;
      }

      // Stop polling for environments that are no longer enabled
      for (const envId in envPresentationUnsubscribes) {
        if (!enabledLookup[envId]) {
          stopPollingForEnv(EnvironmentId.make(envId));
        }
      }
      for (const envId in envPollTimers) {
        if (!enabledLookup[envId]) {
          stopPollingForEnv(EnvironmentId.make(envId));
        }
      }

      // Start polling for eligible environments not yet scheduled
      for (const envId in enabledLookup) {
        if (envId === PRIMARY_LOCAL_ENVIRONMENT_ID) continue;
        const brandedId = EnvironmentId.make(envId);

        // Subscribe to live connection presentation transitions once per enabled environment
        if (envPresentationUnsubscribes[envId] === undefined) {
          const presentationAtom = environmentPresentations.presentationAtom(brandedId);
          const initialPresentation = appAtomRegistry.get(presentationAtom);
          envLastKnownPhase[envId] = initialPresentation?.connection.phase;

          envPresentationUnsubscribes[envId] = appAtomRegistry.subscribe(
            presentationAtom,
            (presentation) => {
              const currentPhase = presentation?.connection.phase;
              const previousPhase = envLastKnownPhase[envId];
              if (currentPhase === previousPhase) return;
              envLastKnownPhase[envId] = currentPhase;

              if (currentPhase === "connected" && previousPhase !== "connected") {
                // Connection entered 'connected': trigger first discovery immediately to capture baseline
                window.clearTimeout(envPollTimers[envId]);
                delete envPollTimers[envId];
                if (!envInFlightPolls[envId]) {
                  envPollTimers[envId] = window.setTimeout(() => {
                    delete envPollTimers[envId];
                    void runEnvPollCycle(brandedId);
                  }, 0);
                }
              } else if (currentPhase !== "connected" && previousPhase === "connected") {
                // Real phase disconnect transition: invalidate and reset state ONCE
                window.clearTimeout(envPollTimers[envId]);
                delete envPollTimers[envId];
                envPollGenerations[envId] = (envPollGenerations[envId] ?? 0) + 1;
                resetAutoForwardState(brandedId);
              }
            },
          );
        }

        if (envPollTimers[envId] === undefined && !envInFlightPolls[envId]) {
          const isCurrentlyConnected = envLastKnownPhase[envId] === "connected";
          // If already connected, run discovery immediately (0ms); otherwise wait 100ms
          const initialDelay = isCurrentlyConnected ? 0 : 100;
          envPollTimers[envId] = window.setTimeout(() => {
            delete envPollTimers[envId];
            void runEnvPollCycle(brandedId);
          }, initialDelay);
        }
      }
    };

    // 1. Subscribe to push updates first so no events are dropped during bootstrap.
    const unsubscribeChanged = bridge.onChanged((ports) => {
      if (isDisposed) return;
      eventEpoch++;
      currentPortsRef.current = ports;
      appAtomRegistry.set(forwardedPortsAtom, ports);
      reconcileDisabledEnvironments(
        appAtomRegistry.get(environmentCatalog.catalogValueAtom),
        ports,
        bridge,
      );
    });

    const unsubscribeRequest = bridge.onConnectionRequest((request) => {
      if (isDisposed) return;
      void handlePortForwardConnectionRequest(request);
    });

    // 2. Fetch initial list with generation guard: if an onChanged event already arrived, do not overwrite.
    void bridge
      .list()
      .then((ports) => {
        if (isDisposed) return;
        if (eventEpoch === 0) {
          currentPortsRef.current = ports;
          appAtomRegistry.set(forwardedPortsAtom, ports);
          const initialCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
          reconcileDisabledEnvironments(initialCatalog, ports, bridge);
        }
      })
      .catch(() => undefined);

    // 3. Watch environment catalog: when an environment is disabled or removed,
    // reconcile active listeners and sync independent pollers.
    // Subscribe first to capture subsequent updates, then immediately sync with current catalog.
    const unsubscribeCatalog = appAtomRegistry.subscribe(
      environmentCatalog.catalogValueAtom,
      (catalog) => {
        if (isDisposed) return;
        reconcileDisabledEnvironments(catalog, currentPortsRef.current, bridge);
        syncEnvironmentPollers(catalog);
      },
    );

    const initialCatalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    reconcileDisabledEnvironments(initialCatalog, currentPortsRef.current, bridge);
    syncEnvironmentPollers(initialCatalog);

    return () => {
      isDisposed = true;
      for (const envId in envPresentationUnsubscribes) {
        envPresentationUnsubscribes[envId]?.();
        delete envPresentationUnsubscribes[envId];
      }
      for (const envId in envPollTimers) {
        window.clearTimeout(envPollTimers[envId]);
        delete envPollTimers[envId];
      }
      unsubscribeChanged();
      unsubscribeRequest();
      unsubscribeCatalog();
    };
  }, []);

  return null;
}
