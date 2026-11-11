import type { LegendListRef } from "@legendapp/list/react";
import type { ThreadActivityPageRequest } from "@t3tools/client-runtime/state/threads";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  activityGroupForEntry,
  activityGroupForTarget,
  activityPageRequest,
  type TimelineActivityEntry,
} from "./activityTargetNavigation";
import type { ThreadFindMatch } from "./threadFind";
import { useThreadFindHighlights } from "./threadFindHighlights";
import type { TimelineActivityGroup } from "./timelineActivity";
interface FindTargetHydration {
  key: string;
  historyRequested: boolean;
  historyEntries: ReadonlyArray<TimelineActivityEntry>;
  historyLoadingObserved: boolean;
  activityRequested: boolean;
  expandedGroupKeys: Set<string>;
}
const EMPTY_ACTIVITY_GROUPS: ReadonlyArray<TimelineActivityGroup> = [];

const FIND_MATCH_VIEW_MARGIN = 96;

/** Materializes missing results and otherwise scrolls only enough to reveal the active text. */
export function useThreadFindNavigation({
  container,
  query,
  match,
  navigationId,
  rowIndex,
  entries,
  listRef,
  contentInsetEndAdjustment,
  listReady,
  historyControls,
  activityGroups = EMPTY_ACTIVITY_GROUPS,
  onLoadActivityPage,
  onExpandActivityGroup,
}: {
  container: HTMLElement | null;
  query: string;
  match: ThreadFindMatch | null;
  navigationId: number;
  rowIndex: number;
  entries: ReadonlyArray<TimelineActivityEntry>;
  listRef: RefObject<LegendListRef | null>;
  contentInsetEndAdjustment: number;
  listReady: boolean;
  historyControls?:
    | {
        readonly hasMoreHistory: boolean;
        readonly loading: boolean;
        readonly error: string | null;
        readonly onLoadEarlier: (throughEntryId?: string) => void;
      }
    | undefined;
  activityGroups?: ReadonlyArray<TimelineActivityGroup>;
  onLoadActivityPage?: (request: ThreadActivityPageRequest) => void | Promise<unknown>;
  onExpandActivityGroup?: (group: TimelineActivityGroup) => void;
}) {
  const matchKey = match ? `${navigationId}:${query}:${match.entryId}:${match.occurrence}` : null;
  const positioningRef = useRef<{
    key: string;
    rowIndex: number;
    entries: typeof entries;
  } | null>(null);
  const settledMatchRef = useRef<string | null>(null);
  const positionedEntriesRef = useRef<typeof entries | null>(null);
  const revealedMatchRef = useRef<string | null>(null);
  const currentMatchKeyRef = useRef(matchKey);
  const activeRangeRef = useRef<Range | null>(null);
  const pagingPositionRef = useRef<{ key: string; entries: typeof entries; top: number } | null>(
    null,
  );
  const currentEntriesRef = useRef(entries);
  useLayoutEffect(() => {
    currentEntriesRef.current = entries;
  }, [entries]);
  useEffect(() => {
    if (!container) return;
    const onScroll = () => {
      const position = pagingPositionRef.current;
      const range = activeRangeRef.current;
      if (
        !position ||
        position.entries !== currentEntriesRef.current ||
        !range?.startContainer.isConnected
      )
        return;
      const rect = range.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom)
        pagingPositionRef.current = null;
      else position.top = rect.top;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [container]);
  const revealRef = useRef<(range: Range | null) => void>(() => {});
  useLayoutEffect(() => {
    currentMatchKeyRef.current = matchKey;
    return () => {
      currentMatchKeyRef.current = null;
    };
  }, [matchKey]);
  const requestedTargetRef = useRef<FindTargetHydration | null>(null);
  useEffect(() => {
    if (!match || !matchKey || !listReady) return;
    let hydration = requestedTargetRef.current;
    if (hydration?.key !== matchKey) {
      hydration = {
        key: matchKey,
        historyRequested: false,
        historyEntries: entries,
        historyLoadingObserved: false,
        activityRequested: false,
        expandedGroupKeys: new Set(),
      };
      requestedTargetRef.current = hydration;
    }
    const targetEntry = entries.find((entry) => entry.id === match.entryId);
    const targetGroup = targetEntry
      ? activityGroupForEntry(targetEntry, activityGroups)
      : activityGroupForTarget(match.entryId, activityGroups, match.runId);
    if (targetEntry && targetGroup) {
      if (rowIndex < 0) {
        if (!hydration.activityRequested && onLoadActivityPage) {
          hydration.activityRequested = true;
          void onLoadActivityPage(activityPageRequest(match.entryId, targetEntry, targetGroup));
        }
        if (onExpandActivityGroup && !hydration.expandedGroupKeys.has(targetGroup.key)) {
          hydration.expandedGroupKeys.add(targetGroup.key);
          onExpandActivityGroup(targetGroup);
        }
      }
      return;
    }
    if (targetEntry || rowIndex >= 0 || !historyControls) return;
    if (historyControls.loading) {
      if (hydration.historyRequested) hydration.historyLoadingObserved = true;
      return;
    }
    if (!hydration.historyRequested) {
      hydration.historyRequested = true;
      hydration.historyEntries = entries;
      historyControls.onLoadEarlier(match.entryId);
      return;
    }
    const historySettled = hydration.historyLoadingObserved || hydration.historyEntries !== entries;
    if (
      !historySettled ||
      activityGroups.length === 0 ||
      !onLoadActivityPage ||
      hydration.activityRequested
    )
      return;
    hydration.activityRequested = true;
    void onLoadActivityPage(activityPageRequest(match.entryId, undefined, targetGroup));
    if (targetGroup && onExpandActivityGroup && !hydration.expandedGroupKeys.has(targetGroup.key)) {
      hydration.expandedGroupKeys.add(targetGroup.key);
      onExpandActivityGroup(targetGroup);
    }
  }, [
    activityGroups,
    entries,
    historyControls,
    listReady,
    match,
    matchKey,
    onExpandActivityGroup,
    onLoadActivityPage,
    rowIndex,
  ]);
  const reveal = useCallback(
    (range: Range | null) => {
      activeRangeRef.current = range;
      if (!matchKey) {
        positioningRef.current = null;
        settledMatchRef.current = null;
        revealedMatchRef.current = null;
        pagingPositionRef.current = null;
        return;
      }
      const pagingPosition = pagingPositionRef.current;
      if (pagingPosition && pagingPosition.key !== matchKey) pagingPositionRef.current = null;
      if (
        range?.startContainer.isConnected &&
        pagingPosition?.key === matchKey &&
        pagingPosition.entries !== entries
      ) {
        const restore = () => {
          const pinned = pagingPositionRef.current;
          const currentRange = activeRangeRef.current;
          if (
            currentMatchKeyRef.current !== matchKey ||
            !pinned ||
            !currentRange?.startContainer.isConnected
          )
            return;
          const delta = currentRange.getBoundingClientRect().top - pinned.top;
          const scroll = listRef.current?.getState?.().scroll;
          if (Math.abs(delta) >= 1 && typeof scroll === "number")
            listRef.current?.scrollToOffset({ offset: scroll + delta, animated: false });
        };
        pagingPosition.entries = entries;
        restore();
        // The list measures newly inserted activity after the first layout pass.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            restore();
            if (!historyControls?.loading && pagingPositionRef.current === pagingPosition)
              pagingPositionRef.current = null;
          }),
        );
      }
      if (historyControls?.error) pagingPositionRef.current = null;
      if (revealedMatchRef.current === matchKey) return;
      if (!listReady || rowIndex < 0) return;
      const materialize = () => {
        const list = listRef.current;
        const previous = positioningRef.current;
        if (
          !list ||
          (previous?.key === matchKey &&
            previous.rowIndex === rowIndex &&
            previous.entries === entries)
        )
          return;
        // Activity can insert rows while LegendList waits for layout. Retarget the
        // pending jump instead of treating the first requested index as final.
        const request = { key: matchKey, rowIndex, entries };
        positioningRef.current = request;

        void list
          .scrollToIndex({
            index: rowIndex,
            animated: false,
            viewOffset: FIND_MATCH_VIEW_MARGIN,
          })
          .then(() => {
            if (positioningRef.current !== request || currentMatchKeyRef.current !== matchKey)
              return;

            positionedEntriesRef.current = entries;
            settledMatchRef.current = matchKey;
            revealRef.current(activeRangeRef.current);
          });
      };
      if (!range) {
        if (container) materialize();
        return;
      }

      const codeScroller = range.startContainer.parentElement?.closest("pre");
      if (codeScroller) {
        const rect = range.getBoundingClientRect();
        const viewport = codeScroller.getBoundingClientRect();
        if (rect.left < viewport.left) codeScroller.scrollLeft += rect.left - viewport.left - 16;
        else if (rect.right > viewport.right)
          codeScroller.scrollLeft += rect.right - viewport.right + 16;
      }
      const rect = range.getBoundingClientRect();
      const viewport = container?.getBoundingClientRect();
      if (!viewport || rect.height === 0) return;
      // Shrink the margin when the band above the composer is short, so the match stays inside it.
      const margin = Math.min(
        FIND_MATCH_VIEW_MARGIN,
        Math.max(0, (viewport.height - contentInsetEndAdjustment - rect.height) / 2),
      );
      const top = viewport.top + margin;
      const bottom = viewport.bottom - margin - contentInsetEndAdjustment;
      const delta =
        rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
      // A new list can expose DOM text before its virtual row sizes settle.
      // Await row positioning before measuring an offscreen occurrence.
      if (
        Math.abs(delta) >= 1 &&
        positionedEntriesRef.current !== entries &&
        settledMatchRef.current !== matchKey
      ) {
        materialize();
        return;
      }
      const scroll = listRef.current?.getState?.().scroll;
      positionedEntriesRef.current = entries;

      revealedMatchRef.current = matchKey;
      if (historyControls?.loading)
        pagingPositionRef.current = { key: matchKey, entries, top: rect.top - delta };
      if (Math.abs(delta) >= 1 && typeof scroll === "number") {
        listRef.current?.scrollToOffset({ offset: scroll + delta, animated: false });
        // Scrolling can mount rows whose measured heights move the selected text again.
        requestAnimationFrame(() => {
          if (currentMatchKeyRef.current !== matchKey) return;
          if (
            listRef.current?.getState?.().scroll === scroll &&
            range.getBoundingClientRect().top === rect.top
          )
            return;
          revealedMatchRef.current = null;
          revealRef.current(activeRangeRef.current);
        });
      }
    },
    [
      container,
      contentInsetEndAdjustment,
      entries,
      historyControls?.loading,
      historyControls?.error,
      listRef,
      listReady,
      matchKey,
      rowIndex,
    ],
  );

  useLayoutEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  useThreadFindHighlights({
    container,
    query,
    activeRowId: match?.entryId ?? null,
    activeOccurrence: match?.occurrence ?? 0,
    onActiveRange: reveal,
  });
}
