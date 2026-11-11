import { TurnItemId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { ThreadActivityPageRequest } from "@t3tools/client-runtime/state/threads";
import type { TimelineActivityGroup } from "./timelineActivity";

export type TimelineActivityEntry = {
  readonly id: string;
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem | undefined;
  readonly entry?: {
    readonly projectedItem?: OrchestrationV2ProjectedTurnItem | undefined;
  };
};

function projectedItemForEntry(
  entry: TimelineActivityEntry,
): OrchestrationV2ProjectedTurnItem | undefined {
  return entry.projectedItem ?? entry.entry?.projectedItem;
}

export function activityGroupForEntry(
  entry: TimelineActivityEntry,
  groups: ReadonlyArray<TimelineActivityGroup>,
): TimelineActivityGroup | undefined {
  const projectedItem = projectedItemForEntry(entry);
  if (!projectedItem) return undefined;
  const sourceThreadId = String(
    projectedItem.orderKey?.sourceThreadId ?? projectedItem.sourceThreadId,
  );
  const ordinal = projectedItem.orderKey?.ordinal ?? projectedItem.item.ordinal;
  return groups.find(
    ({ summary }) =>
      String(summary.sourceThreadId) === sourceThreadId &&
      ordinal >= summary.firstOrdinal &&
      ordinal <= summary.lastOrdinal,
  );
}

export function activityGroupForTarget(
  entryId: string,
  groups: ReadonlyArray<TimelineActivityGroup>,
  runId?: string | null,
): TimelineActivityGroup | undefined {
  const byItemId = groups.find(({ summary }) =>
    [summary.groupStartItemId, summary.firstItemId, summary.lastItemId].some(
      (itemId) => String(itemId) === entryId,
    ),
  );
  if (byItemId || runId == null) return byItemId;
  const byRun = groups.filter(({ summary }) => String(summary.runId) === runId);
  return byRun.length === 1 ? byRun[0] : undefined;
}

export function activityPageRequest(
  entryId: string,
  entry: TimelineActivityEntry | undefined,
  group: TimelineActivityGroup | undefined,
): ThreadActivityPageRequest {
  const projectedItem = entry === undefined ? undefined : projectedItemForEntry(entry);
  return {
    anchorItemId: projectedItem?.sourceItemId ?? TurnItemId.make(entryId),
    ...(group === undefined ? {} : { sourceThreadId: group.summary.sourceThreadId }),
  };
}
