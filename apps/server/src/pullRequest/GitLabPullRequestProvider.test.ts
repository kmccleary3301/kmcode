import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

it.effect.each(["merge", "disable-auto-merge"] as const)(
  "keeps reads and %s on the selected host when glab prefers another remote",
  (action) =>
    Effect.gen(function* () {
      const selectedHost = "gitlab.example.test:8443";
      const otherHost = "other.gitlab.example.test";
      const readHosts: string[] = [];
      const actionHosts: string[] = [];
      const cli = yield* GitLabPullRequestCli.make.pipe(
        Effect.provide(
          GitLabCli.layer.pipe(
            Layer.provide(
              Layer.mock(VcsProcess.VcsProcess)({
                run: (input) => {
                  // glab prefers a remote named `gitlab` to `origin`; the selected host must win.
                  const host = input.env?.GITLAB_HOST ?? otherHost;
                  const path = input.args[1];
                  const methodIndex = input.args.indexOf("--method");
                  const isAction = input.args[0] === "mr" || input.args[methodIndex + 1] === "POST";
                  (isAction ? actionHosts : readHosts).push(host);
                  const response =
                    input.args[0] === "mr"
                      ? {}
                      : path === "user"
                        ? { username: "reviewer" }
                        : path === "graphql"
                          ? {
                              data: {
                                project: {
                                  mergeRequests: {
                                    nodes: [
                                      {
                                        iid: "7",
                                        diffStatsSummary: { additions: 2, deletions: 1 },
                                      },
                                    ],
                                  },
                                },
                              },
                            }
                          : path?.includes("/merge_requests/7")
                            ? {
                                iid: 7,
                                title: "Merge request 7",
                                web_url: `https://${host}/acme/web/-/merge_requests/7`,
                                source_branch: "feature",
                                target_branch: "main",
                                state: "opened",
                                created_at: "2026-07-01T00:00:00Z",
                                updated_at: "2026-07-02T00:00:00Z",
                                user: { can_merge: true },
                              }
                            : { merge_method: "merge", squash_option: "default_off" };
                  return Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: JSON.stringify(response),
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
                },
              }),
            ),
          ),
        ),
      );
      const provider = yield* make.pipe(
        Effect.provideService(GitLabPullRequestCli.GitLabPullRequestCli, cli),
      );
      const reference = {
        cwd: "/repo",
        repository: "acme/web",
        host: selectedHost,
        number: 7,
      };

      const detail = yield* provider.getChangeRequest(reference);
      expect(detail.url).toBe(`https://${selectedHost}/acme/web/-/merge_requests/7`);
      expect({ additions: detail.additions, deletions: detail.deletions }).toEqual({
        additions: 2,
        deletions: 1,
      });
      expect(yield* provider.getViewer(reference)).toBe("reviewer");
      yield* provider.runAction({ ...reference, action });

      expect(readHosts).toEqual([selectedHost, selectedHost, selectedHost]);
      expect(actionHosts).toEqual([selectedHost, selectedHost]);
    }),
);

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: true })).toEqual({
      // Arming a merge for later and taking the arming back answer to the same `can_merge`.
      actions: [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      // GitLab says nothing about who may set a reviewer, and an unreported permission is granted.
      requestReviewers: true,
      // Rebase and nothing else: GitLab cannot merge a target branch into a source branch, so
      // offering the choice would be offering something no request could carry out.
      updateMethods: ["rebase"],
    });
  });

  it("keeps merge, now and later, from a viewer GitLab says cannot", () => {
    // `user.can_merge` already accounts for the role, the approval rules and a protected target
    // branch, so it is the one answer here that does not have to be inferred.
    expect(gitLabViewerPermissions({ viewerCanMerge: false })).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
    });
  });

  it("names no way of updating a branch it will not let this viewer update", () => {
    // The action and the strategy behind it go together: a button offered with nothing to press
    // it with, or a strategy left standing next to a withheld button, is a half-refusal.
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).updateMethods).toBeUndefined();
  });

  it("treats an author with read access as any other reader, which is all GitLab says", () => {
    // Its REST API names no relationship between the viewer and the merge request beyond
    // `can_merge`, so the four an author keeps stay offered to everyone rather than being taken
    // from the one person entitled to them.
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).actions).toEqual([
      "ready",
      "draft",
      "close",
      "reopen",
    ]);
  });
});

describe("getChangeRequest base freshness", () => {
  const detail = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };

  it.effect("reads checks without fetching project settings", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
          }),
        ),
      );
      const read = provider.getChangeRequestChecks;
      if (read === undefined) return yield* Effect.die("checks read missing");
      expect(
        yield* read({ cwd: "/w", repository: "group/subgroup/web", host: "gitlab.com", number: 7 }),
      ).toEqual({ state: "open", checks: [] });
    }),
  );

  const readWith = (
    divergence: { readonly divergedCommits?: number },
    listMergeRequestStats: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listMergeRequestStats"] = () =>
      Effect.succeed([]),
  ) =>
    Effect.gen(function* () {
      const provider = yield* make;
      return yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          getMergeRequestDetail: () => Effect.succeed({ ...detail, ...divergence }),
          getProjectMergeCapabilities: () =>
            Effect.succeed({ merge: true, squash: true, rebase: true }),
          listMergeRequestStats,
        }),
      ),
    );

  it.effect("fills detail line counts from the GitLab stats query", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({}, () =>
        Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
      );

      expect(changeRequest.additions).toBe(40);
      expect(changeRequest.deletions).toBe(2);
    }),
  );

  it.effect("reads a counted divergence as a branch that has fallen behind", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 3 });

      expect(changeRequest.baseComparison).toBe("behind");
      expect(changeRequest.behindBy).toBe(3);
    }),
  );

  it.effect("reads a divergence of none as a branch that is current", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 0 });

      expect(changeRequest.baseComparison).toBe("up-to-date");
      expect(changeRequest.behindBy).toBe(0);
    }),
  );

  it.effect("says nothing at all where GitLab counted nothing", () =>
    Effect.gen(function* () {
      // An install too old to answer has to leave the page silent rather than let it claim the
      // branch is current, which is the one wrong thing this banner could say.
      const changeRequest = yield* readWith({});

      expect(changeRequest.baseComparison).toBe("unknown");
      expect(changeRequest.behindBy).toBeUndefined();
    }),
  );
});

describe("merge request reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const detail = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };

  const countingProvider = Effect.gen(function* () {
    const calls = { detail: 0, mergeCapabilities: 0 };
    const host = { viewerCanMerge: true };
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          getMergeRequestDetail: (input) =>
            Effect.sync(() => {
              calls.detail += 1;
              return { ...detail, number: input.number, viewerCanMerge: host.viewerCanMerge };
            }),
          getProjectMergeCapabilities: () =>
            Effect.sync(() => {
              calls.mergeCapabilities += 1;
              return { merge: true, squash: true, rebase: true };
            }),
          listMergeRequestStats: () => Effect.succeed([]),
          runMergeRequestAction: () => Effect.void,
        }),
      ),
    );
    const checks = provider.getChangeRequestChecks;
    const forget = provider.forgetChangeRequestReads;
    if (checks === undefined || forget === undefined) {
      return yield* Effect.die("GitLab answers checks and forgets its reads");
    }
    return { provider, checks, forget, calls, host };
  });

  it.effect("includes line counts in summaries and list stats", () =>
    Effect.gen(function* () {
      const stats = [{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }];
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
            getProjectMergeCapabilities: () =>
              Effect.succeed({ merge: true, squash: true, rebase: true }),
            listMergeRequestStats: () => Effect.succeed(stats),
          }),
        ),
      );
      const readSummary = provider.getChangeRequestSummary;
      const readStats = provider.listChangeRequestStats;
      if (readSummary === undefined || readStats === undefined) {
        return yield* Effect.die("GitLab provides summaries and list stats");
      }

      expect(yield* readSummary(reference)).toMatchObject({ additions: 40, deletions: 2 });
      expect(
        yield* readStats({
          cwd: "/w",
          host: "gitlab.com",
          changeRequests: [{ repository: "acme/web", number: 7 }],
        }),
      ).toEqual(stats);
    }),
  );

  it.effect("asks for project merge methods once across its merge requests", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest({ ...reference, number: 8 });

      expect(calls.mergeCapabilities).toBe(1);
    }),
  );

  it.effect("answers checks from the merge request the detail just read", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* checks(reference);

      expect(calls.detail).toBe(1);
    }),
  );

  it.effect("reads the merge request again after a write to it", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.runAction({ ...reference, action: "ready" });
      yield* checks(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect.each([{ cwd: "/other" }, { host: "other.gitlab.test" }])(
    "does not share reads with %j",
    (other) =>
      Effect.gen(function* () {
        const { provider, calls } = yield* countingProvider;

        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });
        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });

        expect(calls).toEqual({ detail: 2, mergeCapabilities: 2 });
      }),
  );

  it.effect("reads a merge request again once a minute has passed", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* TestClock.adjust("61 seconds");
      yield* provider.getChangeRequest(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect("answers viewer permissions from GitLab, not the page's read", () =>
    Effect.gen(function* () {
      const { provider, host } = yield* countingProvider;

      host.viewerCanMerge = false;
      yield* provider.getChangeRequest(reference);
      host.viewerCanMerge = true;
      const granted = yield* provider.getViewerPermissions(reference);
      host.viewerCanMerge = false;
      const revoked = yield* provider.getViewerPermissions(reference);

      expect(granted.actions).toContain("merge");
      expect(revoked.actions).not.toContain("merge");
    }),
  );

  it.effect("reads a merge request again after its reads are forgotten", () =>
    Effect.gen(function* () {
      const { provider, checks, forget, calls } = yield* countingProvider;
      const other = { ...reference, repository: "acme/api" };

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(other);
      yield* forget({ repository: "ACME/web", number: 7 });
      yield* checks(reference);
      yield* checks(other);
      expect(calls.detail).toBe(3);

      yield* forget({ repository: "acme/web" });
      yield* checks(reference);
      yield* forget();
      yield* checks(other);
      expect(calls.detail).toBe(5);
    }),
  );
});

describe("rewriting what has already been said", () => {
  const updateMergeRequest = vi.fn(() => Effect.void);
  const updateNote = vi.fn(() => Effect.void);

  const providerWith = make.pipe(
    Effect.provide(
      Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({ updateMergeRequest, updateNote }),
    ),
  );

  it.effect("sends only the half of the merge request the reader rewrote", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateChangeRequest);

      yield* provider.updateChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        body: "What this changes.",
      });

      // GitLab calls it the description, and the title stays out of the request entirely.
      expect(updateMergeRequest).toHaveBeenCalledWith({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        description: "What this changes.",
      });
    }),
  );

  it.effect("rewrites a positioned comment through the same note as any other", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateComment);

      yield* provider.updateComment({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        commentId: "42",
        kind: "review-comment",
        body: "Reworded.",
      });

      expect(updateNote).toHaveBeenCalledWith({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        noteId: "42",
        body: "Reworded.",
      });
    }),
  );
});
