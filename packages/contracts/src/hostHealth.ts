import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const HostHealthPressure = Schema.Struct({
  someAvg10Percent: Schema.NullOr(Schema.Number),
  fullAvg10Percent: Schema.NullOr(Schema.Number),
});
export type HostHealthPressure = typeof HostHealthPressure.Type;

export const HostHealthDiskProcess = Schema.Struct({
  pid: Schema.NullOr(PositiveInt),
  comm: Schema.String,
  unit: Schema.NullOr(Schema.String),
  bytes: NonNegativeInt,
});
export type HostHealthDiskProcess = typeof HostHealthDiskProcess.Type;

export const HostHealthStall = Schema.Struct({
  startedAt: NonNegativeInt,
  durationMs: NonNegativeInt,
  state: Schema.NullOr(Schema.String),
  wchan: Schema.NullOr(Schema.String),
  ioPressureSomeAvg10Percent: Schema.NullOr(Schema.Number),
});
export type HostHealthStall = typeof HostHealthStall.Type;

/** One in-memory sample of host and server responsiveness; no persistent history is retained. */
export const ServerHostHealthSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  sampleWindowMs: NonNegativeInt,
  platform: Schema.Literals(["linux", "unsupported"]),
  serverInstanceId: Schema.String,
  serverStartedAt: NonNegativeInt,
  hostBootId: Schema.NullOr(Schema.String),
  loadAverage: Schema.Array(Schema.Number),
  memoryAvailableBytes: Schema.NullOr(NonNegativeInt),
  swapUsedBytes: Schema.NullOr(NonNegativeInt),
  pressure: Schema.Struct({
    io: HostHealthPressure,
    memory: HostHealthPressure,
    cpu: HostHealthPressure,
  }),
  eventLoopDelayP99Ms: Schema.NullOr(NonNegativeInt),
  eventLoopDelayMaxMs: Schema.NullOr(NonNegativeInt),
  diskWriters: Schema.Array(HostHealthDiskProcess),
  diskReaders: Schema.Array(HostHealthDiskProcess),
  dStateTasks: NonNegativeInt,
  currentStall: Schema.NullOr(HostHealthStall),
  completedStalls: Schema.Array(HostHealthStall),
});
export type ServerHostHealthSnapshot = typeof ServerHostHealthSnapshot.Type;
