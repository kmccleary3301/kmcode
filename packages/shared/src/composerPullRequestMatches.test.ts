import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "./composerPullRequestMatches.ts";

const entry = (number: number, updatedAt: string) => ({
  number,
  projectId: "p1",
  repository: "owner/repo",
  updatedAt,
});

describe("filterComposerPullRequestMatches", () => {
  it("ranks the exact number above newer substring matches", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(1234, "2026-01-03"), entry(123, "2026-01-01"), entry(1230, "2026-01-02")],
      projectId: "p1",
      repository: "owner/repo",
      query: "123",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([123, 1234, 1230]);
  });

  it("leaves the caller's array untouched", () => {
    // The sort runs on a copy; mutating the input would reorder whatever the caller holds.
    const entries = [entry(2, "2026-01-01"), entry(1, "2026-01-02")];
    const snapshot = entries.map((match) => match.number);
    filterComposerPullRequestMatches({
      entries,
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(entries.map((match) => match.number)).toEqual(snapshot);
  });

  it("de-duplicates and honours the limit", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(7, "2026-01-02"), entry(7, "2026-01-01"), entry(8, "2026-01-03")],
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 1,
    });
    expect(result).toHaveLength(1);
  });
});

describe("withLinkedComposerPullRequestsFirst", () => {
  it("puts matching linked pull requests first without duplicating searched results", () => {
    const result = withLinkedComposerPullRequestsFirst({
      matches: [entry(8, "2026-01-03"), entry(42, "2026-01-02"), entry(6, "2026-01-01")],
      linked: [
        { ...entry(42, "2026-01-02"), title: "Unrelated", headBranch: "main" },
        {
          ...entry(4, "2026-01-04"),
          title: "Database migration",
          headBranch: "feature/database",
        },
        { ...entry(9, "2026-01-05"), title: "Docs update", headBranch: "docs" },
      ],
      query: "database feature",
      limit: 4,
    });

    expect(result.map((match) => match.number)).toEqual([42, 4, 8, 6]);
  });
});

describe("composerPullRequestsFromLinks", () => {
  it("uses visible thread links with snapshots and falls back to the link time", () => {
    const linkedAt = "2026-01-02T00:00:00.000Z";
    const snapshot = {
      state: "open",
      title: "Fix deployment",
      headBranch: "fix/deploy",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-03T00:00:00.000Z",
    } as const;
    const link = {
      host: "github.com",
      repository: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      source: "manual",
      linkedAt,
      snapshot,
      stack: null,
    } satisfies ThreadPullRequestLink;

    expect(
      composerPullRequestsFromLinks(
        [
          link,
          { ...link, number: 43, source: "stack-dismissed" },
          { ...link, number: 44, snapshot: null },
        ],
        "p1",
      ),
    ).toEqual([
      {
        projectId: "p1",
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        title: "Fix deployment",
        headBranch: "fix/deploy",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        updatedAt: linkedAt,
      },
    ]);
  });
});
