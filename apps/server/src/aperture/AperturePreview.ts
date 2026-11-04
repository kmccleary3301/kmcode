import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ApertureConnectionError as ApertureConnectionErrorType } from "@t3tools/contracts";
import type { ApertureEmbedTokenPayload } from "@t3tools/shared/apertureEmbed";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ApertureConnection from "./ApertureConnection.ts";
import { authorizeApertureEmbedRequest } from "./ApertureEmbedPolicy.ts";
import * as ApertureRuntime from "./ApertureRuntime.ts";
import * as ApertureWidgetStore from "./ApertureWidgetStore.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { APERTURE_RUNTIME_CONTENT_SECURITY_POLICY } from "../http.ts";

const MAX_PREVIEW_WIDTH = 1_600;
const MIN_PREVIEW_WIDTH = 320;
const MAX_PREVIEW_RESPONSE_BYTES = 16 * 1024 * 1024;
const PREVIEW_RUNTIME_PATH = "/__aperture_runtime.html";
const PREVIEW_BRIDGE_PREFIX = "/__aperture_preview";
const CAPTURE_READY_EXPRESSION = "window.__aperturePreview.ready";
const CAPTURE_HEIGHT_EXPRESSION = "window.__aperturePreview.contentHeight";

export interface AperturePreviewInput {
  readonly kind: "figure" | "widget";
  readonly spec?: unknown;
  readonly widget?: { readonly id: string; readonly version: string };
  readonly entity: string;
  readonly project: string;
  readonly asOf: string;
  readonly width: number;
  readonly appearance: "light" | "dark";
}

export interface AperturePreviewResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<string>;
  readonly embedErrors: ReadonlyArray<{
    readonly code: string;
    readonly message: string;
    readonly detail?: string;
  }>;
  readonly failedRequests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly status: number | null;
    readonly code: string | null;
  }>;
  readonly runtimeVersion: string;
}

export type AperturePreviewErrorCode =
  | "browser_unavailable"
  | "runtime_unavailable"
  | "widget_unavailable"
  | "timeout"
  | "render_failed";

export class AperturePreviewError extends Schema.TaggedError<AperturePreviewError>()(
  "AperturePreviewError",
  {
    code: Schema.Literals([
      "browser_unavailable",
      "runtime_unavailable",
      "widget_unavailable",
      "timeout",
      "render_failed",
    ]),
    message: Schema.String,
  },
) {}

export class AperturePreview extends Context.Service<
  AperturePreview,
  {
    readonly preview: (
      input: AperturePreviewInput,
    ) => Effect.Effect<AperturePreviewResult, AperturePreviewError>;
  }
>()("t3/aperture/AperturePreview") {}

interface PreviewResponseBytesAccumulator {
  readonly chunks: Array<Uint8Array<ArrayBufferLike>>;
  readonly byteLength: number;
}

const PreviewHostStateSchema = Schema.Struct({
  embedErrors: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      detail: Schema.optional(Schema.String),
    }),
  ),
});

const previewError = (code: AperturePreviewErrorCode, message: string): AperturePreviewError =>
  new AperturePreviewError({ code, message });

const connectionError = (
  code: ApertureConnectionErrorType["code"],
  message: string,
): ApertureConnectionErrorType => ({ _tag: "ApertureConnectionError", code, message });

const jsonResponse = (
  status: number,
  statusText: string,
  body: { readonly code: string; readonly message: string },
): HeadlessChrome.HtmlRenderBrowserResponse => ({
  status,
  statusText,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

export function authorizeAperturePreviewRequest(input: {
  readonly entity: string;
  readonly project: string;
  readonly asOf: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: string | null;
}) {
  const token: ApertureEmbedTokenPayload = {
    refId: "preview",
    threadId: "preview",
    entity: input.entity,
    project: input.project,
    asOf: input.asOf,
  };
  return authorizeApertureEmbedRequest({
    request: {
      method: input.method,
      mode: "pinned",
      path: input.path,
      body: input.body,
    },
    token,
  });
}

const previewHostDocument = (input: {
  readonly kind: AperturePreviewInput["kind"];
  readonly spec?: unknown;
  readonly widget?: { readonly id: string; readonly version: string; readonly code: string };
  readonly entity: string;
  readonly project: string;
  readonly asOf: string;
  readonly width: number;
  readonly appearance: AperturePreviewInput["appearance"];
}) => {
  const serialized = JSON.stringify(input);
  if (serialized === undefined)
    throw new Error("Aperture preview initialization is not serializable.");
  const config = serialized.replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:0;background:${input.appearance === "dark" ? "#17191c" : "#ffffff"}}iframe{display:block;width:100%;height:200px;border:0}</style></head><body><iframe id="aperture-runtime" sandbox="allow-scripts" src="${PREVIEW_RUNTIME_PATH}"></iframe><script>(()=>{
const config=${config};
const frame=document.getElementById("aperture-runtime");
const state={contentHeight:null,embedErrors:[],pending:0,fetched:0};
const ready=Promise.withResolvers();
state.ready=ready.promise;
window.__aperturePreview=state;
const snapshot=()=>({embedErrors:state.embedErrors.slice()});
let quietTimer;
const maybeReady=()=>{
  if(state.embedErrors.length){clearTimeout(quietTimer);ready.resolve(snapshot());return}
  // A figure first sizes its loading state, then fetches its data; only a figure with data is settled.
  const settled=()=>state.contentHeight!==null&&state.pending===0&&(config.kind!=="figure"||state.fetched>0);
  if(!settled())return;
  clearTimeout(quietTimer);
  quietTimer=setTimeout(()=>{if(settled())ready.resolve(snapshot())},180);
};
const send=(message,transfer=[])=>frame.contentWindow&&frame.contentWindow.postMessage({v:1,...message},"*",transfer);
const controllers=new Map();
const failedFetch=(id,error)=>send({type:"embed/fetch-error",id,code:"unreachable",message:String(error&&error.message||error)});
const bridgeFetch=async message=>{
  state.pending+=1;
  const controller=new AbortController();
  controllers.set(message.id,controller);
  try{
    const headers={};
    if(typeof message.accept==="string")headers.Accept=message.accept;
    if(message.body!==null)headers["Content-Type"]="application/json";
    const response=await fetch(new URL("${PREVIEW_BRIDGE_PREFIX}"+message.path,location.href),{
      method:message.method,headers,body:message.body===null?undefined:message.body,signal:controller.signal
    });
    send({type:"embed/fetch-head",id:message.id,status:response.status,statusText:response.statusText,headers:Array.from(response.headers.entries())});
    if(response.body){
      const reader=response.body.getReader();
      while(true){
        const result=await reader.read();
        if(result.done)break;
        const bytes=result.value.buffer.slice(result.value.byteOffset,result.value.byteOffset+result.value.byteLength);
        send({type:"embed/fetch-chunk",id:message.id,bytes},[bytes]);
      }
    }
    send({type:"embed/fetch-end",id:message.id});
  }catch(error){if(!(error&&error.name==="AbortError"))failedFetch(message.id,error)}
  finally{controllers.delete(message.id);state.pending-=1;state.fetched+=1;maybeReady()}
};
window.addEventListener("message",event=>{
  if(event.source!==frame.contentWindow||!event.data||typeof event.data!=="object"||event.data.v!==1)return;
  const message=event.data;
  if(message.type==="embed/ready"){
    if(message.protocol!==1){state.embedErrors.push({code:"protocol",message:"Unsupported Aperture embed protocol."});maybeReady();return}
    const init={v:1,type:"embed/init",kind:config.kind,entity:config.entity,project:config.project,
      theme:{appearance:config.appearance,vizTheme:config.appearance==="dark"?"mint-terminal":"github-light",tokens:{}},
      mode:{kind:"pinned",asOf:config.asOf},size:{width:config.width,maxHeight:2000}};
    if(config.spec!==undefined)init.spec=config.spec;
    if(config.widget!==undefined)init.widget=config.widget;
    send(init);
    return;
  }
  if(message.type==="embed/fetch"&&typeof message.id==="string"&&typeof message.path==="string"&&
      (message.method==="GET"||message.method==="POST")&&(message.body===null||typeof message.body==="string")){
    void bridgeFetch(message);
    return;
  }
  if(message.type==="embed/fetch-abort"&&typeof message.id==="string"){
    controllers.get(message.id)?.abort();
    return;
  }
  if(message.type==="embed/size"&&typeof message.height==="number"&&Number.isFinite(message.height)){
    state.contentHeight=message.height;
    frame.style.height=Math.max(80,Math.min(2000,message.height))+"px";
    maybeReady();
    return;
  }
  if(message.type==="embed/error"){
    state.embedErrors.push({code:typeof message.code==="string"?message.code:"protocol",
      message:typeof message.message==="string"?message.message:"Aperture embed failed.",
      ...(typeof message.detail==="string"?{detail:message.detail}:{})});
    maybeReady();
  }
});
})()</script></body></html>`;
};

const make = Effect.gen(function* () {
  const connection = yield* ApertureConnection.ApertureConnection;
  const runtimeService = yield* ApertureRuntime.ApertureRuntime;
  const widgetStore = yield* ApertureWidgetStore.ApertureWidgetStore;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const browsers = yield* Semaphore.make(2);
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const noSandbox = PreviewBrowserHost.sandboxDisabled(yield* HostProcessEnvironment);

  const preview = Effect.fn("AperturePreview.preview")(function* (input: AperturePreviewInput) {
    const width = Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width)));
    const runtime = yield* runtimeService.getLatest.pipe(
      Effect.mapError(() =>
        previewError("runtime_unavailable", "The Aperture embed runtime could not be loaded."),
      ),
    );
    let widget:
      | { readonly id: string; readonly version: string; readonly code: string }
      | undefined;
    if (input.kind === "widget") {
      if (input.widget === undefined) {
        return yield* Effect.fail(
          previewError("widget_unavailable", "A widget id and version are required for preview."),
        );
      }
      const code = yield* widgetStore
        .module(input.widget)
        .pipe(
          Effect.mapError(() =>
            previewError("widget_unavailable", "The Aperture widget module could not be loaded."),
          ),
        );
      widget = { ...input.widget, code };
    }

    let html: string;
    try {
      html = previewHostDocument({
        kind: input.kind,
        ...(input.spec === undefined ? {} : { spec: input.spec }),
        ...(widget === undefined ? {} : { widget }),
        entity: input.entity,
        project: input.project,
        asOf: input.asOf,
        width,
        appearance: input.appearance,
      });
    } catch {
      return yield* Effect.fail(
        previewError("render_failed", "Aperture preview inputs could not be serialized."),
      );
    }

    const failedRequests: Array<{
      readonly method: string;
      readonly path: string;
      readonly status: number | null;
      readonly code: string | null;
    }> = [];
    const handleRequest: HeadlessChrome.HtmlRenderBrowserRequestHandler = (request) =>
      Effect.gen(function* () {
        let url: URL;
        try {
          url = new URL(request.url);
        } catch {
          return jsonResponse(400, "Bad Request", {
            code: "bad_response",
            message: "Aperture preview request URL is invalid.",
          });
        }
        if (url.pathname === PREVIEW_RUNTIME_PATH && request.method === "GET") {
          return {
            status: 200,
            statusText: "OK",
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": APERTURE_RUNTIME_CONTENT_SECURITY_POLICY,
              "X-Content-Type-Options": "nosniff",
            },
            body: runtime.bytes,
          };
        }
        if (!url.pathname.startsWith(`${PREVIEW_BRIDGE_PREFIX}/`)) {
          return jsonResponse(404, "Not Found", {
            code: "not_found",
            message: "Aperture preview resource was not found.",
          });
        }
        const path = `${url.pathname.slice(PREVIEW_BRIDGE_PREFIX.length)}${url.search}`;
        if (request.method === "OPTIONS") {
          return {
            status: 204,
            statusText: "No Content",
            headers: {},
            body: new Uint8Array(),
          };
        }
        if (request.method !== "GET" && request.method !== "POST") {
          failedRequests.push({
            method: request.method,
            path,
            status: null,
            code: "policy_denied",
          });
          return jsonResponse(403, "Forbidden", {
            code: "policy_denied",
            message: "Aperture preview requests are read-only.",
          });
        }
        const body = request.postData ?? null;
        const accept =
          Object.entries(request.headers).find(([name]) => name.toLowerCase() === "accept")?.[1] ??
          null;
        const policy = authorizeAperturePreviewRequest({
          entity: input.entity,
          project: input.project,
          asOf: input.asOf,
          method: request.method,
          path,
          body,
        });
        if (!policy.allowed) {
          failedRequests.push({ method: request.method, path, status: null, code: policy.code });
          return jsonResponse(403, "Forbidden", { code: policy.code, message: policy.message });
        }

        const upstream = yield* Effect.result(
          Effect.scoped(
            connection
              .request({
                method: request.method,
                path: policy.path,
                body: policy.body,
                accept,
              })
              .pipe(
                Effect.flatMap((response) =>
                  Effect.gen(function* () {
                    const contentLength = response.headers["content-length"];
                    if (contentLength !== undefined) {
                      const declaredBytes = Number(contentLength);
                      if (
                        !Number.isFinite(declaredBytes) ||
                        declaredBytes < 0 ||
                        declaredBytes > MAX_PREVIEW_RESPONSE_BYTES
                      ) {
                        return yield* Effect.fail(
                          connectionError(
                            "bad_response",
                            "Aperture preview response exceeds the size limit.",
                          ),
                        );
                      }
                    }
                    const accumulated = yield* response.stream.pipe(
                      Stream.mapError(() =>
                        connectionError("unreachable", "Aperture preview response stream failed."),
                      ),
                      Stream.runFoldEffect<
                        PreviewResponseBytesAccumulator,
                        Uint8Array<ArrayBufferLike>,
                        ApertureConnectionErrorType,
                        never
                      >(
                        () => ({ chunks: [], byteLength: 0 }),
                        (state, chunk) => {
                          const byteLength = state.byteLength + chunk.byteLength;
                          if (byteLength > MAX_PREVIEW_RESPONSE_BYTES) {
                            return Effect.fail(
                              connectionError(
                                "bad_response",
                                "Aperture preview response exceeds the size limit.",
                              ),
                            );
                          }
                          state.chunks.push(chunk);
                          return Effect.succeed({ chunks: state.chunks, byteLength });
                        },
                      ),
                    );
                    const bytes = new Uint8Array(accumulated.byteLength);
                    let offset = 0;
                    for (const chunk of accumulated.chunks) {
                      bytes.set(chunk, offset);
                      offset += chunk.byteLength;
                    }
                    return { response, bytes };
                  }),
                ),
              ),
          ),
        );
        if (upstream._tag === "Failure") {
          const error = upstream.failure;
          failedRequests.push({ method: request.method, path, status: null, code: error.code });
          const status =
            error.code === "unauthorized" ? 401 : error.code === "forbidden" ? 403 : 502;
          return jsonResponse(status, "Aperture Error", {
            code: error.code,
            message: error.message,
          });
        }
        const { response, bytes } = upstream.success;
        if (response.status < 200 || response.status >= 300) {
          failedRequests.push({
            method: request.method,
            path,
            status: response.status,
            code: null,
          });
        }
        return {
          status: response.status,
          statusText: `HTTP ${response.status}`,
          headers: {
            ...(response.headers["content-type"] === undefined
              ? {}
              : { "Content-Type": response.headers["content-type"] }),
            ...(response.headers["cache-control"] === undefined
              ? {}
              : { "Cache-Control": response.headers["cache-control"] }),
          },
          body: bytes,
        };
      });

    const executable = yield* previewBrowser.executable.pipe(
      Effect.mapError(() =>
        previewError("browser_unavailable", "The headless preview browser is unavailable."),
      ),
    );
    const capture = yield* browsers.withPermits(1)(
      HeadlessChrome.captureHtmlScreenshotWithRequests({
        executable,
        noSandbox,
        html,
        width,
        waitExpression: CAPTURE_READY_EXPRESSION,
        contentHeightExpression: CAPTURE_HEIGHT_EXPRESSION,
        requestHandler: handleRequest,
      }).pipe(
        Effect.provideContext(services),
        Effect.mapError((error) =>
          previewError(
            error.reason.includes("within 20 seconds") ? "timeout" : "render_failed",
            error.message,
          ),
        ),
      ),
    );
    const hostState = Schema.decodeUnknownOption(PreviewHostStateSchema)(capture.pageState);
    if (Option.isNone(hostState)) {
      return yield* Effect.fail(
        previewError("render_failed", "The Aperture preview host returned invalid state."),
      );
    }
    return {
      png: capture.png,
      width,
      // Measured when the screenshot was taken, so it matches the PNG rather than the readiness snapshot.
      contentHeight: capture.contentHeight,
      capturedHeight: capture.capturedHeight,
      consoleMessages: capture.consoleMessages.map((message) => message.text),
      embedErrors: hostState.value.embedErrors.map(({ code, message, detail }) => ({
        code,
        message,
        ...(detail === undefined ? {} : { detail }),
      })),
      failedRequests,
      runtimeVersion: runtime.version,
    } satisfies AperturePreviewResult;
  });

  return AperturePreview.of({ preview });
});

export const layer = Layer.effect(AperturePreview, make);
