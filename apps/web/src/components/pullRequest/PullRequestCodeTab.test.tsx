import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestDiffResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

type DiffPageAtom = Atom.Writable<AsyncResult.AsyncResult<PullRequestDiffResult>>;

const state = vi.hoisted(() => ({
  pages: new Map<string | null, DiffPageAtom>(),
}));

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    diff: ({ input }: { input: { cursor?: string } }) => state.pages.get(input.cursor ?? null)!,
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffFilesCollapsed: false,
    diffLayout: "unified",
    wordWrap: false,
    diffIgnoreWhitespace: false,
  }),
  useUpdateClientSettings: () => () => {},
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, () => {}] }));
vi.mock("../diffs/useHideTestFiles", () => ({ useHideTestFiles: () => [false, () => {}] }));
vi.mock("../diffs/useCodeViewFileReveal", () => ({ useCodeViewFileReveal: () => () => {} }));
vi.mock("./usePullRequestFilesViewed", () => ({
  usePullRequestFilesViewed: () => ({
    setViewed: () => {},
    refresh: () => {},
    enabled: false,
    isViewed: () => false,
    isStale: () => false,
  }),
}));
vi.mock("./pullRequestReviewStore", () => ({
  nextPendingReviewCommentId: () => "pending-comment",
  pullRequestReviewKey: () => "owner/repo#1",
  usePendingReviewComments: () => [],
  usePullRequestReviewStore: () => () => {},
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("~/lib/diffFileContents", () => ({
  createPullRequestDiffFileContentsLoader: () => () => {},
}));
vi.mock("../diffs/StyledDiffCodeView", () => ({ StyledDiffCodeView: () => null }));
vi.mock("../diffs/DiffFileTree", () => ({
  DiffFileTree: ({
    entries,
    footer,
  }: {
    entries: ReadonlyArray<{ path: string }>;
    footer?: ReactNode;
  }) => (
    <div>
      <output data-testid="diff-files">
        {entries.map(({ path }) => (
          <span key={path}>{path}</span>
        ))}
      </output>
      {footer}
    </div>
  ),
}));
vi.mock("./pullRequestPresentation", () => ({
  PullRequestDiffStat: () => null,
  PullRequestMetaLine: () => null,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: ComponentProps<"button">["onClick"];
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/menu", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Trigger = ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  );
  return {
    DropdownMenu: Wrapper,
    DropdownMenuContent: Wrapper,
    DropdownMenuItem: Wrapper,
    DropdownMenuRadioGroup: Wrapper,
    DropdownMenuRadioItem: Wrapper,
    DropdownMenuTrigger: Trigger,
  };
});
vi.mock("../ui/tooltip", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Trigger = ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  );
  return { Tooltip: Wrapper, TooltipPopup: Wrapper, TooltipTrigger: Trigger };
});
vi.mock("../ui/toggle-group", () => ({
  Toggle: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  ToggleGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/checkbox", () => ({ Checkbox: () => null }));
vi.mock("../ui/collapsible", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Collapsible: Wrapper, CollapsiblePanel: Wrapper, CollapsibleTrigger: Wrapper };
});
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));

import PullRequestCodeTab from "./PullRequestCodeTab";

const environmentId = EnvironmentId.make("test");
const projectId = ProjectId.make("project");
const reference: PullRequestRef = { projectId, repository: "owner/repo", number: 1 };
const detail: PullRequestDetailView = {
  provider: "github",
  projectId,
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 2,
  deletions: 0,
  changedFiles: 2,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

let renderer: ReactTestRenderer | null = null;
let disposeRegistry: (() => void) | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  disposeRegistry?.();
  disposeRegistry = null;
  state.pages.clear();
});

function page(path: string, value: string, nextCursor: string | null): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${value}\n`,
    truncated: false,
    nextCursor,
  };
}

function filePaths(): string[] {
  return renderer!.root
    .findByProps({ "data-testid": "diff-files" })
    .findAllByType("span")
    .map((node) => node.children.join(""));
}

it("keeps an in-flight cached next page out of the rendered diff until it settles", async () => {
  const registry = AtomRegistry.make();
  disposeRegistry = () => registry.dispose();
  const first = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(page("first.ts", "FIRST", "next")),
  );
  const next = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(page("stale.ts", "STALE", null), { waiting: true }),
  );
  state.pages.set(null, first);
  state.pages.set("next", next);

  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <PullRequestCodeTab
          environmentId={environmentId}
          reference={reference}
          detail={detail}
          selectedCommitOid={null}
          onSelectedCommitChange={() => {}}
          onRefresh={() => {}}
        />
      </RegistryContext.Provider>,
    );
  });
  expect(filePaths()).toEqual(["first.ts"]);

  const loadMore = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Load more files"));
  expect(loadMore).toBeDefined();
  await act(async () => loadMore!.props.onClick());
  expect(filePaths()).toEqual(["first.ts"]);

  await act(() => registry.set(next, AsyncResult.success(page("fresh.ts", "FRESH", null))));
  expect(filePaths()).toEqual(["first.ts", "fresh.ts"]);
});
