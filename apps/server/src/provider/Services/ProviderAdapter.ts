/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ChatImageAttachment,
  ItemLifecyclePayload,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderNativeCommandError,
  ProviderNativeCommandsInput,
  ProviderNativeSessionError,
  ProviderNativeSessionListInput,
  ProviderNativeSessionSummary,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSubagentTranscriptReadResult,
  ProviderUserInputAnswers,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  TaskProgressPayload,
  TaskUpdatedPayload,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * How ProviderService runs manual context compaction for an adapter.
 * Native adapters expose a start call and must emit a compacted thread state
 * when they finish. Slash-command adapters get the command sent as a turn.
 */
export type ProviderCompaction<TError> =
  | {
      readonly type: "native";
      readonly start: (
        threadId: ThreadId,
        modelSelection?: ProviderSendTurnInput["modelSelection"],
      ) => Effect.Effect<void, TError>;
    }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Starts a resumed turn with no synthetic user prompt. Omitted means the
      adapter needs an explicit continuation instruction. */
  readonly promptlessTurnContinuation?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}
export interface ProviderNativeHistoryTextMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly timestamp: string;
  readonly model?: string;
  readonly sourceId?: string;
  readonly sourceIndex?: number;
  readonly images?: ReadonlyArray<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }>;
  readonly attachments?: ReadonlyArray<ChatImageAttachment>;
}

export interface ProviderNativeHistoryToolMessage {
  readonly role: "tool";
  readonly timestamp: string;
  readonly toolCallId?: string;
  readonly phase: "started" | "updated" | "completed";
  readonly payload: ItemLifecyclePayload;
  readonly sourceId?: string;
  readonly sourceIndex?: number;
  readonly tasks?: ReadonlyArray<TaskProgressPayload & Pick<TaskUpdatedPayload, "endedAt">>;
}

export type ProviderNativeHistoryMessage =
  | ProviderNativeHistoryTextMessage
  | ProviderNativeHistoryToolMessage;

export interface ProviderNativeHistoryPage {
  readonly messages: ReadonlyArray<ProviderNativeHistoryMessage>;
  readonly nextCursor?: string;
  readonly totalMessages: number;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Omitted when this adapter does not support manual context compaction. */
  readonly compaction?: ProviderCompaction<TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * List durable sessions owned by the native runtime.
   *
   * Adapters omit this method when their runtime has no stable native session catalog.
   */
  readonly listNativeSessions?: (
    input: ProviderNativeSessionListInput,
  ) => Effect.Effect<
    ReadonlyArray<ProviderNativeSessionSummary>,
    TError | ProviderNativeSessionError
  >;
  /**
   * Discover provider-native slash commands in one explicit workspace.
   */
  readonly discoverNativeCommands?: (
    input: ProviderNativeCommandsInput,
  ) => Effect.Effect<
    ReadonlyArray<ServerProviderSlashCommand>,
    TError | ProviderNativeCommandError
  >;

  /**
   * Read one bounded page from the native history of an active session.
   */
  readonly readNativeHistory?: (
    threadId: ThreadId,
    cursor?: string,
  ) => Effect.Effect<ProviderNativeHistoryPage, TError | ProviderNativeSessionError>;
  /**
   * Read one bounded page from a durable native session without launching it.
   */
  readonly readNativeHistoryBySession?: (input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly cursor?: string;
  }) => Effect.Effect<ProviderNativeHistoryPage, TError | ProviderNativeSessionError>;
  /**
   * Read an incremental transcript page for one provider-native subagent.
   *
   * Adapters omit this method when their runtime cannot expose child sessions.
   */
  readonly readSubagentTranscript?: (
    threadId: ThreadId,
    subagentId: string,
    cursor?: string,
  ) => Effect.Effect<ProviderSubagentTranscriptReadResult, TError | ProviderNativeSessionError>;
  /** Read a child transcript without starting its durable parent session. */
  readonly readSubagentTranscriptBySession?: (input: {
    readonly sessionId: string;
    readonly subagentId: string;
    readonly cwd: string;
    readonly cursor?: string;
  }) => Effect.Effect<ProviderSubagentTranscriptReadResult, TError | ProviderNativeSessionError>;
  /**
   * Rename the durable native session currently attached to a thread.
   */
  readonly renameNativeSession?: (
    threadId: ThreadId,
    name: string,
  ) => Effect.Effect<void, TError | ProviderNativeSessionError>;

  /**
   * Fork the durable native session currently attached to a thread.
   *
   * Native runtimes rebind the process to the fork. Callers must stop the
   * source thread before attaching the returned session id elsewhere.
   */
  readonly forkNativeSession?: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly sessionId: string }, TError | ProviderNativeSessionError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;
  /**
   * Capture the provider-native checkpoint leaf for a quiescent session.
   *
   * Providers without native checkpoint capability omit this method. The
   * returned value is opaque and may be `undefined` when the runtime has no
   * native leaf to persist.
   */
  readonly captureNativeCheckpoint?: (
    threadId: ThreadId,
  ) => Effect.Effect<unknown | undefined, TError>;

  /**
   * Restore an opaque provider-native checkpoint leaf into a quiescent session.
   *
   * Providers without native checkpoint capability omit this method. Callers
   * must treat an omitted method as unsupported when a native leaf exists.
   */
  readonly restoreNativeCheckpoint?: (
    threadId: ThreadId,
    checkpoint: unknown,
  ) => Effect.Effect<void, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
