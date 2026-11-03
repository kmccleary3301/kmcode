// @vitest-environment jsdom

import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  onTaskListChange: undefined as
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined,
}));

vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/server", async () => {
  // vi.mock hoists this factory before static imports, so load its Atom constructor here.
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { configValueAtom: () => Atom.make(null) } };
});
vi.mock("~/remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: "local-exec" }) }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { readonly wordWrap: boolean }) => boolean) =>
    select({ wordWrap: false }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => false,
  setLocalStorageItem: vi.fn(),
  useLocalStorage: (key: string, initial: boolean) => [
    key === "t3code.renderMarkdown" || initial,
    vi.fn(),
  ],
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "Local" }),
  useEnvironmentHttpBaseUrl: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/browser/previewRuntime", () => ({ usePreviewAvailable: () => false }));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({ _tag: "Loading" }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("~/state/threads", () => ({
  environmentThreadDetails: { visibleTurnItemsAtom: vi.fn() },
}));
vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: () => false,
  openFileInPreview: vi.fn(),
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));
vi.mock("./FileBreadcrumbs", () => ({ FileBreadcrumbs: () => null }));
vi.mock("./FileMarkdownPreview", () => ({
  FileMarkdownPreview: (props: {
    readonly onTaskListChange?:
      | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
      | undefined;
  }) => {
    state.onTaskListChange = props.onTaskListChange;
    return null;
  },
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_LINK_REVEAL_ATTRIBUTE: "data-file-link-reveal",
  FILE_LINK_REVEAL_UNSAFE_CSS: "",
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: () => null,
  FileSurfaceFailure: () => null,
  FileSurfaceLoading: () => null,
}));
vi.mock("./projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => null,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: vi.fn(),
  confirmProjectFileQueryData: vi.fn(),
}));
vi.mock("./useFileSaveCoordinator", () => ({
  useFileSaveCoordinator: () => ({ change: vi.fn() }),
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };

function markdownPreview() {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath="tasks.md"
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      availableEditors={[]}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={vi.fn()}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

describe("truncated rendered Markdown previews", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.onTaskListChange = undefined;
  });

  afterEach(async () => {
    if (renderer) {
      await act(() => renderer?.unmount());
      renderer = null;
    }
    vi.unstubAllGlobals();
  });

  it("does not expose task editing for a truncated read", async () => {
    state.file = {
      relativePath: "tasks.md",
      contents: "- [ ] Keep the rest of this file\n",
      byteLength: 1_200_000,
      truncated: true,
    };
    await act(async () => {
      renderer = create(markdownPreview());
    });

    expect(state.onTaskListChange).toBeUndefined();
  });

  it("keeps task editing enabled for a complete read", async () => {
    state.file = {
      relativePath: "tasks.md",
      contents: "- [ ] Keep the rest of this file\n",
      byteLength: 32,
      truncated: false,
    };
    await act(async () => {
      renderer = create(markdownPreview());
    });

    expect(state.onTaskListChange).toBeTypeOf("function");
  });
});
