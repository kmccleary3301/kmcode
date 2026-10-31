import { describe, expect, it } from "@effect/vitest";
import { ServerHostHealthSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  makeProcSamplingState,
  parseCgroupUnit,
  parseLoadAverage,
  parseMemoryInfo,
  parsePressure,
  parseProcIo,
  parseProcStat,
  make,
  readLinuxHostHealthData,
  sampleProcProcesses,
  type ProcReader,
} from "./HostHealth.ts";
import { advanceStallState, initialStallMachineState } from "./StallState.ts";

const procStatFixture =
  "4242 (node (primary)) R 1 4242 4242 0 -1 4194304 12 3 0 0 200 30 0 0 20 0 8 0 123456 1234 42";
const procIoFixture = "rchar: 8192\nwchar: 16384\nsyscr: 2\nsyscw: 3\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n";
const procCgroupFixture = "0::/user.slice/user-1000.slice/app.slice/code.service\n";

function procStatFor(pid: number, state = "S"): string {
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = state;
  fields[19] = String(pid * 10);
  return `${pid} (process-${pid}) ${fields.join(" ")}`;
}

function procIoFor(readBytes: number, writeBytes: number): string {
  return `read_bytes: ${readBytes}\nwrite_bytes: ${writeBytes}\n`;
}


describe("host health proc parsers", () => {
  it("parses process stat fields even when comm contains a closing parenthesis", () => {
    expect(parseProcStat(procStatFixture)).toEqual({
      pid: 4242,
      comm: "node (primary)",
      state: "R",
      startTimeTicks: 123456,
    });
  });

  it("parses proc io counters, load, memory, pressure, and systemd unit fixtures", () => {
    expect(parseProcIo(procIoFixture)).toEqual({ readBytes: 4096, writeBytes: 8192 });
    expect(parseLoadAverage("0.12 1.34 0.89 2/99 12345\n")).toEqual([0.12, 1.34, 0.89]);
    expect(
      parseMemoryInfo(
        "MemTotal: 16384 kB\nMemAvailable: 10000 kB\nSwapTotal: 5000 kB\nSwapFree: 1024 kB\n",
      ),
    ).toEqual({ memoryAvailableBytes: 10_240_000, swapUsedBytes: 4_071_424 });
    expect(
      parsePressure(
        "some avg10=1.23 avg60=0.50 avg300=0.20 total=1234\nfull avg10=0.04 avg60=0.01 avg300=0.00 total=12\n",
      ),
    ).toEqual({ someAvg10Percent: 1.23, fullAvg10Percent: 0.04 });
    expect(parseCgroupUnit(procCgroupFixture)).toBe("code.service");
  });

  it("collects host metrics from proc fixtures", async () => {
    const fixtures: Readonly<Record<string, string>> = {
      "/proc/loadavg": "0.12 1.34 0.89 2/99 12345\n",
      "/proc/meminfo":
        "MemTotal: 16384 kB\nMemAvailable: 10000 kB\nSwapTotal: 5000 kB\nSwapFree: 1024 kB\n",
      "/proc/pressure/io":
        "some avg10=1.23 avg60=0.50 avg300=0.20 total=1234\nfull avg10=0.04 avg60=0.01 avg300=0.00 total=12\n",
      "/proc/pressure/memory": "some avg10=0.13 avg60=0.05 avg300=0.01 total=7\n",
      "/proc/pressure/cpu": "some avg10=4.56 avg60=1.00 avg300=0.50 total=99\n",
      "/proc/sys/kernel/random/boot_id": "boot-id-fixture\n",
      "/proc/4242/stat": procStatFixture,
      "/proc/4242/io": procIoFixture,
      "/proc/4242/cgroup": procCgroupFixture,
    };
    const reader: ProcReader = {
      readdir: async (path) => {
        if (path === "/proc") return ["self", "4242"];
        if (path === "/proc/4242/task") return ["4242"];
        throw new Error(`Unexpected proc directory: ${path}`);
      },
      readFile: async (path) => {
        const fixture = fixtures[path];
        if (fixture === undefined) throw new Error(`Unexpected proc file: ${path}`);
        return fixture;
      },
    };
    expect(await readLinuxHostHealthData({ reader })).toEqual({
      diskActivity: { diskWriters: [], diskReaders: [] },
      loadAverage: [0.12, 1.34, 0.89],
      memoryAvailableBytes: 10_240_000,
      swapUsedBytes: 4_071_424,
      pressure: {
        io: { someAvg10Percent: 1.23, fullAvg10Percent: 0.04 },
        memory: { someAvg10Percent: 0.13, fullAvg10Percent: null },
        cpu: { someAvg10Percent: 4.56, fullAvg10Percent: null },
      },
      hostBootId: "boot-id-fixture",
      dStateTasks: 0,
    });
  });

  it("counts D-state leaders and worker tasks from proc fixtures", async () => {
    const dStateLeaderFixture = procStatFixture.replace(") R ", ") D ");
    const dStateThreadFixture = procStatFixture
      .replace("4242 (node (primary)) R", "4243 (worker) D")
      .replace("123456", "123457");
    const reader: ProcReader = {
      readdir: async (path) => {
        if (path === "/proc") return ["4242"];
        if (path === "/proc/4242/task") return ["4242", "4243"];
        throw new Error(`Unexpected proc directory: ${path}`);
      },
      readFile: async (path) => {
        if (path === "/proc/4242/stat") return dStateLeaderFixture;
        if (path === "/proc/4242/task/4243/stat") return dStateThreadFixture;
        if (path.endsWith("/io")) return procIoFixture;
        return procCgroupFixture;
      },
    };
    const result = await sampleProcProcesses({ reader, now: () => 0 });
    expect(result.dStateTasks).toBe(2);
  });

  it("honors process-count and elapsed-time scan limits", async () => {
    let clock = 0;
    const paths: string[] = [];
    const reader: ProcReader = {
      readdir: async (path) => (path === "/proc" ? ["4242", "4243", "4244"] : ["4242"]),
      readFile: async (path) => {
        paths.push(path);
        if (path.endsWith("/stat")) {
          clock += 5;
          return procStatFixture;
        }
        if (path.endsWith("/io")) return procIoFixture;
        return procCgroupFixture;
      },
    };
    const processBounded = await sampleProcProcesses({
      reader,
      now: () => 0,
      budgetMs: 100,
      maxProcesses: 1,
      maxAdditionalTasks: 0,
    });
    expect(paths).toContain("/proc/4242/stat");
    expect(paths).not.toContain("/proc/4243/stat");

    paths.length = 0;
    const timeBounded = await sampleProcProcesses({
      reader,
      now: () => clock++,
      budgetMs: 4,
      maxProcesses: 2,
      maxAdditionalTasks: 0,
    });
    expect(paths).toContain("/proc/4242/stat");
    expect(paths).not.toContain("/proc/4243/stat");
    expect(paths).not.toContain("/proc/4244/stat");
  });
});

describe("host health disk source selection", () => {
  it("uses cgroup leaf deltas without double-counting an active parent", async () => {
    const state = makeProcSamplingState();
    let generation = 0;
    const accessed: Array<string> = [];
    const reader: ProcReader = {
      readdir: async (path) => {
        if (path === "/sys/fs/cgroup") return ["system.slice"];
        if (path === "/sys/fs/cgroup/system.slice") {
          return ["gp-agent@ProofPrep.service"];
        }
        if (path === "/sys/fs/cgroup/system.slice/gp-agent@ProofPrep.service") return [];
        if (path === "/proc") return ["4242"];
        if (path === "/proc/4242/task") return ["4242"];
        throw new Error(`Unexpected proc directory: ${path}`);
      },
      readFile: async (path) => {
        accessed.push(path);
        if (path === "/sys/fs/cgroup/system.slice/io.stat") {
          return generation === 0
            ? "8:0 rbytes=100 wbytes=100 rios=1 wios=1\n"
            : "8:0 rbytes=2000 wbytes=3000 rios=2 wios=2\n";
        }
        if (path === "/sys/fs/cgroup/system.slice/gp-agent@ProofPrep.service/io.stat") {
          return generation === 0
            ? "8:0 rbytes=0 wbytes=0 rios=0 wios=0\n"
            : "8:0 rbytes=1500 wbytes=2500 rios=1 wios=1\n";
        }
        if (path === "/proc/4242/stat") return procStatFor(4242);
        if (path === "/proc/loadavg") return "0 0 0 0/0 0";
        if (path === "/proc/meminfo") return "";
        if (path.startsWith("/proc/pressure/")) return "";
        if (path === "/proc/sys/kernel/random/boot_id") return "boot-id\n";
        throw new Error(`Unexpected proc file: ${path}`);
      },
    };

    await readLinuxHostHealthData({ reader, state, now: () => 0 });
    generation = 1;
    const current = await readLinuxHostHealthData({ reader, state, now: () => 0 });

    expect(current.diskActivity).toEqual({
      diskWriters: [
        {
          pid: null,
          comm: "cgroup",
          unit: "gp-agent@ProofPrep.service",
          bytes: 2_500,
        },
      ],
      diskReaders: [
        {
          pid: null,
          comm: "cgroup",
          unit: "gp-agent@ProofPrep.service",
          bytes: 1_500,
        },
      ],
    });
    expect(accessed).not.toContain("/proc/4242/io");
  });

  it("uses per-process deltas and top-N when cgroup io.stat is unavailable", async () => {
    const state = makeProcSamplingState();
    let generation = 0;
    const processIds = [4242, 4243, 4244, 4245];
    const reader: ProcReader = {
      readdir: async (path) => {
        if (path === "/sys/fs/cgroup") return [];
        if (path === "/proc") return processIds.map(String);
        if (path.endsWith("/task")) return [path.split("/")[2] ?? "1"];
        throw new Error(`Unexpected proc directory: ${path}`);
      },
      readFile: async (path) => {
        const match = /^\/proc\/(\d+)\/(stat|io|cgroup)$/.exec(path);
        if (match) {
          const pid = Number(match[1]);
          if (match[2] === "stat") return procStatFor(pid);
          if (match[2] === "io") {
            const readBytes =
              generation === 0 ? 0 : pid === 4242 ? 100 : pid === 4243 ? 400 : pid === 4244 ? 2_000 : 3_000;
            const writeBytes =
              generation === 0 ? 0 : pid === 4242 ? 500 : pid === 4243 ? 1_000 : pid === 4244 ? 3_000 : 2_000;
            return procIoFor(readBytes, writeBytes);
          }
          return procCgroupFixture;
        }
        if (path === "/proc/loadavg") return "0 0 0 0/0 0";
        if (path === "/proc/meminfo") return "";
        if (path.startsWith("/proc/pressure/")) return "";
        if (path === "/proc/sys/kernel/random/boot_id") return "boot-id\n";
        throw new Error(`Unexpected proc file: ${path}`);
      },
    };

    await readLinuxHostHealthData({ reader, state, now: () => 0 });
    generation = 1;
    const current = await readLinuxHostHealthData({ reader, state, now: () => 0 });

    expect(current.diskActivity.diskWriters).toEqual([
      { pid: 4244, comm: "process-4244", unit: "code.service", bytes: 3_000 },
      { pid: 4245, comm: "process-4245", unit: "code.service", bytes: 2_000 },
      { pid: 4243, comm: "process-4243", unit: "code.service", bytes: 1_000 },
    ]);
    expect(current.diskActivity.diskReaders).toEqual([
      { pid: 4245, comm: "process-4245", unit: "code.service", bytes: 3_000 },
      { pid: 4244, comm: "process-4244", unit: "code.service", bytes: 2_000 },
      { pid: 4243, comm: "process-4243", unit: "code.service", bytes: 400 },
    ]);
  });

  it("finds a high-pid offender beyond the first 128 /proc entries", async () => {
    const state = makeProcSamplingState();
    let generation = 0;
    const highPid = 3_200_001;
    const pids = [...Array.from({ length: 140 }, (_, index) => String(index + 1)), String(highPid)];
    const reader: ProcReader = {
      readdir: async (path) => {
        if (path === "/sys/fs/cgroup") return [];
        if (path === "/proc") return pids;
        if (path.endsWith("/task")) return [path.split("/")[2] ?? "1"];
        throw new Error(`Unexpected proc directory: ${path}`);
      },
      readFile: async (path) => {
        const match = /^\/proc\/(\d+)\/(stat|io|cgroup)$/.exec(path);
        if (match) {
          const pid = Number(match[1]);
          if (match[2] === "stat") return procStatFor(pid);
          if (match[2] === "io") {
            return procIoFor(0, pid === highPid && generation > 0 ? 9_000 : 0);
          }
          return procCgroupFixture;
        }
        if (path === "/proc/loadavg") return "0 0 0 0/0 0";
        if (path === "/proc/meminfo") return "";
        if (path.startsWith("/proc/pressure/")) return "";
        if (path === "/proc/sys/kernel/random/boot_id") return "boot-id\n";
        throw new Error(`Unexpected proc file: ${path}`);
      },
    };

    await readLinuxHostHealthData({ reader, state, now: () => 0 });
    generation = 1;
    const current = await readLinuxHostHealthData({ reader, state, now: () => 0 });

    expect(current.diskActivity.diskWriters[0]).toEqual({
      pid: highPid,
      comm: `process-${highPid}`,
      unit: "code.service",
      bytes: 9_000,
    });
  });
});


describe("host health stall state machine", () => {
  it("starts only after one second without a heartbeat and records completion", () => {
    const initial = advanceStallState(initialStallMachineState, {
      heartbeat: 7,
      monotonicNowMs: 0,
      wallNowMs: 10_000,
      taskState: "R",
      wchan: "0",
      ioPressureSomeAvg10Percent: 0,
    });
    const atThreshold = advanceStallState(initial.state, {
      heartbeat: 7,
      monotonicNowMs: 1_000,
      wallNowMs: 11_000,
      taskState: "D",
      wchan: "io_schedule",
      ioPressureSomeAvg10Percent: 2.5,
    });
    expect(atThreshold.started).toBeNull();

    const stalled = advanceStallState(atThreshold.state, {
      heartbeat: 7,
      monotonicNowMs: 1_001,
      wallNowMs: 11_001,
      taskState: "D",
      wchan: "io_schedule",
      ioPressureSomeAvg10Percent: 2.5,
    });
    expect(stalled.started).toEqual({
      startedAt: 10_000,
      durationMs: 1_001,
      state: "D",
      wchan: "io_schedule",
      ioPressureSomeAvg10Percent: 2.5,
    });

    const resumed = advanceStallState(stalled.state, {
      heartbeat: 8,
      monotonicNowMs: 3_000,
      wallNowMs: 13_000,
      taskState: "R",
      wchan: "0",
      ioPressureSomeAvg10Percent: 0.5,
    });
    expect(resumed.completed).toEqual({
      startedAt: 10_000,
      durationMs: 3_000,
      state: "D",
      wchan: "io_schedule",
      ioPressureSomeAvg10Percent: 2.5,
    });
    expect(resumed.state.active).toBeNull();
  });
});

// Holds the event loop so the delay histogram records a fractional-millisecond value.
function holdEventLoop(durationMs: number): void {
  // @effect-diagnostics-next-line globalDate:off
  const blockUntil = Date.now() + durationMs;
  // @effect-diagnostics-next-line globalDate:off
  while (Date.now() < blockUntil) {
    // busy wait
  }
}

describe("host health service", () => {
  it.live("publishes snapshots that encode on the wire after real event-loop delay", () =>
    Effect.gen(function* () {
      const unavailableProc: ProcReader = {
        readFile: () => Promise.reject(new Error("no procfs")),
        readdir: () => Promise.reject(new Error("no procfs")),
      };
      const service = yield* make({
        platform: "linux",
        procReader: unavailableProc,
        startStallDetector: () => ({ close: () => Promise.resolve() }),
        sampleIntervalMs: 50,
      });
      holdEventLoop(80);
      yield* Effect.sleep("200 millis");
      const snapshot = yield* service.latest;
      expect(snapshot.eventLoopDelayMaxMs).toBeGreaterThan(0);
      yield* Schema.encodeEffect(ServerHostHealthSnapshot)(snapshot);
    }).pipe(Effect.scoped),
  );
});
