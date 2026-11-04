import {
  makeApertureEmbedHost,
  type ApertureEmbedHost,
  type ApertureEmbedHostFetchResult,
  type ApertureEmbedHostOptions,
} from "@t3tools/client-runtime/aperture/host";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ApertureFetchError, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type {
  ApertureEmbedMode,
  ApertureEmbedReference,
  ApertureEmbedTheme,
} from "@t3tools/shared/apertureEmbed";
import * as Schema from "effect/Schema";
import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useFrameAssetSrc } from "~/assets/assetUrls";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";
import { apertureEnvironment } from "~/state/aperture";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { acquireApertureRequestSlot, registerApertureLiveFrame } from "./apertureEmbedSlots";

const isApertureFetchError = Schema.is(ApertureFetchError);

/** The tallest frame a reply may hold; the reference's height is clamped to the same range. */
const MAX_FRAME_HEIGHT = 2000;
/** A runtime that has not announced itself by then failed to load: a frame cannot report that. */
const READY_TIMEOUT_MS = 20_000;

/** What the chrome reports instead of, or above, the figure. */
type EmbedIssue =
  | { readonly kind: "offline" | "unauthorized" | "unavailable"; readonly message: string }
  | {
      readonly kind: "embed";
      readonly message: string;
      readonly detail?: string;
    };

const pinnedTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The reply-time label; an unparseable stamp shows as sent rather than as "Invalid Date". */
export function apertureAsOfLabel(asOf: string): string {
  const time = Date.parse(asOf);
  return Number.isNaN(time) ? asOf : pinnedTimeFormat.format(time);
}

/** Aperture's own figure theme for the app's appearance, on the transcript's background and fonts. */
function useApertureEmbedTheme(): ApertureEmbedTheme {
  const theme = useHtmlRenderTheme();
  return useMemo(() => {
    const tokens: Record<string, string> = {};
    for (const [token, variable] of [
      ["--plot-page", "--background"],
      ["--plot-font-ui", "--font-sans"],
      ["--plot-font-mono", "--font-mono"],
    ] as const) {
      const value = theme.variables[variable];
      if (value !== undefined) tokens[token] = value;
    }
    return {
      appearance: theme.appearance,
      vizTheme: theme.appearance === "dark" ? "mint-terminal" : "github-light",
      tokens,
    };
  }, [theme]);
}

/** Issues a failed bridged request shows in the chrome; the rest the figure reports itself. */
function fetchIssue(error: { readonly code: string; readonly message: string }): EmbedIssue | null {
  switch (error.code) {
    case "unreachable":
      return { kind: "offline", message: "Aperture is unreachable from KM Code." };
    case "unauthorized":
    case "forbidden":
      return { kind: "unauthorized", message: "Aperture refused KM Code's API key." };
    case "invalid_ref":
      return { kind: "unauthorized", message: "This embed's signature is no longer valid." };
    default:
      return null;
  }
}

/**
 * An Aperture figure or widget inline in the thread. Aperture's embed runtime
 * runs in a sandboxed, opaque-origin frame; every request it makes is bridged
 * through KM Code's server, which holds the key and keeps a pinned embed at
 * its reply time. Pinned is the default; Live follows the run as it trains.
 */
export function ApertureEmbedFrame(props: {
  readonly environmentId: EnvironmentId;
  /** The thread the reference's token is bound to. */
  readonly threadId: ThreadId;
  readonly reference: ApertureEmbedReference;
}) {
  const { environmentId, threadId, reference } = props;
  const threadKey = `${environmentId}:${threadId}`;
  const [mode, setMode] = useState<ApertureEmbedMode>(() =>
    reference.mode === "live" ? { kind: "live" } : { kind: "pinned", asOf: reference.asOf },
  );
  const [issue, setIssue] = useState<EmbedIssue | null>(null);
  const [linkOnly, setLinkOnly] = useState(false);
  const [ready, setReady] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>();
  const height = Math.min(MAX_FRAME_HEIGHT, Math.max(80, contentHeight ?? reference.height));

  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const resize = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    const intersection = new IntersectionObserver(([entry]) => {
      if (entry) setVisible(entry.isIntersecting);
    });
    resize.observe(box);
    intersection.observe(box);
    return () => {
      resize.disconnect();
      intersection.disconnect();
    };
  }, [linkOnly]);

  // The thread's live cap may pause this frame while newer live figures stream.
  const frameId = useId();
  const [streaming, setStreaming] = useState(false);
  const live = mode.kind === "live";
  const liveFrame = useRef<ReturnType<typeof registerApertureLiveFrame> | null>(null);
  const liveState = useRef({ live, visible });
  useEffect(() => {
    const handle = registerApertureLiveFrame(threadKey, frameId, setStreaming);
    liveFrame.current = handle;
    handle.update(liveState.current);
    return () => {
      handle.dispose();
      liveFrame.current = null;
    };
  }, [frameId, threadKey]);
  useEffect(() => {
    liveState.current = { live, visible };
    liveFrame.current?.update({ live, visible });
  }, [live, visible]);
  const paused = live && visible && !streaming;

  const runtime = useFrameAssetSrc(
    environmentId,
    useMemo(
      () => ({ _tag: "aperture-runtime" as const, version: reference.runtime.version }),
      [reference.runtime.version],
    ),
  );
  const [reload, setReload] = useState<{ readonly key: number; readonly src: string | null }>({
    key: 0,
    src: null,
  });
  const src = reload.src ?? runtime.src;

  // A widget's module is served as inert text and handed to the runtime at init.
  const widgetResource = useMemo(
    () =>
      reference.widget === undefined
        ? null
        : {
            _tag: "aperture-widget" as const,
            id: reference.widget.id,
            version: reference.widget.version,
          },
    [reference.widget],
  );
  const mintWidgetUrl = useAssetUrlRefresh(environmentId, widgetResource);
  const [widgetCode, setWidgetCode] = useState<string | null>(null);
  useEffect(() => {
    if (widgetResource === null) return;
    let cancelled = false;
    void (async () => {
      const url = await mintWidgetUrl();
      if (url === null) throw new Error("No connection to the environment.");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`The widget's code returned ${response.status}.`);
      return response.text();
    })().then(
      (code) => {
        if (!cancelled) setWidgetCode(code);
      },
      () => {
        if (!cancelled)
          setIssue({ kind: "unavailable", message: "The widget's code could not be loaded." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mintWidgetUrl, reload.key, widgetResource]);

  const content = useMemo<ApertureEmbedHostOptions["content"] | null>(() => {
    const base = { kind: reference.kind, entity: reference.entity, project: reference.project };
    if (reference.kind === "figure") {
      return reference.spec === undefined ? base : { ...base, spec: reference.spec };
    }
    if (reference.widget === undefined || widgetCode === null) return null;
    return { ...base, widget: { ...reference.widget, code: widgetCode } };
  }, [reference, widgetCode]);

  const runFetch = useAtomCommand(apertureEnvironment.fetch, { reportFailure: false });
  const bridge: ApertureEmbedHostOptions["fetch"] = async (request, onEvent, signal) => {
    const release = await acquireApertureRequestSlot(threadKey, signal);
    if (release === null) {
      return { _tag: "error", code: "aborted", message: "The embed cancelled the request." };
    }
    try {
      const result = await runFetch({
        environmentId,
        input: {
          request: {
            threadId,
            embedToken: reference.embedToken,
            mode: request.mode,
            method: request.method,
            path: request.path,
            body: request.body,
            accept: request.accept,
          },
          onEvent: (event) => {
            // A response from Aperture means the bridge works again.
            if (event.type === "head") {
              setIssue((current) =>
                current?.kind === "offline" || current?.kind === "unauthorized" ? null : current,
              );
            }
            onEvent(event);
          },
          signal,
        },
      });
      if (result._tag === "Success") return { _tag: "end" };
      if (isAtomCommandInterrupted(result)) {
        return { _tag: "error", code: "aborted", message: "The embed cancelled the request." };
      }
      const failure = squashAtomCommandFailure(result);
      const error: Extract<ApertureEmbedHostFetchResult, { readonly _tag: "error" }> =
        isApertureFetchError(failure)
          ? { _tag: "error", code: failure.code, message: failure.message }
          : { _tag: "error", code: "unreachable", message: "KM Code could not reach its server." };
      const next = fetchIssue(error);
      if (next !== null) setIssue(next);
      return error;
    } finally {
      release();
    }
  };

  const theme = useApertureEmbedTheme();
  const refresh = async () => {
    setIssue(null);
    setReady(false);
    // A signed URL expires; a reload past its life needs a fresh one.
    const url = await runtime.refresh().catch(() => null);
    setReload((current) => ({ key: current.key + 1, src: url ?? current.src }));
  };
  const runtimeFailed = runtime.failed && src === null;
  const shownIssue: EmbedIssue | null =
    issue ??
    (runtimeFailed
      ? { kind: "unavailable", message: "The Aperture runtime could not be loaded." }
      : null);

  const header = (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <span className="min-w-0 truncate font-medium text-foreground/85">{reference.title}</span>
      {linkOnly ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost-muted"
                aria-pressed={live}
                onClick={() => {
                  // Claim the live slot in this event, so the frame never renders live while marked hidden.
                  liveFrame.current?.update({ live: !live, visible });
                  setMode(live ? { kind: "pinned", asOf: reference.asOf } : { kind: "live" });
                }}
              />
            }
          >
            {live ? (
              <span className="flex items-center gap-1">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    paused ? "bg-muted-foreground/60" : "bg-success",
                  )}
                />
                {paused ? "Live · paused" : "Live"}
              </span>
            ) : (
              `Pinned · ${apertureAsOfLabel(reference.asOf)}`
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {live
              ? paused
                ? "Paused while newer live figures stream. Click to pin to the reply's time."
                : "Click to pin to the reply's time."
              : "Shows Aperture as of the reply. Click to follow it live."}
          </TooltipPopup>
        </Tooltip>
      )}
      <span className="flex-1" />
      {linkOnly ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Reload figure"
                onClick={() => void refresh()}
              />
            }
          >
            <RotateCwIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Reload</TooltipPopup>
        </Tooltip>
      )}
      {reference.webUrl === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={reference.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in Aperture"
                className="inline-flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
              />
            }
          >
            <ExternalLinkIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open in Aperture</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );

  if (linkOnly) {
    return (
      <div className="flex flex-col gap-1">
        {header}
        <p className="text-muted-foreground text-xs">
          This {reference.kind} needs a newer KM Code to show here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {header}
      {shownIssue === null ? null : (
        <div
          role="alert"
          className={cn(
            "rounded-md border px-2 py-1 text-xs",
            shownIssue.kind === "embed" || shownIssue.kind === "unauthorized"
              ? "border-destructive/30 text-destructive-foreground"
              : "border-border text-muted-foreground",
          )}
        >
          <span>{shownIssue.message}</span>
          {shownIssue.kind === "embed" && shownIssue.detail !== undefined ? (
            <details className="mt-1">
              <summary className="cursor-pointer select-none">Details</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                {shownIssue.detail}
              </pre>
            </details>
          ) : null}
        </div>
      )}
      <div ref={boxRef} className="relative" style={{ height }}>
        {ready ? null : (
          <p className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
            {shownIssue === null ? `Loading ${reference.title}…` : null}
          </p>
        )}
        {src !== null && content !== null && width > 0 ? (
          <ApertureEmbedDocument
            // A reload starts a fresh runtime and host; nothing carries over.
            key={reload.key}
            src={src}
            title={reference.title}
            content={content}
            width={width}
            theme={theme}
            mode={mode}
            visible={visible && (!live || streaming)}
            ready={ready}
            fetch={bridge}
            onReady={() => setReady(true)}
            onStartFailed={() =>
              setIssue({ kind: "unavailable", message: "The Aperture runtime did not start." })
            }
            onProtocolMismatch={() => setLinkOnly(true)}
            onSize={setContentHeight}
            onError={(error) =>
              setIssue({
                kind: "embed",
                message: error.message,
                ...(error.detail === undefined ? {} : { detail: error.detail }),
              })
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The runtime frame and its host. The host speaks the embed protocol; this
 * component only checks that a message really came from its own frame (the
 * opaque origin posts as "null") and passes the app's state in.
 */
function ApertureEmbedDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly content: ApertureEmbedHostOptions["content"];
  readonly width: number;
  readonly theme: ApertureEmbedTheme;
  readonly mode: ApertureEmbedMode;
  readonly visible: boolean;
  readonly ready: boolean;
  readonly fetch: ApertureEmbedHostOptions["fetch"];
  readonly onReady: () => void;
  readonly onStartFailed: () => void;
  readonly onProtocolMismatch: () => void;
  readonly onSize: (height: number) => void;
  readonly onError: ApertureEmbedHostOptions["onError"];
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Read by the host on every call, so it always sees current callbacks without being rebuilt.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const hostRef = useRef<ApertureEmbedHost | null>(null);
  // Created with the frame's listener and disposed with it, so a remount never
  // keeps a disposed host. Listen from the commit that inserts the frame: the
  // runtime announces itself as soon as it loads.
  useLayoutEffect(() => {
    const initial = latest.current;
    const host = makeApertureEmbedHost({
      post: (message, transfer) =>
        frameRef.current?.contentWindow?.postMessage(message, "*", transfer),
      content: initial.content,
      size: { width: Math.round(initial.width), maxHeight: MAX_FRAME_HEIGHT },
      theme: initial.theme,
      mode: initial.mode,
      visible: initial.visible,
      fetch: (request, onEvent, signal) => latest.current.fetch(request, onEvent, signal),
      onReady: () => latest.current.onReady(),
      onProtocolMismatch: () => latest.current.onProtocolMismatch(),
      onSize: (height) => latest.current.onSize(height),
      onError: (error) => latest.current.onError(error),
      onOpenLink: (href) => {
        const frame = frameRef.current;
        // As for HTML renders: only while the frame has focus and the reader just used it.
        if (
          frame === null ||
          document.activeElement !== frame ||
          navigator.userActivation?.isActive === false
        ) {
          return;
        }
        const url = URL.canParse(href) ? new URL(href) : null;
        if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return;
        window.open(url.href, "_blank", "noopener,noreferrer");
      },
    });
    hostRef.current = host;
    const receive = (event: MessageEvent) => {
      if (event.origin !== "null" || event.source !== frameRef.current?.contentWindow) return;
      host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      host.dispose();
      hostRef.current = null;
    };
  }, []);
  useEffect(() => hostRef.current?.setTheme(props.theme), [props.theme]);
  useEffect(() => hostRef.current?.setMode(props.mode), [props.mode]);
  useEffect(() => hostRef.current?.setVisible(props.visible), [props.visible]);
  const { ready } = props;
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => latest.current.onStartFailed(), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  const [loaded, setLoaded] = useState(false);
  return (
    <iframe
      ref={frameRef}
      src={props.src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps agent code out of the app's session.
      sandbox="allow-scripts allow-forms"
      onLoad={() => setLoaded(true)}
      className={cn(
        "absolute inset-0 block size-full border-0 scheme-light transition-opacity duration-150",
        ready ? "opacity-100" : "opacity-0",
      )}
      style={loaded ? { colorScheme: props.theme.appearance } : undefined}
    />
  );
}
