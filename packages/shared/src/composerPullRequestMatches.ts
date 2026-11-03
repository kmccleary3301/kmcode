import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "./threadPullRequests.ts";

export interface ComposerPullRequestMatch {
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

/** Pull request records linked to a thread, with the snapshot fields the composer displays. */
export function composerPullRequestsFromLinks(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: string,
) {
  return visibleThreadPullRequests(links).flatMap((link) =>
    link.snapshot === null
      ? []
      : [
          {
            projectId,
            repository: link.repository,
            number: link.number,
            url: link.url,
            title: link.snapshot.title,
            headBranch: link.snapshot.headBranch,
            baseBranch: link.snapshot.baseBranch,
            state: link.snapshot.state,
            isDraft: link.snapshot.isDraft,
            updatedAt: link.snapshot.updatedAt ?? link.linkedAt,
          },
        ],
  );
}

/**
 * Pull requests matching the numeric fragment typed after `#`, de-duplicated. An exact number
 * match always outranks a substring match so the result limit can never drop the pull request
 * the user typed in full; the rest stay newest first.
 */
export function filterComposerPullRequestMatches<Entry extends ComposerPullRequestMatch>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly projectId: string;
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry> {
  const repository = input.repository.trim().toLowerCase();
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      entry.repository.trim().toLowerCase() === repository &&
      String(entry.number).includes(input.query),
  );
  const uniqueEntries = new Map<number, Entry>();
  for (const entry of matchingEntries) {
    if (!uniqueEntries.has(entry.number)) {
      uniqueEntries.set(entry.number, entry);
    }
  }
  const isExactMatch = (entry: Entry) => String(entry.number) === input.query;
  // `.sort()` on a copy, not `.toSorted()`: this runs on Hermes, which has no ES2023 array
  // methods, and reaching for one here crashed the composer as the suggestions loaded.
  return [...uniqueEntries.values()]
    .sort((left, right) => {
      const exactness = Number(isExactMatch(right)) - Number(isExactMatch(left));
      return exactness !== 0 ? exactness : right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, input.limit);
}
/** Puts the thread's linked pull requests that match a text query ahead of searched ones. */
export function withLinkedComposerPullRequestsFirst<
  Entry extends ComposerPullRequestMatch,
  Linked extends ComposerPullRequestMatch & {
    readonly title: string;
    readonly headBranch: string;
  },
>(input: {
  readonly matches: ReadonlyArray<Entry>;
  readonly linked: ReadonlyArray<Linked>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const keyOf = (entry: ComposerPullRequestMatch) =>
    `${entry.repository.trim().toLowerCase()}#${entry.number}`;
  const matchesByKey = new Map(input.matches.map((entry) => [keyOf(entry), entry]));
  const words = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const linked = input.linked.flatMap((entry): Array<Entry | Linked> => {
    const match = matchesByKey.get(keyOf(entry));
    if (match !== undefined) return [match];
    const text =
      `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch}`.toLowerCase();
    return words.every((word) => text.includes(word)) ? [entry] : [];
  });
  const linkedKeys = new Set(linked.map(keyOf));
  return [...linked, ...input.matches.filter((entry) => !linkedKeys.has(keyOf(entry)))].slice(
    0,
    input.limit,
  );
}
