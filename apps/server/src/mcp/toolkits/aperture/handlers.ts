import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  ApertureEmbedReferenceSchema,
  type ApertureEmbedTokenPayload,
} from "@t3tools/shared/apertureEmbed";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ApertureConnection from "../../../aperture/ApertureConnection.ts";
import * as ApertureEmbedPolicy from "../../../aperture/ApertureEmbedPolicy.ts";
import * as ApertureEmbedToken from "../../../aperture/ApertureEmbedToken.ts";
import * as AperturePreview from "../../../aperture/AperturePreview.ts";
import * as ApertureRuntime from "../../../aperture/ApertureRuntime.ts";
import * as ApertureWidgetStore from "../../../aperture/ApertureWidgetStore.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  ApertureFigurePreviewToolkit,
  ApertureStandardToolkit,
  ApertureToolkit,
  ApertureWidgetPreviewToolkit,
} from "./tools.ts";

type FailureCode = "capability_denied" | "invalid_request" | "orchestration_error";

interface ScopeOptions {
  readonly entity?: string | undefined;
  readonly project?: string | undefined;
  readonly asOf?: string | undefined;
}

interface PreviewOptions extends ScopeOptions {
  readonly width?: number | undefined;
  readonly appearance?: "light" | "dark" | undefined;
}

interface RenderOptions extends ScopeOptions {
  readonly kind: "figure" | "widget";
  readonly spec?: unknown;
  readonly widget?: { readonly id: string; readonly version: string };
  readonly title: string;
  readonly height: number;
  readonly mode?: "pinned" | "live" | undefined;
}

/** Width the render tools measure at: the transcript column on a typical desktop window. */
const RENDER_MEASURE_WIDTH = 728;
const RENDER_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe it; reply with only what it doesn't already say.";

const failure = (message: string, code: FailureCode = "orchestration_error") =>
  new OrchestratorMcpFailure({ code, message });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const RunsResponseSchema = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      state: Schema.String,
      created_at: Schema.Finite,
      summary: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  next_cursor: Schema.NullOr(Schema.String),
});

const KeysResponseSchema = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ key: Schema.String, kind: Schema.String })),
});

const HistorySeriesSchema = Schema.Struct({
  run: Schema.String,
  key: Schema.String,
  step: Schema.Array(Schema.Unknown),
  y: Schema.Array(Schema.Unknown),
  y_min: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  y_max: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  x_last: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  y_last: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  count: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const HistoryResponseSchema = Schema.Struct({ series: Schema.Array(HistorySeriesSchema) });

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((nowMillis) => DateTime.formatIso(DateTime.makeUnsafe(nowMillis))),
);

const readSettings = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  return yield* settingsService.getSettings.pipe(
    Effect.mapError(() => failure("Aperture settings could not be read.")),
  );
});

const readEnabledApertureSettings = Effect.gen(function* () {
  const settings = yield* readSettings;
  if (!settings.aperture.enabled) {
    return yield* failure("Aperture tools are disabled in server settings.", "capability_denied");
  }
  return settings.aperture;
});

const callerThreadId = (toolName: string) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const { thread } = yield* McpInvocationContext.requireThreadScope(invocation, toolName);
    return thread.threadId;
  });

/** A caller-supplied asOf must be a real instant no later than now; absent means now. */
const resolveAsOf = (value: string | undefined) =>
  Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    if (value === undefined) return DateTime.formatIso(DateTime.makeUnsafe(nowMillis));
    const decoded = Schema.decodeOption(Schema.DateTimeUtcFromString)(value);
    if (Option.isNone(decoded)) {
      return yield* failure("asOf must be an ISO timestamp.", "invalid_request");
    }
    if (DateTime.toEpochMillis(decoded.value) > nowMillis) {
      return yield* failure("asOf cannot be later than the server time.", "invalid_request");
    }
    return DateTime.formatIso(decoded.value);
  });

const resolveScope = (
  settings: { readonly defaultEntity: string; readonly defaultProject: string },
  options: ScopeOptions,
) => {
  const entity = options.entity ?? settings.defaultEntity;
  const project = options.project ?? settings.defaultProject;
  return entity.trim().length === 0 || project.trim().length === 0
    ? Effect.fail(
        failure(
          "Set Aperture's default entity and project, or supply both to this tool.",
          "invalid_request",
        ),
      )
    : Effect.succeed({ entity, project });
};

/**
 * Runs one JSON request through the same read-only allowlist and pinned clamp the
 * transcript embeds use, so tool numbers and a pinned render at `token.asOf` agree.
 */
const requestJson = <A, I>(
  token: ApertureEmbedTokenPayload,
  query: unknown,
  schema: Schema.Codec<A, I>,
) =>
  Effect.gen(function* () {
    const connection = yield* ApertureConnection.ApertureConnection;
    const decision = ApertureEmbedPolicy.authorizeApertureEmbedRequest({
      request: { method: "POST", mode: "pinned", path: "/api/v1/query", body: encodeJson(query) },
      token,
    });
    if (!decision.allowed) return yield* failure(decision.message, "invalid_request");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* connection
          .request({
            method: "POST",
            path: decision.path,
            body: decision.body,
            accept: "application/json",
          })
          .pipe(Effect.mapError((error) => failure(error.message)));
        if (response.status < 200 || response.status >= 300) {
          return yield* failure(`Aperture returned HTTP ${response.status}.`);
        }
        const json = yield* response.json.pipe(
          Effect.mapError(() => failure("Aperture returned invalid JSON.")),
        );
        return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(() => failure("Aperture returned an unexpected response.")),
        );
      }),
    );
  });

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const summaryFieldValue = (summary: unknown, field: string): unknown => {
  let value = summary;
  for (const part of field.split(".")) {
    if (!Predicate.isObject(value)) return undefined;
    value = value[part];
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 256);
  return finiteNumber(value) ?? undefined;
};

const historySummary = (
  runId: string,
  key: string,
  series: typeof HistorySeriesSchema.Type | undefined,
) => {
  if (series === undefined) {
    return { runId, key, min: null, max: null, last: null, count: 0, lastStep: null };
  }
  let min: number | null = null;
  for (const value of series.y_min ?? series.y) {
    const numeric = finiteNumber(value);
    if (numeric !== null && (min === null || numeric < min)) min = numeric;
  }
  let max: number | null = null;
  for (const value of series.y_max ?? series.y) {
    const numeric = finiteNumber(value);
    if (numeric !== null && (max === null || numeric > max)) max = numeric;
  }
  let count = series.count === undefined ? series.step.length : 0;
  for (const value of series.count ?? []) count += finiteNumber(value) ?? 0;
  const lastOf = (values: ReadonlyArray<unknown>) =>
    values.length === 0 ? null : finiteNumber(values[values.length - 1]);
  return {
    runId,
    key,
    min,
    max,
    last: lastOf(series.y_last ?? series.y),
    count,
    lastStep: lastOf(series.x_last ?? series.step),
  };
};

const previewFailure = (error: AperturePreview.AperturePreviewError) =>
  failure(
    error.message,
    error.code === "widget_unavailable" || error.code === "render_failed"
      ? "invalid_request"
      : "orchestration_error",
  );

const widgetFailure = (error: ApertureWidgetStore.ApertureWidgetError) =>
  failure(
    error.message,
    error.code === "invalid" || error.code === "not_found"
      ? "invalid_request"
      : "orchestration_error",
  );

const preview = (
  toolName: string,
  target: Pick<AperturePreview.AperturePreviewInput, "kind" | "spec" | "widget">,
  options: PreviewOptions,
) =>
  Effect.gen(function* () {
    const apertureSettings = yield* readEnabledApertureSettings;
    yield* callerThreadId(toolName);
    const scope = yield* resolveScope(apertureSettings, options);
    const asOf = yield* resolveAsOf(options.asOf);
    const previewService = yield* AperturePreview.AperturePreview;
    const result = yield* previewService
      .preview({
        ...target,
        ...scope,
        asOf,
        width: Math.min(1600, Math.max(320, options.width ?? RENDER_MEASURE_WIDTH)),
        appearance: options.appearance ?? "dark",
      })
      .pipe(Effect.mapError(previewFailure));
    return {
      asOf,
      width: result.width,
      contentHeight: result.contentHeight,
      capturedHeight: result.capturedHeight,
      runtimeVersion: result.runtimeVersion,
      consoleMessages: result.consoleMessages,
      embedErrors: result.embedErrors,
      failedRequests: result.failedRequests,
      screenshot: {
        mimeType: "image/png" as const,
        data: Buffer.from(result.png).toString("base64"),
        width: result.width,
        height: result.capturedHeight,
      },
    };
  });

const render = (toolName: string, options: RenderOptions) =>
  Effect.gen(function* () {
    const apertureSettings = yield* readEnabledApertureSettings;
    const threadId = yield* callerThreadId(toolName);
    const scope = yield* resolveScope(apertureSettings, options);
    const asOf = yield* resolveAsOf(options.asOf);
    const target = {
      kind: options.kind,
      ...(options.spec === undefined ? {} : { spec: options.spec }),
      ...(options.widget === undefined ? {} : { widget: options.widget }),
    };
    if (options.widget !== undefined) {
      const widgetStore = yield* ApertureWidgetStore.ApertureWidgetStore;
      yield* widgetStore.module(options.widget).pipe(Effect.mapError(widgetFailure));
    }
    const runtime = yield* ApertureRuntime.ApertureRuntime;
    const runtimeDocument = yield* runtime.getLatest.pipe(
      Effect.mapError((error) => failure(error.message)),
    );

    // Measure like html_render; without a preview browser the caller's height stands.
    const previewService = yield* AperturePreview.AperturePreview;
    const measured = yield* Effect.result(
      previewService.preview({
        ...target,
        ...scope,
        asOf,
        width: RENDER_MEASURE_WIDTH,
        appearance: "dark",
      }),
    );
    if (Result.isSuccess(measured) && measured.success.embedErrors.length > 0) {
      const [first] = measured.success.embedErrors;
      return yield* failure(
        `The Aperture runtime rejected this ${options.kind}: ${first?.code}: ${first?.message}. Fix it and preview again before rendering.`,
        "invalid_request",
      );
    }
    const height = Result.isSuccess(measured)
      ? Math.min(2000, Math.max(80, Math.ceil(measured.success.contentHeight)))
      : options.height;

    const crypto = yield* Crypto.Crypto;
    const refId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => failure("Aperture reference ID could not be generated.")),
    );
    const tokens = yield* ApertureEmbedToken.ApertureEmbedToken;
    const embedToken = yield* tokens
      .issue({ refId, threadId, ...scope, asOf })
      .pipe(Effect.mapError(() => failure("Aperture embed token could not be issued.")));
    const apertureEmbed = yield* Schema.decodeUnknownEffect(ApertureEmbedReferenceSchema)({
      refId,
      ...target,
      ...scope,
      title: options.title.trim(),
      height,
      mode: options.mode ?? "pinned",
      asOf,
      runtime: { version: runtimeDocument.version },
      ...(apertureSettings.webUrl.trim().length === 0 ? {} : { webUrl: apertureSettings.webUrl }),
      embedToken,
    }).pipe(Effect.mapError(() => failure("The rendered Aperture reference was invalid.")));
    return { apertureEmbed, message: RENDER_MESSAGE };
  });

const handlers = {
  aperture_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { aperture } = yield* readSettings;
      const asOf = yield* nowIso;
      const defaults = {
        defaultEntity: aperture.defaultEntity,
        defaultProject: aperture.defaultProject,
      };
      if (!aperture.enabled) {
        return {
          enabled: false,
          asOf,
          connection: { status: "disabled" as const, message: "Aperture is disabled." },
          projects: [],
          ...defaults,
        };
      }
      const connection = yield* ApertureConnection.ApertureConnection;
      const viewer = yield* Effect.result(connection.viewer);
      if (Result.isFailure(viewer)) {
        return {
          enabled: true,
          asOf,
          connection: {
            status: "unavailable" as const,
            code: viewer.failure.code,
            message: viewer.failure.message,
          },
          projects: [],
          ...defaults,
        };
      }
      const projects =
        aperture.defaultEntity.length === 0
          ? Result.succeed([])
          : yield* Effect.result(connection.projects(aperture.defaultEntity));
      const runtime = yield* ApertureRuntime.ApertureRuntime;
      const runtimeVersion = yield* runtime.getLatest.pipe(
        Effect.map((document) => document.version),
        Effect.option,
      );
      const { user } = viewer.success;
      return {
        enabled: true,
        asOf,
        connection: Result.isFailure(projects)
          ? {
              status: "unavailable" as const,
              code: projects.failure.code,
              message: projects.failure.message,
            }
          : { status: "connected" as const },
        viewer: {
          id: user.id,
          username: user.username,
          ...(user.display_name == null ? {} : { displayName: user.display_name }),
        },
        projects: Result.isFailure(projects)
          ? []
          : projects.success.map((project) => ({
              name: project.name,
              ...(project.display_name == null ? {} : { displayName: project.display_name }),
            })),
        ...defaults,
        ...(Option.isNone(runtimeVersion) ? {} : { runtimeVersion: runtimeVersion.value }),
      };
    }),
  ),
  aperture_query: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const apertureSettings = yield* readEnabledApertureSettings;
      const threadId = yield* callerThreadId("aperture_query");
      const scope = yield* resolveScope(apertureSettings, input);
      const asOf = yield* nowIso;
      const token: ApertureEmbedTokenPayload = {
        refId: "aperture_query",
        threadId,
        ...scope,
        asOf,
      };
      const project = `${scope.entity}/${scope.project}`;
      const limit = input.limit ?? 50;
      const result = { asOf, operation: input.operation, ...scope };
      if (input.operation === "runs") {
        const summaryFields = input.summaryFields ?? [];
        const response = yield* requestJson(
          token,
          {
            kind: "runs",
            project,
            ...(input.filter === undefined ? {} : { filter: input.filter }),
            order: [{ key: "created_at", dir: "desc" }],
            limit,
            fields: summaryFields.map((field) => `summary.${field}`),
          },
          RunsResponseSchema,
        );
        return {
          ...result,
          runs: response.runs.slice(0, limit).map((run) => {
            const summary = summaryFields.flatMap((field) => {
              const value = summaryFieldValue(run.summary, field);
              return value === undefined ? [] : [{ field, value }];
            });
            return {
              id: run.id,
              name: run.name,
              state: run.state,
              createdAt: run.created_at,
              ...(summary.length === 0 ? {} : { summary }),
            };
          }),
          truncated: response.next_cursor !== null || response.runs.length > limit,
        };
      }
      const runIds = input.runIds ?? [];
      if (input.operation === "keys") {
        const response = yield* requestJson(
          token,
          {
            kind: "keys",
            project,
            ...(runIds.length === 0 ? {} : { runs: { ids: runIds } }),
            ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
          },
          KeysResponseSchema,
        );
        return {
          ...result,
          keys: response.keys.slice(0, limit),
          truncated: response.keys.length > limit,
        };
      }
      const keys = input.keys ?? [];
      if (runIds.length === 0 || keys.length === 0) {
        return yield* failure(
          "History summaries need at least one run ID and one metric key.",
          "invalid_request",
        );
      }
      const response = yield* requestJson(
        token,
        {
          kind: "history",
          project,
          runs: { ids: runIds },
          keys,
          samples: 256,
          sampling: "minmax",
        },
        HistoryResponseSchema,
      );
      return {
        ...result,
        history: runIds.flatMap((runId) =>
          keys.map((key) =>
            historySummary(
              runId,
              key,
              response.series.find((entry) => entry.run === runId && entry.key === key),
            ),
          ),
        ),
        truncated: false,
      };
    }),
  ),
  aperture_figure_preview: McpToolAccess.readsAsCaller(({ spec, ...options }) =>
    preview("aperture_figure_preview", { kind: "figure", spec }, options),
  ),
  aperture_figure_render: McpToolAccess.actsAsCaller((input) =>
    render("aperture_figure_render", { kind: "figure", ...input }),
  ),
  aperture_widget_push: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* readEnabledApertureSettings;
      yield* callerThreadId("aperture_widget_push");
      const widgetStore = yield* ApertureWidgetStore.ApertureWidgetStore;
      return yield* widgetStore
        .push({ id: input.id, source: input.source })
        .pipe(Effect.mapError(widgetFailure));
    }),
  ),
  aperture_widget_preview: McpToolAccess.readsAsCaller(({ id, version, ...options }) =>
    preview("aperture_widget_preview", { kind: "widget", widget: { id, version } }, options),
  ),
  aperture_widget_render: McpToolAccess.actsAsCaller(({ id, version, ...options }) =>
    render("aperture_widget_render", { kind: "widget", widget: { id, version }, ...options }),
  ),
} satisfies McpToolAccess.Handlers<typeof ApertureToolkit.tools>;

export const layerStandard = McpToolAccess.toLayer(ApertureStandardToolkit, {
  aperture_status: handlers.aperture_status,
  aperture_query: handlers.aperture_query,
  aperture_figure_render: handlers.aperture_figure_render,
  aperture_widget_push: handlers.aperture_widget_push,
  aperture_widget_render: handlers.aperture_widget_render,
});

export const layerFigurePreview = McpToolAccess.toLayer(ApertureFigurePreviewToolkit, {
  aperture_figure_preview: handlers.aperture_figure_preview,
});

export const layerWidgetPreview = McpToolAccess.toLayer(ApertureWidgetPreviewToolkit, {
  aperture_widget_preview: handlers.aperture_widget_preview,
});
