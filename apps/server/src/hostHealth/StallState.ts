import type { ServerHostHealthSnapshot } from "@t3tools/contracts";

export const STALL_THRESHOLD_MS = 1_000;

export type HostHealthStall = NonNullable<ServerHostHealthSnapshot["currentStall"]>;

export interface StallMachineState {
  readonly heartbeat: number | null;
  readonly lastHeartbeatAtMs: number | null;
  readonly lastHeartbeatWallTimeMs: number | null;
  readonly active: HostHealthStall | null;
}

export interface StallObservation {
  readonly heartbeat: number;
  readonly monotonicNowMs: number;
  readonly wallNowMs: number;
  readonly taskState: string | null;
  readonly wchan: string | null;
  readonly ioPressureSomeAvg10Percent: number | null;
}

export interface StallTransition {
  readonly state: StallMachineState;
  readonly started: HostHealthStall | null;
  readonly completed: HostHealthStall | null;
}

export const initialStallMachineState: StallMachineState = {
  heartbeat: null,
  lastHeartbeatAtMs: null,
  lastHeartbeatWallTimeMs: null,
  active: null,
};

export function advanceStallState(
  state: StallMachineState,
  observation: StallObservation,
): StallTransition {
  const { heartbeat, monotonicNowMs, wallNowMs } = observation;
  if (state.heartbeat === null || state.heartbeat !== heartbeat) {
    const completed =
      state.active === null
        ? null
        : {
            ...state.active,
            durationMs: Math.max(0, wallNowMs - state.active.startedAt),
          };
    return {
      state: {
        heartbeat,
        lastHeartbeatAtMs: monotonicNowMs,
        lastHeartbeatWallTimeMs: wallNowMs,
        active: null,
      },
      started: null,
      completed,
    };
  }

  if (state.active) {
    return {
      state: {
        ...state,
        active: {
          ...state.active,
          durationMs: Math.max(0, wallNowMs - state.active.startedAt),
        },
      },
      started: null,
      completed: null,
    };
  }

  if (
    state.lastHeartbeatAtMs === null ||
    monotonicNowMs - state.lastHeartbeatAtMs <= STALL_THRESHOLD_MS
  ) {
    return { state, started: null, completed: null };
  }

  const startedAtMs = state.lastHeartbeatWallTimeMs ?? wallNowMs;
  const started: HostHealthStall = {
    startedAt: startedAtMs,
    durationMs: Math.max(0, wallNowMs - startedAtMs),
    state: observation.taskState,
    wchan: observation.wchan,
    ioPressureSomeAvg10Percent: observation.ioPressureSomeAvg10Percent,
  };
  return {
    state: { ...state, active: started },
    started,
    completed: null,
  };
}
