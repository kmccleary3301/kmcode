import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { isOrchestrationV2TurnItemVisible } from "@t3tools/shared/orchestrationV2Timeline";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** True after at least one older page was merged; skip monolithic cache growth. */
  readonly expanded: boolean;
  /**
   * Max local turn ordinal known for partial progressive windows. Null when
   * unknown (legacy cache) or when history meta is cleared for a full snapshot.
   */
  readonly latestLocalTurnOrdinal: number | null;
  readonly activeRequestId?: number;
};

export const EMPTY_THREAD_HISTORY_META: ThreadHistoryMeta = {
  historyCursor: null,
  hasMoreHistory: false,
  loading: false,
  error: null,
  expanded: false,
  latestLocalTurnOrdinal: null,
};

/** Whether the in-flight history response still owns the thread history state. */
export function isActiveHistoryRequest(requestId: number, history: ThreadHistoryMeta): boolean {
  return history.loading && history.activeRequestId === requestId;
}

/** Whether a cursor page still addresses the cursor that started it. */
export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

/** Clear loading only for the request that currently owns the history state. */
export function clearHistoryRequestLoading(
  requestId: number,
  history: ThreadHistoryMeta,
): ThreadHistoryMeta {
  if (!isActiveHistoryRequest(requestId, history)) return history;
  const { activeRequestId: _activeRequestId, ...idle } = history;
  return { ...idle, loading: false };
}

function projectedItemKey(row: OrchestrationV2ProjectedTurnItem): string {
  return JSON.stringify([row.sourceThreadId, row.sourceItemId]);
}

function renumberVisible(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

/**
 * Merge a bounded history window into the projection. Canonical order keys
 * place anchored rows among the matching source's rows; local dense positions
 * are used only by legacy pages.
 */
export function mergeHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  pageItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ThreadProjection {
  if (pageItems.length === 0) return projection;
  const projected = new Map<string, OrchestrationV2ProjectedTurnItem>();
  for (const row of projection.visibleTurnItems) projected.set(projectedItemKey(row), row);
  const turnItemById = new Map<string, OrchestrationV2TurnItem>();
  for (const item of projection.turnItems) turnItemById.set(String(item.id), item);
  const additions: OrchestrationV2ProjectedTurnItem[] = [];
  let changed = false;

  for (const pageRow of pageItems) {
    const key = projectedItemKey(pageRow);
    const current = projected.get(key);
    if (current !== undefined) {
      const currentItem = turnItemById.get(String(pageRow.sourceItemId)) ?? current.item;
      const item =
        DateTime.toEpochMillis(currentItem.updatedAt) >=
        DateTime.toEpochMillis(pageRow.item.updatedAt)
          ? currentItem
          : pageRow.item;
      if (
        item !== current.item ||
        (pageRow.orderKey !== undefined && current.orderKey === undefined)
      ) {
        const orderKey = pageRow.orderKey ?? current.orderKey;
        projected.set(key, {
          ...pageRow,
          ...current,
          item,
          ...(orderKey === undefined ? {} : { orderKey }),
        });
        changed = true;
      }
      continue;
    }

    let row = pageRow;
    if (row.visibility === "local" || row.sourceThreadId === projection.thread.id) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      if (currentItem !== undefined) {
        if (
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        ) {
          continue;
        }
        row = { ...row, item: currentItem };
      } else {
        turnItemById.set(String(row.sourceItemId), row.item);
      }
    }
    projected.set(key, row);
    additions.push(row);
    changed = true;
  }
  if (!changed) return projection;

  const additionKeys = new Set(additions.map(projectedItemKey));
  const rows = projection.visibleTurnItems
    .map((row) => projected.get(projectedItemKey(row)) ?? row)
    .filter((row) => !additionKeys.has(projectedItemKey(row)));
  const legacyAdditions = additions.filter((row) => row.orderKey === undefined);
  rows.unshift(...legacyAdditions);
  const canonicalBySource = new Map<string, OrchestrationV2ProjectedTurnItem[]>();
  for (const row of additions) {
    if (row.orderKey === undefined) continue;
    const sourceThreadId = String(row.orderKey.sourceThreadId);
    const group = canonicalBySource.get(sourceThreadId) ?? [];
    group.push(row);
    canonicalBySource.set(sourceThreadId, group);
  }
  for (const [sourceThreadId, sourceRows] of canonicalBySource) {
    sourceRows.sort(
      (left, right) =>
        left.orderKey!.ordinal - right.orderKey!.ordinal ||
        String(left.orderKey!.itemId).localeCompare(String(right.orderKey!.itemId)),
    );
    for (const row of sourceRows) {
      const orderKey = row.orderKey!;
      let insertionIndex = -1;
      let lastSourceIndex = -1;
      for (let index = 0; index < rows.length; index += 1) {
        const candidate = rows[index]!;
        const candidateSource = String(
          candidate.orderKey?.sourceThreadId ?? candidate.sourceThreadId,
        );
        if (candidateSource !== sourceThreadId) continue;
        lastSourceIndex = index;
        const candidateOrdinal = candidate.orderKey?.ordinal ?? candidate.item.ordinal;
        const candidateItemId = String(candidate.orderKey?.itemId ?? candidate.sourceItemId);
        if (
          candidateOrdinal > orderKey.ordinal ||
          (candidateOrdinal === orderKey.ordinal &&
            candidateItemId.localeCompare(String(orderKey.itemId)) > 0)
        ) {
          insertionIndex = index;
          break;
        }
      }
      let at = rows.length;
      if (insertionIndex >= 0) at = insertionIndex;
      else if (lastSourceIndex >= 0) at = lastSourceIndex + 1;
      rows.splice(at, 0, row);
    }
  }

  const visibleTurnItems = renumberVisible(rows);
  for (const row of visibleTurnItems) {
    if (row.visibility === "local" || row.sourceThreadId === projection.thread.id) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      if (
        currentItem === undefined ||
        DateTime.toEpochMillis(currentItem.updatedAt) < DateTime.toEpochMillis(row.item.updatedAt)
      ) {
        turnItemById.set(String(row.sourceItemId), row.item);
      }
    }
  }
  return {
    ...projection,
    turnItems: Array.from(turnItemById.values()),
    visibleTurnItems,
  };
}

export function applyHistoryPageMeta(
  current: ThreadHistoryMeta,
  page: {
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  },
): ThreadHistoryMeta {
  return {
    historyCursor: page.nextCursor,
    hasMoreHistory: page.hasMoreHistory,
    loading: false,
    error: null,
    expanded: true,
    // Preserve the partial-timeline watermark across load-earlier pages.
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

/** Whether a client timeline should render its load-earlier control. */
export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}
