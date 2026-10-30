import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  type BrowserLinkTarget,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import { renderCodexFileCitationsAsMarkdown } from "@t3tools/client-runtime/codex-markdown-directives";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "../chat/ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "../chat/markdownImageGallery";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../../editorPreferences";
import { openInEditorMenuLabel } from "../../editorLabels";
import { resolveDiffThemeName, type DiffThemeName } from "../../lib/diffRendering";
import {
  chatMarkdownClipboardPayload,
} from "../../markdown-clipboard";
import {
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../../markdown-links";
import {
  buildFileLinkParentSuffixByPath,
  extractInlineCodeSpans,
  MarkdownFileLink,
  normalizeMarkdownLinkHrefKey,
} from "./MarkdownLinks";
import { useRemoteOpenResolution, type RemoteOpenMode } from "../../remoteOpen";
import { useRightPanelStore } from "../../rightPanelStore";
import { recordVisitForThread } from "../../browserHistoryStore";
import { readThreadShell, useProjects } from "../../state/entities";
import { useTheme } from "../../hooks/useTheme";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope, usePreparedConnection, useEnvironmentScope } from "../../state/session";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { projectEnvironment } from "../../state/projects";
import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "../../workspaceBasenameLookup";
import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
  useOpenChangeRequestLink,
} from "~/lib/openPullRequestLink";
import { useOpenLink } from "../../browser/useOpenLink";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { isAbsolutePath, resolvePathLinkTarget } from "../../terminal-links";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
} from "../../browser/openFileInPreview";
import { useClientSettings } from "../../hooks/useSettings";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";

export interface ChatMarkdownComponentState {
  readonly reportMarkdownActionFailure: typeof reportMarkdownActionFailure;
  readonly canOperateHost: boolean;
  readonly canOperatePreview: boolean;
  readonly cwd: string | undefined;
  readonly diffThemeName: DiffThemeName;
  readonly environmentId: EnvironmentId | null;
  readonly expandMedia: (preview: ExpandedImagePreview) => void;
  readonly fileLinkChip: (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    mediaSource?: string,
  ) => ReactNode;
  readonly githubMedia: boolean;
  readonly renderContextReference:
    | ((reference: ChatMarkdownContextReference) => ReactNode)
    | undefined;
  readonly headingLevelOffset: number;
  readonly imageBaseDir: string | undefined;
  readonly inlineCodeFileLinkMetaByText: Map<string, MarkdownFileLinkMeta>;
  readonly isStreaming: boolean;
  readonly linkTargetPreference: BrowserLinkTarget;
  readonly markdownFileLinkMetaByHref: Map<string, MarkdownFileLinkMeta>;
  readonly onTaskListChange:
    | ((input: { markerOffset: number; checked: boolean }) => void)
    | undefined;
  readonly onUseArtifactTemplate: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly onRunShellCommand: ((command: string) => void) | undefined;
  readonly openChangeRequestLink: (
    event: Pick<
      ReactMouseEvent<HTMLElement>,
      "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
    >,
    targetUrl: string,
    targetThreadRef?: ScopedThreadRef,
    targetEnvironmentId?: EnvironmentId,
  ) => boolean;
  readonly openDeferredMarkdownLink: (
    url: string,
    options?: {
      readonly event?: { readonly metaKey: boolean; readonly ctrlKey: boolean };
      readonly threadRef?: ScopedThreadRef | undefined;
    },
  ) => Promise<void>;
  readonly openExternalLinkInPreview: (url: string) => Promise<AtomCommandResult<void, unknown>>;
  readonly openMarkdownMedia: (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => void;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly pullRequestRepositoryUrl: string | undefined;
  readonly linkedThreadPullRequestFor: (
    href: string,
  ) => (ThreadPullRequestKey & { readonly url: string }) | null;
  readonly resolveThreadPullRequest: (
    href: string,
  ) => (ThreadPullRequestKey & { readonly url: string }) | null;
  readonly resolvedTheme: "light" | "dark";
  readonly serverConfig:
    | {
        readonly environment: {
          readonly capabilities: { readonly pullRequests?: boolean };
        };
      }
    | null
    | undefined;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly text: string;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly updateThreadPullRequestLink: (href: string, linked: boolean) => Promise<void>;
}

interface ChatMarkdownState {
  readonly componentState: ChatMarkdownComponentState;
  readonly handleCopy: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  readonly markdownRef: React.RefObject<HTMLDivElement | null>;
  readonly markdownUrlTransform: (href: string) => string;
  readonly localMediaPreview: ExpandedImagePreview | null;
  readonly setLocalMediaPreview: React.Dispatch<React.SetStateAction<ExpandedImagePreview | null>>;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const SAFE_MARKDOWN_URL_PROTOCOL = /^(?:https?|ircs?|mailto|xmpp)$/iu;
export interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  /** Panel that receives pull request links, including the standalone PR view. */
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  /** Environment that owns non-thread markdown, such as a pull request panel. */
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  /** Wrap the words of the streaming block so arriving words fade in (the minimal style animates them). */
  streamWordFade?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  /** Treat single newlines as hard breaks — chat-style user input. */
  lineBreaks?: boolean;
  /** Parse sanitized raw HTML instead of displaying its source text. */
  parseRawHtml?: boolean;
  /** Append a prompt that invokes a newly created artifact-template skill. */
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  /** Directory that anchors relative links and images; defaults to `cwd`. Set
      to the file's own directory when rendering a markdown file. */
  imageBaseDir?: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  pullRequestRepositoryUrl?: string | undefined;
  /** Renders a `t3-context://` link as a chip; without it the link shows its label as text. */
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads GitHub-hosted media through `cwd`'s GitHub credential, which a private repository's
      uploads need; without it those images and videos load unauthenticated and 404. */
  githubMedia?: boolean | undefined;
  /** Levels added to each markdown heading in the accessibility tree so the
      text nests under the heading that introduces it, such as a chat message's
      author. Rendered tags and their styling are unchanged. */
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}
interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

export function reportMarkdownActionFailure(context: MarkdownActionFailureContext, cause: unknown): void {
  console.error("[chat-markdown] action failed", context, cause);
}
export function useChatMarkdownState({
  text,
  cwd,
  threadRef,
  pullRequestPanelRef,
  pullRequestRepositoryUrl,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  onImageExpand,
  renderContextReference,
  headingLevelOffset = 0,
  githubMedia = false,
}: ChatMarkdownProps): ChatMarkdownState {
  const { resolvedTheme } = useTheme();
  const [localMediaPreview, setLocalMediaPreview] = useState<ExpandedImagePreview | null>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const expandMedia = onImageExpand ?? setLocalMediaPreview;
  const mediaRequestId = useRef(0);
  useEffect(() => {
    setLocalMediaPreview(null);
    return () => {
      mediaRequestId.current += 1;
    };
  }, [threadRef?.environmentId, threadRef?.threadId, explicitEnvironmentId, cwd, imageBaseDir]);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const preparedConnection = usePreparedConnection(environmentId);
  const openMarkdownMedia = useCallback(
    (source: string, resolvedFilePath?: string, clickedImage?: HTMLImageElement | null) => {
      const requestId = ++mediaRequestId.current;
      void resolveMarkdownMediaPreview({
        source,
        resolvedFilePath,
        cwd,
        threadRef,
        httpBaseUrl:
          preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : undefined,
        createAssetUrl,
        onOpenFile: threadRef
          ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
          : undefined,
      }).then(
        (preview) => {
          if (preview && mediaRequestId.current === requestId) {
            const selected = preview.images[preview.index];
            expandMedia(
              selected && selected.type !== "video" && markdownRef.current
                ? markdownImageGallery(clickedImage ?? markdownRef.current, selected)
                : preview,
            );
          }
        },
        (error: unknown) => {
          if (mediaRequestId.current !== requestId) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Media unavailable",
              description:
                error instanceof Error
                  ? error.message
                  : "The file could not be loaded. It may have been moved or deleted.",
            }),
          );
        },
      );
    },
    [createAssetUrl, cwd, expandMedia, preparedConnection, threadRef],
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const projects = useProjects();
  const availableEditors = serverConfig?.availableEditors ?? [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealInFileManagerLabel =
    environmentId !== null &&
    serverConfig?.shellRevealInFileManager === true &&
    serverConfig.availableEditors.includes("file-manager")
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : undefined;
  const revealFileInFileManager = useCallback(
    (filePath: string) => {
      if (environmentId === null) {
        return Promise.resolve(
          AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
            Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
          ),
        );
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
        return Promise.resolve(
          AsyncResult.failure<void, Error>(
            Cause.fail(new Error("This connection cannot reveal files on this environment.")),
          ),
        );
      }
      return openInEditor({
        environmentId,
        input: { cwd: filePath, editor: "file-manager", reveal: true },
      });
    },
    [environmentId, openInEditor],
  );
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(renderCodexFileCitationsAsMarkdown(text))) {
      if (parseComposerContextHref(href)) continue;
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, imageBaseDir, text]);
  const inlineCodeFileLinkMetaByText = useMemo(() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  }, [cwd, imageBaseDir, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [inlineCodeFileLinkMetaByText, markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    if (parseAssistantCitationHref(href)) return href;
    if (parseComposerContextHref(href)) return href;
    if (parseThreadLinkHref(href)) return href;
    if (isWindowsDrivePathHref(href)) return href;
    const fileHref = rewriteMarkdownFileUriHref(href);
    if (fileHref) return fileHref;
    // Same allowlist as react-markdown's defaultUrlTransform: relative URLs or safe protocols only.
    const colon = href.indexOf(":");
    const pathBoundary = href.search(/[/?#]/u);
    if (colon === -1 || (pathBoundary !== -1 && colon > pathBoundary)) return href;
    return SAFE_MARKDOWN_URL_PROTOCOL.test(href.slice(0, colon)) ? href : "";
  }, []);
  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    const fragment = event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    event.clipboardData.setData(
      "text/html",
      fragment
        ? encodeComposerContextClipboardHtml(payload.text, fragment, payload.html)
        : payload.html,
    );
  }, []);
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribed rather than read at click time: the anchor has to decide
  // synchronously whether to intercept its `_blank`, and a subscription is what
  // makes a persisted "app" apply once settings hydrate after launch.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  const resolveThreadPullRequest = useCallback(
    (href: string): (ThreadPullRequestKey & { readonly url: string }) | null => {
      if (
        threadRef === undefined ||
        readThreadShell(threadRef) === null ||
        !pullRequestLinking.canLink(href)
      )
        return null;
      const parsed = parseChangeRequestUrl(href);
      return parsed === null ? null : { ...parsed, url: href };
    },
    [pullRequestLinking, threadRef],
  );
  const linkedThreadPullRequestFor = useCallback(
    (href: string) => {
      if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
        return null;
      const parsed = parseChangeRequestUrl(href);
      return parsed === null ? null : { ...parsed, url: href };
    },
    [pullRequestLinking, threadRef],
  );
  const updateThreadPullRequestLink = useCallback(
    async (href: string, linked: boolean) => {
      if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      await pullRequestLinking.changeLink(threadRef, href, linked);
    },
    [linkedThreadPullRequestFor, pullRequestLinking, threadRef],
  );
  const openExternalLinkInPreview = useCallback(
    (url: string) => {
      if (!threadRef || !canOperatePreview) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Preview access is unavailable for this client.",
              }),
            ),
          ),
        );
      }
      return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
        if (result._tag === "Success") recordVisitForThread(threadRef, url);
        else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          if (error instanceof BrowserSettingsReadError) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to open link in browser",
                description: error.message,
              }),
            );
          }
        }
        return result;
      });
    },
    [canOperatePreview, openPreview, threadRef],
  );
  const openMarkdownFileInPreview = useCallback(
    (path: string) => {
      if (!threadRef || !canOperatePreview || preparedConnection._tag === "None") {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Environment is not connected.",
              }),
            ),
          ),
        );
      }
      return openFileInPreview({
        threadRef,
        filePath: path,
        workspaceRoot: cwd,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
    },
    [canOperatePreview, createAssetUrl, cwd, openPreview, preparedConnection, threadRef],
  );
  const findWorkspaceBasenameMatch = useCallback(
    async (workspaceRelativePath: string) => {
      if (
        !cwd ||
        environmentId === null ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
        !needsWorkspaceBasenameLookup(workspaceRelativePath)
      ) {
        return null;
      }
      const result = await searchProjectEntries({
        environmentId,
        input: {
          cwd,
          query: workspaceRelativePath,
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          kind: "file",
        },
      });
      return result._tag === "Success"
        ? pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries)
        : null;
    },
    [cwd, environmentId, searchProjectEntries],
  );
  // A bare filename resolves to the workspace root, which is rarely where the
  // file is, so ask the index before opening. Absolute host paths open as-is.
  const openFileInPanel = useCallback(
    (panelPath: string, line: number | undefined) => {
      if (!threadRef) return;
      // Claimed on every open so a synchronous one supersedes a lookup already
      // in flight.
      const isLatestLookup = claimWorkspaceBasenameLookup();
      const openAt = (path: string) =>
        useRightPanelStore.getState().openFile(threadRef, path, line);
      if (!cwd || !needsWorkspaceBasenameLookup(panelPath)) {
        openAt(panelPath);
        return;
      }
      void (async () => {
        const match = await findWorkspaceBasenameMatch(panelPath);
        if (!isLatestLookup()) return;
        openAt(match ?? panelPath);
      })();
    },
    [cwd, findWorkspaceBasenameMatch, threadRef],
  );
  const revealMarkdownFileInFileManager = useCallback(
    async (fileLinkMeta: MarkdownFileLinkMeta) => {
      const workspaceRelativePath = fileLinkMeta.workspaceRelativePath;
      const match = workspaceRelativePath
        ? await findWorkspaceBasenameMatch(workspaceRelativePath)
        : null;
      const filePath = match && cwd ? resolvePathLinkTarget(match, cwd) : fileLinkMeta.filePath;
      return revealFileInFileManager(filePath);
    },
    [cwd, findWorkspaceBasenameMatch, revealFileInFileManager],
  );
  const fileLinkChip = useCallback(
    (fileLinkMeta: MarkdownFileLinkMeta, copyMarkdown: string, mediaSource?: string) => {
      const parentSuffix = fileLinkParentSuffixByPath.get(
        fileLinkMeta.filePath.replaceAll("\\", "/"),
      );
      const labelParts = [fileLinkMeta.basename];
      if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
        labelParts.push(parentSuffix);
      }
      if (fileLinkMeta.line) {
        labelParts.push(
          `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
        );
      }
      const mediaPath = mediaSource ?? fileLinkMeta.filePath;
      const canPreviewMedia =
        mediaMimeTypeFromExtension(
          fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
        ) !== null;
      // Media outside the workspace keeps the expanded preview; other host
      // files (a report in a temp dir) open read-only in the files panel.
      const panelPath =
        fileLinkMeta.workspaceRelativePath ??
        (!canPreviewMedia && isAbsolutePath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

      return (
        <MarkdownFileLink
          href={fileLinkMeta.targetPath}
          targetPath={fileLinkMeta.targetPath}
          iconPath={fileLinkMeta.filePath}
          displayPath={fileLinkMeta.displayPath}
          panelPath={panelPath}
          line={fileLinkMeta.line}
          label={labelParts.join(" · ")}
          copyMarkdown={copyMarkdown}
          theme={resolvedTheme}
          reportMarkdownActionFailure={reportMarkdownActionFailure}
          threadRef={threadRef}
          {...(canUseShellActions ? { onOpen: openInPreferredEditor } : {})}
          onOpenInPanel={openFileInPanel}
          onOpenMedia={
            threadRef && canPreviewMedia
              ? () => openMarkdownMedia(mediaPath, fileLinkMeta.filePath)
              : undefined
          }
          openInEditorMenuLabel={preferredEditorMenuLabel}
          onReveal={
            canUseShellActions && revealInFileManagerLabel !== undefined
              ? () => revealMarkdownFileInFileManager(fileLinkMeta)
              : undefined
          }
          revealLabel={revealInFileManagerLabel}
          onOpenInBrowser={
            threadRef &&
            canOperatePreview &&
            isPreviewAvailableFor(threadRef.environmentId) &&
            isBrowserPreviewFile(fileLinkMeta.filePath)
              ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
              : undefined
          }
        />
      );
    },
    [
      canUseShellActions,
      canOperatePreview,
      fileLinkParentSuffixByPath,
      openFileInPanel,
      openInPreferredEditor,
      openMarkdownFileInPreview,
      openMarkdownMedia,
      preferredEditorMenuLabel,
      resolvedTheme,
      revealInFileManagerLabel,
      revealMarkdownFileInFileManager,
      threadRef,
    ],
  );

  const componentState = useMemo<ChatMarkdownComponentState>(
    () => ({
      reportMarkdownActionFailure,
      canOperateHost,
      canOperatePreview,
      cwd,
      diffThemeName,
      environmentId,
      expandMedia,
      fileLinkChip,
      githubMedia,
      renderContextReference,
      headingLevelOffset,
      imageBaseDir,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      linkTargetPreference,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      onUseArtifactTemplate,
      onRunShellCommand,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      openExternalLinkInPreview,
      openMarkdownMedia,
      projects,
      pullRequestRepositoryUrl,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      resolvedTheme,
      serverConfig,
      skills,
      text,
      threadRef,
      updateThreadPullRequestLink,
    }),
    [
      canOperateHost,
      canOperatePreview,
      cwd,
      diffThemeName,
      environmentId,
      expandMedia,
      fileLinkChip,
      githubMedia,
      renderContextReference,
      headingLevelOffset,
      imageBaseDir,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      linkTargetPreference,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      onUseArtifactTemplate,
      onRunShellCommand,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      openExternalLinkInPreview,
      openMarkdownMedia,
      projects,
      pullRequestRepositoryUrl,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      resolvedTheme,
      serverConfig,
      skills,
      text,
      threadRef,
      updateThreadPullRequestLink,
    ],
  );
  return {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    setLocalMediaPreview,
  };
}
export const ChatMarkdownRendererContext =
  React.createContext<ChatMarkdownComponentState>(null!);
