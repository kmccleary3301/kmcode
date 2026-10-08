import type { RunId } from "@t3tools/contracts";

import type { ThreadFeedActivity, ThreadFeedEntry } from "../../lib/threadActivity";

export type ThreadFeedNavigationKind = "prompt" | "answer" | "thinking" | "tool" | "activity";

export interface ThreadFeedNavigationItem {
  readonly id: string;
  /** The feed entry id, or the id of an activity inside an activity group. */
  readonly targetId: string;
  readonly runId: RunId | null;
  readonly kind: ThreadFeedNavigationKind;
  readonly label: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly createdAt: string;
  readonly searchText: string;
}

const MAX_THREAD_FEED_SEARCH_RESULTS = 80;
const NAVIGATION_LABEL_BY_KIND: Record<ThreadFeedNavigationKind, string> = {
  prompt: "Prompt",
  answer: "Answer",
  thinking: "Thinking",
  tool: "Tool",
  activity: "Activity",
};

function compactText(value: string | null | undefined, maxLength = 180): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function searchText(values: ReadonlyArray<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
}

function activityItem(activity: ThreadFeedActivity): ThreadFeedNavigationItem {
  const work = activity.workEntry;
  const kind: ThreadFeedNavigationKind =
    work.tone === "thinking" ? "thinking" : work.tone === "tool" ? "tool" : "activity";
  const label = NAVIGATION_LABEL_BY_KIND[kind];
  const title = compactText(work.toolTitle ?? work.label ?? activity.summary) || label;
  return {
    id: `thread-feed-navigation:${activity.id}`,
    targetId: activity.id,
    runId: activity.runId,
    kind,
    label,
    title,
    subtitle: compactText(activity.detail ?? work.command) || null,
    createdAt: activity.createdAt,
    searchText: searchText([
      label,
      title,
      activity.summary,
      activity.detail,
      work.label,
      work.toolTitle,
      work.command,
      work.detail,
      work.changedFiles?.join(" "),
    ]),
  };
}

/** Every prompt, answer, and activity in the feed as a searchable jump target. */
export function deriveThreadFeedNavigationItems(
  feed: ReadonlyArray<ThreadFeedEntry>,
): ThreadFeedNavigationItem[] {
  return feed.flatMap<ThreadFeedNavigationItem>((entry) => {
    if (entry.type === "activity-group") return entry.activities.map(activityItem);
    let kind: ThreadFeedNavigationKind;
    let title: string;
    let runId: RunId | null;
    let values: ReadonlyArray<string | null | undefined>;
    if (entry.type === "message") {
      kind = entry.message.role === "user" ? "prompt" : "answer";
      title = compactText(entry.message.text);
      runId = entry.message.runId;
      values = [entry.message.text, entry.message.role];
    } else if (entry.type === "work-toggle") {
      kind = "tool";
      title = compactText(entry.summary);
      runId = entry.runId;
      values = [entry.summary];
    } else if (entry.type === "run-fold") {
      kind = "activity";
      title = compactText(entry.label);
      runId = entry.runId;
      values = [entry.label];
    } else {
      return [];
    }
    const label = NAVIGATION_LABEL_BY_KIND[kind];
    const resolvedTitle = title || label;
    return [
      {
        id: `thread-feed-navigation:${entry.id}`,
        targetId: entry.id,
        runId,
        kind,
        label,
        title: resolvedTitle,
        subtitle: null,
        createdAt: entry.createdAt,
        searchText: searchText([label, resolvedTitle, ...values]),
      },
    ];
  });
}

/** Items matching every whitespace-separated term, capped for the overlay list. */
export function filterThreadFeedNavigationItems(
  items: ReadonlyArray<ThreadFeedNavigationItem>,
  query: string,
): ThreadFeedNavigationItem[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => terms.every((term) => item.searchText.includes(term)))
    .slice(0, MAX_THREAD_FEED_SEARCH_RESULTS);
}

/**
 * The feed index showing the item. Folded or regrouped feeds fall back to the
 * first entry of the item's run.
 */
export function resolveThreadFeedNavigationIndex(
  feed: ReadonlyArray<ThreadFeedEntry>,
  item: Pick<ThreadFeedNavigationItem, "targetId" | "runId">,
): number | null {
  const directIndex = feed.findIndex(
    (entry) =>
      entry.id === item.targetId ||
      (entry.type === "activity-group" &&
        entry.activities.some((activity) => activity.id === item.targetId)),
  );
  if (directIndex >= 0) return directIndex;
  if (item.runId === null) return null;
  const runIndex = feed.findIndex(
    (entry) =>
      (entry.type === "message" ? entry.message.runId : entry.runId) === item.runId &&
      entry.type !== "thinking",
  );
  return runIndex >= 0 ? runIndex : null;
}
