import {
  CommandId,
  type CheckpointRef,
  EventId,
  isNativeCheckpointDescriptor,
  MessageId,
  type NativeCheckpointDescriptor,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import {
  CHECKPOINT_RECOVERY_BLOCKED_PREFIX,
  checkpointRefForRestoreCompensation,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function failureDetail(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
function nativeCheckpointIdentity(
  value: unknown,
): { readonly runtime: string; readonly sessionId: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const runtime = typeof record.runtime === "string" ? record.runtime.trim() : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  return runtime.length > 0 && sessionId.length > 0 ? { runtime, sessionId } : undefined;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const queuedEntryRefreshes = new Set<string>();
  const entryRefreshWorker = yield* makeDrainableWorker((cwd: string) =>
    Effect.sync(() => queuedEntryRefreshes.delete(cwd)).pipe(
      Effect.andThen(workspaceEntries.refresh(cwd)),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () =>
          Effect.logWarning("failed to refresh checkpoint workspace entries", {
            cwd,
          }),
      ),
    ),
  );
  const refreshWorkspaceEntries = Effect.fn("refreshWorkspaceEntries")(function* (cwd: string) {
    if (queuedEntryRefreshes.has(cwd)) return;
    queuedEntryRefreshes.add(cwd);
    yield* entryRefreshWorker.enqueue(cwd);
  });

  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );
  const persistRecoveryFailure = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
    readonly providerName: OrchestrationSession["providerName"];
    readonly providerInstanceId: OrchestrationSession["providerInstanceId"];
    readonly runtimeMode: OrchestrationSession["runtimeMode"];
  }) =>
    Effect.gen(function* () {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.session.set",
          commandId: yield* serverCommandId("checkpoint-recovery-blocked"),
          threadId: input.threadId,
          session: {
            threadId: input.threadId,
            status: "error",
            providerName: input.providerName,
            ...(input.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: input.providerInstanceId }),
            runtimeMode: input.runtimeMode,
            activeTurnId: null,
            lastError: `${CHECKPOINT_RECOVERY_BLOCKED_PREFIX}${input.detail}`,
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist checkpoint recovery blocked state", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      yield* appendRevertFailureActivity(input);
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    // Bind the opaque leaf to the active provider session before persistence.
    // ProviderService still owns the raw leaf; the orchestration descriptor
    // prevents restoring it into a different provider/session.
    const nativeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const nativeLeaf = yield* providerService.captureNativeCheckpoint({
      threadId: input.threadId,
    });
    const nativeIdentity =
      nativeLeaf === undefined ? undefined : nativeCheckpointIdentity(nativeLeaf);
    if (nativeLeaf !== undefined && (nativeSession === undefined || nativeIdentity === undefined)) {
      return yield* Effect.die(
        new Error(
          `Native checkpoint capture returned a leaf without active provider and native session identity for thread '${input.threadId}'.`,
        ),
      );
    }
    if (
      nativeIdentity !== undefined &&
      nativeSession !== undefined &&
      nativeIdentity.runtime !== String(nativeSession.provider)
    ) {
      return yield* Effect.die(
        new Error(
          `Native checkpoint runtime '${nativeIdentity.runtime}' does not match provider '${nativeSession.provider}'.`,
        ),
      );
    }
    const nativeCheckpoint: NativeCheckpointDescriptor | undefined =
      nativeLeaf === undefined
        ? undefined
        : {
            version: 1,
            runtime: nativeIdentity!.runtime,
            provider: nativeSession!.provider,
            instanceId:
              nativeSession!.providerInstanceId ??
              ProviderInstanceId.make(String(nativeSession!.provider)),
            threadId: input.threadId,
            sessionId: nativeIdentity!.sessionId,
            captureState: "captured",
            opaque: nativeLeaf,
          };

    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore
      .hasCheckpointRef({
        cwd: input.cwd,
        checkpointRef: fromCheckpointRef,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkpoint capture previous ref lookup failed", {
            threadId: input.threadId,
            checkpointRef: fromCheckpointRef,
            category: error._tag,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* refreshWorkspaceEntries(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseTurnDiffFilesFromNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      ...(nativeCheckpoint === undefined ? {} : { nativeCheckpoint }),
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("failed to follow worktree branch drift", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  // Refreshing git status ends in a remote PR lookup under the vcs status
  // write lock. Run it on its own worker so file capture for this turn (and
  // checkpoints for other threads) never wait behind that network call.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      refreshLocalGitStatusFromTurnCompletion(event).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () =>
            Effect.logWarning("failed to refresh git status after turn completion", {
              threadId: event.threadId,
            }),
        ),
      ),
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      // A bootstrap message lands before the worktree exists; its baseline
      // would snapshot the project checkout. The turn-start event that
      // follows captures it against the right cwd.
      if (
        event.metadata.historyImport === true ||
        event.metadata.deferredTurn === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  // Checkpoints contain the whole checkout, so restoring a shared cwd can erase a sibling's work.
  const isRestoreWorkspaceIsolated = Effect.fn("isRestoreWorkspaceIsolated")(function* (
    thread: { readonly id: ThreadId; readonly worktreePath: string | null },
    cwd: string,
  ) {
    if (thread.worktreePath === null) return false;
    const canonicalCwd = yield* fileSystem.realPath(cwd);
    if ((yield* fileSystem.realPath(thread.worktreePath)) !== canonicalCwd) return false;
    const active = yield* projectionSnapshotQuery.getShellSnapshot();
    const archived = yield* projectionSnapshotQuery.getArchivedShellSnapshot();
    const projects = [...active.projects, ...archived.projects];
    const paths = new Set<string>();
    for (const other of [...active.threads, ...archived.threads]) {
      if (other.id === thread.id) continue;
      const candidate =
        other.worktreePath ??
        projects.find((project) => project.id === other.projectId)?.workspaceRoot;
      if (candidate !== undefined) paths.add(candidate);
    }
    for (const session of yield* providerService.listSessions()) {
      if (
        session.threadId !== thread.id &&
        session.status !== "closed" &&
        session.cwd !== undefined
      )
        paths.add(session.cwd);
    }
    for (const candidate of paths) {
      const otherCwd = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
      if (otherCwd === null) continue;
      const isWithin = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === "" ||
          (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        );
      };
      // Parent and nested owners can both have files inside the restore target.
      if (isWithin(canonicalCwd, otherCwd) || isWithin(otherCwd, canonicalCwd)) return false;
    }
    return true;
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: event.payload.threadId,
      thread,
      projects: yield* resolveThreadProjects(thread.projectId),
      preferSessionRuntime: true,
    }).pipe(
      Effect.catch((error) =>
        event.payload.restoreFiles === false ? Effect.undefined : Effect.fail(error),
      ),
    );

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,

        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    const targetCheckpoint = thread.checkpoints.find(
      (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
    );
    const nativeTarget =
      targetCheckpoint?.nativeCheckpoint === null ? undefined : targetCheckpoint?.nativeCheckpoint;
    const nativeDescriptor =
      nativeTarget !== undefined && isNativeCheckpointDescriptor(nativeTarget)
        ? nativeTarget
        : undefined;
    const nativeLeaf = nativeDescriptor === undefined ? nativeTarget : nativeDescriptor.opaque;
    const nativeIdentity =
      nativeDescriptor === undefined ? undefined : nativeCheckpointIdentity(nativeLeaf);

    // Native leaves rewind the provider conversation themselves; without one
    // the provider must support plain conversation rollback.
    if (nativeTarget === undefined) {
      yield* providerService.assertConversationRollbackSupported(event.payload.threadId);
    }

    let filesystemRestore:
      | { readonly cwd: string; readonly checkpointRef: CheckpointRef }
      | undefined;
    if (event.payload.restoreFiles !== false) {
      if (!checkpointCwd) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Checkpoint workspace is unavailable or is not a git repository.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      if (!(yield* isRestoreWorkspaceIsolated(thread, checkpointCwd))) {
        yield* appendRevertFailureActivity({
          threadId: thread.id,
          turnCount: event.payload.turnCount,
          detail:
            "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const targetCheckpointRef =
        event.payload.turnCount === 0
          ? checkpointRefForThreadTurn(event.payload.threadId, 0)
          : targetCheckpoint?.checkpointRef;

      if (!targetCheckpointRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      filesystemRestore = { cwd: checkpointCwd, checkpointRef: targetCheckpointRef };
    }

    if (filesystemRestore !== undefined || nativeLeaf !== undefined) {
      const compensationRef = checkpointRefForRestoreCompensation(
        event.payload.threadId,
        yield* randomUUID,
      );
      const restoreFilesystemCompensation = (cwd: string) =>
        checkpointStore
          .restoreCheckpoint({ cwd, checkpointRef: compensationRef })
          .pipe(Effect.result);
      const filesystemCompensationDetail = (
        compensated: Result.Result<boolean, unknown> | undefined,
      ): string =>
        compensated === undefined
          ? ""
          : Result.isFailure(compensated)
            ? ` Filesystem compensation failed: ${failureDetail(compensated.failure)}`
            : compensated.success
              ? ""
              : " Filesystem compensation checkpoint was unavailable.";
      const cleanupCompensationRef =
        filesystemRestore === undefined
          ? Effect.void
          : checkpointStore
              .deleteCheckpointRefs({
                cwd: filesystemRestore.cwd,
                checkpointRefs: [compensationRef],
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("failed to delete checkpoint restore compensation ref", {
                    threadId: event.payload.threadId,
                    compensationRef,
                    detail: failureDetail(error),
                  }),
                ),
              );

      const resourceRestore = Effect.gen(function* () {
        let currentNative: unknown | undefined;
        if (nativeDescriptor !== undefined) {
          const currentSession = yield* providerService
            .listSessions()
            .pipe(
              Effect.map((sessions) =>
                sessions.find((session) => session.threadId === event.payload.threadId),
              ),
            );
          if (
            currentSession === undefined ||
            currentSession.threadId !== nativeDescriptor.threadId ||
            currentSession.provider !== nativeDescriptor.provider ||
            currentSession.providerInstanceId !== nativeDescriptor.instanceId ||
            String(currentSession.provider) !== nativeDescriptor.runtime ||
            nativeIdentity === undefined ||
            nativeIdentity.runtime !== nativeDescriptor.runtime ||
            nativeIdentity.sessionId !== nativeDescriptor.sessionId
          ) {
            return {
              ok: false as const,
              detail:
                "Native checkpoint restore was refused because its provider/session identity does not match the active session.",
            };
          }
        }

        if (nativeLeaf !== undefined) {
          const capturedNative = yield* providerService
            .captureNativeCheckpoint({ threadId: event.payload.threadId })
            .pipe(Effect.result);
          if (Result.isFailure(capturedNative)) {
            return {
              ok: false as const,
              detail: `Native checkpoint compensation capture failed: ${failureDetail(capturedNative.failure)}`,
            };
          }
          if (capturedNative.success === undefined) {
            return {
              ok: false as const,
              detail:
                "Native checkpoint restore was refused because the current native leaf could not be captured for compensation.",
            };
          }
          currentNative = capturedNative.success;
        }

        if (filesystemRestore !== undefined) {
          const capturedFilesystem = yield* checkpointStore
            .captureCheckpoint({
              cwd: filesystemRestore.cwd,
              checkpointRef: compensationRef,
            })
            .pipe(Effect.result);
          if (Result.isFailure(capturedFilesystem)) {
            return {
              ok: false as const,
              detail: `Filesystem compensation capture failed: ${failureDetail(capturedFilesystem.failure)}`,
            };
          }

          const restoredFilesystem = yield* checkpointStore
            .restoreCheckpoint({
              cwd: filesystemRestore.cwd,
              checkpointRef: filesystemRestore.checkpointRef,
              fallbackToHead: event.payload.turnCount === 0,
            })
            .pipe(Effect.result);
          if (Result.isFailure(restoredFilesystem) || !restoredFilesystem.success) {
            const compensationDetail = filesystemCompensationDetail(
              yield* restoreFilesystemCompensation(filesystemRestore.cwd),
            );
            return {
              ok: false as const,
              detail: Result.isFailure(restoredFilesystem)
                ? `Filesystem checkpoint restore failed: ${failureDetail(restoredFilesystem.failure)}.${compensationDetail}`
                : `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.${compensationDetail}`,
            };
          }
        }

        if (nativeLeaf !== undefined) {
          const restoredNative = yield* providerService
            .restoreNativeCheckpoint({
              threadId: event.payload.threadId,
              checkpoint: nativeLeaf,
            })
            .pipe(Effect.result);
          if (Result.isFailure(restoredNative)) {
            const compensatedNative = yield* providerService
              .restoreNativeCheckpoint({
                threadId: event.payload.threadId,
                checkpoint: currentNative,
              })
              .pipe(Effect.result);
            const compensatedFilesystem =
              filesystemRestore === undefined
                ? undefined
                : yield* restoreFilesystemCompensation(filesystemRestore.cwd);
            const compensationDetails = [
              Result.isFailure(compensatedNative)
                ? ` Native compensation failed: ${failureDetail(compensatedNative.failure)}`
                : "",
              filesystemCompensationDetail(compensatedFilesystem),
            ].join("");
            return {
              ok: false as const,
              detail: `Native checkpoint restore failed: ${failureDetail(restoredNative.failure)}.${compensationDetails}`,
            };
          }
        }

        return { ok: true as const };
      }).pipe(Effect.ensuring(cleanupCompensationRef));

      const resourceResult = yield* resourceRestore;
      if (!resourceResult.ok) {
        yield* persistRecoveryFailure({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: resourceResult.detail,
          createdAt: now,
          providerName: thread.session?.providerName ?? null,
          providerInstanceId: thread.session?.providerInstanceId,
          runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      if (filesystemRestore !== undefined) {
        // Refresh the workspace entry index so the @-mention file picker
        // reflects the reverted filesystem state.
        yield* refreshWorkspaceEntries(filesystemRestore.cwd);
      }
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (nativeTarget === undefined && rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: event.payload.threadId,
        numTurns: rolledBackTurns,
      });
    }
    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (checkpointCwd && staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn(thread.projectId);
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("checkpoint reactor failed to process input", {
            source: input.source,
            eventType: input.event.type,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(
      Effect.andThen(statusRefreshWorker.drain),
      Effect.andThen(entryRefreshWorker.drain),
    ),
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
