import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { ApertureEmbedReferenceSchema } from "@t3tools/shared/apertureEmbed";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ApertureConnection from "../../../aperture/ApertureConnection.ts";
import * as ApertureEmbedToken from "../../../aperture/ApertureEmbedToken.ts";
import * as AperturePreview from "../../../aperture/AperturePreview.ts";
import * as ApertureRuntime from "../../../aperture/ApertureRuntime.ts";
import * as ApertureWidgetStore from "../../../aperture/ApertureWidgetStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const RunIds = Schema.Array(NonEmptyString).check(Schema.isMaxLength(20));
const MetricKeys = Schema.Array(NonEmptyString).check(Schema.isMaxLength(20));
const SummaryFields = Schema.Array(NonEmptyString).check(Schema.isMaxLength(20));
const ToolFailures = OrchestratorMcpFailure;
const ACCURACY_RULE =
  "Accuracy rule: every number stated about Aperture data must come from aperture_query or a rendered widget with the same asOf. Pass aperture_query's asOf to render tools.";
const ThreadDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const ApertureConnectionStatusSchema = Schema.Struct({
  status: Schema.Literals(["connected", "unavailable", "disabled"]),
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const ApertureViewerSchema = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});

const ApertureProjectSchema = Schema.Struct({
  name: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});

const ApertureRunSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
  createdAt: Schema.Finite,
  summary: Schema.optionalKey(
    Schema.Array(Schema.Struct({ field: Schema.String, value: Schema.Unknown })),
  ),
});

const ApertureKeySchema = Schema.Struct({ key: Schema.String, kind: Schema.String });

const ApertureHistorySummarySchema = Schema.Struct({
  runId: Schema.String,
  key: Schema.String,
  min: Schema.NullOr(Schema.Finite),
  max: Schema.NullOr(Schema.Finite),
  last: Schema.NullOr(Schema.Finite),
  count: Schema.Finite,
  lastStep: Schema.NullOr(Schema.Finite),
});

export const ApertureStatusTool = Tool.make("aperture_status", {
  description: `Check whether Aperture is enabled and reachable. Returns the viewer, projects for the default entity, configured defaults, and runtime version when available. ${ACCURACY_RULE}`,
  success: Schema.Struct({
    enabled: Schema.Boolean,
    asOf: Schema.String,
    connection: ApertureConnectionStatusSchema,
    viewer: Schema.optionalKey(ApertureViewerSchema),
    projects: Schema.Array(ApertureProjectSchema),
    defaultEntity: Schema.String,
    defaultProject: Schema.String,
    runtimeVersion: Schema.optionalKey(Schema.String),
  }),
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    ApertureConnection.ApertureConnection,
    ApertureRuntime.ApertureRuntime,
  ],
})
  .annotate(Tool.Title, "Aperture status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ApertureQueryTool = Tool.make("aperture_query", {
  description: `Query Aperture runs, metric keys, or history summaries. Every result includes one server-captured asOf; history is queried with that same pinned cutoff. Runs and keys are bounded, and history accepts at most 20 run IDs and 20 keys. ${ACCURACY_RULE}`,
  parameters: Schema.Struct({
    operation: Schema.Literals(["runs", "keys", "history"]),
    entity: Schema.optional(NonEmptyString),
    project: Schema.optional(NonEmptyString),
    filter: Schema.optional(Schema.Unknown),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
        description: "Maximum runs or keys returned; at most 100. Defaults to 50.",
      }),
    ),
    summaryFields: Schema.optional(SummaryFields),
    runIds: Schema.optional(RunIds),
    keys: Schema.optional(MetricKeys),
    prefix: Schema.optional(NonEmptyString),
  }),
  success: Schema.Struct({
    asOf: Schema.String,
    operation: Schema.Literals(["runs", "keys", "history"]),
    entity: Schema.String,
    project: Schema.String,
    runs: Schema.optionalKey(Schema.Array(ApertureRunSchema)),
    keys: Schema.optionalKey(Schema.Array(ApertureKeySchema)),
    history: Schema.optionalKey(Schema.Array(ApertureHistorySummarySchema)),
    truncated: Schema.Boolean,
  }),
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    ApertureConnection.ApertureConnection,
  ],
})
  .annotate(Tool.Title, "Query Aperture")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PreviewParameters = Schema.Struct({
  entity: Schema.optional(NonEmptyString),
  project: Schema.optional(NonEmptyString),
  width: Schema.optional(
    Schema.Int.annotate({ description: "CSS pixels; the server clamps this to 320–1600." }),
  ),
  appearance: Schema.optional(Schema.Literals(["light", "dark"])),
  asOf: Schema.optional(
    Schema.String.annotate({ description: "An ISO timestamp no later than now." }),
  ),
});

const PreviewSuccess = Schema.Struct({
  asOf: Schema.String,
  width: Schema.Int,
  capturedHeight: Schema.Int,
  runtimeVersion: Schema.String,
  contentHeight: Schema.Finite,
  consoleMessages: Schema.Array(Schema.String),
  embedErrors: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      detail: Schema.optionalKey(Schema.String),
    }),
  ),
  failedRequests: Schema.Array(
    Schema.Struct({
      method: Schema.String,
      path: Schema.String,
      status: Schema.NullOr(Schema.Finite),
      code: Schema.NullOr(Schema.String),
    }),
  ),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});

export const ApertureFigurePreviewTool = Tool.make("aperture_figure_preview", {
  description: `Render a figure spec in the live Aperture runtime and return a PNG with sizing and diagnostics. Use this before aperture_figure_render. The result includes its pinned asOf. ${ACCURACY_RULE}`,
  parameters: Schema.Struct({ spec: Schema.Unknown, ...PreviewParameters.fields }),
  success: PreviewSuccess,
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    AperturePreview.AperturePreview,
  ],
})
  .annotate(Tool.Title, "Preview Aperture figure")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ApertureFigureRenderTool = Tool.make("aperture_figure_render", {
  description: `Show a finished Aperture figure inline in this thread, above your final reply. Do not announce or restate it. Pass asOf from aperture_query to keep its data aligned with your prose. Defaults to pinned mode. ${ACCURACY_RULE}`,
  parameters: Schema.Struct({
    spec: Schema.Unknown,
    title: NonEmptyString,
    height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })),
    mode: Schema.optional(Schema.Literals(["pinned", "live"])),
    entity: Schema.optional(NonEmptyString),
    project: Schema.optional(NonEmptyString),
    asOf: Schema.optional(
      Schema.String.annotate({ description: "An ISO timestamp no later than now." }),
    ),
  }),
  success: Schema.Struct({
    apertureEmbed: ApertureEmbedReferenceSchema,
    message: Schema.String,
  }),
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    AperturePreview.AperturePreview,
    ApertureRuntime.ApertureRuntime,
    ApertureEmbedToken.ApertureEmbedToken,
    ApertureWidgetStore.ApertureWidgetStore,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Render Aperture figure")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ApertureWidgetPushTool = Tool.make("aperture_widget_push", {
  description: `Compile and upload agent-written TSX to Aperture's development widget store. The source must default-export defineWidget({ id, ... }) with the same id you pass here; the runtime refuses a module whose defineWidget id differs. The diagnostics are returned verbatim; fix compile errors and push again before previewing or rendering. ${ACCURACY_RULE}`,
  parameters: Schema.Struct({
    source: Schema.String.check(Schema.isMinLength(1)),
    id: NonEmptyString,
  }),
  success: Schema.Struct({
    id: Schema.String,
    version: Schema.NullOr(Schema.String),
    diagnostics: Schema.Array(
      Schema.Struct({
        file: Schema.String,
        line: Schema.Finite,
        column: Schema.Finite,
        severity: Schema.Literals(["error", "warning"]),
        text: Schema.String,
      }),
    ),
  }),
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    ApertureWidgetStore.ApertureWidgetStore,
  ],
})
  .annotate(Tool.Title, "Push Aperture widget")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ApertureWidgetPreviewTool = Tool.make("aperture_widget_preview", {
  description: `Render a pinned widget version in the live Aperture runtime and return a PNG with sizing and diagnostics. Use this before aperture_widget_render. Pass the asOf from aperture_query when discussing data. ${ACCURACY_RULE}`,
  parameters: Schema.Struct({
    id: NonEmptyString,
    version: NonEmptyString,
    ...PreviewParameters.fields,
  }),
  success: PreviewSuccess,
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    AperturePreview.AperturePreview,
  ],
})
  .annotate(Tool.Title, "Preview Aperture widget")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ApertureWidgetRenderTool = Tool.make("aperture_widget_render", {
  description: `Show a pinned Aperture widget version inline in this thread, above your final reply. Do not announce or restate it. Pass asOf from aperture_query to keep its data aligned with your prose. Defaults to pinned mode. ${ACCURACY_RULE}`,
  parameters: Schema.Struct({
    id: NonEmptyString,
    version: NonEmptyString,
    title: NonEmptyString,
    height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })),
    mode: Schema.optional(Schema.Literals(["pinned", "live"])),
    entity: Schema.optional(NonEmptyString),
    project: Schema.optional(NonEmptyString),
    asOf: Schema.optional(
      Schema.String.annotate({ description: "An ISO timestamp no later than now." }),
    ),
  }),
  success: Schema.Struct({
    apertureEmbed: ApertureEmbedReferenceSchema,
    message: Schema.String,
  }),
  failure: ToolFailures,
  failureMode: "return",
  dependencies: [
    ...ThreadDependencies,
    ServerSettings.ServerSettingsService,
    AperturePreview.AperturePreview,
    ApertureRuntime.ApertureRuntime,
    ApertureEmbedToken.ApertureEmbedToken,
    ApertureWidgetStore.ApertureWidgetStore,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Render Aperture widget")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ApertureToolkit = Toolkit.make(
  ApertureStatusTool,
  ApertureQueryTool,
  ApertureFigurePreviewTool,
  ApertureFigureRenderTool,
  ApertureWidgetPushTool,
  ApertureWidgetPreviewTool,
  ApertureWidgetRenderTool,
);

export const ApertureStandardToolkit = Toolkit.make(
  ApertureStatusTool,
  ApertureQueryTool,
  ApertureFigureRenderTool,
  ApertureWidgetPushTool,
  ApertureWidgetRenderTool,
);

export const ApertureFigurePreviewToolkit = Toolkit.make(ApertureFigurePreviewTool);
export const ApertureWidgetPreviewToolkit = Toolkit.make(ApertureWidgetPreviewTool);

export interface ApertureToolkitSet {
  readonly standard: Toolkit.Toolkit<typeof ApertureStandardToolkit.tools>;
  readonly figurePreview: Toolkit.Toolkit<typeof ApertureFigurePreviewToolkit.tools>;
  readonly widgetPreview: Toolkit.Toolkit<typeof ApertureWidgetPreviewToolkit.tools>;
}

export const apertureToolkitsWhen = (isEnabled: () => boolean): ApertureToolkitSet => {
  const status = ApertureStatusTool.annotate(McpSchema.EnabledWhen, isEnabled);
  const query = ApertureQueryTool.annotate(McpSchema.EnabledWhen, isEnabled);
  const figurePreview = ApertureFigurePreviewTool.annotate(McpSchema.EnabledWhen, isEnabled);
  const figureRender = ApertureFigureRenderTool.annotate(McpSchema.EnabledWhen, isEnabled);
  const widgetPush = ApertureWidgetPushTool.annotate(McpSchema.EnabledWhen, isEnabled);
  const widgetPreview = ApertureWidgetPreviewTool.annotate(McpSchema.EnabledWhen, isEnabled);
  const widgetRender = ApertureWidgetRenderTool.annotate(McpSchema.EnabledWhen, isEnabled);
  return {
    standard: Toolkit.make(status, query, figureRender, widgetPush, widgetRender),
    figurePreview: Toolkit.make(figurePreview),
    widgetPreview: Toolkit.make(widgetPreview),
  };
};
