// @vitest-environment jsdom
import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("environment-test");

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => null,
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { threadPullRequests: true } } }],
    ])) as never,
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("updates palette PR status from linked snapshots without a legacy link or branch PR", async () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "example/repo",
    number: 7,
    url: "https://github.com/example/repo/pull/7",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: {
      state: "merged",
      title: "Linked change",
      headBranch: "deleted-branch",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-03T00:00:00Z",
    },
  };
  const row = (pullRequest: ThreadPullRequestLink) => (
    <AppAtomRegistryProvider>
      <ThreadRowLeadingStatus
        thread={makeThreadFixture({
          environmentId,
          linkedPullRequest: null,
          branchPullRequest: null,
          pullRequests: [pullRequest],
        })}
      />
    </AppAtomRegistryProvider>
  );
  const hasLabel = (label: string) =>
    renderer!.root.findAllByProps({ "aria-label": label }).length > 0;

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(row(link));
  });
  expect(hasLabel("PR #7 - Merged: Linked change")).toBe(true);
  expect(hasLabel("PR #7, status pending")).toBe(false);

  await act(async () => {
    renderer!.update(row({ ...link, snapshot: null }));
  });
  expect(hasLabel("PR #7, status pending")).toBe(true);
  expect(hasLabel("PR #7 - Merged: Linked change")).toBe(false);

  await act(async () => {
    renderer!.update(
      row({ ...link, snapshot: { ...link.snapshot!, state: "open", isDraft: true } }),
    );
  });
  expect(hasLabel("PR #7 - Draft: Linked change")).toBe(true);
  expect(hasLabel("PR #7, status pending")).toBe(false);
});
