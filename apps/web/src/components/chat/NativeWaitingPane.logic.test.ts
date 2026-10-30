import * as DateTime from "effect/DateTime";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isNativeWaitTool, readNativeWaitState } from "./NativeWaitingPane.logic";

const timestamp = DateTime.makeUnsafe("2026-10-14T12:00:00.000Z");
type DynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
type NativeSubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
type NativeNoticeItem = Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;

const itemBase = {
  threadId: ThreadId.make("native-wait-thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: timestamp,
  completedAt: null,
  updatedAt: timestamp,
} satisfies Pick<
  OrchestrationV2TurnItem,
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
>;

function waitItem(
  details: unknown,
  status: DynamicToolItem["status"] = "running",
): DynamicToolItem {
  return {
    ...itemBase,
    id: TurnItemId.make("native-hub-wait"),
    type: "dynamic_tool",
    toolName: "hub",
    input: { op: "wait" },
    details,
    status,
    completedAt: status === "running" ? null : timestamp,
  };
}

function subagentItem(
  nativeAgentId: string,
  status: NativeSubagentItem["status"],
  completionPercent?: number,
): NativeSubagentItem {
  const subagentId = NodeId.make(`node:subagent:${nativeAgentId}`);
  return {
    ...itemBase,
    id: TurnItemId.make(`turn-item:subagent:${nativeAgentId}`),
    nodeId: subagentId,
    type: "subagent",
    status,
    subagentId,
    origin: "provider_native",
    driver: ProviderDriverKind.make("omp"),
    providerInstanceId: ProviderInstanceId.make("omp"),
    childThreadId: null,
    prompt: "Run the requested task",
    result: null,
    title: "Task worker",
    nativeAgentId,
    startedAt: DateTime.makeUnsafe("2026-10-14T11:59:00.000Z"),
    completedAt: status === "running" ? null : timestamp,
    ...(completionPercent === undefined ? {} : { completionPercent }),
  };
}

function completionNotice(
  jobCompletion: NonNullable<NativeNoticeItem["jobCompletion"]>,
): NativeNoticeItem {
  return {
    ...itemBase,
    id: TurnItemId.make(`notice:${jobCompletion.jobId}`),
    type: "system_notice",
    status: "completed",
    message: "Background job completed",
    completedAt: timestamp,
    jobCompletion,
  };
}

describe("readNativeWaitState", () => {
  it("reads reported job kinds and only takes task progress from a matching task item", () => {
    const state = readNativeWaitState(
      waitItem({
        op: "wait",
        jobs: [
          {
            id: "bash-1",
            type: "bash",
            status: "running",
            label: "Compile server",
            durationMs: 12_000,
          },
          {
            id: "task-1",
            type: "task",
            status: "running",
            label: "Task worker",
            durationMs: 8_000,
          },
          {
            id: "eval-1",
            type: "eval",
            status: "completed",
            label: "Check output",
            durationMs: 4_000,
          },
        ],
      }),
      [subagentItem("task-1", "running", 42)],
    );

    expect(state).toMatchObject({
      waiting: true,
      jobs: [
        {
          id: "bash-1",
          type: "bash",
          status: "running",
          label: "Compile server",
          completionPercent: null,
        },
        { id: "task-1", type: "task", status: "running", completionPercent: 42 },
        { id: "eval-1", type: "eval", status: "completed", completionPercent: null },
      ],
    });
  });

  it("uses explicit terminal job events to clear a stale running wait snapshot", () => {
    const state = readNativeWaitState(
      waitItem({
        op: "wait",
        jobs: [
          {
            id: "bash-1",
            type: "bash",
            status: "running",
            label: "Compile server",
            durationMs: 12_000,
          },
          {
            id: "task-1",
            type: "task",
            status: "running",
            label: "Task worker",
            durationMs: 8_000,
          },
          {
            id: "eval-1",
            type: "eval",
            status: "running",
            label: "Check output",
            durationMs: 4_000,
          },
        ],
      }),
      [
        completionNotice({
          jobId: "bash-1",
          type: "bash",
          status: "failed",
          label: "Compile server",
          durationMs: 15_000,
        }),
        subagentItem("task-1", "failed", 42),
        completionNotice({
          jobId: "eval-1",
          type: "eval",
          status: "cancelled",
          label: "Check output",
          durationMs: 6_000,
        }),
      ],
    );

    expect(state).toMatchObject({
      waiting: false,
      jobs: [
        { id: "bash-1", status: "failed", durationMs: 15_000 },
        { id: "task-1", status: "failed", durationMs: 60_000, completionPercent: 42 },
        { id: "eval-1", status: "cancelled", durationMs: 6_000 },
      ],
    });
  });

  it("keeps a completed historical wait and its old running durations frozen", () => {
    const state = readNativeWaitState(
      waitItem(
        {
          op: "wait",
          jobs: [
            {
              id: "bash-1",
              type: "bash",
              status: "running",
              label: "Compile server",
              durationMs: 12_000,
            },
          ],
        },
        "completed",
      ),
    );

    expect(state).toMatchObject({
      waiting: false,
      jobs: [{ id: "bash-1", status: "running", durationMs: 12_000 }],
    });
  });

  it("classifies a hub wait before details are hydrated without inventing rows", () => {
    const item = waitItem({ summary: "details are not available yet" });
    expect(isNativeWaitTool(item)).toBe(true);
    expect(readNativeWaitState(item)).toBeNull();
  });

  it("does not infer jobs from other tools, prose, or summarized details", () => {
    expect(
      readNativeWaitState({
        ...waitItem({ op: "wait", jobs: [{ id: "bash-1", type: "bash", status: "running" }] }),
        toolName: "other",
      }),
    ).toBeNull();
    expect(readNativeWaitState(waitItem({ summary: "waiting for shell jobs" }))).toBeNull();
    expect(readNativeWaitState({ ...waitItem({ jobs: [] }), input: { op: "jobs" } })).toBeNull();
  });

  it("draws a T3 thread wait from the delegated child it waits on", () => {
    const threadWait = (status: DynamicToolItem["status"]): DynamicToolItem => ({
      ...waitItem(undefined, status),
      toolName: "mcp__t3-code__t3_thread_wait",
      input: { threadId: "child-thread" },
    });
    const child = (status: NativeSubagentItem["status"]): NativeSubagentItem => ({
      ...subagentItem("delegate", status, 40),
      origin: "app_owned",
      title: "Schema reviewer",
      childThreadId: ThreadId.make("child-thread"),
    });

    expect(isNativeWaitTool(threadWait("running"))).toBe(true);
    expect(readNativeWaitState(threadWait("running"), [child("running")])).toEqual({
      jobs: [
        {
          id: "child-thread",
          type: "thread",
          status: "running",
          label: "Schema reviewer",
          durationMs: 60_000,
          completionPercent: 40,
        },
      ],
      waiting: true,
      snapshotAtMs: DateTime.toEpochMillis(timestamp),
    });
    // A wait that timed out leaves its child running; the child's own status wins.
    expect(readNativeWaitState(threadWait("completed"), [child("running")])).toMatchObject({
      jobs: [{ status: "running" }],
      waiting: false,
    });
    expect(readNativeWaitState(threadWait("completed"), [child("completed")])).toMatchObject({
      jobs: [{ status: "completed", durationMs: 60_000 }],
    });
    // Without a subagent item the thread is only known while the wait runs.
    expect(readNativeWaitState(threadWait("completed"), [])).toMatchObject({
      jobs: [{ id: "child-thread", status: "unknown", label: null }],
    });
  });
});
