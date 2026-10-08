/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderNativeCommandsInput,
  ProviderNativeSessionListInput,
  ProviderNativeSessionSummary,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSubagentTranscriptReadResult,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  MessageId,
  ThreadId,
  ProviderTurnStartResult,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities, ProviderNativeHistoryPage } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly compactThread: (
    threadId: ThreadId,
    modelSelection?: ProviderSendTurnInput["modelSelection"],
    requestId?: MessageId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  readonly listNativeSessions?: (
    input: ProviderNativeSessionListInput,
  ) => Effect.Effect<ReadonlyArray<ProviderNativeSessionSummary>, ProviderServiceError>;
  readonly discoverNativeCommands: (
    input: ProviderNativeCommandsInput,
  ) => Effect.Effect<ReadonlyArray<ServerProviderSlashCommand>, ProviderServiceError>;

  readonly readNativeHistory?: (input: {
    readonly threadId: ThreadId;
    readonly cursor?: string;
  }) => Effect.Effect<ProviderNativeHistoryPage, ProviderServiceError>;
  readonly readNativeHistoryBySession?: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: string;
    readonly cwd: string;
    readonly cursor?: string;
  }) => Effect.Effect<ProviderNativeHistoryPage, ProviderServiceError>;
  readonly readSubagentTranscript?: (input: {
    readonly threadId: ThreadId;
    readonly subagentId: string;
    readonly cursor?: string;
  }) => Effect.Effect<ProviderSubagentTranscriptReadResult, ProviderServiceError>;
  readonly renameNativeSession?: (input: {
    readonly threadId: ThreadId;
    readonly name: string;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly forkNativeSession?: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<{ readonly sessionId: string }, ProviderServiceError>;

  /**
   * Reject unsupported rewind before files change, without resuming the session.
   */
  readonly assertConversationRollbackSupported: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;
  /**
   * Capture the opaque provider-native checkpoint leaf for a quiescent turn.
   * Providers without native checkpoint support return `undefined`.
   */
  readonly captureNativeCheckpoint: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<unknown | undefined, ProviderServiceError>;

  /**
   * Restore an opaque provider-native checkpoint leaf into a quiescent
   * provider session. A missing provider capability is an explicit failure
   * when a checkpoint leaf is supplied.
   */
  readonly restoreNativeCheckpoint: (input: {
    readonly threadId: ThreadId;
    readonly checkpoint: unknown;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Upload a thread and return the provider's shareable feedback identifier.
   */
  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
