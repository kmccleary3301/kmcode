import { GlobeIcon } from "lucide-react";
import { isMarkdownFileLinkLabel } from "@t3tools/client-runtime/markdown-links";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { mediaKindFromPath } from "@t3tools/shared/filePreview";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  Children,
  isValidElement,
  memo,
  use,
  useCallback,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { InlineNodeViewProps } from "@stream-mdx/react";
import type { InlineNode } from "@stream-mdx/core";
import {
  codexFileCitationMarkdown,
  resolveCodexFileCitationLink,
} from "@t3tools/client-runtime/codex-file-citations";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  shouldOpenMarkdownFileLinkInEditor,
  type MarkdownFileLinkMeta,
  normalizeMarkdownLinkDestination,
} from "../../markdown-links";
import {
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
} from "~/lib/openPullRequestLink";
import { resolveLinkTarget } from "../../browser/browserLinkTarget";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { BrowserSettingsReadError } from "../../browser/openFileInPreview";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ContextChip } from "../ContextChip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AssistantCitationChip } from "../chat/AssistantCitationChip";
import { MarkdownThreadLink } from "../chat/MarkdownThreadLink";
import { FileTagChipContent } from "../chat/FileTagChip";
import { GitHubIcon } from "../Icons";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "../chat/externalLinkContextMenu";
import { ChatMarkdownRendererContext, type ChatMarkdownComponentState } from "./markdownContext";
import { MarkdownLinkContext } from "./MarkdownMedia";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  iconPath: string;
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return (
    input.canOpenInBrowser &&
    (shouldOpenMarkdownFileLinkInBrowserByDefault(input.iconPath) ||
      (!input.canOpenInEditor && !input.canOpenInPanel))
  );
}
export const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
export function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

export function inlineNodesToPlainText(nodes: readonly InlineNode[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "code":
        text += node.text;
        break;
      case "strong":
      case "em":
      case "strike":
      case "link":
        text += inlineNodesToPlainText(node.children);
        break;
      case "html":
      case "plugin":
        text += node.children
          ? inlineNodesToPlainText(node.children)
          : node.kind === "plugin"
            ? node.raw
            : "";
        break;
      case "image":
        text += node.alt ?? "";
        break;
      case "br":
        text += "\n";
        break;
      case "mention":
        text += `@${node.handle}`;
        break;
      case "citation":
        text += node.id;
        break;
      case "math-inline":
      case "math-display":
        text += node.tex;
        break;
      case "footnote-ref":
        text += node.label;
        break;
      case "trusted-mdx-inline":
        text += node.raw;
        break;
    }
  }
  return text;
}
interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  iconPath: string;
  displayPath: string;
  /** What the files panel opens: workspace-relative inside the workspace, the
      absolute host path outside it, null when the panel cannot show the file. */
  panelPath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen?: ((targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenInPanel: (panelPath: string, line: number | undefined) => void;
  openInEditorMenuLabel: string;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenMedia?: (() => void) | undefined;
  onReveal?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  /** Platform-specific menu label ("Reveal in Finder", ...); required for the
      reveal item to show. */
  revealLabel?: string | undefined;
  reportMarkdownActionFailure: ChatMarkdownComponentState["reportMarkdownActionFailure"];
}

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

export function buildFileLinkParentSuffixByPath(
  filePaths: ReadonlyArray<string>,
): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(normalizedPath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

export function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(FENCED_CODE_SEGMENT_PATTERN);
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_CODE_SPAN_PATTERN)) {
      const span = match[1]?.trim();
      if (span) spans.push(span);
    }
  }
  return spans;
}

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Hosts whose favicon request already failed this session — skip straight to the globe. */
const failedFaviconHosts = new Set<string>();

/** Sites whose brand mark (drawn in `currentColor`) replaces the fetched favicon so it follows the theme. */
function brandLinkIcon(host: string): typeof GitHubIcon | null {
  const hostname = host.toLowerCase();
  if (hostname === "github.com" || hostname.endsWith(".github.com")) return GitHubIcon;
  return null;
}

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  const BrandIcon = brandLinkIcon(host);
  const faviconUrl = BrandIcon ? null : faviconUrlForOrigin(`https://${host}`);
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {BrandIcon ? (
        <BrandIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : faviconUrl === null || failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
});

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text.matchAll(/\s+|\S+/g), ({ 0: word, index: start }) =>
    word.length <= 16 ? (
      word
    ) : (
      <span key={start} className="[overflow-wrap:anywhere]">
        {word}
      </span>
    ),
  );
}

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

function handleMarkdownFragmentClick(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = findMarkdownFragmentTarget(event.currentTarget, href);
  if (!target) return;

  event.preventDefault();
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = href.slice(1);
  window.history.pushState(window.history.state, "", nextUrl);
  target.scrollIntoView({ block: "nearest" });
}

function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="[overflow-wrap:anywhere]">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}

export const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  iconPath,
  displayPath,
  panelPath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onOpenInPanel,
  openInEditorMenuLabel,
  onOpenInBrowser,
  onOpenMedia,
  onReveal,
  revealLabel,
  reportMarkdownActionFailure,
}: MarkdownFileLinkProps) {
  const handleOpenInEditor = useCallback(() => {
    if (!onOpen) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpen(targetPath);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpen, targetPath]);

  const handleOpenInFilePreview = useCallback(() => {
    if (threadRef && panelPath) {
      onOpenInPanel(panelPath, line);
      return;
    }
    if (onOpenMedia) {
      onOpenMedia();
      return;
    }
    handleOpenInEditor();
  }, [handleOpenInEditor, line, onOpenInPanel, onOpenMedia, panelPath, threadRef]);

  const handleOpenInBrowser = useCallback(() => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpenInBrowser, targetPath]);

  const handleRevealInFileManager = useCallback(() => {
    if (!onReveal) {
      return;
    }
    void (async () => {
      try {
        const result = await onReveal();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onReveal, targetPath]);

  const handleCopy = useCallback(
    (value: string, title: string) => {
      if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: "Clipboard API unavailable.",
          }),
        );
        return;
      }

      void navigator.clipboard.writeText(value).then(
        () => {
          toastManager.add({
            type: "success",
            title: `${title} copied`,
            description: value,
          });
        },
        (error) => {
          reportMarkdownActionFailure(
            { operation: "copy-file-path", target: targetPath, copyTarget: title },
            error,
          );
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to copy ${title.toLowerCase()}`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    },
    [targetPath],
  );

  const showFileContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;

      try {
        const clicked = await api.contextMenu.show(
          [
            ...(onOpenMedia ? ([{ id: "preview-media", label: "Preview media" }] as const) : []),
            ...(onOpen ? ([{ id: "open", label: openInEditorMenuLabel }] as const) : []),
            ...(onOpenInBrowser
              ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
              : []),
            ...(onReveal && revealLabel ? ([{ id: "reveal", label: revealLabel }] as const) : []),
            { id: "copy-relative", label: "Copy relative path" },
            { id: "copy-full", label: "Copy full path" },
          ] as const,
          position,
        );

        if (clicked === "preview-media") {
          onOpenMedia?.();
          return;
        }
        if (clicked === "open") {
          handleOpenInEditor();
          return;
        }
        if (clicked === "open-in-browser") {
          handleOpenInBrowser();
          return;
        }
        if (clicked === "reveal") {
          handleRevealInFileManager();
          return;
        }
        if (clicked === "copy-relative") {
          handleCopy(displayPath, "Relative path");
          return;
        }
        if (clicked === "copy-full") {
          handleCopy(targetPath, "Full path");
        }
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "show-file-context-menu", target: targetPath },
          cause,
        );
      }
    },
    [
      displayPath,
      handleCopy,
      handleOpenInBrowser,
      handleOpenInEditor,
      handleRevealInFileManager,
      onOpenInBrowser,
      onOpenMedia,
      onOpen,
      onReveal,
      openInEditorMenuLabel,
      revealLabel,
      targetPath,
    ],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const position =
        event.clientX === 0 && event.clientY === 0
          ? (() => {
              const bounds = event.currentTarget.getBoundingClientRect();
              return { x: bounds.left, y: bounds.bottom };
            })()
          : { x: event.clientX, y: event.clientY };
      void showFileContextMenu(position);
    },
    [showFileContextMenu],
  );

  const canOpenInEditor = onOpen !== undefined;
  const canOpenInBrowser = onOpenInBrowser !== undefined;
  const canOpenInPanel = threadRef !== undefined && Boolean(panelPath);
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
    canOpenMedia: onOpenMedia !== undefined,
  });
  const useBrowserPrimaryAction = shouldUseMarkdownFileBrowserPrimaryAction({
    iconPath,
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          hasPrimaryAction ? (
            <ContextChip
              kind="mention"
              render={<a href={href} />}
              className={MARKDOWN_FILE_LINK_CLASS_NAME}
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (onOpen && shouldOpenMarkdownFileLinkInEditor(event)) {
                  handleOpenInEditor();
                  return;
                }
                if (useBrowserPrimaryAction) {
                  handleOpenInBrowser();
                  return;
                }
                handleOpenInFilePreview();
              }}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent path={iconPath} label={label} theme={theme} />
            </ContextChip>
          ) : (
            <ContextChip
              kind="mention"
              render={<button type="button" />}
              aria-label={`File options for ${label}`}
              aria-haspopup="menu"
              className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, "select-text")}
              data-markdown-copy={copyMarkdown}
              onClick={handleContextMenu}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent path={iconPath} label={label} theme={theme} />
            </ContextChip>
          )
        }
      />
      <TooltipPopup side="top" variant="code">
        {/* The full path: the chip already shows the shortened form, and a link
            to the workspace root collapses to a bare label that repeats it. */}
        <div className="overflow-x-auto whitespace-nowrap scrollbar-thumb-border/78 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/78 [&::-webkit-scrollbar-track]:bg-transparent">
          {targetPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.displayPath === next.displayPath &&
    previous.panelPath === next.panelPath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.onOpen === next.onOpen &&
    previous.onOpenInPanel === next.onOpenInPanel &&
    previous.openInEditorMenuLabel === next.openInEditorMenuLabel &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.onOpenMedia === next.onOpenMedia &&
    previous.onReveal === next.onReveal &&
    previous.reportMarkdownActionFailure === next.reportMarkdownActionFailure &&
    previous.revealLabel === next.revealLabel
  );
}
export function MarkdownAnchor({
  href,
  children,
  title: _title,
  markdownState,
  sourceRange,
  pullRequestAutolink,
  pullRequestCopyOverride,
  plainText: suppliedPlainText,
  className,
  ...props
}: ComponentProps<"a"> & {
  readonly markdownState: ChatMarkdownComponentState;
  readonly sourceRange?: { readonly from: number; readonly to: number } | undefined;
  readonly pullRequestAutolink?: "commit" | "reference" | undefined;
  readonly pullRequestCopyOverride?: string | undefined;
  readonly plainText?: string | undefined;
}) {
  const {
    reportMarkdownActionFailure,
    canOperateHost,
    canOperatePreview,
    cwd,
    environmentId,
    imageBaseDir,
    markdownFileLinkMetaByHref,
    threadRef,
    openMarkdownMedia,
    openChangeRequestLink,
    openDeferredMarkdownLink,
    linkTargetPreference,
    openExternalLinkInPreview,
    projects,
    linkedThreadPullRequestFor,
    resolveThreadPullRequest,
    serverConfig,
    updateThreadPullRequestLink,
    fileLinkChip,
    renderContextReference,
    text,
  } = markdownState;
  const plainText = suppliedPlainText ?? nodeToPlainText(children);
  const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
  const citation = href ? parseAssistantCitationHref(href) : null;
  if (citation) return <AssistantCitationChip citation={citation} />;
  // A thread link opens the thread here, never a browser.
  const threadLink = href ? parseThreadLinkHref(href) : null;
  if (threadLink) {
    return <MarkdownThreadLink {...threadLink}>{linkChildren}</MarkdownThreadLink>;
  }
  const contextReference = href ? parseComposerContextHref(href) : null;
  if (contextReference) {
    const label = plainText || contextReference.contextId;
    return renderContextReference ? (
      renderContextReference({ ...contextReference, label })
    ) : (
      <span>{label}</span>
    );
  }
  const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
  const fileLinkMeta = normalizedHref
    ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
      resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd))
    : null;
  if (!fileLinkMeta) {
    const faviconHost = resolveExternalWebLinkHost(href);
    const pullRequestCopy =
      pullRequestCopyOverride ??
      (pullRequestAutolink === "commit"
        ? /\/commit\/([0-9a-f]{40})$/iu.exec(href ?? "")?.[1]
        : pullRequestAutolink === "reference"
          ? plainText
          : undefined);
    const isPullRequestAutolink = pullRequestCopy !== undefined;
    const confirmBeforeOpen = pullRequestAutolink === "reference";
    const pullRequestCandidateUrl =
      confirmBeforeOpen && href ? pullRequestCandidateUrlFromReferenceAutolink(href) : href;
    const pullRequestPreviewTarget = pullRequestCandidateUrl
      ? resolvePullRequestPreviewTarget({
          environmentId,
          projects,
          pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
          url: pullRequestCandidateUrl,
        })
      : null;
    const isSameDocumentLink = href?.startsWith("#") ?? false;
    const onClick = props.onClick;
    const canOpenInPreview =
      canOperatePreview && Boolean(threadRef && isPreviewAvailableFor(threadRef.environmentId));
    const link = (
      <a
        {...props}
        className={cn(className, pullRequestAutolink === "commit" && "font-mono")}
        data-markdown-copy={pullRequestCopy}
        href={href}
        target={isSameDocumentLink ? undefined : "_blank"}
        rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
        onClick={(event) => {
          onClick?.(event);
          if (isSameDocumentLink && href) {
            handleMarkdownFragmentClick(event, href);
            return;
          }
          if (
            href &&
            faviconHost !== null &&
            mediaKindFromPath(href) !== null &&
            !event.defaultPrevented &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            openMarkdownMedia(
              href,
              undefined,
              event.target instanceof HTMLImageElement
                ? event.target
                : event.currentTarget.querySelector("img"),
            );
            return;
          }
          // A link to a change request in a workspace project opens beside the
          // conversation instead of in a browser: it is the thing being talked about, and
          // the panel it opens offers the browser as one of its actions.
          if (!href || openChangeRequestLink(event, href, undefined, environmentId ?? undefined)) {
            return;
          }
          // Anything else follows the "Open links in" setting. The system browser
          // keeps the `_blank` the shell already handles; the in-app browser needs
          // the click intercepted here. A modifier click is the way out of the
          // in-app default, so it is left to the shell too.
          if (
            event.defaultPrevented ||
            resolveLinkTarget({
              url: href,
              event,
              preference: linkTargetPreference,
              canOpenInApp: canOpenInPreview,
            }) !== "app"
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          // Keep the link here if saved settings could not be read.
          void openExternalLinkInPreview(href).then((result) => {
            if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
            reportMarkdownActionFailure(
              { operation: "open-link-in-preview", target: href },
              result.cause,
            );
            if (squashAtomCommandFailure(result) instanceof BrowserSettingsReadError) return;
            void readLocalApi()?.shell.openExternal(href);
          });
        }}
        onContextMenu={(event) => {
          if (!href || !faviconHost) return;
          event.preventDefault();
          event.stopPropagation();
          const api = readLocalApi();
          if (!api) return;
          const threadLinkAction = !canOperateHost
            ? undefined
            : linkedThreadPullRequestFor(href) !== null
              ? "unlink-from-thread"
              : resolveThreadPullRequest(href) === null
                ? undefined
                : "link-to-thread";
          void showExternalLinkContextMenu({
            href,
            canOpenInPreview,
            threadLinkAction,
            position: { x: event.clientX, y: event.clientY },
            showContextMenu: (items, position) => api.contextMenu.show(items, position),
            openInPreview: async (target) => {
              const result = await openExternalLinkInPreview(target);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                reportMarkdownActionFailure(
                  { operation: "open-link-in-preview", target },
                  result.cause,
                );
              }
            },
            openExternal: (target) => api.shell.openExternal(target),
            copyLink: (target) => writeTextToClipboard(target, "link"),
            updateThreadLink: updateThreadPullRequestLink,
            reportFailure: (operation, cause) => {
              reportMarkdownActionFailure({ operation, target: href }, cause);
              if (
                operation === "link-pull-request-to-thread" ||
                operation === "unlink-pull-request-from-thread"
              ) {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title:
                      operation === "link-pull-request-to-thread"
                        ? "Unable to link pull request"
                        : "Unable to unlink pull request",
                    description: cause instanceof Error ? cause.message : "The request failed.",
                  }),
                );
              }
            },
          });
        }}
      >
        {faviconHost && plainText.trim().length > 0 && !isPullRequestAutolink ? (
          <MarkdownExternalLinkContent host={faviconHost} plainText={plainText}>
            {linkChildren}
          </MarkdownExternalLinkContent>
        ) : (
          linkChildren
        )}
      </a>
    );
    if (!faviconHost || !href) {
      return link;
    }
    if (pullRequestPreviewTarget !== null) {
      return (
        <PullRequestLinkPreview
          link={link}
          originalUrl={href}
          target={pullRequestPreviewTarget}
          confirmBeforeOpen={confirmBeforeOpen}
          onOpenPullRequest={(targetUrl) =>
            openChangeRequestLink(
              {
                metaKey: false,
                ctrlKey: false,
                preventDefault: () => undefined,
                stopPropagation: () => undefined,
              },
              targetUrl,
              undefined,
              environmentId ?? undefined,
            )
          }
          onOpenFallback={openDeferredMarkdownLink}
        />
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger render={link} />
        <TooltipPopup side="top">{href}</TooltipPopup>
      </Tooltip>
    );
  }

  const label = plainText;
  const start = sourceRange?.from;
  const end = sourceRange?.to;
  const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
  const copyMarkdown =
    source.startsWith("[") && source.includes("](")
      ? source
      : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
  const chip = fileLinkChip(fileLinkMeta, copyMarkdown, normalizedHref);
  return isMarkdownFileLinkLabel(label, normalizedHref) ? (
    chip
  ) : (
    <span data-markdown-copy={copyMarkdown}>
      {children} {chip}
    </span>
  );
}

export function MarkdownPrReferencePresentation({ node }: InlineNodeViewProps) {
  const markdownState = use(ChatMarkdownRendererContext);
  const inLink = use(MarkdownLinkContext);
  if (node.kind !== "plugin" || node.name !== "pr-reference") return null;
  if (inLink) return node.raw;
  const { href: nodeRepositoryUrl, kind, value } = node.attrs;
  const repositoryUrl = markdownState.pullRequestRepositoryUrl ?? nodeRepositoryUrl;
  if (!repositoryUrl || !value || (kind !== "issue" && kind !== "commit")) {
    return node.raw;
  }
  const base = repositoryUrl.replace(/\/+$/u, "");
  const isCommit = kind === "commit";
  const href = isCommit ? `${base}/commit/${value}` : `${base}/issues/${value}`;
  const label = isCommit ? value.slice(0, 7) : `#${value}`;
  return (
    <MarkdownAnchor
      href={href}
      markdownState={markdownState}
      pullRequestAutolink={isCommit ? "commit" : "reference"}
      pullRequestCopyOverride={isCommit ? value : `#${value}`}
      sourceRange={node.sourceRange}
    >
      {label}
    </MarkdownAnchor>
  );
}

export function MarkdownFileCitationPresentation({ node }: InlineNodeViewProps) {
  const markdownState = use(ChatMarkdownRendererContext);
  const inLink = use(MarkdownLinkContext);
  if (node.kind !== "plugin" || node.name !== "file-citation") return null;
  if (inLink) return node.raw;
  const citation = resolveCodexFileCitationLink(node.attrs);
  if (!citation) return node.raw;
  const href = normalizeMarkdownLinkHrefKey(citation.href);
  const fileLinkMeta =
    markdownState.markdownFileLinkMetaByHref.get(href) ??
    resolveMarkdownFileLinkMeta(
      href,
      markdownState.cwd,
      markdownState.imageBaseDir ?? markdownState.cwd,
    );
  if (fileLinkMeta) {
    return markdownState.fileLinkChip(fileLinkMeta, codexFileCitationMarkdown(citation), href);
  }
  return (
    <MarkdownAnchor
      href={citation.href}
      markdownState={markdownState}
      sourceRange={node.sourceRange}
    >
      {citation.label}
    </MarkdownAnchor>
  );
}
