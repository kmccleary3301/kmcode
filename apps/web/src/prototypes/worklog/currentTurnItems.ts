// PROTOTYPE: throwaway work-log tree demo. Not production code.
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { streamedPrefix } from "./trace";
import type { Trace, TraceSubagent, TraceTextEvent, TraceToolEvent } from "./trace";

const OMP_DRIVER = ProviderDriverKind.make("omp");
const OMP_INSTANCE_ID = ProviderInstanceId.make("omp");

type ItemStatus = OrchestrationV2TurnItem["status"];
type RecordValue = Readonly<Record<string, unknown>>;

const TaskRecordSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  jobId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  assignment: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  resultText: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ content: Schema.optional(Schema.String) })]),
  ),
  progress: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
type TaskRecord = typeof TaskRecordSchema.Type;
const isTaskRecord = Schema.is(TaskRecordSchema);

function itemBase(input: {
  readonly trace: Trace;
  readonly id: string;
  readonly ordinal: number;
  readonly status: ItemStatus;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly updatedAt: number;
  readonly wallOffsetMs: number;
  readonly parentItemId?: TurnItemId | null;
  readonly nodeId?: NodeId | null;
}): Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
  | "id"
  | "threadId"
  | "runId"
  | "nodeId"
  | "providerThreadId"
  | "providerTurnId"
  | "nativeItemRef"
  | "parentItemId"
  | "ordinal"
  | "status"
  | "title"
  | "startedAt"
  | "completedAt"
  | "updatedAt"
> {
  const asDateTime = (recordingTime: number) =>
    DateTime.makeUnsafe(recordingTime + input.wallOffsetMs);
  return {
    id: TurnItemId.make(input.id),
    threadId: ThreadId.make(`prototype-worklog-${input.trace.id}`),
    runId: RunId.make(`prototype-worklog-${input.trace.id}-run`),
    nodeId: input.nodeId ?? null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: input.parentItemId ?? null,
    ordinal: input.ordinal,
    status: input.status,
    title: null,
    startedAt: asDateTime(input.startedAt),
    completedAt: input.completedAt === null ? null : asDateTime(input.completedAt),
    updatedAt: asDateTime(input.updatedAt),
  };
}

function recordString(record: RecordValue | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function taskRecords(value: unknown): ReadonlyArray<TaskRecord> {
  if (!Array.isArray(value)) return [];
  return value.filter(isTaskRecord);
}

function taskRecordString(
  record: TaskRecord | undefined,
  key: keyof TaskRecord,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function firstNonEmptyString(
  ...values: ReadonlyArray<string | null | undefined>
): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value.trim().length > 0) return value;
  }
  return undefined;
}

function countDiffLines(diff: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function fileNameForTool(event: TraceToolEvent, completed: boolean): string | undefined {
  if (event.name === "edit") {
    const input = event.args.input;
    const marker = typeof input === "string" ? /^\[([^\]]+)\]/.exec(input)?.[1] : undefined;
    const tagSeparator = marker?.lastIndexOf("#") ?? -1;
    const hashlinePath =
      marker !== undefined && tagSeparator > 0 ? marker.slice(0, tagSeparator) : undefined;
    return (
      (completed ? recordString(event.details, "path") : undefined) ??
      hashlinePath ??
      recordString(event.args, "path") ??
      recordString(event.args, "file_path")
    );
  }
  return recordString(event.args, "path") ?? recordString(event.args, "file_path");
}

function toolItem(
  trace: Trace,
  event: TraceToolEvent,
  t: number,
  wallOffsetMs: number,
  ordinal: number,
): OrchestrationV2TurnItem | null {
  if (t < event.start) return null;

  const completed = t >= event.end;
  const status: ItemStatus = !completed ? "running" : event.isError ? "failed" : "completed";
  const intent =
    event.intent?.trim() ||
    recordString(event.args, "i")?.trim() ||
    recordString(event.args, "_i")?.trim() ||
    undefined;
  const id = `turn-item:${trace.id}:${event.id}`;
  const base = {
    ...itemBase({
      trace,
      id,
      ordinal,
      status,
      startedAt: event.start,
      completedAt: completed ? event.end : null,
      updatedAt: completed ? event.end : Math.min(t, event.end),
      wallOffsetMs,
    }),
    title: event.name,
    ...(intent === undefined ? {} : { intent }),
  };

  if (event.name === "bash") {
    const output =
      completed && event.output !== null && event.output.length > 0 ? { output: event.output } : {};
    const exitCodeValue = event.details?.exitCode;
    const exitCode =
      completed && typeof exitCodeValue === "number" && Number.isInteger(exitCodeValue)
        ? exitCodeValue
        : undefined;
    return {
      ...base,
      type: "command_execution",
      input: recordString(event.args, "command") ?? "",
      ...output,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  if (event.name === "write" || event.name === "edit") {
    const fileName = fileNameForTool(event, completed);
    if (fileName !== undefined) {
      const content = event.name === "write" ? recordString(event.args, "content") : undefined;
      const visibleContent =
        content === undefined
          ? undefined
          : t < event.argsEnd
            ? streamedPrefix(content, t, event.start, event.argsEnd)
            : content;
      const diffStr = completed ? recordString(event.details, "diff") : undefined;
      const diffStats = diffStr === undefined ? undefined : countDiffLines(diffStr);
      const contentStats =
        event.name === "write" && content !== undefined && !event.isError
          ? {
              additions:
                (visibleContent ?? "").length === 0
                  ? 0
                  : (visibleContent ?? "").replace(/\r?\n$/, "").split("\n").length,
              deletions: 0,
            }
          : undefined;
      const stats = diffStats ?? contentStats;
      return {
        ...base,
        type: "file_change",
        fileName,
        ...(diffStr === undefined ? {} : { diffStr }),
        ...(visibleContent === undefined ? {} : { newStr: visibleContent }),
        ...(stats === undefined ? {} : stats),
      };
    }
  }

  return {
    ...base,
    type: "dynamic_tool",
    toolName: event.name,
    input: event.args,
    ...(completed && event.output !== null && event.output.length > 0
      ? { output: event.output }
      : {}),
    ...(completed && event.details !== null ? { details: event.details } : {}),
  };
}

function textItem(
  trace: Trace,
  event: TraceTextEvent,
  t: number,
  wallOffsetMs: number,
  ordinal: number,
): OrchestrationV2TurnItem | null {
  if (t < event.start) return null;
  const streaming = t < event.end;
  const text = streaming ? streamedPrefix(event.text, t, event.start, event.end) : event.text;
  const base = itemBase({
    trace,
    id: `turn-item:${trace.id}:${event.id}`,
    ordinal,
    status: streaming ? "running" : "completed",
    startedAt: event.start,
    completedAt: streaming ? null : event.end,
    updatedAt: streaming ? Math.min(t, event.end) : event.end,
    wallOffsetMs,
  });

  if (event.kind === "thinking") {
    return { ...base, type: "reasoning", text, streaming };
  }
  return {
    ...base,
    type: "assistant_message",
    messageId: MessageId.make(`message:${trace.id}:${event.id}`),
    text,
    streaming,
  };
}

function taskSpecForSubagent(
  event: TraceToolEvent,
  subagent: TraceSubagent,
  index: number,
): TaskRecord | undefined {
  const specs = taskRecords(event.args.tasks);
  const match = specs.find(
    (spec) =>
      spec.id === subagent.id ||
      spec.jobId === subagent.id ||
      spec.agent === subagent.id ||
      spec.label === subagent.id ||
      spec.name === subagent.id,
  );
  if (match !== undefined) return match;
  if (specs.length === 1) return specs[0];
  return specs[index];
}

function resultRecordForSubagent(
  event: TraceToolEvent,
  subagent: TraceSubagent,
  index: number,
): TaskRecord | undefined {
  let records: ReadonlyArray<TaskRecord> = [];
  for (const key of ["jobs", "results", "reports", "progress"]) {
    const candidateRecords = taskRecords(event.details?.[key]);
    if (candidateRecords.length > 0) {
      records = candidateRecords;
      break;
    }
  }
  const match = records.find(
    (record) =>
      record.id === subagent.id ||
      record.jobId === subagent.id ||
      record.agent === subagent.id ||
      record.label === subagent.id ||
      record.name === subagent.id ||
      record.taskId === subagent.id,
  );
  if (match !== undefined) return match;
  if (records.length === 1 && (event.subagents?.length ?? 0) === 1) return records[0];
  return records.length === event.subagents?.length ? records[index] : undefined;
}

function taskResultText(record: TaskRecord | undefined): string | undefined {
  const result = record?.result;
  const nestedResult =
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    typeof result.content === "string"
      ? result.content
      : undefined;
  return firstNonEmptyString(
    record?.resultText,
    record?.output,
    record?.summary,
    typeof result === "string" ? result : undefined,
    nestedResult,
  );
}

function latestSubagentText(subagent: TraceSubagent, t: number): string | undefined {
  let latest: TraceTextEvent | undefined;
  for (const event of subagent.events) {
    if (event.kind !== "text" || t < event.start) continue;
    if (latest === undefined || event.start >= latest.start) latest = event;
  }
  if (latest === undefined) return undefined;
  return t < latest.end ? streamedPrefix(latest.text, t, latest.start, latest.end) : latest.text;
}

function subagentItem(
  trace: Trace,
  event: TraceToolEvent,
  subagent: TraceSubagent,
  index: number,
  t: number,
  wallOffsetMs: number,
  ordinal: number,
  parentItemId: TurnItemId,
): OrchestrationV2TurnItem | null {
  if (t < subagent.start) return null;

  const spec = taskSpecForSubagent(event, subagent, index);
  const completed = t >= subagent.end;
  const eventCompleted = t >= event.end;
  const resultRecord = eventCompleted ? resultRecordForSubagent(event, subagent, index) : undefined;
  const reportedStatus = resultRecord?.status?.toLowerCase();
  let status: ItemStatus = "running";
  if (completed) {
    if (reportedStatus === "failed" || reportedStatus === "error") status = "failed";
    else if (reportedStatus === "cancelled" || reportedStatus === "canceled") status = "cancelled";
    else if (reportedStatus === "interrupted") status = "interrupted";
    else if (reportedStatus === "waiting") status = "waiting";
    else if (eventCompleted && event.isError && (event.subagents?.length ?? 0) === 1) {
      status = "failed";
    } else {
      status = "completed";
    }
  }
  const specTitle = firstNonEmptyString(spec?.name, spec?.agent, spec?.label);
  const childText = latestSubagentText(subagent, t);
  const resultText = completed
    ? (taskResultText(resultRecord) ??
      childText ??
      (eventCompleted && (event.subagents?.length ?? 0) === 1
        ? (event.output ?? undefined)
        : undefined))
    : undefined;
  const progressText = completed ? undefined : childText;
  const prompt =
    firstNonEmptyString(
      taskRecordString(spec, "task"),
      taskRecordString(spec, "prompt"),
      taskRecordString(spec, "assignment"),
      taskRecordString(spec, "description"),
      recordString(event.args, "task"),
      recordString(event.args, "prompt"),
    ) ?? "";
  const subagentId = NodeId.make(`prototype-worklog:${trace.id}:${subagent.id}`);
  return {
    ...itemBase({
      trace,
      id: `turn-item:${trace.id}:${event.id}:subagent:${subagent.id}`,
      ordinal,
      status,
      startedAt: subagent.start,
      completedAt: completed ? subagent.end : null,
      updatedAt: completed ? subagent.end : Math.min(t, subagent.end),
      wallOffsetMs,
      parentItemId,
      nodeId: subagentId,
    }),
    type: "subagent",
    subagentId,
    origin: "provider_native",
    driver: OMP_DRIVER,
    providerInstanceId: OMP_INSTANCE_ID,
    childThreadId: null,
    prompt,
    title: specTitle ?? subagent.id,
    result: resultText?.slice(0, 10_000) ?? null,
    ...(progressText === undefined ? {} : { progress: progressText.slice(0, 200) }),
  };
}

/** Projects the OMP turn items visible at recording time `t`. */
export function turnItemsAt(
  trace: Trace,
  t: number,
  wallOffsetMs: number,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const items: OrchestrationV2TurnItem[] = [];
  const promptAt = trace.prompt.at;
  if (t >= promptAt) {
    items.push({
      ...itemBase({
        trace,
        id: `turn-item:${trace.id}:prompt`,
        ordinal: 0,
        status: "completed",
        startedAt: promptAt,
        completedAt: promptAt,
        updatedAt: promptAt,
        wallOffsetMs,
      }),
      type: "user_message",
      messageId: MessageId.make(`message:${trace.id}:prompt`),
      text: trace.prompt.text,
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    });
  }

  let ordinal = 1;
  for (const event of trace.events) {
    const eventOrdinal = ordinal++;
    const item =
      event.kind === "tool"
        ? toolItem(trace, event, t, wallOffsetMs, eventOrdinal)
        : textItem(trace, event, t, wallOffsetMs, eventOrdinal);
    if (item !== null) items.push(item);

    if (event.kind !== "tool" || event.name !== "task") continue;
    const parentItemId = TurnItemId.make(`turn-item:${trace.id}:${event.id}`);
    for (const [index, subagent] of (event.subagents ?? []).entries()) {
      const subagentOrdinal = ordinal++;
      const subagentTurnItem = subagentItem(
        trace,
        event,
        subagent,
        index,
        t,
        wallOffsetMs,
        subagentOrdinal,
        parentItemId,
      );
      if (subagentTurnItem !== null) items.push(subagentTurnItem);
    }
  }
  return items;
}
function sameReplayValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (
      !rightKeys.includes(key) ||
      !sameReplayValue(Reflect.get(left, key), Reflect.get(right, key))
    ) {
      return false;
    }
  }
  return true;
}

function sameReplayItem(previous: OrchestrationV2TurnItem, next: OrchestrationV2TurnItem): boolean {
  if (previous.status !== next.status) return false;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of previousKeys) {
    if (key === "updatedAt" && previous.status === "running") continue;
    if (
      !nextKeys.includes(key) ||
      !sameReplayValue(Reflect.get(previous, key), Reflect.get(next, key))
    ) {
      return false;
    }
  }
  return true;
}

/** Projects a replay while keeping unchanged OMP items and arrays stable. */
export function createTurnItemsProjector(trace: Trace, wallOffsetMs: number) {
  let previousItems: ReadonlyArray<OrchestrationV2TurnItem> = [];
  let previousById = new Map<string, OrchestrationV2TurnItem>();

  return (t: number): ReadonlyArray<OrchestrationV2TurnItem> => {
    const projected = turnItemsAt(trace, t, wallOffsetMs);
    const nextItems = projected.map((item) => {
      const previous = previousById.get(item.id);
      return previous !== undefined && sameReplayItem(previous, item) ? previous : item;
    });
    if (
      nextItems.length === previousItems.length &&
      nextItems.every((item, index) => item === previousItems[index])
    ) {
      return previousItems;
    }

    previousItems = nextItems;
    previousById = new Map(nextItems.map((item) => [item.id, item]));
    return nextItems;
  };
}
