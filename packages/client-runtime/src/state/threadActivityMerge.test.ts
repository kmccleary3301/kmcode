import {
  OrchestrationV2ThreadActivityRow as OrchestrationV2ThreadActivityRowSchema,
  type OrchestrationV2ThreadActivityPage,
  type OrchestrationV2ThreadActivityRow,
  type OrchestrationV2ThreadActivitySummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import {
  EMPTY_THREAD_ACTIVITY_STATE,
  activityGroupKey,
  activityPageRequestKey,
  activityRowsForGroup,
  activitySummaryRefreshRequestsForLiveRow,
  beginThreadActivityRequest,
  failThreadActivityRequest,
  mergeThreadActivityLiveRow,
  mergeThreadActivityPage,
  threadActivityStateFromSnapshot,
} from "./threadActivityMerge.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const RUN_ID = "run-activity" as never;
const GROUP_START_ID = "group-start" as never;
const TURN_START_ID = "turn-start" as never;

function summary(lastOrdinal = 4): OrchestrationV2ThreadActivitySummary {
  return {
    sourceThreadId: v2ThreadId,
    groupStartItemId: GROUP_START_ID,
    turnStartItemId: TURN_START_ID,
    runId: RUN_ID,
    firstItemId: "item-1" as never,
    firstOrdinal: 1,
    lastItemId: `item-${lastOrdinal}` as never,
    lastOrdinal,
    activityCount: lastOrdinal,
    countsByType: [{ type: "command_execution", count: lastOrdinal }],
    statusCounts: [{ status: "completed", count: lastOrdinal }],
    runStatus: "completed",
    stepCount: lastOrdinal,
    filesEditedCount: 1,
    diffStats: { added: 4, removed: 2 },
    hasFailure: false,
    labelPreview: "Read files",
    intentPreview: "Inspecting the project",
    startedAt: NOW,
    endedAt: NOW,
  };
}
const decodeActivityRow = Schema.decodeUnknownSync(OrchestrationV2ThreadActivityRowSchema);

function row(ordinal: number, updatedAt = NOW): OrchestrationV2ThreadActivityRow {
  const id = `item-${ordinal}` as never;
  return decodeActivityRow({
    sourceThreadId: v2ThreadId,
    sourceItemId: id,
    visibility: "local",
    ordinal,
    item: {
      id,
      type: "command_execution",
      threadId: v2ThreadId,
      runId: RUN_ID,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: `Command ${ordinal}`,
      input: `cmd-${ordinal}`,
      output: `out-${ordinal}`,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt,
    },
    orderKey: { sourceThreadId: v2ThreadId, ordinal, itemId: id },
  });
}

function page(input: {
  readonly sequence: number;
  readonly rows: ReadonlyArray<OrchestrationV2ThreadActivityRow>;
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly summary?: OrchestrationV2ThreadActivitySummary;
}): OrchestrationV2ThreadActivityPage {
  return {
    snapshotSequence: input.sequence,
    sourceThreadId: v2ThreadId,
    groupStartItemId: GROUP_START_ID,
    summary: input.summary ?? summary(),
    items: input.rows,
    previousCursor: input.previousCursor,
    nextCursor: input.nextCursor,
    hasPrevious: input.hasPrevious,
    hasNext: input.hasNext,
  };
}

describe("threadActivityMerge", () => {
  it("joins sequential windows, preserves order, and uses the newest duplicate row", () => {
    const initial = threadActivityStateFromSnapshot({
      snapshotSequence: 10,
      activitySummaries: [summary()],
    });
    const newerItem = row(2, DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"));
    const first = mergeThreadActivityPage(
      initial,
      page({
        sequence: 10,
        rows: [row(1), newerItem],
        previousCursor: null,
        nextCursor: "after-item-2",
        hasPrevious: false,
        hasNext: true,
      }),
      { direction: "next" },
    );
    const second = mergeThreadActivityPage(
      first,
      page({
        sequence: 12,
        rows: [row(2), row(3)],
        previousCursor: "before-item-3",
        nextCursor: null,
        hasPrevious: true,
        hasNext: false,
        summary: summary(3),
      }),
      { cursor: "after-item-2", direction: "next" },
    );
    const key = activityGroupKey(v2ThreadId, GROUP_START_ID);

    expect(activityRowsForGroup(second, key).map((entry) => entry.sourceItemId)).toEqual([
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(activityRowsForGroup(second, key)[1]?.item.updatedAt).toBe(newerItem.item.updatedAt);
    expect(second.groups.get(key)?.windows).toHaveLength(1);
    expect(second.groups.get(key)?.summary.stepCount).toBe(3);
    expect(second.groups.get(key)?.windows[0]).toMatchObject({
      previousCursor: null,
      nextCursor: null,
      hasPrevious: false,
      hasNext: false,
    });
  });

  it("keeps an anchor window separate from unloaded gaps and dedupes its overlap", () => {
    const initial = threadActivityStateFromSnapshot({
      snapshotSequence: 20,
      activitySummaries: [summary(9)],
    });
    const first = mergeThreadActivityPage(
      initial,
      page({
        sequence: 20,
        rows: [row(1), row(2)],
        previousCursor: null,
        nextCursor: "after-item-2",
        hasPrevious: false,
        hasNext: true,
      }),
      { direction: "next" },
    );
    const anchored = mergeThreadActivityPage(
      first,
      page({
        sequence: 21,
        rows: [row(7), row(8)],
        previousCursor: "before-item-7",
        nextCursor: "after-item-8",
        hasPrevious: true,
        hasNext: true,
      }),
      { anchorItemId: "item-8" as never },
    );
    const key = activityGroupKey(v2ThreadId, GROUP_START_ID);

    expect(activityRowsForGroup(anchored, key).map((entry) => entry.sourceItemId)).toEqual([
      "item-1",
      "item-2",
      "item-7",
      "item-8",
    ]);
    expect(anchored.groups.get(key)?.windows).toHaveLength(2);
    expect(anchored.groups.get(key)?.windows[1]).toMatchObject({
      previousCursor: "before-item-7",
      nextCursor: "after-item-8",
      hasPrevious: true,
      hasNext: true,
    });
  });

  it("reconciles a live update and append without duplicating page rows", () => {
    const initial = threadActivityStateFromSnapshot({
      snapshotSequence: 30,
      activitySummaries: [summary(2)],
    });
    const paged = mergeThreadActivityPage(
      initial,
      page({
        sequence: 30,
        rows: [row(1), row(2)],
        previousCursor: null,
        nextCursor: null,
        hasPrevious: false,
        hasNext: false,
      }),
      { direction: "next" },
    );
    const update = row(2, DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"));
    const appended = row(3, DateTime.makeUnsafe("2026-06-20T00:00:03.000Z"));
    const live = mergeThreadActivityLiveRow(mergeThreadActivityLiveRow(paged, update), appended);
    const key = activityGroupKey(v2ThreadId, GROUP_START_ID);

    expect(activityRowsForGroup(live, key).map((entry) => entry.sourceItemId)).toEqual([
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(activityRowsForGroup(live, key)[1]?.item.updatedAt).toBe(update.item.updatedAt);
    expect(activityRowsForGroup(live, key)[2]?.item.updatedAt).toBe(appended.item.updatedAt);
  });
  it("keeps runless live updates ahead of stale HTTP rows and refreshes their summary", () => {
    const runlessSummary = { ...summary(2), turnStartItemId: null, runId: null };
    const initial = threadActivityStateFromSnapshot({
      snapshotSequence: 30,
      activitySummaries: [runlessSummary],
    });
    const liveRow = row(2, DateTime.makeUnsafe("2026-06-19T00:00:00.000Z"));
    const live = mergeThreadActivityLiveRow(initial, liveRow, 32);
    const stale = mergeThreadActivityPage(
      live,
      page({
        sequence: 31,
        rows: [row(2, DateTime.makeUnsafe("2026-06-20T00:00:05.000Z"))],
        previousCursor: "before-item-2",
        nextCursor: "after-item-2",
        hasPrevious: true,
        hasNext: true,
        summary: { ...runlessSummary, activityCount: 1, stepCount: 1 },
      }),
      { anchorItemId: "item-2" as never },
    );
    const key = activityGroupKey(v2ThreadId, GROUP_START_ID);

    expect(stale.groups.get(key)).toMatchObject({
      summaryStale: true,
      summary: { runId: null, stepCount: 2 },
    });
    expect(activityRowsForGroup(stale, key)[0]?.item.updatedAt).toBe(liveRow.item.updatedAt);

    const refreshed = mergeThreadActivityPage(
      stale,
      page({
        sequence: 32,
        rows: [row(2, DateTime.makeUnsafe("2026-06-20T00:00:06.000Z"))],
        previousCursor: null,
        nextCursor: null,
        hasPrevious: false,
        hasNext: false,
        summary: runlessSummary,
      }),
      { anchorItemId: "item-2" as never },
    );
    expect(refreshed.groups.get(key)).toMatchObject({
      summaryStale: false,
      summary: runlessSummary,
    });
    expect(activityRowsForGroup(refreshed, key)[0]?.item.updatedAt).toStrictEqual(
      DateTime.makeUnsafe("2026-06-20T00:00:06.000Z"),
    );
  });

  it("ignores a page from an older snapshot without merging its rows", () => {
    const current = threadActivityStateFromSnapshot({
      snapshotSequence: 50,
      activitySummaries: [summary(4)],
    });
    const request = { sourceThreadId: v2ThreadId, groupStartItemId: GROUP_START_ID, cursor: "c-1" };
    const pending = beginThreadActivityRequest(current, request);
    const stale = mergeThreadActivityPage(
      pending,
      page({
        sequence: 40,
        rows: [row(2)],
        previousCursor: null,
        nextCursor: null,
        hasPrevious: false,
        hasNext: false,
      }),
      request,
    );
    expect(stale.groups.get(activityGroupKey(v2ThreadId, GROUP_START_ID))?.windows).toEqual([]);
    expect(stale.loadingRequestKeys.has(activityPageRequestKey(request))).toBe(false);
    expect(stale.snapshotSequence).toBe(50);
  });

  it("clears a failed request's error when the retry begins", () => {
    const current = threadActivityStateFromSnapshot({
      snapshotSequence: 50,
      activitySummaries: [summary(4)],
    });
    const request = { anchorItemId: "item-2" as never };
    const requestKey = activityPageRequestKey(request);
    const failed = failThreadActivityRequest(current, request, "network down");
    expect(failed.errorsByRequestKey.get(requestKey)).toBe("network down");
    const retrying = beginThreadActivityRequest(failed, request);
    expect(retrying.errorsByRequestKey.has(requestKey)).toBe(false);
    expect(retrying.loadingRequestKeys.has(requestKey)).toBe(true);
  });

  it("sends no summary refresh for a legacy session", () => {
    expect(activitySummaryRefreshRequestsForLiveRow(EMPTY_THREAD_ACTIVITY_STATE, row(2))).toEqual(
      [],
    );
  });

  it("coalesces refreshes per group and sends an anchor-only request for unscoped rows", () => {
    const state = threadActivityStateFromSnapshot({
      snapshotSequence: 50,
      activitySummaries: [summary(4)],
    });
    expect(activitySummaryRefreshRequestsForLiveRow(state, row(2))).toEqual([
      { sourceThreadId: v2ThreadId, groupStartItemId: GROUP_START_ID, summaryOnly: true },
    ]);
    const burstKeys = [row(2), row(3)]
      .flatMap((live) => activitySummaryRefreshRequestsForLiveRow(state, live))
      .map(activityPageRequestKey);
    expect(new Set(burstKeys).size).toBe(1);
    const stray = { ...row(9), item: { ...row(9).item, runId: null } };
    expect(activitySummaryRefreshRequestsForLiveRow(state, stray)).toEqual([
      { anchorItemId: "item-9", summaryOnly: true },
    ]);
  });
});
