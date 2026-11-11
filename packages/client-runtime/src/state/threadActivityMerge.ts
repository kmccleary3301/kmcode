import type {
  OrchestrationV2ThreadActivityPage,
  OrchestrationV2ThreadActivityRow,
  OrchestrationV2ThreadActivitySummary,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadActivityPageDirection = "previous" | "next";

export interface ThreadActivityPageWindow {
  readonly rows: ReadonlyArray<OrchestrationV2ThreadActivityRow>;
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export interface ThreadActivityLiveAnchor {
  readonly itemId: TurnItemId;
  readonly sequence: number;
}

export interface ThreadActivityGroupState {
  readonly summary: OrchestrationV2ThreadActivitySummary;
  readonly summarySequence: number;
  /** Separate windows preserve gaps created by direct search/citation jumps. */
  readonly windows: ReadonlyArray<ThreadActivityPageWindow>;
  /** Live rows are retained separately from indexed pages until a newer page covers them. */
  readonly liveRows: ReadonlyArray<OrchestrationV2ThreadActivityRow>;
  readonly liveSequenceByRowKey: ReadonlyMap<string, number>;
  readonly loadingRequestKeys: ReadonlySet<string>;
  readonly errorsByRequestKey: ReadonlyMap<string, string>;
  readonly latestLiveSequence: number;
  readonly summaryStale: boolean;
}

export interface ThreadActivityState {
  readonly mode: "legacy" | "summary-v1";
  readonly snapshotSequence: number | null;
  /** Changes only when negotiated capability is installed or downgraded. */
  readonly generation: number;
  readonly groups: ReadonlyMap<string, ThreadActivityGroupState>;
  /** Latest unresolved live item per source until an indexed summary resolves its group. */
  readonly unscopedLiveAnchors: ReadonlyMap<string, ThreadActivityLiveAnchor>;
  /** Requests such as an anchored find whose group is not known until the response. */
  readonly loadingRequestKeys: ReadonlySet<string>;
  readonly errorsByRequestKey: ReadonlyMap<string, string>;
}

export interface ThreadActivityPageRequest {
  readonly sourceThreadId?: ThreadId;
  readonly groupStartItemId?: TurnItemId;
  readonly cursor?: string;
  readonly anchorItemId?: TurnItemId;
  readonly summaryOnly?: boolean;
  /** Local merge direction; not sent over HTTP because it is encoded in the cursor. */
  readonly direction?: ThreadActivityPageDirection;
}

export const EMPTY_THREAD_ACTIVITY_STATE: ThreadActivityState = {
  mode: "legacy",
  snapshotSequence: null,
  generation: 0,
  groups: new Map(),
  unscopedLiveAnchors: new Map(),
  loadingRequestKeys: new Set(),
  errorsByRequestKey: new Map(),
};

export function resetThreadActivityState(current: ThreadActivityState): ThreadActivityState {
  return {
    ...EMPTY_THREAD_ACTIVITY_STATE,
    generation: current.generation + 1,
  };
}

export function activityGroupKey(sourceThreadId: ThreadId, groupStartItemId: TurnItemId): string {
  return JSON.stringify([sourceThreadId, groupStartItemId]);
}

export function activityPageRequestKey(request: ThreadActivityPageRequest): string {
  return JSON.stringify([
    request.sourceThreadId ?? null,
    request.groupStartItemId ?? null,
    request.cursor ?? null,
    request.anchorItemId ?? null,
    request.summaryOnly === true,
  ]);
}

function rowKey(row: OrchestrationV2ThreadActivityRow): string {
  return JSON.stringify([row.sourceThreadId, row.sourceItemId]);
}

function rowTime(row: OrchestrationV2ThreadActivityRow): number {
  return DateTime.toEpochMillis(row.item.updatedAt);
}

function preferNewerRow(
  current: OrchestrationV2ThreadActivityRow,
  incoming: OrchestrationV2ThreadActivityRow,
): OrchestrationV2ThreadActivityRow {
  return rowTime(incoming) >= rowTime(current) ? incoming : current;
}

function compareActivityRows(
  left: OrchestrationV2ThreadActivityRow,
  right: OrchestrationV2ThreadActivityRow,
): number {
  return (
    String(left.orderKey.sourceThreadId).localeCompare(String(right.orderKey.sourceThreadId)) ||
    left.orderKey.ordinal - right.orderKey.ordinal ||
    String(left.orderKey.itemId).localeCompare(String(right.orderKey.itemId))
  );
}

function compareWindowsByStart(
  left: ThreadActivityPageWindow,
  right: ThreadActivityPageWindow,
): number {
  const leftFirst = left.rows[0];
  const rightFirst = right.rows[0];
  if (leftFirst === undefined || rightFirst === undefined) {
    return leftFirst === undefined ? (rightFirst === undefined ? 0 : 1) : -1;
  }
  return compareActivityRows(leftFirst, rightFirst);
}

function mergeRows(
  current: ReadonlyArray<OrchestrationV2ThreadActivityRow>,
  incoming: ReadonlyArray<OrchestrationV2ThreadActivityRow>,
): OrchestrationV2ThreadActivityRow[] {
  const rowsByKey = new Map<string, OrchestrationV2ThreadActivityRow>();
  for (const row of current) rowsByKey.set(rowKey(row), row);
  for (const row of incoming) {
    const key = rowKey(row);
    const previous = rowsByKey.get(key);
    rowsByKey.set(key, previous === undefined ? row : preferNewerRow(previous, row));
  }
  return Array.from(rowsByKey.values()).sort(compareActivityRows);
}

function groupState(
  summary: OrchestrationV2ThreadActivitySummary,
  summarySequence: number,
  previous?: ThreadActivityGroupState,
): ThreadActivityGroupState {
  const latestLiveSequence = previous?.latestLiveSequence ?? -1;
  const keepsPreviousSummary =
    previous !== undefined &&
    (previous.summarySequence > summarySequence || latestLiveSequence > summarySequence);
  return {
    summary: keepsPreviousSummary ? previous.summary : summary,
    summarySequence: keepsPreviousSummary
      ? previous.summarySequence
      : Math.max(summarySequence, previous?.summarySequence ?? -1),
    windows: previous?.windows ?? [],
    liveRows: previous?.liveRows ?? [],
    liveSequenceByRowKey: previous?.liveSequenceByRowKey ?? new Map(),
    latestLiveSequence,
    loadingRequestKeys: previous?.loadingRequestKeys ?? new Set(),
    errorsByRequestKey: previous?.errorsByRequestKey ?? new Map(),
    summaryStale: keepsPreviousSummary
      ? previous.summaryStale || latestLiveSequence > previous.summarySequence
      : false,
  };
}

export function threadActivityStateFromSnapshot(input: {
  readonly snapshotSequence: number;
  readonly activitySummaries: ReadonlyArray<OrchestrationV2ThreadActivitySummary>;
}): ThreadActivityState {
  return mergeThreadActivitySummaries(EMPTY_THREAD_ACTIVITY_STATE, input);
}

/** Replaces the summary set from a snapshot; groups it omits are dropped, retained groups keep their windows. */
export function mergeThreadActivitySummaries(
  current: ThreadActivityState,
  input: {
    readonly snapshotSequence: number;
    readonly activitySummaries: ReadonlyArray<OrchestrationV2ThreadActivitySummary>;
  },
): ThreadActivityState {
  if (current.snapshotSequence !== null && input.snapshotSequence < current.snapshotSequence) {
    return current;
  }
  const groups = new Map<string, ThreadActivityGroupState>();
  for (const summary of input.activitySummaries) {
    const key = activityGroupKey(summary.sourceThreadId, summary.groupStartItemId);
    groups.set(key, groupState(summary, input.snapshotSequence, current.groups.get(key)));
  }
  return {
    ...current,
    mode: "summary-v1",
    snapshotSequence: input.snapshotSequence,
    generation: current.generation + (current.mode === "summary-v1" ? 0 : 1),
    groups,
    unscopedLiveAnchors: new Map(
      Array.from(current.unscopedLiveAnchors).filter(
        ([, anchor]) => anchor.sequence > input.snapshotSequence,
      ),
    ),
  };
}

/** Clears a request's loading and error state without merging any rows. */
function releaseActivityRequest(
  current: ThreadActivityState,
  request: ThreadActivityPageRequest,
): ThreadActivityState {
  const requestKey = activityPageRequestKey(request);
  const loadingRequestKeys = new Set(current.loadingRequestKeys);
  loadingRequestKeys.delete(requestKey);
  const errorsByRequestKey = new Map(current.errorsByRequestKey);
  errorsByRequestKey.delete(requestKey);
  const groups = new Map(current.groups);
  for (const [key, group] of current.groups) {
    if (!group.loadingRequestKeys.has(requestKey) && !group.errorsByRequestKey.has(requestKey)) {
      continue;
    }
    const pending = new Set(group.loadingRequestKeys);
    pending.delete(requestKey);
    const errors = new Map(group.errorsByRequestKey);
    errors.delete(requestKey);
    groups.set(key, { ...group, loadingRequestKeys: pending, errorsByRequestKey: errors });
  }
  return { ...current, groups, loadingRequestKeys, errorsByRequestKey };
}

export function mergeThreadActivityPage(
  current: ThreadActivityState,
  page: OrchestrationV2ThreadActivityPage,
  request: ThreadActivityPageRequest,
): ThreadActivityState {
  // A page from an older snapshot cannot replace rows already established by a newer one.
  if (current.snapshotSequence !== null && page.snapshotSequence < current.snapshotSequence) {
    return releaseActivityRequest(current, request);
  }
  const key = activityGroupKey(page.sourceThreadId, page.groupStartItemId);
  const previous = current.groups.get(key);
  const nextGroup = groupState(page.summary, page.snapshotSequence, previous);
  const hasFreshSummary =
    page.snapshotSequence >=
    Math.max(
      nextGroup.summarySequence,
      nextGroup.latestLiveSequence,
      current.snapshotSequence ?? -1,
    );
  const windows = mergePageWindow(nextGroup.windows, page, request);
  const group: ThreadActivityGroupState = {
    ...nextGroup,
    summary: hasFreshSummary ? page.summary : nextGroup.summary,
    summarySequence: hasFreshSummary ? page.snapshotSequence : nextGroup.summarySequence,
    windows,
    liveRows: nextGroup.liveRows.filter((row) => {
      const key = rowKey(row);
      const liveSequence = nextGroup.liveSequenceByRowKey.get(key) ?? -1;
      return (
        !page.items.some((item) => rowKey(item) === key) || page.snapshotSequence < liveSequence
      );
    }),
    liveSequenceByRowKey: new Map(
      Array.from(nextGroup.liveSequenceByRowKey).filter(
        ([key, sequence]) =>
          !page.items.some((item) => rowKey(item) === key) || page.snapshotSequence < sequence,
      ),
    ),
    summaryStale: hasFreshSummary ? false : nextGroup.summaryStale,
  };
  const requestKey = activityPageRequestKey(request);
  const loadingRequestKeys = new Set(current.loadingRequestKeys);
  loadingRequestKeys.delete(requestKey);
  const errorsByRequestKey = new Map(current.errorsByRequestKey);
  errorsByRequestKey.delete(requestKey);
  const groups = new Map(current.groups);
  groups.set(key, {
    ...group,
    loadingRequestKeys: new Set(
      Array.from(group.loadingRequestKeys).filter((pending) => pending !== requestKey),
    ),
    errorsByRequestKey: new Map(
      Array.from(group.errorsByRequestKey).filter(([pending]) => pending !== requestKey),
    ),
  });
  const unscopedLiveAnchors = new Map(current.unscopedLiveAnchors);
  const unscopedAnchor = unscopedLiveAnchors.get(String(page.sourceThreadId));
  if (
    hasFreshSummary &&
    request.anchorItemId !== undefined &&
    unscopedAnchor?.itemId === request.anchorItemId &&
    page.snapshotSequence >= unscopedAnchor.sequence
  ) {
    unscopedLiveAnchors.delete(String(page.sourceThreadId));
  }
  return {
    ...current,
    mode: "summary-v1",
    snapshotSequence: Math.max(current.snapshotSequence ?? -1, page.snapshotSequence),
    groups,
    unscopedLiveAnchors,
    loadingRequestKeys,
    errorsByRequestKey,
  };
}

function mergeWindow(
  window: ThreadActivityPageWindow,
  page: OrchestrationV2ThreadActivityPage,
  direction: ThreadActivityPageDirection,
): ThreadActivityPageWindow {
  const rows = mergeRows(window.rows, page.items);
  if (direction === "next") {
    return {
      rows,
      previousCursor: window.previousCursor,
      nextCursor: page.nextCursor,
      hasPrevious: window.hasPrevious,
      hasNext: page.hasNext,
    };
  }
  return {
    rows,
    previousCursor: page.previousCursor,
    nextCursor: window.nextCursor,
    hasPrevious: page.hasPrevious,
    hasNext: window.hasNext,
  };
}

function mergePageWindow(
  windows: ReadonlyArray<ThreadActivityPageWindow>,
  page: OrchestrationV2ThreadActivityPage,
  request: ThreadActivityPageRequest,
): ReadonlyArray<ThreadActivityPageWindow> {
  if (page.items.length === 0 && request.summaryOnly === true) return windows;
  const direction = request.direction;
  const cursor = request.cursor;
  const adjacentIndex =
    cursor === undefined || direction === undefined
      ? -1
      : windows.findIndex((window) =>
          direction === "next" ? window.nextCursor === cursor : window.previousCursor === cursor,
        );
  if (adjacentIndex >= 0 && direction !== undefined) {
    return windows.map((window, index) =>
      index === adjacentIndex ? mergeWindow(window, page, direction) : window,
    );
  }

  // The first open and a retry of that same first page extend its leftmost window.
  if (cursor === undefined && request.anchorItemId === undefined && windows.length > 0) {
    const firstWindow = windows[0]!;
    if (!firstWindow.hasPrevious) {
      return [
        {
          ...firstWindow,
          rows: mergeRows(firstWindow.rows, page.items),
          nextCursor: page.nextCursor,
          hasNext: page.hasNext,
        },
        ...windows.slice(1),
      ];
    }
  }

  const next = [
    ...windows,
    {
      rows: mergeRows([], page.items),
      previousCursor: page.previousCursor,
      nextCursor: page.nextCursor,
      hasPrevious: page.hasPrevious,
      hasNext: page.hasNext,
    },
  ];
  return next.sort(compareWindowsByStart);
}

export function beginThreadActivityRequest(
  current: ThreadActivityState,
  request: ThreadActivityPageRequest,
): ThreadActivityState {
  const requestKey = activityPageRequestKey(request);
  if (current.loadingRequestKeys.has(requestKey)) return current;
  const loadingRequestKeys = new Set(current.loadingRequestKeys);
  loadingRequestKeys.add(requestKey);
  const errorsByRequestKey = new Map(current.errorsByRequestKey);
  errorsByRequestKey.delete(requestKey);
  const groups = new Map(current.groups);
  if (request.sourceThreadId !== undefined && request.groupStartItemId !== undefined) {
    const key = activityGroupKey(request.sourceThreadId, request.groupStartItemId);
    const group = groups.get(key);
    if (group !== undefined) {
      const pending = new Set(group.loadingRequestKeys);
      pending.add(requestKey);
      const errors = new Map(group.errorsByRequestKey);
      errors.delete(requestKey);
      groups.set(key, { ...group, loadingRequestKeys: pending, errorsByRequestKey: errors });
    }
  }
  return { ...current, groups, loadingRequestKeys, errorsByRequestKey };
}

export function failThreadActivityRequest(
  current: ThreadActivityState,
  request: ThreadActivityPageRequest,
  message: string,
): ThreadActivityState {
  const requestKey = activityPageRequestKey(request);
  const loadingRequestKeys = new Set(current.loadingRequestKeys);
  loadingRequestKeys.delete(requestKey);
  const errorsByRequestKey = new Map(current.errorsByRequestKey);
  errorsByRequestKey.set(requestKey, message);
  const groups = new Map(current.groups);
  if (request.sourceThreadId !== undefined && request.groupStartItemId !== undefined) {
    const key = activityGroupKey(request.sourceThreadId, request.groupStartItemId);
    const group = groups.get(key);
    if (group !== undefined) {
      const pending = new Set(group.loadingRequestKeys);
      pending.delete(requestKey);
      const errors = new Map(group.errorsByRequestKey);
      errors.set(requestKey, message);
      groups.set(key, { ...group, loadingRequestKeys: pending, errorsByRequestKey: errors });
    }
  }
  return { ...current, groups, loadingRequestKeys, errorsByRequestKey };
}

function groupMatchesLiveRow(
  group: ThreadActivityGroupState,
  row: OrchestrationV2ThreadActivityRow,
): boolean {
  if (group.summary.sourceThreadId !== row.sourceThreadId) return false;
  const id = rowKey(row);
  const alreadyLoaded =
    group.windows.some((window) => window.rows.some((candidate) => rowKey(candidate) === id)) ||
    group.liveRows.some((candidate) => rowKey(candidate) === id);
  const inOrdinalRange =
    row.ordinal >= group.summary.firstOrdinal && row.ordinal <= group.summary.lastOrdinal;
  const sameRun = group.summary.runId !== null && row.item.runId === group.summary.runId;
  const sameBoundary = row.sourceItemId === group.summary.groupStartItemId;
  return alreadyLoaded || inOrdinalRange || sameRun || sameBoundary;
}

export function activitySummaryRefreshRequestsForLiveRow(
  current: ThreadActivityState,
  row: OrchestrationV2ThreadActivityRow,
): ReadonlyArray<ThreadActivityPageRequest> {
  if (current.mode !== "summary-v1") return [];
  // Keyed by request identity so a burst of live rows for one group coalesces.
  const requests = new Map<string, ThreadActivityPageRequest>();
  for (const group of current.groups.values()) {
    if (!groupMatchesLiveRow(group, row)) continue;
    const request: ThreadActivityPageRequest = {
      sourceThreadId: group.summary.sourceThreadId,
      groupStartItemId: group.summary.groupStartItemId,
      summaryOnly: true,
    };
    requests.set(activityPageRequestKey(request), request);
  }
  if (requests.size > 0) return Array.from(requests.values());
  // The query accepts source and group only together, so an unscoped row asks by anchor alone.
  return [{ anchorItemId: row.sourceItemId, summaryOnly: true }];
}

/** Refreshes loaded windows when the live stream updates a row already on screen. */
export function mergeThreadActivityLiveRow(
  current: ThreadActivityState,
  row: OrchestrationV2ThreadActivityRow,
  sequence?: number,
): ThreadActivityState {
  if (current.mode !== "summary-v1") return current;
  const groups = new Map(current.groups);
  let matched = false;
  for (const [key, group] of current.groups) {
    if (!groupMatchesLiveRow(group, row)) continue;
    matched = true;
    const id = rowKey(row);
    const previousSequence = group.liveSequenceByRowKey.get(id);
    const previousLiveRow = group.liveRows.find((candidate) => rowKey(candidate) === id);
    const shouldUseIncoming =
      previousLiveRow === undefined ||
      (sequence !== undefined &&
        (previousSequence === undefined || sequence >= previousSequence)) ||
      (sequence === undefined && rowTime(row) >= rowTime(previousLiveRow));
    const liveRowsById = new Map(group.liveRows.map((candidate) => [rowKey(candidate), candidate]));
    if (shouldUseIncoming) liveRowsById.set(id, row);
    const liveRows = Array.from(liveRowsById.values()).sort(compareActivityRows);
    const liveSequenceByRowKey = new Map(group.liveSequenceByRowKey);
    if (sequence !== undefined && shouldUseIncoming) {
      liveSequenceByRowKey.set(id, Math.max(previousSequence ?? -1, sequence));
    }
    const latestLiveSequence = Math.max(group.latestLiveSequence, sequence ?? -1);
    groups.set(key, {
      ...group,
      liveRows,
      liveSequenceByRowKey,
      latestLiveSequence,
      summaryStale:
        group.summaryStale || sequence === undefined || sequence > group.summarySequence,
    });
  }
  const unscopedLiveAnchors = new Map(current.unscopedLiveAnchors);
  if (!matched) {
    const sourceKey = String(row.sourceThreadId);
    const prior = unscopedLiveAnchors.get(sourceKey);
    if (sequence === undefined || prior === undefined || sequence >= prior.sequence) {
      unscopedLiveAnchors.set(sourceKey, {
        itemId: row.sourceItemId,
        sequence: sequence ?? current.snapshotSequence ?? -1,
      });
    }
  }
  return {
    ...current,
    snapshotSequence: Math.max(current.snapshotSequence ?? -1, sequence ?? -1),
    groups,
    unscopedLiveAnchors,
  };
}

export function markThreadActivitySummaryStale(
  current: ThreadActivityState,
  key: string,
): ThreadActivityState {
  const group = current.groups.get(key);
  if (group === undefined || group.summaryStale) return current;
  const groups = new Map(current.groups);
  groups.set(key, { ...group, summaryStale: true });
  return { ...current, groups };
}

export function activityRowsForGroup(
  current: ThreadActivityState,
  key: string,
): ReadonlyArray<OrchestrationV2ThreadActivityRow> {
  const group = current.groups.get(key);
  if (group === undefined) return [];
  const rowsByKey = new Map(
    mergeRows(
      [],
      group.windows.flatMap((window) => window.rows),
    ).map((row) => [rowKey(row), row] as const),
  );
  // A stream event at a later sequence is authoritative even if its updatedAt
  // clock is older than the HTTP row's clock.
  for (const row of group.liveRows) rowsByKey.set(rowKey(row), row);
  return Array.from(rowsByKey.values()).sort(compareActivityRows);
}

export function activityGroupLoadState(group: ThreadActivityGroupState): {
  readonly loading: boolean;
  readonly error: string | null;
} {
  const loading = group.loadingRequestKeys.size > 0;
  const error = group.errorsByRequestKey.values().next().value ?? null;
  return { loading, error };
}
