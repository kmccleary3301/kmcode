import {
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

/** What a browser action fails with, including the access gate's refusal. */
const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields);

/** Drives the real browser and can destroy page state. */
const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

/** Same open-world browser access, but the action does not destroy page state. */
const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

/** A safe browser action that only observes, so it is also repeatable. */
const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report tab owner, pending dialog, URL, title, loading state, viewport, and size. Omit `tabId` for this thread's tab.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a browser tab; open the thread-bound preview by default. Set `open=false` for background automation. Pass `tabId` to reuse a tab, or omit it to use this agent session's current tab. Parallel agents sharing a provider session each need `reuseExistingTab=false` and their returned `tabId`. Server tabs use isolated storage and are session-bound.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss a pending dialog from `preview_status`. For prompts, pass `promptText` when accepting. Requires ownership of the tab; desktop hosts may not support it.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a tab to `url` or environment-port `target`; exactly one is required. Omit `tabId` for this thread's tab.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a tab with `fill`, `freeform`, or `preset` mode. This changes CSS breakpoints, not the browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate `prefers-color-scheme` with `dark`, `light`, or `system` (clear override).",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSnapshotTool = readonlyBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page only when the current request asks for browser work, never to verify your own edits or repeat a snapshot. Returns page state, accessibility refs, diagnostics, action history, and a screenshot. Refresh refs after navigation, another snapshot, or human takeover. Output is capped; use `preview_evaluate` for more. Set `includeImage=false` for text only or `save=true` to write a PNG. To show the user a screenshot, save it and embed `screenshotPath` as `![alt](screenshotPath)`.",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description: "Include the PNG. Defaults to true.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description: "Write the PNG to disk and return `screenshotPath`. Defaults to false.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click one target. Prefer a Playwright locator; use `selector` for CSS or `x` and `y` together. Set `button=right` for a context menu or `clickCount=2` to double-click. Server tabs only.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input. Prefer a Playwright locator; set `clear=true` to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewHoverTool = safeBrowserTool(
  Tool.make("preview_hover", {
    description: "Hover one target to reveal menus or tooltips. Server tabs only.",
    parameters: PreviewAutomationHoverInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Hover preview page"),
);

const PreviewSelectTool = browserTool(
  Tool.make("preview_select", {
    description:
      "Choose an option in a native `<select>` by value or label. Custom dropdowns need `preview_click`. Server tabs only.",
    parameters: PreviewAutomationSelectInput,
    success: Schema.Struct({
      ...PreviewAutomationSelectResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Select preview option"),
);

const PreviewDragTool = browserTool(
  Tool.make("preview_drag", {
    description: "Drag one element onto another. Server tabs only.",
    parameters: PreviewAutomationDragInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Drag in preview page"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Set files in the open chooser with absolute paths, or pass an empty list to cancel. A file-input locator avoids the picker. Server tabs only.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press a keyboard key. Examples: `{key:'Enter'}`, `{key:'Escape'}`, `{key:'a',modifiers:['Meta']}`.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll a tab; positive `deltaY` goes down and positive `deltaX` goes right. Use a locator or selector to target a container.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown,
});

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the page. Returns `{value}` (up to 64 KB). Page APIs are data-only: do not create, save, or display artifacts there; use `html_render`.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description: "Wait until supplied locator, selector, text, and URL conditions match.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording the tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording and transfer the compressed recording once to an environment-readable evidence file. Returns its local path.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
