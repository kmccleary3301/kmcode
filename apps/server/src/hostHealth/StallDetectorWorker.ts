// @effect-diagnostics globalDate:off -- Stall timing must continue while the main-thread Effect clock is stalled.
// @effect-diagnostics globalTimers:off -- Polling runs on the worker thread, outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This worker reads Linux procfs for the stalled main thread.
import * as NodeFS from "node:fs/promises";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeWorkerThreads from "node:worker_threads";

import { parsePressure, parseProcStat } from "./Proc.ts";
import { advanceStallState, initialStallMachineState } from "./StallState.ts";
import type { StallDetectorMessage } from "./StallDetector.ts";

const MAIN_THREAD_TASK_PATH = `/proc/${process.pid}/task/${process.pid}`;

const POLL_INTERVAL_MS = 250;
const workerData: unknown = NodeWorkerThreads.workerData;
if (
  typeof workerData !== "object" ||
  workerData === null ||
  !("heartbeatBuffer" in workerData) ||
  !(workerData.heartbeatBuffer instanceof SharedArrayBuffer)
) {
  throw new TypeError("Host health worker requires a shared heartbeat buffer.");
}
const heartbeat = new Int32Array(workerData.heartbeatBuffer);
const port = NodeWorkerThreads.parentPort;
let state = initialStallMachineState;
let polling = false;

async function readProcText(path: string): Promise<string | null> {
  try {
    return await NodeFS.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function poll(): Promise<void> {
  if (polling || !port) return;
  polling = true;
  try {
    const monotonicNowMs = NodePerfHooks.performance.now();
    const wallNowMs = Date.now();
    const currentHeartbeat = Atomics.load(heartbeat, 0);
    const shouldReadPressure =
      state.heartbeat === currentHeartbeat &&
      state.active === null &&
      state.lastHeartbeatAtMs !== null &&
      monotonicNowMs - state.lastHeartbeatAtMs > 1_000;
    const [statText, wchanText, pressureText] = await Promise.all([
      readProcText(`${MAIN_THREAD_TASK_PATH}/stat`),
      readProcText(`${MAIN_THREAD_TASK_PATH}/wchan`),
      shouldReadPressure ? readProcText("/proc/pressure/io") : Promise.resolve(null),
    ]);
    const taskStat = statText === null ? null : parseProcStat(statText);
    const pressure = pressureText === null ? null : parsePressure(pressureText);
    const transition = advanceStallState(state, {
      heartbeat: currentHeartbeat,
      monotonicNowMs,
      wallNowMs,
      taskState: taskStat?.state ?? null,
      wchan: wchanText?.trim() || null,
      ioPressureSomeAvg10Percent: pressure?.someAvg10Percent ?? null,
    });
    state = transition.state;
    if (transition.started) {
      port.postMessage({ type: "started", stall: transition.started } satisfies StallDetectorMessage);
    }
    if (transition.completed) {
      port.postMessage({ type: "completed", stall: transition.completed } satisfies StallDetectorMessage);
    }
  } finally {
    polling = false;
  }
}

setInterval(() => void poll(), POLL_INTERVAL_MS);
void poll();
