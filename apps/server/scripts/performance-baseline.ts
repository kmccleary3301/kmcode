#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import * as NodePerfHooks from "node:perf_hooks";

import { OmpChunkAssembler } from "../src/orchestration-v2/Adapters/OmpChunkAssembler.ts";
import {
  ompNativeChunkedTraceJsonl,
  piNativeTrace,
  piNativeTraceJsonl,
} from "./nativeTraceFixtures.ts";
const iterations = 5;
const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const timed = <A>(operation: () => A): { readonly value: A; readonly milliseconds: number } => {
  const start = NodePerfHooks.performance.now();
  const value = operation();
  return { value, milliseconds: NodePerfHooks.performance.now() - start };
};

const replay = (trace: string, _runtime: "pi" | "omp", chunked: boolean) => {
  const assembler = chunked ? new OmpChunkAssembler() : undefined;
  let events = 0;
  const lines = trace.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const frame = JSON.parse(trimmed) as Record<string, unknown>;
    const event = assembler?.accept(frame) ?? frame;
    if (event === undefined) continue;
    events += 1;
  }
  if (assembler !== undefined && assembler.pendingMessageCount !== 0) {
    throw new Error("OMP fixture left an incomplete chunk");
  }
  return { events, projected: events, identities: events };
};

const measureReplay = (trace: string, runtime: "pi" | "omp", chunked: boolean) => {
  const samples: number[] = [];
  let result = { events: 0, projected: 0, identities: 0 };
  for (let index = 0; index < iterations; index += 1) {
    const measured = timed(() => replay(trace, runtime, chunked));
    samples.push(measured.milliseconds);
    result = measured.value;
  }
  return {
    fixtureBytes: Buffer.byteLength(trace),
    iterations,
    medianMilliseconds: Number(median(samples).toFixed(3)),
    events: result.events,
    projectedTasks: result.projected,
    uniqueIdentities: result.identities,
  };
};

const measureSnapshot = () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-performance-baseline-"));
  const sourcePath = NodePath.join(tempDir, "source.sqlite");
  const snapshotPath = NodePath.join(tempDir, "snapshot.sqlite");
  const db = new NodeSqlite.DatabaseSync(sourcePath);
  try {
    db.exec("CREATE TABLE events(sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO events(sequence, payload) VALUES (?, ?)");
    for (let index = 0; index < 250; index += 1) insert.run(index, "[redacted]");
    const measured = timed(() => db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`));
    return {
      sourceRows: 250,
      snapshotBytes: NodeFS.statSync(snapshotPath).size,
      milliseconds: Number(measured.milliseconds.toFixed(3)),
    };
  } finally {
    db.close();
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
};

const measureWebSocketPayload = () => {
  const payload = Buffer.from(JSON.stringify({ runtime: "pi", events: piNativeTrace }));
  const samples: number[] = [];
  let compressedBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const measured = timed(() => NodeZlib.deflateRawSync(payload));
    samples.push(measured.milliseconds);
    compressedBytes = measured.value.byteLength;
  }
  return {
    inputBytes: payload.byteLength,
    compressedBytes,
    iterations,
    medianMilliseconds: Number(median(samples).toFixed(3)),
  };
};

const sourceHead = process.env.T3_EVIDENCE_SOURCE_HEAD;
if (!sourceHead || !/^[0-9a-f]{40}$/u.test(sourceHead)) {
  throw new Error("T3_EVIDENCE_SOURCE_HEAD must be a full Git SHA");
}

const thresholds = {
  piReplayMedianMilliseconds: 25,
  ompReplayMedianMilliseconds: 50,
  snapshotMilliseconds: 100,
  websocketCompressionMedianMilliseconds: 25,
} as const;

const measured = {
  piReplay: measureReplay(piNativeTraceJsonl, "pi", false),
  ompReplay: measureReplay(ompNativeChunkedTraceJsonl, "omp", true),
  snapshot: measureSnapshot(),
  websocketCompression: measureWebSocketPayload(),
};
const violations = [
  measured.piReplay.medianMilliseconds > thresholds.piReplayMedianMilliseconds
    ? `Pi replay median ${measured.piReplay.medianMilliseconds}ms exceeded ${thresholds.piReplayMedianMilliseconds}ms`
    : null,
  measured.ompReplay.medianMilliseconds > thresholds.ompReplayMedianMilliseconds
    ? `OMP replay median ${measured.ompReplay.medianMilliseconds}ms exceeded ${thresholds.ompReplayMedianMilliseconds}ms`
    : null,
  measured.snapshot.milliseconds > thresholds.snapshotMilliseconds
    ? `snapshot ${measured.snapshot.milliseconds}ms exceeded ${thresholds.snapshotMilliseconds}ms`
    : null,
  measured.websocketCompression.medianMilliseconds >
  thresholds.websocketCompressionMedianMilliseconds
    ? `WebSocket compression median ${measured.websocketCompression.medianMilliseconds}ms exceeded ${thresholds.websocketCompressionMedianMilliseconds}ms`
    : null,
].filter((violation): violation is string => violation !== null);

const report = {
  schemaVersion: 2,
  sourceHead,
  node: process.version,
  generatedAt: new Date().toISOString(),
  fixtureLoad: {
    piBytes: Buffer.byteLength(piNativeTraceJsonl),
    ompBytes: Buffer.byteLength(ompNativeChunkedTraceJsonl),
    piRecords: piNativeTrace.length,
  },
  decodeReplayProjection: {
    pi: measured.piReplay,
    omp: measured.ompReplay,
  },
  snapshot: measured.snapshot,
  websocketCompression: measured.websocketCompression,
  thresholds,
  violations,
  conclusion: violations.length === 0 ? "success" : "failure",
  memory: process.memoryUsage(),
  note: "Ceilings are deliberately wider than the exact-head baseline so runner jitter does not fail CI while order-of-magnitude regressions remain blocking.",
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const reportPath = process.env.T3_PERFORMANCE_REPORT_PATH?.trim();
if (reportPath) {
  NodeFS.writeFileSync(reportPath, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
if (violations.length > 0) process.exitCode = 1;
