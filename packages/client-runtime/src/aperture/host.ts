import type { ApertureFetchStreamEvent } from "@t3tools/contracts";
import {
  APERTURE_EMBED_PROTOCOL,
  isApertureEmbedFrameMessage,
  isApertureEmbedRecord,
  type ApertureEmbedErrorMessage,
  type ApertureEmbedFetchMessage,
  type ApertureEmbedHostMessage,
  type ApertureEmbedMode,
  type ApertureEmbedTheme,
  type ApertureFetchErrorCode,
} from "@t3tools/shared/apertureEmbed";

export type ApertureEmbedHostFetchRequest = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: string | null;
  readonly accept: string | null;
  /** The host's mode when the frame asked; the frame never asserts it. */
  readonly mode: "pinned" | "live";
};

export type ApertureEmbedHostFetchResult =
  | { readonly _tag: "end" }
  | { readonly _tag: "error"; readonly code: ApertureFetchErrorCode; readonly message: string };

export interface ApertureEmbedHostOptions {
  readonly post: (message: ApertureEmbedHostMessage, transfer?: Transferable[]) => void;
  readonly content: {
    readonly kind: "figure" | "widget";
    readonly spec?: unknown;
    readonly widget?: { readonly id: string; readonly version: string; readonly code: string };
    readonly entity: string;
    readonly project: string;
  };
  readonly size: { readonly width: number; readonly maxHeight: number };
  readonly theme: ApertureEmbedTheme;
  readonly mode: ApertureEmbedMode;
  readonly visible: boolean;
  /** Runs one bridged request. Emits events in order; resolves when the stream ends or fails. Must stop and resolve when `signal` aborts. */
  readonly fetch: (
    request: ApertureEmbedHostFetchRequest,
    onEvent: (event: ApertureFetchStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<ApertureEmbedHostFetchResult>;
  readonly onReady: (runtimeVersion: string) => void;
  /** `embed/ready` with a protocol this host does not speak: show the link-only fallback. */
  readonly onProtocolMismatch: (protocol: unknown) => void;
  readonly onSize: (height: number) => void;
  readonly onError: (error: {
    readonly code: ApertureEmbedErrorMessage["code"];
    readonly message: string;
    readonly detail?: string;
  }) => void;
  /** Number of bridged requests currently open, after every change (P5.5 evidence + live cap). */
  readonly onOpenRequestsChange?: (open: number) => void;
}

export interface ApertureEmbedHost {
  /** Caller already checked event.source === iframe.contentWindow (origin is "null"). */
  readonly receive: (data: unknown) => void;
  readonly setTheme: (theme: ApertureEmbedTheme) => void;
  readonly setMode: (mode: ApertureEmbedMode) => void;
  readonly setVisible: (visible: boolean) => void;
  readonly setWidth: (width: number) => void;
  readonly dispose: () => void;
}

interface InFlightRequest {
  readonly controller: AbortController;
  readonly mode: "pinned" | "live";
}

export function makeApertureEmbedHost(options: ApertureEmbedHostOptions): ApertureEmbedHost {
  let initialized = false;
  let initializing = false;
  let disposed = false;
  let protocolMismatch = false;
  let theme = options.theme;
  let mode = options.mode;
  let visible = options.visible;
  let width = options.size.width;
  const openRequests = new Map<string, InFlightRequest>();

  const post = (message: ApertureEmbedHostMessage, transfer?: Transferable[]) => {
    if (!disposed && !protocolMismatch) options.post(message, transfer);
  };

  const removeRequest = (id: string, request: InFlightRequest): boolean => {
    if (openRequests.get(id) !== request) return false;
    openRequests.delete(id);
    options.onOpenRequestsChange?.(openRequests.size);
    return true;
  };

  const postFetchError = (id: string, code: ApertureFetchErrorCode, message: string) =>
    post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/fetch-error", id, code, message });

  const receiveFetch = (message: ApertureEmbedFetchMessage) => {
    if (openRequests.has(message.id)) {
      postFetchError(message.id, "bad_response", "A request with this id is already open.");
      return;
    }

    const controller = new AbortController();
    const request: InFlightRequest = { controller, mode: mode.kind };
    openRequests.set(message.id, request);
    options.onOpenRequestsChange?.(openRequests.size);

    const onEvent = (event: ApertureFetchStreamEvent) => {
      if (disposed || protocolMismatch || openRequests.get(message.id) !== request) return;
      switch (event.type) {
        case "head":
          post({
            v: APERTURE_EMBED_PROTOCOL,
            type: "embed/fetch-head",
            id: message.id,
            status: event.status,
            statusText: event.statusText,
            headers: event.headers,
          });
          return;
        case "chunk": {
          const buffer = new ArrayBuffer(event.data.byteLength);
          new Uint8Array(buffer).set(event.data);
          post(
            {
              v: APERTURE_EMBED_PROTOCOL,
              type: "embed/fetch-chunk",
              id: message.id,
              bytes: buffer,
            },
            [buffer],
          );
          return;
        }
        case "end":
          post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/fetch-end", id: message.id });
          removeRequest(message.id, request);
          return;
      }
    };

    let result: Promise<ApertureEmbedHostFetchResult>;
    try {
      result = options.fetch(
        {
          method: message.method,
          path: message.path,
          body: message.body,
          accept: message.accept,
          mode: request.mode,
        },
        onEvent,
        controller.signal,
      );
    } catch (error) {
      if (removeRequest(message.id, request)) {
        postFetchError(
          message.id,
          "unreachable",
          error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
        );
      }
      return;
    }

    void result.then(
      (outcome) => {
        if (!removeRequest(message.id, request)) return;
        // A stream that completed without its own end event still ends the frame's response.
        if (outcome._tag === "end") {
          post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/fetch-end", id: message.id });
        } else postFetchError(message.id, outcome.code, outcome.message);
      },
      (error: unknown) => {
        if (!removeRequest(message.id, request)) return;
        postFetchError(
          message.id,
          "unreachable",
          error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
        );
      },
    );
  };

  const initialize = (runtimeVersion: string) => {
    initialized = true;
    initializing = true;
    options.onReady(runtimeVersion);
    const content = options.content;
    post({
      v: APERTURE_EMBED_PROTOCOL,
      type: "embed/init",
      kind: content.kind,
      ...(content.spec === undefined ? {} : { spec: content.spec }),
      ...(content.widget === undefined ? {} : { widget: content.widget }),
      entity: content.entity,
      project: content.project,
      theme,
      mode,
      size: { width, maxHeight: options.size.maxHeight },
    });
    if (!visible) post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/visibility", visible: false });
    initializing = false;
  };

  return {
    receive(data) {
      if (disposed || protocolMismatch) return;
      if (isApertureEmbedRecord(data) && data.type === "embed/ready" && !initialized) {
        if (data.v !== APERTURE_EMBED_PROTOCOL || data.protocol !== APERTURE_EMBED_PROTOCOL) {
          protocolMismatch = true;
          options.onProtocolMismatch(
            data.protocol !== APERTURE_EMBED_PROTOCOL ? data.protocol : data.v,
          );
          return;
        }
      }
      if (!isApertureEmbedFrameMessage(data)) return;
      if (data.type === "embed/ready") {
        if (!initialized) initialize(data.runtimeVersion);
        return;
      }
      if (!initialized || initializing) return;
      switch (data.type) {
        case "embed/fetch":
          receiveFetch(data);
          return;
        case "embed/fetch-abort": {
          const request = openRequests.get(data.id);
          if (request !== undefined && removeRequest(data.id, request)) request.controller.abort();
          return;
        }
        case "embed/size":
          if (Number.isFinite(data.height)) {
            options.onSize(Math.min(options.size.maxHeight, Math.max(80, Math.round(data.height))));
          }
          return;
        case "embed/error":
          options.onError({
            code: data.code,
            message: data.message,
            ...(data.detail === undefined ? {} : { detail: data.detail }),
          });
          return;
      }
    },
    setTheme(nextTheme) {
      if (disposed) return;
      theme = nextTheme;
      if (initialized && !initializing)
        post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/theme", theme });
    },
    setMode(nextMode) {
      if (disposed) return;
      mode = nextMode;
      if (initialized && !initializing)
        post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/mode", mode });
      if (mode.kind !== "pinned") return;
      for (const [id, request] of openRequests) {
        if (request.mode !== "live" || !removeRequest(id, request)) continue;
        request.controller.abort();
        postFetchError(id, "aborted", "Live requests stop when the embed is pinned.");
      }
    },
    setVisible(nextVisible) {
      if (disposed) return;
      const changed = visible !== nextVisible;
      visible = nextVisible;
      if (initialized && !initializing && changed) {
        post({ v: APERTURE_EMBED_PROTOCOL, type: "embed/visibility", visible });
      }
    },
    setWidth(nextWidth) {
      if (!disposed && !initialized) width = nextWidth;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const requests = [...openRequests.values()];
      openRequests.clear();
      options.onOpenRequestsChange?.(0);
      for (const request of requests) request.controller.abort();
    },
  };
}
