import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";
import {
  findSearchTokenRanges,
  messagePhrase,
  messageSearchTokens,
} from "@t3tools/shared/paletteSearch";
import type { ThreadFindStart } from "./threadFind";

const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";
const THREAD_FIND_QUERY_EVENT = "t3:thread-find-query";
const PENDING_FIND_MS = 30_000;

interface PendingFind {
  readonly query: string;
  readonly start?: ThreadFindStart;
}

let pendingFind: (PendingFind & { readonly threadKey: string; readonly at: number }) | null = null;

export function requestThreadFindOpen(): void {
  window.dispatchEvent(new Event(THREAD_FIND_OPEN_EVENT));
}

export function subscribeThreadFindOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}

export function requestThreadFindQuery(threadKey: string, find: PendingFind): void {
  pendingFind = { threadKey, at: Date.now(), ...find };
  window.dispatchEvent(new Event(THREAD_FIND_QUERY_EVENT));
}

export function takeThreadFindQuery(threadKey: string): PendingFind | null {
  if (pendingFind?.threadKey !== threadKey) return null;
  const { at, threadKey: _threadKey, ...find } = pendingFind;
  pendingFind = null;
  return Date.now() - at < PENDING_FIND_MS ? find : null;
}

export function findForMessageMatch(
  match: Pick<OrchestrationThreadSearchMatch, "snippet" | "messageId">,
  query: string,
): PendingFind {
  const start = match.messageId ? { start: { entryId: match.messageId, occurrence: 0 } } : {};
  const together = messagePhrase(query)?.exec(match.snippet.replace(/[\u2018\u2019]/g, "'"));
  if (together) {
    return {
      query: match.snippet.slice(together.index, together.index + together[0].length),
      ...start,
    };
  }
  const word =
    messageSearchTokens(query).long.reduce(
      (longest, token) => (token.length > longest.length ? token : longest),
      "",
    ) || query;
  const ranges = findSearchTokenRanges(match.snippet, word);
  const shown =
    ranges.find((range) => !/[\p{L}\p{N}]/u.test(match.snippet[range.end] ?? "")) ?? ranges[0];
  return { query: shown ? match.snippet.slice(shown.start, shown.end) : word, ...start };
}

export function subscribeThreadFindQuery(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_QUERY_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_QUERY_EVENT, listener);
}
