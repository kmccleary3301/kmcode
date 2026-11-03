// @effect-diagnostics nodeBuiltinImport:off -- This module reads Linux procfs without filesystem writes.
import * as NodeFS from "node:fs/promises";
import * as NodePerfHooks from "node:perf_hooks";

export const PROC_SAMPLE_BUDGET_MS = 100;
export const MAX_ADDITIONAL_PROC_TASKS = 256;
export const MAX_DISK_ACTIVITY_ITEMS = 3;

export interface ProcReader {
  readonly readFile: (path: string) => Promise<string>;
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly readdirDirectories?: (path: string) => Promise<ReadonlyArray<string>>;
  readonly readdirLimited?: (
    path: string,
    maxEntries: number,
  ) => Promise<ReadonlyArray<string>>;
}

async function readdirLimited(path: string, maxEntries: number): Promise<string[]> {
  const entries: string[] = [];
  if (maxEntries <= 0) return entries;
  const directory = await NodeFS.opendir(path);
  try {
    while (entries.length < maxEntries) {
      const entry = await directory.read();
      if (entry === null) break;
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

export const systemProcReader: ProcReader = {
  readFile: (path) => NodeFS.readFile(path, "utf8"),
  readdir: (path) => NodeFS.readdir(path, { encoding: "utf8" }),
  readdirLimited,
  readdirDirectories: async (path) =>
    (
      await NodeFS.readdir(path, {
        encoding: "utf8",
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
};

export interface ParsedProcStat {
  readonly pid: number;
  readonly comm: string;
  readonly state: string;
  readonly startTimeTicks: number;
}

export interface ParsedProcIo {
  readonly readBytes: number;
  readonly writeBytes: number;
}


export interface ProcSamplingResult {
  readonly diskActivity: DiskActivity;
  readonly dStateTasks: number;
}

export interface ProcSamplingOptions {
  readonly reader?: ProcReader;
  readonly now?: () => number;
  readonly deadline?: number;
  readonly budgetMs?: number;
  readonly maxProcesses?: number;
  readonly maxAdditionalTasks?: number;
  readonly readIo?: boolean;
  readonly state?: ProcSamplingState;
}

export interface DiskActivityItem {
  readonly pid: number | null;
  readonly comm: string;
  readonly unit: string | null;
  readonly bytes: number;
}

export interface DiskActivity {
  readonly diskWriters: DiskActivityItem[];
  readonly diskReaders: DiskActivityItem[];
}

export interface CgroupIoSample {
  readonly path: string;
  readonly unit: string;
  readonly readBytes: number;
  readonly writeBytes: number;
}

interface ProcIoBaseline extends ParsedProcIo {
  readonly startTimeTicks: number;
}

interface ProcTaskState {
  readonly ownerPid: number;
  readonly tid: number;
  readonly startTimeTicks: number;
  readonly state: string;
}

export interface ProcSamplingState {
  procCursor: number;
  taskPidCursor: number;
  processIo: Map<number, ProcIoBaseline>;
  processStates: Map<number, Pick<ParsedProcStat, "startTimeTicks" | "state">>;
  taskStates: Map<string, ProcTaskState>;
  cgroupQueue: Array<{ readonly path: string; readonly depth: number }>;
  cgroupQueueIndex: number;
  cgroupBaselines: Map<string, CgroupIoSample>;
  cgroupSourceAvailable: boolean;
}

export function makeProcSamplingState(): ProcSamplingState {
  return {
    procCursor: 0,
    taskPidCursor: 0,
    processIo: new Map(),
    processStates: new Map(),
    taskStates: new Map(),
    cgroupQueue: [],
    cgroupQueueIndex: 0,
    cgroupBaselines: new Map(),
    cgroupSourceAvailable: false,
  };
}

export function parseProcStat(text: string): ParsedProcStat | null {
  const closeParen = text.lastIndexOf(")");
  if (closeParen < 0) return null;
  const openParen = text.indexOf("(");
  const pid = Number(text.slice(0, openParen).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || openParen < 0) return null;
  const comm = text.slice(openParen + 1, closeParen);
  const fields = text.slice(closeParen + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTimeTicks = Number(fields[19]);
  if (!state || !Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0) return null;
  return { pid, comm, state, startTimeTicks };
}

export function parseProcIo(text: string): ParsedProcIo | null {
  let readBytes: number | undefined;
  let writeBytes: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (key !== "read_bytes" && key !== "write_bytes") continue;
    const value = Number(line.slice(colon + 1).trim());
    if (!Number.isSafeInteger(value) || value < 0) continue;
    if (key === "read_bytes") readBytes = value;
    else writeBytes = value;
  }
  if (readBytes === undefined || writeBytes === undefined) return null;
  return { readBytes, writeBytes };
}

export function parseCgroupIoStat(text: string): ParsedProcIo {
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || !/^\d+:\d+$/.test(fields[0] ?? "")) continue;
    for (const field of fields.slice(1)) {
      const equals = field.indexOf("=");
      if (equals < 0) continue;
      const key = field.slice(0, equals);
      if (key !== "rbytes" && key !== "wbytes") continue;
      const value = Number(field.slice(equals + 1));
      if (!Number.isSafeInteger(value) || value < 0) continue;
      if (key === "rbytes") readBytes += value;
      else writeBytes += value;
    }
  }
  return {
    readBytes: Number.isSafeInteger(readBytes) ? readBytes : Number.MAX_SAFE_INTEGER,
    writeBytes: Number.isSafeInteger(writeBytes) ? writeBytes : Number.MAX_SAFE_INTEGER,
  };
}

export function parseLoadAverage(text: string): number[] | null {
  const values = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return values;
}

export interface ParsedMemoryInfo {
  readonly memoryAvailableBytes: number | null;
  readonly swapUsedBytes: number | null;
}

export function parseMemoryInfo(text: string): ParsedMemoryInfo {
  const values: Partial<Record<"MemAvailable" | "SwapTotal" | "SwapFree", number>> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB\s*$/.exec(line);
    if (!match) continue;
    const kibibytes = Number(match[2]);
    if (!Number.isSafeInteger(kibibytes)) continue;
    const key = match[1];
    if (key === "MemAvailable" || key === "SwapTotal" || key === "SwapFree") {
      values[key] = kibibytes * 1_024;
    }
  }
  const swapTotal = values.SwapTotal;
  const swapFree = values.SwapFree;
  return {
    memoryAvailableBytes: values.MemAvailable ?? null,
    swapUsedBytes:
      swapTotal === undefined || swapFree === undefined
        ? null
        : Math.max(0, swapTotal - swapFree),
  };
}

export interface PressureAverage {
  readonly someAvg10Percent: number | null;
  readonly fullAvg10Percent: number | null;
}

export function parsePressure(text: string): PressureAverage {
  let someAvg10Percent: number | null = null;
  let fullAvg10Percent: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(some|full)\s+.*?\bavg10=([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (match[1] === "some") someAvg10Percent = value;
    else fullAvg10Percent = value;
  }
  return { someAvg10Percent, fullAvg10Percent };
}

export function parseCgroupUnit(text: string): string | null {
  const paths = text
    .split(/\r?\n/)
    .map((line) => {
      const firstColon = line.indexOf(":");
      const secondColon = firstColon < 0 ? -1 : line.indexOf(":", firstColon + 1);
      return secondColon < 0
        ? null
        : {
            controllers: line.slice(firstColon + 1, secondColon),
            path: line.slice(secondColon + 1),
          };
    })
    .filter((value): value is { readonly controllers: string; readonly path: string } => value !== null)
    .sort((left, right) => {
      const leftUnified = left.controllers === "" ? 1 : 0;
      const rightUnified = right.controllers === "" ? 1 : 0;
      const leftSystemd = left.controllers.split(",").includes("name=systemd") ? 1 : 0;
      const rightSystemd = right.controllers.split(",").includes("name=systemd") ? 1 : 0;
      return rightUnified - leftUnified || rightSystemd - leftSystemd;
    });

  let slice: string | null = null;
  for (const entry of paths) {
    const components = entry.path.split("/").filter(Boolean).reverse();
    for (const component of components) {
      if (component.endsWith(".service") || component.endsWith(".scope")) return component;
      if (slice === null && component.endsWith(".slice")) slice = component;
    }
  }
  return slice;
}

async function readText(reader: ProcReader, path: string): Promise<string | null> {
  try {
    return await reader.readFile(path);
  } catch {
    return null;
  }
}

interface ProcIoDelta {
  readonly pid: number;
  readonly comm: string;
  readonly readBytes: number;
  readonly writeBytes: number;
}

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_MAX_DEPTH = 8;
const CGROUP_DISCOVERY_BUDGET_MS = 25;
const CGROUP_SCAN_BUDGET_MS = 75;
const MAX_CGROUP_DIRECTORIES = 8_192;
const MAX_CGROUP_BASELINES = 8_192;
const MAX_PROC_TASK_PROCESSES_PER_SAMPLE = 64;

function cgroupUnitFromPath(path: string): string {
  if (path === "/") return "cgroup root";
  return (
    parseCgroupUnit(`0::${path}`) ??
    path.split("/").filter(Boolean).at(-1) ??
    "cgroup"
  );
}

function isDescendantCgroup(parent: string, child: string): boolean {
  return parent === "/" ? child !== "/" : child.startsWith(`${parent}/`);
}

export function calculateCgroupDiskActivity(
  current: ReadonlyArray<CgroupIoSample>,
  previous: ReadonlyMap<string, CgroupIoSample>,
  limit = MAX_DISK_ACTIVITY_ITEMS,
): DiskActivity {
  const deltas: Array<{
    readonly path: string;
    readonly unit: string;
    readonly readBytes: number;
    readonly writeBytes: number;
  }> = [];
  for (const sample of current) {
    const baseline = previous.get(sample.path);
    if (baseline === undefined) continue;
    const readBytes = sample.readBytes - baseline.readBytes;
    const writeBytes = sample.writeBytes - baseline.writeBytes;
    if (
      (!Number.isSafeInteger(readBytes) || readBytes < 0) &&
      (!Number.isSafeInteger(writeBytes) || writeBytes < 0)
    ) {
      continue;
    }
    deltas.push({
      path: sample.path,
      unit: sample.unit,
      readBytes: Number.isSafeInteger(readBytes) && readBytes > 0 ? readBytes : 0,
      writeBytes: Number.isSafeInteger(writeBytes) && writeBytes > 0 ? writeBytes : 0,
    });
  }

  const rank = (counter: "readBytes" | "writeBytes"): DiskActivityItem[] => {
    const active = deltas.filter((delta) => delta[counter] > 0);
    return active
      .filter(
        (parent) =>
          !active.some(
            (child) =>
              child.path !== parent.path && isDescendantCgroup(parent.path, child.path),
          ),
      )
      .sort(
        (left, right) =>
          right[counter] - left[counter] || left.path.localeCompare(right.path),
      )
      .slice(0, Math.max(0, limit))
      .map((delta) => ({
        pid: null,
        comm: "cgroup",
        unit: delta.unit,
        bytes: delta[counter],
      }));
  };

  return { diskWriters: rank("writeBytes"), diskReaders: rank("readBytes") };
}

async function readCgroupIo(
  reader: ProcReader,
  state: ProcSamplingState,
  now: () => number,
  deadline: number,
  limit: number,
): Promise<DiskActivity> {
  if (state.cgroupQueueIndex >= state.cgroupQueue.length) {
    state.cgroupQueue = [{ path: CGROUP_ROOT, depth: 0 }];
    state.cgroupQueueIndex = 0;
  }
  const scanBudgetMs = state.cgroupSourceAvailable
    ? CGROUP_SCAN_BUDGET_MS
    : CGROUP_DISCOVERY_BUDGET_MS;
  const scanDeadline = Math.min(deadline, now() + scanBudgetMs);
  const current: CgroupIoSample[] = [];
  let scannedDirectories = 0;
  while (
    state.cgroupQueueIndex < state.cgroupQueue.length &&
    scannedDirectories < MAX_CGROUP_DIRECTORIES &&
    now() < scanDeadline
  ) {
    const directory = state.cgroupQueue[state.cgroupQueueIndex];
    state.cgroupQueueIndex += 1;
    if (directory === undefined) break;
    scannedDirectories += 1;

    const ioText = await readText(reader, `${directory.path}/io.stat`);
    if (ioText !== null) {
      state.cgroupSourceAvailable = true;
      const relativePath = directory.path.slice(CGROUP_ROOT.length) || "/";
      current.push({
        path: relativePath,
        unit: cgroupUnitFromPath(relativePath),
        ...parseCgroupIoStat(ioText),
      });
    }

    if (directory.depth >= CGROUP_MAX_DEPTH || now() >= scanDeadline) continue;
    let childNames: ReadonlyArray<string>;
    try {
      childNames = reader.readdirDirectories
        ? await reader.readdirDirectories(directory.path)
        : await reader.readdir(directory.path);
    } catch {
      continue;
    }
    for (const childName of childNames) {
      if (
        childName.length === 0 ||
        childName === "." ||
        childName === ".." ||
        childName.includes("/") ||
        state.cgroupQueue.length >= MAX_CGROUP_DIRECTORIES
      ) {
        continue;
      }
      state.cgroupQueue.push({
        path: `${directory.path}/${childName}`,
        depth: directory.depth + 1,
      });
    }
  }
  if (state.cgroupQueueIndex >= state.cgroupQueue.length) {
    state.cgroupQueue = [];
    state.cgroupQueueIndex = 0;
  }

  const activity = calculateCgroupDiskActivity(current, state.cgroupBaselines, limit);
  for (const sample of current) {
    state.cgroupBaselines.delete(sample.path);
    state.cgroupBaselines.set(sample.path, sample);
  }
  while (state.cgroupBaselines.size > MAX_CGROUP_BASELINES) {
    const oldestPath = state.cgroupBaselines.keys().next().value;
    if (oldestPath === undefined) break;
    state.cgroupBaselines.delete(oldestPath);
  }
  return activity;
}

export async function sampleProcProcesses(
  options: ProcSamplingOptions = {},
): Promise<ProcSamplingResult> {
  const reader = options.reader ?? systemProcReader;
  const now = options.now ?? NodePerfHooks.performance.now.bind(NodePerfHooks.performance);
  const state = options.state ?? makeProcSamplingState();
  const budgetMs = Math.max(
    0,
    Math.min(PROC_SAMPLE_BUDGET_MS, options.budgetMs ?? PROC_SAMPLE_BUDGET_MS),
  );
  const deadline = options.deadline ?? now() + budgetMs;
  const maxProcesses = Math.max(0, Math.floor(options.maxProcesses ?? Number.MAX_SAFE_INTEGER));
  const maxAdditionalTasks = Math.min(
    MAX_ADDITIONAL_PROC_TASKS,
    Math.max(0, Math.floor(options.maxAdditionalTasks ?? MAX_ADDITIONAL_PROC_TASKS)),
  );
  if (now() >= deadline || maxProcesses === 0) {
    return {
      diskActivity: { diskWriters: [], diskReaders: [] },
      dStateTasks: 0,
    };
  }

  let processNames: ReadonlyArray<string>;
  try {
    processNames = await reader.readdir("/proc");
  } catch {
    return {
      diskActivity: { diskWriters: [], diskReaders: [] },
      dStateTasks: 0,
    };
  }

  const processIds = processNames
    .filter((name) => /^[1-9]\d*$/.test(name))
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  const activePids = new Set(processIds);
  for (const pid of state.processIo.keys()) {
    if (!activePids.has(pid)) state.processIo.delete(pid);
  }
  for (const pid of state.processStates.keys()) {
    if (!activePids.has(pid)) state.processStates.delete(pid);
  }
  for (const [key, task] of state.taskStates) {
    if (!activePids.has(task.ownerPid)) state.taskStates.delete(key);
  }

  const readIo = options.readIo ?? true;
  const deltas: ProcIoDelta[] = [];
  let scannedProcesses = 0;
  const scannedProcessIdSet = new Set<number>();
  const startIndex = processIds.findIndex((pid) => pid > state.procCursor);
  const firstIndex = startIndex < 0 ? 0 : startIndex;
  for (let offset = 0; offset < processIds.length; offset += 1) {
    if (scannedProcesses >= maxProcesses || now() >= deadline) break;
    const pid = processIds[(firstIndex + offset) % processIds.length];
    if (pid === undefined) continue;
    scannedProcesses += 1;
    state.procCursor = pid;
    scannedProcessIdSet.add(pid);
    const base = `/proc/${pid}`;
    const [statText, ioText] = await Promise.all([
      readText(reader, `${base}/stat`),
      readIo ? readText(reader, `${base}/io`) : Promise.resolve(null),
    ]);
    const stat = statText === null ? null : parseProcStat(statText);
    if (stat === null || stat.pid !== pid) {
      state.processStates.delete(pid);
      state.processIo.delete(pid);
      continue;
    }
    state.processStates.set(pid, {
      startTimeTicks: stat.startTimeTicks,
      state: stat.state,
    });

    if (!readIo) continue;
    const io = ioText === null ? null : parseProcIo(ioText);
    if (io === null) {
      state.processIo.delete(pid);
      continue;
    }
    const previous = state.processIo.get(pid);
    if (
      previous !== undefined &&
      previous.startTimeTicks === stat.startTimeTicks &&
      io.readBytes >= previous.readBytes &&
      io.writeBytes >= previous.writeBytes
    ) {
      deltas.push({
        pid,
        comm: stat.comm,
        readBytes: io.readBytes - previous.readBytes,
        writeBytes: io.writeBytes - previous.writeBytes,
      });
    }
    state.processIo.set(pid, {
      ...io,
      startTimeTicks: stat.startTimeTicks,
    });
  }

  let scannedAdditionalTasks = 0;
  let scannedTaskProcesses = 0;
  const taskStartIndex = processIds.findIndex((pid) => pid > state.taskPidCursor);
  const firstTaskIndex = taskStartIndex < 0 ? 0 : taskStartIndex;
  for (let offset = 0; offset < processIds.length; offset += 1) {
    if (
      scannedAdditionalTasks >= maxAdditionalTasks ||
      scannedTaskProcesses >= MAX_PROC_TASK_PROCESSES_PER_SAMPLE ||
      now() >= deadline
    ) {
      break;
    }
    const pid = processIds[(firstTaskIndex + offset) % processIds.length];
    if (pid === undefined || !scannedProcessIdSet.has(pid)) continue;
    const base = `/proc/${pid}`;
    let taskNames: ReadonlyArray<string>;
    try {
      taskNames = reader.readdirLimited
        ? await reader.readdirLimited(
            `${base}/task`,
            maxAdditionalTasks - scannedAdditionalTasks + 1,
          )
        : await reader.readdir(`${base}/task`);
    } catch {
      continue;
    }
    scannedTaskProcesses += 1;
    state.taskPidCursor = pid;
    const currentTaskIds = new Set(
      taskNames.filter(
        (name) => name !== String(pid) && /^[1-9]\d*$/.test(name),
      ),
    );
    for (const [key, task] of state.taskStates) {
      if (task.ownerPid === pid && !currentTaskIds.has(String(task.tid))) {
        state.taskStates.delete(key);
      }
    }
    for (const taskName of currentTaskIds) {
      if (scannedAdditionalTasks >= maxAdditionalTasks || now() >= deadline) break;
      scannedAdditionalTasks += 1;
      const taskPid = Number(taskName);
      const taskStatText = await readText(reader, `${base}/task/${taskName}/stat`);
      const taskStat = taskStatText === null ? null : parseProcStat(taskStatText);
      const key = `${pid}:${taskName}`;
      if (taskStat?.pid === taskPid) {
        state.taskStates.set(key, {
          ownerPid: pid,
          tid: taskPid,
          startTimeTicks: taskStat.startTimeTicks,
          state: taskStat.state,
        });
      } else {
        state.taskStates.delete(key);
      }
    }
  }

  const candidatePids = new Set<number>();
  const sortedWriters = [...deltas]
    .filter((delta) => delta.writeBytes > 0)
    .sort((left, right) => right.writeBytes - left.writeBytes || left.pid - right.pid);
  const sortedReaders = [...deltas]
    .filter((delta) => delta.readBytes > 0)
    .sort((left, right) => right.readBytes - left.readBytes || left.pid - right.pid);
  for (const delta of [
    ...sortedWriters.slice(0, MAX_DISK_ACTIVITY_ITEMS * 2),
    ...sortedReaders.slice(0, MAX_DISK_ACTIVITY_ITEMS * 2),
  ]) {
    candidatePids.add(delta.pid);
  }
  const unitsByPid = new Map<number, string | null>();
  for (const pid of candidatePids) {
    if (now() >= deadline) break;
    const cgroupText = await readText(reader, `/proc/${pid}/cgroup`);
    unitsByPid.set(pid, cgroupText === null ? null : parseCgroupUnit(cgroupText));
  }
  const item = (
    delta: ProcIoDelta,
    bytes: number,
  ): DiskActivityItem => ({
    pid: delta.pid,
    comm: delta.comm,
    unit: unitsByPid.get(delta.pid) ?? null,
    bytes,
  });
  const diskActivity: DiskActivity = {
    diskWriters: sortedWriters
      .slice(0, MAX_DISK_ACTIVITY_ITEMS)
      .map((delta) => item(delta, delta.writeBytes)),
    diskReaders: sortedReaders
      .slice(0, MAX_DISK_ACTIVITY_ITEMS)
      .map((delta) => item(delta, delta.readBytes)),
  };
  const dStateTasks =
    [...state.processStates.values()].filter((process) => process.state === "D").length +
    [...state.taskStates.values()].filter((task) => task.state === "D").length;
  return { diskActivity, dStateTasks };
}

export async function sampleCgroupDiskActivity(options: {
  readonly reader?: ProcReader;
  readonly now?: () => number;
  readonly deadline: number;
  readonly state: ProcSamplingState;
  readonly limit?: number;
}): Promise<{ readonly available: boolean; readonly diskActivity: DiskActivity }> {
  const reader = options.reader ?? systemProcReader;
  const now = options.now ?? NodePerfHooks.performance.now.bind(NodePerfHooks.performance);
  const diskActivity = await readCgroupIo(
    reader,
    options.state,
    now,
    options.deadline,
    options.limit ?? MAX_DISK_ACTIVITY_ITEMS,
  );
  return { available: options.state.cgroupSourceAvailable, diskActivity };
}

