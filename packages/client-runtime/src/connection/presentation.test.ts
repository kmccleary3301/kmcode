import { EnvironmentId, type ServerHostHealthSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  diagnoseEnvironmentConnection,
  environmentMcpUrl,
  connectionStatusText,
  connectionStatusTitle,
  presentEnvironmentConnection,
  presentConnectionState,
  type EnvironmentHostHealthObservation,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("labels a blocked protocol as unsupported", () => {
    const connection = presentConnectionState(
      supervisorState({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Update your app.",
        }),
      }),
    );
    expect(connection.phase).toBe("unsupported");
    expect(connection.error).toBe("Update your app.");
    expect(connectionStatusText(connection)).toBe("Client not supported");
  });

  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it("copies the MCP address of the route this device is connected over", () => {
    const route = (connectionId: string, httpBaseUrl: string): ConnectionRoute => {
      const target = new BearerConnectionTarget({ ...TARGET, connectionId });
      return {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId,
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
      };
    };
    const lan = route("lan", "http://192.168.4.53:3773/");
    const tailnet = route("tailnet", "http://100.115.1.44:3773/");
    const serve = route("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    // Not connected: the preferred route, plain http or not.
    expect(environmentMcpUrl({ entry })).toBe("http://192.168.4.53:3773/mcp");
  });

  it("passes over routes without an address of their own", () => {
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: relay,
      profile: Option.none(),
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };

    // Relay discovery has not reported the tunnel address yet.
    expect(environmentMcpUrl({ entry, connectedTarget: relay })).toBe(
      "https://environment.example.test/mcp",
    );
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: relay,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
    });
  });

  it("combines reconnect progress with the latest failure", () => {
    const connection = {
      phase: "reconnecting",
      error: "Relay request timed out.",
      traceId: "trace-retry",
    } as const;
    expect(connectionStatusText(connection)).toBe(
      "Failed to connect. Reconnecting... Reason: Relay request timed out.",
    );
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});

const BASE_HOST_HEALTH_SNAPSHOT: ServerHostHealthSnapshot = {
  sampledAt: 10_000,
  sampleWindowMs: 5_000,
  platform: "linux",
  serverInstanceId: "server-1",
  serverStartedAt: 100,
  hostBootId: "boot-1",
  loadAverage: [1, 1, 1],
  memoryAvailableBytes: 1_000_000,
  swapUsedBytes: 0,
  pressure: {
    io: { someAvg10Percent: 0, fullAvg10Percent: 0 },
    memory: { someAvg10Percent: 0, fullAvg10Percent: 0 },
    cpu: { someAvg10Percent: 0, fullAvg10Percent: 0 },
  },
  eventLoopDelayP99Ms: 10,
  eventLoopDelayMaxMs: 20,
  diskWriters: [],
  diskReaders: [],
  dStateTasks: 0,
  currentStall: null,
  completedStalls: [],
};

function hostHealthObservation(
  snapshot: ServerHostHealthSnapshot,
  previousSnapshot: ServerHostHealthSnapshot | null = null,
): EnvironmentHostHealthObservation {
  return { snapshot, previousSnapshot, receivedAt: 10_000 };
}

describe("connection diagnosis", () => {
  it("prioritizes device-offline over transport and stalled-server signals", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      browserOnline: false,
      desktopTunnelState: "stopped",
      state: supervisorState({
        network: "offline",
        phase: "backoff",
        lastFailureConnection: "open",
        lastFailure: new ConnectionTransientError({
          reason: "timeout",
          detail: "The WebSocket stopped responding.",
        }),
      }),
      hostHealth: hostHealthObservation({
        ...BASE_HOST_HEALTH_SNAPSHOT,
        currentStall: {
          startedAt: 9_000,
          durationMs: 1_000,
          state: "D",
          wchan: "jbd2_log_wait_for_space",
          ioPressureSomeAvg10Percent: 70,
        },
      }),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("offline");
  });

  it("prioritizes transport failure before WebSocket open over a stall", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({
        phase: "backoff",
        lastFailureConnection: "before-open",
        lastFailure: new ConnectionTransientError({
          reason: "network",
          detail: "The WebSocket stopped responding.",
        }),
      }),
      hostHealth: hostHealthObservation({
        ...BASE_HOST_HEALTH_SNAPSHOT,
        currentStall: {
          startedAt: 9_000,
          durationMs: 1_000,
          state: "D",
          wchan: "jbd2_log_wait_for_space",
          ioPressureSomeAvg10Percent: 70,
        },
      }),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("transport");
  });

  it("classifies a failure after open as an unresponsive server", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({
        phase: "backoff",
        lastFailureConnection: "open",
        lastFailure: new ConnectionTransientError({
          reason: "timeout",
          detail: "The WebSocket stopped responding.",
        }),
      }),
      hostHealth: hostHealthObservation(BASE_HOST_HEALTH_SNAPSHOT),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("server-unresponsive");
  });

  it("detects a changed host boot id after reconnect", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({ phase: "connected", stage: null }),
      hostHealth: hostHealthObservation(
        {
          ...BASE_HOST_HEALTH_SNAPSHOT,
          hostBootId: "boot-2",
          serverInstanceId: "server-2",
        },
        BASE_HOST_HEALTH_SNAPSHOT,
      ),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("host-rebooted");
  });

  it("detects a changed server instance id after reconnect", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({ phase: "connected", stage: null }),
      hostHealth: hostHealthObservation(
        { ...BASE_HOST_HEALTH_SNAPSHOT, serverInstanceId: "server-2" },
        BASE_HOST_HEALTH_SNAPSHOT,
      ),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("server-restarted");
  });

  it("reports a newly completed main-thread stall", () => {
    const previous = BASE_HOST_HEALTH_SNAPSHOT;
    const current = {
      ...BASE_HOST_HEALTH_SNAPSHOT,
      pressure: {
        io: { someAvg10Percent: 50, fullAvg10Percent: 20 },
        memory: { someAvg10Percent: 0, fullAvg10Percent: 0 },
        cpu: { someAvg10Percent: 0, fullAvg10Percent: 0 },
      },
      eventLoopDelayP99Ms: 1_200,
      completedStalls: [
        {
          startedAt: 6_000,
          durationMs: 2_500,
          state: "D",
          wchan: "jbd2_log_wait_for_space",
          ioPressureSomeAvg10Percent: 72,
        },
      ],
    };
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({ phase: "connected", stage: null }),
      hostHealth: hostHealthObservation(current, previous),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("stall");
  });

  it("classifies a stopped desktop SSH forward as transport trouble", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({ phase: "connecting" }),
      desktopTunnelState: "stopped",
      now: 10_000,
    });
    expect(diagnosis.category).toBe("transport");
  });

  it("treats a stale health beacon on an open socket as an unresponsive server", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({ phase: "connected", stage: null }),
      hostHealth: {
        snapshot: BASE_HOST_HEALTH_SNAPSHOT,
        previousSnapshot: null,
        receivedAt: 0,
      },
      now: 20_000,
    });
    expect(diagnosis.category).toBe("server-unresponsive");
  });

  it("flags pressure while the connection remains healthy", () => {
    const diagnosis = diagnoseEnvironmentConnection({
      hostLabel: "km-dev.local",
      state: supervisorState({ phase: "connected", stage: null }),
      hostHealth: hostHealthObservation({
        ...BASE_HOST_HEALTH_SNAPSHOT,
        pressure: {
          ...BASE_HOST_HEALTH_SNAPSHOT.pressure,
          io: { someAvg10Percent: 41, fullAvg10Percent: 10 },
        },
      }),
      now: 10_000,
    });
    expect(diagnosis.category).toBe("pressure");
  });
});
