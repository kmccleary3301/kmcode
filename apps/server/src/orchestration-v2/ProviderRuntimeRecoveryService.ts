import { OMP_ASYNC_JOB_TASK_ID_PREFIX } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type { ProviderAdapterV2SettlementResult } from "./ProviderAdapter.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalSubagentStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalNodeStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

type RecoveredSubagentStatus = Extract<
  OrchestrationV2Subagent["status"],
  "completed" | "failed" | "interrupted"
>;
type RecoveredProviderNativeSubagent = {
  readonly subagent: OrchestrationV2Subagent;
  readonly status: RecoveredSubagentStatus;
  readonly completedAt: DateTime.Utc;
};

function isEndedRunStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

function isTerminalTurnItemStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

type TerminalTurnItemStatus = Extract<
  OrchestrationV2Subagent["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

function terminalTurnItemStatus(status: string): TerminalTurnItemStatus | null {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
    ? status
    : null;
}
type ProviderNativeSubagentTurnItem = Extract<
  OrchestrationV2ThreadProjection["turnItems"][number],
  { readonly type: "subagent" }
>;
type DynamicToolTurnItem = Extract<
  OrchestrationV2ThreadProjection["turnItems"][number],
  { readonly type: "dynamic_tool" }
>;

function unknownRecordField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function parentReportsActiveTask(
  item: ProviderNativeSubagentTurnItem,
  parentItem: DynamicToolTurnItem,
  subagent: OrchestrationV2Subagent,
): boolean {
  const jobs =
    unknownRecordField(parentItem.details, "jobs") ?? unknownRecordField(parentItem, "jobs");
  if (!Array.isArray(jobs)) return false;
  const nativeTaskIds = [
    String(subagent.id),
    subagent.nativeAgentId,
    subagent.nativeTaskRef?.nativeId,
    item.nativeItemRef?.nativeId,
  ];
  return jobs.some((job: unknown) => {
    if (job === null || typeof job !== "object") return false;
    const type = unknownRecordField(job, "type");
    if (type !== undefined && type !== "task") return false;
    const status = unknownRecordField(job, "status") ?? unknownRecordField(job, "state");
    if (status !== "running" && status !== "pending" && status !== "queued") return false;
    const jobId = unknownRecordField(job, "id") ?? unknownRecordField(job, "jobId");
    const jobAgentId = unknownRecordField(job, "agentId");
    return nativeTaskIds.some(
      (nativeTaskId) =>
        nativeTaskId !== undefined && (jobId === nativeTaskId || jobAgentId === nativeTaskId),
    );
  });
}

function settleableProviderNativeSubagent(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  now: DateTime.Utc,
): RecoveredProviderNativeSubagent | null {
  if (
    item.type !== "subagent" ||
    item.origin !== "provider_native" ||
    !isNonterminalTurnItemStatus(item.status) ||
    item.runId === null ||
    item.parentItemId === null
  ) {
    return null;
  }
  const run = projection.runs.find((candidate) => candidate.id === item.runId);
  if (
    run === undefined ||
    !isEndedRunStatus(run.status) ||
    !isProcessBoundProviderRuntimeItem(item, projection)
  )
    return null;
  const parentItem = projection.turnItems.find((candidate) => candidate.id === item.parentItemId);
  if (
    parentItem?.type !== "dynamic_tool" ||
    parentItem.runId !== run.id ||
    !isTerminalTurnItemStatus(parentItem.status)
  ) {
    return null;
  }
  const subagent = projection.subagents.find((candidate) => candidate.id === item.subagentId);
  if (
    subagent === undefined ||
    subagent.origin !== "provider_native" ||
    subagent.runId !== run.id ||
    !isNonterminalSubagentStatus(subagent.status)
  ) {
    return null;
  }
  let status: RecoveredSubagentStatus;
  if (
    run.status === "interrupted" ||
    run.status === "cancelled" ||
    parentItem.status === "interrupted" ||
    parentItem.status === "cancelled"
  ) {
    status = "interrupted";
  } else if (
    parentItem.status === "completed" &&
    parentClaimsChildWasAsync(item, parentItem, subagent)
  ) {
    status = "interrupted";
  } else if (parentItem.status === "completed") {
    status = "completed";
  } else if (parentItem.status === "failed" || run.status === "failed") {
    status = "failed";
  } else {
    status = "interrupted";
  }
  return {
    subagent,
    status,
    completedAt: parentItem.completedAt ?? run.completedAt ?? now,
  };
}

/**
 * A delegate_task child. Its own thread is reconciled and continued on its own
 * and reports back through the app, so it is not provider background work.
 */
function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
}): boolean {
  return task.origin === "app_owned" && task.childThreadId !== null;
}

function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
): boolean {
  return item.type === "subagent" && isAppOwnedDelegation(item);
}
function isProcessBoundProviderThread(
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): boolean {
  const providerSessionId = providerThread.providerSessionId;
  return (
    providerSessionId !== null &&
    providerSessionId !== undefined &&
    projection.providerSessions.some(
      (candidate) =>
        candidate.id === providerSessionId &&
        candidate.providerInstanceId === providerThread.providerInstanceId &&
        candidate.driver === providerThread.driver,
    )
  );
}

function processBoundProviderThread(
  run: OrchestrationV2ThreadProjection["runs"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
) {
  if (run.providerThreadId === null) return undefined;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    providerThread === undefined ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    !isProcessBoundProviderThread(providerThread, projection)
  ) {
    return undefined;
  }
  return providerThread;
}

function isProcessBoundProviderRuntimeItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): boolean {
  const itemProviderThreadId = unknownRecordField(item, "providerThreadId");
  const itemProviderTurnId = unknownRecordField(item, "providerTurnId");
  if (item.runId === null) {
    if (typeof itemProviderThreadId !== "string") return false;
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === itemProviderThreadId,
    );
    return providerThread !== undefined && isProcessBoundProviderThread(providerThread, projection);
  }
  const run = projection.runs.find((candidate) => candidate.id === item.runId);
  if (run === undefined) return false;
  const providerThread = processBoundProviderThread(run, projection);
  if (
    providerThread === undefined ||
    (typeof itemProviderThreadId === "string" && itemProviderThreadId !== providerThread.id) ||
    (typeof itemProviderTurnId === "string" &&
      !projection.attempts.some(
        (attempt) => attempt.runId === run.id && attempt.providerTurnId === itemProviderTurnId,
      ))
  ) {
    return false;
  }
  return item.type !== "subagent" || item.providerInstanceId === run.providerInstanceId;
}

function isProcessBoundProviderNativeSubagent(
  subagent: OrchestrationV2Subagent,
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): boolean {
  if (subagent.origin !== "provider_native" || subagent.runId === null) return false;
  const run = projection.runs.find((candidate) => candidate.id === subagent.runId);
  if (run === undefined || subagent.providerInstanceId !== run.providerInstanceId) return false;
  const providerThread = processBoundProviderThread(run, projection);
  return (
    providerThread !== undefined &&
    (subagent.providerThreadId === null || subagent.providerThreadId === providerThread.id)
  );
}

function parentClaimsChildWasAsync(
  item: ProviderNativeSubagentTurnItem,
  parentItem: DynamicToolTurnItem,
  subagent: OrchestrationV2Subagent,
): boolean {
  const asyncState = unknownRecordField(unknownRecordField(parentItem.details, "async"), "state");
  return asyncState === "running" || parentReportsActiveTask(item, parentItem, subagent);
}

function isEndedProviderNativeChildThreadItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): boolean {
  if (
    item.type !== "subagent" ||
    item.origin !== "provider_native" ||
    item.childThreadId === null ||
    item.childThreadId === undefined ||
    item.runId === null
  ) {
    return false;
  }
  const run = projection.runs.find((candidate) => candidate.id === item.runId);
  return (
    run !== undefined &&
    isEndedRunStatus(run.status) &&
    projection.subagents.some(
      (subagent) =>
        subagent.id === item.subagentId &&
        subagent.runId === run.id &&
        subagent.origin === "provider_native" &&
        subagent.childThreadId === item.childThreadId &&
        isNonterminalSubagentStatus(subagent.status),
    )
  );
}

function terminalBackgroundTaskIds(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown, omp: boolean) => {
    if (typeof value !== "string" || value.length === 0) return;
    ids.add(value);
    if (omp && !value.startsWith(OMP_ASYNC_JOB_TASK_ID_PREFIX)) {
      ids.add(`${OMP_ASYNC_JOB_TASK_ID_PREFIX}${value}`);
    }
  };
  for (const item of projection.turnItems) {
    if (
      terminalTurnItemStatus(item.status) === null ||
      !isBackgroundCapableTurnItemType(item.type)
    ) {
      continue;
    }
    const run =
      item.runId === null
        ? undefined
        : projection.runs.find((candidate) => candidate.id === item.runId);
    const itemProviderThreadId = unknownRecordField(item, "providerThreadId");
    const providerThreadId =
      typeof itemProviderThreadId === "string" ? itemProviderThreadId : run?.providerThreadId;
    const providerThread =
      providerThreadId === null || providerThreadId === undefined
        ? undefined
        : projection.providerThreads.find((candidate) => candidate.id === providerThreadId);
    const omp = String(providerThread?.driver) === "omp";
    add(item.id, omp);
    add(unknownRecordField(unknownRecordField(item, "nativeItemRef"), "nativeId"), omp);
    if (item.type !== "subagent") continue;
    add(item.subagentId, omp);
    const subagent = projection.subagents.find(
      (candidate) => candidate.id === item.subagentId && candidate.runId === item.runId,
    );
    add(subagent?.nativeAgentId, omp);
    add(unknownRecordField(subagent?.nativeTaskRef, "nativeId"), omp);
  }
  return ids;
}

/**
 * Resolve providerInstanceId for a stale background-capable turn item whose
 * run is missing/null (or not found). Prefer an existing run, then a subagent
 * item's own instance id, then the item's provider thread, then a last-resort
 * first provider thread, then the thread's selected provider.
 */
function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

/** An open item closed by recovery. A secret card also closes its form, so it takes no answer. */
const cancelledItem = (
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection["turnItems"][number] =>
  item.type === "secret_request" && item.secretStatus === "pending"
    ? { ...item, status: "cancelled", secretStatus: "cancelled", completedAt: now, updatedAt: now }
    : { ...item, status: "cancelled", completedAt: now, updatedAt: now };

/**
 * A provider thread's latest started run: the last turn that provider saw.
 * Restart recovery records the thread's cancelled background work on it, and
 * the next run on the same provider thread delivers it with its input.
 */
function latestStartedRun(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerThreadId: ProviderThreadId,
) {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const providerSessions = yield* Effect.serviceOption(
    ProviderSessionManager.ProviderSessionManagerV2,
  );
  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      continueAfterRestart: boolean,
    ) {
      const now = yield* DateTime.now;
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (run.status === "waiting") {
          // Captures enqueued before per-attempt command ids used the run id alone.
          const captureCommandIds = [
            CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
            ...(run.rootNodeId === null
              ? []
              : [RunExecutionService.checkpointCaptureCommandId(run.id, run.rootNodeId)]),
          ];
          const checkpointEffects = yield* Effect.forEach(captureCommandIds, (commandId) =>
            outbox.listByCommandId(commandId),
          ).pipe(
            Effect.map((lists) => lists.flat()),
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      // On shutdown, inspect whether the original bound runtime confirms
      // native settlement before blind cancellation. Startup cannot
      // reconstruct lost native work and must NOT infer past completion there.
      const nativeSettlementByRunId = new Map<string, ProviderAdapterV2SettlementResult>();
      const nativeHeadRefByThreadId = new Map<
        ProviderThreadId,
        ProviderAdapterV2SettlementResult["nativeConversationHeadRef"]
      >();
      if (trigger === "shutdown" && Option.isSome(providerSessions)) {
        const sessionManager = providerSessions.value;
        for (const run of runs) {
          if (run.providerThreadId === null) continue;
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          );
          if (providerThread === undefined || providerThread.providerSessionId === null) {
            continue;
          }
          const settlement = yield* sessionManager
            .inspectSettlement({
              providerSessionId: providerThread.providerSessionId,
              providerThread,
              runId: run.id,
            })
            .pipe(Effect.orElseSucceed(() => null));
          if (settlement !== null) {
            nativeSettlementByRunId.set(run.id, settlement);
            nativeHeadRefByThreadId.set(providerThread.id, settlement.nativeConversationHeadRef);
          }
        }
      }
      const pendingRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      // The lost provider callback cannot resume; persisted questions can be
      // answered by a new user message in threads that accept messages.
      const questions = pendingRequests.filter(
        (request) =>
          request.kind === "user_input" &&
          request.responseCapability.type === "live" &&
          projection.turnItems.some(
            (item) =>
              item.type === "user_input_request" &&
              item.requestId === request.id &&
              item.nodeId === request.nodeId &&
              item.questions.length > 0 &&
              item.questions.every((question) => question.question.trim().length > 0),
          ) &&
          !isProviderNativeSubagentThread(projection.thread),
      );
      const recoveredRequestIds = new Set(questions.map((request) => request.id));
      const messageRequestNodeIds = new Set(
        pendingRequests
          .filter(
            (request) =>
              request.responseCapability.type === "message" || recoveredRequestIds.has(request.id),
          )
          .map((request) => request.nodeId),
      );
      const requests = pendingRequests.filter(
        (request) =>
          request.responseCapability.type !== "message" && !recoveredRequestIds.has(request.id),
      );
      // Delegated task rows, items and nodes stay open: the child settles them.
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedDelegation).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      const updatedStaleNodeIds = new Set<string>();
      const terminalizedSubagentIds = new Set<string>();
      const terminalizedBackgroundTaskIds = terminalBackgroundTaskIds(projection);
      const unboundProviderNativeSubagentIds = new Set(
        projection.subagents
          .filter(
            (subagent) =>
              subagent.origin === "provider_native" &&
              !isProcessBoundProviderNativeSubagent(subagent, projection),
          )
          .map((subagent) => String(subagent.id)),
      );
      const unboundBackgroundNodeIds = new Set(
        projection.turnItems.flatMap((item) =>
          isBackgroundCapableTurnItemType(item.type) &&
          !isProcessBoundProviderRuntimeItem(item, projection) &&
          item.nodeId !== null &&
          item.nodeId !== undefined
            ? [String(item.nodeId)]
            : [],
        ),
      );
      // Background work that outlived its settled turn. The provider transcript
      // cannot record its death, so the next provider turn is told instead.
      // Shutdown records it too: a graceful restart cancels it there first.
      // Keyed by the provider thread that lost the work: only its turns are told.
      const cancelledBackgroundWork = new Map<
        ProviderThreadId,
        Array<OrchestrationV2RestartCancelledBackgroundWork>
      >();
      const cancelledBackgroundNativeIds = new Set<string>();
      const recordCancelledBackgroundWork = (
        providerThreadId: ProviderThreadId | null | undefined,
        work: OrchestrationV2RestartCancelledBackgroundWork,
      ) => {
        if (providerThreadId == null) return;
        const existing = cancelledBackgroundWork.get(providerThreadId);
        if (existing === undefined) cancelledBackgroundWork.set(providerThreadId, [work]);
        else existing.push(work);
      };
      const recordCancelledBackgroundItem = (
        item: OrchestrationV2ThreadProjection["turnItems"][number],
      ) => {
        if (!isBackgroundCapableTurnItemType(item.type)) return;
        const work = cancelledTurnItemWork(item);
        if (work === undefined) return;
        recordCancelledBackgroundWork(
          item.providerThreadId ??
            projection.runs.find((run) => run.id === item.runId)?.providerThreadId,
          work,
        );
        if (item.nativeItemRef?.nativeId != null) {
          cancelledBackgroundNativeIds.add(item.nativeItemRef.nativeId);
        }
      };
      for (const item of projection.turnItems) {
        const status = terminalTurnItemStatus(item.status);
        if (
          status === null ||
          !isBackgroundCapableTurnItemType(item.type) ||
          (item.type === "subagent" &&
            (item.origin !== "provider_native" || isAppOwnedDelegationItem(item)))
        ) {
          continue;
        }
        let linkedNodeId = item.type === "subagent" ? item.subagentId : item.nodeId;
        if (item.type === "subagent") {
          const subagent = projection.subagents.find(
            (candidate) =>
              candidate.id === item.subagentId &&
              candidate.runId === item.runId &&
              candidate.origin === "provider_native" &&
              isNonterminalSubagentStatus(candidate.status),
          );
          if (subagent !== undefined) {
            if (!terminalizedSubagentIds.has(String(subagent.id))) {
              terminalizedSubagentIds.add(String(subagent.id));
              events.push({
                id: yield* allocateEventId(),
                type: "subagent.updated",
                threadId: projection.thread.id,
                ...(item.runId === null ? {} : { runId: item.runId }),
                nodeId: subagent.id,
                driver: subagent.driver,
                providerInstanceId: subagent.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...subagent,
                  status,
                  ...(item.result === null ? {} : { result: item.result }),
                  completedAt: item.completedAt,
                  updatedAt: item.updatedAt,
                },
              });
            }
            linkedNodeId = subagent.id;
          }
        }
        if (linkedNodeId === null || linkedNodeId === undefined) continue;
        const staleNode = projection.nodes.find(
          (candidate) =>
            candidate.id === linkedNodeId &&
            candidate.runId === item.runId &&
            candidate.providerTurnId === item.providerTurnId &&
            isNonterminalNodeStatus(candidate.status),
        );
        if (staleNode === undefined || updatedStaleNodeIds.has(String(staleNode.id))) continue;
        updatedStaleNodeIds.add(String(staleNode.id));
        events.push({
          id: yield* allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          nodeId: staleNode.id,
          providerInstanceId: resolveStaleBackgroundItemProviderInstanceId(item, projection),
          occurredAt: now,
          payload: { ...staleNode, status, completedAt: item.completedAt },
        });
      }
      // Queued runs have not started provider work. Preserve their execution
      // identities and order, but require explicit consent before draining them.
      for (const run of projection.runs) {
        if (run.status !== "queued" || run.queueHeld === true) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, queueHeld: true },
        });
      }
      for (const question of questions) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: question.nodeId,
          occurredAt: now,
          payload: { ...question, responseCapability: { type: "message" } },
        });
      }
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      for (const run of runs) {
        const settlement = nativeSettlementByRunId.get(run.id);
        const isNativeSettled = settlement !== undefined;
        const runStatus = isNativeSettled ? "completed" : "cancelled";
        const runCompletedAt = settlement?.settledAt ?? now;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: runStatus, queuePosition: null, completedAt: runCompletedAt },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: runStatus, completedAt: runCompletedAt },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !messageRequestNodeIds.has(candidate.id) &&
            !delegatedTaskNodeIds.has(candidate.id) &&
            !unboundBackgroundNodeIds.has(String(candidate.id)) &&
            !unboundProviderNativeSubagentIds.has(String(candidate.id)) &&
            !updatedStaleNodeIds.has(String(candidate.id)) &&
            !terminalizedSubagentIds.has(String(candidate.id)) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: runStatus, completedAt: runCompletedAt },
          });
        }
        for (const subagent of projection.subagents.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !isAppOwnedDelegation(candidate) &&
            (isProcessBoundProviderNativeSubagent(candidate, projection) ||
              projection.turnItems.some(
                (item) =>
                  item.type === "subagent" &&
                  item.subagentId === candidate.id &&
                  item.runId === run.id &&
                  isNonterminalTurnItemStatus(item.status) &&
                  isProcessBoundProviderRuntimeItem(item, projection),
              )) &&
            !terminalizedSubagentIds.has(String(candidate.id)) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "subagent.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: subagent.id,
            driver: subagent.driver,
            providerInstanceId: subagent.providerInstanceId,
            occurredAt: now,
            payload: { ...subagent, status: "cancelled", completedAt: now, updatedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...providerTurn,
              ...(settlement?.providerTurnId === providerTurn.id
                ? { nativeTurnRef: settlement.nativeTurnRef }
                : {}),
              status: runStatus,
              completedAt: runCompletedAt,
            },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: runCompletedAt },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            (!isBackgroundCapableTurnItemType(candidate.type) ||
              isProcessBoundProviderRuntimeItem(candidate, projection)) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          // A waiting run's provider turn already settled; its open items are
          // background work. A running run's items die with its turn.
          if (run.status === "waiting" || isNativeSettled) recordCancelledBackgroundItem(item);
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: cancelledItem(item, now),
          });
        }
      }
      // Process loss also orphans background-capable turn items on already-
      // settled runs (e.g. post-settle Waiting work). Skip items already
      // cancelled above for recovered nonterminal runs to avoid duplicate
      // cancellation events.
      const recoveredNonterminalRunIds = new Set(runs.map((run) => run.id));
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && recoveredNonterminalRunIds.has(item.runId)) {
          continue;
        }
        if (!isBackgroundCapableTurnItemType(item.type)) {
          continue;
        }
        if (
          !isNonterminalTurnItemStatus(item.status) ||
          isAppOwnedDelegationItem(item) ||
          (!isProcessBoundProviderRuntimeItem(item, projection) &&
            !isEndedProviderNativeChildThreadItem(item, projection))
        ) {
          continue;
        }
        if (item.type === "subagent") {
          const settlement = settleableProviderNativeSubagent(item, projection, now);
          if (settlement !== null) {
            const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(
              item,
              projection,
            );
            if (settlement.status === "interrupted") {
              recordCancelledBackgroundItem(item);
            }
            events.push({
              id: yield* allocateEventId(),
              type: "turn-item.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
              providerInstanceId,
              occurredAt: now,
              payload: {
                ...item,
                status: settlement.status,
                completedAt: settlement.completedAt,
                updatedAt: now,
              },
            });
            events.push({
              id: yield* allocateEventId(),
              type: "subagent.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: settlement.subagent.id,
              driver: settlement.subagent.driver,
              providerInstanceId: settlement.subagent.providerInstanceId,
              occurredAt: now,
              payload: {
                ...settlement.subagent,
                status: settlement.status,
                completedAt: settlement.completedAt,
                updatedAt: now,
              },
            });
            const subagentNode = projection.nodes.find(
              (candidate) =>
                candidate.id === settlement.subagent.id &&
                candidate.runId === item.runId &&
                candidate.providerTurnId === item.providerTurnId &&
                isNonterminalNodeStatus(candidate.status),
            );
            if (subagentNode !== undefined && !updatedStaleNodeIds.has(subagentNode.id)) {
              updatedStaleNodeIds.add(subagentNode.id);
              events.push({
                id: yield* allocateEventId(),
                type: "node.updated",
                threadId: projection.thread.id,
                ...(item.runId === null ? {} : { runId: item.runId }),
                nodeId: subagentNode.id,
                providerInstanceId: settlement.subagent.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...subagentNode,
                  status: settlement.status,
                  completedAt: settlement.completedAt,
                },
              });
            }
            continue;
          }
        }
        const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
        recordCancelledBackgroundItem(item);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          providerInstanceId,
          occurredAt: now,
          payload: cancelledItem(item, now),
        });
        if (item.nodeId !== null && item.nodeId !== undefined) {
          const staleItemNode = projection.nodes.find(
            (candidate) =>
              candidate.id === item.nodeId &&
              candidate.runId === item.runId &&
              candidate.providerTurnId === item.providerTurnId &&
              isNonterminalNodeStatus(candidate.status),
          );
          if (staleItemNode !== undefined && !updatedStaleNodeIds.has(staleItemNode.id)) {
            updatedStaleNodeIds.add(staleItemNode.id);
            events.push({
              id: yield* allocateEventId(),
              type: "node.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: staleItemNode.id,
              providerInstanceId,
              occurredAt: now,
              payload: { ...staleItemNode, status: "cancelled", completedAt: now },
            });
          }
        }
        if (item.type !== "subagent") {
          continue;
        }
        // Cancelling only the turn item would leave the linked subagent entity
        // non-terminal forever, since the dead provider process can no longer
        // emit its terminal event. Match the exact linked id so a subagent
        // that already finished is never overwritten.
        const staleSubagent = projection.subagents.find(
          (candidate) =>
            candidate.id === item.subagentId &&
            candidate.runId === item.runId &&
            isNonterminalSubagentStatus(candidate.status),
        );
        if (staleSubagent !== undefined) {
          events.push({
            id: yield* allocateEventId(),
            type: "subagent.updated",
            threadId: projection.thread.id,
            ...(item.runId === null ? {} : { runId: item.runId }),
            nodeId: staleSubagent.id,
            driver: staleSubagent.driver,
            providerInstanceId: staleSubagent.providerInstanceId,
            occurredAt: now,
            payload: { ...staleSubagent, status: "cancelled", completedAt: now, updatedAt: now },
          });
        }
        const staleSubagentNode = projection.nodes.find(
          (candidate) =>
            candidate.id === item.subagentId &&
            candidate.runId === item.runId &&
            candidate.providerTurnId === item.providerTurnId &&
            isNonterminalNodeStatus(candidate.status),
        );
        if (staleSubagentNode !== undefined && !updatedStaleNodeIds.has(staleSubagentNode.id)) {
          updatedStaleNodeIds.add(staleSubagentNode.id);
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            ...(item.runId === null ? {} : { runId: item.runId }),
            nodeId: staleSubagentNode.id,
            providerInstanceId,
            occurredAt: now,
            payload: { ...staleSubagentNode, status: "cancelled", completedAt: now },
          });
        }
      }
      // A provider-native subagent thread has no runs: its work is a runless
      // root turn, plus items under it (Claude's live progress item), that
      // only the dead provider process could settle. Left running, the child
      // would show as working forever.
      const cancelledStaleItemIds = new Set(
        events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload.id] : [])),
      );
      const providerNativeSubagentThread =
        projection.thread.lineage?.relationshipToParent === "subagent" &&
        projection.thread.creationSource === "provider";
      for (const node of projection.nodes) {
        if (
          node.kind !== "root_turn" ||
          node.runId !== null ||
          !isNonterminalNodeStatus(node.status) ||
          updatedStaleNodeIds.has(node.id)
        ) {
          continue;
        }
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === node.providerThreadId,
        );
        if (
          !providerNativeSubagentThread &&
          (providerThread === undefined ||
            !isProcessBoundProviderThread(providerThread, projection))
        ) {
          continue;
        }
        updatedStaleNodeIds.add(node.id);
        events.push({
          id: yield* allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          nodeId: node.id,
          providerInstanceId:
            providerThread?.providerInstanceId ?? projection.thread.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "cancelled", completedAt: now },
        });
        for (const item of projection.turnItems) {
          const itemProviderThreadId = unknownRecordField(item, "providerThreadId");
          if (
            item.nodeId !== node.id ||
            item.runId !== null ||
            (!providerNativeSubagentThread && itemProviderThreadId !== providerThread?.id) ||
            !isNonterminalTurnItemStatus(item.status) ||
            cancelledStaleItemIds.has(item.id)
          ) {
            continue;
          }
          cancelledStaleItemIds.add(item.id);
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            nodeId: node.id,
            providerInstanceId:
              providerThread?.providerInstanceId ?? projection.thread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...item,
              status: "cancelled",
              completedAt: now,
              updatedAt: now,
              ...(item.type === "reasoning" || item.type === "assistant_message"
                ? { streaming: false }
                : {}),
            },
          });
        }
      }
      // All provider processes are gone on startup/shutdown: clear any
      // persisted Waiting roster (including idle threads from settled roots)
      // and idle active threads without resurrecting active status.
      for (const providerThread of projection.providerThreads ?? []) {
        const processBound = isProcessBoundProviderThread(providerThread, projection);
        const needsIdle = processBound && providerThread.status === "active";
        const pendingBackgroundTasks = providerThread.pendingBackgroundTasks ?? [];
        const retainedBackgroundTasks = pendingBackgroundTasks.filter(
          (task) => !terminalizedBackgroundTaskIds.has(task.taskId) && !processBound,
        );
        const cancelledBackgroundTasks = processBound
          ? pendingBackgroundTasks.filter((task) => !terminalizedBackgroundTaskIds.has(task.taskId))
          : [];
        const needsRosterUpdate = retainedBackgroundTasks.length !== pendingBackgroundTasks.length;
        if (!needsIdle && !needsRosterUpdate && !nativeHeadRefByThreadId.has(providerThread.id)) {
          continue;
        }
        if (processBound && providerThread.ownerNodeId === null) {
          for (const task of cancelledBackgroundTasks) {
            if (cancelledBackgroundNativeIds.has(task.taskId)) continue;
            cancelledBackgroundNativeIds.add(task.taskId);
            recordCancelledBackgroundWork(providerThread.id, cancelledRosterTaskWork(task));
          }
        }
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            ...(nativeHeadRefByThreadId.has(providerThread.id)
              ? {
                  nativeConversationHeadRef: nativeHeadRefByThreadId.get(providerThread.id) ?? null,
                }
              : {}),
            status: needsIdle ? "idle" : providerThread.status,
            pendingBackgroundTasks: retainedBackgroundTasks,
            updatedAt: now,
          },
        });
      }
      for (const session of projection.providerSessions.filter(
        (candidate) =>
          candidate.status !== "stopped" &&
          candidate.status !== "error" &&
          projection.providerThreads.some(
            (providerThread) =>
              providerThread.providerSessionId === candidate.id &&
              isProcessBoundProviderThread(providerThread, projection),
          ),
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      for (const [providerThreadId, work] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection, providerThreadId);
        if (noteRun === undefined) continue;
        // Its own event: a run snapshot read before this commit could regress
        // a lifecycle change (e.g. a checkpoint completing the run) made since.
        events.push({
          id: yield* allocateEventId(),
          type: "run.background-work-cancelled",
          threadId: projection.thread.id,
          runId: noteRun.id,
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: {
            runId: noteRun.id,
            restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
              noteRun.restartCancelledBackgroundWork ?? [],
              work,
            ),
          },
        });
      }
      const continuationRun =
        continueAfterRestart && trigger === "startup"
          ? restartContinuationRun(projection)
          : undefined;
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continuationRun
        ? [
            {
              id: `effect:restart-continuation:${continuationRun.id}`,
              commandId,
              threadId: projection.thread.id,
              request: { type: "provider-runtime.continue", sourceRunId: continuationRun.id },
            },
          ]
        : [];
      const stoppedSessions = projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      ).length;
      let retiredEffects: number;
      if (events.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects,
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = (trigger: "startup" | "shutdown") =>
    Effect.gen(function* () {
      const continueAfterRestart = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => null),
      );
      const threadIds = yield* projections
        .getRecoveryThreadIds("runtime")
        .pipe(
          Effect.mapError(
            (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
          ),
        );
      let terminalizedRuns = 0;
      let stoppedSessions = 0;
      let closedRequests = 0;
      let retiredEffects = 0;
      for (const threadId of threadIds) {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId,
                cause,
              }),
          ),
        );
        const enabled =
          continueAfterRestart !== null &&
          resolveProjectSettings(continueAfterRestart, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate;
        const result = yield* reconcileProjection(projection, trigger, enabled);
        terminalizedRuns += result.terminalizedRuns;
        stoppedSessions += result.stoppedSessions;
        closedRequests += result.closedRequests;
        retiredEffects += result.retiredEffects;
      }
      const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      );
      return {
        terminalizedRuns,
        stoppedSessions,
        closedRequests,
        retiredEffects: retiredEffects + outboxReconciliation.cancelled,
        requeuedEffects: outboxReconciliation.requeued,
      } satisfies ProviderRuntimeReconciliationSummary;
    });

  // Snapshot intent only while providers are live. A provider may finish while
  // this commits; reconciliation reads fresh state after shutdown, and delivery
  // rejects any source run that actually completed.
  const prepareForShutdown = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    for (const threadId of threadIds) {
      yield* Effect.gen(function* () {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
        if (
          !resolveProjectSettings(enabled, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate
        )
          return;
        const run = restartContinuationRun(projection);
        if (!run) return;
        if (run.providerThreadId !== null && Option.isSome(providerSessions)) {
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          );
          if (providerThread?.providerSessionId != null) {
            const settlement = yield* providerSessions.value
              .inspectSettlement({
                providerSessionId: providerThread.providerSessionId,
                providerThread,
                runId: run.id,
              })
              .pipe(Effect.orElseSucceed(() => null));
            if (settlement !== null && settlement.settledAt !== undefined) {
              return;
            }
          }
        }
        const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
        yield* eventSink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            {
              id: `effect:restart-continuation:${run.id}`,
              commandId,
              threadId,
              request: { type: "provider-runtime.continue", sourceRunId: run.id },
            },
          ],
        });
      }).pipe(
        // One failing thread must not cost the threads after it their continuation.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.mapError((cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause })),
  );

  const recover = Effect.gen(function* () {
    return (yield* reconcile("startup")) satisfies ProviderRuntimeRecoverySummary;
  });

  return ProviderRuntimeRecoveryService.of({ reconcile, prepareForShutdown, recover });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
