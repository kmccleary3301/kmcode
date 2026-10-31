// @effect-diagnostics nodeBuiltinImport:off -- Host health is collected directly from Linux procfs.
import type { ServerHostHealthSnapshot } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodePerfHooks from "node:perf_hooks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  calculateCgroupDiskActivity,
  MAX_DISK_ACTIVITY_ITEMS,
  makeProcSamplingState,
  parseCgroupIoStat,
  parseCgroupUnit,
  parseLoadAverage,
  parseMemoryInfo,
  parsePressure,
  parseProcIo,
  parseProcStat,
  PROC_SAMPLE_BUDGET_MS,
  sampleCgroupDiskActivity,
  sampleProcProcesses,
  systemProcReader,
  type DiskActivity,
  type ProcReader,
  type ProcSamplingState,
} from "./Proc.ts";
import { startStallDetector, type StallDetectorMessage } from "./StallDetector.ts";
import type { HostHealthStall } from "./StallState.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

export const HOST_HEALTH_SAMPLE_INTERVAL_MS = 5_000;
const MAX_COMPLETED_STALLS = 20;
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

export type { HostHealthStall } from "./StallState.ts";
export {
  calculateCgroupDiskActivity,
  MAX_DISK_ACTIVITY_ITEMS,
  makeProcSamplingState,
  parseCgroupIoStat,
  parseCgroupUnit,
  parseLoadAverage,
  parseMemoryInfo,
  parsePressure,
  parseProcIo,
  parseProcStat,
  PROC_SAMPLE_BUDGET_MS,
  sampleCgroupDiskActivity,
  sampleProcProcesses,
};
export type {
  CgroupIoSample,
  DiskActivity,
  DiskActivityItem,
  ParsedMemoryInfo,
  ParsedProcIo,
  ParsedProcStat,
  PressureAverage,
  ProcReader,
  ProcSamplingOptions,
  ProcSamplingResult,
  ProcSamplingState,
} from "./Proc.ts";
export { advanceStallState, initialStallMachineState, STALL_THRESHOLD_MS } from "./StallState.ts";
export type { StallMachineState, StallObservation, StallTransition } from "./StallState.ts";

export interface HostHealthSubscription {
  readonly latest: ServerHostHealthSnapshot;
  readonly changes: Stream.Stream<ServerHostHealthSnapshot>;
}

export class HostHealthService extends Context.Service<
  HostHealthService,
  {
    readonly latest: Effect.Effect<ServerHostHealthSnapshot>;
    readonly changes: Stream.Stream<ServerHostHealthSnapshot>;
    readonly subscribe: Effect.Effect<HostHealthSubscription, never, Scope.Scope>;
  }
>()("t3/hostHealth/HostHealth/HostHealthService") {}

export interface LinuxHostHealthData {
  readonly loadAverage: number[];
  readonly memoryAvailableBytes: number | null;
  readonly swapUsedBytes: number | null;
  readonly pressure: ServerHostHealthSnapshot["pressure"];
  readonly hostBootId: string | null;
  readonly diskActivity: DiskActivity;
  readonly dStateTasks: number;
}

export interface LinuxHostHealthDataOptions {
  readonly reader?: ProcReader;
  readonly now?: () => number;
  readonly processBudgetMs?: number;
  readonly maxProcesses?: number;
  readonly maxAdditionalTasks?: number;
  readonly state?: ProcSamplingState;
}

async function readProcFile(reader: ProcReader, path: string): Promise<string | null> {
  try {
    return await reader.readFile(path);
  } catch {
    return null;
  }
}

export async function readLinuxHostHealthData(
  options: LinuxHostHealthDataOptions = {},
): Promise<LinuxHostHealthData> {
  const reader = options.reader ?? systemProcReader;
  const now = options.now ?? NodePerfHooks.performance.now.bind(NodePerfHooks.performance);
  const budgetMs = Math.max(
    0,
    Math.min(PROC_SAMPLE_BUDGET_MS, options.processBudgetMs ?? PROC_SAMPLE_BUDGET_MS),
  );
  const deadline = now() + budgetMs;
  const state = options.state ?? makeProcSamplingState();
  const metricsPromise = Promise.all([
    readProcFile(reader, "/proc/loadavg"),
    readProcFile(reader, "/proc/meminfo"),
    readProcFile(reader, "/proc/pressure/io"),
    readProcFile(reader, "/proc/pressure/memory"),
    readProcFile(reader, "/proc/pressure/cpu"),
    readProcFile(reader, "/proc/sys/kernel/random/boot_id"),
  ]);
  const cgroupSample = await sampleCgroupDiskActivity({
    reader,
    now,
    deadline,
    state,
  });
  const procSample = await sampleProcProcesses({
    reader,
    now,
    deadline,
    state,
    readIo: !cgroupSample.available,
    ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
    ...(options.maxAdditionalTasks === undefined
      ? {}
      : { maxAdditionalTasks: options.maxAdditionalTasks }),
  });
  const [loadText, memoryText, ioPressureText, memoryPressureText, cpuPressureText, bootIdText] =
    await metricsPromise;
  const memory = memoryText === null ? null : parseMemoryInfo(memoryText);
  return {
    loadAverage: loadText === null ? [] : (parseLoadAverage(loadText) ?? []),
    memoryAvailableBytes: memory?.memoryAvailableBytes ?? null,
    swapUsedBytes: memory?.swapUsedBytes ?? null,
    pressure: {
      io: ioPressureText === null ? parsePressure("") : parsePressure(ioPressureText),
      memory: memoryPressureText === null ? parsePressure("") : parsePressure(memoryPressureText),
      cpu: cpuPressureText === null ? parsePressure("") : parsePressure(cpuPressureText),
    },
    hostBootId: bootIdText?.trim() || null,
    diskActivity: cgroupSample.available ? cgroupSample.diskActivity : procSample.diskActivity,
    dStateTasks: procSample.dStateTasks,
  };
}

export interface HostHealthLayerOptions {
  readonly platform?: NodeJS.Platform;
  readonly procReader?: ProcReader;
  readonly now?: () => number;
  readonly startStallDetector?: typeof startStallDetector;
  readonly sampleIntervalMs?: number;
}

function emptySnapshot(input: {
  readonly sampledAt: number;
  readonly sampleWindowMs: number;
  readonly platform: ServerHostHealthSnapshot["platform"];
  readonly serverInstanceId: string;
  readonly serverStartedAt: number;
}): ServerHostHealthSnapshot {
  return {
    ...input,
    hostBootId: null,
    loadAverage: [],
    memoryAvailableBytes: null,
    swapUsedBytes: null,
    pressure: {
      io: { someAvg10Percent: null, fullAvg10Percent: null },
      memory: { someAvg10Percent: null, fullAvg10Percent: null },
      cpu: { someAvg10Percent: null, fullAvg10Percent: null },
    },
    eventLoopDelayP99Ms: null,
    eventLoopDelayMaxMs: null,
    diskWriters: [],
    diskReaders: [],
    dStateTasks: 0,
    currentStall: null,
    completedStalls: [],
  };
}


export const make = Effect.fn("hostHealth.make")(function* (options: HostHealthLayerOptions = {}) {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const serverInstanceId = NodeCrypto.randomUUID();
  const serverStartedAt = startedAtMs;
  const platform: ServerHostHealthSnapshot["platform"] = (options.platform ?? process.platform) === "linux"
    ? "linux"
    : "unsupported";
  const snapshotRef = yield* Ref.make(
    emptySnapshot({
      sampledAt: startedAtMs,
      sampleWindowMs: 0,
      platform,
      serverInstanceId,
      serverStartedAt,
    }),
  );
  const changes = yield* PubSub.sliding<ServerHostHealthSnapshot>(8);
  const mutex = yield* Semaphore.make(1);
  const latest = Ref.get(snapshotRef);
  const subscribe = subscribeBeforeSnapshot(changes, latest, mutex);
  const liveChanges = Stream.unwrap(Effect.map(subscribe, (subscription) => subscription.changes));
  const procSamplingState = makeProcSamplingState();
  let currentStall: HostHealthStall | null = null;
  let completedStalls: HostHealthStall[] = [];
  let lastSampleAtMs = NodePerfHooks.performance.now();

  const publish = (snapshot: ServerHostHealthSnapshot) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(snapshotRef, snapshot);
        yield* PubSub.publish(changes, snapshot);
      }),
    );

  const onStall = (message: StallDetectorMessage) => {
    if (message.type === "started") {
      currentStall = message.stall;
      return;
    }
    currentStall = null;
    completedStalls = [...completedStalls, message.stall].slice(-MAX_COMPLETED_STALLS);
  };
  const startDetector = options.startStallDetector ?? startStallDetector;
  if (platform === "linux") {
    yield* Effect.acquireRelease(
      Effect.sync(() => startDetector(onStall)),
      (running) => Effect.promise(() => running.close()),
    );
  }

  const eventLoopHistogram = platform === "linux"
    ? yield* Effect.acquireRelease(
        Effect.sync(() => {
          const histogram = NodePerfHooks.monitorEventLoopDelay({
            resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
          });
          histogram.enable();
          return histogram;
        }),
        (histogram) => Effect.sync(() => histogram.disable()),
      )
    : null;

  const sampleOnce = Effect.gen(function* () {
    const sampleStartedAtMs = NodePerfHooks.performance.now();
    const sampledAtMs = now();
    const data = platform === "linux"
      ? yield* Effect.promise(() =>
          readLinuxHostHealthData({
            now,
            state: procSamplingState,
            ...(options.procReader === undefined ? {} : { reader: options.procReader }),
          }),
        )
      : null;
    const activity = data?.diskActivity ?? { diskWriters: [], diskReaders: [] };

    const delayP99 =
      eventLoopHistogram === null ? null : eventLoopHistogram.percentile(99) / 1e6;
    const delayMax = eventLoopHistogram === null ? null : eventLoopHistogram.max / 1e6;
    eventLoopHistogram?.reset();
    const sampleWindowMs = Math.max(0, Math.round(sampleStartedAtMs - lastSampleAtMs));
    lastSampleAtMs = sampleStartedAtMs;
    const activeStall = currentStall === null
      ? null
      : {
          ...currentStall,
          durationMs: Math.max(0, sampledAtMs - currentStall.startedAt),
        };
    const snapshot: ServerHostHealthSnapshot = {
      sampledAt: sampledAtMs,
      sampleWindowMs,
      platform,
      serverInstanceId,
      serverStartedAt,
      hostBootId: data?.hostBootId ?? null,
      loadAverage: data?.loadAverage ?? [],
      memoryAvailableBytes: data?.memoryAvailableBytes ?? null,
      swapUsedBytes: data?.swapUsedBytes ?? null,
      pressure: data?.pressure ?? {
        io: { someAvg10Percent: null, fullAvg10Percent: null },
        memory: { someAvg10Percent: null, fullAvg10Percent: null },
        cpu: { someAvg10Percent: null, fullAvg10Percent: null },
      },
      eventLoopDelayP99Ms:
        delayP99 !== null && Number.isFinite(delayP99) ? Math.round(delayP99) : null,
      eventLoopDelayMaxMs:
        delayMax !== null && Number.isFinite(delayMax) ? Math.round(delayMax) : null,
      diskWriters: activity.diskWriters,
      diskReaders: activity.diskReaders,
      dStateTasks: data?.dStateTasks ?? 0,
      currentStall: activeStall,
      completedStalls,
    };
    yield* publish(snapshot);
  });

  yield* sampleOnce;
  yield* Effect.sleep(options.sampleIntervalMs ?? HOST_HEALTH_SAMPLE_INTERVAL_MS).pipe(
    Effect.andThen(sampleOnce),
    Effect.forever,
    Effect.forkScoped,
  );

  return HostHealthService.of({
    latest,
    changes: liveChanges,
    subscribe,
  });
});

export const layer = Layer.effect(HostHealthService, make());
export const layerWith = (options: HostHealthLayerOptions) =>
  Layer.effect(HostHealthService, make(options));

 
