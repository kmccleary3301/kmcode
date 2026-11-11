import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadActivityRow,
  OrchestrationV2ThreadActivitySummary,
} from "@t3tools/contracts";
import {
  activityGroupLoadState,
  activityRowsForGroup,
  type ThreadActivityPageRequest,
  type ThreadActivityState,
} from "@t3tools/client-runtime/state/threads";

/**
 * A summary-backed activity group as the timeline sees it. `summary` describes
 * the whole group. `loaded*` describe only the rows currently in memory, so the
 * timeline must never present loaded rows as the complete group.
 */
export interface TimelineActivityGroup {
  readonly key: string;
  readonly summary: OrchestrationV2ThreadActivitySummary;
  /** Rows fetched from activity pages or received live; snapshot rows are not page windows. */
  readonly loadedCount: number;
  readonly loadedFirstOrdinal: number | null;
  readonly loadedFirstItemId: string | null;
  readonly loadedLastOrdinal: number | null;
  readonly loadedLastItemId: string | null;
  /** Centered on the newest summary row; used when a group is expanded before any page loads. */
  readonly initialRequest: ThreadActivityPageRequest;
  /** Page request for activity above the loaded rows; null when none is missing. */
  readonly previousRequest: ThreadActivityPageRequest | null;
  /** Page request for activity below the loaded rows; null when none is missing. */
  readonly nextRequest: ThreadActivityPageRequest | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function compareWithinSource(
  left: OrchestrationV2ProjectedTurnItem,
  right: OrchestrationV2ProjectedTurnItem,
): number {
  return (
    (left.orderKey?.ordinal ?? left.item.ordinal) -
      (right.orderKey?.ordinal ?? right.item.ordinal) ||
    String(left.orderKey?.itemId ?? left.sourceItemId).localeCompare(
      String(right.orderKey?.itemId ?? right.sourceItemId),
    )
  );
}

export function activityRowToProjectedItem(
  row: OrchestrationV2ThreadActivityRow,
): OrchestrationV2ProjectedTurnItem {
  return {
    position: row.ordinal,
    visibility: row.visibility,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
    orderKey: row.orderKey,
  };
}

/**
 * Adds rows held only by the activity store (paged windows and live rows) to the
 * bounded snapshot's visible items. Rows already present keep their snapshot
 * copy. Legacy sessions return the input unchanged so their timeline is untouched.
 */
export function mergeActivityRowsIntoVisibleItems(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  activity: ThreadActivityState,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  if (activity.mode !== "summary-v1") return visibleTurnItems;
  const present = new Set(
    visibleTurnItems.map((item) => JSON.stringify([item.sourceThreadId, item.sourceItemId])),
  );
  const rowsBySource = new Map<string, OrchestrationV2ProjectedTurnItem[]>();
  for (const group of activity.groups.values()) {
    for (const row of [...group.windows.flatMap((window) => window.rows), ...group.liveRows]) {
      const key = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
      if (present.has(key)) continue;
      present.add(key);
      const sourceId = String(row.orderKey.sourceThreadId);
      const rows = rowsBySource.get(sourceId) ?? [];
      rows.push(activityRowToProjectedItem(row));
      rowsBySource.set(sourceId, rows);
    }
  }
  if (rowsBySource.size === 0) return visibleTurnItems;

  // Projection positions are globally ordered; activity ordinals are only
  // comparable within a source thread. Insert each page row beside its source
  // neighbors without re-sorting the existing projection across sources.
  const merged = [...visibleTurnItems];
  for (const rows of rowsBySource.values()) {
    rows.sort(compareWithinSource);
    for (const row of rows) {
      const sourceId = String(row.orderKey?.sourceThreadId ?? row.sourceThreadId);
      let insertionIndex = -1;
      let lastSourceIndex = -1;
      for (let index = 0; index < merged.length; index += 1) {
        const candidate = merged[index]!;
        if (String(candidate.orderKey?.sourceThreadId ?? candidate.sourceThreadId) !== sourceId)
          continue;
        lastSourceIndex = index;
        if (compareWithinSource(candidate, row) > 0) {
          insertionIndex = index;
          break;
        }
      }
      const at =
        insertionIndex >= 0
          ? insertionIndex
          : lastSourceIndex >= 0
            ? lastSourceIndex + 1
            : merged.length;
      merged.splice(at, 0, row);
    }
  }
  return merged.map((row, position) => (row.position === position ? row : { ...row, position }));
}

/**
 * Builds paging state for each summary independently of snapshot activity rows.
 * Windows and live rows describe loaded activity; the summary remains complete.
 */
export function deriveTimelineActivityGroups(
  activity: ThreadActivityState,
): ReadonlyArray<TimelineActivityGroup> {
  if (activity.mode !== "summary-v1") return [];
  const groups: TimelineActivityGroup[] = [];
  for (const [key, group] of activity.groups) {
    const { summary } = group;
    const rows = activityRowsForGroup(activity, key);
    const first = rows[0] ?? null;
    const last = rows.at(-1) ?? null;
    const base = {
      sourceThreadId: summary.sourceThreadId,
      groupStartItemId: summary.groupStartItemId,
    } as const;
    const initialRequest: ThreadActivityPageRequest = {
      ...base,
      anchorItemId: summary.lastItemId,
    };
    const firstWindow = group.windows[0];
    const lastWindow = group.windows.at(-1);
    const previousRequest: ThreadActivityPageRequest | null =
      firstWindow?.hasPrevious && firstWindow.previousCursor !== null
        ? { ...base, cursor: firstWindow.previousCursor, direction: "previous" }
        : firstWindow === undefined && first !== null && first.ordinal > summary.firstOrdinal
          ? { ...base, anchorItemId: first.sourceItemId, direction: "previous" }
          : null;
    const nextRequest: ThreadActivityPageRequest | null =
      lastWindow?.hasNext && lastWindow.nextCursor !== null
        ? { ...base, cursor: lastWindow.nextCursor, direction: "next" }
        : lastWindow === undefined && last !== null && last.ordinal < summary.lastOrdinal
          ? { ...base, anchorItemId: last.sourceItemId, direction: "next" }
          : null;
    const loadState = activityGroupLoadState(group);
    groups.push({
      key,
      summary,
      loadedCount: rows.length,
      loadedFirstOrdinal: first?.ordinal ?? null,
      loadedFirstItemId: first === null ? null : String(first.sourceItemId),
      loadedLastOrdinal: last?.ordinal ?? null,
      loadedLastItemId: last === null ? null : String(last.sourceItemId),
      initialRequest,
      previousRequest,
      nextRequest,
      loading: loadState.loading,
      error: loadState.error,
    });
  }
  return groups;
}
