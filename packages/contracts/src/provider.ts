import * as Schema from "effect/Schema";
import { AbsolutePath, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  UserInputAttachments,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderNativeSessionStatus = Schema.Literals([
  "complete",
  "interrupted",
  "aborted",
  "error",
  "pending",
  "unknown",
]);
export type ProviderNativeSessionStatus = typeof ProviderNativeSessionStatus.Type;
export const ProviderNativeSessionRuntime = Schema.Literals(["pi", "omp"]);
export type ProviderNativeSessionRuntime = typeof ProviderNativeSessionRuntime.Type;

export const ProviderNativeSessionSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  runtime: ProviderNativeSessionRuntime,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  model: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  status: ProviderNativeSessionStatus,
});
export type ProviderNativeSessionSummary = typeof ProviderNativeSessionSummary.Type;
export const ProviderNativeSessionListRequest = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ProviderNativeSessionListRequest = typeof ProviderNativeSessionListRequest.Type;
export const ProviderNativeSessionListInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderNativeSessionListInput = typeof ProviderNativeSessionListInput.Type;

export const ProviderNativeCommandsInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  workspaceRoot: AbsolutePath,
});
export type ProviderNativeCommandsInput = typeof ProviderNativeCommandsInput.Type;

export const ProviderNativeSessionListResult = Schema.Struct({
  sessions: Schema.Array(ProviderNativeSessionSummary),
});
export type ProviderNativeSessionListResult = typeof ProviderNativeSessionListResult.Type;

export const ProviderNativeSessionOpenInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
  indexOnly: Schema.optional(Schema.Boolean),
});
export type ProviderNativeSessionOpenInput = typeof ProviderNativeSessionOpenInput.Type;

export const ProviderNativeSessionOpenResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type ProviderNativeSessionOpenResult = typeof ProviderNativeSessionOpenResult.Type;

export const ProviderNativeSessionRenameInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type ProviderNativeSessionRenameInput = typeof ProviderNativeSessionRenameInput.Type;

export const ProviderNativeSessionRenameResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type ProviderNativeSessionRenameResult = typeof ProviderNativeSessionRenameResult.Type;

export const ProviderNativeSessionForkInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type ProviderNativeSessionForkInput = typeof ProviderNativeSessionForkInput.Type;

export const ProviderNativeSessionForkResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type ProviderNativeSessionForkResult = typeof ProviderNativeSessionForkResult.Type;

export const ProviderNativeSessionStopInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type ProviderNativeSessionStopInput = typeof ProviderNativeSessionStopInput.Type;

export const ProviderNativeSessionStopResult = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type ProviderNativeSessionStopResult = typeof ProviderNativeSessionStopResult.Type;

export const ProviderNativeSessionArchiveInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type ProviderNativeSessionArchiveInput = typeof ProviderNativeSessionArchiveInput.Type;

export const ProviderNativeSessionArchiveResult = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderNativeSessionArchiveResult = typeof ProviderNativeSessionArchiveResult.Type;

export const ProviderNativeSessionResumeCursor = Schema.Struct({
  kind: Schema.Literal("native-session"),
  runtime: ProviderNativeSessionRuntime,
  sessionId: TrimmedNonEmptyString,
});
export type ProviderNativeSessionResumeCursor = typeof ProviderNativeSessionResumeCursor.Type;

export const ProviderSubagentTranscriptEntryKind = Schema.Literals([
  "user",
  "assistant",
  "reasoning",
  "tool",
  "system",
]);
export type ProviderSubagentTranscriptEntryKind = typeof ProviderSubagentTranscriptEntryKind.Type;

export const ProviderSubagentTranscriptEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ProviderSubagentTranscriptEntryKind,
  text: TrimmedNonEmptyString,
  timestamp: IsoDateTime,
  toolName: Schema.optional(TrimmedNonEmptyString),
  isError: Schema.optional(Schema.Boolean),
});
export type ProviderSubagentTranscriptEntry = typeof ProviderSubagentTranscriptEntry.Type;

export const ProviderSubagentTranscriptReadInput = Schema.Struct({
  threadId: ThreadId,
  subagentId: TrimmedNonEmptyString,
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSubagentTranscriptReadInput = typeof ProviderSubagentTranscriptReadInput.Type;

export const ProviderSubagentTranscriptReadResult = Schema.Struct({
  entries: Schema.Array(ProviderSubagentTranscriptEntry),
  nextCursor: TrimmedNonEmptyString,
  reset: Schema.Boolean,
});
export type ProviderSubagentTranscriptReadResult = typeof ProviderSubagentTranscriptReadResult.Type;

export class ProviderNativeSessionError extends Schema.TaggedError<ProviderNativeSessionError>()(
  "ProviderNativeSessionError",
  {
    code: Schema.Literals(["unsupported", "not_found", "invalid", "native"]),
    message: TrimmedNonEmptyString,
  },
) {}
export const ProviderNativeCommandErrorCode = Schema.Literals([
  "unknown",
  "unsupported",
  "discovery",
]);
export type ProviderNativeCommandErrorCode = typeof ProviderNativeCommandErrorCode.Type;

export class ProviderNativeCommandError extends Schema.TaggedError<ProviderNativeCommandError>()(
  "ProviderNativeCommandError",
  {
    code: ProviderNativeCommandErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /** Internal recovery signal. Allows an empty turn only for adapters that
      explicitly support promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
