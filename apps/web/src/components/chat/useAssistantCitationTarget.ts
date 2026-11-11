import type { LegendListRef } from "@legendapp/list/react";
import type { ThreadActivityPageRequest } from "@t3tools/client-runtime/state/threads";
import type { RunId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { AssistantCitationRequest, AssistantCitationTarget } from "./AssistantCitationSource";
import {
  activityGroupForEntry,
  activityGroupForTarget,
  activityPageRequest,
} from "./activityTargetNavigation";
import { toastManager } from "../ui/toast";
import type { TimelineActivityGroup } from "./timelineActivity";

export interface CitationHistoryPage {
  readonly loading: boolean;
  readonly onLoadEarlier: (throughEntryId?: string) => void | Promise<unknown>;
}

interface CitationNavigation {
  target: AssistantCitationTarget;
  requestedTarget: string | null;
  historyEntries: ReadonlyArray<TimelineEntry> | null;
  historyLoadingObserved: boolean;
  historyRequestSettled: boolean;
  activityRequested: boolean;
  activityRequestSettled: boolean;
  expandedGroupKeys: Set<string>;
  done: boolean;
}

const EMPTY_ACTIVITY_GROUPS: ReadonlyArray<TimelineActivityGroup> = [];

/** Fetch, unfold, and mount the source before its measured quote owns scrolling. */
export function useAssistantCitationTarget({
  request,
  entries,
  rows,
  listRef,
  viewport,
  historyLoading,
  loadEarlier,
  activityGroups = EMPTY_ACTIVITY_GROUPS,
  onLoadActivityPage,
  onExpandActivityGroup,
  onExpandTurn,
  onManualNavigation,
}: {
  request: AssistantCitationRequest | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  historyLoading: boolean;
  loadEarlier: CitationHistoryPage | null;
  activityGroups?: ReadonlyArray<TimelineActivityGroup>;
  onLoadActivityPage?: (request: ThreadActivityPageRequest) => void | Promise<unknown>;
  onExpandActivityGroup?: (group: TimelineActivityGroup) => void;
  onExpandTurn: (runId: RunId) => void;
  onManualNavigation: () => void;
}) {
  const [ready, setReady] = useState<AssistantCitationTarget | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const onListLoad = useCallback(() => setListLoaded(true), []);
  const navigationRef = useRef<CitationNavigation | null>(null);

  useEffect(() => {
    if (navigationRef.current && navigationRef.current.target.key !== request?.key) {
      navigationRef.current.target.activationRef.current.dismissed = true;
      navigationRef.current.target.activationRef.current.cancelScroll?.();
    }
    if (!request) {
      navigationRef.current = null;
      setReady(null);
      setFinishedKey(null);
      return;
    }
    if (navigationRef.current?.target.key !== request.key) {
      const target: AssistantCitationTarget = {
        ...request,
        activationRef: { current: { scrolled: false, dismissed: false } },
        onComplete: () => {
          if (navigationRef.current?.target !== target) return;
          navigationRef.current.done = true;
          // ChatView's thread-open effect can run after our initial opt-out.
          onManualNavigation();
          setFinishedKey(target.key);
        },
      };
      navigationRef.current = {
        target,
        requestedTarget: null,
        historyEntries: null,
        historyLoadingObserved: false,
        historyRequestSettled: false,
        activityRequested: false,
        activityRequestSettled: false,
        expandedGroupKeys: new Set(),
        done: false,
      };
      setReady(null);
      onManualNavigation();
    }
    const navigation = navigationRef.current;
    if (!viewport || navigation.done || navigation.target.activationRef.current.dismissed) return;
    const fail = (title: string, description: string) => {
      navigation.done = true;
      setFinishedKey(navigation.target.key);
      toastManager.add({ type: "warning", title, description });
    };
    const targetMessageId = String(navigation.target.citation.messageId);
    const isHistoryLoading = historyLoading || loadEarlier?.loading === true;
    if (isHistoryLoading) {
      if (navigation.requestedTarget === targetMessageId) navigation.historyLoadingObserved = true;
      return;
    }
    const source = entries.find(
      (entry) => entry.kind === "message" && entry.message.id === targetMessageId,
    );
    if (!source) {
      if (navigation.requestedTarget !== targetMessageId) {
        if (!loadEarlier) {
          fail(
            "The cited response is unavailable",
            "It may have been removed. The selected text is still saved in your citation.",
          );
          return;
        }
        navigation.requestedTarget = targetMessageId;
        navigation.historyEntries = entries;
        const historyLoad = loadEarlier.onLoadEarlier(targetMessageId);
        if (historyLoad && typeof (historyLoad as PromiseLike<unknown>).then === "function") {
          const settled = () => {
            if (navigationRef.current !== navigation) return;
            navigation.historyRequestSettled = true;
            setHydrationVersion((version) => version + 1);
          };
          void Promise.resolve(historyLoad).then(settled, settled);
        }
        return;
      }
      const historySettled =
        navigation.historyLoadingObserved ||
        navigation.historyRequestSettled ||
        (navigation.historyEntries !== null && navigation.historyEntries !== entries);
      if (!historySettled) return;
      if (activityGroups.length > 0 && onLoadActivityPage && !navigation.activityRequested) {
        navigation.activityRequested = true;
        const group = activityGroupForTarget(targetMessageId, activityGroups);
        const activityLoad = onLoadActivityPage(
          activityPageRequest(targetMessageId, undefined, group),
        );
        if (activityLoad && typeof (activityLoad as PromiseLike<unknown>).then === "function") {
          const settled = () => {
            if (navigationRef.current !== navigation) return;
            navigation.activityRequestSettled = true;
            setHydrationVersion((version) => version + 1);
          };
          void Promise.resolve(activityLoad).then(settled, settled);
        }
        if (group && onExpandActivityGroup && !navigation.expandedGroupKeys.has(group.key)) {
          navigation.expandedGroupKeys.add(group.key);
          onExpandActivityGroup(group);
        }
        return;
      }
      if (navigation.activityRequested && !navigation.activityRequestSettled) return;
      fail(
        "The cited response is unavailable",
        "It may have been removed. The selected text is still saved in your citation.",
      );
      return;
    }
    if (source.kind !== "message" || source.message.role !== "assistant") {
      fail(
        "The citation does not refer to an assistant response",
        "The selected text is still saved in your citation.",
      );
      return;
    }
    const index = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === targetMessageId,
    );
    if (index < 0) {
      const group = activityGroupForEntry(source, activityGroups);
      if (group) {
        if (!navigation.activityRequested && onLoadActivityPage) {
          navigation.activityRequested = true;
          const activityLoad = onLoadActivityPage(
            activityPageRequest(targetMessageId, source, group),
          );
          if (activityLoad && typeof (activityLoad as PromiseLike<unknown>).then === "function") {
            const settled = () => {
              if (navigationRef.current !== navigation) return;
              navigation.activityRequestSettled = true;
              setHydrationVersion((version) => version + 1);
            };
            void Promise.resolve(activityLoad).then(settled, settled);
          }
        }
        if (onExpandActivityGroup && !navigation.expandedGroupKeys.has(group.key)) {
          navigation.expandedGroupKeys.add(group.key);
          onExpandActivityGroup(group);
        }
      } else if (source.message.runId) {
        onExpandTurn(source.message.runId);
      }
      return;
    }
    if (listLoaded && listRef.current) setReady(navigation.target);
  }, [
    activityGroups,
    entries,
    historyLoading,
    hydrationVersion,
    listLoaded,
    listRef,
    loadEarlier,
    onExpandActivityGroup,
    onExpandTurn,
    onLoadActivityPage,
    onManualNavigation,
    request,
    rows,
    viewport,
  ]);

  useEffect(() => {
    if (!request) return;
    const dismiss = (onlyPending: boolean) => {
      const navigation = navigationRef.current;
      if (!navigation || navigation.target.key !== request.key) return;
      const activation = navigation.target.activationRef.current;
      if (activation.dismissed || (onlyPending && (activation.scrolled || navigation.done))) return;
      activation.dismissed = true;
      activation.cancelScroll?.();
      if (!activation.scrolled && !navigation.done) onManualNavigation();
      navigation.done = true;
      setReady(null);
      setFinishedKey(request.key);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss(false);
      } else if (
        viewport?.contains(event.target as Node) &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      ) {
        dismiss(true);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) dismiss(true);
    };
    const onNavigation = () => dismiss(true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onNavigation, true);
    viewport?.addEventListener("wheel", onWheel, { passive: true });
    viewport?.addEventListener("touchmove", onNavigation, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onNavigation, true);
      viewport?.removeEventListener("wheel", onWheel);
      viewport?.removeEventListener("touchmove", onNavigation);
    };
  }, [onManualNavigation, request, viewport]);

  const target = ready?.key === request?.key ? ready : null;
  const positioning = request !== null && finishedKey !== request.key;
  const sourceRow =
    target && positioning
      ? rows.find((row) => row.kind === "message" && row.message.id === target.citation.messageId)
      : undefined;
  return {
    target,
    positioning,
    onListLoad,
    alwaysRender: sourceRow ? { keys: [sourceRow.id] } : undefined,
  };
}
