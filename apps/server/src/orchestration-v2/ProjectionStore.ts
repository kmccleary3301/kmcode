import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import type {
  OrchestrationV2ActivityMode,
  OrchestrationV2AppThread,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  PlanId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadActivityPage,
  OrchestrationV2ThreadActivitySummary,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  MessageId,
} from "@t3tools/contracts";
import {
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema,
  OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema,
  OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema,
  OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema,
  OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema,
  OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema,
  OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema,
  OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema,
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  orchestrationV2RunWorkStartedAt,
  RunId,
  RuntimeRequestId,
  CheckpointScopeId,
  ThreadId,
  TurnItemId,
  NodeId,
  ProjectId,
} from "@t3tools/contracts";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2SupersededInterrupt,
  isOrchestrationV2TurnItemVisible,
} from "@t3tools/shared/orchestrationV2Timeline";
import {
  derivePendingBackgroundWork,
  isOmpAsyncJobWait,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import { findProjectedThreadItems, makeThreadFind } from "./ThreadFind.ts";

import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";
import {
  decodeThreadActivityCursor,
  encodeThreadActivityCursor,
  isThreadHistoryUserTurn,
  isThreadHistoryTurnStart,
  THREAD_ACTIVITY_PAGE_LIMIT,
  THREAD_HISTORY_MAX_RAW_TURNS,
} from "./threadHistoryPaging.ts";
import {
  getSemanticActivityPage,
  getSemanticActivitySummaries,
  type SemanticActivityQueryError,
  type SemanticActivitySource,
} from "./semanticActivityQueries.ts";
import { packContextHandoffDelivery } from "./ContextHandoffDeliveryIds.ts";

export class ProjectionStoreApplyEventError extends Schema.TaggedError<ProjectionStoreApplyEventError>()(
  "ProjectionStoreApplyEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to apply orchestration projection event ${this.eventType}.`;
  }
}

export class ProjectionStoreSetupError extends Schema.TaggedError<ProjectionStoreSetupError>()(
  "ProjectionStoreSetupError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to initialize orchestration projection store.";
  }
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedError<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No orchestration projection exists for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreReadError extends Schema.TaggedError<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read orchestration projection for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreInvalidActivityCursorError extends Schema.TaggedError<ProjectionStoreInvalidActivityCursorError>()(
  "ProjectionStoreInvalidActivityCursorError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ProjectionStoreActivityNotFoundError extends Schema.TaggedError<ProjectionStoreActivityNotFoundError>()(
  "ProjectionStoreActivityNotFoundError",
  {
    threadId: ThreadId,
    sourceThreadId: Schema.optional(ThreadId),
    groupStartItemId: Schema.optional(TurnItemId),
    anchorItemId: Schema.optional(TurnItemId),
  },
) {}

export class ProjectionStoreInvalidActivityRequestError extends Schema.TaggedError<ProjectionStoreInvalidActivityRequestError>()(
  "ProjectionStoreInvalidActivityRequestError",
  {
    threadId: ThreadId,
    reason: Schema.String,
  },
) {}
export const ProjectionStoreV2Error = Schema.Union([
  ProjectionStoreSetupError,
  ProjectionStoreApplyEventError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreInvalidActivityCursorError,
  ProjectionStoreActivityNotFoundError,
  ProjectionStoreInvalidActivityRequestError,
  ProjectionStoreReadError,
]);
export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export interface ShellSnapshotOptions {
  readonly location?: "active" | "archive";
  /** Background sweeps only: skips settled threads before any shell state is read. */
  readonly unsettledOnly?: boolean;
  readonly projectId?: ProjectId;
  readonly worktreePath?: string;
  readonly threadIds?: ReadonlyArray<ThreadId>;
}

/** Lightweight metadata used to select thread shells without materializing their full state. */
export interface ActiveShellIndexEntry extends Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pinnedAt" | "snoozedUntil"
> {
  /** A superset of live state; false only when no run, request, work item, or watch can be live. */
  readonly mayBeLive: boolean;
}

export type ProjectionRecoveryKind =
  | "queued-runs"
  | "runtime"
  | "subagent-results"
  | "delegated-completions";

/** Persisted state needed for limit recovery, without transcript or fork history. */
export type ProjectionLimitRecoveryCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "usageLimitResetAt"
  | "archivedAt"
  | "settledOverride"
  | "pendingRuntimeRequest"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "limitRecovery"
  | "snoozedUntil"
>;

/** The thread fields pull request sync reads, for a thread with at least one link. */
export type ProjectionThreadPullRequests = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pullRequests"
>;

/**
 * Thread activity needed by settlement, without transcript or fork history.
 * Settlement always loads `latestUserAuthoredMessageAt`, so it is required here.
 */
export type ProjectionSettlementCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "branch"
  | "worktreePath"
  | "pullRequests"
  | "linkedPullRequest"
  | "branchPullRequest"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "autoSettleDisabledAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "lastSnoozeWakeAt"
  | "latestRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "latestUserMessageAt"
  | "status"
  | "activityRunStartedAt"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
> & { readonly latestUserAuthoredMessageAt: DateTime.Utc | null };

const ProjectionCheckpointContext = Schema.Struct({
  runs: Schema.Array(
    OrchestrationV2RunJsonSchema.mapFields(({ id, ordinal, status }) => ({ id, ordinal, status })),
  ),
  checkpointScopes: Schema.Array(
    OrchestrationV2CheckpointScopeJsonSchema.mapFields(({ id, runId, kind, cwd }) => ({
      id,
      runId,
      kind,
      cwd,
    })),
  ),
  checkpoints: Schema.Array(
    OrchestrationV2CheckpointJsonSchema.mapFields(
      ({ scopeId, runId, appRunOrdinal, status, ref }) => ({
        scopeId,
        runId,
        appRunOrdinal,
        status,
        ref,
      }),
    ),
  ),
});
export type ProjectionCheckpointContext = typeof ProjectionCheckpointContext.Type;
const decodeCheckpointContext = Schema.decodeUnknownEffect(ProjectionCheckpointContext);

/** Durable capture targets, without transcript or checkpoint file payloads. */
export interface ProjectionCheckpointCaptureContext {
  readonly run: OrchestrationV2Run | undefined;
  readonly rootNode: OrchestrationV2ExecutionNode | undefined;
  readonly scope: OrchestrationV2CheckpointScope | undefined;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly readyCheckpointOrdinals: ReadonlyArray<number>;
}

/** Exact durable targets used by interrupt, restart, and steering effects. */
export interface ProjectionProviderControlContext {
  readonly providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] | undefined;
  readonly providerTurn: OrchestrationV2ProviderTurn | undefined;
  readonly attempt: OrchestrationV2ThreadProjection["attempts"][number] | undefined;
  readonly message: OrchestrationV2ConversationMessage | undefined;
  readonly run: OrchestrationV2Run | undefined;
}

export interface ProjectionProviderControlTarget {
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId?: RunAttemptId;
  readonly messageId?: MessageId;
}

export type ProjectionRuntimeRecoveryState = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "attempts"
  | "nodes"
  | "subagents"
  | "providerSessions"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "messages"
  | "turnItems"
>;

export type ProjectionPendingUserInputs = Pick<
  OrchestrationV2ThreadProjection,
  "runtimeRequests" | "nodes" | "turnItems"
>;

export type ProjectionThreadProviderContext = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "providerSessions" | "providerThreads"
>;
export interface ProjectionRuntimeResponseContext {
  readonly request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined;
  readonly node: OrchestrationV2ThreadProjection["nodes"][number] | undefined;
  readonly item: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
  readonly session: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
}

export interface ProjectionRecordFilter {
  readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
  readonly turnItemRunId?: RunId;
  readonly messageIds?: ReadonlyArray<MessageId>;
  readonly messageRunIds?: ReadonlyArray<RunId>;
  readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
  readonly turnItemNodeIds?: ReadonlyArray<NodeId>;
  readonly runIds?: ReadonlyArray<RunId>;
  readonly subagentIds?: ReadonlyArray<NodeId>;
  readonly subagentRunIds?: ReadonlyArray<RunId>;
  readonly nodeIds?: ReadonlyArray<NodeId>;
  readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly turnItemStatuses?: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
  readonly omitSettledLeafNodes?: boolean;
  /**
   * Skips ended subagents whose completion was acknowledged, delivered or disposed, unless their
   * run is active or `except` names them.
   */
  readonly omitSettledSubagents?: true | { readonly except: ReadonlyArray<NodeId> };
  readonly contextTransferStatuses?: ReadonlyArray<
    OrchestrationV2ThreadProjection["contextTransfers"][number]["status"]
  >;
  /**
   * Also skips the provider thread of each subagent skipped by `omitSettledSubagents`, and, with
   * `omitSettledLeafNodes`, its node. A provider thread sharing this thread's provider session stays.
   */
  readonly omitSettledSubagentRecords?: boolean;
  /**
   * For a compacted thread, narrows attempts, nodes, messages and provider turns to runs since its
   * latest completed compaction and the named exceptions. Runs and turn items remain unbounded.
   */
  readonly sinceLastCompaction?: {
    readonly keepRunIds: ReadonlyArray<RunId>;
    readonly keepMessageId: MessageId;
  };
}
export type ProjectionRecordField = Exclude<
  keyof OrchestrationV2ThreadProjection,
  "thread" | "updatedAt" | "visibleTurnItems"
>;
export type ProjectionRecords<K extends ProjectionRecordField> = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | K
>;

export interface ProjectionTimelinePageOptions {
  readonly afterPosition?: number;
  readonly itemId?: TurnItemId;
  readonly view?: "messages" | "activity";
  readonly limit: number;
}
export interface ProjectionTimelinePage {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly totalItems: number;
  readonly hasMore: boolean;
}
export interface ProjectionActivityPageOptions {
  readonly threadId: ThreadId;
  readonly sourceThreadId?: ThreadId | undefined;
  readonly groupStartItemId?: TurnItemId | undefined;
  readonly cursor?: string | undefined;
  readonly anchorItemId?: TurnItemId | undefined;
  readonly limit?: number | undefined;
  readonly summaryOnly?: boolean | undefined;
}

export type ProjectionThreadSnapshotWindow = {
  readonly schemaVersion: number;
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
} & (
  | {
      readonly activityMode: "summary-v1";
      readonly activitySummaries: ReadonlyArray<OrchestrationV2ThreadActivitySummary>;
    }
  | {
      readonly activityMode?: never;
      readonly activitySummaries?: never;
    }
);

export interface ProjectionStoreV2Shape {
  readonly getThreadAttachmentIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionStoreV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, ProjectionStoreV2Error>;
  readonly getThreadActivityPage: (
    input: ProjectionActivityPageOptions,
  ) => Effect.Effect<OrchestrationV2ThreadActivityPage, ProjectionStoreV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getSubagentCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getNextTurnItemOrdinal: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionStoreV2Error>;
  /** One persisted turn item, or null when the thread has no such item. */
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, ProjectionStoreV2Error>;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error>;

  readonly apply: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<void, ProjectionStoreV2Error>;
  /**
   * `unsettledOnly` is for background sweeps, not clients: it skips settled
   * threads before any of their run, item or session rows are read.
   */
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>;
  /** Count every non-deleted thread, including archived threads. */
  readonly countThreads: () => Effect.Effect<number, ProjectionStoreV2Error>;
  /** Active shell metadata in the same order as `getShellSnapshot({ location: "active" })`. */
  readonly listActiveShellIndex: () => Effect.Effect<
    ReadonlyArray<ActiveShellIndexEntry>,
    ProjectionStoreV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2AppThread, ProjectionStoreV2Error>;
  readonly getLimitRecoveryCandidates: (options: {
    readonly now: DateTime.Utc;
    readonly autoResume: boolean;
    readonly snooze: boolean;
  }) => Effect.Effect<ReadonlyArray<ProjectionLimitRecoveryCandidate>, ProjectionStoreV2Error>;
  /** Epoch ms of the next armed reset or snooze end after `now`. */
  readonly getLimitRecoveryWakeAt: (
    now: DateTime.Utc,
  ) => Effect.Effect<number | null, ProjectionStoreV2Error>;
  /** Every candidate, or only `threadId` when a sweep checks one thread. */
  readonly getSettlementCandidates: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionSettlementCandidate>, ProjectionStoreV2Error>;
  /**
   * Active (not deleted, not archived) threads with at least one pull request
   * link, in shell snapshot order, or only `threadId` when given. Skips run,
   * message and item reads.
   */
  readonly getThreadsWithPullRequests: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequests>, ProjectionStoreV2Error>;
  readonly getTurnStartContext: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<
    Pick<
      OrchestrationV2ThreadProjection,
      | "thread"
      | "runs"
      | "attempts"
      | "nodes"
      | "subagents"
      | "providerSessions"
      | "providerThreads"
      | "providerTurns"
      | "messages"
      | "checkpointScopes"
      | "contextHandoffs"
      | "contextTransfers"
      | "turnItems"
    > & { readonly hasConversation: boolean },
    ProjectionStoreV2Error
  >;
  readonly getTurnStartHistory: (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, ProjectionStoreV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly getRuntimeRecoveryProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionRuntimeRecoveryState, ProjectionStoreV2Error>;
  readonly getPendingNativeUserInputs: (
    threadId: ThreadId,
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<ProjectionPendingUserInputs, ProjectionStoreV2Error>;
  readonly getPlan: (
    threadId: ThreadId,
    planId: PlanId,
  ) => Effect.Effect<OrchestrationV2PlanArtifact | undefined, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest: (
    threadId: ThreadId,
    requestId: TurnItemId,
    resultId: TurnItemId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly isNodeStored: (
    node: OrchestrationV2ExecutionNode,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getRuntimeRequest: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<
    OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined,
    ProjectionStoreV2Error
  >;
  readonly getProviderControlContext: (
    threadId: ThreadId,
    target: ProjectionProviderControlTarget,
  ) => Effect.Effect<ProjectionProviderControlContext, ProjectionStoreV2Error>;
  readonly getRunningTurnContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<ProjectionProviderControlContext, "run" | "providerThread" | "providerTurn">,
    ProjectionStoreV2Error
  >;
  readonly getThreadProviderContext: (
    threadId: ThreadId,
    targetInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<ProjectionThreadProviderContext, ProjectionStoreV2Error>;
  readonly getRuntimeResponseContext: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<ProjectionRuntimeResponseContext, ProjectionStoreV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, ProjectionStoreV2Error>;
  readonly getCheckpointCaptureContext: (
    threadId: ThreadId,
    target: { readonly runId: RunId; readonly scopeId: CheckpointScopeId },
  ) => Effect.Effect<ProjectionCheckpointCaptureContext, ProjectionStoreV2Error>;
  readonly getRunMessage: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, ProjectionStoreV2Error>;
  readonly canStartQueuedRun: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getHeldQueuedRuns: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, ProjectionStoreV2Error>;
  readonly getRecoveryThreadIds: (
    kind: ProjectionRecoveryKind,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
  readonly getUnreadableThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: {
      /** Row fallback for histories without turn starts. */
      readonly rowLimit: number;
      /** User-turn window, with extra anchors for the inclusive cursor and has-more check. */
      readonly userTurnLimit?: number | undefined;
      readonly anchorItemId?: TurnItemId | undefined;
      readonly anchorThreadId?: ThreadId | undefined;
      readonly requiredRunId?: RunId | undefined;
      readonly activityMode?: OrchestrationV2ActivityMode | undefined;
      readonly compactTimeline?: boolean | undefined;
      readonly throughEntryId?: string | undefined;
    },
  ) => Effect.Effect<ProjectionThreadSnapshotWindow, ProjectionStoreV2Error>;
}

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "t3/orchestration-v2/ProjectionStore/ProjectionStoreV2",
) {}

export const ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION = 2;

function needsRecovery(
  projection: OrchestrationV2ThreadProjection,
  kind: ProjectionRecoveryKind,
): boolean {
  if (projection.thread.deletedAt !== null) return false;
  switch (kind) {
    case "queued-runs":
      return (
        projection.thread.archivedAt === null &&
        projection.runs.some((run) => run.status === "queued") &&
        !projection.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      );
    case "delegated-completions":
      return projection.runs.some((run) => run.delegatedCompletion?.delivery != null);
    case "subagent-results": {
      const parentThreadId = projection.thread.lineage.parentThreadId;
      return (
        projection.thread.lineage.relationshipToParent === "subagent" &&
        parentThreadId !== null &&
        projection.thread.forkedFrom?.type === "node" &&
        projection.thread.creationSource !== "provider" &&
        projection.runs.some((run) => {
          if (
            !["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(run.status)
          ) {
            return false;
          }
          if (
            projection.runs.some(
              (continuation) => continuation.restartContinuationOfRunId === run.id,
            )
          ) {
            return false;
          }
          return !projection.contextTransfers.some(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === projection.thread.id &&
              transfer.targetThreadId === parentThreadId &&
              (transfer.sourcePoint.runId === run.id || transfer.sourcePoint.runId === undefined),
          );
        })
      );
    }
    case "runtime":
      return (
        projection.runs.some(
          (run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status) ||
            (run.status === "queued" && run.queueHeld !== true),
        ) ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        projection.providerSessions.some(
          (session) => session.status !== "stopped" && session.status !== "error",
        ) ||
        projection.providerThreads.some(
          (thread) =>
            thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
        ) ||
        projection.turnItems.some(
          (item) =>
            ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
            ["pending", "running", "waiting"].includes(item.status) &&
            !projection.runs.some((run) => run.id === item.runId && run.status === "rolled_back"),
        )
      );
  }
}

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  const updated = [...items];
  updated[index] = next;
  return updated;
}

export function upsertProviderTurn(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  next: OrchestrationV2ProviderTurn,
): Array<OrchestrationV2ProviderTurn> {
  const current = turns.find((turn) => turn.id === next.id);
  return upsertById(turns, {
    ...next,
    ...((next.tokenUsage ?? current?.tokenUsage) === undefined
      ? {}
      : { tokenUsage: next.tokenUsage ?? current?.tokenUsage }),
  });
}

/** A stale run snapshot must not erase fields that other events recorded on the run. */
function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  if (current === undefined) return next;
  return {
    ...next,
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
  };
}

function preserveCompletionDelivery(
  current: OrchestrationV2Subagent | undefined,
  next: OrchestrationV2Subagent,
): OrchestrationV2Subagent {
  if (next.completionDelivery !== undefined || current?.completionDelivery === undefined) {
    return next;
  }
  return { ...next, completionDelivery: current.completionDelivery };
}

export function emptyProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return {
    thread: event.payload,
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: event.occurredAt,
  };
}

// A future queued provider has a reserved thread record but is not active until delivery.
function isQueuedProviderThreadPlaceholder(providerThread: OrchestrationV2ProviderThread): boolean {
  return (
    providerThread.status === "not_loaded" &&
    providerThread.firstRunOrdinal === null &&
    providerThread.nativeThreadRef === null &&
    providerThread.providerSessionId === null
  );
}

export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  const base = {
    ...projection,
    thread: {
      ...projection.thread,
      updatedAt: event.occurredAt,
    },
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return {
        ...base,
        thread: event.payload,
      };
    // Visited tracking is read state, not activity: skip the updatedAt bump so
    // viewing a thread does not surface it as recently active.
    case "thread.visited":
    case "thread.marked-unread":
      return {
        ...projection,
        thread: event.payload,
      };
    case "run.created":
    case "run.updated":
      return withLocalVisibleTurnItems({
        ...base,
        runs: upsertById(
          base.runs,
          preserveRunRecordedFields(
            base.runs.find((run) => run.id === event.payload.id),
            event.payload,
          ),
        ),
      });
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run-attempt.created":
    case "run-attempt.updated":
      return withLocalVisibleTurnItems({
        ...base,
        attempts: upsertById(base.attempts, event.payload),
      });
    case "node.updated":
      return {
        ...base,
        nodes: upsertById(base.nodes, event.payload),
      };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertById(
          base.subagents,
          preserveCompletionDelivery(
            base.subagents.find((task) => task.id === event.payload.id),
            event.payload,
          ),
        ),
      };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertById(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return {
        ...base,
        thread:
          event.payload.appThreadId === base.thread.id &&
          !isQueuedProviderThreadPlaceholder(event.payload)
            ? {
                ...base.thread,
                activeProviderThreadId: event.payload.id,
              }
            : base.thread,
        providerThreads: upsertById(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertProviderTurn(base.providerTurns, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertById(base.runtimeRequests, event.payload),
      };
    case "message.updated":
      return {
        ...base,
        messages: upsertById(base.messages, event.payload),
      };
    case "turn-item.updated":
      return withLocalVisibleTurnItems({
        ...base,
        turnItems: upsertById(base.turnItems, event.payload),
      });
    case "plan.updated":
      return {
        ...base,
        plans: upsertById(base.plans, event.payload),
      };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertById(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return {
        ...base,
        checkpoints: upsertById(base.checkpoints, event.payload),
      };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertById(base.contextHandoffs, event.payload),
      };
    case "context-transfer.created":
    case "context-transfer.updated":
      return {
        ...base,
        contextTransfers: upsertById(base.contextTransfers, event.payload),
      };
  }
}

/**
 * Replay state for entities whose persisted projection is shared across thread bindings.
 *
 * Provider sessions are process-scoped: one session row can be bound to several app
 * threads. Updating that row changes what every bound thread reads, even though the
 * application event itself belongs to one thread stream. Keeping the binding index here
 * makes in-memory replay match the normalized SQL projection without scanning every
 * thread for every session event.
 */
export interface ProjectionReplayState {
  readonly projections: Map<ThreadId, OrchestrationV2ThreadProjection>;
  readonly providerSessionThreadIds: Map<ProviderSessionId, ReadonlySet<ThreadId>>;
}

function makeProjectionReplayState(): ProjectionReplayState {
  return {
    projections: new Map(),
    providerSessionThreadIds: new Map(),
  };
}

function applyToProjectionReplayState(
  state: ProjectionReplayState,
  event: OrchestrationV2DomainEvent,
): boolean {
  if (event.type === "thread.created" && !state.projections.has(event.threadId)) {
    state.projections.set(event.threadId, emptyProjection(event));
    return true;
  }

  const current = state.projections.get(event.threadId);
  if (current === undefined) {
    return false;
  }

  let next = applyToProjection(current, event);
  if (event.type === "provider-session.updated") {
    const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id);
    if (boundThreadIds?.has(event.threadId) !== true) {
      // The SQL projection updates the global session row but does not implicitly
      // create a thread binding for an update event.
      next = { ...next, providerSessions: current.providerSessions };
    }
  }
  state.projections.set(event.threadId, next);

  switch (event.type) {
    case "provider-session.attached": {
      const boundThreadIds = new Set(state.providerSessionThreadIds.get(event.payload.id) ?? []);
      boundThreadIds.add(event.threadId);
      state.providerSessionThreadIds.set(event.payload.id, boundThreadIds);
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.updated": {
      const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id) ?? [];
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.detached": {
      const boundThreadIds = new Set(
        state.providerSessionThreadIds.get(event.payload.providerSessionId) ?? [],
      );
      boundThreadIds.delete(event.threadId);
      if (boundThreadIds.size === 0) {
        state.providerSessionThreadIds.delete(event.payload.providerSessionId);
      } else {
        state.providerSessionThreadIds.set(event.payload.providerSessionId, boundThreadIds);
      }
      break;
    }
  }

  return true;
}

type PayloadRow = {
  readonly payload_json: string;
};

type ShellThreadRow = {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly forked_from_run_source_thread_id: string | null;
  readonly latest_run_id: string | null;
  readonly latest_run_status: string | null;
  readonly latest_run_requested_at: string | null;
  readonly latest_run_started_at: string | null;
  readonly latest_run_completed_at: string | null;
  readonly latest_run_work_completed_at: string | null;
  readonly active_run_id: string | null;
  readonly activity_run_status: string | null;
  readonly activity_run_started_at: string | null;
  readonly activity_run_work_completed_at: string | null;
  readonly last_error: string | null;
  readonly terminal_failure_payload_json: string | null;
  readonly blocking_run_id: string | null;
  readonly blocking_run_requested_at: string | null;
  readonly blocking_run_started_at: string | null;
  readonly blocking_run_completed_at: string | null;
  readonly blocking_run_work_completed_at: string | null;
  readonly blocking_failure_payload_json: string | null;
  readonly pending_request_payload_json: string | null;
  readonly pending_secret_request_payload_json: string | null;
  readonly latest_user_message_at: string | null;
  readonly latest_user_authored_message_at: string | null;
  readonly has_actionable_proposed_plan: number;
  readonly item_count: number;
  readonly runless_item_count: number;
};

type ShellRunRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly ordinal: number;
};

type SettlementThreadRow = Pick<
  ShellThreadRow,
  | "thread_id"
  | "payload_json"
  | "latest_run_id"
  | "latest_run_status"
  | "latest_run_requested_at"
  | "latest_run_started_at"
  | "latest_run_completed_at"
  | "latest_run_work_completed_at"
  | "latest_user_message_at"
  | "latest_user_authored_message_at"
>;

type ShellRunItemCountRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly item_count: number;
};

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const CONVERSATION_INDEX_EXCLUDED_TYPE_NAMES = [
  "command_execution",
  "reasoning",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
];
const CONVERSATION_INDEX_EXCLUDED_TYPE_SQL = `(${CONVERSATION_INDEX_EXCLUDED_TYPE_NAMES.map(
  (type) => `'${type}'`,
).join(", ")})`;

// Typed conversation reads use the partial index; run and node filters keep their narrower plans.
const readsConversationItemsOnly = (filter: ProjectionRecordFilter | undefined) =>
  filter?.turnItemTypes !== undefined &&
  filter.turnItemRunId === undefined &&
  filter.turnItemRunIds === undefined &&
  filter.turnItemNodeIds === undefined &&
  filter.turnItemTypes.every((type) =>
    CONVERSATION_INDEX_EXCLUDED_TYPE_NAMES.every((excluded) => excluded !== type),
  );

const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const encodeRunPayload = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJsonSchema));
const encodeRestartCancelledBackgroundWork = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema.fields.restartCancelledBackgroundWork),
);
const encodeRunAttemptPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const encodeNodePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const encodeSubagentPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const encodeProviderSessionPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
const encodeProviderThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const encodeProviderTurnPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const encodeRuntimeRequestPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const encodeMessagePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const encodePlanPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);
const encodeTurnItemPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const encodeCheckpointScopePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const encodeCheckpointPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const encodeContextHandoffPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const encodeContextTransferPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const decodeRunPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);
const decodeRunAttemptPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const decodeNodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const decodeSubagentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const decodeProviderSessionPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
const decodeProviderThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const decodeProviderTurnPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const decodeRuntimeRequestPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const decodeMessagePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const decodePlanArtifact = Schema.decodeUnknownEffect(OrchestrationV2PlanArtifactSchema);
const decodePlanPayload = (json: string) => decodePlanArtifact(parseEncodedPayload(json));
const decodeTurnItemPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const decodeCheckpointScopePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const decodeCheckpointPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const decodeContextHandoffPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const decodeContextTransferPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);
const isProjectionStoreReadError = Schema.is(ProjectionStoreReadError);

function parseEncodedPayload(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : String(value);
}

function nullableStringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

function booleanInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

const decodeRows =
  <A, E>(decode: (json: string) => Effect.Effect<A, E>, threadId: ThreadId) =>
  (rows: ReadonlyArray<PayloadRow>): Effect.Effect<Array<A>, ProjectionStoreReadError> =>
    Effect.forEach(rows, (row) => decode(row.payload_json)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionStoreReadError({
            threadId,
            cause,
          }),
      ),
    );

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return projection.turnItems
    .filter((item) =>
      isOrchestrationV2TurnItemVisible({
        item,
        runs: projection.runs,
        attempts: projection.attempts,
        items: projection.turnItems,
      }),
    )
    .map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    }));
}

function localVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return activeLocalTurnItems(projection);
}

function inheritedVisibleTurnItemsFromLocalItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  return items.map((item) => ({
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: localVisibleTurnItems(projection),
  };
}

function renumberVisibleTurnItems(
  rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
): Array<OrchestrationV2ProjectedTurnItem> {
  return rows.map((row, position) => ({ ...row, position }));
}

function makeForkMarkerTurnItem(input: {
  readonly targetProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Extract<OrchestrationV2TurnItem, { type: "fork" }> {
  const createdAt = input.targetProjection.thread.createdAt;
  return {
    id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
    threadId: input.targetProjection.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "fork",
    source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
    targetThreadId: input.targetProjection.thread.id,
  };
}

export function isTurnItemAtOrBeforeRun(input: {
  readonly historyOrigin: OrchestrationV2ThreadProjection["thread"]["historyOrigin"];
  readonly itemRunId: OrchestrationV2TurnItem["runId"];
  readonly runOrdinalById: ReadonlyMap<NonNullable<OrchestrationV2TurnItem["runId"]>, number>;
  readonly sourceRunOrdinal: number;
}): boolean {
  if (input.itemRunId === null) {
    return input.historyOrigin === "v1_import";
  }
  const ordinal = input.runOrdinalById.get(input.itemRunId);
  return ordinal !== undefined && ordinal <= input.sourceRunOrdinal;
}

function visibleTurnItemsThroughRun(input: {
  readonly sourceProjection: OrchestrationV2ThreadProjection;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (sourceRun === undefined) {
    return [];
  }

  const runOrdinalById = new Map(input.sourceProjection.runs.map((run) => [run.id, run.ordinal]));
  const inheritedPrefix = input.sourceProjection.visibleTurnItems
    .filter(
      (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
    )
    .map((row) => ({
      visibility: "inherited" as const,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: row.item,
    }));
  const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
    input.sourceProjection.turnItems.filter((item) => {
      if (
        isOrchestrationV2SupersededInterrupt({
          item,
          attempts: input.sourceProjection.attempts,
          items: input.sourceProjection.turnItems,
        })
      ) {
        return false;
      }
      return isTurnItemAtOrBeforeRun({
        historyOrigin: input.sourceProjection.thread.historyOrigin,
        itemRunId: item.runId,
        runOrdinalById,
        sourceRunOrdinal: sourceRun.ordinal,
      });
    }),
  );

  return [...inheritedPrefix, ...localPrefix];
}

function buildVisibleTurnItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceProjection: OrchestrationV2ThreadProjection | null;
}): Array<OrchestrationV2ProjectedTurnItem> {
  const forkedFrom = input.projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run" || input.sourceProjection === null) {
    return localVisibleTurnItems(input.projection);
  }

  const inherited = visibleTurnItemsThroughRun({
    sourceProjection: input.sourceProjection,
    sourceRunId: forkedFrom.runId,
  });
  const markerItem = makeForkMarkerTurnItem({
    targetProjection: input.projection,
    sourceThreadId: forkedFrom.threadId,
    sourceRunId: forkedFrom.runId,
  });
  const local = activeLocalTurnItems(input.projection).map((row) => ({
    visibility: "local" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));

  return renumberVisibleTurnItems([
    ...inherited,
    {
      visibility: "synthetic",
      sourceThreadId: forkedFrom.threadId,
      sourceItemId: markerItem.id,
      item: markerItem,
    },
    ...local,
  ]);
}

/**
 * An agent waiting on a secret is waiting on the user just like a question,
 * so the shell reports it as pending user input. Secret requests have no
 * runtime request of their own; this stands one in for the shell summary
 * only, keyed by the card's turn item.
 */
function secretRequestAsPendingInput(
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2ThreadProjection["runtimeRequests"][number] | null {
  if (item?.type !== "secret_request" || item.nodeId === null) return null;
  return {
    id: RuntimeRequestId.make(item.id),
    nodeId: item.nodeId,
    providerTurnId: item.providerTurnId,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: item.startedAt ?? item.updatedAt,
    resolvedAt: null,
  };
}

/**
 * Preserve the explicit OMP wait marker for open-run status presentation.
 * General background-work derivation intentionally excludes active runs.
 */
function activeBackgroundJobWaitSignal(
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
  activeProviderThreadId: ProviderThreadId | null,
): ReadonlyArray<NonNullable<OrchestrationV2ProviderThread["pendingBackgroundTasks"]>[number]> {
  const activeProviderThread = providerThreads.find(
    (providerThread) => providerThread.id === activeProviderThreadId,
  );
  return (activeProviderThread?.pendingBackgroundTasks ?? []).filter(isOmpAsyncJobWait);
}

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const providerSession =
    projection.providerSessions
      .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const latestRun =
    usageLimitRunPresentedAsLatest(
      projection.runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(projection.runs);
  const activeRun =
    projection.runs
      .filter(isInterruptibleRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const activityRun =
    projection.runs
      .filter(isActivityRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const liveRunIds = new Set(projection.runs.filter(isActivityRunForShell).map((run) => run.id));
  const pendingRuntimeRequest =
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )[0] ??
    secretRequestAsPendingInput(
      projection.turnItems
        .filter(
          (item) =>
            item.type === "secret_request" &&
            item.status === "waiting" &&
            item.runId !== null &&
            liveRunIds.has(item.runId),
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )[0] ?? null,
    );
  const userMessages = projection.messages
    .filter((message) => message.role === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const latestUserMessage = userMessages[0] ?? null;
  const derivedPendingBackgroundTasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
    pullRequests: projection.thread.pullRequests,
  });
  const pendingBackgroundTasks = [
    ...derivedPendingBackgroundTasks,
    ...(activeRun === null
      ? []
      : activeBackgroundJobWaitSignal(
          projection.providerThreads,
          projection.thread.activeProviderThreadId,
        )),
  ];
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    pullRequests: threadPullRequestsOf(projection.thread),
    ...(projection.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(projection.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: projection.thread.branchPullRequest }),
    ...(projection.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: projection.thread.activeOrderKey }),
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    ...(projection.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: projection.thread.historyOrigin }),
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    latestRunWorkCompletedAt: latestRun?.workCompletedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt:
      activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
    activityRunWorkCompletedAt: activityRun?.workCompletedAt ?? null,
    status: latestRun?.status ?? "idle",
    ...threadErrorSummary(
      latestRootProviderFailure(latestRun, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    pendingRuntimeRequest:
      pendingRuntimeRequest === null
        ? null
        : {
            id: pendingRuntimeRequest.id,
            kind: pendingRuntimeRequest.kind,
            createdAt: pendingRuntimeRequest.createdAt,
          },
    // Thread detail owns message bodies. Keeping them out of shell rows makes
    // initial hydration and streaming updates independent of transcript size.
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
    latestUserAuthoredMessageAt:
      userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    pendingBackgroundTasks: [...pendingBackgroundTasks],
    providerInstanceHistory: providerInstanceHistoryForShell({
      threadId: projection.thread.id,
      providerThreads: projection.providerThreads,
    }),
    goal: activeProviderGoalForShell(
      projection.providerThreads,
      projection.thread.activeProviderThreadId,
    ),
    itemCount: activeLocalTurnItems(projection).length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.updatedAt,
    archivedAt: projection.thread.archivedAt,
    settledOverride: projection.thread.settledOverride,
    settledAt: projection.thread.settledAt,
    unsettledAt: projection.thread.unsettledAt ?? null,
    snoozedUntil: projection.thread.snoozedUntil ?? null,
    snoozedAt: projection.thread.snoozedAt ?? null,
    lastSnoozeWakeAt: projection.thread.lastSnoozeWakeAt ?? null,
    pinnedAt: projection.thread.pinnedAt ?? null,

    autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: projection.thread.pinOrderKey ?? null,
    lastVisitedAt: projection.thread.lastVisitedAt,
    opens: projection.thread.opens ?? null,
    titleRegeneration: projection.thread.titleRegeneration ?? null,
    limitRecovery: projection.thread.limitRecovery ?? null,
    deletedAt: projection.thread.deletedAt,
  };
}

/**
 * Provider instances that have owned this thread's root conversation, oldest
 * first. Subagent provider threads carry an owner node and are excluded so a
 * delegated Codex child does not make a Claude thread look handed off.
 */
function providerInstanceHistoryForShell(input: {
  readonly threadId: ThreadId;
  readonly providerThreads: ReadonlyArray<
    OrchestrationV2ThreadProjection["providerThreads"][number]
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const history: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads
    .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )) {
    if (!history.includes(providerThread.providerInstanceId)) {
      history.push(providerThread.providerInstanceId);
    }
  }
  return history;
}

/** The native goal lives on the provider thread that currently owns the conversation. */
function activeProviderGoalForShell(
  providerThreads: ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>,
  activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ThreadShell["goal"] {
  return providerThreads.find((thread) => thread.id === activeProviderThreadId)?.goal ?? null;
}

function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

function isActivityRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
  readonly status: ShellActivityRunStatus;
} {
  return isInterruptibleRunForShell(run) || run.status === "waiting";
}

type ShellThreadState = {
  readonly thread: OrchestrationV2ThreadProjection["thread"];
  readonly latestRunId: RunId | null;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  readonly latestRunRequestedAt: DateTime.Utc | null;
  readonly latestRunStartedAt: DateTime.Utc | null;
  readonly latestRunCompletedAt: DateTime.Utc | null;
  readonly latestRunWorkCompletedAt: DateTime.Utc | null;
  readonly activeRunId: RunId | null;
  readonly activityRunStatus: ShellActivityRunStatus | null;
  readonly activityRunStartedAt: DateTime.Utc | null;
  readonly activityRunWorkCompletedAt: DateTime.Utc | null;
  readonly lastError: string | null;
  readonly lastErrorClass: OrchestrationV2ThreadShell["lastErrorClass"];
  readonly usageLimitResetAt: OrchestrationV2ThreadShell["usageLimitResetAt"];
  readonly pendingRuntimeRequest: OrchestrationV2ThreadProjection["runtimeRequests"][number] | null;
  readonly latestUserMessageAt: DateTime.Utc | null;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly providerInstanceHistory: OrchestrationV2ThreadShell["providerInstanceHistory"];
  readonly goal: OrchestrationV2ThreadShell["goal"];
  readonly itemCount: number;
  readonly runlessItemCount: number;
  readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
  readonly runOrdinalById: ReadonlyMap<RunId, number>;
  readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

function shellStatusFromStoredRunStatus(status: string | null): OrchestrationV2ShellThreadStatus {
  switch (status) {
    case null:
      return "idle";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return status;
    default:
      return "failed";
  }
}

function itemCountThroughRun(input: {
  readonly state: ShellThreadState;
  readonly runId: RunId;
}): number {
  const runOrdinal = input.state.runOrdinalById.get(input.runId);
  if (runOrdinal === undefined) {
    return 0;
  }

  let count = input.state.thread.historyOrigin === "v1_import" ? input.state.runlessItemCount : 0;
  for (const [runId, itemCount] of input.state.itemCountByRunId) {
    const itemRunOrdinal = input.state.runOrdinalById.get(runId);
    if (itemRunOrdinal !== undefined && itemRunOrdinal <= runOrdinal) {
      count += itemCount;
    }
  }
  return count;
}

/**
 * Threads that some shell row forks from at a run. Only these need run
 * ordinals and per-run item counts, to count the inherited prefix, so a thread
 * nobody forked from never pays for a scan of its run history.
 */
function shellForkSourceIds(
  rows: ReadonlyArray<{ readonly forked_from_run_source_thread_id: string | null }>,
): ReadonlyArray<ThreadId> {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.forked_from_run_source_thread_id === null
          ? []
          : [ThreadId.make(row.forked_from_run_source_thread_id)],
      ),
    ),
  ];
}

function visibleItemCountForShell(input: {
  readonly threadId: ThreadId;
  readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
  readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
  const state = input.statesByThreadId.get(input.threadId);
  if (state === undefined) {
    return 0;
  }

  const forkedFrom = state.thread.forkedFrom;
  if (forkedFrom?.type !== "run") {
    return state.itemCount;
  }

  const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
  if (seenThreadIds.has(state.thread.id)) {
    return state.itemCount;
  }

  const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
  if (sourceState === undefined) {
    return state.itemCount;
  }

  const sourceForkedFrom = sourceState.thread.forkedFrom;
  const inheritedPrefixCount =
    sourceForkedFrom?.type === "run"
      ? visibleItemCountForShell({
          threadId: sourceState.thread.id,
          statesByThreadId: input.statesByThreadId,
          seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
        }) - sourceState.itemCount
      : 0;

  return (
    inheritedPrefixCount +
    itemCountThroughRun({ state: sourceState, runId: forkedFrom.runId }) +
    1 +
    state.itemCount
  );
}

function shellFromState(input: {
  readonly state: ShellThreadState;
  readonly visibleItemCount: number;
}): OrchestrationV2ThreadShell {
  return {
    createdBy: input.state.thread.createdBy,
    creationSource: input.state.thread.creationSource,
    id: input.state.thread.id,
    projectId: input.state.thread.projectId,
    title: input.state.thread.title,
    providerInstanceId: input.state.thread.providerInstanceId,
    modelSelection: input.state.thread.modelSelection,
    runtimeMode: input.state.thread.runtimeMode,
    interactionMode: input.state.thread.interactionMode,
    branch: input.state.thread.branch,
    worktreePath: input.state.thread.worktreePath,
    pullRequests: threadPullRequestsOf(input.state.thread),
    ...(input.state.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: input.state.thread.linkedPullRequest }),
    ...(input.state.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.state.thread.branchPullRequest }),
    ...(input.state.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: input.state.thread.activeOrderKey }),
    lineage: input.state.thread.lineage,
    forkedFrom: input.state.thread.forkedFrom,
    activeProviderThreadId: input.state.thread.activeProviderThreadId,
    ...(input.state.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: input.state.thread.historyOrigin }),
    latestRunId: input.state.latestRunId,
    latestRunRequestedAt: input.state.latestRunRequestedAt,
    latestRunStartedAt: input.state.latestRunStartedAt,
    latestRunCompletedAt: input.state.latestRunCompletedAt,
    latestRunWorkCompletedAt: input.state.latestRunWorkCompletedAt,
    activeRunId: input.state.activeRunId,
    activityRunStatus: input.state.activityRunStatus,
    activityRunStartedAt: input.state.activityRunStartedAt,
    activityRunWorkCompletedAt: input.state.activityRunWorkCompletedAt,
    status: input.state.latestRunStatus,
    lastError: input.state.lastError,
    lastErrorClass: input.state.lastErrorClass,
    usageLimitResetAt: input.state.usageLimitResetAt,
    pendingRuntimeRequest:
      input.state.pendingRuntimeRequest === null
        ? null
        : {
            id: input.state.pendingRuntimeRequest.id,
            kind: input.state.pendingRuntimeRequest.kind,
            createdAt: input.state.pendingRuntimeRequest.createdAt,
          },
    latestVisibleMessage: null,
    latestUserMessageAt: input.state.latestUserMessageAt,
    latestUserAuthoredMessageAt: input.state.latestUserAuthoredMessageAt,
    hasActionableProposedPlan: input.state.hasActionableProposedPlan,
    pendingBackgroundTasks: input.state.pendingBackgroundTasks,
    providerInstanceHistory: input.state.providerInstanceHistory,
    goal: input.state.goal,
    itemCount: input.state.itemCount,
    visibleItemCount: input.visibleItemCount,
    createdAt: input.state.thread.createdAt,
    updatedAt: input.state.updatedAt,
    archivedAt: input.state.thread.archivedAt,
    settledOverride: input.state.thread.settledOverride,
    settledAt: input.state.thread.settledAt,
    unsettledAt: input.state.thread.unsettledAt ?? null,
    snoozedUntil: input.state.thread.snoozedUntil ?? null,
    snoozedAt: input.state.thread.snoozedAt ?? null,
    lastSnoozeWakeAt: input.state.thread.lastSnoozeWakeAt ?? null,
    pinnedAt: input.state.thread.pinnedAt ?? null,

    autoSettleDisabledAt: input.state.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: input.state.thread.pinOrderKey ?? null,
    lastVisitedAt: input.state.thread.lastVisitedAt,
    opens: input.state.thread.opens ?? null,
    titleRegeneration: input.state.thread.titleRegeneration ?? null,
    limitRecovery: input.state.thread.limitRecovery ?? null,
    deletedAt: input.state.thread.deletedAt,
  };
}

export const layer: Layer.Layer<ProjectionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const CONVERSATION_INDEX_EXCLUDED_TYPES = sql.literal(CONVERSATION_INDEX_EXCLUDED_TYPE_SQL);
    const LIVE_NODES_INDEX = sql.literal("INDEXED BY orchestration_v2_projection_nodes_live_idx");
    const todoListOfSettledRun = (row: Statement.Fragment) => sql`(
      ${row}.kind = 'todo_list' AND ${row}.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS todo_run
        WHERE todo_run.run_id = ${row}.run_id
          AND todo_run.status IN ('queued','preparing','starting','running','waiting')
      ))`;

    // For run upserts: a snapshot without `path` keeps the value another event recorded there.
    const keepRecordedRunField = (payload: Statement.Fragment, path: string) => sql`
      CASE
        WHEN json_type(excluded.payload_json, ${path}) IS NULL
          AND json_type(orchestration_v2_projection_runs.payload_json, ${path}) IS NOT NULL
        THEN json_set(
          ${payload},
          ${path},
          json_extract(orchestration_v2_projection_runs.payload_json, ${path})
        )
        ELSE ${payload}
      END
    `;

    const apply: ProjectionStoreV2Shape["apply"] = (event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.created":
          case "thread.archived":
          case "thread.unarchived":
          case "thread.deleted":
          case "thread.settled":
          case "thread.unsettled":
          case "thread.snoozed":
          case "thread.unsnoozed":
          case "thread.auto-settle-set":
          case "thread.pinned":
          case "thread.unpinned":
          case "thread.pin-reordered":
          case "thread.active-reordered":
          case "thread.visited":
          case "thread.marked-unread":
          case "thread.metadata-updated":
          case "thread.pull-request-synced":
          case "thread.runtime-mode-updated":
          case "thread.interaction-mode-updated":
          case "thread.model-selection-updated":
          case "thread.provider-switched": {
            const payloadJson = yield* encodeThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id,
                project_id,
                title,
                default_provider,
                provider_instance_id,
                runtime_mode,
                interaction_mode,
                active_provider_thread_id,
                created_at,
                updated_at,
                archived_at,
                deleted_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.projectId},
                ${event.payload.title},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.runtimeMode},
                ${event.payload.interactionMode},
                ${event.payload.activeProviderThreadId},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${nullableStringField(payload, "archivedAt")},
                ${nullableStringField(payload, "deletedAt")},
                ${payloadJson}
              )
              ON CONFLICT(thread_id)
              DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                default_provider = excluded.default_provider,
                provider_instance_id = excluded.provider_instance_id,
                runtime_mode = excluded.runtime_mode,
                interaction_mode = excluded.interaction_mode,
                active_provider_thread_id = excluded.active_provider_thread_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "run.created":
          case "run.updated": {
            const payloadJson = yield* encodeRunPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runs (
                run_id,
                thread_id,
                ordinal,
                provider,
                provider_instance_id,
                provider_thread_id,
                status,
                requested_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.ordinal},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.status},
                ${stringField(payload, "requestedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(run_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                ordinal = excluded.ordinal,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                status = excluded.status,
                requested_at = excluded.requested_at,
                completed_at = excluded.completed_at,
                payload_json = ${keepRecordedRunField(
                  keepRecordedRunField(sql`excluded.payload_json`, "$.delegatedCompletion"),
                  "$.restartCancelledBackgroundWork",
                )}
            `;
            break;
          }
          case "run.background-work-cancelled": {
            // Only this field changes, so a concurrent lifecycle write is never regressed.
            const workJson = yield* encodeRestartCancelledBackgroundWork(
              event.payload.restartCancelledBackgroundWork,
            );
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_set(
                payload_json,
                '$.restartCancelledBackgroundWork',
                json(${workJson})
              )
              WHERE run_id = ${event.payload.runId} AND thread_id = ${event.threadId}
            `;
            break;
          }
          case "run-attempt.created":
          case "run-attempt.updated": {
            const payloadJson = yield* encodeRunAttemptPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_run_attempts (
                attempt_id,
                thread_id,
                run_id,
                attempt_ordinal,
                root_node_id,
                provider,
                provider_instance_id,
                provider_thread_id,
                provider_turn_id,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.runId},
                ${event.payload.attemptOrdinal},
                ${event.payload.rootNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(attempt_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                attempt_ordinal = excluded.attempt_ordinal,
                root_node_id = excluded.root_node_id,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "node.updated": {
            const payloadJson = yield* encodeNodePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_nodes (
                node_id,
                thread_id,
                run_id,
                parent_node_id,
                root_node_id,
                kind,
                status,
                provider_thread_id,
                provider_turn_id,
                runtime_request_id,
                checkpoint_scope_id,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.rootNodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.runtimeRequestId},
                ${event.payload.checkpointScopeId},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(node_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                root_node_id = excluded.root_node_id,
                kind = excluded.kind,
                status = excluded.status,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                runtime_request_id = excluded.runtime_request_id,
                checkpoint_scope_id = excluded.checkpoint_scope_id,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "subagent.updated": {
            const payloadJson = yield* encodeSubagentPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_subagents (
                subagent_id,
                thread_id,
                run_id,
                parent_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_thread_id,
                child_thread_id,
                origin,
                status,
                started_at,
                completed_at,
                updated_at,
                completion_delivery_state,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.childThreadId},
                ${event.payload.origin},
                ${event.payload.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${stringField(payload, "updatedAt")},
                ${event.payload.completionDelivery?.state ?? null},
                ${payloadJson}
              )
              ON CONFLICT(subagent_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                child_thread_id = excluded.child_thread_id,
                origin = excluded.origin,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at,
                completion_delivery_state = COALESCE(
                  excluded.completion_delivery_state,
                  orchestration_v2_projection_subagents.completion_delivery_state
                ),
                payload_json = CASE
                  WHEN json_type(excluded.payload_json, '$.completionDelivery') IS NULL
                    AND json_type(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery') IS NOT NULL
                  THEN json_set(
                    excluded.payload_json,
                    '$.completionDelivery',
                    json_extract(
                      orchestration_v2_projection_subagents.payload_json,
                      '$.completionDelivery'
                    )
                  )
                  ELSE excluded.payload_json
                END
            `;
            break;
          }
          case "provider-session.attached":
          case "provider-session.updated": {
            const payloadJson = yield* encodeProviderSessionPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_sessions (
                provider_session_id,
                thread_id,
                provider,
                driver,
                provider_instance_id,
                status,
                model,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.status},
                ${event.payload.model},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_session_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                status = excluded.status,
                model = excluded.model,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            if (event.type === "provider-session.attached") {
              yield* sql`
                INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings (
                  provider_session_id,
                  thread_id
                )
                VALUES (${event.payload.id}, ${event.threadId})
              `;
            }
            break;
          }
          case "provider-session.detached": {
            yield* sql`
              DELETE FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id = ${event.payload.providerSessionId}
                AND thread_id = ${event.threadId}
            `;
            break;
          }
          case "provider-thread.updated": {
            const payloadJson = yield* encodeProviderThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_threads (
                provider_thread_id,
                thread_id,
                owner_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_session_id,
                status,
                first_run_ordinal,
                last_run_ordinal,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.appThreadId},
                ${event.payload.ownerNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerSessionId},
                ${event.payload.status},
                ${event.payload.firstRunOrdinal},
                ${event.payload.lastRunOrdinal},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_thread_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                owner_node_id = excluded.owner_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_session_id = excluded.provider_session_id,
                status = excluded.status,
                first_run_ordinal = excluded.first_run_ordinal,
                last_run_ordinal = excluded.last_run_ordinal,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            if (
              event.payload.appThreadId !== null &&
              !isQueuedProviderThreadPlaceholder(event.payload)
            ) {
              const threadRows = yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_threads
                WHERE thread_id = ${event.payload.appThreadId}
                LIMIT 1
              `;
              const threadRow = threadRows[0];
              if (threadRow !== undefined) {
                const thread = yield* decodeThreadPayload(threadRow.payload_json);
                const updatedThread = {
                  ...thread,
                  activeProviderThreadId: event.payload.id,
                  updatedAt: event.payload.updatedAt,
                };
                const updatedThreadPayloadJson = yield* encodeThreadPayload(updatedThread);
                yield* sql`
                  UPDATE orchestration_v2_projection_threads
                  SET
                    active_provider_thread_id = ${event.payload.id},
                    updated_at = ${stringField(parseEncodedPayload(updatedThreadPayloadJson), "updatedAt")},
                    payload_json = ${updatedThreadPayloadJson}
                  WHERE thread_id = ${event.payload.appThreadId}
                `;
              }
            }
            break;
          }
          case "provider-turn.updated": {
            const existingRows =
              event.payload.tokenUsage === undefined
                ? yield* sql<PayloadRow>`
                    SELECT payload_json
                    FROM orchestration_v2_projection_provider_turns
                    WHERE provider_turn_id = ${event.payload.id}
                    LIMIT 1
                  `
                : [];
            const existing = existingRows[0];
            const providerTurn =
              existing === undefined
                ? event.payload
                : upsertProviderTurn(
                    [yield* decodeProviderTurnPayload(existing.payload_json)],
                    event.payload,
                  )[0]!;
            const payloadJson = yield* encodeProviderTurnPayload(providerTurn);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_turns (
                provider_turn_id,
                thread_id,
                provider_thread_id,
                node_id,
                run_attempt_id,
                ordinal,
                status,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${providerTurn.providerThreadId},
                ${providerTurn.nodeId},
                ${providerTurn.runAttemptId},
                ${providerTurn.ordinal},
                ${providerTurn.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_turn_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider_thread_id = excluded.provider_thread_id,
                node_id = excluded.node_id,
                run_attempt_id = excluded.run_attempt_id,
                ordinal = excluded.ordinal,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "runtime-request.updated": {
            const payloadJson = yield* encodeRuntimeRequestPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runtime_requests (
                runtime_request_id,
                thread_id,
                node_id,
                provider_turn_id,
                kind,
                status,
                created_at,
                resolved_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.nodeId},
                ${event.payload.providerTurnId},
                ${event.payload.kind},
                ${event.payload.status},
                ${stringField(payload, "createdAt")},
                ${nullableStringField(payload, "resolvedAt")},
                ${payloadJson}
              )
              ON CONFLICT(runtime_request_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                node_id = excluded.node_id,
                provider_turn_id = excluded.provider_turn_id,
                kind = excluded.kind,
                status = excluded.status,
                created_at = excluded.created_at,
                resolved_at = excluded.resolved_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "message.updated": {
            const payloadJson = yield* encodeMessagePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_messages (
                message_id,
                thread_id,
                run_id,
                node_id,
                role,
                streaming,
                created_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.role},
                ${booleanInt(event.payload.streaming)},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(message_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                role = excluded.role,
                streaming = excluded.streaming,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "plan.updated": {
            const payloadJson = yield* encodePlanPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_plans (
                plan_id,
                thread_id,
                run_id,
                node_id,
                kind,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(plan_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                kind = excluded.kind,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "turn-item.updated": {
            const payloadJson = yield* encodeTurnItemPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id,
                thread_id,
                run_id,
                node_id,
                provider_thread_id,
                provider_turn_id,
                parent_item_id,
                ordinal,
                type,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.parentItemId},
                ${event.payload.ordinal},
                ${event.payload.type},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(turn_item_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                parent_item_id = excluded.parent_item_id,
                ordinal = excluded.ordinal,
                type = excluded.type,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint-scope.created": {
            const payloadJson = yield* encodeCheckpointScopePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoint_scopes (
                scope_id,
                thread_id,
                run_id,
                node_id,
                parent_scope_id,
                provider_thread_id,
                kind,
                ordinal_within_parent,
                advances_app_run_count,
                created_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentScopeId},
                ${event.payload.providerThreadId},
                ${event.payload.kind},
                ${event.payload.ordinalWithinParent},
                ${booleanInt(event.payload.advancesAppRunCount)},
                ${stringField(payload, "createdAt")},
                ${payloadJson}
              )
              ON CONFLICT(scope_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_scope_id = excluded.parent_scope_id,
                provider_thread_id = excluded.provider_thread_id,
                kind = excluded.kind,
                ordinal_within_parent = excluded.ordinal_within_parent,
                advances_app_run_count = excluded.advances_app_run_count,
                created_at = excluded.created_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.captured": {
            const payloadJson = yield* encodeCheckpointPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoints (
                checkpoint_id,
                thread_id,
                scope_id,
                run_id,
                node_id,
                parent_checkpoint_id,
                ordinal_within_scope,
                app_run_ordinal,
                status,
                captured_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.scopeId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentCheckpointId},
                ${event.payload.ordinalWithinScope},
                ${event.payload.appRunOrdinal},
                ${event.payload.status},
                ${stringField(payload, "capturedAt")},
                ${payloadJson}
              )
              ON CONFLICT(checkpoint_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                scope_id = excluded.scope_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_checkpoint_id = excluded.parent_checkpoint_id,
                ordinal_within_scope = excluded.ordinal_within_scope,
                app_run_ordinal = excluded.app_run_ordinal,
                status = excluded.status,
                captured_at = excluded.captured_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.rollback-requested":
            break;
          case "context-handoff.updated": {
            const payloadJson = yield* encodeContextHandoffPayload(
              packContextHandoffDelivery(event.payload),
            );
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_handoffs (
                context_handoff_id,
                thread_id,
                target_run_id,
                to_provider_thread_id,
                strategy,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.targetRunId},
                ${event.payload.toProviderThreadId},
                ${event.payload.strategy},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_handoff_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                target_run_id = excluded.target_run_id,
                to_provider_thread_id = excluded.to_provider_thread_id,
                strategy = excluded.strategy,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "context-transfer.created":
          case "context-transfer.updated": {
            const payloadJson = yield* encodeContextTransferPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_transfers (
                context_transfer_id,
                source_thread_id,
                target_thread_id,
                target_run_id,
                type,
                status,
                source_provider,
                target_provider,
                source_provider_instance_id,
                target_provider_instance_id,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.sourceThreadId},
                ${event.payload.targetThreadId},
                ${event.payload.targetRunId},
                ${event.payload.type},
                ${event.payload.status},
                ${event.payload.sourceProviderInstanceId},
                ${event.payload.targetProviderInstanceId},
                ${event.payload.sourceProviderInstanceId},
                ${event.payload.targetProviderInstanceId},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_transfer_id)
              DO UPDATE SET
                source_thread_id = excluded.source_thread_id,
                target_thread_id = excluded.target_thread_id,
                target_run_id = excluded.target_run_id,
                type = excluded.type,
                status = excluded.status,
                source_provider = excluded.source_provider,
                target_provider = excluded.target_provider,
                source_provider_instance_id = excluded.source_provider_instance_id,
                target_provider_instance_id = excluded.target_provider_instance_id,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
        }

        if (
          event.type !== "thread.created" &&
          event.type !== "thread.archived" &&
          event.type !== "thread.unarchived" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.settled" &&
          event.type !== "thread.unsettled" &&
          event.type !== "thread.snoozed" &&
          event.type !== "thread.unsnoozed" &&
          event.type !== "thread.auto-settle-set" &&
          event.type !== "thread.pinned" &&
          event.type !== "thread.unpinned" &&
          event.type !== "thread.pin-reordered" &&
          event.type !== "thread.visited" &&
          event.type !== "thread.marked-unread" &&
          event.type !== "thread.metadata-updated" &&
          event.type !== "thread.runtime-mode-updated" &&
          event.type !== "thread.interaction-mode-updated" &&
          event.type !== "thread.model-selection-updated" &&
          event.type !== "thread.provider-switched"
        ) {
          // Only the activity timestamp changes. Streamed runs, nodes and turn items do not
          // need the thread payload decoded and serialized for every update.
          const updatedAt = yield* Schema.encodeEffect(
            OrchestrationV2AppThreadJsonSchema.fields.updatedAt,
          )(event.occurredAt);
          yield* sql`
            UPDATE orchestration_v2_projection_threads
            SET
              updated_at = ${updatedAt},
              payload_json = json_set(payload_json, '$.updatedAt', ${updatedAt})
            WHERE thread_id = ${event.threadId}
          `;
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStoreApplyEventError({
              eventType: event.type,
              cause,
            }),
        ),
      );

    const readCanonicalProjection = (
      threadId: ThreadId,
      window?: {
        readonly rowLimit: number;
        readonly userTurnLimit?: number | undefined;
        readonly anchorItemId?: TurnItemId | undefined;
        readonly requiredRunId?: RunId | undefined;
        readonly suppressLocal?: boolean | undefined;
        readonly compact?: boolean | undefined;
      },
      fields?: ReadonlyArray<ProjectionRecordField>,
      filter?: ProjectionRecordFilter,
    ) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const threadRow = threadRows[0];
        if (!threadRow) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        const compactionFilter = filter?.sinceLastCompaction;
        const recentRunIds =
          window === undefined && compactionFilter !== undefined
            ? yield* sql<{ readonly run_id: RunId }>`
                WITH compaction AS (
                  SELECT run.ordinal, run.requested_at
                  FROM orchestration_v2_projection_turn_items AS item
                    INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
                  INNER JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
                  WHERE item.thread_id = ${threadId}
                    AND item.type = 'compaction'
                    AND item.status = 'completed'
                    AND item.type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
                    AND run.status <> 'rolled_back'
                  ORDER BY item.ordinal DESC
                  LIMIT 1
                )
                SELECT run.run_id
                FROM compaction
                INNER JOIN orchestration_v2_projection_runs AS run ON run.thread_id = ${threadId}
                WHERE run.ordinal >= compaction.ordinal
                  OR run.completed_at IS NULL
                  OR run.completed_at >= compaction.requested_at
                  OR run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                UNION
                SELECT message.run_id
                FROM compaction
                INNER JOIN orchestration_v2_projection_messages AS message
                  ON message.message_id = ${compactionFilter.keepMessageId}
                WHERE message.thread_id = ${threadId} AND message.run_id IS NOT NULL
              `
            : null;
        const recentRunIdList =
          recentRunIds === null || compactionFilter === undefined || recentRunIds.length === 0
            ? null
            : encodeIdList([
                ...recentRunIds.map((row) => row.run_id),
                ...compactionFilter.keepRunIds,
              ]);
        const inRecentRuns = (column: string) =>
          recentRunIdList === null
            ? sql``
            : sql`AND ${sql.literal(column)} IN (SELECT value FROM json_each(${recentRunIdList}))`;
        // An id list already names the rows; the unary plus keeps SQLite on that
        // id index rather than walking the whole thread.
        const threadColumn = (ids: ReadonlyArray<unknown> | undefined, column = "thread_id") =>
          sql.literal(ids === undefined ? column : `+${column}`);
        const settledSubagent = (row: Statement.Fragment) => sql`(
          ${row}.status IN ('completed', 'failed', 'cancelled', 'interrupted')
          AND COALESCE(${row}.completion_delivery_state, '')
            IN ('acknowledged', 'delivered', 'disposed')
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs AS active_run
            WHERE active_run.run_id = ${row}.run_id
              AND active_run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          )
        )`;
        const unsettledSubagentRowids = sql`
          SELECT candidate.rowid
          FROM orchestration_v2_projection_subagents AS candidate
            INDEXED BY orchestration_v2_projection_subagents_settled_idx
          WHERE candidate.thread_id = ${threadId}
            AND NOT ${settledSubagent(sql`candidate`)}
        `;

        const boundedTurnItemRows =
          fields !== undefined && !fields.includes("turnItems")
            ? []
            : window === undefined
              ? yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_turn_items
                ${
                  readsConversationItemsOnly(filter)
                    ? sql`INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
                WHERE thread_id = ${threadId} AND type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}`
                    : sql`WHERE thread_id = ${threadId}`
                }
                  ${filter?.turnItemTypes === undefined ? sql`` : sql`AND type IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemTypes)}))`}
                  ${filter?.turnItemStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemStatuses)}))`}
                  ${filter?.turnItemRunId === undefined ? sql`` : sql`AND run_id = ${filter.turnItemRunId}`}
                  ${filter?.turnItemNodeIds === undefined ? sql`` : sql`AND node_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemNodeIds)}))`}
                  ${filter?.turnItemRunIds === undefined ? sql`` : sql`AND (run_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemRunIds.filter((id): id is RunId => id !== null))})) OR (${filter.turnItemRunIds.includes(null) ? 1 : 0} = 1 AND run_id IS NULL))`}
                ORDER BY ordinal ASC, turn_item_id ASC
              `
              : yield* sql<PayloadRow>`
                WITH eligible AS NOT MATERIALIZED (
                  SELECT item.payload_json, item.ordinal, item.turn_item_id,
                    item.run_id, item.node_id, item.type
                  FROM orchestration_v2_projection_turn_items AS item
                  LEFT JOIN orchestration_v2_projection_runs AS run
                    ON run.run_id = item.run_id
                  WHERE item.thread_id = ${threadId}
                    AND item.ordinal <= COALESCE(
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${threadId}
                          AND turn_item_id = ${window.anchorItemId ?? null}
                        LIMIT 1
                      ),
                      9223372036854775807
                    )
                    AND (
                      ${window.requiredRunId ?? null} IS NOT NULL
                      OR (
                        (run.status IS NULL OR run.status <> 'rolled_back')
                        AND NOT (
                          item.type = 'user_message'
                          AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
                          AND run.status IS 'cancelled'
                        )
                      )
                    )
                    AND (
                      ${window.requiredRunId ?? null} IS NULL
                      OR (
                        item.run_id IS NULL
                        AND EXISTS (
                          SELECT 1
                          FROM orchestration_v2_projection_threads AS source_thread
                          WHERE source_thread.thread_id = item.thread_id
                            AND json_extract(source_thread.payload_json, '$.historyOrigin') = 'v1_import'
                        )
                      )
                      OR run.ordinal <= (
                        SELECT required_run.ordinal
                        FROM orchestration_v2_projection_runs AS required_run
                        WHERE required_run.thread_id = item.thread_id
                          AND required_run.run_id = ${window.requiredRunId ?? null}
                        LIMIT 1
                      )
                    )
                    AND NOT (
                      item.type = 'run_interrupt_result'
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_run_attempts AS attempt
                        WHERE attempt.run_id = item.run_id
                          AND attempt.root_node_id = item.node_id
                          AND attempt.status = 'superseded'
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_turn_items AS request
                        WHERE request.thread_id = item.thread_id
                          AND request.run_id = item.run_id
                          AND request.type = 'run_interrupt_request'
                      )
                    )
                ), turn_anchors AS (
                  -- The partial index omits work items, so recent turn starts don't walk a long
                  -- thread's command and tool rows.
                  SELECT item.ordinal, item.payload_json
                  FROM orchestration_v2_projection_turn_items AS item
                    INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
                  LEFT JOIN orchestration_v2_projection_runs AS run
                    ON run.run_id = item.run_id
                  WHERE item.thread_id = ${threadId}
                    AND item.ordinal <= COALESCE(
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${threadId}
                          AND turn_item_id = ${window.anchorItemId ?? null}
                        LIMIT 1
                      ),
                      9223372036854775807
                    )
                    AND item.type = 'user_message'
                    AND item.type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
                    AND json_extract(item.payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
                    AND ${window.userTurnLimit ?? null} IS NOT NULL
                    AND (
                      ${window.requiredRunId ?? null} IS NOT NULL
                      OR (
                        (run.status IS NULL OR run.status <> 'rolled_back')
                        AND NOT (
                          json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
                          AND run.status IS 'cancelled'
                        )
                      )
                    )
                    AND (
                      ${window.requiredRunId ?? null} IS NULL
                      OR (
                        item.run_id IS NULL
                        AND EXISTS (
                          SELECT 1
                          FROM orchestration_v2_projection_threads AS source_thread
                          WHERE source_thread.thread_id = item.thread_id
                            AND json_extract(source_thread.payload_json, '$.historyOrigin') = 'v1_import'
                        )
                      )
                      OR run.ordinal <= (
                        SELECT required_run.ordinal
                        FROM orchestration_v2_projection_runs AS required_run
                        WHERE required_run.thread_id = item.thread_id
                          AND required_run.run_id = ${window.requiredRunId ?? null}
                        LIMIT 1
                      )
                    )
                  ORDER BY item.ordinal DESC
                  LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                ),
                user_anchors AS (
                  SELECT ordinal
                  FROM turn_anchors
                  WHERE json_extract(payload_json, '$.createdBy') = 'user'
                  ORDER BY ordinal DESC
                  LIMIT ${(window.userTurnLimit ?? 0) + 2}
                ), boundary AS (
                  SELECT CASE
                    WHEN COUNT(*) >= ${(window.userTurnLimit ?? 0) + 2} THEN MIN(ordinal)
                    WHEN (SELECT COUNT(*) FROM turn_anchors) >= ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                      THEN (SELECT MIN(ordinal) FROM turn_anchors)
                    ELSE 0
                  END AS ordinal
                  FROM user_anchors
                ), latest_turn AS (
                  SELECT ordinal FROM turn_anchors ORDER BY ordinal DESC LIMIT 1
                ), long_turn AS (
                  SELECT COUNT(*) > ${window.rowLimit} AS oversized
                  FROM (
                    SELECT ordinal FROM eligible
                    WHERE ${
                      window.compact === true &&
                      window.anchorItemId === undefined &&
                      window.requiredRunId === undefined
                        ? 1
                        : 0
                    } = 1
                      AND ${window.userTurnLimit ?? null} IS NOT NULL
                      AND ordinal >= (SELECT ordinal FROM latest_turn)
                    ORDER BY ordinal DESC
                    LIMIT ${
                      Number.isSafeInteger(window.rowLimit) && window.rowLimit >= 0
                        ? window.rowLimit + 1
                        : 0
                    }
                  )
                ), conversational_selected AS (
                  SELECT ordinal, turn_item_id, run_id, type
                  FROM eligible
                  WHERE ordinal >= (SELECT ordinal FROM boundary)
                    AND (${window.compact === true ? 1 : 0} = 0 OR type IN ('user_message', 'assistant_message', 'proposed_plan'))
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT CASE
                    WHEN ${window.rowLimit} = 0 THEN 0
                    WHEN (SELECT oversized FROM long_turn) = 1 THEN ${window.rowLimit}
                    WHEN (SELECT COUNT(*) FROM user_anchors) > 0 THEN -1
                    ELSE ${window.rowLimit}
                  END
                ),
                activity_tail AS (
                  SELECT ordinal, turn_item_id, run_id, type
                  FROM eligible
                  WHERE ${window.compact === true ? 1 : 0} = 1
                    AND type NOT IN ('user_message', 'assistant_message', 'proposed_plan')
                    AND ordinal >= (SELECT ordinal FROM boundary)
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT ${window.rowLimit}
                ), selected AS (
                  SELECT ordinal, turn_item_id, run_id, type FROM conversational_selected
                  UNION ALL
                  SELECT ordinal, turn_item_id, run_id, type FROM activity_tail
                ), retained AS MATERIALIZED (
                  SELECT ordinal, turn_item_id FROM selected
                  UNION
                  SELECT request.ordinal, request.turn_item_id
                  FROM orchestration_v2_projection_turn_items AS request
                  WHERE request.run_id IN (
                      SELECT run_id FROM selected
                      WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
                    )
                    AND request.type = 'run_interrupt_request'
                  UNION
                  SELECT latest.ordinal, latest.turn_item_id
                  FROM (
                    SELECT ordinal, turn_item_id
                    FROM orchestration_v2_projection_turn_items
                    WHERE thread_id = ${threadId}
                      AND ${window.anchorItemId ?? null} IS NULL
                      AND ${window.requiredRunId ?? null} IS NULL
                    ORDER BY ordinal DESC, turn_item_id DESC
                    LIMIT 1
                  ) AS latest
                  ORDER BY ordinal ASC, turn_item_id ASC
                )
                SELECT item.payload_json
                FROM retained
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  ON item.turn_item_id = retained.turn_item_id
                ORDER BY retained.ordinal ASC, retained.turn_item_id ASC
              `;
        // Reuse the decoded items for cohort IDs and the resulting projection.
        // Parsing these rows separately duplicates every retained tool output.
        const turnItems = yield* decodeRows(decodeTurnItemPayload, threadId)(boundedTurnItemRows);
        const cohortJson = (field: string) =>
          JSON.stringify(
            turnItems.flatMap((payload) => {
              const value = nullableStringField(payload, field);
              return value === null ? [] : [value];
            }),
          );
        const cohortRunIds = cohortJson("runId");
        // A run can contain thousands of completed nodes. Load the visible
        // nodes and live control dependencies, then walk only their ancestors.
        const cohortNodeIds =
          window === undefined
            ? cohortJson("nodeId")
            : encodeIdList(
                (yield* sql<{ readonly node_id: string }>`
            WITH RECURSIVE retained(node_id) AS (
              SELECT value FROM json_each(${cohortJson("nodeId")})
              UNION
              SELECT node_id FROM orchestration_v2_projection_nodes AS live
                ${LIVE_NODES_INDEX}
              WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
                AND NOT ${todoListOfSettledRun(sql`live`)}
              UNION
              SELECT root_node_id FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND (
                status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null})
              UNION
              SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND (
                status IN ('queued','preparing','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null})
              UNION
              SELECT node_id FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND status IN ('pending','waiting')
              UNION
              SELECT parent_node_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
              UNION
              SELECT node_id FROM orchestration_v2_projection_provider_turns
              WHERE thread_id = ${threadId} AND status IN ('starting','running','waiting')
              UNION
              SELECT parent.parent_node_id FROM orchestration_v2_projection_nodes AS parent
              INNER JOIN retained ON parent.node_id = retained.node_id
              WHERE parent.thread_id = ${threadId} AND parent.parent_node_id IS NOT NULL
            )
            SELECT node_id FROM retained WHERE node_id IS NOT NULL
          `).map((row) => row.node_id),
              );
        const cohortProviderThreadIds = cohortJson("providerThreadId");
        const cohortProviderTurnIds = cohortJson("providerTurnId");
        const cohortMessageIds = cohortJson("messageId");
        const cohortPlanIds = cohortJson("planId");
        const cohortCheckpointIds = cohortJson("checkpointId");
        const cohortHandoffIds = cohortJson("contextHandoffId");

        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          planRows,
          checkpointScopeRows,
          checkpointRows,
          contextHandoffRows,
          contextTransferRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRow.payload_json),
          fields !== undefined && !fields.includes("runs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              ${filter?.runIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.runIds)}))`}
            ORDER BY ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND (status IN ('queued','preparing','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null})
            ORDER BY ordinal ASC
          `,
          fields !== undefined && !fields.includes("attempts")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
              ${inRecentRuns("run_id")}
            ORDER BY run_id ASC, attempt_ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds})))
            ORDER BY run_id ASC, attempt_ordinal ASC
          `,
          fields !== undefined && !fields.includes("nodes")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_nodes AS node
            WHERE ${
              filter?.omitSettledLeafNodes === true
                ? sql`node.rowid IN (
                    SELECT rowid FROM orchestration_v2_projection_nodes
                      ${
                        recentRunIdList === null
                          ? sql``
                          : sql`INDEXED BY orchestration_v2_projection_nodes_thread_run_idx`
                      }
                    WHERE thread_id = ${threadId}
                      AND (kind IN ('tool_call', 'assistant_message', 'reasoning')
                        AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                        AND run_id IS NOT NULL) = 0
                      ${inRecentRuns("run_id")}
                    ${
                      filter.omitSettledSubagentRecords === true
                        ? sql`EXCEPT
                    SELECT settled_node.rowid
                    FROM orchestration_v2_projection_subagents AS settled
                      INDEXED BY orchestration_v2_projection_subagents_thread_idx
                    CROSS JOIN orchestration_v2_projection_nodes AS settled_node
                      ON settled_node.node_id = settled.subagent_id
                    WHERE settled.thread_id = ${threadId}
                      AND settled.rowid NOT IN (${unsettledSubagentRowids})`
                        : sql``
                    }
                    UNION ALL
                    SELECT rowid FROM orchestration_v2_projection_nodes
                    WHERE thread_id = ${threadId}
                      AND run_id IN (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId}
                          AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
                      )
                      AND kind IN ('tool_call', 'assistant_message', 'reasoning')
                      AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                  )`
                : sql`${threadColumn(filter?.nodeIds, "node.thread_id")} = ${threadId}
                    ${inRecentRuns("node.run_id")}`
            }
              ${filter?.nodeIds === undefined ? sql`` : sql`AND node.node_id IN (SELECT value FROM json_each(${encodeIdList(filter.nodeIds)}))`}
            ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId}
              AND node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
            ORDER BY COALESCE(started_at, ''), node_id ASC
          `,
          fields !== undefined && !fields.includes("subagents")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_subagents AS subagent
            WHERE subagent.thread_id = ${threadId}
              ${filter?.subagentIds === undefined ? sql`` : sql`AND subagent.subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentIds)}))`}
              ${filter?.subagentRunIds === undefined ? sql`` : sql`AND subagent.run_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentRunIds)}))`}
              ${
                filter?.omitSettledSubagents === true
                  ? sql`AND subagent.rowid IN (${unsettledSubagentRowids})`
                  : filter?.omitSettledSubagents !== undefined
                    ? sql`AND (
                      subagent.subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.omitSettledSubagents.except)}))
                      OR NOT ${settledSubagent(sql`subagent`)}
                    )`
                    : sql``
              }
            ORDER BY COALESCE(subagent.started_at, ''), subagent.subagent_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR parent_node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `,
          fields !== undefined && !fields.includes("providerSessions")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `
              : sql<PayloadRow>`
            SELECT DISTINCT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            LEFT JOIN orchestration_v2_projection_provider_threads AS threads
              ON threads.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
              AND (sessions.status IN ('starting','running','waiting')
                OR threads.provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds})))
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `,
          fields !== undefined && !fields.includes("providerThreads")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE (thread_id = ${threadId}
               OR owner_node_id IN (
                 SELECT node.node_id
                 FROM orchestration_v2_projection_nodes AS node
                 WHERE node.thread_id = ${threadId}
                   ${
                     filter?.omitSettledSubagentRecords === true
                       ? sql`AND node.node_id NOT IN (
                     SELECT settled.subagent_id
                     FROM orchestration_v2_projection_subagents AS settled
                       INDEXED BY orchestration_v2_projection_subagents_thread_idx
                     WHERE settled.thread_id = ${threadId}
                       AND settled.rowid NOT IN (${unsettledSubagentRowids})
                   )`
                       : sql``
                   }
               )
               OR ${
                 filter?.omitSettledSubagentRecords === true
                   ? sql`provider_thread_id IN (
                 SELECT provider_thread_id
                 FROM orchestration_v2_projection_subagents
                 WHERE rowid IN (${unsettledSubagentRowids})
                   AND provider_thread_id IS NOT NULL
               )
               OR (provider_session_id IN (
                   SELECT provider_session_id
                   FROM orchestration_v2_projection_provider_session_bindings
                   WHERE thread_id = ${threadId}
                 )
                 AND EXISTS (
                   SELECT 1 FROM orchestration_v2_projection_subagents AS owner
                   WHERE owner.provider_thread_id =
                       orchestration_v2_projection_provider_threads.provider_thread_id
                     AND owner.thread_id = ${threadId}
                 ))`
                   : sql`provider_thread_id IN (
                 SELECT provider_thread_id
                 FROM orchestration_v2_projection_subagents
                 WHERE thread_id = ${threadId}
                   AND provider_thread_id IS NOT NULL
               )`
               })
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE (thread_id = ${threadId} AND status = 'active')
              OR provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds}))
              OR owner_node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `,
          fields !== undefined && !fields.includes("providerTurns")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId}
              ${
                recentRunIdList === null
                  ? sql``
                  : sql`AND run_attempt_id IN (
                      SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                      WHERE thread_id = ${threadId} ${inRecentRuns("run_id")})`
              }
            ORDER BY provider_thread_id ASC, ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId}
              AND (status IN ('starting','running','waiting')
                OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY provider_thread_id ASC, ordinal ASC
          `,
          fields !== undefined && !fields.includes("runtimeRequests")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
            ORDER BY created_at ASC, runtime_request_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','waiting')
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
                OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds})))
            ORDER BY created_at ASC, runtime_request_id ASC
          `,
          fields !== undefined && !fields.includes("messages")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_messages
                ${recentRunIdList === null ? sql`` : sql`INDEXED BY orchestration_v2_projection_messages_run_idx`}
                WHERE ${recentRunIdList === null ? threadColumn(filter?.messageIds) : sql.literal("thread_id")} = ${threadId}
                  ${inRecentRuns("run_id")}
                  ${filter?.messageIds === undefined ? sql`` : sql`AND message_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageIds)}))`}
                  ${filter?.messageRoles === undefined ? sql`` : sql`AND role IN (SELECT value FROM json_each(${encodeIdList(filter.messageRoles)}))`}
                  ${filter?.messageRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageRunIds)}))`}
                ORDER BY created_at ASC, message_id ASC
              `
              : sql<PayloadRow>`
                -- The window's messages and live-run messages are both key lookups; an OR on
                -- thread_id otherwise walks every message the thread ever had.
                SELECT payload_json FROM (
                  SELECT message.payload_json, message.created_at, message.message_id
                  FROM json_each(${cohortMessageIds}) AS wanted
                  CROSS JOIN orchestration_v2_projection_messages AS message
                    ON message.message_id = wanted.value
                  WHERE message.thread_id = ${threadId}
                  UNION
                  SELECT message.payload_json, message.created_at, message.message_id
                  FROM orchestration_v2_projection_runs AS run
                  CROSS JOIN orchestration_v2_projection_messages AS message
                    ON message.run_id = run.run_id
                  WHERE run.thread_id = ${threadId}
                    AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    AND message.thread_id = ${threadId}
                )
                ORDER BY created_at ASC, message_id ASC
              `,
          fields !== undefined && !fields.includes("plans")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans
                WHERE thread_id = ${threadId} ORDER BY plan_id ASC
              `
              : sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans AS plan
                WHERE plan.thread_id = ${threadId}
                  AND (
                    (plan.status = 'active' AND NOT ${todoListOfSettledRun(sql`plan`)})
                    OR plan.plan_id IN (
                      SELECT value FROM json_each(${cohortPlanIds})
                    )
                  )
                ORDER BY plan_id ASC
              `,
          fields !== undefined && !fields.includes("checkpointScopes")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
              AND (run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `,
          fields !== undefined && !fields.includes("checkpoints")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','capturing')
                OR checkpoint_id = (
                  SELECT checkpoint_id FROM orchestration_v2_projection_checkpoints
                  WHERE thread_id = ${threadId} AND status = 'ready'
                    AND app_run_ordinal IS NOT NULL
                  ORDER BY app_run_ordinal DESC LIMIT 1
                )
                OR checkpoint_id IN (SELECT value FROM json_each(${cohortCheckpointIds}))
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `,
          fields !== undefined && !fields.includes("contextHandoffs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_context_handoffs
                WHERE thread_id = ${threadId} ORDER BY rowid ASC
              `
              : sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_context_handoffs AS handoff
                WHERE handoff.thread_id = ${threadId}
                  AND (
                    handoff.status IN ('pending', 'ready')
                    OR handoff.context_handoff_id IN (
                      SELECT value FROM json_each(${cohortHandoffIds})
                    )
                  )
                ORDER BY rowid ASC
              `,
          fields !== undefined && !fields.includes("contextTransfers")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_context_transfers
            WHERE ${
              filter?.contextTransferStatuses === undefined
                ? sql`source_thread_id = ${threadId} OR target_thread_id = ${threadId}`
                : sql`rowid IN (
                    SELECT rowid FROM orchestration_v2_projection_context_transfers
                    WHERE source_thread_id = ${threadId}
                      AND status IN (
                        SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)})
                      )
                    UNION
                    SELECT rowid FROM orchestration_v2_projection_context_transfers
                    WHERE target_thread_id = ${threadId}
                      AND status IN (
                        SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)})
                      )
                  )`
            }
            ORDER BY rowid ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_context_transfers
            WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
              AND (status IN ('pending','running','waiting')
                OR target_run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR json_extract(payload_json, '$.contextHandoffId') IN
                  (SELECT value FROM json_each(${cohortHandoffIds})))
            ORDER BY rowid ASC
          `,
        ]);

        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          plans,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodePlanPayload, threadId)(planRows),
          decodeRows(decodeCheckpointScopePayload, threadId)(checkpointScopeRows),
          decodeRows(decodeCheckpointPayload, threadId)(checkpointRows),
          decodeRows(decodeContextHandoffPayload, threadId)(contextHandoffRows),
          decodeRows(decodeContextTransferPayload, threadId)(contextTransferRows),
        ]);
        const messageOrdinals = new Map<string, number>();
        const userOnly = messages.every((message) => message.role === "user");
        const loadsEveryItemOf = (type: OrchestrationV2TurnItem["type"]) =>
          window === undefined &&
          (fields === undefined || fields.includes("turnItems")) &&
          filter?.turnItemStatuses === undefined &&
          filter?.turnItemRunId === undefined &&
          filter?.turnItemRunIds === undefined &&
          filter?.turnItemNodeIds === undefined &&
          (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(type));
        if (
          fields !== undefined &&
          fields.includes("messages") &&
          messages.length > 1 &&
          !(loadsEveryItemOf("user_message") && (userOnly || loadsEveryItemOf("assistant_message")))
        ) {
          const rows = yield* sql<{ message_id: string; ordinal: number }>`
            SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND type IN ('user_message', 'assistant_message')
            GROUP BY json_extract(payload_json, '$.messageId')
          `;
          for (const row of rows) messageOrdinals.set(row.message_id, row.ordinal);
        }
        const orderedMessages = sortMessagesByTurnItemOrder(messages, turnItems, messageOrdinals);
        const projection = {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages: orderedMessages,
          plans,
          turnItems,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
          visibleTurnItems: [],
          updatedAt: thread.updatedAt,
        } satisfies OrchestrationV2ThreadProjection;
        return fields === undefined ? withLocalVisibleTurnItems(projection) : projection;
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({
                threadId,
                cause,
              }),
        ),
      );

    const readProjection = (
      threadId: ThreadId,
      seenThreadIds: ReadonlySet<ThreadId>,
      window?: {
        readonly rowLimit: number;
        readonly userTurnLimit?: number | undefined;
        readonly anchorItemId?: TurnItemId | undefined;
        readonly requiredRunId?: RunId | undefined;
        readonly suppressLocal?: boolean | undefined;
        readonly compact?: boolean | undefined;
        readonly historyAnchor?:
          | { readonly threadId: ThreadId; readonly itemId: TurnItemId }
          | undefined;
      },
    ): Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error> =>
      Effect.gen(function* () {
        const localWindow =
          window?.suppressLocal === true ||
          (window?.historyAnchor !== undefined && window.historyAnchor.threadId !== threadId)
            ? { ...window, rowLimit: 0, anchorItemId: undefined }
            : window;
        const projection = yield* readCanonicalProjection(threadId, localWindow);
        const forkedFrom = projection.thread.forkedFrom;
        if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
          return withLocalVisibleTurnItems(projection);
        }

        // A row-limited segment without turn anchors must finish paging locally
        // before inherited user turns can influence the page boundary.
        if (
          window?.userTurnLimit !== undefined &&
          localWindow !== undefined &&
          localWindow.rowLimit > 0 &&
          projection.turnItems.length >= localWindow.rowLimit &&
          !projection.turnItems.some(isThreadHistoryUserTurn)
        ) {
          return withLocalVisibleTurnItems(projection);
        }

        const sourceWindow =
          window === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const historyAnchor = window.historyAnchor;
                const anchorBelongsToSource = historyAnchor?.threadId === forkedFrom.threadId;
                const rows = yield* sql<{ readonly turn_item_id: string }>`
                  WITH fork_run AS (
                    SELECT ordinal
                    FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${forkedFrom.threadId}
                      AND run_id = ${forkedFrom.runId}
                    LIMIT 1
                  ), fork_boundary AS (
                    SELECT (
                      SELECT item.ordinal
                      FROM orchestration_v2_projection_turn_items AS item
                      WHERE item.run_id = run.run_id
                      ORDER BY item.ordinal DESC
                      LIMIT 1
                    ) AS ordinal
                    FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${forkedFrom.threadId}
                      AND run.ordinal <= (SELECT ordinal FROM fork_run)
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_turn_items AS item
                        WHERE item.run_id = run.run_id
                        LIMIT 1
                      )
                    ORDER BY run.ordinal DESC
                    LIMIT 1
                  ), effective_boundary AS (
                    SELECT COALESCE(
                      (SELECT ordinal FROM fork_boundary),
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${forkedFrom.threadId}
                          AND run_id IS NULL
                          AND json_extract(payload_json, '$.historyOrigin') = 'v1_import'
                        ORDER BY ordinal DESC, turn_item_id DESC
                        LIMIT 1
                      ),
                      -1
                    ) AS ordinal
                  )
                  SELECT turn_item_id
                  FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${forkedFrom.threadId}
                    AND ordinal <= COALESCE(
                      (SELECT ordinal FROM effective_boundary),
                      -1
                    )
                    AND (
                      ${anchorBelongsToSource ? 1 : 0} = 0
                      OR ordinal <= COALESCE(
                        (SELECT ordinal FROM orchestration_v2_projection_turn_items
                         WHERE thread_id = ${forkedFrom.threadId}
                           AND turn_item_id = ${historyAnchor?.itemId ?? null}
                         LIMIT 1),
                        (SELECT ordinal FROM effective_boundary),
                        -1
                      )
                    )
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT 1
                `;
                const anchor = rows[0]?.turn_item_id;
                const anchorIsInDescendant =
                  historyAnchor !== undefined &&
                  historyAnchor.threadId !== threadId &&
                  historyAnchor.threadId !== forkedFrom.threadId;
                return {
                  rowLimit: window.rowLimit,
                  compact: window.compact,
                  userTurnLimit: window.userTurnLimit,
                  requiredRunId: forkedFrom.runId,
                  suppressLocal: anchor === undefined || anchorIsInDescendant,
                  ...(anchor === undefined || anchorIsInDescendant
                    ? {}
                    : { anchorItemId: TurnItemId.make(anchor) }),
                  ...(historyAnchor === undefined || historyAnchor.threadId === threadId
                    ? {}
                    : { historyAnchor }),
                };
              });

        const sourceProjection = yield* readProjection(
          forkedFrom.threadId,
          new Set([...seenThreadIds, threadId]),
          sourceWindow,
        );
        return {
          ...projection,
          visibleTurnItems: buildVisibleTurnItems({
            projection,
            sourceProjection,
          }),
        };
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getLimitRecoveryCandidates = Effect.fn("ProjectionStore.getLimitRecoveryCandidates")(
      function* (options: Parameters<ProjectionStoreV2Shape["getLimitRecoveryCandidates"]>[0]) {
        // Indexed latest-run and root-error lookups avoid reading run histories,
        // counting transcript items, or walking fork ancestors on scheduler ticks.
        const rows = yield* sql<{
          readonly payload_json: string;
          readonly run_id: string;
          readonly completed_at: string | null;
          readonly failure_payload_json: string;
          readonly last_error: string | null;
        }>`
          SELECT t.payload_json, r.run_id, r.completed_at,
            item.payload_json AS failure_payload_json,
            (
              SELECT json_extract(session.payload_json, '$.lastError')
              FROM orchestration_v2_projection_provider_sessions session
              INNER JOIN orchestration_v2_projection_provider_session_bindings binding
                ON binding.provider_session_id = session.provider_session_id
              WHERE binding.thread_id = t.thread_id
                AND session.provider_instance_id = t.provider_instance_id
              ORDER BY session.updated_at DESC, session.provider_session_id DESC
              LIMIT 1
            ) AS last_error
          FROM orchestration_v2_projection_threads t
          INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
            SELECT latest.run_id FROM orchestration_v2_projection_runs latest
            WHERE latest.thread_id = t.thread_id
              AND latest.status <> 'queued'
              AND NOT (
                latest.status = 'cancelled'
                AND json_extract(latest.payload_json, '$.startedAt') IS NULL
              )
            -- latestExecutedRun: the run that ended last (runRanAfter).
            ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
              latest.ordinal DESC, latest.run_id DESC
            LIMIT 1
          ) AND r.status = 'failed'
          INNER JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
            SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
            WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
              AND error.type = 'error' AND error.status = 'failed'
              AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
            ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
            LIMIT 1
          )
          WHERE t.deleted_at IS NULL
            AND json_extract(t.payload_json, '$.archivedAt') IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
            AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
            AND json_extract(item.payload_json, '$.failure.resetAt') IS NOT NULL
            AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(COALESCE(r.completed_at, json_extract(t.payload_json, '$.updatedAt')))
            AND (
              (
                json_extract(t.payload_json, '$.limitRecovery.runId') IS r.run_id
                AND json_extract(t.payload_json, '$.limitRecovery.resetAt') IS json_extract(item.payload_json, '$.failure.resetAt')
                AND json_extract(t.payload_json, '$.limitRecovery.autoResume') = 1
                AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) <= julianday(${DateTime.formatIso(options.now)})
                AND (
                  json_extract(t.payload_json, '$.snoozedUntil') IS NULL
                  OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(options.now)})
                )
              )
              OR (
                (
                  json_extract(t.payload_json, '$.limitRecovery.runId') IS NOT r.run_id
                  OR json_extract(t.payload_json, '$.limitRecovery.resetAt') IS NOT json_extract(item.payload_json, '$.failure.resetAt')
                )
                AND (
                  ${booleanInt(options.autoResume)}
                  OR (${booleanInt(options.snooze)} AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(${DateTime.formatIso(options.now)}))
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
          ORDER BY t.thread_id
        `;
        const candidates: Array<ProjectionLimitRecoveryCandidate> = [];
        for (const row of rows) {
          const thread = yield* decodeThreadPayload(row.payload_json);
          const item = yield* decodeTurnItemPayload(row.failure_payload_json);
          const summary = threadErrorSummary(
            item.type === "error" ? item.failure : null,
            row.last_error,
          );
          if (summary.lastErrorClass !== "usage_limit") continue;
          candidates.push({
            id: thread.id,
            status: "failed",
            lastErrorClass: summary.lastErrorClass,
            usageLimitResetAt: summary.usageLimitResetAt,
            latestRunId: RunId.make(row.run_id),
            latestRunCompletedAt:
              row.completed_at === null ? null : DateTime.makeUnsafe(row.completed_at),
            updatedAt: thread.updatedAt,
            archivedAt: thread.archivedAt,
            settledOverride: thread.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: thread.limitRecovery ?? null,
            snoozedUntil: thread.snoozedUntil ?? null,
          });
        }
        return candidates;
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );
    const getLimitRecoveryWakeAt = Effect.fn("ProjectionStore.getLimitRecoveryWakeAt")(
      function* (now: DateTime.Utc) {
        const nowIso = DateTime.formatIso(now);
        const rows = yield* sql<{
          readonly reset_ms: number | null;
          readonly snooze_ms: number | null;
        }>`
          SELECT
            MIN(CASE WHEN julianday(reset_at) > julianday(${nowIso})
              THEN (julianday(reset_at) - 2440587.5) * 86400000 END) AS reset_ms,
            MIN(CASE WHEN julianday(snoozed_until) > julianday(${nowIso})
              THEN (julianday(snoozed_until) - 2440587.5) * 86400000 END) AS snooze_ms
          FROM (
            SELECT json_extract(payload_json, '$.limitRecovery.resetAt') AS reset_at,
              json_extract(payload_json, '$.snoozedUntil') AS snoozed_until
            FROM orchestration_v2_projection_threads
            WHERE deleted_at IS NULL
              AND json_extract(payload_json, '$.limitRecovery.autoResume') = 1
          )
        `;
        const resetMs = rows[0]?.reset_ms ?? null;
        const snoozeMs = rows[0]?.snooze_ms ?? null;
        if (resetMs === null) return snoozeMs === null ? null : Math.round(snoozeMs);
        return snoozeMs === null ? Math.round(resetMs) : Math.round(Math.min(resetMs, snoozeMs));
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    const getRecoveryThreadIds = Effect.fn("ProjectionStore.getRecoveryThreadIds")(
      function* (kind: ProjectionRecoveryKind) {
        const candidates = (() => {
          switch (kind) {
            case "queued-runs":
              return sql`
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status = 'queued'
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS active
                    WHERE active.thread_id = orchestration_v2_projection_runs.thread_id
                      AND active.status IN ('preparing', 'starting', 'running', 'waiting')
                  )
              `;
            case "delegated-completions":
              return sql`
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE CASE WHEN json_valid(payload_json)
                  THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
                  ELSE 0 END
              `;
            case "subagent-results":
              return sql`
                SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
                WHERE CASE WHEN json_valid(child.payload_json) THEN
                  json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND json_extract(child.payload_json, '$.lineage.parentThreadId') IS NOT NULL
                  AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
                  AND json_extract(child.payload_json, '$.creationSource') IS NOT 'provider'
                  AND EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS task_run
                    WHERE task_run.thread_id = child.thread_id
                      AND task_run.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                      AND NOT EXISTS (
                        SELECT 1 FROM orchestration_v2_projection_runs AS continuation
                        WHERE continuation.thread_id = child.thread_id
                          AND CASE WHEN json_valid(continuation.payload_json) THEN
                            json_extract(continuation.payload_json, '$.restartContinuationOfRunId') = task_run.run_id
                          ELSE 0 END
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM orchestration_v2_projection_context_transfers AS result
                        WHERE result.source_thread_id = child.thread_id
                          AND result.target_thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
                          AND result.type = 'subagent_result'
                          AND CASE WHEN json_valid(result.payload_json) THEN
                            json_extract(result.payload_json, '$.sourcePoint.runId') = task_run.run_id
                            OR json_extract(result.payload_json, '$.sourcePoint.runId') IS NULL
                          ELSE 0 END
                      )
                  )
                  ELSE 0 END
              `;
            case "runtime":
              return sql`
                WITH pending_provider_threads AS MATERIALIZED (
                  SELECT provider_thread_id, thread_id, owner_node_id
                  FROM orchestration_v2_projection_provider_threads
                  WHERE status = 'active'
                    OR CASE WHEN json_valid(payload_json)
                      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
                      ELSE 0 END
                )
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status IN ('preparing', 'starting', 'running', 'waiting')
                UNION
                -- A held queue already went through recovery; rereading it on
                -- every boot costs a projection read per held thread.
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status = 'queued'
                  AND CASE WHEN json_valid(payload_json)
                    THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
                    ELSE 1 END
                UNION
                SELECT thread_id FROM orchestration_v2_projection_runtime_requests
                WHERE status = 'pending'
                UNION
                SELECT bindings.thread_id
                FROM orchestration_v2_projection_provider_sessions AS sessions
                CROSS JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                  ON bindings.provider_session_id = sessions.provider_session_id
                WHERE sessions.status NOT IN ('stopped', 'error')
                UNION
                SELECT thread_id FROM pending_provider_threads
                UNION
                SELECT nodes.thread_id FROM pending_provider_threads
                CROSS JOIN orchestration_v2_projection_nodes AS nodes
                  ON nodes.node_id = pending_provider_threads.owner_node_id
                UNION
                SELECT subagents.thread_id FROM pending_provider_threads
                CROSS JOIN orchestration_v2_projection_subagents AS subagents
                  ON subagents.provider_thread_id = pending_provider_threads.provider_thread_id
                UNION
                SELECT subagents.child_thread_id FROM orchestration_v2_projection_subagents AS subagents
                WHERE subagents.child_thread_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS node
                      ${LIVE_NODES_INDEX}
                    WHERE node.thread_id = subagents.child_thread_id
                      AND node.run_id IS NULL
                      AND node.kind = 'root_turn'
                      AND node.status IN ('pending', 'starting', 'running', 'waiting')
                  )
                UNION
                SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
                WHERE NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                  AND type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND status IN ('pending', 'running', 'waiting')
                UNION
                SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
                WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                  AND (
                    EXISTS (
                      SELECT 1 FROM orchestration_v2_projection_nodes AS node
                      WHERE node.thread_id = item.thread_id
                        AND node.node_id = item.node_id
                        AND node.status IN ('pending', 'starting', 'running', 'waiting')
                    )
                    OR (
                      item.type = 'subagent'
                      AND json_extract(item.payload_json, '$.subagentId') IN (
                        SELECT subagent_id FROM orchestration_v2_projection_subagents AS subagent
                        WHERE subagent.thread_id = item.thread_id
                          AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                      )
                    )
                    OR (
                      item.type = 'subagent'
                      AND json_extract(item.payload_json, '$.subagentId') IN (
                        SELECT node_id FROM orchestration_v2_projection_nodes AS node
                        WHERE node.thread_id = item.thread_id
                          AND node.status IN ('pending', 'starting', 'running', 'waiting')
                      )
                    )
                  )
                UNION
                SELECT provider_turn.thread_id
                FROM orchestration_v2_projection_provider_turns AS provider_turn
                WHERE provider_turn.status IN ('pending', 'running')
                  AND EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_run_attempts AS attempt
                    WHERE attempt.attempt_id = provider_turn.run_attempt_id
                      AND attempt.status NOT IN ('pending', 'running')
                  )
                UNION
                SELECT thread_id FROM orchestration_v2_effect_outbox
                WHERE status IN ('pending', 'running')
              `;
          }
        })();
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
            AND thread_id IN (${candidates})
            ${kind === "queued-runs" ? sql`AND archived_at IS NULL` : sql``}
          ORDER BY updated_at ASC, thread_id ASC
        `;
        return rows.map((row) => ThreadId.make(row.thread_id));
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    // Decode every canonical row once. Full thread reads repeat shared sessions,
    // provider threads, transfers, and inherited fork histories for each owner.
    const getUnreadableThreadIds = Effect.fn("ProjectionStore.getUnreadableThreadIds")(
      function* () {
        const actualThreadIds = new Set<ThreadId>();
        const unreadable = new Set<ThreadId>();
        const forkChildren = new Map<ThreadId, Array<ThreadId>>();
        const tables: ReadonlyArray<{
          readonly name: string;
          readonly id: string;
          readonly decode: (payload: string, entityId: string) => Effect.Effect<unknown, unknown>;
        }> = [
          {
            name: "threads",
            id: "thread_id",
            decode: (payload: string, entityId: string) =>
              decodeThreadPayload(payload).pipe(
                Effect.tap((thread) =>
                  Effect.sync(() => {
                    if (thread.forkedFrom?.type !== "run") return;
                    const sourceId = thread.forkedFrom.threadId;
                    const children = forkChildren.get(sourceId) ?? [];
                    children.push(ThreadId.make(entityId));
                    forkChildren.set(sourceId, children);
                  }),
                ),
              ),
          },
          { name: "runs", id: "run_id", decode: (payload) => decodeRunPayload(payload) },
          {
            name: "run_attempts",
            id: "attempt_id",
            decode: (payload) => decodeRunAttemptPayload(payload),
          },
          { name: "nodes", id: "node_id", decode: (payload) => decodeNodePayload(payload) },
          {
            name: "subagents",
            id: "subagent_id",
            decode: (payload) => decodeSubagentPayload(payload),
          },
          {
            name: "provider_sessions",
            id: "provider_session_id",
            decode: (payload) => decodeProviderSessionPayload(payload),
          },
          {
            name: "provider_threads",
            id: "provider_thread_id",
            decode: (payload) => decodeProviderThreadPayload(payload),
          },
          {
            name: "provider_turns",
            id: "provider_turn_id",
            decode: (payload) => decodeProviderTurnPayload(payload),
          },
          {
            name: "runtime_requests",
            id: "runtime_request_id",
            decode: (payload) => decodeRuntimeRequestPayload(payload),
          },
          {
            name: "messages",
            id: "message_id",
            decode: (payload) => decodeMessagePayload(payload),
          },
          { name: "plans", id: "plan_id", decode: decodePlanPayload },
          {
            name: "turn_items",
            id: "turn_item_id",
            decode: (payload) => decodeTurnItemPayload(payload),
          },
          {
            name: "checkpoint_scopes",
            id: "scope_id",
            decode: (payload) => decodeCheckpointScopePayload(payload),
          },
          {
            name: "checkpoints",
            id: "checkpoint_id",
            decode: (payload) => decodeCheckpointPayload(payload),
          },
          {
            name: "context_handoffs",
            id: "context_handoff_id",
            decode: (payload) => decodeContextHandoffPayload(payload),
          },
          {
            name: "context_transfers",
            id: "context_transfer_id",
            decode: (payload) => decodeContextTransferPayload(payload),
          },
        ];
        const pageSize = 500;
        for (const table of tables) {
          let afterRowId = 0;
          while (true) {
            const rows = yield* sql<{
              readonly row_id: number;
              readonly entity_id: string;
              readonly thread_id: string | null;
              readonly target_thread_id: string | null;
              readonly payload_json: string;
            }>`
              SELECT rowid AS row_id, ${sql(table.id)} AS entity_id,
                ${sql(table.name === "context_transfers" ? "source_thread_id" : "thread_id")} AS thread_id,
                ${table.name === "context_transfers" ? sql`target_thread_id` : sql`NULL`} AS target_thread_id,
                payload_json
              FROM ${sql(`orchestration_v2_projection_${table.name}`)}
              WHERE rowid > ${afterRowId}
              ORDER BY rowid ASC LIMIT ${pageSize}
            `;
            for (const row of rows) {
              if (table.name === "threads") actualThreadIds.add(ThreadId.make(row.entity_id));
              const decoded = yield* Effect.exit(
                Effect.suspend(() => table.decode(row.payload_json, row.entity_id)),
              );
              if (decoded._tag === "Success") continue;
              if (table.name === "provider_sessions") {
                const bindings = yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings
                  WHERE provider_session_id = ${row.entity_id}
                `;
                for (const binding of bindings) unreadable.add(ThreadId.make(binding.thread_id));
              } else {
                if (row.thread_id !== null) unreadable.add(ThreadId.make(row.thread_id));
                if (row.target_thread_id !== null)
                  unreadable.add(ThreadId.make(row.target_thread_id));
              }
              if (table.name === "provider_threads") {
                const owners = yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_nodes
                  WHERE node_id = (
                    SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
                    WHERE provider_thread_id = ${row.entity_id}
                  )
                  UNION
                  SELECT thread_id FROM orchestration_v2_projection_subagents
                  WHERE provider_thread_id = ${row.entity_id}
                `;
                for (const owner of owners) unreadable.add(ThreadId.make(owner.thread_id));
              }
            }
            if (rows.length < pageSize) break;
            afterRowId = rows[rows.length - 1]!.row_id;
            yield* Effect.yieldNow;
          }
        }
        // A full fork projection also reads its source. Propagate decode failures
        // and missing sources through the same ancestry without loading history.
        const pending = [
          ...unreadable,
          ...[...forkChildren.keys()].filter((sourceId) => !actualThreadIds.has(sourceId)),
        ];
        for (let index = 0; index < pending.length; index += 1) {
          for (const childId of forkChildren.get(pending[index]!) ?? []) {
            if (unreadable.has(childId)) continue;
            unreadable.add(childId);
            pending.push(childId);
          }
        }
        return [...unreadable].filter((threadId) => actualThreadIds.has(threadId)).sort();
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    // SQLite trim defaults to ASCII spaces; compact recognition uses JavaScript trim.
    const javascriptTrimWhitespace =
      " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

    // Startup needs execution metadata, not the transcript or inherited fork history.
    const getTurnStartContext: ProjectionStoreV2Shape["getTurnStartContext"] = (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const runs = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} ORDER BY ordinal ASC
            `.pipe(Effect.flatMap(decodeRows(decodeRunPayload, threadId)));
            const attempts = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} ORDER BY run_id ASC, attempt_ordinal ASC
            `.pipe(Effect.flatMap(decodeRows(decodeRunAttemptPayload, threadId)));
            const nodes = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_nodes
              -- Node IDs are the table's primary key; avoid walking every node in the thread.
              INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1
              WHERE thread_id = ${threadId} AND node_id IN (SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = ${runId}) ORDER BY node_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeNodePayload, threadId)));
            const subagents = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND status NOT IN ('interrupted','failed','cancelled') ORDER BY subagent_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeSubagentPayload, threadId)));
            const providerThreads = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${threadId} ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeProviderThreadPayload, threadId)));
            const providerTurns = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_provider_turns
              WHERE thread_id = ${threadId} ORDER BY provider_thread_id ASC, ordinal ASC
            `.pipe(Effect.flatMap(decodeRows(decodeProviderTurnPayload, threadId)));
            const checkpointScopes = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId} AND scope_id IN ${sql.in(nodes.flatMap((node) => (node.checkpointScopeId === null ? [] : [node.checkpointScopeId])))} ORDER BY ordinal_within_parent ASC, scope_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeCheckpointScopePayload, threadId)));
            const contextHandoffs = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_handoffs
              WHERE thread_id = ${threadId} ORDER BY rowid ASC
            `.pipe(Effect.flatMap(decodeRows(decodeContextHandoffPayload, threadId)));
            const contextTransfers = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_transfers
              WHERE source_thread_id = ${threadId} OR target_thread_id = ${threadId} ORDER BY rowid ASC
            `.pipe(Effect.flatMap(decodeRows(decodeContextTransferPayload, threadId)));
            const turnItems = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND run_id = ${runId} ORDER BY ordinal ASC, turn_item_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeTurnItemPayload, threadId)));
            const providerSessions = yield* sql<PayloadRow>`
              SELECT sessions.payload_json FROM orchestration_v2_projection_provider_sessions AS sessions
              INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                ON bindings.provider_session_id = sessions.provider_session_id
              WHERE bindings.thread_id = ${threadId}
              ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeProviderSessionPayload, threadId)));
            // Compact retries need their original markers; emptiness is an existence check.
            const messages = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND (
                message_id IN (SELECT json_extract(payload_json, '$.userMessageId') FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId} AND run_id = ${runId})
                OR (role = 'user' AND lower(trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace})) = '/compact')
              ) ORDER BY created_at ASC, message_id ASC
            `.pipe(Effect.flatMap(decodeRows(decodeMessagePayload, threadId)));
            const conversation = yield* sql<{ present: number }>`
              SELECT EXISTS(
                SELECT 1 FROM orchestration_v2_projection_messages
                WHERE thread_id = ${threadId} AND role = 'user'
                    AND (lower(trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace})) <> '/compact'
                      OR json_array_length(payload_json, '$.attachments') > 0)
              ) AS present
            `;
            return {
              hasConversation: conversation[0]?.present === 1,
              thread,
              runs,
              attempts,
              nodes,
              subagents,
              providerSessions,
              providerThreads,
              providerTurns,
              messages,
              checkpointScopes,
              contextHandoffs,
              contextTransfers,
              turnItems,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getTurnStartHistory: ProjectionStoreV2Shape["getTurnStartHistory"] = (threadId, runIds) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
            AND type IN ('user_message','assistant_message','command_execution','error',
              'run_interrupt_result','file_change','proposed_plan')
            AND ${runIds === undefined ? sql`1` : sql`run_id IN ${sql.in(runIds)}`}
          ORDER BY ordinal ASC, turn_item_id ASC
        `;
        return yield* decodeRows(decodeTurnItemPayload, threadId)(rows);
      }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    const getThreadProjection: ProjectionStoreV2Shape["getThreadProjection"] = (threadId) =>
      readProjection(threadId, new Set());

    const getRuntimeRecoveryProjection: ProjectionStoreV2Shape["getRuntimeRecoveryProjection"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
          `;
        if (threadRows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          turnItemRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRows[0].payload_json),
          sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = ${threadId}
                AND (
                  run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  OR run.run_id = (
                    SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
                    WHERE latest.thread_id = ${threadId}
                    ORDER BY latest.ordinal DESC LIMIT 1
                  )
                  -- Retain the latest run for each provider thread with lost
                  -- background work, including owners used before a handoff.
                  OR run.run_id IN (
                    SELECT (
                      SELECT ended.run_id FROM orchestration_v2_projection_runs AS ended
                      WHERE ended.thread_id = ${threadId}
                        AND ended.provider_thread_id = roster.provider_thread_id
                        AND ended.status NOT IN ('queued', 'rolled_back')
                      ORDER BY ended.completed_at IS NULL DESC, ended.completed_at DESC,
                        ended.ordinal DESC
                      LIMIT 1
                    )
                    FROM orchestration_v2_projection_provider_threads AS roster
                    WHERE roster.thread_id = ${threadId}
                      AND CASE WHEN json_valid(roster.payload_json)
                        THEN json_array_length(roster.payload_json, '$.pendingBackgroundTasks') > 0
                        ELSE 0 END
                  )
                  OR run.run_id IN (
                    SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                      AND item.run_id IS NOT NULL
                  )
                )
              ORDER BY run.ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT attempt.payload_json
              FROM orchestration_v2_projection_run_attempts AS attempt
              WHERE attempt.thread_id = ${threadId}
                AND (
                  attempt.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  -- Ended attempts whose provider turn was never settled.
                  OR attempt.attempt_id IN (
                    SELECT run_attempt_id FROM orchestration_v2_projection_provider_turns
                    WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
                  )
                )
              ORDER BY attempt.run_id ASC, attempt.attempt_ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT node.payload_json FROM orchestration_v2_projection_nodes AS node
                ${LIVE_NODES_INDEX}
              WHERE node.thread_id = ${threadId}
                AND node.status IN ('pending', 'starting', 'running', 'waiting')
                AND (
                  (node.run_id IS NULL AND node.kind = 'root_turn')
                  OR node.node_id IN (
                    SELECT node_id FROM orchestration_v2_projection_runtime_requests
                    WHERE thread_id = ${threadId} AND status = 'pending' AND kind = 'user_input'
                  )
                  OR node.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT item.node_id FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT json_extract(item.payload_json, '$.subagentId')
                    FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                    WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
                    WHERE item.node_id = node.node_id
                      AND item.thread_id = node.thread_id
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                      AND json_extract(item.payload_json, '$.providerTurnId')
                        IS json_extract(node.payload_json, '$.providerTurnId')
                  )
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                    WHERE item.thread_id = node.thread_id
                      AND item.run_id IS node.run_id
                      AND item.type = 'subagent'
                      AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                      AND json_extract(item.payload_json, '$.subagentId') = node.node_id
                      AND json_extract(item.payload_json, '$.providerTurnId')
                        IS json_extract(node.payload_json, '$.providerTurnId')
                  )
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
                    WHERE subagent.thread_id = node.thread_id
                      AND subagent.subagent_id = node.node_id
                      AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
            `,
          sql<PayloadRow>`
              SELECT subagent.payload_json FROM orchestration_v2_projection_subagents AS subagent
              WHERE subagent.thread_id = ${threadId}
                AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
              ORDER BY COALESCE(subagent.started_at, ''), subagent.subagent_id ASC
            `,
          sql<PayloadRow>`
              SELECT DISTINCT session.payload_json
              FROM orchestration_v2_projection_provider_sessions AS session
              JOIN orchestration_v2_projection_provider_session_bindings AS binding
                ON binding.provider_session_id = session.provider_session_id
              WHERE binding.thread_id = ${threadId}
                AND (
                  session.status NOT IN ('stopped', 'error')
                  OR session.provider_session_id IN (
                    SELECT provider_thread.provider_session_id
                    FROM orchestration_v2_projection_provider_threads AS provider_thread
                    WHERE provider_thread.provider_thread_id IN (
                      SELECT run.provider_thread_id
                      FROM orchestration_v2_projection_runs AS run
                      WHERE run.thread_id = ${threadId}
                        AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    )
                  )
                )
              ORDER BY session.updated_at ASC, session.provider_session_id ASC
            `,
          sql<PayloadRow>`
              SELECT provider_thread.payload_json
              FROM orchestration_v2_projection_provider_threads AS provider_thread
              WHERE (
                  provider_thread.thread_id = ${threadId}
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS owner
                    WHERE owner.node_id = provider_thread.owner_node_id
                      AND owner.thread_id = ${threadId}
                  )
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
                    WHERE subagent.provider_thread_id = provider_thread.provider_thread_id
                      AND subagent.thread_id = ${threadId}
                  )
                )
                AND (
                  provider_thread.status = 'active'
                  OR CASE WHEN json_valid(provider_thread.payload_json)
                    THEN json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
                  OR provider_thread.provider_thread_id IN (
                    SELECT run.provider_thread_id FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${threadId}
                      AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR provider_thread.provider_thread_id IN (
                    SELECT item.provider_thread_id
                    FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(provider_thread.first_run_ordinal, 0), provider_thread.provider_thread_id ASC
            `,
          sql<PayloadRow>`
              SELECT provider_turn.payload_json
              FROM orchestration_v2_projection_provider_turns AS provider_turn
              WHERE provider_turn.thread_id = ${threadId}
                AND provider_turn.status IN ('pending', 'starting', 'running', 'waiting')
                AND provider_turn.run_attempt_id IN (
                  SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                  WHERE thread_id = ${threadId}
                    AND (
                      status NOT IN ('pending', 'running')
                      OR run_id IN (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId}
                          AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                      )
                    )
                )
              ORDER BY provider_turn.provider_thread_id ASC, provider_turn.ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND status = 'pending'
              ORDER BY created_at ASC, runtime_request_id ASC
            `,
          sql<PayloadRow>`
              SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
              WHERE message.thread_id = ${threadId} AND message.streaming = 1
                AND message.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
              ORDER BY message.created_at ASC, message.message_id ASC
            `,
          sql<PayloadRow>`
              SELECT recovery_item.payload_json FROM (
                SELECT item.payload_json, item.ordinal, item.turn_item_id
                FROM orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_active_ordinal_idx
                WHERE item.thread_id = ${threadId}
                  AND item.status IN ('pending', 'running', 'waiting')
                  AND (
                    item.run_id IN (
                      SELECT run_id FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    )
                    OR item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                    OR (
                      item.type = 'user_input_request'
                      AND json_extract(item.payload_json, '$.requestId') IN (
                        SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests
                        WHERE thread_id = ${threadId} AND status = 'pending' AND kind = 'user_input'
                      )
                    )
                    OR (
                      item.run_id IS NULL
                      AND item.node_id IN (
                        SELECT node_id FROM orchestration_v2_projection_nodes
                        WHERE thread_id = ${threadId}
                          AND run_id IS NULL
                          AND kind = 'root_turn'
                          AND status IN ('pending', 'running', 'waiting')
                      )
                    )
                  )
                UNION ALL
                -- Keep terminal parent details for native children whose
                -- status recovery needs to compare with the parent call.
                -- Drive from active children and resolve parents by primary key.
                SELECT parent.payload_json, parent.ordinal, parent.turn_item_id
                FROM orchestration_v2_projection_turn_items AS child
                  INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                CROSS JOIN orchestration_v2_projection_turn_items AS parent
                WHERE child.thread_id = ${threadId}
                  AND child.type = 'subagent'
                  AND child.status IN ('pending', 'running', 'waiting')
                  AND child.type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND json_extract(child.payload_json, '$.origin') = 'provider_native'
                  AND child.parent_item_id IS NOT NULL
                  AND parent.turn_item_id = child.parent_item_id
                  AND child.run_id IS NOT NULL
                  AND parent.run_id = child.run_id
                  AND parent.type = 'dynamic_tool'
                  AND parent.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = child.run_id
                      AND run.thread_id = child.thread_id
                      AND run.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  )
                UNION ALL
                -- Terminal items can outlive a stale active node or subagent row.
                -- Resolve each by an indexed node, run, or thread/run key.
                SELECT item.payload_json, item.ordinal, item.turn_item_id
                FROM orchestration_v2_projection_nodes AS node
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
                WHERE node.thread_id = ${threadId}
                  AND node.status IN ('pending', 'starting', 'running', 'waiting')
                  AND item.node_id = node.node_id
                  AND item.thread_id = node.thread_id
                  AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND json_extract(item.payload_json, '$.providerTurnId')
                    IS json_extract(node.payload_json, '$.providerTurnId')
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                  AND NOT (
                    item.type = 'dynamic_tool'
                    AND EXISTS (
                      SELECT 1 FROM orchestration_v2_projection_turn_items AS child
                        INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                      WHERE child.thread_id = item.thread_id
                        AND child.type IN ('command_execution', 'dynamic_tool', 'subagent')
                        AND child.parent_item_id = item.turn_item_id
                        AND child.type = 'subagent'
                        AND child.status IN ('pending', 'running', 'waiting')
                        AND json_extract(child.payload_json, '$.origin') = 'provider_native'
                    )
                  )
                UNION ALL
                SELECT item.payload_json, item.ordinal, item.turn_item_id
                FROM orchestration_v2_projection_nodes AS node
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE node.thread_id = ${threadId}
                  AND node.status IN ('pending', 'starting', 'running', 'waiting')
                  AND item.thread_id = node.thread_id
                  AND item.run_id IS node.run_id
                  AND item.type = 'subagent'
                  AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND json_extract(item.payload_json, '$.subagentId') = node.node_id
                  AND json_extract(item.payload_json, '$.providerTurnId')
                    IS json_extract(node.payload_json, '$.providerTurnId')
                  AND item.node_id IS NOT node.node_id
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
                    WHERE subagent.thread_id = item.thread_id
                      AND subagent.subagent_id = node.node_id
                      AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                UNION ALL
                SELECT item.payload_json, item.ordinal, item.turn_item_id
                FROM orchestration_v2_projection_subagents AS subagent
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
                WHERE subagent.thread_id = ${threadId}
                  AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                  AND item.node_id = subagent.subagent_id
                  AND item.thread_id = subagent.thread_id
                  AND item.type = 'subagent'
                  AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS node
                    WHERE node.thread_id = item.thread_id
                      AND node.node_id = item.node_id
                      AND node.status IN ('pending', 'starting', 'running', 'waiting')
                      AND json_extract(item.payload_json, '$.providerTurnId')
                        IS json_extract(node.payload_json, '$.providerTurnId')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                UNION ALL
                SELECT item.payload_json, item.ordinal, item.turn_item_id
                FROM orchestration_v2_projection_subagents AS subagent
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_run_ordinal_idx
                WHERE subagent.thread_id = ${threadId}
                  AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                  AND subagent.run_id IS NOT NULL
                  AND item.run_id = subagent.run_id
                  AND item.thread_id = subagent.thread_id
                  AND item.type = 'subagent'
                  AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND json_extract(item.payload_json, '$.subagentId') = subagent.subagent_id
                  AND item.node_id IS NOT subagent.subagent_id
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS node
                    WHERE node.thread_id = item.thread_id
                      AND node.node_id = item.node_id
                      AND node.status IN ('pending', 'starting', 'running', 'waiting')
                      AND json_extract(item.payload_json, '$.providerTurnId')
                        IS json_extract(node.payload_json, '$.providerTurnId')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                UNION ALL
                SELECT item.payload_json, item.ordinal, item.turn_item_id
                FROM orchestration_v2_projection_subagents AS subagent
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE subagent.thread_id = ${threadId}
                  AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                  AND subagent.run_id IS NULL
                  AND item.thread_id = subagent.thread_id
                  AND item.run_id IS NULL
                  AND item.type = 'subagent'
                  AND item.status IN ('completed', 'failed', 'interrupted', 'cancelled')
                  AND json_extract(item.payload_json, '$.subagentId') = subagent.subagent_id
                  AND item.node_id IS NOT subagent.subagent_id
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS node
                    WHERE node.thread_id = item.thread_id
                      AND node.node_id = item.node_id
                      AND node.status IN ('pending', 'starting', 'running', 'waiting')
                      AND json_extract(item.payload_json, '$.providerTurnId')
                        IS json_extract(node.payload_json, '$.providerTurnId')
                  )
              ) AS recovery_item
              ORDER BY recovery_item.ordinal ASC, recovery_item.turn_item_id ASC
            `,
        ]);
        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodeTurnItemPayload, threadId)(turnItemRows),
        ]);
        return {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        } satisfies ProjectionRuntimeRecoveryState;
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getThread: ProjectionStoreV2Shape["getThread"] = (threadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
        `;
        if (rows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        return yield* decodeThreadPayload(rows[0].payload_json);
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const requireThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
      `;
        if (rows.length === 0) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      });
    const controlReadError = (threadId: ThreadId) => (cause: unknown) =>
      isProjectionStoreThreadNotFoundError(cause)
        ? cause
        : new ProjectionStoreReadError({ threadId, cause });

    const getPendingNativeUserInputs: ProjectionStoreV2Shape["getPendingNativeUserInputs"] = (
      threadId,
      providerTurnId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
            AND kind = 'user_input' AND status = 'pending'
        `;
            const runtimeRequests = (yield* decodeRows(
              decodeRuntimeRequestPayload,
              threadId,
            )(rows)).filter((request) => request.responseCapability.type !== "message");
            if (runtimeRequests.length === 0) return { runtimeRequests, nodes: [], turnItems: [] };
            const nodeRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND ${sql.in(
            "node_id",
            runtimeRequests.map((request) => request.nodeId),
          )}
        `;
            const itemRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
            AND type = 'user_input_request'
        `;
            const requestIds = new Set(runtimeRequests.map((request) => request.id));
            return {
              runtimeRequests,
              nodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
              turnItems: (yield* decodeRows(decodeTurnItemPayload, threadId)(itemRows)).filter(
                (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
              ),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getPlan: ProjectionStoreV2Shape["getPlan"] = (threadId, planId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_plans
          WHERE thread_id = ${threadId} AND plan_id = ${planId}`;
            return rows[0] === undefined
              ? undefined
              : yield* decodePlanPayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const hasUnpairedRunInterruptRequest: ProjectionStoreV2Shape["hasUnpairedRunInterruptRequest"] =
      (threadId, requestId, resultId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ pending: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id = ${requestId}
        ) AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id = ${resultId}
        ) AS pending
      `;
          return rows[0]?.pending === 1;
        }).pipe(Effect.mapError(controlReadError(threadId)));

    const isNodeStored: ProjectionStoreV2Shape["isNodeStored"] = (node) =>
      Effect.gen(function* () {
        const payloadJson = yield* encodeNodePayload(node);
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = ${node.id}
        `;
        return rows[0]?.payload_json === payloadJson;
      }).pipe(Effect.mapError(controlReadError(node.threadId)));

    const getRuntimeRequest: ProjectionStoreV2Shape["getRuntimeRequest"] = (threadId, requestId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND runtime_request_id = ${requestId}
        `;
            return rows[0] === undefined
              ? undefined
              : yield* decodeRuntimeRequestPayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getProviderControlContext: ProjectionStoreV2Shape["getProviderControlContext"] = (
      threadId,
      target,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            // Match the full projection's ownership scope, but fetch only the target
            // records. Transcript items and fork ancestors are never read here.
            const [threadRows, turnRows, attemptRows, messageRows] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${target.providerThreadId} AND (
              thread_id = ${threadId}
              OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId})
            )`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId} AND provider_turn_id = ${target.providerTurnId}`,
              target.attemptId === undefined
                ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
                : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND attempt_id = ${target.attemptId}`,
              target.messageId === undefined
                ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
                : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND message_id = ${target.messageId}`,
            ]);
            const providerThread =
              threadRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(threadRows[0].payload_json);
            const providerTurn =
              turnRows[0] === undefined
                ? undefined
                : yield* decodeProviderTurnPayload(turnRows[0].payload_json);
            const attempt =
              attemptRows[0] === undefined
                ? undefined
                : yield* decodeRunAttemptPayload(attemptRows[0].payload_json);
            const message =
              messageRows[0] === undefined
                ? undefined
                : yield* decodeMessagePayload(messageRows[0].payload_json);
            let run: OrchestrationV2Run | undefined;
            if (target.messageId !== undefined && providerTurn !== undefined) {
              const rows =
                yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.activeAttemptId') IS ${providerTurn.runAttemptId}
            ORDER BY ordinal ASC LIMIT 1`;
              if (rows[0] !== undefined) run = yield* decodeRunPayload(rows[0].payload_json);
            }
            return { providerThread, providerTurn, attempt, message, run };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRunningTurnContext: ProjectionStoreV2Shape["getRunningTurnContext"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND status = 'running' ORDER BY ordinal ASC LIMIT 1`;
            const run =
              rows[0] === undefined ? undefined : yield* decodeRunPayload(rows[0].payload_json);
            if (run === undefined)
              return { run, providerThread: undefined, providerTurn: undefined };
            const threadRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${run.providerThreadId}`;
            const turnRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE provider_thread_id = ${run.providerThreadId}
            AND run_attempt_id = ${run.activeAttemptId}
            AND node_id = ${run.rootNodeId}
            AND status = 'running'`;
            return {
              run,
              providerThread:
                threadRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(threadRows[0].payload_json),
              providerTurn:
                turnRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderTurnPayload(turnRows[0].payload_json),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getThreadProviderContext: ProjectionStoreV2Shape["getThreadProviderContext"] = (
      threadId,
      targetInstanceId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const sessionRows = yield* sql<PayloadRow>`
          SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId}
          ORDER BY session.updated_at ASC, session.provider_session_id ASC
        `;
            const threadRows =
              targetInstanceId === undefined
                ? []
                : yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${thread.activeProviderThreadId}
             OR provider_thread_id = (
               SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
               WHERE thread_id = ${threadId} AND owner_node_id IS NULL
                 AND provider_instance_id = ${targetInstanceId}
               ORDER BY updated_at DESC, provider_thread_id ASC LIMIT 1
             )
          ORDER BY updated_at ASC, provider_thread_id ASC
        `;
            return {
              thread,
              providerSessions: yield* decodeRows(
                decodeProviderSessionPayload,
                threadId,
              )(sessionRows),
              providerThreads: yield* decodeRows(decodeProviderThreadPayload, threadId)(threadRows),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRuntimeResponseContext: ProjectionStoreV2Shape["getRuntimeResponseContext"] = (
      threadId,
      requestId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const request = yield* getRuntimeRequest(threadId, requestId);
            if (request === undefined)
              return { request, node: undefined, item: undefined, session: undefined };
            const nodeRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id = ${request.nodeId}`;
            const itemRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id = ${request.nodeId} AND type IN ('approval_request', 'user_input_request')
            AND json_extract(payload_json, '$.requestId') = ${requestId}
          ORDER BY ordinal ASC LIMIT 1`;
            const sessionRows =
              request.responseCapability.type !== "live"
                ? []
                : yield* sql<PayloadRow>`
          SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId} AND session.provider_session_id = ${request.responseCapability.providerSessionId}`;
            return {
              request,
              node:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              item:
                itemRows[0] === undefined
                  ? undefined
                  : yield* decodeTurnItemPayload(itemRows[0].payload_json),
              session:
                sessionRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getCheckpointContext: ProjectionStoreV2Shape["getCheckpointContext"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const threads = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId} LIMIT 1
          `;
            if (threads.length === 0) {
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            }
            // Checkpoint diffs need no transcript or fork ancestry. Select just the
            // metadata columns so large run/checkpoint JSON payloads stay in SQLite.
            const [runs, checkpointScopes, checkpoints] = yield* Effect.all([
              sql`
              SELECT run_id AS id, ordinal, status
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
              ORDER BY ordinal ASC
            `,
              sql`
              SELECT scope_id AS id, run_id AS "runId", kind,
                json_extract(payload_json, '$.cwd') AS cwd
              FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId}
              ORDER BY ordinal_within_parent ASC, scope_id ASC
            `,
              sql`
              SELECT scope_id AS "scopeId", run_id AS "runId",
                app_run_ordinal AS "appRunOrdinal", status,
                json_extract(payload_json, '$.ref') AS ref
              FROM orchestration_v2_projection_checkpoints
              WHERE thread_id = ${threadId}
              ORDER BY scope_id ASC, ordinal_within_scope ASC
            `,
            ]);
            return yield* decodeCheckpointContext({ runs, checkpointScopes, checkpoints });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getCheckpointCaptureContext: ProjectionStoreV2Shape["getCheckpointCaptureContext"] = (
      threadId,
      target,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const runRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND run_id = ${target.runId}`;
            const run =
              runRows[0] === undefined
                ? undefined
                : yield* decodeRunPayload(runRows[0].payload_json);
            const [nodeRows, scopeRows, providerRows, readyRows] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${run?.providerThreadId ?? null}
              AND (thread_id = ${threadId}
                OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
                OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
              sql<{ readonly ordinal: number }>`SELECT ordinal_within_scope AS ordinal
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId} AND status = 'ready'`,
            ]);
            return {
              run,
              rootNode:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              scope:
                scopeRows[0] === undefined
                  ? undefined
                  : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json),
              providerThread:
                providerRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(providerRows[0].payload_json),
              readyCheckpointOrdinals: readyRows.map(({ ordinal }) => ordinal),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRunMessage: ProjectionStoreV2Shape["getRunMessage"] = (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<PayloadRow>`
          SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
          JOIN orchestration_v2_projection_runs AS run
            ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
          WHERE run.thread_id = ${threadId} AND run.run_id = ${runId}
            AND message.thread_id = ${threadId}`;
            return rows[0] === undefined
              ? undefined
              : yield* decodeMessagePayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const canStartQueuedRun: ProjectionStoreV2Shape["canStartQueuedRun"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<{ readonly ready: number }>`
          SELECT 1 AS ready FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id = ${threadId} AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND status = 'queued'
                AND json_extract(payload_json, '$.queueHeld') IS NOT 1)
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND status IN ('preparing', 'starting', 'running', 'waiting'))`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));
    const getHeldQueuedRuns: ProjectionStoreV2Shape["getHeldQueuedRuns"] = (threadId) =>
      sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'queued'
          AND json_extract(payload_json, '$.queueHeld') IS 1
        ORDER BY ordinal ASC
      `.pipe(
        Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
        Effect.mapError(controlReadError(threadId)),
      );

    const getMessageCount: ProjectionStoreV2Shape["getMessageCount"] = (threadId) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );
    const getSubagentCount: ProjectionStoreV2Shape["getSubagentCount"] = (threadId) =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_subagents
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );
    const getNextTurnItemOrdinal: ProjectionStoreV2Shape["getNextTurnItemOrdinal"] = (threadId) =>
      sql<{ ordinal: number | null }>`SELECT MAX(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => (rows[0]?.ordinal ?? 0) + 1),
        Effect.mapError(controlReadError(threadId)),
      );

    const getTurnItem: ProjectionStoreV2Shape["getTurnItem"] = ({ threadId, itemId }) =>
      sql<{ payload_json: string }>`SELECT payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(null)
            : decodeTurnItemPayload(rows[0].payload_json),
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    const getThreadAttachmentIds: ProjectionStoreV2Shape["getThreadAttachmentIds"] = (threadId) =>
      Effect.all([
        sql<{ id: string }>`
      SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
      FROM orchestration_v2_projection_messages AS message,
        json_each(message.payload_json, '$.attachments') AS attachment
      WHERE message.thread_id = ${threadId}
    `,
        // Pages published by html_render, and captured MCP App documents,
        // live in the attachment store too.
        sql<{ payload_json: string }>`
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId}
        AND type = 'dynamic_tool'
        AND (payload_json LIKE '%htmlRender%' OR payload_json LIKE ${`%${MCP_APP_OUTPUT_KEY}%`})
    `,
        sql<{ id: string }>`
      SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
      FROM orchestration_v2_projection_turn_items AS item,
        json_each(item.payload_json, '$.questionAnswer.attachmentsByQuestionId') AS question,
        json_each(question.value) AS attachment
      WHERE item.thread_id = ${threadId}
        AND item.type = 'user_input_request'
    `,
      ]).pipe(
        Effect.map(([messages, renders, answerFiles]) => [
          ...new Set([
            ...messages.map((row) => row.id),
            ...answerFiles.map((row) => row.id),
            ...threadHtmlRenderAttachmentIds(
              threadId,
              renders.map((row) => {
                const item = parseEncodedPayload(row.payload_json);
                return {
                  toolName: typeof item.toolName === "string" ? item.toolName : null,
                  output: item.output,
                };
              }),
            ),
          ]),
        ]),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

    const getThreadRecords: ProjectionStoreV2Shape["getThreadRecords"] = (
      threadId,
      fields,
      filter,
    ) =>
      sql.withTransaction(readCanonicalProjection(threadId, undefined, fields, filter)).pipe(
        Effect.map(
          (projection) =>
            Object.fromEntries([
              ["thread", projection.thread],
              ...fields.map((field) => [field, projection[field]]),
            ]) as ProjectionRecords<(typeof fields)[number]>,
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    const getThreadSnapshot: ProjectionStoreV2Shape["getThreadSnapshot"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const projection = yield* getThreadProjection(threadId);
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
          `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    // Only the timeline index is assembled across fork ancestry. Payloads are read
    // after page selection, so a small MCP page never hydrates all tool output.
    type TimelineIndexItem = Pick<
      OrchestrationV2TurnItem,
      "id" | "threadId" | "runId" | "nodeId" | "type"
    > & {
      readonly inputIntent?: "queued_turn";
    };
    type TimelineIndexRow = {
      readonly sourceThreadId: ThreadId;
      readonly sourceItemId: TurnItemId;
      readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
      readonly item: TimelineIndexItem;
      readonly synthetic?: OrchestrationV2TurnItem;
    };
    const readTimelineIndex = (
      threadId: ThreadId,
      seen: ReadonlySet<ThreadId>,
    ): Effect.Effect<
      {
        readonly records: ProjectionRecords<"runs" | "attempts">;
        readonly local: ReadonlyArray<TimelineIndexRow>;
        readonly visible: ReadonlyArray<TimelineIndexRow>;
      },
      ProjectionStoreV2Error
    > =>
      Effect.gen(function* () {
        const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
        const rows = yield* sql<{
          turn_item_id: string;
          run_id: string | null;
          node_id: string | null;
          type: OrchestrationV2TurnItem["type"];
          input_intent: string | null;
        }>`SELECT turn_item_id, run_id, node_id, type,
          CASE WHEN type = 'user_message' THEN json_extract(payload_json, '$.inputIntent') END AS input_intent
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
        ORDER BY ordinal ASC, turn_item_id ASC`;
        const items: Array<TimelineIndexItem> = rows.map((row) => ({
          id: TurnItemId.make(row.turn_item_id),
          threadId,
          runId: row.run_id === null ? null : RunId.make(row.run_id),
          nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
          type: row.type,
          ...(row.input_intent === "queued_turn" ? { inputIntent: "queued_turn" as const } : {}),
        }));
        const local: Array<TimelineIndexRow> = items.map((item) => ({
          sourceThreadId: threadId,
          sourceItemId: item.id,
          visibility: "local",
          item,
        }));
        const isVisible = createOrchestrationV2TurnItemVisibility({
          runs: records.runs,
          attempts: records.attempts,
          items,
        });
        const visible = local.filter((row) => isVisible(row.item));
        const fork = records.thread.forkedFrom;
        if (fork?.type !== "run" || seen.has(fork.threadId)) return { records, local, visible };
        const source = yield* readTimelineIndex(fork.threadId, new Set([...seen, threadId]));
        const sourceRun = source.records.runs.find((run) => run.id === fork.runId);
        let inherited: Array<TimelineIndexRow> = [];
        if (sourceRun !== undefined) {
          const ordinals = new Map(source.records.runs.map((run) => [run.id, run.ordinal]));
          const sourceItems = source.local.map((row) => row.item);
          inherited = [
            ...source.visible.filter(
              (row) => row.item.threadId !== fork.threadId || row.item.type === "fork",
            ),
            ...source.local.filter(
              (row) =>
                !isOrchestrationV2SupersededInterrupt({
                  item: row.item,
                  attempts: source.records.attempts,
                  items: sourceItems,
                }) &&
                isTurnItemAtOrBeforeRun({
                  historyOrigin: source.records.thread.historyOrigin,
                  itemRunId: row.item.runId,
                  runOrdinalById: ordinals,
                  sourceRunOrdinal: sourceRun.ordinal,
                }),
            ),
          ].map((row) => ({ ...row, visibility: "inherited" }));
        }
        const marker = makeForkMarkerTurnItem({
          targetProjection: records,
          sourceThreadId: fork.threadId,
          sourceRunId: fork.runId,
        });
        return {
          records,
          local,
          visible: [
            ...inherited,
            {
              sourceThreadId: fork.threadId,
              sourceItemId: marker.id,
              visibility: "synthetic" as const,
              item: marker,
              synthetic: marker,
            },
            ...visible,
          ],
        };
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );
    type TimelineWindowItem = TimelineIndexItem & {
      readonly ordinal: number;
    };
    type HiddenCandidate = {
      readonly turn_item_id: string;
      readonly run_id: string;
      readonly node_id: string | null;
      readonly type: OrchestrationV2TurnItem["type"];
      readonly ordinal: number;
      readonly input_intent: "queued_turn" | null;
    };
    type PositionedTimelineRow = TimelineIndexRow & {
      readonly position: number;
    };
    type LocalTimeline = {
      readonly records: ProjectionRecords<"runs" | "attempts">;
      readonly isVisible: (item: TimelineIndexItem) => boolean;
      readonly hidden: ReadonlyArray<HiddenCandidate>;
      readonly visibleBefore: (ordinal: number, itemId?: string) => Effect.Effect<number, unknown>;
      readonly read: (
        where: Statement.Fragment,
        limit?: Statement.Fragment,
      ) => Effect.Effect<ReadonlyArray<TimelineWindowItem>, unknown>;
    };
    const readTimelineWindow = Effect.fn("ProjectionStore.readTimelineWindow")(function* (
      threadId: ThreadId,
      where: Statement.Fragment,
      limit: Statement.Fragment = sql``,
    ) {
      const rows = yield* sql<{
        turn_item_id: string;
        run_id: string | null;
        node_id: string | null;
        type: OrchestrationV2TurnItem["type"];
        ordinal: number;
        input_intent: "queued_turn" | null;
      }>`SELECT item.turn_item_id, item.run_id, item.node_id, item.type, item.ordinal,
          CASE WHEN item.type = 'user_message'
            AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
            THEN 'queued_turn' END AS input_intent
        FROM orchestration_v2_projection_turn_items AS item
        WHERE item.thread_id = ${threadId} ${where}
        ORDER BY item.ordinal ASC, item.turn_item_id ASC ${limit}`;
      return rows.map((row): TimelineWindowItem => ({
        id: TurnItemId.make(row.turn_item_id),
        threadId,
        runId: row.run_id === null ? null : RunId.make(row.run_id),
        nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
        type: row.type,
        ordinal: row.ordinal,
        ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
      }));
    });
    const openLocalTimeline = Effect.fn("ProjectionStore.openLocalTimeline")(function* (
      threadId: ThreadId,
    ) {
      const ownRowsOnly = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
          AND json_extract(payload_json, '$.forkedFrom.type') IS NOT 'run'`;
      if (ownRowsOnly.length === 0) return null;
      const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
      if (records.thread.forkedFrom?.type === "run") return null;
      const superseded = records.attempts.filter((attempt) => attempt.status === "superseded");
      const stopRequests =
        superseded.length === 0
          ? []
          : yield* sql<{ run_id: string | null }>`
              SELECT DISTINCT run_id
              FROM orchestration_v2_projection_turn_items
                INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
              WHERE thread_id = ${threadId} AND type = 'run_interrupt_request'
                AND type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}`;
      const isVisible = createOrchestrationV2TurnItemVisibility({
        runs: records.runs,
        attempts: records.attempts,
        items: stopRequests.map(
          (
            row,
          ): {
            readonly type: "run_interrupt_request";
            readonly runId: RunId | null;
            readonly nodeId: null;
          } => ({
            type: "run_interrupt_request",
            runId: row.run_id === null ? null : RunId.make(row.run_id),
            nodeId: null,
          }),
        ),
      });
      const stoppedRuns = new Set(stopRequests.map((row) => row.run_id));
      const rolledBack = records.runs.flatMap((run) =>
        run.status === "rolled_back" ? [String(run.id)] : [],
      );
      const cancelled = records.runs.flatMap((run) =>
        run.status === "cancelled" ? [String(run.id)] : [],
      );
      const rolledBackSet = new Set(rolledBack);
      const steered = [...new Set(superseded.map((attempt) => String(attempt.runId)))].filter(
        (runId) => !stoppedRuns.has(runId) && !rolledBackSet.has(runId),
      );
      const candidateColumns = sql`item.turn_item_id, item.run_id, item.node_id, item.type,
        item.ordinal, CASE WHEN item.type = 'user_message'
          AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
          THEN 'queued_turn' END AS input_intent`;
      const rolledBackRows =
        rolledBack.length === 0
          ? []
          : yield* sql<HiddenCandidate>`
              SELECT ${candidateColumns}
              FROM json_each(${encodeIdList(rolledBack)}) AS wanted
              CROSS JOIN orchestration_v2_projection_turn_items AS item
                INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                ON item.thread_id = ${threadId} AND item.run_id = wanted.value`;
      const conversationRows =
        cancelled.length + steered.length === 0
          ? []
          : yield* sql<HiddenCandidate>`
              SELECT ${candidateColumns}
              FROM orchestration_v2_projection_turn_items AS item
                INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
              WHERE item.thread_id = ${threadId}
                AND item.type NOT IN ${CONVERSATION_INDEX_EXCLUDED_TYPES}
                AND ((item.type = 'user_message'
                    AND item.run_id IN (SELECT value FROM json_each(${encodeIdList(cancelled)})))
                  OR (item.type = 'run_interrupt_result'
                    AND item.run_id IN (SELECT value FROM json_each(${encodeIdList(steered)}))))`;
      const hidden = [...rolledBackRows, ...conversationRows].filter(
        (row) =>
          !isVisible({
            type: row.type,
            runId: RunId.make(row.run_id),
            nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
            ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
          }),
      );
      const visibleBefore = Effect.fn("ProjectionStore.countVisibleTimelineRows")(function* (
        ordinal: number,
        itemId = "",
      ) {
        const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND (ordinal, turn_item_id) < (${ordinal}, ${itemId})`;
        const hiddenBefore = hidden.filter(
          (row) =>
            row.ordinal < ordinal ||
            (row.ordinal === ordinal &&
              Buffer.compare(Buffer.from(row.turn_item_id), Buffer.from(itemId)) < 0),
        );
        return (rows[0]?.count ?? 0) - hiddenBefore.length;
      });
      return {
        records,
        isVisible,
        hidden,
        visibleBefore,
        read: (where: Statement.Fragment, limit?: Statement.Fragment) =>
          readTimelineWindow(threadId, where, limit),
      };
    });
    const matchLocalTimelineRows = Effect.fn("ProjectionStore.matchLocalTimelineRows")(function* (
      local: LocalTimeline,
      options: ProjectionTimelinePageOptions,
    ) {
      const threadId = local.records.thread.id;
      const totals = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}`;
      const totalItems = (totals[0]?.count ?? 0) - local.hidden.length;
      if (options.itemId !== undefined) {
        const found = (yield* local.read(sql`AND item.turn_item_id = ${options.itemId}`)).filter(
          local.isVisible,
        );
        const matching = yield* Effect.forEach(found, (item) =>
          local.visibleBefore(item.ordinal, item.id).pipe(
            Effect.map((position): PositionedTimelineRow => ({
              sourceThreadId: item.threadId,
              sourceItemId: item.id,
              visibility: "local",
              item,
              position,
            })),
          ),
        );
        return { matching, totalItems };
      }
      const afterPosition = options.afterPosition ?? -1;
      const firstPosition = Math.max(afterPosition + 1, 0);
      const starts = yield* sql<{ ordinal: number }>`
        SELECT ordinal FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}
        ORDER BY ordinal ASC, turn_item_id ASC LIMIT 1 OFFSET ${firstPosition}`;
      const start = starts[0]?.ordinal;
      if (start === undefined) return { matching: [], totalItems };
      const base = yield* local.visibleBefore(start);
      const hiddenAfter = local.hidden.filter((row) => row.ordinal >= start).length;
      const messagesOnly = options.view !== "activity";
      const candidates = (yield* local.read(
        messagesOnly
          ? sql`AND item.ordinal >= ${start}
              AND item.type IN ('user_message', 'assistant_message', 'proposed_plan')`
          : sql`AND item.ordinal >= ${start}`,
        sql`LIMIT ${firstPosition - base + Math.min(options.limit, totalItems) + 1 + hiddenAfter}`,
      )).filter(local.isVisible);
      const positions = new Map<string, number>();
      const last = candidates.at(-1);
      if (messagesOnly && last !== undefined) {
        const hiddenIds = new Set(local.hidden.map((row) => row.turn_item_id));
        const span = yield* sql<{ turn_item_id: string }>`
          SELECT turn_item_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND ordinal >= ${start} AND ordinal <= ${last.ordinal}
          ORDER BY ordinal ASC, turn_item_id ASC`;
        for (const row of span) {
          if (!hiddenIds.has(row.turn_item_id))
            positions.set(row.turn_item_id, base + positions.size);
        }
      }
      const matching = candidates
        .map((item, offset): PositionedTimelineRow => ({
          sourceThreadId: item.threadId,
          sourceItemId: item.id,
          visibility: "local",
          item,
          position: messagesOnly ? (positions.get(item.id) ?? -1) : base + offset,
        }))
        .filter((row) => row.position > afterPosition);
      return { matching, totalItems };
    });

    const { searchThread, searchThreadStream } = yield* makeThreadFind((threadId) =>
      readTimelineIndex(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
    );
    const getTimelinePage: ProjectionStoreV2Shape["getTimelinePage"] = (threadId, options) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const local =
              Number.isSafeInteger(options.limit) &&
              options.limit >= 0 &&
              Number.isSafeInteger(options.afterPosition ?? -1)
                ? yield* openLocalTimeline(threadId)
                : null;
            const whole = Effect.gen(function* () {
              const index = yield* readTimelineIndex(threadId, new Set());
              const matching = index.visible
                .map((row, position) => ({ ...row, position }))
                .filter((row) =>
                  options.itemId === undefined
                    ? row.position > (options.afterPosition ?? -1) &&
                      (options.view === "activity" ||
                        ["user_message", "assistant_message", "proposed_plan"].includes(
                          row.item.type,
                        ))
                    : row.sourceItemId === options.itemId,
                );
              return { matching, totalItems: index.visible.length };
            });
            const { matching, totalItems } =
              local === null ? yield* whole : yield* matchLocalTimelineRows(local, options);
            const page = matching.slice(0, options.limit);
            const items = yield* Effect.forEach(page, (row) =>
              Effect.gen(function* () {
                if (row.synthetic !== undefined)
                  return {
                    position: row.position,
                    sourceThreadId: row.sourceThreadId,
                    sourceItemId: row.sourceItemId,
                    visibility: row.visibility,
                    item: row.synthetic,
                  };
                const payloads =
                  yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${row.sourceThreadId} AND turn_item_id = ${row.sourceItemId}`;
                const decoded = yield* decodeRows(
                  decodeTurnItemPayload,
                  row.sourceThreadId,
                )(payloads);
                const item = decoded[0];
                if (item === undefined)
                  return yield* new ProjectionStoreReadError({
                    threadId,
                    cause: "Timeline item disappeared during snapshot",
                  });
                return {
                  position: row.position,
                  sourceThreadId: row.sourceThreadId,
                  sourceItemId: row.sourceItemId,
                  visibility: row.visibility,
                  item,
                };
              }),
            );
            return {
              items,
              totalItems,
              hasMore: matching.length > page.length,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const mapSemanticActivityError =
      (threadId: ThreadId) =>
      (error: SemanticActivityQueryError): ProjectionStoreV2Error => {
        switch (error._tag) {
          case "InvalidActivityCursor":
            return new ProjectionStoreInvalidActivityCursorError({ threadId });
          case "InvalidActivityRequest":
            return new ProjectionStoreInvalidActivityRequestError({
              threadId,
              reason: error.reason,
            });
          case "ActivityNotFound":
            return new ProjectionStoreActivityNotFoundError({
              threadId,
              ...(error.sourceThreadId === undefined
                ? {}
                : { sourceThreadId: ThreadId.make(error.sourceThreadId) }),
              ...(error.groupStartItemId === undefined
                ? {}
                : { groupStartItemId: TurnItemId.make(error.groupStartItemId) }),
              ...(error.anchorItemId === undefined
                ? {}
                : { anchorItemId: TurnItemId.make(error.anchorItemId) }),
            });
          case "ThreadNotFound":
            return new ProjectionStoreThreadNotFoundError({
              threadId: ThreadId.make(error.threadId),
            });
          case "ReadError":
            return new ProjectionStoreReadError({ threadId, cause: error.cause });
        }
      };

    /**
     * Visible fork ancestry for semantic activity queries: ancestors first, requested thread last.
     * Each ancestor's maxOrdinal is the same fork boundary readProjection uses for that run.
     */
    const resolveActivitySources = (
      threadId: ThreadId,
    ): Effect.Effect<ReadonlyArray<SemanticActivitySource>, ProjectionStoreV2Error> =>
      Effect.gen(function* () {
        const sources: Array<SemanticActivitySource> = [];
        const seenThreadIds = new Set<string>();
        let currentThreadId: string = threadId;
        let maxOrdinal: number | null = null;
        for (;;) {
          seenThreadIds.add(currentThreadId);
          const forkRows = yield* sql<{
            readonly fork_type: string | null;
            readonly fork_source_thread_id: string | null;
            readonly fork_run_id: string | null;
          }>`
            SELECT
              json_extract(payload_json, '$.forkedFrom.type') AS fork_type,
              json_extract(payload_json, '$.forkedFrom.threadId') AS fork_source_thread_id,
              json_extract(payload_json, '$.forkedFrom.runId') AS fork_run_id
            FROM orchestration_v2_projection_threads
            WHERE thread_id = ${currentThreadId}
            LIMIT 1
          `;
          const row = forkRows[0];
          if (row === undefined) {
            if (sources.length === 0) {
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            }
            break;
          }
          sources.push({ threadId: ThreadId.make(currentThreadId), maxOrdinal });
          if (
            row.fork_type !== "run" ||
            row.fork_source_thread_id === null ||
            row.fork_run_id === null ||
            seenThreadIds.has(row.fork_source_thread_id)
          ) {
            break;
          }
          const boundaryRows = yield* sql<{ readonly ordinal: number | null }>`
            WITH fork_run AS (
              SELECT ordinal
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${row.fork_source_thread_id}
                AND run_id = ${row.fork_run_id}
              LIMIT 1
            ), fork_boundary AS (
              SELECT (
                SELECT item.ordinal
                FROM orchestration_v2_projection_turn_items AS item
                WHERE item.run_id = run.run_id
                ORDER BY item.ordinal DESC
                LIMIT 1
              ) AS ordinal
              FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = ${row.fork_source_thread_id}
                AND run.ordinal <= (SELECT ordinal FROM fork_run)
                AND EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.run_id = run.run_id
                  LIMIT 1
                )
              ORDER BY run.ordinal DESC
              LIMIT 1
            )
            SELECT COALESCE(
              (SELECT ordinal FROM fork_boundary),
              (
                SELECT ordinal
                FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${row.fork_source_thread_id}
                  AND run_id IS NULL
                  AND json_extract(payload_json, '$.historyOrigin') = 'v1_import'
                ORDER BY ordinal DESC, turn_item_id DESC
                LIMIT 1
              ),
              -1
            ) AS ordinal
          `;
          maxOrdinal = boundaryRows[0]?.ordinal ?? -1;
          currentThreadId = row.fork_source_thread_id;
        }
        return sources.reverse();
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getThreadActivityPage: ProjectionStoreV2Shape["getThreadActivityPage"] = (input) =>
      Effect.gen(function* () {
        const sources = yield* resolveActivitySources(input.threadId);
        return yield* getSemanticActivityPage(sql, { ...input, sources }).pipe(
          Effect.mapError(mapSemanticActivityError(input.threadId)),
        );
      });

    const getThreadSnapshotWindow: ProjectionStoreV2Shape["getThreadSnapshotWindow"] = (
      threadId,
      options,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const anchorTarget =
              options.anchorItemId !== undefined
                ? {
                    itemId: options.anchorItemId,
                    threadId: options.anchorThreadId,
                  }
                : options.throughEntryId === undefined
                  ? undefined
                  : yield* sql<{
                      readonly thread_id: string;
                      readonly turn_item_id: string;
                    }>`
                    SELECT thread_id, turn_item_id
                    FROM orchestration_v2_projection_turn_items
                    WHERE turn_item_id = ${options.throughEntryId}
                      OR json_extract(payload_json, '$.messageId') = ${options.throughEntryId}
                    ORDER BY thread_id = ${threadId} DESC, ordinal DESC
                    LIMIT 1
                  `.pipe(
                      Effect.map((rows) => {
                        const row = rows[0];
                        return row === undefined
                          ? undefined
                          : {
                              itemId: TurnItemId.make(row.turn_item_id),
                              threadId: ThreadId.make(row.thread_id),
                            };
                      }),
                    );
            const historyAnchor =
              anchorTarget === undefined
                ? undefined
                : {
                    itemId: anchorTarget.itemId,
                    threadId:
                      anchorTarget.threadId ??
                      (yield* sql<{ readonly thread_id: string }>`
                      SELECT thread_id
                      FROM orchestration_v2_projection_turn_items
                      WHERE turn_item_id = ${anchorTarget.itemId}
                      LIMIT 1
                    `).map((row) => ThreadId.make(row.thread_id))[0] ??
                      threadId,
                  };
            if (options.throughEntryId !== undefined && historyAnchor === undefined) {
              return yield* new ProjectionStoreActivityNotFoundError({
                threadId,
                anchorItemId: TurnItemId.make(options.throughEntryId),
              });
            }
            const projection = yield* readProjection(threadId, new Set(), {
              rowLimit: options.rowLimit,
              compact: options.activityMode === "summary-v1" || options.compactTimeline === true,
              userTurnLimit: options.userTurnLimit,
              ...(historyAnchor?.threadId === threadId
                ? { anchorItemId: historyAnchor.itemId }
                : {}),
              ...(historyAnchor === undefined ? {} : { historyAnchor }),
            });
            if (
              options.throughEntryId !== undefined &&
              !projection.visibleTurnItems.some(
                (row) =>
                  row.sourceItemId === historyAnchor?.itemId &&
                  row.sourceThreadId === historyAnchor.threadId,
              )
            ) {
              return yield* new ProjectionStoreActivityNotFoundError({
                threadId,
                anchorItemId: historyAnchor?.itemId,
              });
            }
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
              SELECT MAX(sequence) AS snapshot_sequence
              FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            `;
            if (options.activityMode !== "summary-v1") {
              return {
                schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
                snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
                projection,
              };
            }
            const sources = yield* resolveActivitySources(threadId);
            const summarySources = sources.flatMap((source) => {
              const range = projection.visibleTurnItems.reduce<
                { from: number; to: number } | undefined
              >((acc, row) => {
                if (row.sourceThreadId !== source.threadId) {
                  return acc;
                }
                return acc === undefined
                  ? { from: row.item.ordinal, to: row.item.ordinal }
                  : {
                      from: Math.min(acc.from, row.item.ordinal),
                      to: Math.max(acc.to, row.item.ordinal),
                    };
              }, undefined);
              return range === undefined ? [] : [{ ...source, ordinalRange: range }];
            });
            const activitySummaries = yield* getSemanticActivitySummaries(sql, {
              threadId,
              sources: summarySources,
            }).pipe(Effect.mapError(mapSemanticActivityError(threadId)));
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
              activityMode: "summary-v1" as const,
              activitySummaries,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const selectShellThreadRows = (
      threadId?: ThreadId,
      location?: "active" | "archive",
      unsettledOnly = false,
      filters: Pick<ShellSnapshotOptions, "projectId" | "worktreePath" | "threadIds"> = {},
    ) =>
      sql<ShellThreadRow>`
            SELECT
              t.thread_id,
              t.payload_json,
              CASE
                WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
                  THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
                ELSE NULL
              END AS forked_from_run_source_thread_id,
              presented.run_id AS latest_run_id,
              presented.status AS latest_run_status,
              presented.requested_at AS latest_run_requested_at,
              json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
              presented.completed_at AS latest_run_completed_at,
              json_extract(presented.payload_json, '$.workCompletedAt') AS latest_run_work_completed_at,
              (
                SELECT r.run_id
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS active_run_id,
              (
                SELECT r.status
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_status,
              (
                -- Mirrors orchestrationV2RunWorkStartedAt.
                SELECT COALESCE(
                  json_extract(r.payload_json, '$.workStartedAt'),
                  json_extract(r.payload_json, '$.startedAt'),
                  r.requested_at
                )
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_started_at,
              (
                SELECT json_extract(r.payload_json, '$.workCompletedAt')
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_work_completed_at,
              (
                SELECT json_extract(session.payload_json, '$.lastError')
                FROM orchestration_v2_projection_provider_sessions session
                INNER JOIN orchestration_v2_projection_provider_session_bindings binding
                  ON binding.provider_session_id = session.provider_session_id
                WHERE binding.thread_id = t.thread_id
                  AND session.provider_instance_id = t.provider_instance_id
                ORDER BY session.updated_at DESC, session.provider_session_id DESC
                LIMIT 1
              ) AS last_error,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                INNER JOIN orchestration_v2_projection_runs r ON r.run_id = item.run_id
                WHERE r.run_id = presented.run_id
                  AND r.status = 'failed'
                  AND item.thread_id = t.thread_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(r.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS terminal_failure_payload_json,
              blocked.run_id AS blocking_run_id,
              blocked.requested_at AS blocking_run_requested_at,
              json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
              blocked.completed_at AS blocking_run_completed_at,
              json_extract(blocked.payload_json, '$.workCompletedAt') AS blocking_run_work_completed_at,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE item.thread_id = t.thread_id
                  AND item.run_id = blocked.run_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS blocking_failure_payload_json,
              (
                SELECT request.payload_json
                FROM orchestration_v2_projection_runtime_requests request
                WHERE request.thread_id = t.thread_id
                  AND request.status = 'pending'
                ORDER BY request.created_at DESC, request.runtime_request_id DESC
                LIMIT 1
              ) AS pending_request_payload_json,
              (
                SELECT secret.payload_json
                -- Keep runs outermost so completed history is never scanned for a pending secret.
                FROM orchestration_v2_projection_runs r
                CROSS JOIN orchestration_v2_projection_turn_items secret
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                  AND secret.thread_id = t.thread_id AND secret.run_id = r.run_id
                  AND secret.type = 'secret_request' AND secret.status = 'waiting'
                ORDER BY secret.updated_at DESC, secret.turn_item_id DESC
                LIMIT 1
              ) AS pending_secret_request_payload_json,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at,
              EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_plans plan
                WHERE plan.thread_id = t.thread_id
                  AND plan.kind = 'proposed_plan'
                  AND plan.status = 'active'
              ) AS has_actionable_proposed_plan,
              -- Count per run on the covering (thread_id, run_id) index, then
              -- look up each run once, instead of one run lookup per item.
              (
                SELECT COALESCE(SUM(per_run.item_count), 0)
                FROM (
                  SELECT i.run_id, COUNT(*) AS item_count
                  FROM orchestration_v2_projection_turn_items i
                  WHERE i.thread_id = t.thread_id
                  GROUP BY i.run_id
                ) per_run
                LEFT JOIN orchestration_v2_projection_runs r
                  ON r.run_id = per_run.run_id
                WHERE per_run.run_id IS NULL OR r.status <> 'rolled_back'
              ) AS item_count,
              (
                SELECT COUNT(*)
                FROM orchestration_v2_projection_turn_items i
                WHERE i.thread_id = t.thread_id
                  AND i.run_id IS NULL
              ) AS runless_item_count
            FROM orchestration_v2_projection_threads t
            -- The newest run not waiting in a held queue, matching latestUnheldRun.
            LEFT JOIN orchestration_v2_projection_runs presented ON presented.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND NOT (
                  candidate.status = 'queued'
                  AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
                )
              ORDER BY candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            )
            LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND candidate.status <> 'queued'
                AND NOT (
                  candidate.status = 'cancelled'
                  AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
                )
              -- latestExecutedRun: the run that ended last (runRanAfter).
              ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
                candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            ) AND blocked.status = 'failed'
            WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`} ${
              location === "active"
                ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
                : location === "archive"
                  ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NOT NULL`
                  : sql``
            }${
              unsettledOnly
                ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
                : sql``
            }${
              filters.projectId === undefined
                ? sql``
                : sql` AND t.project_id = ${filters.projectId}`
            }${
              filters.worktreePath === undefined
                ? sql``
                : sql` AND json_extract(t.payload_json, '$.worktreePath') = ${filters.worktreePath}`
            }${
              filters.threadIds === undefined
                ? sql``
                : sql` AND t.thread_id IN (SELECT value FROM json_each(${encodeIdList(filters.threadIds)}))`
            }
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;

    const selectShellRunRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
          `
        : sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
            WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
          `;

    const selectShellRunItemCounts = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
            GROUP BY thread_id, run_id
          `
        : sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
              AND thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
            GROUP BY thread_id, run_id
          `;

    const selectShellProviderThreadRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IS NOT NULL
          `
        : sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
          `;

    const selectShellPendingTurnItemRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<PayloadRow & { readonly thread_id: string }>`
            SELECT i.thread_id, i.payload_json
            FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r
              ON r.run_id = i.run_id
            WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
              -- A rolled-back run's items are abandoned, not pending. Without
              -- this the shell reports Waiting for work no one will finish,
              -- matching the item_count query's exclusion above.
              AND (i.run_id IS NULL OR r.status <> 'rolled_back')
          `
        : sql<PayloadRow & { readonly thread_id: string }>`
            SELECT i.thread_id, i.payload_json
            FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r
              ON r.run_id = i.run_id
            WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
              AND (i.run_id IS NULL OR r.status <> 'rolled_back')
              AND i.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
          `;

    const runMapsByThreadId = (input: {
      readonly runRows: ReadonlyArray<ShellRunRow>;
      readonly itemCountRows: ReadonlyArray<ShellRunItemCountRow>;
    }) => {
      const runOrdinalsByThreadId = new Map<ThreadId, Map<RunId, number>>();
      for (const row of input.runRows) {
        const threadId = ThreadId.make(row.thread_id);
        const runId = RunId.make(row.run_id);
        const existing = runOrdinalsByThreadId.get(threadId) ?? new Map<RunId, number>();
        existing.set(runId, row.ordinal);
        runOrdinalsByThreadId.set(threadId, existing);
      }
      const itemCountsByThreadId = new Map<ThreadId, Map<RunId, number>>();
      for (const row of input.itemCountRows) {
        const threadId = ThreadId.make(row.thread_id);
        const runId = RunId.make(row.run_id);
        const existing = itemCountsByThreadId.get(threadId) ?? new Map<RunId, number>();
        existing.set(runId, row.item_count);
        itemCountsByThreadId.set(threadId, existing);
      }
      return { runOrdinalsByThreadId, itemCountsByThreadId };
    };

    const pendingBackgroundDataByThreadId = (input: {
      readonly providerThreadRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
      readonly pendingTurnItemRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
    }) =>
      Effect.gen(function* () {
        const providerThreadsByThreadId = new Map<
          ThreadId,
          Array<OrchestrationV2ThreadProjection["providerThreads"][number]>
        >();
        for (const row of input.providerThreadRows) {
          const providerThread = yield* decodeProviderThreadPayload(row.payload_json);
          const threadId =
            row.thread_id.length > 0 ? ThreadId.make(row.thread_id) : providerThread.appThreadId;
          if (threadId === null) {
            continue;
          }
          const existing = providerThreadsByThreadId.get(threadId) ?? [];
          existing.push(providerThread);
          providerThreadsByThreadId.set(threadId, existing);
        }

        const pendingTurnItemsByThreadId = new Map<ThreadId, Array<OrchestrationV2TurnItem>>();
        for (const row of input.pendingTurnItemRows) {
          const turnItem = yield* decodeTurnItemPayload(row.payload_json);
          const threadId = ThreadId.make(row.thread_id);
          const existing = pendingTurnItemsByThreadId.get(threadId) ?? [];
          existing.push(turnItem);
          pendingTurnItemsByThreadId.set(threadId, existing);
        }

        return { providerThreadsByThreadId, pendingTurnItemsByThreadId };
      });

    const getSettlementCandidates: ProjectionStoreV2Shape["getSettlementCandidates"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Settlement needs activity timestamps, not item counts, run history,
            // provider sessions or inherited fork rows. Reject parked and busy
            // threads before loading the remaining candidates' background work.
            const rows = yield* sql<SettlementThreadRow>`
            SELECT t.thread_id, t.payload_json,
              r.run_id AS latest_run_id,
              r.status AS latest_run_status,
              r.requested_at AS latest_run_requested_at,
              json_extract(r.payload_json, '$.startedAt') AS latest_run_started_at,
              r.completed_at AS latest_run_completed_at,
              json_extract(r.payload_json, '$.workCompletedAt') AS latest_run_work_completed_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id AND message.role = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
              SELECT latest.run_id FROM orchestration_v2_projection_runs latest
              WHERE latest.thread_id = t.thread_id
              ORDER BY latest.ordinal DESC, latest.run_id DESC
              LIMIT 1
            )
            WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}
              AND json_extract(t.payload_json, '$.archivedAt') IS NULL
              AND json_extract(t.payload_json, '$.settledOverride') IS NULL
              AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
              AND json_extract(t.payload_json, '$.autoSettleDisabledAt') IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs active
                WHERE active.thread_id = t.thread_id
                  AND active.status IN ('preparing', 'starting', 'running', 'waiting')
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runtime_requests request
                WHERE request.thread_id = t.thread_id AND request.status = 'pending'
              )
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;
            if (rows.length === 0) return [];
            const threadIds = rows.map((row) => ThreadId.make(row.thread_id));
            const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
              yield* pendingBackgroundDataByThreadId({
                providerThreadRows: yield* selectShellProviderThreadRows(threadIds),
                pendingTurnItemRows: yield* selectShellPendingTurnItemRows(threadIds),
              });
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const thread = yield* decodeThreadPayload(row.payload_json);
                const status = shellStatusFromStoredRunStatus(row.latest_run_status);
                const latestRunId =
                  row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
                return {
                  ...thread,
                  pinnedAt: thread.pinnedAt ?? null,

                  autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
                  snoozedUntil: thread.snoozedUntil ?? null,
                  snoozedAt: thread.snoozedAt ?? null,
                  status,
                  latestRunId,
                  latestRunRequestedAt:
                    row.latest_run_requested_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_requested_at),
                  latestRunStartedAt:
                    row.latest_run_started_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_started_at),
                  latestRunCompletedAt:
                    row.latest_run_completed_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_completed_at),
                  latestUserMessageAt:
                    row.latest_user_message_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_user_message_at),
                  latestUserAuthoredMessageAt:
                    row.latest_user_authored_message_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_user_authored_message_at),
                  activityRunStatus: null,
                  activityRunStartedAt: null,
                  pendingRuntimeRequest: null,
                  pendingBackgroundTasks: derivePendingBackgroundWork({
                    latestRun:
                      latestRunId === null || status === "idle"
                        ? null
                        : { id: latestRunId, ordinal: 0, status },
                    providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
                    turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
                    activeProviderThreadId: thread.activeProviderThreadId,
                    hasActiveRun: false,
                    pullRequests: thread.pullRequests,
                  }),
                } satisfies ProjectionSettlementCandidate;
              }),
            );
          }),
        )
        .pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    const getThreadsWithPullRequests: ProjectionStoreV2Shape["getThreadsWithPullRequests"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND thread_id = ${threadId}`}
            AND json_extract(payload_json, '$.archivedAt') IS NULL
            AND json_array_length(payload_json, '$.pullRequests') > 0
          ORDER BY updated_at ASC, thread_id ASC
        `;
        return yield* Effect.forEach(rows, (row) =>
          decodeThreadPayload(row.payload_json).pipe(
            Effect.map((thread): ProjectionThreadPullRequests => ({
              id: thread.id,
              projectId: thread.projectId,
              lineage: thread.lineage,
              settledOverride: thread.settledOverride,
              settledAt: thread.settledAt,
              pullRequests: thread.pullRequests ?? [],
            })),
          ),
        );
      }).pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    const shellThreadStateFromRow = (input: {
      readonly row: ShellThreadRow;
      readonly runOrdinalsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly itemCountsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly providerThreadsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>
      >;
      readonly pendingTurnItemsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2TurnItem>
      >;
    }) =>
      Effect.gen(function* () {
        const {
          row,
          runOrdinalsByThreadId,
          itemCountsByThreadId,
          providerThreadsByThreadId,
          pendingTurnItemsByThreadId,
        } = input;
        const thread = yield* decodeThreadPayload(row.payload_json);
        const pendingRuntimeRequest =
          row.pending_request_payload_json !== null
            ? yield* decodeRuntimeRequestPayload(row.pending_request_payload_json)
            : row.pending_secret_request_payload_json !== null
              ? secretRequestAsPendingInput(
                  yield* decodeTurnItemPayload(row.pending_secret_request_payload_json),
                )
              : null;
        let terminalFailureItem =
          row.terminal_failure_payload_json === null
            ? null
            : yield* decodeTurnItemPayload(row.terminal_failure_payload_json);
        let latestRunId = row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
        let latestRunStatus = shellStatusFromStoredRunStatus(row.latest_run_status);
        let latestRunRequestedAt =
          row.latest_run_requested_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_requested_at);
        let latestRunStartedAt =
          row.latest_run_started_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_started_at);
        let latestRunCompletedAt =
          row.latest_run_completed_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_completed_at);
        let latestRunWorkCompletedAt =
          row.latest_run_work_completed_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_work_completed_at);
        if (row.blocking_run_id !== null && row.blocking_failure_payload_json !== null) {
          const blockingFailure = yield* decodeTurnItemPayload(
            row.blocking_failure_payload_json,
          ).pipe(Effect.orElseSucceed(() => null));
          const blocksQueue =
            threadErrorSummary(
              blockingFailure?.type === "error" ? blockingFailure.failure : null,
              row.last_error,
            ).lastErrorClass === "usage_limit";
          if (blocksQueue && blockingFailure !== null) {
            terminalFailureItem = blockingFailure;
            latestRunId = RunId.make(row.blocking_run_id);
            latestRunStatus = "failed";
            latestRunRequestedAt =
              row.blocking_run_requested_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_requested_at);
            latestRunStartedAt =
              row.blocking_run_started_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_started_at);
            latestRunCompletedAt =
              row.blocking_run_completed_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_completed_at);
            latestRunWorkCompletedAt =
              row.blocking_run_work_completed_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_work_completed_at);
          }
        }
        const providerThreads = providerThreadsByThreadId.get(thread.id) ?? [];
        let updatedAt = thread.updatedAt;
        for (const providerThread of providerThreads) {
          if (providerThread.appThreadId !== thread.id || providerThread.ownerNodeId !== null) {
            continue;
          }
          if (
            DateTime.toEpochMillis(providerThread.updatedAt) > DateTime.toEpochMillis(updatedAt)
          ) {
            updatedAt = providerThread.updatedAt;
          }
        }
        const pendingBackgroundTasks = [
          ...derivePendingBackgroundWork({
            latestRun:
              latestRunId === null || latestRunStatus === "idle"
                ? null
                : {
                    id: latestRunId,
                    ordinal: 0,
                    status: latestRunStatus,
                  },
            providerThreads,
            turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
            activeProviderThreadId: thread.activeProviderThreadId,
            hasActiveRun: row.active_run_id !== null,
            pullRequests: thread.pullRequests,
          }),
          ...(row.active_run_id === null
            ? []
            : activeBackgroundJobWaitSignal(providerThreads, thread.activeProviderThreadId)),
        ];
        return {
          thread,
          latestRunId,
          latestRunStatus,
          latestRunRequestedAt,
          latestRunStartedAt,
          latestRunCompletedAt,
          latestRunWorkCompletedAt,
          activeRunId: row.active_run_id === null ? null : RunId.make(row.active_run_id),
          activityRunStartedAt:
            row.activity_run_started_at === null
              ? null
              : DateTime.makeUnsafe(row.activity_run_started_at),
          activityRunWorkCompletedAt:
            row.activity_run_work_completed_at === null
              ? null
              : DateTime.makeUnsafe(row.activity_run_work_completed_at),
          activityRunStatus:
            row.activity_run_status === "preparing" ||
            row.activity_run_status === "starting" ||
            row.activity_run_status === "running" ||
            row.activity_run_status === "waiting"
              ? row.activity_run_status
              : null,
          ...threadErrorSummary(
            terminalFailureItem?.type === "error" ? terminalFailureItem.failure : null,
            row.last_error,
          ),
          pendingRuntimeRequest,
          latestUserMessageAt:
            row.latest_user_message_at === null
              ? null
              : DateTime.makeUnsafe(row.latest_user_message_at),
          latestUserAuthoredMessageAt:
            row.latest_user_authored_message_at === null
              ? null
              : DateTime.makeUnsafe(row.latest_user_authored_message_at),
          hasActionableProposedPlan: row.has_actionable_proposed_plan === 1,
          pendingBackgroundTasks,
          providerInstanceHistory: providerInstanceHistoryForShell({
            threadId: thread.id,
            providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
          }),
          goal: activeProviderGoalForShell(
            providerThreadsByThreadId.get(thread.id) ?? [],
            thread.activeProviderThreadId,
          ),
          itemCount: row.item_count,
          runlessItemCount: row.runless_item_count,
          updatedAt,
          runOrdinalById: runOrdinalsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
          itemCountByRunId: itemCountsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
        } satisfies ShellThreadState;
      });

    const getShellSnapshot: ProjectionStoreV2Shape["getShellSnapshot"] = (options) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const targetThreadRows = yield* selectShellThreadRows(
              undefined,
              options?.location,
              options?.unsettledOnly ?? false,
              options ?? {},
            );
            const targetThreadIds = new Set(
              targetThreadRows.map((row) => ThreadId.make(row.thread_id)),
            );
            const rowsByThreadId = new Map(
              targetThreadRows.map((row) => [ThreadId.make(row.thread_id), row] as const),
            );
            const pendingSourceIds = targetThreadRows.flatMap((row) =>
              row.forked_from_run_source_thread_id === null
                ? []
                : [ThreadId.make(row.forked_from_run_source_thread_id)],
            );
            while (pendingSourceIds.length > 0) {
              const sourceId = pendingSourceIds.pop();
              if (sourceId === undefined || rowsByThreadId.has(sourceId)) continue;
              const source = (yield* selectShellThreadRows(sourceId))[0];
              if (source === undefined) continue;
              rowsByThreadId.set(sourceId, source);
              if (source.forked_from_run_source_thread_id !== null) {
                pendingSourceIds.push(ThreadId.make(source.forked_from_run_source_thread_id));
              }
            }
            const threadRows = [...rowsByThreadId.values()];
            const threadIds = [...rowsByThreadId.keys()];
            const forkSourceIds = shellForkSourceIds(threadRows);
            const readForThreadIds = <A>(
              read: (ids: ReadonlyArray<ThreadId>) => Effect.Effect<ReadonlyArray<A>, unknown>,
              ids: ReadonlyArray<ThreadId> = threadIds,
            ) => (ids.length === 0 ? Effect.succeed([] as ReadonlyArray<A>) : read(ids));
            const [runRows, itemCountRows, sequenceRows, providerThreadRows, pendingTurnItemRows] =
              yield* Effect.all([
                readForThreadIds(selectShellRunRows, forkSourceIds),
                readForThreadIds(selectShellRunItemCounts, forkSourceIds),
                sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
          `,
                readForThreadIds(selectShellProviderThreadRows),
                readForThreadIds(selectShellPendingTurnItemRows),
              ]);

            const { runOrdinalsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
              runRows,
              itemCountRows,
            });
            const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
              yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });
            const states = yield* Effect.forEach(threadRows, (row) =>
              shellThreadStateFromRow({
                row,
                runOrdinalsByThreadId,
                itemCountsByThreadId,
                providerThreadsByThreadId,
                pendingTurnItemsByThreadId,
              }),
            );
            const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));

            const shells = states
              .filter((state) => targetThreadIds.has(state.thread.id))
              .map((state) =>
                shellFromState({
                  state,
                  visibleItemCount: visibleItemCountForShell({
                    threadId: state.thread.id,
                    statesByThreadId,
                  }),
                }),
              );

            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0,
              threads: shells.filter((thread) => thread.archivedAt === null),
              archivedThreads: shells.filter((thread) => thread.archivedAt !== null),
            };
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectionStoreReadError({
                threadId: ThreadId.make("thread:shell"),
                cause,
              }),
          ),
        );
    const countThreads: ProjectionStoreV2Shape["countThreads"] = () =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(
          (cause) =>
            new ProjectionStoreReadError({
              threadId: ThreadId.make("thread:shell"),
              cause,
            }),
        ),
      );

    const listActiveShellIndex: ProjectionStoreV2Shape["listActiveShellIndex"] = () =>
      sql<{
        readonly thread_id: string;
        readonly project_id: string;
        readonly relationship_to_parent: string | null;
        readonly parent_thread_id: string | null;
        readonly root_thread_id: string;
        readonly settled_override: string | null;
        readonly settled_at: string | null;
        readonly pinned_at: string | null;
        readonly snoozed_until: string | null;
        readonly may_be_live: number;
      }>`
        SELECT
          t.thread_id,
          t.project_id,
          json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
          json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
          json_extract(t.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
          json_extract(t.payload_json, '$.settledOverride') AS settled_override,
          json_extract(t.payload_json, '$.settledAt') AS settled_at,
          json_extract(t.payload_json, '$.pinnedAt') AS pinned_at,
          json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
          (
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items item
              WHERE item.thread_id = t.thread_id
                AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items link_request
              WHERE link_request.thread_id = t.thread_id
                AND link_request.type = 'link_request' AND link_request.status = 'waiting'
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_provider_threads provider_thread
              WHERE provider_thread.thread_id = t.thread_id
                AND json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
            )
            OR EXISTS (
              SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
              WHERE json_type(link.value, '$.watch') IS NOT NULL
            )
          ) AS may_be_live
        FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL
          AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        ORDER BY t.updated_at ASC, t.thread_id ASC
      `.pipe(
        Effect.map((rows) =>
          rows.map((row): ActiveShellIndexEntry => ({
            id: ThreadId.make(row.thread_id),
            projectId: ProjectId.make(row.project_id),
            lineage: {
              parentThreadId:
                row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
              relationshipToParent:
                row.relationship_to_parent === "fork" || row.relationship_to_parent === "subagent"
                  ? row.relationship_to_parent
                  : null,
              rootThreadId: ThreadId.make(row.root_thread_id),
            },
            settledOverride:
              row.settled_override === "settled" || row.settled_override === "active"
                ? row.settled_override
                : null,
            settledAt: row.settled_at === null ? null : DateTime.makeUnsafe(row.settled_at),
            pinnedAt: row.pinned_at === null ? null : DateTime.makeUnsafe(row.pinned_at),
            snoozedUntil:
              row.snoozed_until === null ? null : DateTime.makeUnsafe(row.snoozed_until),
            mayBeLive: row.may_be_live === 1,
          })),
        ),
        Effect.mapError(
          (cause) =>
            new ProjectionStoreReadError({
              threadId: ThreadId.make("thread:shell"),
              cause,
            }),
        ),
      );

    // Per-thread shell for the live shell streams: reads only the target thread
    // plus its fork-source chain instead of materializing every thread. Returns
    // null when the thread is deleted or unknown.
    const getThreadShell: ProjectionStoreV2Shape["getThreadShell"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rowsByThreadId = new Map<ThreadId, ShellThreadRow>();
            const pending: Array<ThreadId> = [threadId];
            while (pending.length > 0) {
              const nextId = pending.pop();
              if (nextId === undefined || rowsByThreadId.has(nextId)) {
                continue;
              }
              const rows = yield* selectShellThreadRows(nextId);
              const row = rows[0];
              if (row === undefined) {
                continue;
              }
              rowsByThreadId.set(nextId, row);
              if (row.forked_from_run_source_thread_id !== null) {
                pending.push(ThreadId.make(row.forked_from_run_source_thread_id));
              }
            }
            if (!rowsByThreadId.has(threadId)) {
              return null;
            }

            const threadIds = [...rowsByThreadId.keys()];
            const forkSourceIds = shellForkSourceIds([...rowsByThreadId.values()]);
            const [runRows, itemCountRows, providerThreadRows, pendingTurnItemRows] =
              yield* Effect.all([
                forkSourceIds.length === 0
                  ? Effect.succeed([] as ReadonlyArray<ShellRunRow>)
                  : selectShellRunRows(forkSourceIds),
                forkSourceIds.length === 0
                  ? Effect.succeed([] as ReadonlyArray<ShellRunItemCountRow>)
                  : selectShellRunItemCounts(forkSourceIds),
                selectShellProviderThreadRows(threadIds),
                selectShellPendingTurnItemRows(threadIds),
              ]);
            const { runOrdinalsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
              runRows,
              itemCountRows,
            });
            const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
              yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });

            const states = yield* Effect.forEach([...rowsByThreadId.values()], (row) =>
              shellThreadStateFromRow({
                row,
                runOrdinalsByThreadId,
                itemCountsByThreadId,
                providerThreadsByThreadId,
                pendingTurnItemsByThreadId,
              }),
            );
            const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));
            const state = statesByThreadId.get(threadId);
            if (state === undefined) {
              return null;
            }
            return shellFromState({
              state,
              visibleItemCount: visibleItemCountForShell({ threadId, statesByThreadId }),
            });
          }),
        )
        .pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    return {
      apply,
      getShellSnapshot,
      countThreads,
      listActiveShellIndex,
      getThreadShell,
      getThread,
      getSettlementCandidates,
      getThreadsWithPullRequests,
      getThreadProjection,
      getTurnStartContext,
      getTurnStartHistory,
      getRuntimeRecoveryProjection,
      getRunningTurnContext,
      getThreadProviderContext,
      getRuntimeResponseContext,
      getCheckpointContext,
      getCheckpointCaptureContext,
      getRunMessage,
      canStartQueuedRun,
      getHeldQueuedRuns,
      getPendingNativeUserInputs,
      hasUnpairedRunInterruptRequest,
      isNodeStored,
      getMessageCount,
      getSubagentCount,
      getNextTurnItemOrdinal,
      getTurnItem,
      getThreadRecords,
      getRuntimeRequest,
      getPlan,
      getProviderControlContext,
      getLimitRecoveryCandidates,
      getLimitRecoveryWakeAt,
      getRecoveryThreadIds,
      getUnreadableThreadIds,
      getThreadSnapshot,
      getThreadSnapshotWindow,
      getThreadActivityPage,
      getTimelinePage,
      searchThread,
      searchThreadStream,
      getThreadAttachmentIds,
    } satisfies ProjectionStoreV2Shape;
  }),
);

const MEMORY_ACTIVITY_PREVIEW_MAX_LENGTH = 160;

/** Mirrors the SQL summary-v1 conversational types, which are kept as messages, not activity. */
const CONVERSATIONAL_MEMORY_ITEM_TYPES: Record<string, true> = {
  user_message: true,
  assistant_message: true,
  proposed_plan: true,
};

type MemoryActivityGroup = [
  OrchestrationV2ProjectedTurnItem,
  ...Array<OrchestrationV2ProjectedTurnItem>,
];

/**
 * Mirrors the SQL group key (sourceThreadId, groupStartItemId): each source's group starts at a
 * visible turn start, or at its first visible row, and runs until that source's next turn start.
 */
const groupMemoryActivityRows = (
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): Array<MemoryActivityGroup> => {
  const openGroups = new Map<string, MemoryActivityGroup>();
  const groupsBySource = new Map<string, Array<MemoryActivityGroup>>();
  for (const row of rows) {
    const open = openGroups.get(row.sourceThreadId);
    if (open !== undefined && !isThreadHistoryTurnStart(row.item)) {
      open.push(row);
      continue;
    }
    const group: MemoryActivityGroup = [row];
    openGroups.set(row.sourceThreadId, group);
    const sourceGroups = groupsBySource.get(row.sourceThreadId) ?? [];
    sourceGroups.push(group);
    groupsBySource.set(row.sourceThreadId, sourceGroups);
  }
  return [...groupsBySource.values()].flat();
};

/** Mirrors SQL `firstPreviewText`: the first activity row with non-space text decides, then trim and cap. */
const firstMemoryPreview = (
  activityRows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  read: (item: OrchestrationV2ProjectedTurnItem["item"]) => string | null | undefined,
): string | null => {
  for (const row of activityRows) {
    const text = read(row.item);
    if (text === undefined || text === null || !/[^ ]/.test(text)) continue;
    const trimmed = text.trim();
    return trimmed === "" ? null : trimmed.slice(0, MEMORY_ACTIVITY_PREVIEW_MAX_LENGTH);
  }
  return null;
};

const countMemoryValues = (values: ReadonlyArray<string>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

/** Earliest or latest timestamp by epoch millis; null when no row carries one. */
const extremeMemoryTimestamp = (
  values: ReadonlyArray<DateTime.Utc | null>,
  latest: boolean,
): DateTime.Utc | null => {
  let best: DateTime.Utc | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null) {
      best = value;
      continue;
    }
    const valueMillis = DateTime.toEpochMillis(value);
    const bestMillis = DateTime.toEpochMillis(best);
    if (latest ? valueMillis > bestMillis : valueMillis < bestMillis) best = value;
  }
  return best;
};

const summarizeMemoryActivityGroup = (
  group: MemoryActivityGroup,
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2ThreadActivitySummary => {
  const [head] = group;
  // Mirrors SQL `activityItem`: user and assistant messages are conversation, not activity.
  const activityRows = group.filter(
    (row) => row.item.type !== "user_message" && row.item.type !== "assistant_message",
  );
  const first = activityRows[0] ?? head;
  const last = activityRows.at(-1) ?? group.at(-1) ?? head;
  const filesEdited = new Set<string>();
  let stepCount = 0;
  let added = 0;
  let removed = 0;
  let hasFailure = false;
  for (const row of activityRows) {
    const { item } = row;
    if (item.type !== "reasoning") stepCount += 1;
    if (
      item.status === "failed" ||
      item.type === "error" ||
      ("outputIndicatesFailure" in item && item.outputIndicatesFailure === true)
    ) {
      hasFailure = true;
    }
    if (item.type === "file_change") {
      filesEdited.add(item.fileName);
      added += item.additions ?? 0;
      removed += item.deletions ?? 0;
    }
  }
  // Timestamps come from activity rows when there are any, else from the whole group.
  const timedRows = activityRows.length > 0 ? activityRows : group;
  const runId = head.item.runId;
  return {
    sourceThreadId: head.sourceThreadId,
    groupStartItemId: head.sourceItemId,
    turnStartItemId: isThreadHistoryTurnStart(head.item) ? head.item.id : null,
    runId,
    firstItemId: first.item.id,
    firstOrdinal: first.item.ordinal,
    lastItemId: last.item.id,
    lastOrdinal: last.item.ordinal,
    activityCount: activityRows.length,
    countsByType: [...countMemoryValues(activityRows.map((row) => row.item.type))].map(
      ([type, count]) => ({ type, count }),
    ),
    statusCounts: [...countMemoryValues(activityRows.map((row) => row.item.status))].map(
      ([status, count]) => ({ status, count }),
    ),
    runStatus: runId === null ? null : (runs.find((run) => run.id === runId)?.status ?? null),
    stepCount,
    filesEditedCount: filesEdited.size,
    diffStats: { added, removed },
    hasFailure,
    labelPreview: firstMemoryPreview(activityRows, (item) => item.title),
    intentPreview: firstMemoryPreview(activityRows, (item) =>
      "intent" in item ? item.intent : undefined,
    ),
    startedAt: extremeMemoryTimestamp(
      timedRows.map((row) => row.item.startedAt),
      false,
    ),
    endedAt: extremeMemoryTimestamp(
      timedRows.map((row) => row.item.completedAt),
      true,
    ),
  };
};

/** Keeps the newest `rowLimit` rows in order; a zero limit keeps none. */
const newestMemoryRows = (
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  rowLimit: number,
): Array<OrchestrationV2ProjectedTurnItem> => {
  const start = Math.max(rows.length - rowLimit, 0);
  return rows.slice(start);
};

/**
 * Mirrors the SQL summary-v1 selection: conversational rows after the boundary (the newest
 * `rowLimit` when there are no user-turn anchors), the newest `rowLimit` activity rows after the
 * boundary, interrupt requests for kept interrupt results, and the latest row when unanchored.
 */
const selectMemorySummaryWindowRows = (
  candidates: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  input: {
    readonly boundary: number;
    readonly hasUserAnchors: boolean;
    readonly rowLimit: number;
    readonly keepLatest: boolean;
  },
): Array<OrchestrationV2ProjectedTurnItem> => {
  const bounded = candidates.slice(input.boundary);
  const conversational = bounded.filter(
    (row) => CONVERSATIONAL_MEMORY_ITEM_TYPES[row.item.type] === true,
  );
  const activity = bounded.filter(
    (row) => CONVERSATIONAL_MEMORY_ITEM_TYPES[row.item.type] !== true,
  );
  const kept = new Set<OrchestrationV2ProjectedTurnItem>([
    ...(input.hasUserAnchors ? conversational : newestMemoryRows(conversational, input.rowLimit)),
    ...newestMemoryRows(activity, input.rowLimit),
  ]);
  const keptRunIds = new Set(
    [...kept].flatMap((row) =>
      row.item.type === "run_interrupt_result" && row.item.runId !== null ? [row.item.runId] : [],
    ),
  );
  for (const row of candidates) {
    if (
      row.item.type === "run_interrupt_request" &&
      row.item.runId !== null &&
      keptRunIds.has(row.item.runId)
    ) {
      kept.add(row);
    }
  }
  const latest = candidates.at(-1);
  if (input.keepLatest && latest !== undefined) kept.add(latest);
  return candidates.filter((row) => kept.has(row));
};

/** Summaries only for groups overlapping the returned window rows' per-source ordinal range. */
const summarizeMemoryActivityGroupsInWindow = (
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<OrchestrationV2Run>,
  windowRows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): Array<OrchestrationV2ThreadActivitySummary> => {
  const ranges = new Map<string, { from: number; to: number }>();
  for (const row of windowRows) {
    const ordinal = row.item.ordinal;
    const current = ranges.get(row.sourceThreadId);
    ranges.set(
      row.sourceThreadId,
      current === undefined
        ? { from: ordinal, to: ordinal }
        : { from: Math.min(current.from, ordinal), to: Math.max(current.to, ordinal) },
    );
  }
  return groupMemoryActivityRows(rows).flatMap((group) => {
    const [head] = group;
    const range = ranges.get(head.sourceThreadId);
    if (range === undefined) {
      return [];
    }
    const first = head.item.ordinal;
    const last = group.at(-1)?.item.ordinal ?? first;
    return first <= range.to && last >= range.from
      ? [summarizeMemoryActivityGroup(group, runs)]
      : [];
  });
};

const toMemoryActivityRow = (row: OrchestrationV2ProjectedTurnItem) => ({
  position: row.position,
  visibility: row.visibility,
  sourceThreadId: row.sourceThreadId,
  sourceItemId: row.sourceItemId,
  ordinal: row.item.ordinal,
  item: row.item,
  orderKey: {
    sourceThreadId: row.sourceThreadId,
    ordinal: row.item.ordinal,
    itemId: row.sourceItemId,
  },
});

export const layerMemory: Layer.Layer<ProjectionStoreV2> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const replayState = yield* Ref.make(makeProjectionReplayState());
    const sequence = yield* Ref.make(0);

    const service: ProjectionStoreV2Shape = {
      apply: (event) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(replayState, (existing) => {
            const next: ProjectionReplayState = {
              projections: new Map(existing.projections),
              providerSessionThreadIds: new Map(existing.providerSessionThreadIds),
            };
            if (!applyToProjectionReplayState(next, event)) {
              return [
                new ProjectionStoreThreadNotFoundError({ threadId: event.threadId }),
                existing,
              ] as const;
            }
            return [undefined, next] as const;
          });

          if (result) {
            return yield* result;
          }
          yield* Ref.update(sequence, (current) => current + 1);
        }),
      getShellSnapshot: (options) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          const selectedThreadIds = [...existing.entries()]
            .filter(([, projection]) => {
              const thread = projection.thread;
              if (options?.projectId !== undefined && thread.projectId !== options.projectId)
                return false;
              if (
                options?.worktreePath !== undefined &&
                thread.worktreePath !== options.worktreePath
              )
                return false;
              if (options?.threadIds !== undefined && !options.threadIds.includes(thread.id))
                return false;
              if (
                options?.unsettledOnly &&
                (thread.settledAt !== null || thread.settledOverride === "settled")
              )
                return false;
              if (options?.location === "active") return thread.archivedAt === null;
              if (options?.location === "archive") return thread.archivedAt !== null;
              return true;
            })
            .map(([threadId]) => threadId);
          const shells = yield* Effect.forEach(
            selectedThreadIds.toSorted((left, right) => String(left).localeCompare(String(right))),
            (threadId) =>
              service.getThreadProjection(threadId).pipe(Effect.map(threadShellFromProjection)),
          );
          const visible = shells.filter((thread) => thread.deletedAt === null);
          return {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence: yield* Ref.get(sequence),
            threads: visible.filter((thread) => thread.archivedAt === null),
            archivedThreads: visible.filter((thread) => thread.archivedAt !== null),
          };
        }),
      countThreads: () =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              [...state.projections.values()].filter(
                (projection) => projection.thread.deletedAt === null,
              ).length,
          ),
        ),
      getSubagentCount: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => state.projections.get(threadId)?.subagents.length ?? 0),
        ),
      getLimitRecoveryWakeAt: (now) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const nowMs = DateTime.toEpochMillis(now);
            let wakeAt: number | null = null;
            for (const { thread } of state.projections.values()) {
              const recovery = thread.limitRecovery;
              if (thread.deletedAt !== null || recovery?.autoResume !== true) continue;
              const resetAt = Date.parse(recovery.resetAt);
              if (resetAt > nowMs && (wakeAt === null || resetAt < wakeAt)) {
                wakeAt = resetAt;
              }
              if (thread.snoozedUntil == null) continue;
              const snoozedUntil = DateTime.toEpochMillis(thread.snoozedUntil);
              if (snoozedUntil > nowMs && (wakeAt === null || snoozedUntil < wakeAt)) {
                wakeAt = snoozedUntil;
              }
            }
            return wakeAt === null ? null : Math.round(wakeAt);
          }),
        ),
      listActiveShellIndex: () =>
        service.getShellSnapshot({ location: "active" }).pipe(
          Effect.map((snapshot) =>
            snapshot.threads.map((thread): ActiveShellIndexEntry => ({
              id: thread.id,
              projectId: thread.projectId,
              lineage: thread.lineage,
              settledOverride: thread.settledOverride,
              settledAt: thread.settledAt,
              pinnedAt: thread.pinnedAt,
              snoozedUntil: thread.snoozedUntil,
              mayBeLive:
                thread.activeRunId !== null ||
                thread.activityRunStatus !== null ||
                thread.pendingRuntimeRequest !== null ||
                (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
                thread.status === "queued" ||
                thread.status === "preparing" ||
                thread.status === "starting" ||
                thread.status === "running" ||
                thread.status === "waiting" ||
                (thread.pullRequests ?? []).some((link) => link.watch != null),
            })),
          ),
        ),
      getThreadShell: (threadId) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          if (!existing.has(threadId)) {
            return null;
          }
          const shell = yield* service
            .getThreadProjection(threadId)
            .pipe(Effect.map(threadShellFromProjection));
          return shell.deletedAt === null ? shell : null;
        }),
      getThread: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection.thread;
        }),
      getSettlementCandidates: (threadId) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter(
              ({ thread, runs, runtimeRequests }) =>
                (threadId === undefined || thread.id === threadId) &&
                thread.deletedAt === null &&
                thread.archivedAt === null &&
                thread.settledOverride === null &&
                thread.pinnedAt == null &&
                thread.autoSettleDisabledAt == null &&
                !runs.some(isActivityRunForShell) &&
                !runtimeRequests.some((request) => request.status === "pending"),
            )
            .map((projection) => {
              const shell = threadShellFromProjection(projection);
              return {
                ...shell,
                latestUserAuthoredMessageAt: shell.latestUserAuthoredMessageAt ?? null,
              };
            })
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.updatedAt) - DateTime.toEpochMillis(right.updatedAt) ||
                left.id.localeCompare(right.id),
            );
        }),
      getThreadsWithPullRequests: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()]
              .map(({ thread }) => thread)
              .filter(
                (thread) =>
                  (threadId === undefined || thread.id === threadId) &&
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  (thread.pullRequests ?? []).length > 0,
              )
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(left.updatedAt) -
                    DateTime.toEpochMillis(right.updatedAt) || left.id.localeCompare(right.id),
              )
              .map((thread): ProjectionThreadPullRequests => ({
                id: thread.id,
                projectId: thread.projectId,
                lineage: thread.lineage,
                settledOverride: thread.settledOverride,
                settledAt: thread.settledAt,
                pullRequests: thread.pullRequests ?? [],
              })),
          ),
        ),
      getLimitRecoveryCandidates: (options) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()]
              .filter(
                ({ thread }) =>
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  thread.settledOverride !== "settled",
              )
              .map(threadShellFromProjection)
              .filter(
                (thread) =>
                  thread.status === "failed" &&
                  thread.lastErrorClass === "usage_limit" &&
                  thread.usageLimitResetAt !== null &&
                  thread.pendingRuntimeRequest === null,
              )
              .filter((thread) => {
                const resetMs = Date.parse(thread.usageLimitResetAt!);
                const nowMs = DateTime.toEpochMillis(options.now);
                if (
                  !Number.isFinite(resetMs) ||
                  resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
                )
                  return false;
                if (
                  thread.limitRecovery?.runId !== thread.latestRunId ||
                  thread.limitRecovery.resetAt !== thread.usageLimitResetAt
                ) {
                  return options.autoResume || (options.snooze && resetMs > nowMs);
                }
                return (
                  thread.limitRecovery.autoResume &&
                  resetMs <= nowMs &&
                  (thread.snoozedUntil == null ||
                    DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs)
                );
              })
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          ),
        ),
      getRecoveryThreadIds: (kind) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter((projection) => needsRecovery(projection, kind))
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.thread.updatedAt) -
                  DateTime.toEpochMillis(right.thread.updatedAt) ||
                left.thread.id.localeCompare(right.thread.id),
            )
            .map((projection) => projection.thread.id);
        }),
      getUnreadableThreadIds: () => Effect.succeed([]),
      getPendingNativeUserInputs: (threadId, providerTurnId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) return { runtimeRequests: [], nodes: [], turnItems: [] };
          const runtimeRequests = projection.runtimeRequests.filter(
            (request) =>
              request.providerTurnId === providerTurnId &&
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type !== "message",
          );
          const requestIds = new Set(runtimeRequests.map((request) => request.id));
          const nodeIds = new Set(runtimeRequests.map((request) => request.nodeId));
          return {
            runtimeRequests,
            nodes: projection.nodes.filter((node) => nodeIds.has(node.id)),
            turnItems: projection.turnItems.filter(
              (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
            ),
          };
        }),
      getPlan: (threadId, planId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return projection.plans.find((plan) => plan.id === planId);
        }),
      hasUnpairedRunInterruptRequest: (threadId, requestId, resultId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          return (
            projection !== undefined &&
            projection.turnItems.some((item) => item.id === requestId) &&
            !projection.turnItems.some((item) => item.id === resultId)
          );
        }),
      isNodeStored: (node) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const stored = state.projections
              .get(node.threadId)
              ?.nodes.find((candidate) => candidate.id === node.id);
            return stored !== undefined && Equal.equals(stored, node);
          }),
        ),
      getMessageCount: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => state.projections.get(threadId)?.messages.length ?? 0),
        ),
      getNextTurnItemOrdinal: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              (state.projections
                .get(threadId)
                ?.turnItems.reduce((max, item) => Math.max(max, item.ordinal), 0) ?? 0) + 1,
          ),
        ),
      getTurnItem: ({ threadId, itemId }) =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              state.projections.get(threadId)?.turnItems.find((item) => item.id === itemId) ?? null,
          ),
        ),
      getThreadAttachmentIds: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => [
            ...new Set([
              ...projection.messages.flatMap((message) =>
                message.attachments.map((attachment) => attachment.id),
              ),
              ...projection.turnItems.flatMap((item) =>
                item.type === "user_input_request"
                  ? Object.values(item.questionAnswer?.attachmentsByQuestionId ?? {})
                      .flat()
                      .map((attachment) => attachment.id)
                  : [],
              ),
              ...threadHtmlRenderAttachmentIds(
                threadId,
                projection.turnItems.flatMap((item) =>
                  item.type === "dynamic_tool" ? [item] : [],
                ),
              ),
            ]),
          ]),
        ),
      getThreadRecords: (threadId, fields, filter) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const selected = {
            ...projection,
            messages: projection.messages.filter(
              (row) =>
                (filter?.messageRunIds === undefined ||
                  (row.runId !== null && filter.messageRunIds.includes(row.runId))) &&
                (filter?.messageIds === undefined || filter.messageIds.includes(row.id)) &&
                (filter?.messageRoles === undefined || filter.messageRoles.includes(row.role)),
            ),
            runs:
              filter?.runIds === undefined
                ? projection.runs
                : projection.runs.filter((row) => filter.runIds!.includes(row.id)),
            nodes: projection.nodes.filter(
              (row) => filter?.nodeIds === undefined || filter.nodeIds.includes(row.id),
            ),
            subagents: projection.subagents.filter((row) => {
              const excepted =
                filter?.omitSettledSubagents !== undefined &&
                filter.omitSettledSubagents !== true &&
                filter.omitSettledSubagents.except.includes(row.id);
              const activeRun = projection.runs.some(
                (run) =>
                  run.id === row.runId &&
                  (run.status === "preparing" ||
                    run.status === "queued" ||
                    run.status === "starting" ||
                    run.status === "running" ||
                    run.status === "waiting"),
              );
              const settledDelivery =
                row.completionDelivery?.state === "acknowledged" ||
                row.completionDelivery?.state === "delivered" ||
                row.completionDelivery?.state === "disposed";
              return (
                (filter?.subagentIds === undefined || filter.subagentIds.includes(row.id)) &&
                (filter?.subagentRunIds === undefined ||
                  (row.runId !== null && filter.subagentRunIds.includes(row.runId))) &&
                (filter?.omitSettledSubagents === undefined ||
                  excepted ||
                  !(
                    (row.status === "completed" ||
                      row.status === "failed" ||
                      row.status === "cancelled" ||
                      row.status === "interrupted") &&
                    settledDelivery &&
                    !activeRun
                  ))
              );
            }),
            turnItems: projection.turnItems.filter(
              (row) =>
                (filter?.turnItemRunIds === undefined ||
                  filter.turnItemRunIds.includes(row.runId)) &&
                (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(row.type)) &&
                (filter?.turnItemStatuses === undefined ||
                  filter.turnItemStatuses.includes(row.status)) &&
                (filter?.turnItemNodeIds === undefined ||
                  (row.nodeId !== null && filter.turnItemNodeIds.includes(row.nodeId))) &&
                (filter?.turnItemRunId === undefined || filter.turnItemRunId === row.runId),
            ),
          };
          return Object.fromEntries([
            ["thread", projection.thread],
            ...fields.map((field) => [field, selected[field]]),
          ]) as ProjectionRecords<(typeof fields)[number]>;
        }),
      getRuntimeRequest: (threadId, requestId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return projection.runtimeRequests.find((request) => request.id === requestId);
        }),
      getProviderControlContext: (threadId, target) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const providerTurn = projection.providerTurns.find(
            (turn) => turn.id === target.providerTurnId,
          );
          return {
            providerThread: projection.providerThreads.find(
              (thread) => thread.id === target.providerThreadId,
            ),
            providerTurn,
            attempt:
              target.attemptId === undefined
                ? undefined
                : projection.attempts.find((attempt) => attempt.id === target.attemptId),
            message:
              target.messageId === undefined
                ? undefined
                : projection.messages.find((message) => message.id === target.messageId),
            run:
              target.messageId === undefined || providerTurn === undefined
                ? undefined
                : projection.runs.find((run) => run.activeAttemptId === providerTurn.runAttemptId),
          };
        }),
      getRunningTurnContext: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((run) => run.status === "running");
          return {
            run,
            providerThread: projection.providerThreads.find(
              (thread) => thread.id === run?.providerThreadId,
            ),
            providerTurn: projection.providerTurns.find(
              (turn) =>
                turn.providerThreadId === run?.providerThreadId &&
                turn.runAttemptId === run?.activeAttemptId &&
                turn.nodeId === run?.rootNodeId &&
                turn.status === "running",
            ),
          };
        }),
      getThreadProviderContext: (threadId, targetInstanceId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const target = projection.providerThreads
            .filter(
              (thread) =>
                thread.appThreadId === threadId &&
                thread.ownerNodeId === null &&
                thread.providerInstanceId === targetInstanceId,
            )
            .toSorted(
              (a, b) =>
                DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
                a.id.localeCompare(b.id),
            )[0];
          return {
            thread: projection.thread,
            providerSessions: projection.providerSessions,
            providerThreads:
              targetInstanceId === undefined
                ? []
                : projection.providerThreads.filter(
                    (thread) =>
                      thread.id === projection.thread.activeProviderThreadId ||
                      thread.id === target?.id,
                  ),
          };
        }),
      getRuntimeResponseContext: (threadId, requestId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const request = projection.runtimeRequests.find((request) => request.id === requestId);
          return {
            request,
            node: projection.nodes.find((node) => node.id === request?.nodeId),
            item: projection.turnItems.find(
              (item) =>
                item.nodeId === request?.nodeId &&
                (item.type === "approval_request" || item.type === "user_input_request") &&
                item.requestId === requestId,
            ),
            session: projection.providerSessions.find(
              (session) =>
                request?.responseCapability.type === "live" &&
                session.id === request.responseCapability.providerSessionId,
            ),
          };
        }),
      getCheckpointContext: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return {
            runs: projection.runs.map(({ id, ordinal, status }) => ({ id, ordinal, status })),
            checkpointScopes: projection.checkpointScopes.map(({ id, runId, kind, cwd }) => ({
              id,
              runId,
              kind,
              cwd,
            })),
            checkpoints: projection.checkpoints.map(
              ({ scopeId, runId, appRunOrdinal, status, ref }) => ({
                scopeId,
                runId,
                appRunOrdinal,
                status,
                ref,
              }),
            ),
          };
        }),
      getCheckpointCaptureContext: (threadId, target) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((candidate) => candidate.id === target.runId);
          return {
            run,
            rootNode: projection.nodes.find((candidate) => candidate.id === run?.rootNodeId),
            scope: projection.checkpointScopes.find((candidate) => candidate.id === target.scopeId),
            providerThread: projection.providerThreads.find(
              (candidate) => candidate.id === run?.providerThreadId,
            ),
            readyCheckpointOrdinals: projection.checkpoints
              .filter(
                (candidate) => candidate.scopeId === target.scopeId && candidate.status === "ready",
              )
              .map((candidate) => candidate.ordinalWithinScope),
          };
        }),
      getRunMessage: (threadId, runId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((candidate) => candidate.id === runId);
          return projection.messages.find((message) => message.id === run?.userMessageId);
        }),
      canStartQueuedRun: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return (
            projection.thread.archivedAt === null &&
            projection.thread.deletedAt === null &&
            projection.runs.some((run) => run.status === "queued" && run.queueHeld !== true) &&
            !projection.runs.some(
              (run) =>
                run.status === "preparing" ||
                run.status === "starting" ||
                run.status === "running" ||
                run.status === "waiting",
            )
          );
        }),
      getHeldQueuedRuns: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          return (
            projection?.runs
              .filter((run) => run.status === "queued" && run.queueHeld === true)
              .sort((left, right) => left.ordinal - right.ordinal) ?? []
          );
        }),
      getThreadProjection: (threadId) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          const readProjection = (
            targetThreadId: ThreadId,
            seenThreadIds: ReadonlySet<ThreadId>,
          ): OrchestrationV2ThreadProjection | null => {
            const projection = existing.get(targetThreadId);
            if (!projection) {
              return null;
            }
            const forkedFrom = projection.thread.forkedFrom;
            if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
              return withLocalVisibleTurnItems(projection);
            }
            const sourceProjection = readProjection(
              forkedFrom.threadId,
              new Set([...seenThreadIds, targetThreadId]),
            );
            return {
              ...projection,
              visibleTurnItems: buildVisibleTurnItems({
                projection,
                sourceProjection,
              }),
            };
          };
          const projection = readProjection(threadId, new Set());
          if (!projection) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection;
        }),
      getTurnStartContext: (threadId, runId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => ({
            ...projection,
            hasConversation: projection.messages.some(
              (message) =>
                message.role === "user" &&
                (message.text.trim().toLowerCase() !== "/compact" ||
                  message.attachments.length > 0),
            ),
            turnItems: projection.turnItems.filter((item) => item.runId === runId),
          })),
        ),
      getTurnStartHistory: (threadId, runIds) =>
        service
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) =>
              projection.turnItems.filter(
                (item) =>
                  [
                    "user_message",
                    "assistant_message",
                    "command_execution",
                    "error",
                    "run_interrupt_result",
                    "file_change",
                    "proposed_plan",
                  ].includes(item.type) &&
                  (runIds === undefined || (item.runId !== null && runIds.includes(item.runId))),
              ),
            ),
          ),
      getRuntimeRecoveryProjection: (threadId) => service.getThreadProjection(threadId),
      getThreadSnapshot: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.flatMap((projection) =>
            Ref.get(sequence).pipe(
              Effect.map((snapshotSequence) => ({
                schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
                snapshotSequence,
                projection,
              })),
            ),
          ),
        ),
      searchThread: (input) =>
        service
          .getThreadProjection(input.threadId)
          .pipe(
            Effect.flatMap((projection) =>
              Ref.get(sequence).pipe(
                Effect.map((snapshotSequence) =>
                  findProjectedThreadItems(projection.visibleTurnItems, input, snapshotSequence),
                ),
              ),
            ),
          ),
      searchThreadStream: (input) => Stream.fromEffect(service.searchThread(input)),
      getTimelinePage: (threadId, options) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const matching = projection.visibleTurnItems.filter((row) =>
              options.itemId === undefined
                ? row.position > (options.afterPosition ?? -1) &&
                  (options.view === "activity" ||
                    ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
                : row.sourceItemId === options.itemId,
            );
            return {
              items: matching.slice(0, options.limit),
              totalItems: projection.visibleTurnItems.length,
              hasMore: matching.length > options.limit,
            };
          }),
        ),
      getThreadSnapshotWindow: (threadId, options) =>
        service.getThreadSnapshot(threadId).pipe(
          Effect.map((snapshot) => {
            const summaryMode = options.activityMode === "summary-v1";
            const rows = snapshot.projection.visibleTurnItems;
            const anchorIndex =
              options.anchorItemId === undefined
                ? rows.length
                : rows.findIndex((row) => row.sourceItemId === options.anchorItemId) + 1;
            const candidates = rows.slice(0, anchorIndex);
            const turnAnchors =
              options.userTurnLimit === undefined
                ? []
                : candidates.flatMap((row, index) =>
                    isThreadHistoryTurnStart(row.item) ? [index] : [],
                  );
            const rawStart = turnAnchors.at(-(THREAD_HISTORY_MAX_RAW_TURNS + 2)) ?? 0;
            const anchors = turnAnchors.filter(
              (index) => index >= rawStart && isThreadHistoryUserTurn(candidates[index]!.item),
            );
            const anchorLimit = (options.userTurnLimit ?? 0) + 2;
            const start =
              anchors.length > 0
                ? anchors.length < anchorLimit
                  ? rawStart
                  : anchors.at(-anchorLimit)!
                : Math.max(0, anchorIndex - options.rowLimit);
            const visibleTurnItems = summaryMode
              ? selectMemorySummaryWindowRows(candidates, {
                  boundary: anchors.length > 0 ? start : 0,
                  hasUserAnchors: anchors.length > 0,
                  rowLimit: options.rowLimit,
                  keepLatest:
                    options.anchorItemId === undefined && options.requiredRunId === undefined,
                })
              : candidates.slice(start);
            return {
              ...snapshot,
              projection: { ...snapshot.projection, visibleTurnItems },
              ...(summaryMode
                ? {
                    activityMode: "summary-v1" as const,
                    activitySummaries: summarizeMemoryActivityGroupsInWindow(
                      rows,
                      snapshot.projection.runs,
                      visibleTurnItems,
                    ),
                  }
                : {}),
            };
          }),
        ),
      getThreadActivityPage: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* service.getThreadSnapshot(input.threadId);
          const rawCursor = input.cursor;
          const cursor =
            rawCursor === undefined
              ? null
              : yield* Effect.try({
                  try: () => decodeThreadActivityCursor(rawCursor),
                  catch: (cause) =>
                    new ProjectionStoreInvalidActivityCursorError({
                      threadId: input.threadId,
                      cause,
                    }),
                });
          if (cursor !== null && cursor.threadId !== input.threadId) {
            return yield* Effect.fail(
              new ProjectionStoreInvalidActivityCursorError({ threadId: input.threadId }),
            );
          }
          if (cursor !== null && input.anchorItemId !== undefined) {
            return yield* Effect.fail(
              new ProjectionStoreInvalidActivityRequestError({
                threadId: input.threadId,
                reason: "cursor and anchorItemId are mutually exclusive",
              }),
            );
          }
          const selectedSourceThreadId =
            cursor === null ? input.sourceThreadId : ThreadId.make(cursor.sourceThreadId);
          const selectedGroupStartItemId =
            cursor === null ? input.groupStartItemId : TurnItemId.make(cursor.groupStartItemId);
          if (selectedGroupStartItemId === undefined && input.anchorItemId === undefined) {
            return yield* Effect.fail(
              new ProjectionStoreInvalidActivityRequestError({
                threadId: input.threadId,
                reason: "groupStartItemId or anchorItemId is required",
              }),
            );
          }
          const groups = groupMemoryActivityRows(snapshot.projection.visibleTurnItems);
          const groupIndex = groups.findIndex((group) => {
            const [head] = group;
            if (selectedGroupStartItemId !== undefined) {
              return (
                head.sourceItemId === selectedGroupStartItemId &&
                (selectedSourceThreadId === undefined ||
                  head.sourceThreadId === selectedSourceThreadId)
              );
            }
            return group.some((row) => row.sourceItemId === input.anchorItemId);
          });
          const group = groupIndex < 0 ? undefined : groups[groupIndex];
          if (group === undefined) {
            return yield* Effect.fail(
              new ProjectionStoreActivityNotFoundError({
                threadId: input.threadId,
                sourceThreadId: selectedSourceThreadId,
                groupStartItemId: selectedGroupStartItemId,
                anchorItemId: input.anchorItemId,
              }),
            );
          }
          const [groupHead] = group;
          const summary = summarizeMemoryActivityGroup(group, snapshot.projection.runs);
          if (input.summaryOnly === true) {
            return {
              snapshotSequence: snapshot.snapshotSequence,
              sourceThreadId: groupHead.sourceThreadId,
              groupStartItemId: groupHead.sourceItemId,
              summary,
              items: [],
              previousCursor: null,
              nextCursor: null,
              hasPrevious: false,
              hasNext: false,
            };
          }
          const limit = input.limit ?? THREAD_ACTIVITY_PAGE_LIMIT;
          const anchorIndex =
            input.anchorItemId === undefined
              ? -1
              : group.findIndex((row) => row.sourceItemId === input.anchorItemId);
          if (input.anchorItemId !== undefined && anchorIndex < 0) {
            return yield* Effect.fail(
              new ProjectionStoreActivityNotFoundError({
                threadId: input.threadId,
                sourceThreadId: selectedSourceThreadId,
                groupStartItemId: selectedGroupStartItemId,
                anchorItemId: input.anchorItemId,
              }),
            );
          }
          const cursorIndex =
            cursor === null
              ? -1
              : group.findIndex((row) => row.sourceItemId === cursor.sourceItemId);
          if (cursor !== null && cursorIndex < 0) {
            return yield* Effect.fail(
              new ProjectionStoreInvalidActivityCursorError({ threadId: input.threadId }),
            );
          }
          let start: number;
          let end: number;
          if (cursor === null) {
            start = Math.max(0, anchorIndex);
            end = Math.min(group.length, start + limit);
          } else if (cursor.direction === "next") {
            start = cursorIndex + 1;
            end = Math.min(group.length, start + limit);
          } else {
            end = cursorIndex;
            start = Math.max(0, end - limit);
          }
          const pageRows = group.slice(start, end).map(toMemoryActivityRow);
          const pageFirst = pageRows[0];
          const pageLast = pageRows[pageRows.length - 1];
          const hasPrevious = start > 0;
          const hasNext = end < group.length;
          const previousCursor =
            hasPrevious && pageFirst !== undefined
              ? encodeThreadActivityCursor({
                  v: 1,
                  threadId: input.threadId,
                  sourceThreadId: groupHead.sourceThreadId,
                  groupStartItemId: groupHead.sourceItemId,
                  ordinal: pageFirst.ordinal,
                  sourceItemId: pageFirst.sourceItemId,
                  direction: "previous",
                })
              : null;
          const nextCursor =
            hasNext && pageLast !== undefined
              ? encodeThreadActivityCursor({
                  v: 1,
                  threadId: input.threadId,
                  sourceThreadId: groupHead.sourceThreadId,
                  groupStartItemId: groupHead.sourceItemId,
                  ordinal: pageLast.ordinal,
                  sourceItemId: pageLast.sourceItemId,
                  direction: "next",
                })
              : null;
          return {
            snapshotSequence: snapshot.snapshotSequence,
            sourceThreadId: groupHead.sourceThreadId,
            groupStartItemId: groupHead.sourceItemId,
            summary,
            items: pageRows,
            previousCursor,
            nextCursor,
            hasPrevious,
            hasNext,
          };
        }),
    };

    return service;
  }),
);
