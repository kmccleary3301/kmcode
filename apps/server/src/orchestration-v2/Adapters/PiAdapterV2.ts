/**
 * PiAdapterV2 — orchestrator-v2 adapter for the Pi coding agent
 * (https://pi.dev), driving `pi --mode rpc` over stdio JSONL via `PiRpc.ts`.
 *
 * Design intent: honor the user's Pi customizations. The process is spawned
 * with no `--no-*` flags, so the user's extensions, skills, prompt templates,
 * AGENTS.md / SYSTEM.md context, settings.json, custom models, and auth all
 * load exactly as they do in the `pi` TUI. Sessions are stored by Pi itself
 * (default `~/.pi/agent/sessions/`), and the session file path is the durable
 * `nativeThreadRef`, so a thread started in T3 can be resumed from the TUI
 * and vice versa.
 *
 * Turn lifecycle: `agent_settled` is the only terminal signal. `agent_end`
 * merely closes one low-level run — compaction retries, auto-retries, and
 * queued continuations may still follow it, so the turn stays open until Pi
 * reports the session settled. An extension can start detached compaction as
 * that signal unwinds, so the adapter confirms Pi is idle before terminalizing.
 *
 * Extension UI: Pi extensions raise dialogs through `extension_ui_request`.
 * Dialog methods become v2 runtime requests (`confirm` → approval_request,
 * `select`/`input`/`editor` → user_input_request); answers travel back as
 * `extension_ui_response`. `notify` becomes a completed activity item.
 * Terminal-only decoration such as status, widget, title, and editor-text
 * updates has no matching T3 surface and is ignored.
 */
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  isOmpAsyncJobWait,
  OMP_ASYNC_JOB_TASK_ID_PREFIX,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  defaultInstanceIdForDriver,
  isOrchestrationV2WorkActive,
  ORCHESTRATION_V2_SUBAGENT_LIVE_CONTENT_MAX_LENGTH,
  OmpSettings,
  OrchestrationV2ProviderGoal,
  PiSettings,
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2SubagentLiveContent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  expandPiSkillReference,
  parsePiCompactCommand,
  parsePiDiscoveredCommands,
  type PiCompactCommand,
} from "../../provider/PiCommands.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { OMP_DIALECT, PI_DIALECT, type PiDialect } from "../../provider/piDialect.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure, makeProviderRetryTurnItem } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  makePiRpcConnection,
  PiRpcError,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "./PiRpc.ts";
import { piToolTurnItemFields } from "./PiToolTurnItem.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "./piT3McpInjection.ts";
import { PI_FILE_CHANGE_TOOLS } from "./piT3McpExtensionSource.ts";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import * as ThreadLiveOverlay from "../ThreadLiveOverlay.ts";

export const PI_PROVIDER = ProviderDriverKind.make("pi");
const PI_DRIVER_KIND = PI_PROVIDER;
const PI_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(PI_DRIVER_KIND);
const DEFAULT_PI_SETTINGS = Schema.decodeSync(PiSettings)({});
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

type OmpGoalCommand =
  | { readonly type: "get" }
  | { readonly type: "create"; readonly objective: string }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "drop" }
  | { readonly type: "budget" }
  | { readonly type: "invalid"; readonly message: string };

function parseOmpGoalCommand(text: string): OmpGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const args = (match[1] ?? "").trim();
  if (args.length === 0) return { type: "get" };
  const subcommand = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
  if (subcommand === null) return { type: "get" };
  const operation = subcommand[1] ?? "";
  const remainder = (subcommand[2] ?? "").trim();
  switch (operation.toLowerCase()) {
    case "set":
      return remainder.length === 0
        ? { type: "invalid", message: "Usage: /goal set <objective>." }
        : { type: "create", objective: remainder };
    case "show":
      return { type: "get" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    case "drop":
    case "clear":
      return { type: "drop" };
    case "budget":
      return { type: "budget" };
    default:
      return { type: "create", objective: args };
  }
}

function providerGoalFromOmpNativeGoal(
  nativeGoal: unknown,
): OrchestrationV2ProviderGoal | null | undefined {
  if (nativeGoal === null) return null;
  const status = recordString(nativeGoal, "status");
  switch (status) {
    case "dropped":
      return null;
    case "active":
    case "paused":
    case "complete":
    case "budget-limited":
      break;
    default:
      return undefined;
  }
  const objective = recordString(nativeGoal, "objective")?.trim();
  if (objective === undefined || objective.length === 0) return undefined;
  const tokensUsed = recordNumber(nativeGoal, "tokensUsed");
  const rawTokenBudget = recordField(nativeGoal, "tokenBudget");
  const tokenBudget = recordNumber(nativeGoal, "tokenBudget");
  const timeUsedSeconds = recordNumber(nativeGoal, "timeUsedSeconds");
  return {
    objective,
    status: status === "budget-limited" ? "budget_limited" : status,
    ...(tokensUsed === undefined ? {} : { tokensUsed: Math.max(0, Math.trunc(tokensUsed)) }),
    tokenBudget:
      rawTokenBudget === null || tokenBudget === undefined
        ? null
        : Math.max(0, Math.trunc(tokenBudget)),
    ...(timeUsedSeconds === undefined
      ? {}
      : { timeUsedSeconds: Math.max(0, Math.trunc(timeUsedSeconds)) }),
  };
}

function providerGoalFromOmpState(data: unknown): OrchestrationV2ProviderGoal | null | undefined {
  const goalState = recordField(data, "goal");
  if (goalState === undefined) return undefined;
  if (goalState === null) return null;
  const nativeGoal = recordField(goalState, "goal");
  return nativeGoal === undefined ? undefined : providerGoalFromOmpNativeGoal(nativeGoal);
}

function providerGoalFromOmpCommandResult(
  data: unknown,
): OrchestrationV2ProviderGoal | null | undefined {
  const nativeGoal = recordField(data, "goal");
  return nativeGoal === undefined ? undefined : providerGoalFromOmpNativeGoal(nativeGoal);
}

function describeOmpGoal(goal: OrchestrationV2ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

/**
 * Sentinel model slug meaning "do not call set_model": Pi resolves the model
 * from the user's own settings.json (`defaultProvider`/`defaultModel`).
 */
const PI_INHERIT_MODEL_SLUG = "default";

const STREAM_FLUSH_MS = 50;

/** OMP progress statuses after which a child agent produces no further output. */
const PI_SUBAGENT_FINISHED_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  aborted: true,
};
/** One `<task-result>` block in OMP's background job delivery (`async-result` message). */
const PI_TASK_RESULT_PATTERN =
  /<task-result id="([^"]+)"[^>]*?\sstatus="([^"]+)"[^>]*>([\s\S]*?)<\/task-result>/g;
const PI_TASK_RESULT_OUTPUT_PATTERN = /<output>([\s\S]*?)<\/output>/;
const PI_REQUEST_TIMEOUT_MS = 15_000;
// Session lifecycle hooks reload extensions, MCP servers and language servers.
const PI_SESSION_TIMEOUT_MS = 60_000;
const PI_SKILL_DISCOVERY_TIMEOUT_MS = 4_000;
const PI_UNSOLICITED_ACTIVITY_ERROR =
  "Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);
const SETTLE_PROBE_BACKOFF = [
  Duration.seconds(30),
  Duration.seconds(60),
  Duration.seconds(120),
  Duration.seconds(240),
  Duration.seconds(600),
] as const;

const PiProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // Mode changes restart this process so the injected permission hook gets
    // one immutable policy for its whole lifetime.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    // Pi exposes a blocking tool_call extension hook. The T3 bridge uses it
    // for supervised and auto-accept modes and forwards its confirmations
    // through the same extension UI protocol as user-installed extensions.
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    // T3 delegation uses the shared MCP `delegate_task` path. Installed Pi
    // subagent extensions are observed best-effort, but their official tool
    // runs children with --no-session and exposes no resumable child id.
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    // T3 delivers both full and delta handoffs through Pi's normal user-message
    // input, so neither strategy depends on a Pi-specific context hook.
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy.ensureRollback requires the snapshot whenever provider
    // rollback is enabled; rollbackThread returns the updated provider thread.
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface PiAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly dialect: PiDialect;
  readonly threadLiveOverlay: ThreadLiveOverlay.ThreadLiveOverlay["Service"];
}

/** Concatenate the `text` fields of a Pi content-block array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .join("");
}

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseRecordDateTime(
  record: unknown,
  ...fieldNames: ReadonlyArray<string>
): DateTime.Utc | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const rec = record as Record<string, unknown>;
  for (const field of fieldNames) {
    const val = rec[field];
    if (typeof val === "number" && Number.isFinite(val)) {
      const ms = val < 10_000_000_000 ? val * 1000 : val;
      const dt = DateTime.make(ms);
      if (Option.isSome(dt)) return dt.value;
    } else if (typeof val === "string") {
      const parsed = Date.parse(val);
      if (Number.isFinite(parsed)) {
        const dt = DateTime.make(parsed);
        if (Option.isSome(dt)) return dt.value;
      }
    }
  }
  return undefined;
}

function parseRecordDurationMs(
  record: unknown,
  ...fieldNames: ReadonlyArray<string>
): number | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const rec = record as Record<string, unknown>;
  for (const field of fieldNames) {
    const val = rec[field];
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      return val;
    }
  }
  return undefined;
}

const OMP_SUBAGENT_ARGS_PREVIEW_MAX_LENGTH = 240;

/** Flatten v18.10 OMP's progress wrapper without mixing its label, type, task, and identity. */
function normalizeOmpSubagentRecord(payload: unknown): Record<string, unknown> {
  const wrapper =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const progressValue = wrapper["progress"];
  const hasProgress =
    progressValue !== null && typeof progressValue === "object" && !Array.isArray(progressValue);
  const progress = hasProgress ? (progressValue as Record<string, unknown>) : {};
  const nativeAgentId = recordString(wrapper, "id") ?? recordString(progress, "id");
  const agentType = recordString(wrapper, "agent") ?? recordString(progress, "agent");
  const displayLabel =
    recordString(progress, "displayLabel") ??
    recordString(wrapper, "displayLabel") ??
    recordString(progress, "label") ??
    recordString(wrapper, "label");
  const currentToolName = recordString(progress, "currentTool");
  const currentToolArgs = recordString(progress, "currentToolArgs");
  const currentToolIntent = recordString(progress, "currentToolIntent");
  const currentTool =
    currentToolName === undefined
      ? null
      : {
          name: currentToolName,
          ...(currentToolIntent === undefined ? {} : { intent: currentToolIntent }),
          ...(currentToolArgs === undefined
            ? {}
            : { argsPreview: currentToolArgs.slice(0, OMP_SUBAGENT_ARGS_PREVIEW_MAX_LENGTH) }),
        };
  const metrics = nativeSubagentMetrics(progress);
  const completionPercent = recordNumber(progress, "completionPercent");
  const retryState = recordField(progress, "retryState");
  const retryFailure = recordField(progress, "retryFailure");
  const retryAttempt = recordNumber(retryState, "attempt") ?? recordNumber(retryFailure, "attempt");
  const retryDelayMs = parseRecordDurationMs(retryState, "delayMs");

  const retry =
    retryAttempt === undefined || !Number.isInteger(retryAttempt) || retryAttempt < 0
      ? null
      : {
          attempt: retryAttempt,
          ...(retryDelayMs === undefined ? {} : { delayMs: retryDelayMs }),
          ...((recordString(retryState, "errorMessage") ??
            recordString(retryFailure, "errorMessage")) === undefined
            ? {}
            : {
                message:
                  recordString(retryState, "errorMessage") ??
                  recordString(retryFailure, "errorMessage"),
              }),
        };

  const task = recordString(progress, "task") ?? recordString(wrapper, "task");
  const status = recordString(progress, "status") ?? recordString(wrapper, "status");
  const index = recordNumber(wrapper, "index") ?? recordNumber(progress, "index");

  return {
    ...progress,
    ...wrapper,
    ...(nativeAgentId === undefined ? {} : { id: nativeAgentId, nativeAgentId }),
    ...(agentType === undefined ? {} : { agent: agentType, agentType }),
    ...(displayLabel === undefined ? {} : { displayLabel }),
    ...(status === undefined ? {} : { status }),
    ...(index === undefined ? {} : { index }),
    ...(hasProgress
      ? {
          currentTool,
          ...(metrics === undefined ? { metrics: undefined } : { metrics }),
          ...(completionPercent !== undefined && completionPercent >= 0 && completionPercent <= 100
            ? { completionPercent }
            : {}),
          retry,
        }
      : {}),
  };
}

// ── per-session state ─────────────────────────────────────────

interface PiStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  completedAt?: DateTime.Utc | undefined;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

type PiSubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;
type PiSubagentMetrics = NonNullable<PiSubagentTurnItem["metrics"]>;
type PiSystemNoticeTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "system_notice" }>;
type PiJobCompletion = NonNullable<PiSystemNoticeTurnItem["jobCompletion"]>;

function nativeMetricInteger(record: unknown, field: string): number | undefined {
  const value = recordNumber(record, field);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Preserve only native counters; absent or invalid values stay unknown. */
function nativeSubagentMetrics(
  record: unknown,
  terminalResult?: unknown,
): PiSubagentMetrics | undefined {
  const toolCount = nativeMetricInteger(record, "toolCount");
  const requests = nativeMetricInteger(record, "requests");
  const tokens = nativeMetricInteger(record, "tokens");
  const contextTokens = nativeMetricInteger(record, "contextTokens");
  const contextWindow = nativeMetricInteger(record, "contextWindow");
  const usageCost = recordNumber(
    recordField(recordField(terminalResult, "usage"), "cost"),
    "total",
  );
  const directCost = recordNumber(record, "cost");
  const cost =
    usageCost !== undefined && usageCost >= 0
      ? usageCost
      : directCost !== undefined && directCost >= 0
        ? directCost
        : undefined;
  if (
    toolCount === undefined &&
    requests === undefined &&
    tokens === undefined &&
    contextTokens === undefined &&
    contextWindow === undefined &&
    cost === undefined
  ) {
    return undefined;
  }
  return {
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(requests === undefined ? {} : { requests }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** A tool call whose arguments are still streaming inside the assistant message. */
interface PiToolPreviewState {
  toolName?: string | undefined;
  args?: unknown;
  flushScheduled: boolean;
  /** Execution events own the item once Pi starts running the tool. */
  executing: boolean;
}

/** An OMP child agent, keyed by its subagent id, observed through subagent RPC frames. */
interface PiSubagentLiveState {
  nativeTaskId?: string | undefined;
  transcriptFile?: string | undefined;
  liveContent?: OrchestrationV2SubagentLiveContent | undefined;
  flushScheduled: boolean;
  overlayFlushScheduled: boolean;
  lastOverlayPublishedAt?: number | undefined;
  activeRunId?: string | undefined;
  model?: string | undefined;
}
function newPiSubagentLiveState(): PiSubagentLiveState {
  return { flushScheduled: false, overlayFlushScheduled: false };
}

interface PiTurnSubagentActivation {
  currentActivationId?: string | undefined;
  readonly seenActivationIds: Set<string>;
  readonly terminalActivationIds: Set<string>;
}

type PiCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface PiCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface PiProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: PiCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

interface ActivePiTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  /** Increments on assistant `message_start` so content indexes stay unique. */
  messageOrdinal: number;
  readonly streamItems: Map<string, PiStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolNames: Map<string, string>;
  readonly toolIntents: Map<string, string>;
  /**
   * First-seen time per `toolCallId`. Later update/end events reuse it so a
   * tool keeps one start timestamp and reports a real duration.
   */
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly toolPreviews: Record<string, PiToolPreviewState>;
  readonly emittedToolCalls: Set<string>;
  /**
   * Tool calls that already returned. OMP's async `task` keeps sending
   * `tool_execution_update` for its background job after the call ends; those
   * update the subagents but must not reopen the finished tool item.
   */
  readonly endedTools: Record<string, true>;
  readonly subagentLive: Record<string, PiSubagentLiveState>;
  /** Last emitted subagent item per native task, re-sent when only its live preview changes. */
  readonly subagentItems: Record<string, PiSubagentTurnItem>;
  readonly subagentActivations: Record<string, PiTurnSubagentActivation>;
  interrupted: boolean;
  /** OMP reported that this run is paused only for a provider-owned async job. */
  waitingOnBackgroundJob: boolean;
  /**
   * Whether any agent run activity was observed. Command-only prompts (pure
   * extension slash commands) never start an agent run and never emit
   * `agent_settled`; their deferred prompt ack plus an idle probe settles
   * the turn instead.
   */
  sawAgentActivity: boolean;
  /** Only slash-command prompts can complete without starting an agent run. */
  readonly promptMayBeCommandOnly: boolean;
  /** Pi reports context as unknown immediately after compaction; keep its estimate for the meter. */
  latestCompactionAfterTokens: number | null;
  /** Last streamed usage total already emitted on the running turn. */
  lastLiveUsedTokens: number | null;
  /** Invalidates idle snapshots when new work starts after a settle probe. */
  settleProbeGeneration: number;
  /** Number of successful unsettled probes that have scheduled another check. */
  settleReprobeAttempt: number;
  /** The single delayed re-probe, canceled when the turn changes or ends. */
  settleReprobeFiber: Fiber.Fiber<void, never> | null;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  /** RPC compact is in flight; Pi abort does not cancel it. */
  manualCompactInFlight: boolean;
  activeCompaction: PiCompactionState | null;
  activeProviderRetry: PiProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  /** Keep the original user boundary when successive inspections advance the tree cursor. */
  nativeTurnStartEntryId?: string;
  /** Session-tree refs read just before Stop terminates Pi, when no read is possible later. */
  stopTreeRefs?: PiTurnTreeRefs | null;
}

interface PiTurnTreeRefs {
  readonly turnStartEntryId: string | null;
  readonly leafId: string | null;
}

interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  readonly approvalKey: string;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

/**
 * The T3 bridge confirms tool calls as `Allow <tool>?`. Edits surface as
 * file-change approvals so clients render them like other providers' edits;
 * every other confirmation, including ones from user extensions, is a command.
 */
function piApprovalRequestKind(title: string): "command" | "file-change" {
  const toolName = /^Allow (\S+)\?$/.exec(title)?.[1];
  return toolName !== undefined &&
    (PI_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)
    ? "file-change"
    : "command";
}

interface PiThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActivePiTurn | null;
  lastFinalizedTurn?: ActivePiTurn | undefined;
  finishedTurnsWithActiveChildren?: ActivePiTurn[];
  nextNoticeOrdinal?: number | undefined;
  readonly seenAsyncResultJobs: Map<string, Set<string>>;
  /**
   * OMP async jobs (background bash, eval, async task) seen starting and not
   * yet seen ending, by job id, as the wait roster names them.
   */
  readonly ompAsyncJobs: Map<string, OrchestrationV2PendingBackgroundTask>;
}

// ── adapter ───────────────────────────────────────────────────

export function makePiAdapterV2(
  options: PiAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  const { idAllocator } = options;
  const driver = options.dialect.driverKind;
  const providerRef = (
    nativeId: string,
    strength: "strong" | "weak" = "strong",
  ): OrchestrationV2ProviderRef => ({ driver, nativeId, strength });

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(PiProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("PiAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      // The extension owns both the optional MCP bridge and Pi's permission
      // hook. Materialize it even when this session has no MCP credential so
      // Supervised never silently degrades to unrestricted tool execution.
      const extensionPath = yield* provideCacheFs(
        materializePiT3McpExtension(options.serverConfig.providerStatusCacheDir),
      );
      const resolvedLaunchArgs = resolvePiLaunchArgs(options.settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* protocolError(resolvedLaunchArgs.message);
      }
      const launchArgs = resolvedLaunchArgs.args;
      const launch = buildPiRpcLaunch({
        launchArgs,
        environment: options.environment,
        mcpSession,
        extensionPath,
        runtimeMode: input.runtimePolicy.runtimeMode,
        runtimeInstructions: buildRuntimeInstructions({
          harness: driver === "omp" ? "OMP" : "Pi",
          aperture: mcpSession?.capabilities?.has("aperture") === true,
        }),
      });
      const spawnConnection = Effect.suspend(() =>
        makePiRpcConnection({
          command: options.settings.binaryPath || options.dialect.binary,
          args: launch.args,
          cwd,
          env: launch.env,
          dialect: options.dialect,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      let connection: PiRpcConnection = yield* spawnConnection;
      let connectionGeneration = 0;
      let desiredSubagentSubscriptionLevel: "events" | "progress" = "progress";
      const requestSubagentSubscription = (level: "events" | "progress") =>
        connection
          .request({ type: "set_subagent_subscription", level }, PI_REQUEST_TIMEOUT_MS)
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("OMP subagent event subscription failed", {
                providerSessionId: input.providerSessionId,
                errorTag: error._tag,
              }),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
          );
      if (driver === "omp") yield* requestSubagentSubscription(desiredSubagentSubscriptionLevel);
      const discoverSkillNames = Effect.suspend(() =>
        connection
          .request({ type: "get_commands" }, PI_SKILL_DISCOVERY_TIMEOUT_MS)
          .pipe(
            Effect.map(
              (data) => new Set(parsePiDiscoveredCommands(data).skills.map((skill) => skill.name)),
            ),
          ),
      );
      let skillNames: Set<string> | null = null;

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: PiProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingPiPrompt>();
      const sessionApprovals = new Set<string>();
      // Answering a dialog and terminalizing a turn both publish lifecycle
      // events. Pi can settle immediately after `extension_ui_response`, so
      // serialize the two paths to stop `turn.terminal` from overtaking the
      // dialog's own resolution updates.
      const sessionEventPermit = yield* Semaphore.make(1);
      const subagentModePermit = yield* Semaphore.make(1);
      let currentSubagentViewer = false;
      let currentSubagentModeReason: "viewing" | "idle" | "rate-limited" | null = null;
      let subagentRateLimitedUntil: number | null = null;
      let subagentGuardGeneration = 0;
      const recentSubagentEvents: Array<{ readonly at: number; readonly bytes: number }> = [];
      let recentSubagentEventBytes = 0;
      const subagentEventExceedsGuard = (event: PiRpcRecord) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const oldestRetainedTime = now - 2_000;
          while (
            recentSubagentEvents[0] !== undefined &&
            recentSubagentEvents[0].at < oldestRetainedTime
          ) {
            const expired = recentSubagentEvents.shift();
            if (expired !== undefined) recentSubagentEventBytes -= expired.bytes;
          }
          const bytes = estimateJsonByteLength(event);
          recentSubagentEvents.push({ at: now, bytes });
          recentSubagentEventBytes += bytes;
          let framesInLastSecond = 0;
          for (let index = recentSubagentEvents.length - 1; index >= 0; index -= 1) {
            const recent = recentSubagentEvents[index];
            if (recent === undefined || recent.at < now - 1_000) break;
            framesInLastSecond += 1;
          }
          return framesInLastSecond > 100 || recentSubagentEventBytes > 8 * 1_024 * 1_024;
        });
      let threadState: PiThreadState | null = null;
      let registrationAttempted = false;
      let lastNativeThreadId: string | null = null;
      // User Stop intentionally tears down this RPC process after aborting.
      // Keep that intent beyond turn finalization so the later stdout close is
      // not mistaken for an unexpected transport failure.
      let stopRequested = false;
      // Pi extensions can trigger an agent turn after the owning T3 turn has
      // settled. Until orchestration has a first-class provider-initiated run,
      // stop that runtime before it can execute tools without a timeline owner.
      let unsolicitedActivityDetected = false;
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      /** Last thread title synced into pi's session name (`/resume` listing). */
      let appliedSessionName: string | null = null;
      /** Extension failures raised during startup are attached to the next turn. */
      const outOfTurnExtensionErrors: Array<PiRpcRecord> = [];
      /**
       * Leaf entry id of the pi session tree as of the last turn boundary.
       * Turn-start user entries are located relative to it, giving each
       * provider turn a durable native ref for session-tree rollback.
       */
      let lastKnownLeaf: string | null = null;
      /**
       * Set when a `get_entries` capture failed. Pi may have advanced past
       * `lastKnownLeaf` since, so the cursor no longer bounds a single turn
       * and the next capture re-syncs it instead of trusting it.
       */
      let leafCursorStale = false;
      // Pi's own configured defaults, captured from the first `get_state` so
      // that selecting the displayed "Pi default" again can restore them. Pi
      // has no "unset" commands, so the baselines have to be replayed
      // explicitly.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      /** Context window of the model Pi currently runs, from get_state and set_model. */
      let contextWindow: number | null = null;
      const modelContextWindows = new Map<string, number>();
      let modelsDiscovered = false;
      // Prompt responses carry no id. Keep their session-wide send order and
      // owner so a late ack from a settled turn cannot affect the next turn.
      const pendingPromptResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];

      const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread = (
        state: PiThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: state.providerThread,
          });
        });

      const syncOmpGoal = (state: PiThreadState, goal: OrchestrationV2ProviderGoal | null) =>
        Effect.gen(function* () {
          if (driver !== "omp" || providerGoalsEqual(state.providerThread.goal ?? null, goal)) {
            return;
          }
          yield* updateProviderThread(state, { goal });
        });

      /** Replaces the OMP async-job entries on the roster, leaving other work alone. */
      const writeOmpAsyncJobRoster = (
        state: PiThreadState,
        jobs: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
      ) => {
        const pendingBackgroundTasks = state.providerThread.pendingBackgroundTasks ?? [];
        const others = pendingBackgroundTasks.filter((task) => !isOmpAsyncJobWait(task));
        if (jobs.length === 0 && others.length === pendingBackgroundTasks.length) {
          return Effect.void;
        }
        return updateProviderThread(state, { pendingBackgroundTasks: [...others, ...jobs] });
      };

      const setOmpBackgroundWait = (state: PiThreadState, turn: ActivePiTurn) =>
        Effect.gen(function* () {
          if (turn.waitingOnBackgroundJob) return;
          turn.waitingOnBackgroundJob = true;
          // A job started before this adapter attached was never seen starting:
          // the wait still shows, unnamed.
          yield* writeOmpAsyncJobRoster(
            state,
            state.ompAsyncJobs.size > 0
              ? Array.from(state.ompAsyncJobs.values())
              : [
                  {
                    taskId: `${OMP_ASYNC_JOB_TASK_ID_PREFIX}${turn.providerTurn.id}`,
                    kind: "background_task",
                    description: "Background job",
                  },
                ],
          );
        });

      const clearOmpBackgroundWait = (state: PiThreadState, turn: ActivePiTurn) =>
        Effect.gen(function* () {
          if (!turn.waitingOnBackgroundJob) return;
          turn.waitingOnBackgroundJob = false;
          yield* writeOmpAsyncJobRoster(state, []);
        });

      const endOmpAsyncJob = (state: PiThreadState, jobId: string) => {
        if (!state.ompAsyncJobs.delete(jobId)) return Effect.void;
        // The last job's end wakes OMP, and that wake clears the wait.
        if (state.activeTurn?.waitingOnBackgroundJob !== true || state.ompAsyncJobs.size === 0) {
          return Effect.void;
        }
        return writeOmpAsyncJobRoster(state, Array.from(state.ompAsyncJobs.values()));
      };

      /**
       * Follows one OMP async job from the `details.async` frame its tool call
       * reports: `running` once the call backgrounds it, then a terminal state.
       * A wait already shown re-lists the jobs still running.
       */
      const trackOmpAsyncJob = Effect.fnUntraced(function* (
        state: PiThreadState,
        turn: ActivePiTurn,
        toolCallId: string,
        args: unknown,
        resultRecord: unknown,
      ) {
        const asyncJob = recordField(recordField(resultRecord, "details"), "async");
        const jobId = recordString(asyncJob, "jobId");
        const jobState = recordString(asyncJob, "state");
        if (jobId === undefined || jobId.length === 0 || jobState === undefined) return;
        if (jobState !== "running") {
          yield* endOmpAsyncJob(state, jobId);
          return;
        }
        if (state.ompAsyncJobs.has(jobId)) return;
        const command = (recordString(args, "command") ?? recordString(args, "code"))?.trim();
        const intent = turn.toolIntents.get(toolCallId)?.trim();
        const jobType = recordString(asyncJob, "type");
        const description =
          intent || command?.split("\n", 1)[0]?.trim() || `${jobType ?? "async"} job ${jobId}`;
        state.ompAsyncJobs.set(jobId, {
          taskId: `${OMP_ASYNC_JOB_TASK_ID_PREFIX}${jobId}`,
          kind: "background_task",
          description,
          ...(command ? { command } : {}),
          startedAt: DateTime.formatIso(
            turn.toolStartedAt.get(toolCallId) ?? (yield* DateTime.now),
          ),
        });
        // Jobs whose end was never reported must not pile up across a long session.
        for (const staleJobId of state.ompAsyncJobs.keys()) {
          if (state.ompAsyncJobs.size <= 64) break;
          state.ompAsyncJobs.delete(staleJobId);
        }
        if (state.activeTurn?.waitingOnBackgroundJob === true) {
          yield* writeOmpAsyncJobRoster(state, Array.from(state.ompAsyncJobs.values()));
        }
      });

      const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = (record: PiRpcRecord, timeoutMs = PI_REQUEST_TIMEOUT_MS) =>
        connection.request(record, timeoutMs);

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      const rememberModelContextWindow = (model: unknown): number | null => {
        const provider = recordString(model, "provider");
        const id = recordString(model, "id");
        const capacity = nonNegativeInteger(model, "contextWindow");
        if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
          modelContextWindows.set(`${provider}/${id}`, capacity);
          return capacity;
        }
        return null;
      };

      const lifecycleRequest = (record: PiRpcRecord) =>
        request(record, PI_SESSION_TIMEOUT_MS).pipe(
          // A local timeout does not cancel Pi's lifecycle hook. Retire the
          // process before fallback can race its eventual switch/new-session.
          Effect.tapError((error) =>
            Effect.logWarning("Pi session lifecycle request failed", {
              providerSessionId: input.providerSessionId,
              operation: record["type"],
              errorTag: error._tag,
            }),
          ),
          Effect.catchTags({
            PiRpcTimeoutError: (error) =>
              connection.terminate.pipe(Effect.andThen(Effect.fail(error))),
          }),
          Effect.onInterrupt(() => connection.terminate),
        );

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;

        const totals = recordField(stats, "tokens");
        const inputTokens = nonNegativeInteger(totals, "input");
        const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
        const outputTokens = nonNegativeInteger(totals, "output");
        return {
          usedTokens,
          maxTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          updatedAt: DateTime.formatIso(updatedAt),
        };
      };

      /**
       * Pi only reports context usage through `get_session_stats`, so the
       * settled turn carries it on the base's per-turn `tokenUsage` (#8144).
       * Usage is secondary telemetry: the request is bounded and a provider
       * version without stats simply leaves the turn without a report, which
       * keeps the meter on the last turn that had one.
       */
      const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
        request({ type: "get_session_stats" }, 10_000).pipe(
          Effect.map((stats) => tokenUsageFromStats(stats, fallbackUsedTokens, updatedAt)),
          Effect.orElseSucceed(() => undefined),
        );

      /**
       * Pi attaches the current message's cumulative usage to every streaming
       * update (0.84.2+); OMP carries it on the update's message snapshot. Emit
       * it on the running turn only when the total changes, so the meter moves
       * live without a burst of no-op updates.
       */
      const reportLiveUsage = (turn: ActivePiTurn, usage: unknown) =>
        Effect.gen(function* () {
          const usedTokens = nonNegativeInteger(usage, "totalTokens");
          if (
            usedTokens === undefined ||
            usedTokens === 0 ||
            usedTokens === turn.lastLiveUsedTokens ||
            contextWindow === null ||
            contextWindow === 0
          ) {
            return;
          }
          turn.lastLiveUsedTokens = usedTokens;
          const inputTokens = nonNegativeInteger(usage, "input");
          const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
          const outputTokens = nonNegativeInteger(usage, "output");
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_turn.updated",
            driver,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              tokenUsage: {
                usedTokens,
                maxTokens: contextWindow,
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
                updatedAt: DateTime.formatIso(updatedAt),
              },
            },
          });
        });

      const baseItemFields = (
        turn: ActivePiTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc | null,
        updatedAt: DateTime.Utc,
        parentNativeItemId?: string,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId:
          parentNativeItemId === undefined
            ? null
            : idAllocator.derive.turnItemFromProviderItem({
                driver,
                nativeItemId: parentNativeItemId,
              }),
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActivePiTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc | null,
        completedAt: DateTime.Utc | null,
        parentNativeItemId?: string,
      ) =>
        emit({
          type: "node.updated",
          driver,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId:
              parentNativeItemId === undefined
                ? turn.turnInput.rootNodeId
                : idAllocator.derive.nodeFromProviderItem({
                    driver,
                    nativeItemId: parentNativeItemId,
                  }),
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitProviderRetry = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        providerRetry: PiProviderRetryState,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: makeProviderRetryTurnItem({
            idAllocator,
            driver,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: providerRetry.itemOrdinal,
            failure: providerRetry.failure,
            retry: providerRetry.retry,
            status,
            startedAt: providerRetry.startedAt,
            updatedAt,
          }),
        });
      });

      const compactionNativeItemId = (turn: ActivePiTurn): string =>
        `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

      const emitCompaction = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        compaction: PiCompactionState,
        status: PiCompactionStatus,
        details: {
          readonly summary?: string;
          readonly beforeTokenCount?: number;
          readonly afterTokenCount?: number;
        } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          compaction.nativeItemId,
          "system",
          status,
          compaction.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt,
            type: "compaction",
            driver,
            ...details,
          },
        });
      });

      // ── streaming text / reasoning ────────────────────────

      const emitStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, streaming: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          if (!streaming) {
            item.completedAt = emittedAt;
          }
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver,
                  nativeItemId: item.nativeItemId,
                }),
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush = (turn: ActivePiTurn, item: PiStreamItemState) =>
        Effect.gen(function* () {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        kind: PiStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: PiStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        // Ordinal reserved on first delta so items appear in stream order.
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActivePiTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      // ── tools ─────────────────────────────────────────────

      const hasSubagentJobDetails = (record: unknown): boolean => {
        if (record === null || typeof record !== "object") return false;
        const details = recordField(record, "details");
        return (
          Array.isArray(recordField(details, "jobs")) ||
          Array.isArray(recordField(record, "jobs")) ||
          Array.isArray(recordField(details, "results")) ||
          Array.isArray(recordField(record, "results")) ||
          Array.isArray(recordField(details, "progress")) ||
          Array.isArray(recordField(record, "progress"))
        );
      };

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        event: PiRpcRecord,
        phase: "preview" | "start" | "update" | "end" | "interrupt",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        if (toolCallId === undefined) return;
        const toolName =
          recordString(event, "toolName") ??
          turn.toolNames.get(toolCallId) ??
          turn.toolPreviews[toolCallId]?.toolName ??
          "tool";
        // Pi tags every phase of calls made through ctx.executeTool.
        const parentToolCallId = recordString(event, "parentToolCallId");
        turn.toolNames.set(toolCallId, toolName);
        if (phase === "preview" || phase === "start") {
          turn.toolArgs.set(toolCallId, event["args"]);
        }
        const startIntent = phase === "start" ? recordString(event, "intent") : undefined;
        if (startIntent !== undefined) turn.toolIntents.set(toolCallId, startIntent);
        const preview = turn.toolPreviews[toolCallId];
        if (preview !== undefined && phase !== "preview") preview.executing = true;
        const args = event["args"] ?? turn.toolArgs.get(toolCallId);
        const emittedAt = yield* DateTime.now;
        const startedAt =
          phase === "preview"
            ? null
            : (turn.toolStartedAt.get(toolCallId) ?? (phase === "start" ? emittedAt : null));
        if (phase === "start" && startedAt !== null) {
          turn.toolStartedAt.set(toolCallId, startedAt);
        }
        const completed = phase === "end";
        const interrupted = phase === "interrupt";
        const terminal = completed || interrupted;
        if (
          driver === "omp" &&
          threadState !== null &&
          phase !== "preview" &&
          phase !== "start" &&
          phase !== "interrupt"
        ) {
          yield* trackOmpAsyncJob(
            threadState,
            turn,
            toolCallId,
            args,
            completed ? event["result"] : event["partialResult"],
          );
        }
        if (turn.endedTools[toolCallId] === true && !completed) {
          if (
            toolName === "subagent" ||
            toolName === "task" ||
            toolName === "wait" ||
            hasSubagentJobDetails(event["partialResult"])
          ) {
            yield* emitSubagentTasks(turn, toolCallId, event["partialResult"], false, args);
          }
          return;
        }
        if (terminal) turn.endedTools[toolCallId] = true;
        turn.emittedToolCalls.add(toolCallId);
        const isError = event["isError"] === true;
        const resultRecord = interrupted
          ? undefined
          : completed
            ? event["result"]
            : event["partialResult"];
        const outputText = contentText(recordField(resultRecord, "content"));
        // A Stop aborts in-flight tools, and pi reports those as error ends.
        // Present them as interrupted (matching the run) rather than failed.
        const status = interrupted
          ? "interrupted"
          : completed
            ? isError
              ? turn.interrupted
                ? "interrupted"
                : "failed"
              : "completed"
            : startedAt === null
              ? "pending"
              : "running";
        const base = baseItemFields(turn, toolCallId, startedAt, emittedAt, parentToolCallId);
        yield* emitItemNode(
          turn,
          toolCallId,
          "tool_call",
          status,
          startedAt,
          terminal ? emittedAt : null,
          parentToolCallId,
        );
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...base,
            status,
            completedAt: terminal ? emittedAt : null,
            ...piToolTurnItemFields({
              toolName,
              args,
              outputText,
              details: recordField(resultRecord, "details"),
              isError,
              intent: turn.toolIntents.get(toolCallId),
            }),
          },
        });
        if (
          (toolName === "subagent" ||
            toolName === "task" ||
            toolName === "wait" ||
            hasSubagentJobDetails(resultRecord)) &&
          phase !== "preview"
        ) {
          yield* emitSubagentTasks(turn, toolCallId, resultRecord, completed, args);
        }
      });

      const emitToolResultMessages = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        messages: unknown,
      ) {
        if (!Array.isArray(messages)) return;
        for (const message of messages) {
          if (recordString(message, "role") !== "toolResult") continue;
          const toolCallId = recordString(message, "toolCallId");
          if (toolCallId === undefined) continue;
          yield* emitToolItem(
            turn,
            {
              toolCallId,
              toolName: recordString(message, "toolName"),
              args: turn.toolArgs.get(toolCallId),
              result: message,
              isError: recordField(message, "isError") === true,
            },
            "end",
          );
        }
      });

      /**
       * Observe the result shape from Pi's official example subagent extension.
       * The extension runs children with --no-session, so these entries are
       * visible in T3's shared subagent UI without inventing a child thread.
       * Unknown or changed result shapes stay ordinary dynamic tool output.
       */
      const emitSubagentRecord = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        record: unknown,
        emittedAt: DateTime.Utc,
        defaultIndex?: number | undefined,
        completedHint = false,
      ) {
        const explicitJobId = recordString(record, "jobId");
        const rawId = recordString(record, "id");
        const rawJobId = explicitJobId ?? rawId;
        const runId = recordString(record, "runId");
        const displayLabel = recordString(record, "displayLabel") ?? recordString(record, "label");
        const label = displayLabel ?? recordString(record, "agent");
        let activationId: string | undefined;
        if (explicitJobId !== undefined) {
          activationId = explicitJobId;
        } else if (rawId !== undefined && label !== undefined && rawId !== label) {
          activationId = rawId;
        } else if (
          rawId !== undefined &&
          label !== undefined &&
          rawId === label &&
          runId !== undefined &&
          runId !== rawId
        ) {
          activationId = runId;
        } else {
          activationId = runId ?? rawJobId;
        }
        const agentType = recordString(record, "agentType") ?? recordString(record, "agent");
        const reportedParentToolCallId = recordString(record, "parentToolCallId");
        const parentToolCallId =
          reportedParentToolCallId !== undefined && reportedParentToolCallId.length > 0
            ? reportedParentToolCallId
            : toolCallId;
        const explicitIndex = recordNumber(record, "index") ?? recordNumber(record, "step");

        let nativeTaskId: string | undefined = undefined;
        if (rawJobId !== undefined && turn.subagentLive[rawJobId]?.nativeTaskId !== undefined) {
          nativeTaskId = turn.subagentLive[rawJobId].nativeTaskId;
        } else if (runId !== undefined && turn.subagentLive[runId]?.nativeTaskId !== undefined) {
          nativeTaskId = turn.subagentLive[runId].nativeTaskId;
        }
        if (nativeTaskId === undefined && explicitIndex === undefined && label !== undefined) {
          const previousTaskId = turn.subagentLive[label]?.nativeTaskId;
          const previousItem =
            previousTaskId === undefined ? undefined : turn.subagentItems[previousTaskId];
          if (
            previousTaskId !== undefined &&
            previousItem !== undefined &&
            !isOrchestrationV2WorkActive(previousItem.status) &&
            turn.subagentActivations[previousTaskId]?.seenActivationIds.has(label)
          ) {
            nativeTaskId = previousTaskId;
          }
        }
        if (nativeTaskId === undefined) {
          if (explicitIndex !== undefined) {
            nativeTaskId = `${parentToolCallId}:subagent:${explicitIndex}`;
          } else if (rawJobId !== undefined && rawJobId.length > 0) {
            nativeTaskId = `${parentToolCallId}:subagent:${rawJobId}`;
          } else if (runId !== undefined && runId.length > 0) {
            nativeTaskId = `${parentToolCallId}:subagent:${runId}`;
          } else if (defaultIndex !== undefined) {
            nativeTaskId = `${parentToolCallId}:subagent:${defaultIndex}`;
          } else if (label !== undefined && label.length > 0) {
            nativeTaskId = `${parentToolCallId}:subagent:${label}`;
          } else {
            return;
          }
        }

        if (rawJobId !== undefined) {
          (turn.subagentLive[rawJobId] ??= newPiSubagentLiveState()).nativeTaskId = nativeTaskId;
        }
        if (runId !== undefined) {
          (turn.subagentLive[runId] ??= newPiSubagentLiveState()).nativeTaskId = nativeTaskId;
        }
        if (rawJobId === undefined && runId === undefined && label !== undefined) {
          (turn.subagentLive[label] ??= newPiSubagentLiveState()).nativeTaskId = nativeTaskId;
        }
        const sessionFile =
          recordString(record, "sessionFile") ?? recordString(record, "transcriptFile");
        if (sessionFile !== undefined) {
          const liveKey = rawJobId ?? label ?? nativeTaskId;
          (turn.subagentLive[liveKey] ??= newPiSubagentLiveState()).transcriptFile = sessionFile;
        }

        const activation = (turn.subagentActivations[nativeTaskId] ??= {
          seenActivationIds: new Set<string>(),
          terminalActivationIds: new Set<string>(),
        });

        const statusStr = recordString(record, "status")?.toLowerCase();
        const existingItem = turn.subagentItems[nativeTaskId];
        const nativeAgentId =
          recordString(record, "nativeAgentId") ??
          recordString(record, "jobId") ??
          recordString(record, "id") ??
          existingItem?.nativeAgentId;
        const taskIndex = explicitIndex ?? defaultIndex;
        const indexedPrefix = taskIndex === undefined ? undefined : `${taskIndex}-`;
        const nativeAgentName =
          nativeAgentId !== undefined &&
          indexedPrefix !== undefined &&
          nativeAgentId.startsWith(indexedPrefix) &&
          nativeAgentId.length > indexedPrefix.length
            ? nativeAgentId.slice(indexedPrefix.length)
            : undefined;
        const stableName =
          nativeAgentId !== undefined &&
          existingItem !== undefined &&
          (nativeAgentId === existingItem.nativeAgentId || displayLabel === existingItem.title)
            ? existingItem.title
            : undefined;
        const displayTitle =
          nativeAgentName ??
          stableName ??
          nativeAgentId ??
          existingItem?.title ??
          label ??
          agentType ??
          "subagent";
        const taskArguments = turn.toolArgs.get(parentToolCallId);
        const taskItems = recordField(taskArguments, "tasks");
        const taskFromParentArgs =
          Array.isArray(taskItems) && taskIndex !== undefined
            ? recordString(taskItems[taskIndex], "task")
            : recordString(taskArguments, "task");
        const live =
          (rawJobId !== undefined ? turn.subagentLive[rawJobId] : undefined) ??
          (label !== undefined ? turn.subagentLive[label] : undefined) ??
          (agentType !== undefined ? turn.subagentLive[agentType] : undefined) ??
          (turn.subagentLive[nativeTaskId] ??= newPiSubagentLiveState());
        const reportedModel =
          recordString(record, "resolvedModel") ?? recordString(record, "model");
        if (reportedModel !== undefined) live.model = reportedModel;
        const model = reportedModel ?? live.model ?? null;
        const currentToolRecord = recordField(record, "currentTool");
        const currentToolName = recordString(currentToolRecord, "name");
        const currentToolArgs = recordString(currentToolRecord, "argsPreview");
        const currentToolIntent = recordString(currentToolRecord, "intent");
        const currentToolElapsedMs = parseRecordDurationMs(currentToolRecord, "elapsedMs");
        const currentTool =
          currentToolRecord === null
            ? null
            : currentToolName === undefined
              ? undefined
              : {
                  name: currentToolName,
                  ...(currentToolIntent === undefined ? {} : { intent: currentToolIntent }),
                  ...(currentToolArgs === undefined
                    ? {}
                    : {
                        argsPreview: currentToolArgs.slice(0, OMP_SUBAGENT_ARGS_PREVIEW_MAX_LENGTH),
                      }),
                  ...(currentToolElapsedMs === undefined
                    ? {}
                    : { elapsedMs: currentToolElapsedMs }),
                };
        const completionPercent = recordNumber(record, "completionPercent");
        const retryRecord = recordField(record, "retry");
        const retryAttempt = recordNumber(retryRecord, "attempt");
        const retryDelayMs = parseRecordDurationMs(retryRecord, "delayMs");
        const retryMessage = recordString(retryRecord, "message");
        const retry =
          retryRecord === null
            ? null
            : retryAttempt === undefined || !Number.isInteger(retryAttempt) || retryAttempt < 0
              ? undefined
              : {
                  attempt: retryAttempt,
                  ...(retryDelayMs === undefined ? {} : { delayMs: retryDelayMs }),
                  ...(retryMessage === undefined ? {} : { message: retryMessage }),
                };
        const nativeStartedAt =
          parseRecordDateTime(record, "startedAt", "startTime", "createdAt") ??
          parseRecordDateTime(
            recordField(record, "metadata"),
            "startedAt",
            "startTime",
            "createdAt",
          ) ??
          parseRecordDateTime(record, "timestamp");
        const nativeCompletedAt =
          parseRecordDateTime(record, "completedAt", "endTime", "finishedAt") ??
          parseRecordDateTime(
            recordField(record, "metadata"),
            "completedAt",
            "endTime",
            "finishedAt",
          );
        const durationMs =
          parseRecordDurationMs(record, "durationMs", "duration_ms", "duration", "elapsed") ??
          parseRecordDurationMs(
            recordField(record, "usage"),
            "duration_ms",
            "durationMs",
            "duration",
          );
        const reportedDuration = durationMs === undefined ? undefined : Duration.millis(durationMs);

        let isNewActivation = false;
        if (activationId !== undefined) {
          if (!activation.seenActivationIds.has(activationId)) {
            activation.seenActivationIds.add(activationId);
            isNewActivation = activation.seenActivationIds.size > 1;
            activation.currentActivationId = activationId;
          }
        }

        const isNativeTerminal =
          recordField(record, "finished") === true ||
          (statusStr !== undefined &&
            (PI_SUBAGENT_FINISHED_STATUSES[statusStr] === true ||
              statusStr === "interrupted" ||
              statusStr === "cancelled" ||
              statusStr === "aborted")) ||
          (!isNewActivation && completedHint);
        if (isNativeTerminal && existingItem !== undefined) {
          yield* clearTurnSubagentPreview(turn, nativeTaskId, existingItem);
        }
        const metricRecord =
          recordField(record, "metrics") ?? recordField(record, "progress") ?? record;
        const reportedMetrics = nativeSubagentMetrics(
          metricRecord,
          isNativeTerminal ? record : undefined,
        );
        const previousMetrics = isNewActivation ? undefined : existingItem?.metrics;
        const metrics =
          previousMetrics === undefined && reportedMetrics === undefined
            ? undefined
            : { ...(previousMetrics ?? {}), ...(reportedMetrics ?? {}) };
        const resolvedAgentType =
          agentType ?? (isNewActivation ? undefined : existingItem?.agentType);
        const resolvedCurrentTool =
          currentTool !== undefined
            ? currentTool
            : isNewActivation
              ? undefined
              : existingItem?.currentTool;
        const hasReportedPercent =
          completionPercent !== undefined && completionPercent >= 0 && completionPercent <= 100;
        const resolvedCompletionPercent = hasReportedPercent
          ? completionPercent
          : isNewActivation
            ? undefined
            : existingItem?.completionPercent;
        const resolvedRetry =
          retry !== undefined ? retry : isNewActivation ? undefined : existingItem?.retry;
        const nativeTaskPresentation = {
          ...(nativeAgentId === undefined ? {} : { nativeAgentId }),
          ...(resolvedAgentType === undefined ? {} : { agentType: resolvedAgentType }),
          ...(resolvedCurrentTool === undefined ? {} : { currentTool: resolvedCurrentTool }),
          ...(resolvedCompletionPercent === undefined
            ? {}
            : { completionPercent: resolvedCompletionPercent }),
          ...(resolvedRetry === undefined ? {} : { retry: resolvedRetry }),
          ...(metrics === undefined ? {} : { metrics }),
        };
        const parentItemId =
          parentToolCallId.length > 0
            ? idAllocator.derive.turnItemFromProviderItem({
                driver,
                nativeItemId: parentToolCallId,
              })
            : isNewActivation
              ? null
              : (existingItem?.parentItemId ?? null);

        if (activationId !== undefined) {
          if (activation.terminalActivationIds.has(activationId)) {
            if (activation.currentActivationId !== activationId) {
              return;
            }
            if (!isNativeTerminal) {
              return;
            }
            const metricsChanged =
              existingItem?.metrics?.toolCount !== metrics?.toolCount ||
              existingItem?.metrics?.requests !== metrics?.requests ||
              existingItem?.metrics?.tokens !== metrics?.tokens ||
              existingItem?.metrics?.contextTokens !== metrics?.contextTokens ||
              existingItem?.metrics?.contextWindow !== metrics?.contextWindow ||
              existingItem?.metrics?.cost !== metrics?.cost;
            const hasReportedTiming =
              nativeStartedAt !== undefined ||
              nativeCompletedAt !== undefined ||
              reportedDuration !== undefined;
            if (existingItem !== undefined && (hasReportedTiming || metricsChanged)) {
              const startedAt = hasReportedTiming
                ? (nativeStartedAt ??
                  (nativeCompletedAt !== undefined && reportedDuration !== undefined
                    ? DateTime.subtractDuration(nativeCompletedAt, reportedDuration)
                    : (existingItem.startedAt ??
                      (reportedDuration === undefined
                        ? null
                        : DateTime.subtractDuration(
                            existingItem.completedAt ?? emittedAt,
                            reportedDuration,
                          )))))
                : existingItem.startedAt;
              const completedAt = hasReportedTiming
                ? (nativeCompletedAt ??
                  (reportedDuration !== undefined && startedAt !== null
                    ? DateTime.addDuration(startedAt, reportedDuration)
                    : (existingItem.completedAt ?? emittedAt)))
                : existingItem.completedAt;
              const currentDurationMs =
                existingItem.completedAt !== null && existingItem.startedAt !== null
                  ? DateTime.toEpochMillis(existingItem.completedAt) -
                    DateTime.toEpochMillis(existingItem.startedAt)
                  : undefined;
              const durationChanged =
                reportedDuration !== undefined && currentDurationMs !== durationMs;
              const terminalTimeChanged =
                hasReportedTiming &&
                (existingItem.completedAt === null ||
                  completedAt === null ||
                  DateTime.toEpochMillis(existingItem.completedAt) !==
                    DateTime.toEpochMillis(completedAt));
              const startTimeChanged =
                hasReportedTiming &&
                (existingItem.startedAt === null
                  ? startedAt !== null
                  : startedAt === null ||
                    DateTime.toEpochMillis(existingItem.startedAt) !==
                      DateTime.toEpochMillis(startedAt));
              const parentItemChanged = parentItemId !== existingItem.parentItemId;
              if (
                durationChanged ||
                terminalTimeChanged ||
                startTimeChanged ||
                metricsChanged ||
                parentItemChanged
              ) {
                if (startedAt === null) {
                  turn.toolStartedAt.delete(nativeTaskId);
                } else {
                  turn.toolStartedAt.set(nativeTaskId, startedAt);
                }
                const turnItem: PiSubagentTurnItem = {
                  ...existingItem,
                  title: displayTitle,
                  parentItemId,
                  ...nativeTaskPresentation,
                  startedAt,
                  completedAt,
                  updatedAt: completedAt ?? emittedAt,
                };
                turn.subagentItems[nativeTaskId] = turnItem;
                const parentNodeId = idAllocator.derive.nodeFromProviderItem({
                  driver,
                  nativeItemId: nativeTaskId.includes(":subagent:")
                    ? nativeTaskId.slice(0, nativeTaskId.lastIndexOf(":subagent:"))
                    : toolCallId,
                });
                yield* emit({
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    id: existingItem.subagentId,
                    threadId: turn.turnInput.threadId,
                    runId: turn.turnInput.runId,
                    parentNodeId,
                    origin: "provider_native",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: options.instanceId,
                    providerThreadId: turn.turnInput.providerThread.id,
                    childThreadId: null,
                    nativeTaskRef: providerRef(nativeTaskId),
                    prompt: existingItem.prompt,
                    title: displayTitle,
                    model,
                    status: existingItem.status,
                    ...nativeTaskPresentation,
                    result: existingItem.result,
                    startedAt,
                    completedAt,
                    updatedAt: completedAt ?? emittedAt,
                  },
                });
                yield* emit({ type: "turn_item.updated", driver, turnItem });
              }
            }
            return;
          }
          if (
            activation.seenActivationIds.has(activationId) &&
            activation.currentActivationId !== activationId
          ) {
            return;
          }
        }

        const stopReason = recordString(record, "stopReason")?.toLowerCase() ?? statusStr;
        const interrupted =
          isNativeTerminal &&
          (stopReason === "aborted" || stopReason === "cancelled" || stopReason === "interrupted");
        const failed =
          isNativeTerminal &&
          !interrupted &&
          ((recordNumber(record, "exitCode") ?? 0) !== 0 ||
            stopReason === "error" ||
            stopReason === "failed");

        let status: "pending" | "running" | "completed" | "failed" | "interrupted";
        if (isNativeTerminal) {
          status = interrupted ? "interrupted" : failed ? "failed" : "completed";
          if (activationId !== undefined) {
            activation.terminalActivationIds.add(activationId);
          }
        } else if (
          !isNewActivation &&
          existingItem !== undefined &&
          !isOrchestrationV2WorkActive(existingItem.status)
        ) {
          status =
            existingItem.status === "cancelled"
              ? "interrupted"
              : existingItem.status === "completed" ||
                  existingItem.status === "failed" ||
                  existingItem.status === "interrupted"
                ? existingItem.status
                : "running";
        } else if (statusStr === "pending") {
          status = "pending";
        } else {
          status = "running";
        }

        let startedAt: DateTime.Utc | null;
        if (
          !isNewActivation &&
          existingItem !== undefined &&
          existingItem.nativeAgentId !== undefined &&
          existingItem.status !== "pending" &&
          existingItem.startedAt !== null
        ) {
          startedAt = existingItem.startedAt;
        } else if (status === "pending") {
          startedAt = null;
        } else if (nativeStartedAt !== undefined) {
          startedAt = nativeStartedAt;
        } else if (nativeCompletedAt !== undefined && reportedDuration !== undefined) {
          startedAt = DateTime.subtractDuration(nativeCompletedAt, reportedDuration);
        } else if (reportedDuration !== undefined) {
          startedAt = DateTime.subtractDuration(emittedAt, reportedDuration);
        } else if (!isNewActivation && turn.toolStartedAt.has(nativeTaskId)) {
          startedAt = turn.toolStartedAt.get(nativeTaskId) ?? null;
        } else {
          startedAt = status === "running" && !isNewActivation ? emittedAt : null;
        }
        if (startedAt === null) {
          turn.toolStartedAt.delete(nativeTaskId);
        } else {
          turn.toolStartedAt.set(nativeTaskId, startedAt);
        }

        const derivedCompletedAt =
          reportedDuration !== undefined && startedAt !== null
            ? DateTime.addDuration(startedAt, reportedDuration)
            : undefined;

        let completedAt: DateTime.Utc | null;
        if (status === "completed" || status === "failed" || status === "interrupted") {
          completedAt =
            nativeCompletedAt ??
            derivedCompletedAt ??
            (isNewActivation ? undefined : existingItem?.completedAt) ??
            emittedAt;
        } else {
          completedAt = null;
        }

        const task =
          recordString(record, "task") ??
          recordString(record, "prompt") ??
          taskFromParentArgs ??
          recordString(record, "assignment") ??
          existingItem?.prompt ??
          (recordField(record, "displayLabel") !== undefined
            ? undefined
            : (recordString(record, "description") ?? recordString(record, "label"))) ??
          "";

        const outputText =
          recordString(record, "resultText") ??
          recordString(record, "output") ??
          recordString(record, "summary") ??
          recordString(record, "result") ??
          recordString(recordField(record, "result"), "content") ??
          piSubagentOutput(record);

        const progress =
          status === "running" && outputText.length > 0
            ? { progress: outputText.slice(0, 200) }
            : {};

        const resultText =
          status === "completed" || status === "failed" || status === "interrupted"
            ? outputText.length > 0
              ? outputText.slice(0, 10_000)
              : isNewActivation
                ? null
                : (existingItem?.result ?? null)
            : null;

        const subagentId =
          existingItem?.subagentId ??
          idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeTaskId });
        const parentNodeId = idAllocator.derive.nodeFromProviderItem({
          driver,
          nativeItemId: nativeTaskId.includes(":subagent:")
            ? nativeTaskId.slice(0, nativeTaskId.lastIndexOf(":subagent:"))
            : toolCallId,
        });

        const turnItem: PiSubagentTurnItem = {
          ...baseItemFields(turn, nativeTaskId, startedAt, emittedAt),
          parentItemId,
          status,
          title: displayTitle,
          model,
          completedAt,
          updatedAt: completedAt ?? emittedAt,
          type: "subagent",
          subagentId,
          origin: "provider_native",
          driver,
          providerInstanceId: options.instanceId,
          childThreadId: null,
          prompt: task,
          ...nativeTaskPresentation,
          result: resultText,
          ...progress,
          ...(live?.transcriptFile === undefined ? {} : { transcriptFile: live.transcriptFile }),
        };
        turn.subagentItems[nativeTaskId] = turnItem;
        if (!isOrchestrationV2WorkActive(status)) {
          yield* clearTurnSubagentPreview(turn, nativeTaskId, turnItem);
        }

        yield* emit({
          type: "subagent.updated",
          driver,
          subagent: {
            id: subagentId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: options.instanceId,
            providerThreadId: turn.turnInput.providerThread.id,
            childThreadId: null,
            nativeTaskRef: providerRef(nativeTaskId),
            prompt: task,
            title: displayTitle,
            model,
            status,
            ...nativeTaskPresentation,
            ...progress,
            result: resultText,
            startedAt,
            completedAt,
            updatedAt: completedAt ?? emittedAt,
          },
        });
        yield* emit({ type: "turn_item.updated", driver, turnItem });
      });

      const emitSubagentTasks = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        resultRecord: unknown,
        completed: boolean,
        args?: unknown,
      ) {
        const details = recordField(resultRecord, "details");
        const jobs = recordField(details, "jobs") ?? recordField(resultRecord, "jobs");
        let results: ReadonlyArray<unknown> | undefined =
          Array.isArray(jobs) && jobs.length > 0 ? jobs : undefined;
        if (!Array.isArray(results)) {
          const cand =
            recordField(details, "results") ??
            recordField(resultRecord, "results") ??
            recordField(details, "reports") ??
            recordField(resultRecord, "reports") ??
            (Array.isArray(resultRecord) ? resultRecord : undefined);
          results = Array.isArray(cand) ? cand : undefined;
          const progressEntries =
            recordField(details, "progress") ?? recordField(resultRecord, "progress");
          if (
            !completed &&
            Array.isArray(progressEntries) &&
            progressEntries.length > 0 &&
            (!Array.isArray(results) || results.length === 0)
          ) {
            results = progressEntries;
          }
          if (!Array.isArray(results) && args !== undefined) {
            const tasks = recordField(args, "tasks");
            if (Array.isArray(tasks)) {
              results = tasks.map((t) =>
                typeof t === "object" && t !== null ? { ...t, finished: false } : t,
              );
            }
          }
        }
        if (!Array.isArray(results)) return;
        const isAsyncJob =
          recordField(details, "async") !== undefined ||
          recordField(resultRecord, "async") !== undefined ||
          Array.isArray(jobs);
        const taskCompleted = completed && !isAsyncJob;
        const emittedAt = yield* DateTime.now;
        for (const [index, result] of results.entries()) {
          if (result === null || typeof result !== "object") continue;
          // Coordination snapshots also include shell/REPL jobs, not just agents.
          const jobType = recordString(result, "type");
          if (Array.isArray(jobs) && jobType !== undefined && jobType !== "task") continue;
          const explicitParent = recordString(result, "parentToolCallId");
          const rawJobId = recordString(result, "id") ?? recordString(result, "jobId");
          const runId = recordString(result, "runId");
          const label = recordString(result, "label") ?? recordString(result, "agent");

          let targetTurn: ActivePiTurn | null = null;
          if (explicitParent !== undefined && explicitParent.length > 0) {
            targetTurn = findOwningTurn(threadState, {
              parentToolCallId: explicitParent,
              jobId: rawJobId,
              runId,
              label,
            });
          }

          if (targetTurn === null && rawJobId !== undefined && rawJobId.length > 0) {
            targetTurn = findOwningTurn(
              threadState,
              {
                jobId: rawJobId,
                runId,
                label,
              },
              turn,
            );
          }

          const owningTurn = targetTurn ?? turn;

          let effectiveToolCallId = explicitParent;
          if (effectiveToolCallId === undefined && rawJobId !== undefined) {
            const recordedNativeId = owningTurn.subagentLive[rawJobId]?.nativeTaskId;
            if (recordedNativeId !== undefined && recordedNativeId.includes(":subagent:")) {
              effectiveToolCallId = recordedNativeId.slice(
                0,
                recordedNativeId.indexOf(":subagent:"),
              );
            }
          }
          if (effectiveToolCallId === undefined) {
            effectiveToolCallId = toolCallId;
          }

          yield* emitSubagentRecord(
            owningTurn,
            effectiveToolCallId,
            result,
            emittedAt,
            Array.isArray(jobs)
              ? (recordNumber(result, "index") ?? recordNumber(result, "step"))
              : (recordNumber(result, "index") ?? recordNumber(result, "step") ?? index),
            taskCompleted,
          );
          pruneFinishedTurnIfIdle(threadState, owningTurn);
        }
        if (
          turn.settleWhenIdle &&
          !Object.values(turn.subagentItems).some((item) =>
            isOrchestrationV2WorkActive(item.status),
          )
        ) {
          yield* scheduleSettleProbe(turn, true);
        }
      });

      /** Re-sends a running subagent item when its transcript file changes. */
      const emitSubagentLive = (turn: ActivePiTurn, live: PiSubagentLiveState) =>
        Effect.gen(function* () {
          live.flushScheduled = false;
          const nativeTaskId = live.nativeTaskId;
          const item = nativeTaskId === undefined ? undefined : turn.subagentItems[nativeTaskId];
          if (
            nativeTaskId === undefined ||
            item === undefined ||
            item.status !== "running" ||
            threadState?.activeTurn !== turn
          ) {
            return;
          }
          const turnItem: PiSubagentTurnItem = {
            ...item,
            updatedAt: yield* DateTime.now,
            ...(live.transcriptFile === undefined ? {} : { transcriptFile: live.transcriptFile }),
          };
          turn.subagentItems[nativeTaskId] = turnItem;
          yield* emit({ type: "turn_item.updated", driver, turnItem });
        });

      const scheduleSubagentLive = (turn: ActivePiTurn, live: PiSubagentLiveState) =>
        Effect.gen(function* () {
          if (live.flushScheduled) return;
          live.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(Effect.suspend(() => emitSubagentLive(turn, live))),
            Effect.forkIn(scope),
          );
        });
      const publishSubagentLivePreview = (turn: ActivePiTurn, live: PiSubagentLiveState) =>
        Effect.gen(function* () {
          live.overlayFlushScheduled = false;
          const nativeTaskId = live.nativeTaskId;
          const item = nativeTaskId === undefined ? undefined : turn.subagentItems[nativeTaskId];
          if (item === undefined || item.status !== "running" || live.liveContent === undefined) {
            return;
          }
          live.lastOverlayPublishedAt = yield* Clock.currentTimeMillis;
          yield* options.threadLiveOverlay.publish(turn.turnInput.threadId, {
            kind: "subagent-live",
            turnItemId: item.id,
            subagentId: item.subagentId,
            liveContent: live.liveContent,
          });
        });

      const scheduleSubagentLivePreview = (turn: ActivePiTurn, live: PiSubagentLiveState) =>
        Effect.gen(function* () {
          if (live.overlayFlushScheduled) return;
          const now = yield* Clock.currentTimeMillis;
          const waitMs =
            live.lastOverlayPublishedAt === undefined
              ? 0
              : Math.max(0, 100 - (now - live.lastOverlayPublishedAt));
          if (waitMs === 0) return yield* publishSubagentLivePreview(turn, live);
          live.overlayFlushScheduled = true;
          yield* Effect.sleep(Duration.millis(waitMs)).pipe(
            Effect.andThen(Effect.suspend(() => publishSubagentLivePreview(turn, live))),
            Effect.forkIn(scope),
          );
        });

      const clearTurnSubagentPreview = (
        turn: ActivePiTurn,
        nativeTaskId: string,
        item = turn.subagentItems[nativeTaskId],
      ) =>
        Effect.gen(function* () {
          let hadContent = false;
          for (const live of Object.values(turn.subagentLive)) {
            if (live.nativeTaskId !== nativeTaskId || live.liveContent === undefined) continue;
            live.liveContent = undefined;
            hadContent = true;
          }
          if (!hadContent || item === undefined) return;
          yield* options.threadLiveOverlay.publish(turn.turnInput.threadId, {
            kind: "subagent-live",
            turnItemId: item.id,
            subagentId: item.subagentId,
            liveContent: null,
          });
        });

      const clearSessionSubagentPreviews = Effect.fnUntraced(function* () {
        const state = threadState;
        if (state === null) return;
        const turns = new Set<ActivePiTurn>();
        if (state.activeTurn !== null) turns.add(state.activeTurn);
        if (state.lastFinalizedTurn !== undefined) turns.add(state.lastFinalizedTurn);
        for (const turn of state.finishedTurnsWithActiveChildren ?? []) turns.add(turn);
        const published = new Set<string>();
        for (const turn of turns) {
          for (const live of Object.values(turn.subagentLive)) {
            if (live.liveContent === undefined) continue;
            live.liveContent = undefined;
            const item =
              live.nativeTaskId === undefined ? undefined : turn.subagentItems[live.nativeTaskId];
            if (item === undefined || published.has(item.id)) continue;
            published.add(item.id);
            yield* options.threadLiveOverlay.publish(turn.turnInput.threadId, {
              kind: "subagent-live",
              turnItemId: item.id,
              subagentId: item.subagentId,
              liveContent: null,
            });
          }
        }
      });

      const republishSessionSubagentPreviews = Effect.fnUntraced(function* () {
        const state = threadState;
        if (state === null) return;
        const turns = new Set<ActivePiTurn>();
        if (state.activeTurn !== null) turns.add(state.activeTurn);
        if (state.lastFinalizedTurn !== undefined) turns.add(state.lastFinalizedTurn);
        for (const turn of state.finishedTurnsWithActiveChildren ?? []) turns.add(turn);
        for (const turn of turns) {
          for (const live of Object.values(turn.subagentLive)) {
            if (live.liveContent !== undefined) yield* scheduleSubagentLivePreview(turn, live);
          }
        }
      });
      const transitionSubagentSubscriptionMode = Effect.fnUntraced(function* (
        publishCurrentState = false,
      ) {
        if (driver !== "omp") return;
        const now = yield* Clock.currentTimeMillis;
        const rateLimited = subagentRateLimitedUntil !== null && now < subagentRateLimitedUntil;
        if (subagentRateLimitedUntil !== null && !rateLimited) subagentRateLimitedUntil = null;
        const nextLevel = currentSubagentViewer && !rateLimited ? "events" : "progress";
        const reason = rateLimited ? "rate-limited" : currentSubagentViewer ? "viewing" : "idle";
        const levelChanged = desiredSubagentSubscriptionLevel !== nextLevel;
        const reasonChanged = currentSubagentModeReason !== reason;
        if (levelChanged) {
          desiredSubagentSubscriptionLevel = nextLevel;
          if (nextLevel === "progress") yield* clearSessionSubagentPreviews();
          yield* requestSubagentSubscription(nextLevel);
          if (nextLevel === "events") yield* republishSessionSubagentPreviews();
        }
        if (levelChanged || reasonChanged || publishCurrentState) {
          currentSubagentModeReason = reason;
          yield* options.threadLiveOverlay.publish(input.threadId, {
            kind: "live-mode",
            mode: nextLevel,
            reason,
          });
        }
      });

      const updateSubagentViewing = (viewed: boolean) =>
        subagentModePermit.withPermits(1)(
          Effect.gen(function* () {
            const newlyViewed = viewed && !currentSubagentViewer;
            currentSubagentViewer = viewed;
            yield* transitionSubagentSubscriptionMode(newlyViewed);
          }),
        );

      const waitForSubagentRateLimit = (generation: number) =>
        Effect.sleep(Duration.seconds(60)).pipe(
          Effect.andThen(
            subagentModePermit.withPermits(1)(
              Effect.gen(function* () {
                if (generation !== subagentGuardGeneration) return;
                const now = yield* Clock.currentTimeMillis;
                if (subagentRateLimitedUntil === null || now < subagentRateLimitedUntil) return;
                subagentRateLimitedUntil = null;
                yield* transitionSubagentSubscriptionMode();
              }),
            ),
          ),
          Effect.forkIn(scope),
        );

      const activateSubagentRateLimit = () =>
        subagentModePermit.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (subagentRateLimitedUntil !== null && now < subagentRateLimitedUntil) return;
            subagentRateLimitedUntil = now + 60_000;
            const generation = ++subagentGuardGeneration;
            yield* transitionSubagentSubscriptionMode();
            yield* waitForSubagentRateLimit(generation);
          }),
        );

      /** Shows a tool call while the model is still writing its arguments. */
      const emitToolPreview = (turn: ActivePiTurn, toolCallId: string) =>
        Effect.suspend(() => {
          const preview = turn.toolPreviews[toolCallId];
          if (preview === undefined) return Effect.void;
          preview.flushScheduled = false;
          if (preview.executing || threadState?.activeTurn !== turn) return Effect.void;
          return emitToolItem(
            turn,
            { toolCallId, toolName: preview.toolName, args: preview.args },
            "preview",
          );
        });

      const scheduleToolPreview = (turn: ActivePiTurn, toolCallId: string) =>
        Effect.gen(function* () {
          const preview = turn.toolPreviews[toolCallId];
          if (preview === undefined || preview.flushScheduled) return;
          preview.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(emitToolPreview(turn, toolCallId)),
            Effect.forkIn(scope),
          );
        });

      // ── extension UI prompts ──────────────────────────────

      const cancelPrompt = (pending: PendingPiPrompt, resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          yield* connection
            .send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              cancelled: true,
            })
            .pipe(Effect.ignore);
          pending.runtimeRequest = {
            ...pending.runtimeRequest,
            status: "cancelled",
            resolvedAt,
          };
          yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId: pending.node.threadId,
            runtimeRequest: pending.runtimeRequest,
          });
          yield* emit({
            type: "node.updated",
            driver,
            node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
          });
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...pending.turnItem,
              status: "cancelled",
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        });

      const cancelPendingPrompts = (resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const pending = Array.from(pendingPrompts.values());
          pendingPrompts.clear();
          yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
            discard: true,
          });
        });

      const emitSystemNotice = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        nativeItemId: string,
        message: string,
      ) {
        const emittedAt = yield* DateTime.now;
        yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "completed",
            completedAt: emittedAt,
            title: null,
            type: "system_notice",
            message,
          },
        });
      });

      // Abort leaves queued steers and follow-ups for Pi's next prompt, and
      // Pi may start them as soon as abort lands, so clear them first.
      const clearNativeQueue = Effect.fnUntraced(function* (turn: ActivePiTurn) {
        const cleared = yield* request({ type: "clear_queue" }, 2_000).pipe(
          Effect.map((data) =>
            ["steering", "followUp"].flatMap((key) => {
              const texts = recordField(data, key);
              return Array.isArray(texts)
                ? texts.filter((text): text is string => typeof text === "string")
                : [];
            }),
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        if (cleared.length === 0) return;
        yield* sessionEventPermit.withPermits(1)(
          threadState?.activeTurn === turn
            ? emitSystemNotice(
                turn,
                `queue-cleared:${turn.providerTurn.id}`,
                [
                  `Stop cleared ${cleared.length} queued ${cleared.length === 1 ? "message" : "messages"} Pi had not read:`,
                  ...cleared.filter((text) => text.length > 0),
                ]
                  .join("\n\n")
                  .slice(0, 2_000),
              )
            : Effect.void,
        );
      });

      const handleExtensionUiRequest = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        if (method === undefined) return;
        if (method === "notify") {
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          const message = recordString(event, "message") ?? "";
          if (turn === null || message.length === 0) return;
          const emittedAt = yield* DateTime.now;
          const nativeItemId = `notify:${turn.nextItemOrdinal}`;
          yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
              status: "completed",
              completedAt: emittedAt,
              title: "notify",
              type: "dynamic_tool",
              toolName: "notify",
              input: {
                message,
                notifyType: recordString(event, "notifyType") ?? "info",
              },
            },
          });
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor"
        ) {
          // Terminal decoration has no matching T3 surface.
          yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        const approvalTitle = recordString(event, "title") ?? "";
        const approvalKey = `${approvalTitle.length}:${approvalTitle}${recordString(event, "message") ?? ""}`;
        if (method === "confirm" && sessionApprovals.has(approvalKey)) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const title = recordString(event, "title") ?? method;
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: method === "confirm" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: method === "confirm" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          // Runless startup/session-switch requests are normalized into the
          // thread-level ordinal range by TurnItemPositionStore.
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          method === "confirm"
            ? {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: piApprovalRequestKind(title),
                prompt: recordString(event, "message") ?? title,
              }
            : {
                ...itemBase,
                type: "user_input_request",
                requestId,
                questions: [piQuestion(nativeRequestId, method, title, event)],
              };
        pendingPrompts.set(String(requestId), {
          nativeRequestId,
          method,
          questionId: nativeRequestId,
          approvalKey,
          runtimeRequest,
          node,
          turnItem,
        });
        yield* emit({
          type: "runtime_request.updated",
          driver,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver, node });
        yield* emit({ type: "turn_item.updated", driver, turnItem });
      });

      const emitExtensionError = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.nextItemOrdinal}`;
        const extensionName = piExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = recordString(event, "error")?.trim();
        const message = [
          `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
          detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        const failure = makeProviderFailure({
          message,
          class: "provider_error",
          retryable: false,
        });
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: extensionName,
            completedAt: emittedAt,
            type: "error",
            failure,
          },
        });
      });

      // ── turn lifecycle ────────────────────────────────────

      /**
       * Locate this turn's first user entry and the new leaf in pi's session
       * tree. The user-entry id becomes the provider turn's native ref (the
       * point `fork` rolls back to); the leaf becomes the conversation head.
       * Pure bookkeeping: failures degrade to the synthetic refs.
       */
      const captureTurnTreeRefs = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        timeoutMs = PI_REQUEST_TIMEOUT_MS,
      ): Effect.fn.Return<PiTurnTreeRefs | null> {
        const cursorWasStale = leafCursorStale;
        const cursor = cursorWasStale ? null : lastKnownLeaf;
        const data = yield* request(
          {
            type: "get_entries",
            ...(cursor === null ? {} : { since: cursor }),
          },
          timeoutMs,
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (data === undefined) {
          // Pi may have advanced past `lastKnownLeaf` while this failed, so the
          // cursor can no longer be trusted to bound a single turn.
          leafCursorStale = true;
          return null;
        }
        const entries = recordField(data, "entries");
        const leafId = recordString(data, "leafId");
        if (leafId !== undefined) lastKnownLeaf = leafId;
        // Without a trustworthy cursor this window spans more than one turn, so
        // its first user entry belongs to an earlier turn. Re-sync the cursor
        // and skip the turn-start ref rather than pointing rollback too far
        // back; the next turn gets an accurate ref again.
        leafCursorStale = false;
        const firstUserEntryId = cursorWasStale
          ? undefined
          : Array.isArray(entries)
            ? entries
                .filter(
                  (entry) =>
                    recordField(entry, "type") === "message" &&
                    recordString(recordField(entry, "message"), "role") === "user",
                )
                .map((entry) => recordString(entry, "id"))
                .find((id) => id !== undefined)
            : undefined;
        if (turn.nativeTurnStartEntryId === undefined && firstUserEntryId !== undefined) {
          turn.nativeTurnStartEntryId = firstUserEntryId;
        }
        return {
          turnStartEntryId: turn.nativeTurnStartEntryId ?? null,
          leafId: leafId ?? null,
        };
      });

      const cancelSettleReprobe = (turn: ActivePiTurn) =>
        Effect.gen(function* () {
          const fiber = turn.settleReprobeFiber;
          if (fiber === null) return;
          turn.settleReprobeFiber = null;
          yield* Fiber.interrupt(fiber);
        });

      const invalidateSettleProbe = (turn: ActivePiTurn) =>
        Effect.gen(function* () {
          turn.settleProbeGeneration += 1;
          turn.settleReprobeAttempt = 0;
          yield* cancelSettleReprobe(turn);
          const state = threadState;
          if (state?.activeTurn === turn) {
            yield* clearOmpBackgroundWait(state, turn);
          }
        });

      const finalizeTurn = Effect.fnUntraced(function* (state: PiThreadState, readUsage = true) {
        const turn = state.activeTurn;
        if (turn === null) return;
        yield* clearOmpBackgroundWait(state, turn);
        state.lastFinalizedTurn = turn;
        state.activeTurn = null;
        yield* cancelSettleReprobe(turn);
        const hasActiveChildren = Object.values(turn.subagentItems).some((item) =>
          isOrchestrationV2WorkActive(item.status),
        );
        if (hasActiveChildren) {
          const list = (state.finishedTurnsWithActiveChildren ??= []);
          if (!list.includes(turn)) {
            list.push(turn);
          }
        }
        const completedAt = yield* DateTime.now;
        yield* emit({
          type: "run.execution-ended",
          driver,
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          attemptId: turn.turnInput.attemptId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          workCompletedAt: completedAt,
        });

        yield* completeOpenStreamItems(turn);
        // Tool updates can mark a preview as executing before its start event
        // arrives. Close every emitted nonterminal item, not only idle previews.
        for (const toolCallId of turn.emittedToolCalls) {
          if (turn.endedTools[toolCallId] === true) continue;
          yield* emitToolItem(
            turn,
            {
              toolCallId,
              toolName: turn.toolNames.get(toolCallId) ?? "tool",
              args: turn.toolArgs.get(toolCallId),
            },
            "interrupt",
          );
        }
        if (turn.activeCompaction !== null) {
          const status = turn.interrupted
            ? "cancelled"
            : turn.failure === null
              ? "completed"
              : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (turn.interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }
        yield* cancelPendingPrompts(completedAt);
        const treeRefs =
          turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs(turn);
        const tokenUsage = readUsage
          ? yield* readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
          : undefined;
        const failure = turn.interrupted ? null : turn.failure;
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs?.turnStartEntryId == null
              ? {}
              : { nativeTurnRef: providerRef(treeRefs.turnStartEntryId) }),
            status: turn.interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        });
        yield* updateProviderThread(state, {
          status: "idle",
          ...(treeRefs?.leafId == null
            ? {}
            : { nativeConversationHeadRef: providerRef(treeRefs.leafId) }),
        });
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          if (turn.activeProviderRetry !== null) {
            yield* emitProviderRetry(
              turn,
              { ...turn.activeProviderRetry, failure },
              "failed",
              completedAt,
            );
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                status: "failed",
                title: null,
                completedAt,
                type: "error",
                failure,
              },
            });
          }
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            ...(turn.activeProviderRetry === null
              ? {}
              : {
                  retry: turn.activeProviderRetry.retry,
                  retryStartedAt: turn.activeProviderRetry.startedAt,
                }),
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: turn.interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }
      });

      // ── event pump ────────────────────────────────────────

      const scheduleSettleProbe = (
        turn: ActivePiTurn,
        settleAfterAgentActivity = false,
        attempt = 1,
      ) => {
        const providerTurnId = turn.providerTurn.id;
        const settleProbeGeneration = turn.settleProbeGeneration;
        return request({ type: "get_state" }, 10_000).pipe(
          Effect.matchEffect({
            onSuccess: (data) => {
              return Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                data,
              });
            },
            // A failed probe still has to reach the pump. Dropping it would
            // leave a command-only turn active forever, because Pi never emits
            // agent events for one.
            onFailure: () => {
              return Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                probeFailed: true,
              });
            },
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      };
      const scheduleSettleProbeRetry = (turn: ActivePiTurn) =>
        Effect.gen(function* () {
          if (turn.settleReprobeFiber !== null || !turn.settleWhenIdle || turn.interrupted) return;
          const state = threadState;
          if (state === null || state.activeTurn !== turn || state.lastFinalizedTurn === turn) {
            return;
          }

          const providerTurnId = turn.providerTurn.id;
          const settleProbeGeneration = turn.settleProbeGeneration;
          const backoffIndex = Math.min(turn.settleReprobeAttempt, SETTLE_PROBE_BACKOFF.length - 1);
          const delay = SETTLE_PROBE_BACKOFF[backoffIndex]!;
          turn.settleReprobeAttempt += 1;
          const fiber = yield* Effect.sleep(delay).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                turn.settleReprobeFiber = null;
                if (
                  threadState !== state ||
                  state.activeTurn !== turn ||
                  turn.providerTurn.id !== providerTurnId ||
                  turn.settleProbeGeneration !== settleProbeGeneration ||
                  !turn.settleWhenIdle ||
                  turn.interrupted ||
                  state.lastFinalizedTurn === turn
                ) {
                  return Effect.void;
                }
                return Effect.asVoid(scheduleSettleProbe(turn, true));
              }),
            ),
            Effect.forkIn(scope),
          );
          turn.settleReprobeFiber = fiber;
        });

      const turnOwnsTool = (turn: ActivePiTurn, toolCallId: string): boolean => {
        if (toolCallId.length === 0) return false;
        if (toolCallId in turn.toolPreviews) return true;
        if (toolCallId in turn.endedTools) return true;
        if (turn.toolStartedAt.has(toolCallId)) return true;
        for (const nativeTaskId of Object.keys(turn.subagentItems)) {
          if (nativeTaskId.startsWith(`${toolCallId}:subagent:`)) {
            return true;
          }
        }
        return false;
      };

      const turnOwnsJob = (turn: ActivePiTurn, jobId: string): boolean => {
        if (jobId.length === 0) return false;
        if (jobId in turn.subagentLive && turn.subagentLive[jobId]?.nativeTaskId !== undefined) {
          return true;
        }
        if (jobId in turn.subagentItems) return true;
        for (const item of Object.values(turn.subagentItems)) {
          if (item.subagentId === jobId) return true;
        }
        for (const activation of Object.values(turn.subagentActivations)) {
          if (
            activation.currentActivationId === jobId ||
            activation.seenActivationIds.has(jobId) ||
            activation.terminalActivationIds.has(jobId)
          ) {
            return true;
          }
        }
        return false;
      };

      const turnOwnsLabel = (turn: ActivePiTurn, label: string): boolean => {
        if (label.length === 0) return false;
        for (const item of Object.values(turn.subagentItems)) {
          if (item.title === label) return true;
        }
        if (label in turn.subagentLive) return true;
        return false;
      };

      const findOwningTurn = (
        state: PiThreadState | null | undefined,
        candidate: {
          readonly parentToolCallId?: string | undefined;
          readonly jobId?: string | undefined;
          readonly runId?: string | undefined;
          readonly label?: string | undefined;
        },
        fallbackTurn: ActivePiTurn | null = state?.activeTurn ?? null,
      ): ActivePiTurn | null => {
        if (state === null || state === undefined) return null;

        const parentToolCallId =
          typeof candidate.parentToolCallId === "string" && candidate.parentToolCallId.length > 0
            ? candidate.parentToolCallId
            : undefined;
        const jobId =
          typeof candidate.jobId === "string" && candidate.jobId.length > 0
            ? candidate.jobId
            : undefined;
        const runId =
          typeof candidate.runId === "string" && candidate.runId.length > 0
            ? candidate.runId
            : undefined;
        const label =
          typeof candidate.label === "string" && candidate.label.length > 0
            ? candidate.label
            : undefined;

        const finishedTurns: ActivePiTurn[] = [];
        if (state.lastFinalizedTurn !== undefined) {
          finishedTurns.push(state.lastFinalizedTurn);
        }
        if (state.finishedTurnsWithActiveChildren !== undefined) {
          for (const t of state.finishedTurnsWithActiveChildren) {
            if (!finishedTurns.includes(t)) {
              finishedTurns.push(t);
            }
          }
        }

        // 1. Highest precedence: explicit parentToolCallId / tool IDs
        if (parentToolCallId !== undefined) {
          if (state.activeTurn !== null && turnOwnsTool(state.activeTurn, parentToolCallId)) {
            return state.activeTurn;
          }
          for (const turn of finishedTurns) {
            if (turnOwnsTool(turn, parentToolCallId)) {
              return turn;
            }
          }
          // If activeTurn is running and this is a new tool call, it belongs to active turn
          if (state.activeTurn !== null) {
            return state.activeTurn;
          }
          return null;
        }

        // 2. Next precedence: explicit jobId / activation distinct IDs
        const distinctJobId = jobId !== undefined && jobId !== label ? jobId : undefined;
        if (distinctJobId !== undefined) {
          for (const turn of finishedTurns) {
            if (turnOwnsJob(turn, distinctJobId)) {
              return turn;
            }
          }
          if (state.activeTurn !== null && turnOwnsJob(state.activeTurn, distinctJobId)) {
            return state.activeTurn;
          }
        }

        const distinctRunId = runId !== undefined && runId !== label ? runId : undefined;
        if (distinctRunId !== undefined) {
          for (const turn of finishedTurns) {
            if (turnOwnsJob(turn, distinctRunId)) {
              return turn;
            }
          }
          if (state.activeTurn !== null && turnOwnsJob(state.activeTurn, distinctRunId)) {
            return state.activeTurn;
          }
        }
        if (distinctJobId !== undefined || distinctRunId !== undefined) return fallbackTurn;

        // 3. Fallback: weak label / title ONLY when unambiguous / no strong ownership conflict
        if (label !== undefined) {
          let labelOwner: ActivePiTurn | null =
            state.activeTurn !== null && turnOwnsLabel(state.activeTurn, label)
              ? state.activeTurn
              : null;
          for (const turn of finishedTurns) {
            if (turnOwnsLabel(turn, label)) {
              if (labelOwner !== null) return fallbackTurn;
              labelOwner = turn;
            }
          }
          if (labelOwner !== null) return labelOwner;
        }

        return fallbackTurn;
      };

      const pruneFinishedTurnIfIdle = (
        state: PiThreadState | null | undefined,
        turn: ActivePiTurn,
      ) => {
        if (
          state?.finishedTurnsWithActiveChildren !== undefined &&
          turn !== state.activeTurn &&
          turn !== state.lastFinalizedTurn
        ) {
          const hasActive = Object.values(turn.subagentItems).some((item) =>
            isOrchestrationV2WorkActive(item.status),
          );
          if (!hasActive) {
            const idx = state.finishedTurnsWithActiveChildren.indexOf(turn);
            if (idx !== -1) state.finishedTurnsWithActiveChildren.splice(idx, 1);
          }
        }
      };

      const emitNativeSystemNotice = Effect.fnUntraced(function* (
        state: PiThreadState,
        message: string,
        timestamp: DateTime.Utc,
        nativeFields: {
          nativeLevel?: "info" | "warning" | "error" | undefined;
          nativeSource?: string | undefined;
          irc?: { readonly from: string; readonly to: string } | undefined;
          jobCompletion?: PiJobCompletion | undefined;
        },
        ownerTurn: ActivePiTurn | null = state.activeTurn,
      ) {
        const threadId = state.providerThread.appThreadId;
        if (threadId === null) return;
        const noticeOrdinal = state.nextNoticeOrdinal ?? 0;
        state.nextNoticeOrdinal = noticeOrdinal + 1;
        const nativeItemId = `omp-system-notice:${state.providerThread.id}:${DateTime.formatIso(timestamp)}:${noticeOrdinal}`;
        const turn = ownerTurn;
        const turnItem =
          turn === null
            ? {
                id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: state.providerThread.id,
                providerTurnId: null,
                nativeItemRef: providerRef(nativeItemId),
                parentItemId: null,
                ordinal: noticeOrdinal,
                startedAt: timestamp,
                completedAt: timestamp,
                updatedAt: timestamp,
                type: "system_notice" as const,
                status: "completed" as const,
                title: null,
                message,
                ...nativeFields,
              }
            : {
                ...baseItemFields(turn, nativeItemId, timestamp, timestamp),
                nodeId: turn.turnInput.rootNodeId,
                ordinal: itemOrdinal(turn, nativeItemId),
                completedAt: timestamp,
                type: "system_notice" as const,
                status: "completed" as const,
                title: null,
                message,
                ...nativeFields,
              };
        yield* emit({ type: "turn_item.updated", driver, turnItem });
      });

      const emitOmpGoalReply = Effect.fnUntraced(function* (turn: ActivePiTurn, text: string) {
        const item = yield* streamItemFor(turn, "assistant_message", -1);
        yield* completeStreamItem(turn, item, text);
      });

      // A goal change is bookkeeping, not an answer: show it as a collapsed tool
      // row instead of repeating the objective, which the user just wrote.
      const emitOmpGoalUpdate = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        title: string,
        objective: string | undefined,
      ) {
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `goal:${turn.nextItemOrdinal}`;
        yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "completed",
            completedAt: emittedAt,
            title,
            type: "dynamic_tool",
            toolName: "goal",
            input: objective === undefined ? {} : { objective },
          },
        });
      });

      const failOmpGoalTurn = Effect.fnUntraced(function* (
        state: PiThreadState,
        turn: ActivePiTurn,
        message: string,
      ) {
        turn.failure = makeProviderFailure({ message, class: "provider_error" });
        yield* finalizeTurn(state);
      });

      const requestOmpGoal = (op: string, objective?: string) =>
        request({
          type: "goal",
          op,
          ...(objective === undefined ? {} : { objective }),
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ error: error.message }),
            onSuccess: (data) => ({ data }),
          }),
        );

      // OMP continues goals on its own only for hosts in `goal.continuationModes`.
      // KM leaves RPC out of that list: a resumed session would then start a goal
      // turn before KM holds one, and KM stops sessions that act outside a turn.
      // The goal's work therefore starts here, as a prompt inside this turn.
      const startOmpGoalTurn = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        op: "create" | "resume",
      ) {
        yield* sessionEventPermit.withPermits(1)(
          Effect.gen(function* () {
            yield* connection.send({
              type: "prompt",
              message: `Your goal is set (/goal ${op}). Work on it now, continuing from where you left off.`,
            });
            pendingPromptResponses.push({
              providerTurnId: turn.providerTurn.id,
              kind: "turn_start",
            });
          }),
        );
      });

      const executeOmpGoalCommand = Effect.fnUntraced(function* (
        state: PiThreadState,
        turn: ActivePiTurn,
        command: OmpGoalCommand,
      ) {
        if (command.type === "budget" || command.type === "invalid") {
          const reply =
            command.type === "budget"
              ? "OMP RPC does not support changing goal budgets."
              : command.message;
          yield* emitOmpGoalReply(turn, reply);
          yield* finalizeTurn(state);
          return;
        }

        if (command.type === "create") {
          const current = yield* requestOmpGoal("get");
          if ("error" in current) {
            yield* failOmpGoalTurn(state, turn, current.error);
            return;
          }
          const currentGoal = providerGoalFromOmpCommandResult(current.data);
          if (currentGoal !== undefined) yield* syncOmpGoal(state, currentGoal);
          const currentStatus = recordString(recordField(current.data, "goal"), "status");
          if (currentStatus === "active" || currentStatus === "paused") {
            const dropped = yield* requestOmpGoal("drop");
            if ("error" in dropped) {
              yield* failOmpGoalTurn(state, turn, dropped.error);
              return;
            }
            const droppedGoal = providerGoalFromOmpCommandResult(dropped.data);
            if (droppedGoal !== undefined) yield* syncOmpGoal(state, droppedGoal);
          }
          const created = yield* requestOmpGoal("create", command.objective);
          if ("error" in created) {
            yield* failOmpGoalTurn(state, turn, created.error);
            return;
          }
          const createdGoal = providerGoalFromOmpCommandResult(created.data);
          if (createdGoal !== undefined) yield* syncOmpGoal(state, createdGoal);
          yield* emitOmpGoalUpdate(turn, "Set goal", command.objective);
          yield* startOmpGoalTurn(turn, "create");
          return;
        }

        const result = yield* requestOmpGoal(command.type);
        if ("error" in result) {
          yield* failOmpGoalTurn(state, turn, result.error);
          return;
        }
        const resultGoal = providerGoalFromOmpCommandResult(result.data);
        if (resultGoal !== undefined) yield* syncOmpGoal(state, resultGoal);
        if (command.type === "get") {
          const goal = resultGoal === undefined ? (state.providerThread.goal ?? null) : resultGoal;
          yield* emitOmpGoalReply(turn, goal === null ? "No goal is set." : describeOmpGoal(goal));
          yield* finalizeTurn(state);
          return;
        }
        if (command.type === "pause") {
          yield* emitOmpGoalUpdate(turn, "Paused goal", resultGoal?.objective);
          yield* finalizeTurn(state);
          return;
        }
        if (command.type === "drop") {
          yield* emitOmpGoalUpdate(turn, "Dropped goal", resultGoal?.objective);
          yield* finalizeTurn(state);
          return;
        }
        const goal = resultGoal ?? state.providerThread.goal ?? null;
        yield* emitOmpGoalUpdate(turn, "Resumed goal", goal?.objective);
        yield* startOmpGoalTurn(turn, "resume");
      });
      const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "goal_updated": {
            if (driver !== "omp" || state === null) return;
            const goal = providerGoalFromOmpNativeGoal(recordField(event, "goal"));
            if (goal !== undefined) yield* syncOmpGoal(state, goal);
            return;
          }
          case "agent_start": {
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            turn.sawAgentActivity = true;
            yield* invalidateSettleProbe(turn);
            return;
          }
          case "message_start": {
            if (turn !== null && recordString(event["message"], "role") === "assistant") {
              turn.sawAgentActivity = true;
              yield* invalidateSettleProbe(turn);
              turn.messageOrdinal += 1;
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            yield* invalidateSettleProbe(turn);
            yield* reportLiveUsage(turn, event["usage"] ?? recordField(event["message"], "usage"));
            const delta = event["assistantMessageEvent"];
            const deltaType = recordString(delta, "type");
            const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
            if (deltaType === "text_delta" || deltaType === "thinking_delta") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_delta" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              item.text += recordString(delta, "delta") ?? "";
              yield* scheduleStreamFlush(turn, item);
              return;
            }
            if (deltaType === "text_end" || deltaType === "thinking_end") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_end" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              yield* completeStreamItem(
                turn,
                item,
                recordString(delta, "content") ?? recordString(delta, "thinking"),
              );
              return;
            }
            if (
              deltaType === "toolcall_start" ||
              deltaType === "toolcall_delta" ||
              deltaType === "toolcall_end"
            ) {
              const content = recordField(recordField(delta, "partial"), "content");
              const part =
                recordField(delta, "toolCall") ??
                (Array.isArray(content) ? content[contentIndex] : undefined);
              const toolCallId = recordString(part, "id");
              if (toolCallId === undefined) return;
              // A tool call closes the text and thinking written before it.
              if (deltaType === "toolcall_start") yield* completeOpenStreamItems(turn);
              const preview = (turn.toolPreviews[toolCallId] ??= {
                flushScheduled: false,
                executing: false,
              });
              preview.toolName = recordString(part, "name") ?? preview.toolName;
              preview.args = recordField(part, "arguments") ?? preview.args;
              yield* deltaType === "toolcall_delta"
                ? scheduleToolPreview(turn, toolCallId)
                : emitToolPreview(turn, toolCallId);
              return;
            }
            return;
          }
          case "custom_message":
          case "message_end": {
            const message = event["message"] ?? event;
            const role = recordString(message, "role");
            const customType =
              recordString(message, "customType") ?? recordString(event, "customType");
            if (
              (event["type"] === "custom_message" || role === "custom") &&
              customType === "async-result"
            ) {
              const details = recordField(message, "details") ?? recordField(event, "details");
              const jobs =
                recordField(details, "jobs") ??
                recordField(message, "jobs") ??
                recordField(event, "jobs");
              const emittedAt = yield* DateTime.now;
              const nativeTimestamp =
                parseRecordDateTime(message, "timestamp") ??
                parseRecordDateTime(event, "timestamp");
              const noticeTimestamp = nativeTimestamp ?? emittedAt;
              const nativeMessageId = recordString(message, "id") ?? recordString(event, "id");
              const noticeIdentity =
                nativeMessageId !== undefined && nativeMessageId.length > 0
                  ? `id:${nativeMessageId}`
                  : nativeTimestamp === undefined
                    ? undefined
                    : `timestamp:${DateTime.formatIso(nativeTimestamp)}`;
              const structuredJobIds = new Set<string>();

              if (Array.isArray(jobs) && jobs.length > 0) {
                for (const job of jobs) {
                  if (job === null || typeof job !== "object") continue;
                  const jobType = recordString(job, "type");
                  const jobId = recordString(job, "jobId") ?? recordString(job, "id");
                  const nativeStatus = recordString(job, "status") ?? recordString(job, "state");
                  if (nativeStatus !== undefined && jobId !== undefined) {
                    structuredJobIds.add(jobId);
                  }
                  const runId = recordString(job, "runId");
                  const label = recordString(job, "label") ?? recordString(job, "agent");
                  const rawParentToolCallId = recordString(job, "parentToolCallId");
                  const parentToolCallId =
                    rawParentToolCallId !== undefined && rawParentToolCallId.length > 0
                      ? rawParentToolCallId
                      : undefined;
                  const owningTurn = findOwningTurn(state, {
                    parentToolCallId,
                    jobId,
                    runId,
                    label,
                  });

                  if (nativeStatus !== undefined && owningTurn !== null) {
                    if (jobType === undefined || jobType === "task") {
                      const resolvedParentToolCallId =
                        parentToolCallId ??
                        (jobId !== undefined
                          ? owningTurn.subagentLive[jobId]?.nativeTaskId?.split(":subagent:")[0]
                          : undefined) ??
                        (runId !== undefined
                          ? owningTurn.subagentLive[runId]?.nativeTaskId?.split(":subagent:")[0]
                          : undefined) ??
                        "";
                      yield* emitSubagentRecord(
                        owningTurn,
                        resolvedParentToolCallId,
                        job,
                        emittedAt,
                        recordNumber(job, "index") ?? recordNumber(job, "step"),
                        false,
                      );
                    }
                    if (
                      owningTurn.settleWhenIdle &&
                      !Object.values(owningTurn.subagentItems).some((item) =>
                        isOrchestrationV2WorkActive(item.status),
                      )
                    ) {
                      yield* scheduleSettleProbe(owningTurn, true);
                    }
                    pruneFinishedTurnIfIdle(state, owningTurn);
                  }

                  if (
                    state === null ||
                    state.providerThread.appThreadId === null ||
                    jobId === undefined ||
                    jobId.length === 0
                  ) {
                    continue;
                  }

                  if (nativeStatus !== "running") yield* endOmpAsyncJob(state, jobId);

                  if (noticeIdentity !== undefined) {
                    let seenJobIds = state.seenAsyncResultJobs.get(noticeIdentity);
                    if (seenJobIds?.has(jobId)) continue;
                    if (seenJobIds === undefined) {
                      seenJobIds = new Set<string>();
                      state.seenAsyncResultJobs.set(noticeIdentity, seenJobIds);
                    }
                    seenJobIds.add(jobId);
                  }

                  const agentId = recordString(job, "agentId");
                  const jobLabel = recordString(job, "label");
                  const durationMs = parseRecordDurationMs(job, "durationMs");
                  const durationText =
                    durationMs === undefined ? "" : ` (${(durationMs / 1_000).toFixed(1)}s)`;
                  const noticeMessage = `Background job completed [${jobType ?? "job"}] ${jobId}${durationText}`;
                  const activeJobOwnerMatches =
                    owningTurn !== null &&
                    state.activeTurn === owningTurn &&
                    ((parentToolCallId !== undefined &&
                      turnOwnsTool(owningTurn, parentToolCallId)) ||
                      turnOwnsJob(owningTurn, jobId) ||
                      (runId !== undefined && turnOwnsJob(owningTurn, runId)));
                  yield* emitNativeSystemNotice(
                    state,
                    noticeMessage,
                    noticeTimestamp,
                    {
                      nativeSource: "omp:async-result",
                      jobCompletion: {
                        jobId,
                        ...(jobType === undefined ? {} : { type: jobType }),
                        ...(nativeStatus === undefined ? {} : { status: nativeStatus }),
                        ...(agentId === undefined ? {} : { agentId }),
                        ...(jobLabel === undefined ? {} : { label: jobLabel }),
                        ...(durationMs === undefined ? {} : { durationMs }),
                      },
                    },
                    activeJobOwnerMatches ? owningTurn : null,
                  );
                }
              }

              const delivered =
                recordString(message, "content") ?? contentText(recordField(message, "content"));
              for (const [block, jobId = "", nativeStatus = "", body = ""] of delivered.matchAll(
                PI_TASK_RESULT_PATTERN,
              )) {
                if (structuredJobIds.has(jobId)) continue;
                const owningTurn = findOwningTurn(state, { jobId });
                if (owningTurn === null) continue;
                const nativeTaskId = owningTurn.subagentLive[jobId]?.nativeTaskId;
                const item =
                  nativeTaskId === undefined ? undefined : owningTurn.subagentItems[nativeTaskId];
                if (
                  nativeTaskId === undefined ||
                  item === undefined ||
                  !isOrchestrationV2WorkActive(item.status)
                ) {
                  continue;
                }
                const status =
                  nativeStatus === "failed"
                    ? "failed"
                    : nativeStatus === "aborted" || nativeStatus === "cancelled"
                      ? "interrupted"
                      : "completed";
                const output = (PI_TASK_RESULT_OUTPUT_PATTERN.exec(body)?.[1] ?? "").trim();
                const result = output.length > 0 ? output.slice(0, 10_000) : null;
                const duration =
                  /\bduration="(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)(ms|s))?"/.exec(
                    block,
                  );
                const durationMs =
                  duration === null ||
                  (duration[1] === undefined &&
                    duration[2] === undefined &&
                    duration[3] === undefined)
                    ? undefined
                    : Number(duration[1] ?? 0) * 3_600_000 +
                      Number(duration[2] ?? 0) * 60_000 +
                      Number(duration[3] ?? 0) * (duration[4] === "ms" ? 1 : 1_000);
                const parentToolCallId = nativeTaskId.includes(":subagent:")
                  ? nativeTaskId.slice(0, nativeTaskId.lastIndexOf(":subagent:"))
                  : "";
                yield* emitSubagentRecord(
                  owningTurn,
                  parentToolCallId,
                  { id: jobId, status, resultText: result ?? undefined, durationMs },
                  emittedAt,
                  undefined,
                  false,
                );
                if (
                  owningTurn.settleWhenIdle &&
                  !Object.values(owningTurn.subagentItems).some((it) =>
                    isOrchestrationV2WorkActive(it.status),
                  )
                ) {
                  yield* scheduleSettleProbe(owningTurn, true);
                }
                pruneFinishedTurnIfIdle(state, owningTurn);
              }
              return;
            }
            if (event["type"] === "custom_message") return;
            if (role === "toolResult") {
              if (turn !== null) yield* emitToolResultMessages(turn, [message]);
              return;
            }
            if (turn === null || role !== "assistant") return;
            yield* completeOpenStreamItems(turn);
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message: recordString(message, "errorMessage") ?? "Pi reported a model error.",
                class: "provider_error",
              });
            }
            return;
          }
          case "subagent_event":
          case "subagent_lifecycle":
          case "subagent_progress": {
            const isLiveEvent = event["type"] === "subagent_event";
            if (driver === "omp" && isLiveEvent && (yield* subagentEventExceedsGuard(event))) {
              yield* activateSubagentRateLimit();
            }
            const rawPayload = recordField(event, "payload") ?? event;
            const payload = normalizeOmpSubagentRecord(rawPayload);
            const subagentId =
              recordString(payload, "nativeAgentId") ?? recordString(payload, "id");
            const parentToolCallId = recordString(payload, "parentToolCallId") ?? "";
            const rawJobId =
              recordString(payload, "nativeAgentId") ??
              recordString(payload, "id") ??
              recordString(payload, "jobId");
            const runId = recordString(payload, "runId");
            const label =
              recordString(payload, "displayLabel") ??
              recordString(payload, "label") ??
              recordString(payload, "agent");
            const owningTurn = findOwningTurn(state, {
              parentToolCallId: parentToolCallId.length > 0 ? parentToolCallId : undefined,
              jobId: rawJobId,
              runId,
              label,
            });
            if (owningTurn === null) return;
            if (subagentId === undefined) return;
            const live = (owningTurn.subagentLive[subagentId] ??= newPiSubagentLiveState());
            const explicitIndex = recordNumber(payload, "index") ?? recordNumber(payload, "step");
            if (live.nativeTaskId === undefined && parentToolCallId.length > 0) {
              live.nativeTaskId =
                explicitIndex === undefined
                  ? `${parentToolCallId}:subagent:${subagentId}`
                  : `${parentToolCallId}:subagent:${explicitIndex}`;
            }
            live.transcriptFile = recordString(payload, "sessionFile") ?? live.transcriptFile;
            if (isLiveEvent && desiredSubagentSubscriptionLevel === "events") {
              const content = piSubagentLiveContent(recordField(payload, "event"));
              if (content !== undefined) {
                live.liveContent = content;
                yield* scheduleSubagentLivePreview(owningTurn, live);
              }
            }
            if (!isLiveEvent) {
              const emittedAt = yield* DateTime.now;
              yield* emitSubagentRecord(
                owningTurn,
                parentToolCallId,
                payload,
                emittedAt,
                explicitIndex,
                false,
              );
              yield* scheduleSubagentLive(owningTurn, live);
            }
            if (
              owningTurn.settleWhenIdle &&
              !Object.values(owningTurn.subagentItems).some((item) =>
                isOrchestrationV2WorkActive(item.status),
              )
            ) {
              yield* scheduleSettleProbe(owningTurn, true);
            }
            pruneFinishedTurnIfIdle(state, owningTurn);
            return;
          }
          case "tool_execution_start": {
            const toolCallId = recordString(event, "toolCallId");
            if (toolCallId === undefined) return;
            const carrierTurn = findOwningTurn(state, { parentToolCallId: toolCallId }) ?? turn;
            if (carrierTurn !== null) {
              carrierTurn.sawAgentActivity = true;
              yield* invalidateSettleProbe(carrierTurn);
              yield* emitToolItem(carrierTurn, event, "start");
            }
            return;
          }
          case "tool_execution_update":
          case "tool_execution_end": {
            const toolCallId = recordString(event, "toolCallId");
            if (toolCallId === undefined) return;
            const carrierTurn =
              findOwningTurn(state, { parentToolCallId: toolCallId }) ?? state?.activeTurn;
            if (carrierTurn != null) {
              yield* emitToolItem(
                carrierTurn,
                event,
                event["type"] === "tool_execution_end" ? "end" : "update",
              );
              pruneFinishedTurnIfIdle(state, carrierTurn);
            }
            return;
          }
          case "compaction_start": {
            if (turn === null) return;
            yield* invalidateSettleProbe(turn);
            turn.sawCompaction = true;
            if (turn.activeCompaction !== null) {
              yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
            }
            const startedAt = yield* DateTime.now;
            const compaction = {
              nativeItemId: compactionNativeItemId(turn),
              startedAt,
            } satisfies PiCompactionState;
            turn.activeCompaction = compaction;
            yield* emitCompaction(turn, compaction, "running");
            return;
          }
          case "compaction_end": {
            if (turn === null) return;
            yield* invalidateSettleProbe(turn);
            const observedAt = yield* DateTime.now;
            const compaction = turn.activeCompaction ?? {
              nativeItemId: compactionNativeItemId(turn),
              startedAt: observedAt,
            };
            turn.activeCompaction = null;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                yield* emitCompaction(turn, compaction, "cancelled");
                if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "Pi context compaction failed.";
              yield* emitCompaction(turn, compaction, "failed", {
                summary: errorMessage.slice(0, 1_000),
              });
              if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // An overflow can surface as a model error (`message_end` with
            // stopReason error) before Pi compacts and retries the turn. Clear
            // that failure only when Pi confirms that compaction will retry;
            // a successful non-retrying compaction must not erase an exhausted
            // provider retry.
            if (event["willRetry"] === true) turn.failure = null;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            const summary = recordString(result, "summary");
            const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
            const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
            yield* emitCompaction(turn, compaction, "completed", {
              ...(summary === undefined ? {} : { summary }),
              ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
              ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
            });
            if (turn.settleWhenIdle || !turn.sawAgentActivity) {
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "auto_retry_start": {
            if (turn === null) return;
            yield* invalidateSettleProbe(turn);
            const emittedAt = yield* DateTime.now;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
            const failure = makeProviderFailure({
              message: recordString(event, "errorMessage") ?? "Pi provider request failed.",
              class: "provider_error",
              retryable: true,
            });
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: { attempt, maxAttempts, retryDelayMs },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            yield* invalidateSettleProbe(turn);
            const emittedAt = yield* DateTime.now;
            if (event["success"] === true) {
              // The retry recovered. Pi emits the erroring `message_end`
              // before retrying, so leaving that failure in place would make
              // `agent_settled` terminalize a successful turn as failed.
              if (turn.activeProviderRetry !== null) {
                const attempt = Math.max(
                  1,
                  Math.trunc(
                    recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                  ),
                );
                const recoveredRetry = {
                  ...turn.activeProviderRetry,
                  retry: { ...turn.activeProviderRetry.retry, attempt },
                };
                yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                turn.activeProviderRetry = null;
              }
              turn.failure = null;
              return;
            }
            const failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "Pi auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: {
                attempt,
                maxAttempts: current?.retry.maxAttempts ?? attempt,
                retryDelayMs: current?.retry.retryDelayMs ?? null,
              },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            turn.failure = failure;
            yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            yield* emitExtensionError(event);
            return;
          }
          case "agent_end": {
            if (turn !== null) yield* emitToolResultMessages(turn, event["messages"]);
            // Upstream Pi emits agent_settled to terminate a turn; agent_end in Pi
            // merely marks an internal step and must not finalize.
            // OMP protocol v2 does not emit agent_settled: agent_end either
            // closes the turn or yields it to background async work.
            if (driver !== "omp") return;
            if (turn === null) return;
            if (event["willRetry"] === true) return;
            if (event["isTerminal"] !== true && event["awaitingAsyncWork"] !== true) return;
            if (turn.interrupted === true) {
              if (state !== null) yield* finalizeTurn(state);
              return;
            }
            turn.settleWhenIdle = true;
            yield* invalidateSettleProbe(turn);
            if (event["awaitingAsyncWork"] === true && state !== null) {
              yield* setOmpBackgroundWait(state, turn);
            }
            yield* scheduleSettleProbe(turn, true);
            return;
          }
          case "agent_settled":
          case "session_settled": {
            if (turn !== null) yield* emitToolResultMessages(turn, event["messages"]);
            if (turn?.interrupted === true) {
              if (state !== null) yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.settleWhenIdle = true;
              yield* invalidateSettleProbe(turn);
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            // Correlated responses never reach the pump; an id-less response
            // is the deferred ack of a fire-and-forget prompt/steer/compact.
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) {
                compactTurn.manualCompactInFlight = false;
                yield* invalidateSettleProbe(compactTurn);
              }
              if (event["success"] === true) {
                if (
                  pendingCompact?.kind === "turn_start" &&
                  compactTurn !== null &&
                  compactTurn.promptMayBeCommandOnly &&
                  !compactTurn.sawAgentActivity
                ) {
                  yield* scheduleSettleProbe(compactTurn);
                }
                return;
              }
              if (event["success"] !== false) return;
              if (compactTurn === null) return;
              if (compactTurn.activeCompaction !== null) return;
              if (pendingCompact?.kind === "steer") {
                yield* Effect.logWarning("Pi rejected a compact steer.", {
                  errorLength: recordString(event, "error")?.length,
                });
                return;
              }
              if (!compactTurn.sawCompaction) {
                compactTurn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "Pi compact failed.",
                  class: "provider_error",
                });
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (!compactTurn.sawAgentActivity) {
                yield* scheduleSettleProbe(compactTurn);
              }
              return;
            }
            const pendingPrompt = command === "prompt" ? pendingPromptResponses.shift() : undefined;
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (event["success"] === true) {
              // Deferred success ack. Command-only prompts (pure extension
              // slash commands) never start an agent run and never emit
              // `agent_settled`, so probe for idleness. The probe result is
              // re-queued behind any events Pi emitted before answering
              // get_state, which keeps the check stream-ordered.
              if (
                pendingPrompt?.kind === "turn_start" &&
                responseTurn !== null &&
                responseTurn.promptMayBeCommandOnly &&
                !responseTurn.sawAgentActivity
              ) {
                yield* scheduleSettleProbe(responseTurn);
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer only means that one message was refused. The
              // turn it was aimed at is still running on Pi, so terminalizing
              // here would report a failure while output keeps streaming.
              yield* Effect.logWarning("Pi rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              failedTurn.failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Pi rejected the prompt.",
                class: "provider_error",
              });
              if (state !== null) yield* finalizeTurn(state);
            }
            return;
          }
          case "t3.flush_extension_errors": {
            // Startup extension failures are informational and do not block
            // Pi, so attach them to the next real turn instead of creating a
            // standalone failed run.
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.settle_probe": {
            // New work increments the generation before the pump can consume
            // a stale idle snapshot, so only a current snapshot may settle.
            const data = event["data"];
            const probeFailed = event["probeFailed"] === true;
            const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            if (
              turn === null ||
              turn.providerTurn.id !== event["providerTurnId"] ||
              turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
              (!settleAfterAgentActivity && turn.sawAgentActivity) ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight ||
              turn.activeProviderRetry?.failure.retryable === true
            ) {
              return;
            }
            if (probeFailed) {
              if (!settleAfterAgentActivity) {
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
                yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
                  Effect.andThen(scheduleSettleProbe(turn, true, attempt + 1)),
                  Effect.forkIn(scope),
                );
                return;
              }
              stopRequested = true;
              yield* connection.terminate;
              return;
            }
            if (driver === "omp" && state !== null) {
              const goal = providerGoalFromOmpState(data);
              if (goal !== undefined) yield* syncOmpGoal(state, goal);
            }
            const hasActiveSubagents = Object.values(turn.subagentItems).some((item) =>
              isOrchestrationV2WorkActive(item.status),
            );
            const isStreaming = recordField(data, "isStreaming") === true;
            const isCompacting = recordField(data, "isCompacting") === true;
            const hasPendingAsyncWork = recordField(data, "hasPendingAsyncWork") === true;
            const pendingMessageCount =
              recordNumber(data, "pendingMessageCount") ??
              recordNumber(data, "queuedMessageCount") ??
              0;
            const waitingOnBackgroundJob =
              driver === "omp" &&
              !isStreaming &&
              !isCompacting &&
              hasPendingAsyncWork &&
              pendingMessageCount === 0;
            // Keep settleWhenIdle: a job that finishes without waking omp emits no
            // session_settled, so only the backoff re-probe can close this run.
            if (waitingOnBackgroundJob && state !== null) {
              yield* setOmpBackgroundWait(state, turn);
            }
            const isNativeSettled = recordField(data, "isSettled");
            const contradictoryBusy =
              isStreaming || isCompacting || hasPendingAsyncWork || pendingMessageCount > 0;
            const settled =
              driver === "omp" && typeof isNativeSettled === "boolean"
                ? isNativeSettled && !contradictoryBusy
                : !contradictoryBusy && !hasActiveSubagents;
            if (settled) {
              turn.settleWhenIdle = false;
              if (state !== null) yield* finalizeTurn(state);
            } else if (turn.settleWhenIdle) {
              yield* scheduleSettleProbeRetry(turn);
            }
            return;
          }
          case "t3.settle_inspection": {
            const deferred = event["deferred"] as
              | Deferred.Deferred<ProviderAdapter.ProviderAdapterV2SettlementResult | null, never>
              | undefined;
            if (deferred === undefined) return;

            const providerTurnId = recordString(event, "providerTurnId");
            const probeGeneration = recordNumber(event, "probeGeneration");
            const runId = recordString(event, "runId");
            const providerThreadId = recordString(event, "providerThreadId");
            const probeFailed = event["probeFailed"] === true;
            const data = event["data"];

            if (probeFailed || data === undefined || typeof data !== "object" || data === null) {
              yield* Deferred.succeed(deferred, null);
              return;
            }

            const isNativeSettled = recordField(data, "isSettled");
            const isStreaming = recordField(data, "isStreaming");
            const isCompacting = recordField(data, "isCompacting");
            const hasPendingAsyncWork = recordField(data, "hasPendingAsyncWork");
            const rawQueued =
              recordField(data, "queuedMessageCount") ?? recordField(data, "pendingMessageCount");
            const queuedMessageCount = typeof rawQueued === "number" ? rawQueued : undefined;

            if (
              isNativeSettled !== true ||
              isStreaming !== false ||
              isCompacting !== false ||
              hasPendingAsyncWork !== false ||
              queuedMessageCount !== 0
            ) {
              yield* Deferred.succeed(deferred, null);
              return;
            }

            const currentState = threadState;
            if (currentState === null) {
              yield* Deferred.succeed(deferred, null);
              return;
            }
            if (currentState.providerThread.id !== providerThreadId) {
              yield* Deferred.succeed(deferred, null);
              return;
            }
            if (driver === "omp") {
              const goal = providerGoalFromOmpState(data);
              if (goal !== undefined) yield* syncOmpGoal(currentState, goal);
            }
            if (currentState.activeTurn === null) {
              yield* Deferred.succeed(deferred, null);
              return;
            }
            const activeTurn = currentState.activeTurn;
            if (
              activeTurn.providerTurn.id !== providerTurnId ||
              activeTurn.turnInput.runId !== runId ||
              activeTurn.settleProbeGeneration !== probeGeneration ||
              activeTurn.failure !== null ||
              activeTurn.interrupted ||
              activeTurn.activeCompaction !== null ||
              activeTurn.manualCompactInFlight ||
              activeTurn.activeProviderRetry !== null
            ) {
              yield* Deferred.succeed(deferred, null);
              return;
            }

            let finalAssistantCompletedAt: DateTime.Utc | undefined = undefined;
            for (const item of activeTurn.streamItems.values()) {
              if (item.kind === "assistant_message" && item.completedAt !== undefined) {
                finalAssistantCompletedAt = item.completedAt;
              }
            }
            const settledAt = finalAssistantCompletedAt ?? (yield* DateTime.now);
            const treeRefs =
              activeTurn.stopTreeRefs !== undefined
                ? activeTurn.stopTreeRefs
                : yield* captureTurnTreeRefs(activeTurn);
            if (treeRefs === null) {
              yield* Deferred.succeed(deferred, null);
              return;
            }
            yield* Deferred.succeed(deferred, {
              settledAt,
              providerTurnId: activeTurn.providerTurn.id,
              nativeTurnRef:
                treeRefs?.turnStartEntryId == null
                  ? activeTurn.providerTurn.nativeTurnRef
                  : providerRef(treeRefs.turnStartEntryId),
              nativeConversationHeadRef:
                treeRefs?.leafId == null
                  ? currentState.providerThread.nativeConversationHeadRef
                  : providerRef(treeRefs.leafId),
            });
            return;
          }
          case "irc_message": {
            const nativeMessage = recordField(event, "message");
            if (recordString(nativeMessage, "customType") !== "irc:relay" || state === null) {
              return;
            }
            const details = recordField(nativeMessage, "details");
            const message =
              recordString(details, "body") ?? contentText(recordField(nativeMessage, "content"));
            const timestamp =
              parseRecordDateTime(nativeMessage, "timestamp") ??
              parseRecordDateTime(event, "timestamp") ??
              (yield* DateTime.now);
            const from = recordString(details, "from");
            const to = recordString(details, "to");
            yield* emitNativeSystemNotice(state, message, timestamp, {
              nativeSource: "irc:relay",
              ...(from === undefined || to === undefined ? {} : { irc: { from, to } }),
            });
            return;
          }

          case "notice": {
            const source = recordString(event, "source");
            if (state !== null) {
              const nativeMessage =
                recordString(event, "message") ??
                recordString(recordField(event, "details"), "body") ??
                contentText(recordField(event, "content"));
              const timestamp = parseRecordDateTime(event, "timestamp") ?? (yield* DateTime.now);
              const nativeLevelValue = recordString(event, "level");
              yield* emitNativeSystemNotice(state, nativeMessage, timestamp, {
                ...(nativeLevelValue === "info" ||
                nativeLevelValue === "warning" ||
                nativeLevelValue === "error"
                  ? { nativeLevel: nativeLevelValue }
                  : {}),
                ...(source === undefined ? {} : { nativeSource: source }),
              });
            }
            // OMP allows one writer per session file. If another omp process
            // (a TUI, `omp -r`) already holds it, OMP saves this session to a
            // fresh file instead and says so here. Follow the move, or the
            // next resume reopens the old file and silently drops every turn
            // written since.
            if (state === null || source !== "session-persistence") return;
            const data = yield* request({ type: "get_state" }, 10_000).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            if (driver === "omp" && data !== undefined) {
              const goal = providerGoalFromOmpState(data);
              if (goal !== undefined) yield* syncOmpGoal(state, goal);
            }
            const sessionFile = recordString(data, "sessionFile");
            if (
              threadState !== state ||
              sessionFile === undefined ||
              sessionFile === state.providerThread.nativeThreadRef?.nativeId
            ) {
              return;
            }
            yield* Effect.logWarning(
              "Pi session file is held by another process; following the redirect.",
              {
                from: state.providerThread.nativeThreadRef?.nativeId,
                to: sessionFile,
              },
            );
            lastNativeThreadId = sessionFile;
            yield* updateProviderThread(state, { nativeThreadRef: providerRef(sessionFile) });
            return;
          }
          default:
            return;
        }
      });

      if (driver === "omp") {
        yield* options.threadLiveOverlay
          .viewed(input.threadId)
          .pipe(Stream.runForEach(updateSubagentViewing), Effect.forkIn(scope));
      }
      const pumpConnection = (current: PiRpcConnection, generation: number) =>
        Stream.fromQueue(current.events).pipe(
          Stream.runForEach((event) =>
            Effect.suspend(() =>
              generation !== connectionGeneration
                ? Effect.void
                : sessionEventPermit.withPermits(1)(handleSessionEvent(event)),
            ),
          ),
          Effect.catchCause((cause) =>
            sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (generation !== connectionGeneration) return;
                // Transport death finalizes any live turn. Stop-with-restart
                // is surfaced as an event-stream failure.
                const transportError = Cause.findErrorOption(cause);
                const crashSignature =
                  Option.isSome(transportError) && transportError.value._tag === "PiRpcError"
                    ? transportError.value.crashSignature
                    : undefined;
                const unexpectedExitMessage =
                  crashSignature === undefined
                    ? "Pi process exited unexpectedly."
                    : `Pi process exited unexpectedly (${crashSignature}).`;
                const state = threadState;
                const interrupted = state?.activeTurn?.interrupted === true;
                if (state?.activeTurn != null) {
                  state.activeTurn.failure = interrupted
                    ? null
                    : makeProviderFailure({
                        cause,
                        message: unexpectedExitMessage,
                        class: "transport_error",
                      });
                  yield* finalizeTurn(state, false);
                }
                if (unsolicitedActivityDetected) {
                  yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
                  yield* Queue.end(events);
                } else if (stopRequested) {
                  yield* updateProviderSession("stopped", null);
                  yield* Queue.end(events);
                } else {
                  yield* updateProviderSession(
                    "error",
                    interrupted ? "Pi process was stopped." : unexpectedExitMessage,
                  );
                  yield* Queue.fail(
                    events,
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                  );
                }
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
      yield* pumpConnection(connection, connectionGeneration);

      // Discovery can invoke extension code and therefore raise a blocking
      // UI request. Start it only after the event pump exists, and never hold
      // session opening on it; startup requests are persisted at session
      // scope and can be answered before a turn begins.
      yield* discoverSkillNames.pipe(
        Effect.tap((discovered) => Effect.sync(() => (skillNames = discovered))),
        Effect.ignore,
        Effect.forkIn(scope),
      );

      // ── session runtime ───────────────────────────────────

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        publish = true,
      ) {
        if (threadState !== null && threadState.activeTurn !== null) {
          return yield* protocolError("Cannot register a Pi thread while a turn is active");
        }
        const existing = threadInput.existingProviderThread;
        const resumeId = existing?.nativeThreadRef?.nativeId;
        const needsNewSession = resumeId == null && registrationAttempted;
        registrationAttempted = true;
        if (resumeId != null || needsNewSession) {
          lastNativeThreadId = resumeId ?? lastNativeThreadId;
          // Even a failed lifecycle operation can change Pi's native session.
          // Never leave the old app binding or model defaults usable afterward.
          threadState = null;
          appliedModel = null;
          appliedThinking = null;
          appliedSessionName = null;
          baselineModel = null;
          baselineThinking = null;
          contextWindow = null;
          const result = yield* lifecycleRequest(
            resumeId != null
              ? { type: "switch_session", sessionPath: resumeId }
              : { type: "new_session" },
          );
          if (recordField(result, "cancelled") === true) {
            return yield* protocolError("A Pi extension cancelled the session switch");
          }
        }
        const stateData = yield* request({ type: "get_state" });
        if (!modelsDiscovered) {
          const modelsData = yield* request({ type: "get_available_models" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const models = recordField(modelsData, "models");
          if (Array.isArray(models)) {
            for (const model of models) rememberModelContextWindow(model);
            modelsDiscovered = true;
          }
        }
        contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
        // Each baseline is captured independently, and only while nothing has
        // been applied yet, so a `get_state` that arrives after our own
        // selection cannot record that selection as Pi's default.
        if (baselineModel === null && appliedModel === null) {
          const stateModel = recordField(stateData, "model");
          const provider = recordString(stateModel, "provider");
          const modelId = recordString(stateModel, "id");
          if (provider !== undefined && modelId !== undefined) {
            baselineModel = { provider, modelId };
          }
        }
        if (baselineThinking === null && appliedThinking === null) {
          baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
        }
        // switch_session accepts a file path, not Pi's display session UUID.
        const nativeId = recordString(stateData, "sessionFile");
        if (nativeId === undefined) {
          return yield* protocolError("get_state returned no persisted sessionFile", stateData);
        }
        if (needsNewSession && nativeId === lastNativeThreadId) {
          return yield* protocolError("Pi did not create a distinct session file");
        }
        lastNativeThreadId = nativeId;
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeId),
                ...(needsNewSession ? { nativeConversationHeadRef: null, contextUsage: null } : {}),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver,
                  nativeThreadId: nativeId,
                }),
                driver,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        const registeredState: PiThreadState = {
          providerThread,
          activeTurn: null,
          seenAsyncResultJobs: new Map(),
          ompAsyncJobs: new Map(),
        };
        threadState = registeredState;
        if (driver === "omp") {
          const goal = providerGoalFromOmpState(stateData);
          if (goal !== undefined) yield* syncOmpGoal(registeredState, goal);
        }
        // Baseline the session-tree leaf so the first turn's user entry can
        // be located with a `since` cursor instead of a full entry scan.
        const baselineEntries = yield* request({ type: "get_entries" }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
        // A successful full baseline makes the cursor trustworthy again. Only
        // a failed one leaves it stale, so a recovered session does not keep
        // skipping turn refs. An empty tree is a success with no leafId.
        leafCursorStale = baselineEntries === undefined;
        if (publish)
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: registeredState.providerThread,
          });
        return registeredState.providerThread;
      });
      // A terminal orchestration run can still own a live Pi process. Stop it,
      // then resume its saved native session on a fresh RPC connection.
      const recoverOrphanedTurn = Effect.fnUntraced(function* (
        state: PiThreadState,
        turn: ActivePiTurn,
      ) {
        let restartConnection = false;
        yield* sessionEventPermit.withPermits(1)(
          Effect.gen(function* () {
            if (state.activeTurn !== turn) return;
            turn.interrupted = true;
            yield* clearOmpBackgroundWait(state, turn);
            yield* cancelSettleReprobe(turn);
            if (turn.stopTreeRefs === undefined) {
              turn.stopTreeRefs = yield* captureTurnTreeRefs(turn, 2_000);
            }
            yield* finalizeTurn(state);
            connectionGeneration += 1;
            yield* connection.terminate;
            restartConnection = true;
          }),
        );
        if (!restartConnection) return;
        connection = yield* spawnConnection;
        if (driver === "omp") {
          yield* requestSubagentSubscription(desiredSubagentSubscriptionLevel);
        }
        skillNames = null;
        yield* discoverSkillNames.pipe(
          Effect.tap((discovered) => Effect.sync(() => (skillNames = discovered))),
          Effect.ignore,
          Effect.forkIn(scope),
        );
        yield* registerThread({
          threadId: turn.turnInput.threadId,
          modelSelection: turn.turnInput.modelSelection,
          runtimePolicy: turn.turnInput.runtimePolicy,
          existingProviderThread: state.providerThread,
        });
        yield* pumpConnection(connection, connectionGeneration);
      });

      const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (modelSelection.model === PI_INHERIT_MODEL_SLUG) {
          // Returning to "Pi default" after an explicit pick has to replay the
          // captured baseline, otherwise Pi stays on the last model applied.
          if (appliedModel !== null && baselineModel !== null) {
            const restoredModel = yield* request({ type: "set_model", ...baselineModel });
            contextWindow = rememberModelContextWindow(restoredModel);
            appliedModel = null;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: PI_INHERIT_MODEL_SLUG, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver,
              providerSession: sessionEntity,
            });
          }
          // The "Pi default" model advertises no thinking choices of its own,
          // so an unqualified return also restores Pi's configured level
          // instead of silently keeping the effort a previous pick applied.
          if (
            thinking === undefined &&
            appliedThinking !== null &&
            baselineThinking !== null &&
            appliedThinking !== baselineThinking
          ) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = null;
          }
        } else if (modelSelection.model !== appliedModel) {
          const parsed = parsePiModelSlug(modelSelection.model);
          if (parsed === null) {
            return yield* protocolError(
              `Pi model '${modelSelection.model}' must use provider/model format`,
            );
          }
          const selectedModel = yield* request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          contextWindow = rememberModelContextWindow(selectedModel);
          appliedModel = modelSelection.model;
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver,
            providerSession: sessionEntity,
          });
        }
        if (
          thinking !== undefined &&
          thinking !== appliedThinking &&
          PI_THINKING_LEVELS.has(thinking)
        ) {
          yield* request({ type: "set_thinking_level", level: thinking });
          appliedThinking = thinking;
        }
      });

      const resolvePromptPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
      ) {
        // Provider discovery and the live session are separate Pi processes.
        // Retry a failed session-local lookup once at first use so a transient
        // startup failure cannot leave a visible $ skill inert for this session.
        if (skillNames === null && text.includes("$")) {
          skillNames = yield* discoverSkillNames.pipe(
            Effect.orElseSucceed(() => new Set<string>()),
          );
        }
        const expandedText = skillNames === null ? text : expandPiSkillReference(text, skillNames);
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const extraLines: Array<string> = [];
        for (const attachment of attachments) {
          const path = resolveAttachmentPath({
            attachmentsDir: options.serverConfig.attachmentsDir,
            attachment,
          });
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* options.fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          } else {
            extraLines.push(`[Attachment saved at ${path}]`);
          }
        }
        const message =
          extraLines.length === 0 ? expandedText : `${expandedText}\n\n${extraLines.join("\n")}`;
        return { message, images };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === PI_INHERIT_MODEL_SLUG
              ? baselineModel === null
                ? undefined
                : `${baselineModel.provider}/${baselineModel.modelId}`
              : selection.model;
          return slug === undefined ? undefined : modelContextWindows.get(slug);
        },
        measureNativeContextTokens: () =>
          DateTime.now.pipe(
            Effect.flatMap((now) => readTokenUsage(null, now)),
            Effect.map((usage) => usage?.usedTokens),
          ),
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        // The run executor routes a bare `/compact` here instead of startTurn.
        // Pi's start path already turns that text into the RPC compact call.
        compactThread: (turnInput) =>
          runtime.startTurn({
            ...turnInput,
            message: { ...turnInput.message, text: "/compact" },
          }),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.activeTurn !== null) {
              const activeTurn = state.activeTurn;
              const stillActive =
                turnInput.isRunAttemptActive === undefined
                  ? true
                  : yield* turnInput.isRunAttemptActive(
                      activeTurn.turnInput.runId,
                      activeTurn.turnInput.attemptId,
                    );
              if (stillActive) {
                return yield* protocolError(
                  `Pi provider thread ${turnInput.providerThread.id} already has an active turn`,
                );
              }
              yield* recoverOrphanedTurn(state, activeTurn);
            }
            if (
              state.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
            ) {
              return yield* protocolError("Pi turn requested for a different native session");
            }
            // The orchestrator adopts a fork under its already-allocated row.
            // Future session updates must retain that authoritative identity.
            state.providerThread = turnInput.providerThread;
            yield* applySelection(turnInput.modelSelection);
            // Mirror the thread title into pi's session name so the session
            // stays identifiable in pi's own /resume listing. Best-effort:
            // naming must never block a turn.
            if (turnInput.appThread.title !== appliedSessionName) {
              yield* request({
                type: "set_session_name",
                name: turnInput.appThread.title,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                ),
                Effect.ignore,
              );
            }
            // Resolved before the turn is installed: a failure here (an
            // unreadable attachment) must not leave `activeTurn` set, which
            // would reject every later turn as already active.
            // Orchestration instructions reach pi through the T3 MCP
            // extension's before_agent_start system-prompt hook, never by
            // wrapping the user text: a wrapped first message would no
            // longer start with "/" and slash commands would stop expanding.
            const compactCommand = parsePiCompactCommand(turnInput.message.text);
            const ompGoalCommand =
              driver === "omp" && turnInput.message.attachments.length === 0
                ? parseOmpGoalCommand(turnInput.message.text)
                : null;
            const payload =
              compactCommand === null && ompGoalCommand === null
                ? yield* resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
                : null;
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActivePiTurn = {
              turnInput,
              providerTurn,
              startedAt,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              streamItems: new Map(),
              toolArgs: new Map(),
              toolNames: new Map(),
              toolIntents: new Map(),
              toolStartedAt: new Map(),
              toolPreviews: {},
              emittedToolCalls: new Set(),
              endedTools: {},
              subagentLive: {},
              subagentItems: {},
              subagentActivations: {},
              interrupted: false,
              waitingOnBackgroundJob: false,
              sawAgentActivity: false,
              promptMayBeCommandOnly:
                compactCommand !== null ||
                ompGoalCommand !== null ||
                (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              lastLiveUsedTokens: null,
              settleProbeGeneration: 0,
              settleReprobeAttempt: 0,
              settleReprobeFiber: null,
              settleWhenIdle: false,
              sawCompaction: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
            };
            // Only the install/send/start-event boundary excludes the event
            // pump. Earlier correlated requests must leave the pump free so
            // project trust, login, and session-switch dialogs can be shown
            // and answered instead of deadlocking the caller.
            yield* Effect.gen(function* () {
              state.activeTurn = activeTurn;
              if (compactCommand !== null) {
                yield* connection.send(compactRpcRecord(compactCommand));
                pendingCompactResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              } else if (payload !== null) {
                yield* connection.send({
                  type: "prompt",
                  message: payload.message,
                  ...(payload.images.length === 0 ? {} : { images: payload.images }),
                });
                pendingPromptResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              }
              yield* emit({
                type: "provider_turn.updated",
                driver,
                threadId: turnInput.threadId,
                providerTurn,
              });
              yield* updateProviderThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                lastRunOrdinal: turnInput.runOrdinal,
              });
              yield* updateProviderSession("running", null);
              if (outOfTurnExtensionErrors.length > 0) {
                yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
              }
            }).pipe(
              sessionEventPermit.withPermits(1),
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (state.activeTurn === activeTurn) state.activeTurn = null;
                }),
              ),
            );
            if (ompGoalCommand !== null) {
              yield* executeOmpGoalCommand(state, activeTurn, ompGoalCommand);
            }
            // Pi acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Rejections therefore return later as id-less response records
            // handled by the event pump.
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) =>
          Effect.gen(function* () {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
            }
            const compactCommand = parsePiCompactCommand(steerInput.message.text);
            const payload =
              compactCommand === null
                ? yield* resolvePromptPayload(
                    steerInput.message.text,
                    steerInput.message.attachments,
                  )
                : null;
            // Prompt with streamingBehavior steer is atomic on Pi's side: it
            // queues during an active run and starts a new run if settlement
            // won the race. A direct `steer` sent after Pi became idle would
            // remain queued forever. Send fire-and-forget under the session
            // permit so a slash-command dialog cannot block the turn, and so
            // settlement cannot overtake the active-turn check.
            // /compact is not a prompt: Pi's compact RPC aborts the agent first.
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (threadState?.activeTurn !== turn) {
                  return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
                }
                if (compactCommand !== null) {
                  turn.manualCompactInFlight = true;
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                } else if (payload !== null) {
                  yield* connection.send({
                    type: "prompt",
                    message: payload.message,
                    streamingBehavior: "steer",
                    ...(payload.images.length === 0 ? {} : { images: payload.images }),
                  });
                  pendingPromptResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                }
                yield* invalidateSettleProbe(turn);
              }),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            // Stop on a settled turn: Pi runs nothing between prompts, so
            // nothing of that turn is left to stop.
            if (turn === null && interruptInput.requestRuntimeRestart === true) return;
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${interruptInput.providerTurnId} is not active`);
            }
            turn.interrupted = true;
            if (state !== null) yield* clearOmpBackgroundWait(state, turn);
            yield* cancelSettleReprobe(turn);
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight
            ) {
              // Pi's generic abort does not cancel manual compaction. Terminate
              // so Stop covers user /compact as well as detached recovery compact.
              stopRequested = true;
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* clearNativeQueue(turn);
                yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              }
              // Terminating fails every later request, so read the stopped
              // turn's session-tree refs first: rolling back past this turn
              // forks at its user entry. Holding the event permit also lets a
              // finalize that is already reading them finish before the kill.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (threadState?.activeTurn === turn && turn.stopTreeRefs === undefined) {
                    turn.stopTreeRefs = yield* captureTurnTreeRefs(turn, 2_000);
                  }
                  yield* connection.terminate;
                }),
              );
              return;
            }
            yield* clearNativeQueue(turn);
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.gen(function* () {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending Pi extension request ${requestInput.requestId}`,
              );
            }
            const response = piUiResponse(pending, requestInput.decision, requestInput.answers);
            yield* connection.send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              ...response,
            });
            // Dropped only once Pi has the answer, so a failed send leaves the
            // request retryable and still cancellable during teardown.
            pendingPrompts.delete(String(requestInput.requestId));
            if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
              sessionApprovals.add(pending.approvalKey);
            }
            const resolvedAt = yield* DateTime.now;
            pending.runtimeRequest = {
              ...pending.runtimeRequest,
              status: "resolved",
              resolvedAt,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver,
              threadId: pending.node.threadId,
              runtimeRequest: pending.runtimeRequest,
            });
            yield* emit({
              type: "node.updated",
              driver,
              node: { ...pending.node, status: "completed", completedAt: resolvedAt },
            });
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...pending.turnItem,
                status: "completed",
                completedAt: resolvedAt,
                updatedAt: resolvedAt,
              },
            });
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver,
                  requestId: requestInput.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "Pi snapshot requested for a thread this session does not host",
              );
            }
            // get_messages is Pi's active-branch view. get_entries returns the
            // whole session tree, including abandoned branches after /tree or
            // fork, which would leak discarded conversation into handoffs.
            const messagesData = yield* request({ type: "get_messages" });
            const activeMessages = recordField(messagesData, "messages");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
              (message, index) => {
                const role = recordString(message, "role");
                if (role !== "user" && role !== "assistant") return [];
                const text = contentText(recordField(message, "content"));
                if (text.length === 0) return [];
                const timestamp = recordNumber(message, "timestamp");
                const at = Option.getOrElse(
                  DateTime.make(timestamp ?? Number.NaN),
                  () => state.providerThread.createdAt,
                );
                return [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver,
                      // RPC messages do not expose session-tree entry ids. The
                      // active-branch index is stable for the lifetime of this
                      // snapshot and keeps abandoned branch ids out of it.
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                    }),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: role as "user" | "assistant",
                    text,
                    attachments: [],
                    streaming: false,
                    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                    creationSource: "provider" as const,
                    createdAt: at,
                    updatedAt: at,
                  },
                ];
              },
            );
            return {
              providerThread: state.providerThread,
              providerTurns: [],
              messages,
              runtimeRequests: [],
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        inspectSettlement: (inspectInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null || state.activeTurn === null) {
              return null;
            }
            if (state.providerThread.id !== inspectInput.providerThread.id) {
              return null;
            }
            if (state.activeTurn.turnInput.runId !== inspectInput.runId) {
              return null;
            }
            const initialActiveTurn = state.activeTurn;
            if (
              initialActiveTurn.failure !== null ||
              initialActiveTurn.interrupted ||
              initialActiveTurn.activeCompaction !== null ||
              initialActiveTurn.manualCompactInFlight ||
              initialActiveTurn.activeProviderRetry !== null
            ) {
              return null;
            }
            const probeGeneration = initialActiveTurn.settleProbeGeneration;
            const providerTurnId = initialActiveTurn.providerTurn.id;

            const deferred = yield* Deferred.make<
              ProviderAdapter.ProviderAdapterV2SettlementResult | null,
              never
            >();

            yield* request({ type: "get_state" }, 5_000).pipe(
              Effect.matchEffect({
                onSuccess: (data) =>
                  Queue.offer(connection.events, {
                    type: "t3.settle_inspection",
                    providerTurnId,
                    probeGeneration,
                    runId: inspectInput.runId,
                    providerThreadId: inspectInput.providerThread.id,
                    data,
                    deferred,
                  }),
                onFailure: () =>
                  Queue.offer(connection.events, {
                    type: "t3.settle_inspection",
                    providerTurnId,
                    probeGeneration,
                    runId: inspectInput.runId,
                    providerThreadId: inspectInput.providerThread.id,
                    probeFailed: true,
                    deferred,
                  }),
              }),
              Effect.ignore,
              Effect.forkIn(scope),
            );

            return yield* Deferred.await(deferred).pipe(
              Effect.timeout(Duration.millis(5_000 + PI_REQUEST_TIMEOUT_MS + 5_000)),
              Effect.orElseSucceed(() => null),
            );
          }),
        rollbackThread: (rollbackInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.providerThread.id !== rollbackInput.providerThread.id) {
              return yield* protocolError(
                "Pi rollback requested for a thread this session does not host",
              );
            }
            if (state.activeTurn !== null) {
              return yield* protocolError("Cannot roll back while a Pi turn is active");
            }
            // `fork(entryId)` re-roots the active branch before that user
            // message, so the rollback boundary is the first user entry of
            // the earliest turn being discarded.
            const forkEntryId = piRollbackForkEntry(rollbackInput);
            if (forkEntryId === null) {
              // Nothing after the target: the conversation is already there.
              return piThreadSnapshot(state.providerThread);
            }
            if (forkEntryId === undefined) {
              return yield* protocolError("Pi rollback target has no captured session-tree entry");
            }
            const forkData = yield* lifecycleRequest({ type: "fork", entryId: forkEntryId });
            if (recordField(forkData, "cancelled") === true) {
              return yield* protocolError("A Pi extension cancelled the session fork");
            }
            // Pi fork replaces the session file, including for rollback. Persist
            // its new identity before any later request can fail or restart.
            // An interrupted read leaves the identity just as unknown as a failed one.
            const forkState = yield* request({ type: "get_state" }).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  threadState = null;
                }),
              ),
            );
            if (driver === "omp") {
              const goal = providerGoalFromOmpState(forkState);
              if (goal !== undefined) yield* syncOmpGoal(state, goal);
            }
            const forkSessionFile = recordString(forkState, "sessionFile");
            if (forkSessionFile === undefined) {
              threadState = null;
              return yield* protocolError("Pi fork did not return a persisted session file");
            }
            lastNativeThreadId = forkSessionFile;
            appliedModel = null;
            appliedThinking = null;
            appliedSessionName = null;
            yield* updateProviderThread(state, { nativeThreadRef: providerRef(forkSessionFile) });
            const entriesData = yield* request({ type: "get_entries" }).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            const leafId = recordString(entriesData, "leafId") ?? null;
            lastKnownLeaf = leafId;
            // The fork re-baselined the tree, so the cursor is trustworthy
            // again unless this listing itself failed.
            leafCursorStale = entriesData === undefined;
            yield* updateProviderThread(state, {
              nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
            });
            return piThreadSnapshot(state.providerThread);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver,
                  providerThreadId: rollbackInput.providerThread.id,
                  checkpointId: rollbackInput.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (forkInput) =>
          Effect.gen(function* () {
            if (threadState?.activeTurn != null) {
              return yield* protocolError("Cannot fork while a Pi turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const sourceFile = source.nativeThreadRef?.nativeId;
            if (sourceFile == null)
              return yield* protocolError("Pi fork source has no session file");
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target === undefined) {
              return yield* protocolError("Pi fork target turn is missing");
            }
            const beforeEntry =
              target === undefined
                ? null
                : piRollbackForkEntry({
                    target: { type: "provider_turn", providerTurn: target },
                    providerThreadTurns: sourceTurns,
                  });
            if (beforeEntry === undefined) {
              return yield* protocolError("Pi fork boundary has no captured session-tree entry");
            }
            // CLI --fork uses Pi's own session format and sets the destination
            // cwd. RPC switch_session/clone alone would retain the source cwd.
            // This short-lived process never prompts or runs user extensions.
            const forkLaunch = buildPiRpcLaunch({
              launchArgs,
              environment: options.environment,
              mcpSession: undefined,
              extensionPath: undefined,
              disableExtensions: true,
              disableTools: true,
            });
            const nativeId = yield* Effect.scoped(
              Effect.gen(function* () {
                const forkConnection = yield* makePiRpcConnection({
                  command: options.settings.binaryPath || options.dialect.binary,
                  args: [...forkLaunch.args, "--fork", sourceFile],
                  cwd,
                  env: forkLaunch.env,
                  dialect: options.dialect,
                });
                yield* Stream.fromQueue(forkConnection.events).pipe(
                  Stream.runDrain,
                  Effect.ignore,
                  Effect.forkScoped,
                );
                if (beforeEntry !== null) {
                  const result = yield* forkConnection.request({
                    type: "fork",
                    entryId: beforeEntry,
                  });
                  if (recordField(result, "cancelled") === true) {
                    return yield* protocolError("A Pi extension cancelled the session fork");
                  }
                }
                const state = yield* forkConnection.request({ type: "get_state" });
                const file = recordString(state, "sessionFile");
                if (file === undefined || file === sourceFile) {
                  return yield* protocolError("Pi fork did not create a distinct session file");
                }
                return file;
              }),
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner));
            const now = yield* DateTime.now;
            return yield* registerThread(
              {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                existingProviderThread: {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver,
                    nativeThreadId: nativeId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              false,
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver,
                  providerThreadId: forkInput.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  });
}

/**
 * Resolve the pi session-tree entry `fork` should re-root at for a rollback.
 * Returns `null` when no turns follow the target (nothing to discard) and
 * `undefined` when the boundary turn has no captured entry ref (only
 * turn-boundary refs recorded by `captureTurnTreeRefs` are strong).
 */
function piRollbackForkEntry(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): string | null | undefined {
  const boundaryOrdinal =
    input.target.type === "thread_start" ? 0 : input.target.providerTurn.ordinal;
  const discarded = input.providerThreadTurns
    .filter((turn) => turn.ordinal > boundaryOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  const boundary = discarded[0];
  if (boundary === undefined) return null;
  const ref = boundary.nativeTurnRef;
  if (ref === null || ref.strength !== "strong" || ref.nativeId === null) return undefined;
  return ref.nativeId;
}

/**
 * Human-readable output for one subagent-extension task result: the last
 * assistant text from its transcript, or the error/stderr when it failed.
 */
function piSubagentOutput(result: unknown): string {
  const summary =
    recordString(result, "summary") ||
    recordString(result, "output") ||
    recordString(result, "result");
  if (summary !== undefined && summary.length > 0) return summary;
  const stopReason = recordString(result, "stopReason");
  const failed =
    (recordNumber(result, "exitCode") ?? 0) !== 0 ||
    stopReason === "error" ||
    stopReason === "aborted";
  if (failed) {
    // Falsy fallback, not `??`: an empty `errorMessage` must not suppress a
    // non-empty `stderr`, which is often the only description of the failure.
    const failure = recordString(result, "errorMessage") || recordString(result, "stderr");
    if (failure !== undefined && failure.length > 0) return failure;
  }
  const messages = recordField(result, "messages");
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (recordString(message, "role") !== "assistant") continue;
      const text = contentText(recordField(message, "content"));
      if (text.length > 0) return text;
    }
  }
  // OMP progress entries carry recent output lines and the agent's last intent.
  const recentOutput = recordField(result, "recentOutput");
  const latestLine = Array.isArray(recentOutput)
    ? recentOutput.findLast((line) => typeof line === "string" && line.trim().length > 0)
    : undefined;
  if (typeof latestLine === "string") return latestLine;
  return recordString(result, "lastIntent") ?? "";
}

function piToolPreviewText(toolName: string | undefined, args: unknown): string {
  const name = toolName ?? "tool";
  return args === undefined ? name : `${name} ${JSON.stringify(args)}`;
}

/**
 * Latest bounded preview of a child agent's output from one OMP `subagent_event`.
 * Message updates carry the partial message, so the preview is the current
 * content block rather than an accumulation of deltas.
 */
function isUnknownArray(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

/** Count JSON bytes without serializing/copying the potentially large event frame. */
function estimateJsonByteLength(root: unknown): number {
  const pending: Array<unknown> = [root];
  let total = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined) continue;
    if (value === null) {
      total += 4;
    } else if (typeof value === "string") {
      total += estimateJsonStringByteLength(value);
    } else if (typeof value === "number") {
      total += String(value).length;
    } else if (typeof value === "boolean") {
      total += value ? 4 : 5;
    } else if (isUnknownArray(value)) {
      total += 2 + Math.max(0, value.length - 1);
      for (const child of value) pending.push(child);
    } else if (typeof value === "object") {
      let propertyCount = 0;
      for (const key in value) {
        if (Object.hasOwn(value, key)) propertyCount += 1;
      }
      total += 2 + Math.max(0, propertyCount - 1);
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        total += estimateJsonStringByteLength(key) + 1;
        pending.push(recordField(value, key));
      }
    }
  }
  return total + 1;
}

function estimateJsonStringByteLength(value: string): number {
  let total = Buffer.byteLength(value) + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      total += 1;
    } else if (code <= 0x1f) {
      total +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 1 : 5;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      } else {
        total += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      total += 3;
    }
  }
  return total;
}

function piSubagentLiveContent(event: unknown): OrchestrationV2SubagentLiveContent | undefined {
  const type = recordString(event, "type");
  let kind: OrchestrationV2SubagentLiveContent["kind"];
  let text: string | undefined;
  if (type === "message_update") {
    const update = recordField(event, "assistantMessageEvent");
    const updateType = recordString(update, "type") ?? "";
    const contentIndex = recordNumber(update, "contentIndex");
    const content = recordField(
      recordField(update, "partial") ?? recordField(event, "message"),
      "content",
    );
    const part =
      contentIndex !== undefined && Array.isArray(content) ? content[contentIndex] : undefined;
    if (updateType.startsWith("thinking_")) {
      kind = "reasoning";
      text = recordString(part, "thinking");
    } else if (updateType.startsWith("text_")) {
      kind = "assistant";
      text = recordString(part, "text");
    } else if (updateType.startsWith("toolcall_")) {
      kind = "tool";
      text = piToolPreviewText(recordString(part, "name"), recordField(part, "arguments"));
    } else {
      return undefined;
    }
  } else if (
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end"
  ) {
    kind = "tool";
    const output = contentText(
      recordField(
        recordField(event, type === "tool_execution_end" ? "result" : "partialResult"),
        "content",
      ),
    );
    text =
      output.length > 0
        ? output
        : piToolPreviewText(recordString(event, "toolName"), recordField(event, "args"));
  } else {
    return undefined;
  }
  if (text === undefined || text.length === 0) return undefined;
  const max = ORCHESTRATION_V2_SUBAGENT_LIVE_CONTENT_MAX_LENGTH;
  return text.length > max ? { kind, text: text.slice(-max), truncated: true } : { kind, text };
}

function piExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Pi extension";
  const normalized = extensionPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return name.length === 0 ? "Pi extension" : name;
}

function piThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}

function piQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({ label: option || "Empty value", description: option, value: option }))
      : [
          {
            label: "Submit empty value",
            description: "Send an empty string to the extension.",
            value: "",
          },
        ];
  // The user-input contract has no prefill field, so an editor dialog's
  // prefill is surfaced inside the question text; without it the user would
  // edit blind against content they cannot see.
  const prefill = method === "editor" ? recordString(event, "prefill") : undefined;
  const question = recordString(event, "message") ?? recordString(event, "placeholder") ?? title;
  return {
    id: questionId,
    header: title,
    question:
      prefill === undefined || prefill.length === 0
        ? question
        : `${question}\n\nCurrent value:\n${prefill.slice(0, 2_000)}`,
    options,
  };
}

function piUiResponse(
  pending: PendingPiPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  const answer = answers?.[pending.questionId];
  // An empty string is a valid dialog value per the RPC spec (the extension
  // receives ""), distinct from cancelling (the extension receives undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

// ── driver ────────────────────────────────────────────────────

export type PiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | ServerConfig.ServerConfig
  | ThreadLiveOverlay.ThreadLiveOverlay;

export const PiAdapterV2Driver: ProviderAdapterDriver<PiSettings, PiAdapterV2DriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => DEFAULT_PI_SETTINGS,
  create: Effect.fn("PiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const threadLiveOverlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
      return makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner,
        fileSystem,
        idAllocator,
        serverConfig,
        threadLiveOverlay,
        dialect: PI_DIALECT,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PI_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Pi adapter.",
              cause,
            }),
        ),
      ),
  ),
};

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, PiAdapterV2DriverEnv> = {
  driverKind: ProviderDriverKind.make("omp"),
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const threadLiveOverlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
      return makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner,
        fileSystem,
        idAllocator,
        serverConfig,
        threadLiveOverlay,
        dialect: OMP_DIALECT,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ProviderDriverKind.make("omp"),
              instanceId: input.instanceId,
              detail: "Failed to create OMP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

const layer: Layer.Layer<ProviderAdapter.ProviderAdapterV2, never, PiAdapterV2DriverEnv> =
  Layer.effect(
    ProviderAdapter.ProviderAdapterV2,
    Effect.gen(function* () {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const threadLiveOverlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
      return makePiAdapterV2({
        instanceId: PI_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_PI_SETTINGS,
        environment: hostEnvironment,
        spawner,
        fileSystem,
        idAllocator,
        serverConfig,
        threadLiveOverlay,
        dialect: PI_DIALECT,
      });
    }),
  );
