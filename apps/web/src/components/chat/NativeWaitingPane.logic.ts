import * as DateTime from "effect/DateTime";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

type NativeDynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
type NativeSubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
type NativeNoticeItem = Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;

type NativeWaitLifecycleFact = NativeSubagentItem | NativeNoticeItem;

export type NativeWaitJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export interface NativeWaitJob {
  readonly id: string;
  readonly type: string | null;
  readonly status: NativeWaitJobStatus;
  readonly label: string | null;
  readonly durationMs: number | null;
  readonly completionPercent: number | null;
}

export interface NativeWaitState {
  readonly jobs: ReadonlyArray<NativeWaitJob>;
  /** True only for an active native wait with at least one known running dependency. */
  readonly waiting: boolean;
  /** Snapshot time for native durationMs values; used only to tick active rows. */
  readonly snapshotAtMs: number | null;
}

interface NativeWaitLifecycleUpdate {
  readonly status: NativeWaitJobStatus;
  readonly type: string | null;
  readonly label: string | null;
  readonly durationMs: number | null;
  readonly completionPercent: number | null;
  readonly observedAtMs: number;
  readonly priority: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function completionPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function jobStatus(value: unknown): NativeWaitJobStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "unknown";
  }
}

function isTerminalStatus(status: NativeWaitJobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
function terminalSubagentDuration(item: NativeSubagentItem): number | null {
  if (
    !isTerminalStatus(jobStatus(item.status)) ||
    item.startedAt === null ||
    item.completedAt === null
  ) {
    return null;
  }
  const elapsedMs =
    DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null;
}
function lifecycleUpdate(
  fact: NativeWaitLifecycleFact,
): { readonly jobId: string; readonly update: NativeWaitLifecycleUpdate } | null {
  if (fact.type === "system_notice") {
    const completion = fact.jobCompletion;
    if (completion === undefined) return null;
    const status = jobStatus(completion.status);
    const jobId = nonEmptyString(completion.jobId);
    if (jobId === null || !isTerminalStatus(status)) return null;
    const reportedDuration = completion.durationMs;
    return {
      jobId,
      update: {
        status,
        type: nonEmptyString(completion.type),
        label: nonEmptyString(completion.label),
        durationMs:
          reportedDuration !== undefined &&
          Number.isFinite(reportedDuration) &&
          reportedDuration >= 0
            ? reportedDuration
            : null,
        completionPercent: null,
        observedAtMs: DateTime.toEpochMillis(fact.updatedAt),
        priority: 2,
      },
    };
  }

  const jobId = nonEmptyString(fact.nativeAgentId);
  const status = jobStatus(fact.status);
  if (jobId === null || (status !== "running" && !isTerminalStatus(status))) return null;
  return {
    jobId,
    update: {
      status,
      type: "task",
      label: nonEmptyString(fact.title),
      durationMs: terminalSubagentDuration(fact),
      completionPercent: completionPercent(fact.completionPercent),
      observedAtMs: DateTime.toEpochMillis(fact.updatedAt),
      priority: 1,
    },
  };
}
function readLifecycleUpdates(
  lifecycleItems: ReadonlyArray<OrchestrationV2TurnItem> | undefined,
): ReadonlyMap<string, NativeWaitLifecycleUpdate> {
  const updates = new Map<string, NativeWaitLifecycleUpdate>();
  for (const item of lifecycleItems ?? []) {
    if (item.type !== "subagent" && item.type !== "system_notice") continue;
    const candidate = lifecycleUpdate(item);
    if (candidate === null) continue;
    const previous = updates.get(candidate.jobId);
    if (
      previous === undefined ||
      candidate.update.observedAtMs > previous.observedAtMs ||
      (candidate.update.observedAtMs === previous.observedAtMs &&
        candidate.update.priority >= previous.priority)
    ) {
      updates.set(candidate.jobId, candidate.update);
    }
  }
  return updates;
}
/** KM Code's `t3_thread_wait`: one T3 thread is the wait's only job. */
export function isT3ThreadWait(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "dynamic_tool" &&
    resolveT3McpToolDefinition(item.toolName)?.summaryAction === "thread-wait"
  );
}
/** Classify native wait calls; job details are validated separately by the reader. */
export function isNativeWaitTool(item: OrchestrationV2TurnItem): boolean {
  if (item.type !== "dynamic_tool") return false;
  if (isT3ThreadWait(item)) return true;
  const name = item.toolName?.toLowerCase();
  if (name === "wait") return true;
  if (name !== "hub") return false;
  return asRecord(item.input)?.op === "wait" || asRecord(item.details)?.op === "wait";
}
/**
 * A thread wait carries only the thread id. A delegated child's subagent item
 * on the parent names it and reports its status and timing, so the row reads
 * like an OMP job; a thread with no such item is only known to be waited on.
 */
function readThreadWaitState(
  item: NativeDynamicToolItem,
  lifecycleItems: ReadonlyArray<OrchestrationV2TurnItem> | undefined,
): NativeWaitState | null {
  const threadId = nonEmptyString(asRecord(item.input)?.threadId);
  if (threadId === null) return null;
  let child: NativeSubagentItem | undefined;
  for (const fact of lifecycleItems ?? []) {
    if (fact.type === "subagent" && fact.childThreadId === threadId) child = fact;
  }
  const waitRunning = item.status === "running";
  const status: NativeWaitJobStatus =
    child === undefined
      ? waitRunning
        ? "running"
        : "unknown"
      : isOrchestrationV2WorkActive(child.status)
        ? "running"
        : jobStatus(child.status);
  const snapshotAtMs = DateTime.toEpochMillis(item.updatedAt);
  const runningForMs =
    child?.startedAt != null && status === "running"
      ? snapshotAtMs - DateTime.toEpochMillis(child.startedAt)
      : null;
  return {
    jobs: [
      {
        id: threadId,
        type: "thread",
        status,
        label: child === undefined ? null : nonEmptyString(child.title),
        durationMs:
          child === undefined
            ? null
            : runningForMs !== null && Number.isFinite(runningForMs) && runningForMs >= 0
              ? runningForMs
              : terminalSubagentDuration(child),
        completionPercent: child === undefined ? null : completionPercent(child.completionPercent),
      },
    ],
    waiting: waitRunning && status === "running",
    snapshotAtMs: Number.isFinite(snapshotAtMs) ? snapshotAtMs : null,
  };
}
function readJobs(details: unknown): ReadonlyArray<NativeWaitJob> | null {
  const jobsValue = asRecord(details)?.jobs;
  if (!Array.isArray(jobsValue)) return null;
  const values: ReadonlyArray<unknown> = jobsValue;
  const jobs: NativeWaitJob[] = [];
  for (const value of values) {
    const record = asRecord(value);
    const id = record === null ? null : nonEmptyString(record.id);
    if (record === null || id === null) continue;
    const duration = record.durationMs;
    jobs.push({
      id,
      type: nonEmptyString(record.type),
      status: jobStatus(record.status),
      label: nonEmptyString(record.label),
      durationMs:
        typeof duration === "number" && Number.isFinite(duration) && duration >= 0
          ? duration
          : null,
      completionPercent: null,
    });
  }
  return jobs.length === 0 ? null : jobs;
}
function mergeLifecycleUpdate(
  job: NativeWaitJob,
  update: NativeWaitLifecycleUpdate | undefined,
): NativeWaitJob {
  if (update === undefined || (update.type === "task" && job.type !== "task")) return job;
  const status = isTerminalStatus(update.status)
    ? update.status
    : job.status === "unknown" && update.status === "running"
      ? "running"
      : job.status;
  return {
    ...job,
    status,
    type: job.type ?? update.type,
    label: job.label ?? update.label,
    durationMs: update.durationMs ?? job.durationMs,
    completionPercent: update.completionPercent ?? job.completionPercent,
  };
}
/** Read native snapshots and reconcile them only with the caller's current lifecycle projection. */
export function readNativeWaitState(
  item: OrchestrationV2TurnItem,
  lifecycleItems?: ReadonlyArray<OrchestrationV2TurnItem>,
): NativeWaitState | null {
  if (item.type !== "dynamic_tool" || !isNativeWaitTool(item)) return null;
  if (isT3ThreadWait(item)) return readThreadWaitState(item, lifecycleItems);
  const jobs = readJobs(item.details);
  if (jobs === null) return null;

  const lifecycleUpdates = readLifecycleUpdates(lifecycleItems);
  const reconciledJobs = jobs.map((job) => mergeLifecycleUpdate(job, lifecycleUpdates.get(job.id)));
  const waiting =
    item.status === "running" && reconciledJobs.some((job) => job.status === "running");
  const snapshotAtMs = DateTime.toEpochMillis(item.updatedAt);
  return {
    jobs: reconciledJobs,
    waiting,
    snapshotAtMs: Number.isFinite(snapshotAtMs) ? snapshotAtMs : null,
  };
}
