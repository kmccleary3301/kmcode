import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import { mediaFileReference, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { normalizeMarkdownLinkDestination } from "../../markdown-links";
import { TriangleAlertIcon } from "lucide-react";
import React, {
  createContext,
  use,
  useCallback,
  useState,
  memo,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { markdownImageGallery, markdownImageItems } from "../chat/markdownImageGallery";
import {
  type ExpandedImagePreview,
} from "../chat/ExpandedImagePreview";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";
import { resolveExternalWebLinkHost } from "../chat/externalLinkContextMenu";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import type { ChatMarkdownComponentState } from "./markdownContext";

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
export const MarkdownLinkContext = createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | undefined;
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {props.alt.length > 0 ? `${label} · ${props.alt}` : label}
    </span>
  );
}

/** Inline chip for an image that sits in a line of text or can never load. */
function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
  readonly actionsSource?: MediaActionSource | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} />
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * A standalone image holds a 16:9 slot (or its authored size) until it has
 * decoded, and keeps that slot if it fails, so a timeline row moves at most
 * once: when the natural size arrives. A bare `<img>` is zero height until
 * then. Once decoded the image renders bare again so its box, hit area, and
 * alignment are exactly the image's own. Inline images (badges, icons in a
 * sentence) skip the slot: a placeholder taller than the image would move the
 * page more than the image does.
 *
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
function ChatMarkdownImage(props: {
  /** Null while the URL is being resolved; the last decoded image stays up. */
  readonly src: string | null;
  readonly sourceFailed?: boolean | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** Sanitized authored attributes (`id`, `align`, …) that fragment links and layout rely on. */
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  // A failure forgets the decoded image so the next URL loads behind the slot.
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
      markdownImageItems.set(image, {
        src,
        name: props.alt.trim() || "image",
        actionsSource: props.actionsSource,
        ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
      });
    },
    [props.actionsSource, props.alt, props.originalUrl, src],
  );
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} />
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

/** Environment-hosted media loads through an exact-file signed asset URL. */
export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | "github-media"
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  /** Reserve a slot while loading; off for images that share a line with text. */
  readonly standalone?: boolean | undefined;
  /** Caps the box height in rem while keeping the image's ratio; 30 by default. */
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  /** Sanitized authored attributes (`id`, `align`, …) that fragment links and layout rely on. */
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  /** Where the media also lives on the web, for the failure state's escape hatch. */
  readonly originalUrl?: string | undefined;
  /** The workspace media frame, on by default; off for media that keeps the author's own box. */
  readonly framed?: boolean | undefined;
  /** Loaded instead of the failure state when no URL can be signed, such as against a server
      too old to know this resource. Only safe when the client can reach it directly. */
  readonly fallbackSrc?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, props.resource);
  const resource = props.resource;
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file" && props.workspaceRoot
        ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path}`
        : undefined;
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const fallbackSrc = assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  // The server reads the pixel size from the file header, so the slot can be
  // the image's final box instead of a 16:9 guess. An authored size wins; a
  // caller's height cap shrinks the box while keeping the ratio.
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? { asset: { environmentId: props.environmentId, resource } }
      : {}),
    ...(reference ? { reference } : {}),
    ...(relativePath && (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile(
                { environmentId: props.environmentId, threadId: resource.threadId },
                relativePath,
              ),
        }
      : {}),
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        actionsSource={actionsSource}
      />
    );
  }

  return (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
    />
  );
});
export function MarkdownImage({
  src,
  title,
  alt,
  width,
  height,
  className,
  id,
  align,
  isStandalone = false,
  markdownState,
}: {
  readonly src?: string;
  readonly title?: string;
  readonly alt?: string;
  readonly width?: string | number;
  readonly height?: string | number;
  readonly className?: string;
  readonly id?: string;
  readonly align?: string;
  readonly isStandalone?: boolean;
  readonly markdownState: ChatMarkdownComponentState;
}) {
  const {
    expandMedia,
    cwd,
    environmentId,
    githubMedia,
    imageBaseDir,
    threadRef,
    renderContextReference,
  } = markdownState;
  const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
  const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
  if (contextReference) {
    const label = alt || contextReference.contextId;
    return renderContextReference ? (
      renderContextReference({ ...contextReference, label })
    ) : (
      <span>{label}</span>
    );
  }
  const srcString = typeof src === "string" ? normalizeMarkdownLinkDestination(src) : "";
  const classifiedSrc = srcString;
  const standalone = isStandalone;
  const altText = alt ?? "";
  const copyMarkdown = markdownImageCopy(altText, srcString, title);
  const imageProps: Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style"> = {
    ...(id === undefined ? {} : { id }),
    ...(align === undefined ? {} : { align }),
  };
  const authoredSizeStyle = authoredImageSizeStyle(width, height);
  const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
  const kind = mediaKindFromPath(classifiedSrc) ?? "image";
  const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
  const githubMediaUrl =
    directUri === null ? null : githubMediaFetchUrl(resolveProtocolRelativeMediaUrl(directUri));
  if (
    githubMedia &&
    cwd !== undefined &&
    environmentId !== null &&
    directUri !== null &&
    githubMediaUrl !== null
  ) {
    return (
      <ChatMarkdownAssetImage
        environmentId={environmentId}
        resource={{ _tag: "github-media", cwd, url: githubMediaUrl }}
        alt={altText}
        kind={kind}
        copyMarkdown={copyMarkdown}
        standalone={standalone}
        className={className}
        style={authoredSizeStyle}
        imageProps={imageProps}
        srcFragment={markdownImageSourceFragment(classifiedSrc)}
        originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
        framed={false}
        fallbackSrc={githubMediaUrl}
        onImageExpand={imageExpand}
      />
    );
  }
  if (imageSource._tag === "Direct") {
    const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
    const originalUrl =
      resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
    const reference = mediaUrlReference(imageSource.uri);
    const actionsSource: MediaActionSource = {
      kind,
      name: altText || kind,
      src: mediaSrc,
      ...(reference ? { reference } : {}),
    };
    if (kind === "video") {
      return (
        <ChatMarkdownVideo
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          originalUrl={originalUrl}
          style={authoredSizeStyle}
          actionsSource={actionsSource}
        />
      );
    }
    return (
      <ChatMarkdownImage
        key={mediaSrc}
        src={mediaSrc}
        alt={altText}
        copyMarkdown={copyMarkdown}
        standalone={standalone}
        className={className}
        style={authoredSizeStyle}
        imageProps={imageProps}
        actionsSource={actionsSource}
        originalUrl={originalUrl}
        onImageExpand={imageExpand}
      />
    );
  }
  if (imageSource._tag === "WorkspaceFile" && threadRef) {
    return (
      <ChatMarkdownAssetImage
        environmentId={threadRef.environmentId}
        resource={{
          _tag: "media-file",
          threadId: threadRef.threadId,
          path: imageSource.path,
        }}
        alt={altText}
        kind={kind}
        copyMarkdown={copyMarkdown}
        srcFragment={markdownImageSourceFragment(classifiedSrc)}
        standalone={standalone}
        className={className}
        style={authoredSizeStyle}
        imageProps={imageProps}
        workspaceRoot={cwd}
        onImageExpand={imageExpand}
      />
    );
  }
  return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
}