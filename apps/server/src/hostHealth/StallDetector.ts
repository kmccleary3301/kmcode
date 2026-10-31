// @effect-diagnostics globalTimers:off -- The main-thread heartbeat must run independently of the Effect sampler fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This module owns the Linux stall-detection worker.
import * as NodeWorkerThreads from "node:worker_threads";

import type { HostHealthStall } from "./StallState.ts";

const HEARTBEAT_INTERVAL_MS = 250;

export type StallDetectorMessage =
  | { readonly type: "started"; readonly stall: HostHealthStall }
  | { readonly type: "completed"; readonly stall: HostHealthStall };

export interface RunningStallDetector {
  readonly close: () => Promise<void>;
}

export function startStallDetector(
  onStall: (message: StallDetectorMessage) => void,
): RunningStallDetector {
  const heartbeatBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const heartbeat = new Int32Array(heartbeatBuffer);
  const worker = new NodeWorkerThreads.Worker(
    new URL("./StallDetectorWorker.ts", import.meta.url),
    { workerData: { heartbeatBuffer } },
  );
  const heartbeatTimer = setInterval(() => Atomics.add(heartbeat, 0, 1), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  worker.unref();

  let closed = false;
  const stopHeartbeat = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
  };
  worker.on("message", onStall);
  worker.once("error", stopHeartbeat);
  worker.once("exit", stopHeartbeat);

  return {
    close: async () => {
      stopHeartbeat();
      await worker.terminate();
    },
  };
}
