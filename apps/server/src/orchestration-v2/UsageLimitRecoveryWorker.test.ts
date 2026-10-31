import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs));
  });
});

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const now = DateTime.makeUnsafe(startMs);
    const threadId = ThreadId.make("thread:idle-limit-recovery");
    yield* TestClock.setTime(startMs);
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const irrelevantItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("turn-item:idle-limit-recovery"),
      type: "assistant_message",
      messageId: MessageId.make("message:idle-limit-recovery"),
      text: "A settled assistant message does not change recovery candidates.",
      streaming: false,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const irrelevantEvent: OrchestrationV2DomainEvent = {
      id: EventId.make("event:idle-limit-recovery:assistant"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: irrelevantItem,
    };
    const requestId = RuntimeRequestId.make("request:idle-limit-recovery");
    const nodeId = NodeId.make("node:idle-limit-recovery");
    const relevantEvent: OrchestrationV2DomainEvent = {
      id: EventId.make("event:idle-limit-recovery:request"),
      type: "runtime-request.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    };
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          ServerSettings.layerTest(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: ({ now: checkedAt }) =>
              Queue.offer(queries, DateTime.toEpochMillis(checkedAt) - startMs).pipe(Effect.as([])),
            getLimitRecoveryWakeAt: (checkedAt) =>
              Effect.succeed(
                DateTime.toEpochMillis(checkedAt) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, irrelevantEvent);
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.size(queries), 0);
      yield* Queue.offer(events, relevantEvent);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);
