import type { EnvironmentId, ForwardedPort, ListeningPort } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AutoForwardState,
  type PlanDiscoveryParams,
  type PlanDiscoveryResult,
  absorbListenersIntoBaseline,
  clearAutoForwardSuppressionAndErrors,
  createInitialAutoForwardState,
  deduplicateListeningPortsByPort,
  handleToggleAutoForward,
  isStartActionValid,
  listenerIdentityKey,
  planDiscoveryActions,
  recordAutoForwardFailure,
  recordUserStop,
  suppressedPortsForEnvironment,
} from "./portForwardingPolicy.ts";

const ENV_REMOTE = "env-remote" as EnvironmentId;
const ENV_LOCAL = "local" as EnvironmentId;

function makeListeningPort(
  port: number,
  host: "127.0.0.1" | "localhost" | "::1" = "127.0.0.1",
  pid: number | null = 1000,
  processName: string | null = "node",
): ListeningPort {
  return { port, host, pid, processName };
}

function makeForwardedPort(
  port: number,
  origin: "user" | "auto" = "auto",
  environmentId: EnvironmentId = ENV_REMOTE,
): ForwardedPort {
  return {
    environmentId,
    remotePort: port,
    remoteHost: "127.0.0.1",
    localPort: port,
    localAddress: `127.0.0.1:${port}`,
    origin,
    status: "listening",
    activeConnections: 0,
    error: null,
  };
}

type ScanOverrides = Partial<Omit<PlanDiscoveryParams, "state">>;

/** One discovery scan of a connected remote environment with auto-forwarding on. */
function scan(state: AutoForwardState, overrides: ScanOverrides = {}): PlanDiscoveryResult {
  return planDiscoveryActions({
    state,
    environmentId: ENV_REMOTE,
    isLocal: false,
    isConnected: true,
    isEnabled: true,
    hasOperateGrant: true,
    isAutoForwardEnabled: true,
    discoveredPorts: [],
    forwardedPorts: [],
    autoForwardLimit: 100,
    ...overrides,
  });
}

/** Two identical scans: the first sees new listeners, the second may forward them. */
function scanTwice(state: AutoForwardState, overrides: ScanOverrides = {}): PlanDiscoveryResult {
  return scan(scan(state, overrides).nextState, overrides);
}

/** State after the first scan of a connection, whose listeners count as pre-existing. */
function baseline(discoveredPorts: readonly ListeningPort[] = []): AutoForwardState {
  return scan(createInitialAutoForwardState(), { discoveredPorts }).nextState;
}

describe("port forwarding policy transitions", () => {
  it("baseline/new listen: ignores initial listeners and forwards a new listener once it persists", () => {
    const initialPorts = [
      makeListeningPort(3000, "127.0.0.1", 100),
      makeListeningPort(8080, "127.0.0.1", 101),
    ];
    const initialPlan = scan(createInitialAutoForwardState(), {
      discoveredPorts: initialPorts,
      lifecycleToken: 1,
    });
    expect(initialPlan.actions).toEqual([]);
    expect(initialPlan.nextState.baselineEstablished).toBe(true);
    expect(Object.keys(initialPlan.nextState.baselineIdentities)).toHaveLength(2);

    const nextPorts = [...initialPorts, makeListeningPort(5173, "127.0.0.1", 200, "vite")];
    const firstSighting = scan(initialPlan.nextState, {
      discoveredPorts: nextPorts,
      lifecycleToken: 1,
    });
    expect(firstSighting.actions).toEqual([]);

    const secondSighting = scan(firstSighting.nextState, {
      discoveredPorts: nextPorts,
      lifecycleToken: 1,
    });
    expect(secondSighting.actions).toEqual([
      {
        type: "start",
        environmentId: ENV_REMOTE,
        remotePort: 5173,
        remoteHost: "127.0.0.1",
        localPort: 5173,
        origin: "auto",
        pid: 200,
        processName: "vite",
        lifecycleToken: 1,
      },
    ]);
  });

  it("a listener that exits before a second scan sees it is never forwarded", () => {
    let state = baseline();
    // Short-lived servers on fresh ports, each alive for a single scan.
    for (const port of [20101, 20150, 41234, 20320]) {
      const plan = scan(state, { discoveredPorts: [makeListeningPort(port, "127.0.0.1", port)] });
      expect(plan.actions).toEqual([]);
      state = plan.nextState;
    }
    expect(scan(state).actions).toEqual([]);
  });

  it("a restarted listener (new pid) must persist again before it is forwarded", () => {
    const first = scan(baseline(), { discoveredPorts: [makeListeningPort(5173, "127.0.0.1", 1)] });
    const restarted = scan(first.nextState, {
      discoveredPorts: [makeListeningPort(5173, "127.0.0.1", 2)],
    });
    expect(restarted.actions).toEqual([]);
    const settled = scan(restarted.nextState, {
      discoveredPorts: [makeListeningPort(5173, "127.0.0.1", 2)],
    });
    expect(settled.actions).toMatchObject([{ type: "start", remotePort: 5173, pid: 2 }]);
  });

  it("closes an auto-forward when nothing listens on its port any more, but never a user forward", () => {
    const listener = makeListeningPort(3000, "127.0.0.1", 100);
    const forwards = [makeForwardedPort(3000, "auto"), makeForwardedPort(1455, "user")];

    const stillListening = scan(baseline(), {
      discoveredPorts: [listener],
      forwardedPorts: forwards,
    });
    expect(stillListening.actions).toEqual([]);

    // Same port served by a different process still counts as listening.
    const replaced = scan(stillListening.nextState, {
      discoveredPorts: [makeListeningPort(3000, "::1", 999)],
      forwardedPorts: forwards,
    });
    expect(replaced.actions).toEqual([]);

    const exited = scan(replaced.nextState, { forwardedPorts: forwards });
    expect(exited.actions).toEqual([
      { type: "stop", environmentId: ENV_REMOTE, remotePort: 3000, remoteHost: "127.0.0.1" },
    ]);
  });

  it("keeps an auto-forward whose start is still in flight", () => {
    const plan = scan(baseline(), {
      forwardedPorts: [makeForwardedPort(3000, "auto")],
      inFlightPorts: { 3000: true },
    });
    expect(plan.actions).toEqual([]);
  });

  it("only closes auto-forwards that belong to the scanned environment", () => {
    const plan = scan(baseline(), {
      forwardedPorts: [makeForwardedPort(3000, "auto", "env-other" as EnvironmentId)],
    });
    expect(plan.actions).toEqual([]);
  });

  it("caps auto-forwards per environment, counting live forwards and in-flight starts", () => {
    const listeners = [4001, 4002, 4003, 4004].map((port) =>
      makeListeningPort(port, "127.0.0.1", port),
    );
    const capped = scanTwice(baseline(), {
      discoveredPorts: [makeListeningPort(3000, "127.0.0.1", 1), ...listeners],
      forwardedPorts: [makeForwardedPort(3000, "auto"), makeForwardedPort(8080, "user")],
      inFlightPorts: { 4001: true },
      autoForwardLimit: 3,
    });
    // 3000 is live and 4001 is starting, so one slot remains; the user forward doesn't count.
    expect(capped.actions).toMatchObject([{ type: "start", remotePort: 4002 }]);

    const full = scan(capped.nextState, {
      discoveredPorts: [makeListeningPort(3000, "127.0.0.1", 1), ...listeners],
      forwardedPorts: [
        makeForwardedPort(3000, "auto"),
        makeForwardedPort(4001, "auto"),
        makeForwardedPort(4002, "auto"),
      ],
      autoForwardLimit: 3,
    });
    expect(full.actions).toEqual([]);

    // When 3000's server exits its forward closes and the freed slot goes to a waiting listener.
    const freed = scan(full.nextState, {
      discoveredPorts: listeners,
      forwardedPorts: [
        makeForwardedPort(3000, "auto"),
        makeForwardedPort(4001, "auto"),
        makeForwardedPort(4002, "auto"),
      ],
      autoForwardLimit: 3,
    });
    expect(freed.actions).toMatchObject([
      { type: "stop", remotePort: 3000 },
      { type: "start", remotePort: 4003 },
    ]);
  });

  it("after stop-all, live listeners stay unforwarded while later listeners still forward", () => {
    const live = [makeListeningPort(3000, "127.0.0.1", 1), makeListeningPort(5173, "::1", 2)];
    const beforeStop = scan(baseline(), { discoveredPorts: live }).nextState;

    const afterStop = absorbListenersIntoBaseline(
      recordAutoForwardFailure(beforeStop, live[0]!, "bind failed"),
      live,
    );
    expect(afterStop.failedErrors).toEqual({});
    expect(scanTwice(afterStop, { discoveredPorts: live }).actions).toEqual([]);

    const later = makeListeningPort(8000, "127.0.0.1", 3);
    expect(scanTwice(afterStop, { discoveredPorts: [...live, later] }).actions).toMatchObject([
      { type: "start", remotePort: 8000 },
    ]);

    // A connection that never finished its first scan gets a baseline too.
    const fresh = absorbListenersIntoBaseline(createInitialAutoForwardState(), live);
    expect(fresh.baselineEstablished).toBe(true);
    expect(scanTwice(fresh, { discoveredPorts: live }).actions).toEqual([]);
  });

  it("stop exclusions survive PID changes, disappearance, reconnect, and explicit Forward", () => {
    const listener = makeListeningPort(5173, "127.0.0.1", 1234, "node");
    const excludedPorts = suppressedPortsForEnvironment(
      [{ environmentId: ENV_REMOTE, remotePort: listener.port, hidden: false }],
      ENV_REMOTE,
    );

    const state = recordUserStop(baseline(), [listener]);
    const restartListener = makeListeningPort(5173, "127.0.0.1", 5678, "node");
    const restartedPlan = scanTwice(state, {
      discoveredPorts: [restartListener],
      excludedPorts,
      lifecycleToken: 1,
    });
    expect(restartedPlan.actions).toEqual([]);

    const disappearedPlan = scan(restartedPlan.nextState, { excludedPorts });
    const reappearedPlan = scanTwice(disappearedPlan.nextState, {
      discoveredPorts: [makeListeningPort(5173, "127.0.0.1", 6789, "node")],
      excludedPorts,
      lifecycleToken: 1,
    });
    expect(reappearedPlan.actions).toEqual([]);

    // A new renderer/coordinator starts with empty in-memory policy state.
    const reconnectPlan = scanTwice(baseline(), {
      discoveredPorts: [makeListeningPort(5173, "127.0.0.1", 7890, "node")],
      excludedPorts,
      lifecycleToken: 2,
    });
    expect(reconnectPlan.actions).toEqual([]);

    const explicitForwardState = clearAutoForwardSuppressionAndErrors(
      reconnectPlan.nextState,
      5173,
    );
    const explicitForwardPlan = scanTwice(explicitForwardState, {
      discoveredPorts: [makeListeningPort(5173, "127.0.0.1", 7890, "node")],
      excludedPorts: {},
      lifecycleToken: 2,
    });
    expect(explicitForwardPlan.actions).toMatchObject([
      { type: "start", remotePort: 5173, origin: "auto" },
    ]);
  });

  it("dual-stack stop blocks both address families after a listener PID changes", () => {
    const ipv4 = makeListeningPort(3000, "127.0.0.1", 100, "node");
    const ipv6 = makeListeningPort(3000, "::1", 100, "node");

    // Dual-stack listen forwards IPv4
    const startPlan = scanTwice(baseline(), { discoveredPorts: [ipv4, ipv6], lifecycleToken: 1 });
    expect(startPlan.actions).toHaveLength(1);
    expect(startPlan.actions[0]?.remoteHost).toBe("127.0.0.1");

    // Stopping forward captures and suppresses BOTH entries on port 3000
    const state = recordUserStop(startPlan.nextState, [ipv4, ipv6]);

    // Next scans: neither IPv4 nor IPv6 is auto-forwarded (no bounce to IPv6)
    const nextScanPlan = scanTwice(state, { discoveredPorts: [ipv4, ipv6], lifecycleToken: 1 });
    expect(nextScanPlan.actions).toEqual([]);

    // Listener identity changed, but the stopped port remains excluded.
    const restartPlan = scanTwice(nextScanPlan.nextState, {
      discoveredPorts: [
        makeListeningPort(3000, "127.0.0.1", 200, "node"),
        makeListeningPort(3000, "::1", 200, "node"),
      ],
      lifecycleToken: 1,
    });
    expect(restartPlan.actions).toEqual([]);
  });

  it("disable->reenable while start is pending invalidates action via lifecycle token", () => {
    let state = baseline();
    const listener = makeListeningPort(3000, "127.0.0.1", 100);

    // Scan planned in cycle with lifecycleToken 1
    const plan = scanTwice(state, { discoveredPorts: [listener], lifecycleToken: 1 });
    expect(plan.actions).toHaveLength(1);
    const startAction = plan.actions[0]!;

    // Before any toggle: valid
    expect(isStartActionValid(startAction, 1, true)).toBe(true);

    // Toggle off: lifecycle token becomes 2
    state = handleToggleAutoForward(state, false, [], ENV_REMOTE).nextState;
    expect(isStartActionValid(startAction, 2, false)).toBe(false);

    // Toggle back on: lifecycle token becomes 3; the pending start from cycle 1 stays invalid.
    state = handleToggleAutoForward(state, true, [], ENV_REMOTE).nextState;
    expect(isStartActionValid(startAction, 3, true)).toBe(false);

    // A fresh action planned under current token 3 is valid
    const freshPlan = scanTwice(state, { discoveredPorts: [listener], lifecycleToken: 3 });
    expect(freshPlan.actions).toHaveLength(1);
    expect(isStartActionValid(freshPlan.actions[0]!, 3, true)).toBe(true);
  });

  it("auto-forward toggle off absorbs listeners into baseline so they are not exposed on reenable", () => {
    let state = handleToggleAutoForward(baseline(), false, [], ENV_REMOTE).nextState;

    // While toggled off, discovery scan discovers a port (e.g. 4000)
    const listener4000 = makeListeningPort(4000, "127.0.0.1", 100);
    const offPlan = scan(state, {
      hasOperateGrant: false,
      isAutoForwardEnabled: false,
      discoveredPorts: [listener4000],
    });
    expect(offPlan.actions).toEqual([]);
    expect(
      offPlan.nextState.baselineIdentities[
        listenerIdentityKey(listener4000.host, listener4000.port, listener4000.pid)
      ],
    ).toBe(true);

    state = handleToggleAutoForward(offPlan.nextState, true, [], ENV_REMOTE).nextState;

    // Port 4000 still running and a NEW port 5000: only 5000 is forwarded.
    const listener5000 = makeListeningPort(5000, "127.0.0.1", 200);
    const reenabledPlan = scanTwice(state, {
      discoveredPorts: [listener4000, listener5000],
      lifecycleToken: 4,
    });
    expect(reenabledPlan.actions).toEqual([
      {
        type: "start",
        environmentId: ENV_REMOTE,
        remotePort: 5000,
        remoteHost: "127.0.0.1",
        localPort: 5000,
        origin: "auto",
        pid: 200,
        processName: "node",
        lifecycleToken: 4,
      },
    ]);
  });

  it("repeated scan no duplicate/start spam: in-flight and active forwards are not re-triggered", () => {
    const listener = makeListeningPort(3000, "127.0.0.1", 100);

    const inFlightPlan = scanTwice(baseline(), {
      discoveredPorts: [listener],
      inFlightPorts: { 3000: true },
    });
    expect(inFlightPlan.actions).toEqual([]);

    const activePlan = scanTwice(baseline(), {
      discoveredPorts: [listener],
      forwardedPorts: [makeForwardedPort(3000, "auto")],
    });
    expect(activePlan.actions).toEqual([]);
  });

  it("conflicts/errors: failed ports record exact identity errors and are not spammed until cleared", () => {
    const listener = makeListeningPort(3000, "127.0.0.1", 100);
    const identity = listenerIdentityKey(listener.host, listener.port, listener.pid);

    let state = recordAutoForwardFailure(baseline(), listener, "Port 3000 already in use");
    expect(state.failedErrors[identity]).toBe("Port 3000 already in use");

    // Scans with listener present: no start action (no spam)
    const scanPlan = scanTwice(state, { discoveredPorts: [listener] });
    expect(scanPlan.actions).toEqual([]);
    expect(scanPlan.nextState.failedErrors[identity]).toBe("Port 3000 already in use");

    // When process exits, error is pruned
    const exitPlan = scan(scanPlan.nextState);
    expect(exitPlan.nextState.failedErrors[identity]).toBeUndefined();

    // User manual retry clears suppression and failure; the listener is forwarded again.
    state = clearAutoForwardSuppressionAndErrors(scanPlan.nextState, 3000);
    expect(state.failedErrors[identity]).toBeUndefined();
    expect(scanTwice(state, { discoveredPorts: [listener] }).actions).toHaveLength(1);
  });

  it("disabled/offline stale scan: resets state on disconnect and ignores primary local", () => {
    const state = createInitialAutoForwardState();

    // Toggle off: stops auto-origin forwards only
    const toggleOff = handleToggleAutoForward(
      state,
      false,
      [makeForwardedPort(3000, "auto"), makeForwardedPort(8080, "user")],
      ENV_REMOTE,
    );
    expect(toggleOff.actions).toEqual([
      { type: "stop", environmentId: ENV_REMOTE, remotePort: 3000, remoteHost: "127.0.0.1" },
    ]);

    // Offline / disconnected: resets state and emits nothing
    const disconnectedPlan = scan(state, {
      isConnected: false,
      discoveredPorts: [makeListeningPort(3000)],
    });
    expect(disconnectedPlan.actions).toEqual([]);
    expect(disconnectedPlan.nextState.baselineEstablished).toBe(false);

    // Primary local environment is never auto-forwarded
    const localPlan = scanTwice(state, {
      environmentId: ENV_LOCAL,
      isLocal: true,
      discoveredPorts: [makeListeningPort(3000)],
    });
    expect(localPlan.actions).toEqual([]);
  });

  it("IPv4/IPv6 dedupe: chooses single loopback target without duplicate binds", () => {
    const deduplicated = deduplicateListeningPortsByPort([
      makeListeningPort(3000, "::1", 100),
      makeListeningPort(3000, "127.0.0.1", 100),
      makeListeningPort(3000, "localhost", 100),
      makeListeningPort(8080, "::1", 101),
    ]);
    expect(deduplicated).toHaveLength(2);
    expect(deduplicated.find((p) => p.port === 3000)?.host).toBe("127.0.0.1");
    expect(deduplicated.find((p) => p.port === 8080)?.host).toBe("::1");

    const dualStackPlan = scanTwice(baseline(), {
      discoveredPorts: [
        makeListeningPort(3000, "::1", 500, "node"),
        makeListeningPort(3000, "127.0.0.1", 500, "node"),
      ],
      lifecycleToken: 1,
    });
    expect(dualStackPlan.actions).toEqual([
      {
        type: "start",
        environmentId: ENV_REMOTE,
        remotePort: 3000,
        remoteHost: "127.0.0.1",
        localPort: 3000,
        origin: "auto",
        pid: 500,
        processName: "node",
        lifecycleToken: 1,
      },
    ]);
  });

  it("reconnect baseline: existing listeners stay unforwarded after reconnect, new ones forward", () => {
    const systemPorts = [
      makeListeningPort(22, "127.0.0.1", 10),
      makeListeningPort(3000, "127.0.0.1", 100),
    ];

    const connectPlan = scan(createInitialAutoForwardState(), {
      discoveredPorts: systemPorts,
      lifecycleToken: 1,
    });
    expect(connectPlan.actions).toEqual([]);
    expect(connectPlan.nextState.baselineEstablished).toBe(true);

    // User starts login process listening on 1455
    const loginPlan = scanTwice(connectPlan.nextState, {
      discoveredPorts: [...systemPorts, makeListeningPort(1455, "127.0.0.1", 200, "node")],
      lifecycleToken: 1,
    });
    expect(loginPlan.actions).toMatchObject([{ type: "start", remotePort: 1455 }]);

    // Disconnect resets the baseline
    const disconnectPlan = scan(loginPlan.nextState, {
      isConnected: false,
      discoveredPorts: systemPorts,
      lifecycleToken: 2,
    });
    expect(disconnectPlan.actions).toEqual([]);
    expect(disconnectPlan.nextState.baselineEstablished).toBe(false);

    // Reconnect: first scan establishes a safe baseline again
    const reconnectPlan = scan(disconnectPlan.nextState, {
      discoveredPorts: systemPorts,
      lifecycleToken: 3,
    });
    expect(reconnectPlan.actions).toEqual([]);
    expect(reconnectPlan.nextState.baselineEstablished).toBe(true);

    // A new listener after reconnect is auto-forwarded
    const subsequentPlan = scanTwice(reconnectPlan.nextState, {
      discoveredPorts: [...systemPorts, makeListeningPort(8080, "127.0.0.1", 300, "node")],
      lifecycleToken: 3,
    });
    expect(subsequentPlan.actions).toMatchObject([{ type: "start", remotePort: 8080 }]);
  });
});
