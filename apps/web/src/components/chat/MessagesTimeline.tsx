import { ComputerUseAppIcon } from "~/components/Icons";
import { useChatCanvas } from "./ChatCanvasContext";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { MarkdownFindContext, useFindRevealRef } from "./markdownFindContext";
import { type ThreadFindMatch, type ThreadFindPositionReader } from "./threadFind";
import { readThreadFindPosition } from "./threadFindPosition";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { WorkLogBlock, WorkLogButton, WorkLogDetails, WorkLogList, WorkLogRow } from "./WorkLog";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  getQuestionTextPreview,
  hasQuestionAnswer,
} from "@t3tools/client-runtime/work-log/user-input";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  type TimelineMinimapItem,
} from "./timelineMinimapItems";
import {
  COMPOSER_CONTEXT_KINDS,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  isOrchestrationV2WorkActive,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type ProviderApprovalDecision,
  type RunAttemptId,
  type ScopedThreadRef,
  type ServerProvider,
  type ServerProviderSkill,
  type RunId,
  type RuntimeRequestId,
  ThreadId,
  type ToolActivityIcon,
} from "@t3tools/contracts";
import { APP_BASE_NAME } from "~/branding";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  formatDiffStats,
  liveThoughtLine,
  resolveWorkEntryToolPresentation,
  resolveViewedImageAsset,
  toolGroupSummaryKind,
  workEntryViewedImagePath,
  type DiffStats,
} from "@t3tools/client-runtime/work-log/presentation";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import {
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};
const NOOP_LOAD_ACTIVITY_PAGE = (_request: ThreadActivityPageRequest) => {};

import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { toolActivityFaviconUrl } from "@t3tools/shared/favicon";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { getProjectFaviconCacheKey } from "@t3tools/shared/projectFavicon";
import { claudeSkillInvocation } from "@t3tools/shared/toolActivity";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  type TimelineEntry,
  providerErrorPresentation,
  projectedWorkEntry,
  createMessageAttachmentPreviewProjector,
  selectMessageImageResources,
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
  type PendingApproval,
  type WorkLogEntry,
} from "../../session-logic";
const NOOP_OPEN_NATIVE_TERMINAL = (
  _fallback: NonNullable<WorkLogEntry["nativeTerminalFallback"]>,
) => {};
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import type { ThreadActivityPageRequest } from "@t3tools/client-runtime/state/threads";
import type { TimelineActivityGroup } from "./timelineActivity";
import {
  type ChatMessage,
  type ChatFileAttachment,
  type ChatImageAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
  type TurnDiffSummary,
} from "../../types";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import ChatMarkdown from "../ChatMarkdown";
import { compileKmMarkdownSnapshot, useKmMarkdownRenderConfig } from "../markdown/markdownRuntime";
import { ChatMarkdownAssetImage } from "../markdown/MarkdownMedia";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { T3Wordmark } from "../T3Wordmark";
import { ThreadContextChip } from "../ThreadContextChip";
import {
  CalendarClockIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  DownloadIcon,
  EyeIcon,
  GitForkIcon,
  GlobeIcon,
  type LucideIcon,
  ListTodoIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MousePointerClickIcon,
  PaintbrushIcon,
  MinusIcon,
  Redo2Icon,
  Minimize2Icon,
  SearchIcon,
  SmartphoneIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  HammerIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
  RotateCcwIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import { SpinningGlobe } from "../ui/spinning-globe";
import { TerminalSpinner, ThinkingPulse } from "../ui/terminal-spinner";
import type {
  ComposerContextId,
  ComposerContextRecord,
  KnownComposerContextRecord,
} from "@t3tools/contracts";
import { Button, InlineButton } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { useAssetUrlRefresh, useAssetUrls, useAssetUrlState } from "../../assets/assetUrls";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import {
  buildAttachmentVideoAsset,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  ExpandedImagePreview,
} from "./ExpandedImagePreview";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { ApertureEmbedFrame, apertureAsOfLabel } from "./ApertureEmbedFrame";
import { McpAppFrame } from "./McpAppFrame";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  readTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { MessageCopyButton } from "./MessageCopyButton";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { inferEntryKindFromPath } from "../../pierre-icons";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  AssistantCitationSource,
  type AssistantCitationRequest,
  type AssistantCitationTarget,
} from "./AssistantCitationSource";
import { useAssistantCitationTarget, type CitationHistoryPage } from "./useAssistantCitationTarget";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRowsProjection,
  liveWorkEntryLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineIsAtEnd,
  timelineEntryTurnFoldRunId,
  timelineEntryTurnFoldRunIdsByEntryId,
  timelineRowKey,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  resolveWorkGroupScrollIndex,
  remarkThoughtPreview,
  shouldPreserveAssistantLineBreaks,
  threadReadLabelPrefix,
  threadReadTargetId,
  threadReadTargetTitle,
  toolGroupAction,
  workEntryDisplayLabel,
  workEntryReadOutput,
  workEntryIsVisibleInGroup,
  worktreeSetupAgentStarted,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type MessagesTimelineActivityStatus,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestRun,
  type TimelineRunTiming,
  type TimelineLiveSubagent,
  type TurnRecap as TurnRecapModel,
  type WorkGroupScrollAnchor,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BottomStickJumpButton, useBottomStick } from "../ui/bottom-stick";
import { Spinner } from "../ui/spinner";
import { ShimmerLayers } from "../ui/shimmer";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipScrollDismissArea } from "../ui/tooltip";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import {
  ContextChipPopover as UserMessageContextPopover,
  ContextChipShell,
  FileChip,
  ImageChipButton,
  PULL_REQUEST_CHIP_KINDS,
  PullRequestChip,
  UnresolvedChip,
} from "../contextChipParts";
import {
  asKnownContextRecord,
  isPullRequestSummaryContext,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
  resolveUserMessageContext,
  reviewCommentContextLabel,
  selectedMessageContextFragment,
} from "~/lib/composerContextRecords";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import { ContextChip, ContextChipLabel, type ContextChipKind } from "../ContextChip";
import { createContextPresentationRegistry } from "../contextPresentationRegistry";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useClientSettings } from "~/hooks/useSettings";
import type { TranscriptStyle } from "@t3tools/contracts/settings";
import { TranscriptStyleCtx } from "./transcriptStyle";
import { EXCERPT_FOLD_DELAY_MS, type TimelineAutoOpen } from "./timelineActivityPolicy";
import { RollingText } from "./RollingText";
import { ToolIntentTag } from "./ToolIntentTag";
import { workEntryPresentation } from "./toolWorkEntryCompactSummary";
import type { ChatMarkdownContextReference } from "../markdown/markdownContext";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { TurnRecap } from "./TurnRecap";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatUpcomingTimestamp,
} from "../../timestampFormat";
import { FetchedToolOutput, V2ItemInspector } from "./V2ItemInspector";
import { ToolWorkEntryCard } from "./ToolWorkEntryCard";
import {
  ActivityDisclosurePanel,
  toCollapsedKey,
  useActivityDisclosure,
} from "./ActivityDisclosure";
import {
  MOTION_MS,
  useChangedSinceMount,
  usePresence,
  usePresentList,
  useSmoothHeight,
} from "~/lib/motion";
import { useEndFollow } from "~/lib/endFollow";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { useStreamingReveal } from "@t3tools/client-runtime/streaming-reveal/react";
import {
  isV2LifecycleItem,
  SubagentNotificationLink,
  V2LifecycleRow,
  type HandoffTimelineRun,
} from "./V2LifecycleRow";
import { SubagentTaskTracker } from "./SubagentTaskTracker";
import { NativeNotice } from "./NativeNotice";
import { CursorTodoPanel } from "./CursorTodoPanel";
import { NativeTodoPane } from "./NativeTodoPane";
import { readNativeTodoPlan, type TodoPlanChange } from "./todoPlan";
import { isNativeWaitTool, isT3ThreadWait } from "./NativeWaitingPane.logic";
import { SecretRequestCard } from "./SecretRequestCard";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";

import { SkillChipIcon, SkillInlineText } from "./SkillInlineText";
import * as DateTime from "effect/DateTime";
import { BottomStickScrollArea } from "../ui/bottom-stick";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  citationRequest: AssistantCitationTarget | null;
  listRef: React.RefObject<LegendListRef | null>;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  /** Provider snapshots for resolving handoff endpoints to icons + model names. */
  providerStatuses: ReadonlyArray<ServerProvider>;
  /** Projection runs, for recovering handoff models on legacy items. */
  runs: ReadonlyArray<HandoffTimelineRun>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
  /** Sends text an MCP App asked to post, after the user approved it. */
  onSendAppMessage: ((text: string) => Promise<void>) | undefined;
  /**
   * An MCP App row entering or leaving full screen. The row stays rendered
   * and the list stops following new output meanwhile, so the app is not
   * virtualized away while the reader is using it.
   */
  onAppFullscreenChange: (rowId: string, fullscreen: boolean) => void;
  onRunShellCommand: ((command: string) => void) | undefined;
  findActive: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  onForkFromRun: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  onRollbackCheckpoint: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
  onToggleTurnFold: (runId: RunId | null, activityGroup?: TimelineActivityGroup) => void;
  onLoadActivityPage: (request: ThreadActivityPageRequest) => void | Promise<unknown>;
  onToggleAttemptFold: (attemptId: RunAttemptId) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
  onFileDownload: (attachment: ChatFileAttachment) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string, expanded: boolean) => void;
  onToggleWorkEntry: (anchorKey: string, collapsed: boolean) => void;
  onOpenNativeTerminal: (fallback: NonNullable<WorkLogEntry["nativeTerminalFallback"]>) => void;
  onCancelWorktreeSetup: (() => void) | null;
  retryableWorkspacePreparationRunIds: ReadonlySet<RunId>;
  onRetryWorkspacePreparation: ((runId: RunId) => void) | null;
  onWorktreeSetupWorkLocally: (() => void) | null;
  onOpenWorktreeSetupTerminal: ((terminalId: string) => void) | null;
  workGroupViewState: WorkGroupViewState;
  pendingApprovals: ReadonlyMap<RuntimeRequestId, PendingApproval>;
  respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  canOperateThread: boolean;
  onRespondToApproval:
    | ((requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<unknown>)
    | undefined;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isCompacting: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  /** The agent waits on an approval or an answer from the user. */
  awaitingUser: boolean;
  isPreparingWorktree: boolean;
  latestRunId: RunId | null;
  /** The latest reasoning entry has yielded to a later live tool. */
  supersededThoughtId: string | null;
  /**
   * A worktree setup whose script is still running after the agent took
   * over. The working header shows it as a chip with a popover; the stage
   * list itself has already left the timeline.
   */
  backgroundWorktreeSetup: WorktreeSetupSnapshot | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

/**
 * Row motion runs only while the reader follows live work, or while a run that
 * just ended folds away. History, virtualized remounts, and thread switches
 * render still.
 */
interface TimelineRowMotionState {
  live: boolean;
  /** Row keys this thread's timeline data has held; a first sighting while live is an arrival. */
  seenRowKeys: Set<string>;
  /** Steps this timeline has drawn; one that moves rows (a lone step joining a group) does not roll in again. */
  seenStepIds: Set<string>;
  /** Row keys removed from the data that stay mounted while they collapse out. */
  exitingRowKeys: ReadonlySet<string>;
}
const TimelineRowMotionCtx = createContext<TimelineRowMotionState>(null!);
const NO_EXITING_ROWS: ReadonlySet<string> = new Set();

interface WorkGroupViewState {
  scrollPositions: Map<string, WorkGroupScrollAnchor>;
  expandedEntries: Set<string>;
}

const WorkGroupViewCtx = createContext<{
  state: WorkGroupViewState;
  onToggleEntry: (collapsed: boolean) => void;
  /** Steps seen arriving in the open group; the steps it opened with are absent. */
  arrivals: ReadonlyMap<string, WorkEntryArrival>;
} | null>(null);
interface WorkEntryArrival {
  /** performance.now() when the step was first seen. */
  readonly at: number;
  /** Stagger for steps that arrive together with their group. */
  readonly delayMs: number;
}
/** A step mounting this soon after it joined its group rolls in; a later remount (scrolling) does not. */
const GROUP_ARRIVAL_WINDOW_MS = 1000;
/** Steps that arrive with their group roll in one after another, this far apart. */
const GROUP_ARRIVAL_STAGGER_MS = 45;
const GROUP_ARRIVAL_STAGGER_MAX_MS = 225;
/** KM excerpts open because their step runs (`live`) or because it just settled (`settling`). */
interface ExcerptFold {
  readonly live: ReadonlySet<string>;
  readonly settling: ReadonlySet<string>;
}
const EMPTY_EXCERPT_FOLD: ExcerptFold = { live: new Set(), settling: new Set() };
/** Whether the timeline row being rendered arrived while the reader watched. */
const TimelineRowArrivedCtx = createContext(false);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);
function TimelineListFooter({
  composerInset,
  footerRef,
  children,
}: {
  readonly composerInset: number;
  readonly footerRef: Ref<HTMLDivElement>;
  readonly children?: ReactNode;
}) {
  return (
    <div ref={footerRef}>
      {children}
      <div aria-hidden style={{ height: composerInset }} />
      {/* Breathing room between the last row and the composer. */}
      <div aria-hidden className="h-8 sm:h-10" />
    </div>
  );
}
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_TIMELINE_RUNS: ReadonlyArray<HandoffTimelineRun> = [];
const EMPTY_TIMELINE_RUN_TIMINGS_BY_ID: ReadonlyMap<RunId, TimelineRunTiming> = new Map<
  RunId,
  TimelineRunTiming
>();
const EMPTY_RUN_IDS: ReadonlySet<RunId> = new Set();
const EMPTY_ACTIVITY_GROUPS: ReadonlyArray<TimelineActivityGroup> = [];
const EMPTY_PENDING_APPROVALS: ReadonlyArray<PendingApproval> = [];
const EMPTY_RESPONDING_REQUEST_IDS: ReadonlyArray<RuntimeRequestId> = [];
const EMPTY_SUBAGENT_SOURCES: ReadonlyMap<string, ReadonlyArray<TimelineLiveSubagent> | undefined> =
  new Map();
// Timeline maintenance is instant so streamed growth cannot pull a reader
// away from the historical position they chose.

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

export interface MessagesTimelineHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

type TimelineProjectionRun = HandoffTimelineRun &
  Partial<
    Pick<
      OrchestrationV2Run,
      "requestedAt" | "startedAt" | "workStartedAt" | "completedAt" | "workCompletedAt"
    >
  >;

interface MessagesTimelineProps {
  citationRequest?: AssistantCitationRequest | null;
  citationHistoryLoading?: boolean;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  onOpenNativeTerminal?: (fallback: NonNullable<WorkLogEntry["nativeTerminalFallback"]>) => void;
  activityStatus?: MessagesTimelineActivityStatus | null;
  /** Native work-end timestamp from the activity-owning run, not latestRun. */
  activityRunWorkCompletedAt?: string | null;
  isWorking: boolean;
  /** The live work belongs to a runless root turn (a provider-native subagent). */
  runlessWorkActive?: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt?: string | null;
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  /** Runs whose failed workspace preparation can be retried, keyed by run id. */
  retryableWorkspacePreparationRunIds?: ReadonlySet<RunId>;
  onRetryWorkspacePreparation?: (runId: RunId) => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  /** The agent waits on an approval or an answer from the user. */
  awaitingUser?: boolean;
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  respondingRequestIds?: ReadonlyArray<RuntimeRequestId>;
  canOperateThread?: boolean;
  onRespondToApproval?: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  /** Thread state shown after the last message, such as a settled or snoozed line. */
  footer?: ReactNode;

  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  parentThreadLink?: {
    readonly threadId: ThreadId;
    readonly title: string;
  } | null;
  onForkFromRun: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  onRollbackCheckpoint: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
  supportsConversationRollback: boolean;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  onSendAppMessage?: (text: string) => Promise<void>;
  onRunShellCommand?: (command: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: (attachment: ChatFileAttachment) => void;
  onFileDownload?: (attachment: ChatFileAttachment) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  providerStatuses: ReadonlyArray<ServerProvider>;
  runs: ReadonlyArray<TimelineProjectionRun>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /**
   * Whether the timeline should keep pinning to the live edge as content
   * grows. Off while the user is reading history, so drifting near the
   * bottom does not re-pin regardless of ChatView's scroll-mode refs.
   */
  liveFollowEnabled: boolean;
  /**
   * Whether the real rows extend past the viewport above the composer.
   * Reported after scrolls, row size changes, and viewport resizes.
   */
  onContentOverflowChange?: (overflows: boolean) => void;
  onToolOutputCollapsedAtEnd?: () => void;
  onManualNavigation: () => void;
  cancelPositionRestoreRef?: React.RefObject<(() => void) | null>;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  historyControls?: MessagesTimelineHistoryControls;
  /** Summary-backed activity groups; absent or empty keeps the legacy timeline. */
  activityGroups?: ReadonlyArray<TimelineActivityGroup>;
  onLoadActivityPage?: (request: ThreadActivityPageRequest) => void | Promise<unknown>;
  /** Non-null when older turns exist beyond the loaded window. */
  loadEarlier?: CitationHistoryPage | null;
  /** Renders in this style instead of the saved setting (the Appearance preview). */
  transcriptStyle?: TranscriptStyle;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  citationRequest = null,
  citationHistoryLoading = false,
  onCiteAssistantText,
  isWorking,
  runlessWorkActive = false,
  activeTurnInProgress,
  activityStatus = null,
  activityRunWorkCompletedAt = null,
  activeTurnStartedAt = null,
  worktreeSetup = null,
  footer = null,
  onCancelWorktreeSetup,
  retryableWorkspacePreparationRunIds = EMPTY_RUN_IDS,
  onRetryWorkspacePreparation,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  awaitingUser = false,
  pendingApprovals = EMPTY_PENDING_APPROVALS,
  respondingRequestIds = EMPTY_RESPONDING_REQUEST_IDS,
  canOperateThread = false,
  onRespondToApproval,
  onOpenNativeTerminal = NOOP_OPEN_NATIVE_TERMINAL,
  listRef,
  timelineEntries,
  latestRun,
  runningRunId = null,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  onOpenTurnDiff,
  onOpenThread,
  parentThreadLink = null,
  onForkFromRun,
  onRollbackCheckpoint,
  supportsConversationRollback,
  onRevertToTurnCount,
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onSendAppMessage,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  providerStatuses,
  runs: runsProp,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  onContentOverflowChange,
  liveFollowEnabled,
  onToolOutputCollapsedAtEnd,
  onManualNavigation,
  cancelPositionRestoreRef,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  historyControls,
  activityGroups = EMPTY_ACTIVITY_GROUPS,
  onLoadActivityPage = NOOP_LOAD_ACTIVITY_PAGE,
  loadEarlier = null,
  transcriptStyle: transcriptStyleOverride,
}: MessagesTimelineProps) {
  const find = use(ThreadFindTimelineContext);
  const findOpen = find?.findOpen ?? false;
  const findExpanded = find?.findExpanded ?? false;
  const findQuery = find?.findQuery ?? "";
  const activeFindMatch = find?.activeFindMatch ?? null;
  const findNavigationId = find?.findNavigationId ?? 0;
  const findPositionReaderRef = find?.findPositionReaderRef ?? null;
  const normalizedFindQuery = findQuery.trim();
  const findActive = findExpanded;
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  const previousFindNavigationRef = useRef({ identity: listIdentityKey, open: false });
  useEffect(() => {
    const previous = previousFindNavigationRef.current;
    previousFindNavigationRef.current = { identity: listIdentityKey, open: findOpen };
    if (findOpen && (!previous.open || previous.identity !== listIdentityKey)) {
      onManualNavigation();
    }
  }, [findOpen, listIdentityKey, onManualNavigation]);
  const markdownWarmupSkillNames = useMemo(() => skills.map((skill) => skill.name), [skills]);
  const markdownWarmupConfig = useKmMarkdownRenderConfig({
    lineBreaks: false,
    parseRawHtml: true,
    streamWordFade: false,
    isStreaming: false,
    pullRequestRepositoryUrl: null,
    skillNames: markdownWarmupSkillNames,
  });
  const markdownWarmupHardBreakConfig = useKmMarkdownRenderConfig({
    lineBreaks: true,
    parseRawHtml: true,
    streamWordFade: false,
    isStreaming: false,
    pullRequestRepositoryUrl: null,
    skillNames: markdownWarmupSkillNames,
  });
  const finalizedAssistantMarkdown = useMemo(
    () =>
      timelineEntries.flatMap((entry) => {
        if (
          entry.kind !== "message" ||
          entry.message.role !== "assistant" ||
          entry.message.streaming === true
        ) {
          return [];
        }
        const text = entry.message.text || "(empty response)";
        return [{ text, lineBreaks: shouldPreserveAssistantLineBreaks(text) }];
      }),
    [timelineEntries],
  );
  useEffect(() => {
    if (finalizedAssistantMarkdown.length === 0) return;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let cancelled = false;
    let cursor = 0;
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    const scheduleBatch = () => {
      if (cancelled) return;
      if (idleWindow.requestIdleCallback !== undefined) {
        idleHandle = idleWindow.requestIdleCallback(runBatch, { timeout: 2000 });
      } else {
        timeoutHandle = window.setTimeout(runBatch, 0);
      }
    };
    const runBatch = () => {
      idleHandle = undefined;
      timeoutHandle = undefined;
      if (cancelled) return;
      const batch = finalizedAssistantMarkdown.slice(cursor, cursor + 8);
      cursor += batch.length;
      const compilations = batch.map(({ text, lineBreaks }) =>
        compileKmMarkdownSnapshot(
          text,
          lineBreaks ? markdownWarmupHardBreakConfig : markdownWarmupConfig,
        ).catch((error: unknown) => {
          console.error("[chat-markdown] snapshot warm-up failed", error);
        }),
      );
      void Promise.all(compilations).then(() => {
        if (cursor < finalizedAssistantMarkdown.length) scheduleBatch();
      });
    };
    scheduleBatch();
    return () => {
      cancelled = true;
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
    };
  }, [
    finalizedAssistantMarkdown,
    listIdentityKey,
    markdownWarmupConfig,
    markdownWarmupHardBreakConfig,
  ]);
  const subagentSourceThreadIds = useMemo(() => {
    const ids = new Set<ThreadId>();
    for (const entry of timelineEntries) {
      if (entry.kind === "event" && entry.projectedItem.item.type === "subagent") {
        ids.add(entry.projectedItem.item.threadId);
      }
    }
    return [...ids];
  }, [timelineEntries]);
  const [subagentSourceState, setSubagentSourceState] = useState<{
    readonly threadKey: string;
    readonly sources: ReadonlyMap<string, ReadonlyArray<TimelineLiveSubagent> | undefined>;
  }>(() => ({ threadKey: listIdentityKey, sources: new Map() }));
  const liveSubagentSources =
    subagentSourceState.threadKey === listIdentityKey
      ? subagentSourceState.sources
      : EMPTY_SUBAGENT_SOURCES;
  const onSubagentSourceChange = useCallback(
    (threadId: ThreadId, agents: ReadonlyArray<TimelineLiveSubagent> | undefined) => {
      setSubagentSourceState((current) => {
        const sources =
          current.threadKey === listIdentityKey ? current.sources : EMPTY_SUBAGENT_SOURCES;
        if (sources.has(threadId) && sameSubagentLifecycles(sources.get(threadId), agents))
          return current;
        const next = new Map(sources);
        next.set(threadId, agents);
        return { threadKey: listIdentityKey, sources: next };
      });
    },
    [listIdentityKey],
  );
  const rememberedPosition = useMemo(
    () => readTimelinePosition(listIdentityKey),
    [listIdentityKey],
  );
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(
    () => rememberedPosition?.disclosures?.runs ?? new Set(),
  );
  const [expandedActivityGroupKeys, setExpandedActivityGroupKeys] = useState<ReadonlySet<string>>(
    () => rememberedPosition?.disclosures?.activityGroups ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<ReadonlySet<RunAttemptId>>(
    () => rememberedPosition?.disclosures?.attempts ?? new Set(),
  );
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    rememberedPosition?.atEnd === false ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  const listIdentityRef = useRef(listIdentityKey);
  const previousLatestRunRef = useRef(latestRun);
  // The list stays mounted across thread switches. Its first end pins on the
  // new thread must snap, not glide, even if that thread is mid-turn.
  const [settlingListIdentity, setSettlingListIdentity] = useState<string | null>(null);
  const initialActivityPageRequestedRef = useRef(new Set<string>());
  let paintedExpandedRunIds = expandedRunIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedAttemptIds = expandedAttemptIds;
  let paintedExpandedActivityGroupKeys = expandedActivityGroupKeys;
  if (listIdentityRef.current !== listIdentityKey) {
    listIdentityRef.current = listIdentityKey;
    setPositionedThreadKey(null);
    previousLatestRunRef.current = latestRun;
    setSettlingListIdentity(listIdentityKey);
    paintedExpandedRunIds = rememberedPosition?.disclosures?.runs ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedActivityGroupKeys = rememberedPosition?.disclosures?.activityGroups ?? new Set();
    initialActivityPageRequestedRef.current.clear();
    paintedExpandedAttemptIds = rememberedPosition?.disclosures?.attempts ?? new Set();
    setExpandedRunIds(paintedExpandedRunIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedAttemptIds(paintedExpandedAttemptIds);
    setExpandedActivityGroupKeys(paintedExpandedActivityGroupKeys);
  }
  const citationThreadRef = useMemo(() => parseScopedThreadKey(routeThreadKey), [routeThreadKey]);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const expandCitedRun = useCallback((runId: RunId) => {
    setExpandedRunIds((current) => (current.has(runId) ? current : new Set([...current, runId])));
  }, []);
  // Nested tool state shares the bounded thread-position cache.
  const workGroupViewState = useMemo<WorkGroupViewState>(
    () =>
      rememberedPosition?.disclosures?.workGroupState ?? {
        scrollPositions: new Map(),
        expandedEntries: new Set(),
      },
    [listIdentityKey, rememberedPosition],
  );
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (settlingListIdentity === null) return;
    // Two frames covers the fresh-data layout pass and the initial end pin.
    let second: number | null = null;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setSettlingListIdentity((current) => (current === settlingListIdentity ? null : current));
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== null) cancelAnimationFrame(second);
    };
  }, [settlingListIdentity]);

  const suspendEndScrollMaintenanceForDisclosure = useCallback(
    (anchorKey: string, collapsed = false) => {
      disclosureAnchorKeyRef.current = anchorKey;
      setDisclosureToggleSettling(true);
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
      disclosureSettleFrameRef.current = requestAnimationFrame(() => {
        disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
          disclosureAnchorKeyRef.current = null;
          setDisclosureToggleSettling(false);
          disclosureSettleFrameRef.current = null;
          disclosureSettleSecondFrameRef.current = null;
          // Wait for row measurement and the disclosure click's blur check.
          // Closing output can reveal the end without a scroll event.
          if (collapsed && resolveTimelineIsAtEnd(listRef.current?.getState()) === true) {
            onToolOutputCollapsedAtEnd?.();
          }
        });
      });
    },
    [listRef, onToolOutputCollapsedAtEnd],
  );

  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  }, []);
  const onExpandActivityGroup = useCallback(
    (group: TimelineActivityGroup) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${group.key}`);
      setExpandedActivityGroupKeys((existing) =>
        existing.has(group.key) ? existing : new Set([...existing, group.key]),
      );

      const latestPageIsLoaded = group.loadedLastOrdinal === group.summary.lastOrdinal;
      if (latestPageIsLoaded || group.loading || group.error !== null) return;
      const requestKey = JSON.stringify([listIdentityKey, group.key]);
      if (initialActivityPageRequestedRef.current.has(requestKey)) return;
      initialActivityPageRequestedRef.current.add(requestKey);
      void onLoadActivityPage(group.initialRequest);
    },
    [listIdentityKey, onLoadActivityPage, suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleTurnFold = useCallback(
    (runId: RunId | null, activityGroup?: TimelineActivityGroup) => {
      if (activityGroup !== undefined) {
        const isExpanded =
          paintedExpandedActivityGroupKeys.has(activityGroup.key) ||
          (runId !== null && paintedExpandedRunIds.has(runId));
        if (!isExpanded) {
          onExpandActivityGroup(activityGroup);
          return;
        }
        suspendEndScrollMaintenanceForDisclosure(`turn-fold:${activityGroup.key}`, true);
        setExpandedActivityGroupKeys((existing) => {
          const next = new Set(existing);
          next.delete(activityGroup.key);
          return next;
        });
        if (runId !== null) {
          setExpandedRunIds((existing) => {
            const next = new Set(existing);
            next.delete(runId);
            return next;
          });
        }
        return;
      }
      if (runId === null) return;
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${runId}`);
      setExpandedRunIds((existing) => {
        const next = new Set(existing);
        if (next.has(runId)) {
          next.delete(runId);
          workGroupViewState.expandedEntries.add(`turn-collapsed:${runId}`);
        } else {
          next.add(runId);
          workGroupViewState.expandedEntries.delete(`turn-collapsed:${runId}`);
        }
        return next;
      });
    },
    [
      onExpandActivityGroup,
      paintedExpandedActivityGroupKeys,
      paintedExpandedRunIds,
      suspendEndScrollMaintenanceForDisclosure,
      workGroupViewState.expandedEntries,
    ],
  );

  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string, isCurrentlyExpanded: boolean) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey, isCurrentlyExpanded);
      const collapsedKey = `work-group-collapsed:${groupId}`;
      setExpandedWorkGroupIds((existing) => {
        const next = new Set(existing);
        if (isCurrentlyExpanded) {
          next.delete(groupId);
          next.add(collapsedKey);
          workGroupViewState.expandedEntries.delete(groupId);
          workGroupViewState.expandedEntries.add(collapsedKey);
        } else {
          next.delete(collapsedKey);
          next.add(groupId);
          workGroupViewState.expandedEntries.delete(collapsedKey);
          workGroupViewState.expandedEntries.add(groupId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure, workGroupViewState.expandedEntries],
  );
  const onToggleAttemptFold = useCallback(
    (attemptId: RunAttemptId) => {
      suspendEndScrollMaintenanceForDisclosure(`attempt-fold:${attemptId}`);
      setExpandedAttemptIds((existing) => {
        const next = new Set(existing);
        if (next.has(attemptId)) {
          next.delete(attemptId);
        } else {
          next.add(attemptId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.

  useEffect(() => {
    const previous = previousLatestRunRef.current;
    previousLatestRunRef.current = latestRun;
    if (!latestRun || previous?.runId === undefined) {
      return;
    }
    if (latestRun.runId === previous.runId) {
      if (previous.status === "running" && latestRun.status === "interrupted") {
        setExpandedRunIds((existing) => {
          const next = new Set(existing);
          next.add(latestRun.runId);
          return next;
        });
      }
      return;
    }
    setExpandedRunIds((existing) => {
      if (!existing.has(previous.runId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.runId);
      return next;
    });
  }, [latestRun]);

  const runTimingsById = useStableTimelineRunTimings(runsProp);
  const savedTranscriptStyle = useClientSettings((settings) => settings.transcriptStyle);
  const transcriptStyle = transcriptStyleOverride ?? savedTranscriptStyle;
  const savedToolDetail = useClientSettings((settings) => settings.toolDetail);
  const liveStepsKeptOpen = useClientSettings((settings) => settings.liveStepsKeptOpen);
  // Minimal opens a step's body only when the reader asks; KM and Minimal+ also
  // show edits, writes, commands, code cells and subagents while they run, and
  // Minimal+ keeps the running turn's latest few open; Terminal opens the foreground step.
  const autoOpen: TimelineAutoOpen =
    transcriptStyle === "minimal" || savedToolDetail === "minimal"
      ? "none"
      : transcriptStyle === "km" || transcriptStyle === "minimal-plus"
        ? "live-excerpts"
        : "foreground";
  const excerptsKeptOpen = transcriptStyle === "minimal-plus" && isWorking ? liveStepsKeptOpen : 0;
  // A live excerpt stays open EXCERPT_FOLD_DELAY_MS after its step settles, then folds.
  const [excerptFold, setExcerptFold] = useState<ExcerptFold>(EMPTY_EXCERPT_FOLD);
  const rowsProjectionRef = useRef<{
    readonly threadKey: string;
    readonly workspaceRoot: string | undefined;
    readonly projection: MessagesTimelineRowsProjection;
  } | null>(null);
  const pendingApprovalsByRequestId = useMemo(() => {
    const approvals = new Map<RuntimeRequestId, PendingApproval>();
    for (const approval of pendingApprovals) {
      approvals.set(approval.requestId, approval);
    }
    return approvals;
  }, [pendingApprovals]);
  const pendingApprovalRequestIds = useMemo(
    () => new Set(pendingApprovalsByRequestId.keys()),
    [pendingApprovalsByRequestId],
  );
  const rawRows = useMemo(() => {
    const previous = rowsProjectionRef.current;
    const projection = deriveMessagesTimelineRowsWithState(
      {
        timelineEntries,
        pendingApprovalRequestIds,
        latestRun,
        runTimingsById,
        runningRunId,
        expandedRunIds: paintedExpandedRunIds,
        expandedActivityGroupKeys: paintedExpandedActivityGroupKeys,
        activityGroups,
        expandedAttemptIds,
        expandedWorkGroupIds,
        explicitActivityCache: workGroupViewState.expandedEntries,
        isWorking,
        activityStatus,
        activityRunWorkCompletedAt,
        runlessWorkActive,
        activeTurnStartedAt,
        turnDiffSummaries,
        supportsConversationRollback,
        worktreeSetup,
        liveSubagentSources,
        autoOpen,
        settlingExcerptIds: excerptFold.settling,
        excerptsKeptOpen,
        layout: transcriptStyle === "terminal" ? "flat" : "grouped",
      },
      previous?.threadKey === listIdentityKey && previous.workspaceRoot === workspaceRoot
        ? previous.projection
        : null,
    );
    rowsProjectionRef.current = { threadKey: listIdentityKey, workspaceRoot, projection };
    return projection.rows;
  }, [
    rowsProjectionRef,
    listIdentityKey,
    workspaceRoot,
    timelineEntries,
    pendingApprovalRequestIds,
    latestRun,
    runTimingsById,
    runningRunId,
    paintedExpandedRunIds,
    paintedExpandedActivityGroupKeys,
    activityGroups,
    expandedAttemptIds,
    expandedWorkGroupIds,
    workGroupViewState.expandedEntries,
    isWorking,
    activityStatus,
    activityRunWorkCompletedAt,
    runlessWorkActive,
    activeTurnStartedAt,
    turnDiffSummaries,
    supportsConversationRollback,
    worktreeSetup,
    liveSubagentSources,
    autoOpen,
    excerptFold.settling,
    excerptsKeptOpen,
    transcriptStyle,
  ]);
  const rows = useStableRows(rawRows, listIdentityKey);
  const unmatchedPendingApprovals = useMemo(() => {
    if (pendingApprovalsByRequestId.size === 0) return pendingApprovalsByRequestId;
    const unmatched = new Map(pendingApprovalsByRequestId);
    for (const row of rows) {
      if (row.kind !== "work") continue;
      for (const entry of row.groupedEntries) {
        const item = entry.projectedItem?.item;
        if (item?.type === "approval_request") unmatched.delete(item.requestId);
      }
    }
    return unmatched;
  }, [pendingApprovalsByRequestId, rows]);
  const selectedFindEntryIsVisible =
    activeFindMatch !== null && rows.some((row) => row.id === activeFindMatch.entryId);
  const activeFindRunId =
    activeFindMatch && !selectedFindEntryIsVisible
      ? timelineEntryTurnFoldRunId(timelineEntries, activeFindMatch.entryId)
      : null;
  useEffect(() => {
    if (
      activeFindRunId === null ||
      !rows.some((row) => row.kind === "turn-fold" && row.runId === activeFindRunId)
    )
      return;
    setExpandedRunIds((existing) =>
      existing.has(activeFindRunId) ? existing : new Set([...existing, activeFindRunId]),
    );
  }, [activeFindRunId, rows]);
  const activeFindAttemptId =
    activeFindMatch && !selectedFindEntryIsVisible
      ? timelineEntries.find((entry) => entry.id === activeFindMatch.entryId)?.attempt?.id
      : undefined;
  useEffect(() => {
    if (
      !activeFindAttemptId ||
      !rows.some((row) => row.kind === "attempt-fold" && row.attemptId === activeFindAttemptId)
    )
      return;
    setExpandedAttemptIds((existing) =>
      existing.has(activeFindAttemptId) ? existing : new Set([...existing, activeFindAttemptId]),
    );
  }, [activeFindAttemptId, rows]);
  const openExcerptIds = useMemo(() => {
    const ids = new Set<string>();
    if (autoOpen !== "live-excerpts") return ids;
    for (const row of rawRows) {
      if (row.kind === "event") {
        if (row.projectedItem.item.type === "subagent") {
          for (const id of row.autoExpandedSubagentItemIds ?? []) ids.add(id);
        } else if (row.autoExpanded) {
          ids.add(row.id);
        }
        continue;
      }
      const entries = row.kind === "work" ? row.groupedEntries : [];
      for (const entry of entries) if (entry.autoExpanded) ids.add(entry.id);
    }
    return ids;
  }, [autoOpen, rawRows]);
  const liveExcerptIds = [...openExcerptIds].filter((id) => !excerptFold.settling.has(id));
  if (
    liveExcerptIds.length !== excerptFold.live.size ||
    liveExcerptIds.some((id) => !excerptFold.live.has(id))
  ) {
    const settled = [...excerptFold.live].filter((id) => !openExcerptIds.has(id));
    setExcerptFold({
      live: new Set(liveExcerptIds),
      settling:
        settled.length === 0
          ? excerptFold.settling
          : new Set([...excerptFold.settling, ...settled]),
    });
  }
  const excerptFoldTimersRef = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = excerptFoldTimersRef.current;
    for (const id of excerptFold.settling) {
      if (timers.has(id)) continue;
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id);
          setExcerptFold((current) => {
            const settling = new Set(current.settling);
            settling.delete(id);
            return { live: current.live, settling };
          });
        }, EXCERPT_FOLD_DELAY_MS),
      );
    }
  }, [excerptFold.settling]);
  useEffect(() => {
    const timers = excerptFoldTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const [rowMotionScope, setRowMotionScope] = useState(() => ({
    key: listIdentityKey,
    seenRowKeys: new Set<string>(),
    seenStepIds: new Set<string>(),
  }));
  const sameRowMotionScope = rowMotionScope.key === listIdentityKey;
  if (!sameRowMotionScope) {
    setRowMotionScope({
      key: listIdentityKey,
      seenRowKeys: new Set<string>(),
      seenStepIds: new Set<string>(),
    });
  }
  // A run that just ended still animates its fold into "Worked for…", but only
  // if its rows were on screen; a load that briefly reports a running turn
  // must not animate the history it settles into.
  const [turnWasInProgress, setTurnWasInProgress] = useState(activeTurnInProgress);
  const [turnSettling, setTurnSettling] = useState(false);
  if (turnWasInProgress !== activeTurnInProgress) {
    setTurnWasInProgress(activeTurnInProgress);
    setTurnSettling(!activeTurnInProgress && rowMotionScope.seenRowKeys.size > 0);
  }
  useEffect(() => {
    if (!turnSettling) return;
    const timer = setTimeout(() => setTurnSettling(false), MOTION_MS * 2);
    return () => clearTimeout(timer);
  }, [turnSettling]);
  const rowMotionLive =
    sameRowMotionScope && liveFollowEnabled && (activeTurnInProgress || turnSettling);
  const presentRows = usePresentList(rows, timelineRowKey, rowMotionLive);
  const exitingRowKeys = useMemo(() => {
    const keys = presentRows.filter((present) => present.exiting).map((present) => present.key);
    return keys.length === 0 ? NO_EXITING_ROWS : new Set(keys);
  }, [presentRows]);
  // Without exits the list data is `rows` itself, so identity checks against
  // the list's state keep meaning "the list has caught up with these rows".
  const timelineData = useMemo(
    () => (exitingRowKeys === NO_EXITING_ROWS ? rows : presentRows.map((present) => present.item)),
    [exitingRowKeys, presentRows, rows],
  );
  const rowMotion = useMemo<TimelineRowMotionState>(
    () => ({
      live: rowMotionLive,
      seenRowKeys: rowMotionScope.seenRowKeys,
      seenStepIds: rowMotionScope.seenStepIds,
      exitingRowKeys,
    }),
    [exitingRowKeys, rowMotionLive, rowMotionScope],
  );
  // The list virtualizes, so a row first mounted by scrolling back is history,
  // not an arrival: every key the data has held counts as seen. Arrivals open
  // from zero height, and older rows doing that made the list mount more rows
  // per layout pass until React gave up (#185). The working indicator is a
  // placeholder, not content the reader has seen: history that loads in behind
  // it must not count as arriving.
  useEffect(() => {
    for (const row of rows) {
      if (row.kind !== "working") rowMotionScope.seenRowKeys.add(timelineRowKey(row));
    }
  }, [rows, rowMotionScope]);
  // Run status/timestamps churn on every stream event; the shared row context
  // must not change with them or every timeline row re-renders per event.
  const runs = useStableHandoffRuns(runsProp);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const restoreRowIndex =
    restoringThreadPosition && rememberedPosition?.atEnd === false
      ? rows.findIndex((row) => row.id === rememberedPosition.rowId)
      : -1;
  const restoringAlwaysRender = useMemo(
    () =>
      restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined,
    [restoreRowIndex, restoringThreadPosition],
  );
  useLayoutEffect(() => {
    if (!restoringThreadPosition || rows.length === 0) return;
    const list = listRef.current;
    if (!list) return;
    if (citationRequest !== null) {
      setPositionedThreadKey(listIdentityKey);
      return;
    }
    let cancelled = false;
    let settleFrame: number | null = null;
    const viewport: HTMLElement | null = list.getScrollableNode();
    const cancelRestoration = () => {
      if (cancelled) return;
      cancelled = true;
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      // Supersede any pending estimated-index scroll before the browser applies the gesture.
      if (viewport) void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
      setPositionedThreadKey(listIdentityKey);
    };
    const cancelForNavigation = () => {
      cancelRestoration();
      onManualNavigation();
    };
    const onScrollKey = (event: globalThis.KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancelForNavigation();
    };
    viewport?.addEventListener("wheel", cancelForNavigation, { passive: true });
    viewport?.addEventListener("touchmove", cancelForNavigation, { passive: true });
    viewport?.addEventListener("pointerdown", cancelForNavigation, { passive: true });
    viewport?.ownerDocument.addEventListener("keydown", onScrollKey);
    const position = rememberedPosition;
    const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
    if (position?.atEnd === false) onManualNavigation();
    if (cancelPositionRestoreRef) cancelPositionRestoreRef.current = cancelRestoration;
    const scrolling =
      position?.atEnd === false
        ? index >= 0
          ? list.scrollToIndex({
              index,
              animated: false,
              viewPosition: 0,
              viewOffset: -position.offsetWithinRow,
            })
          : list.scrollToOffset({ offset: position.scrollOffset, animated: false })
        : list.scrollToEnd({ animated: false });
    void Promise.resolve(scrolling).then(() => {
      if (cancelled) return;
      if (position?.atEnd !== false || index < 0) {
        setPositionedThreadKey(listIdentityKey);
        return;
      }
      // Index scrolling starts from estimates. Keep the saved row mounted
      // until its measured position and the DOM agree for two layout frames.
      let stableFrames = 0;
      const reconcile = () => {
        if (cancelled) return;
        const state = list.getState();
        const row = state.elementAtIndex(index);
        const element = list.getScrollableNode();
        if (!row || !element) return;
        const offset = Math.max(
          0,
          Math.min(
            element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              position.offsetWithinRow,
            element.scrollHeight - element.clientHeight,
          ),
        );
        if (Math.abs(element.scrollTop - offset) > 1) {
          stableFrames = 0;
          void list.scrollToOffset({ offset, animated: false }).then(() => {
            if (!cancelled) settleFrame = requestAnimationFrame(reconcile);
          });
          return;
        }
        if (++stableFrames >= 2) {
          setPositionedThreadKey(listIdentityKey);
        } else {
          settleFrame = requestAnimationFrame(reconcile);
        }
      };
      settleFrame = requestAnimationFrame(reconcile);
    });
    return () => {
      cancelled = true;
      if (cancelPositionRestoreRef?.current === cancelRestoration) {
        cancelPositionRestoreRef.current = null;
      }
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      viewport?.removeEventListener("wheel", cancelForNavigation);
      viewport?.removeEventListener("touchmove", cancelForNavigation);
      viewport?.removeEventListener("pointerdown", cancelForNavigation);
      viewport?.ownerDocument.removeEventListener("keydown", onScrollKey);
    };
  }, [
    citationRequest,
    cancelPositionRestoreRef,
    listIdentityKey,
    listRef,
    onManualNavigation,
    rememberedPosition,
    restoringThreadPosition,
    rows,
  ]);

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  // Re-measure the minimap gutter when the chat column changes width without a viewport resize.
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const {
    target: readyCitationRequest,
    positioning: citationPositioning,
    onListLoad: onCitationListLoad,
    alwaysRender: citationAlwaysRender,
  } = useAssistantCitationTarget({
    request: citationRequest,
    entries: timelineEntries,
    rows,
    listRef,
    viewport: timelineViewportElement,
    historyLoading: citationHistoryLoading,
    loadEarlier,
    activityGroups,
    onLoadActivityPage,
    onExpandActivityGroup,
    onExpandTurn: expandCitedRun,
    onManualNavigation,
  });
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [fullscreenAppRowId, setFullscreenAppRowId] = useState<string | null>(null);
  // Only the row that holds the pin can release it.
  const onAppFullscreenChange = useCallback((rowId: string, fullscreen: boolean) => {
    setFullscreenAppRowId((current) => (fullscreen ? rowId : current === rowId ? null : current));
  }, []);
  // Every pin holds at once, so navigating to a citation or restoring a
  // position never drops a full-screen app's row. The app is pinned by key,
  // which stays right as earlier rows load in.
  const alwaysRender = useMemo(() => {
    const indices = restoringAlwaysRender?.indices ?? [];
    const keys = [
      ...(citationAlwaysRender?.keys ?? []),
      ...(fullscreenAppRowId === null ? [] : [fullscreenAppRowId]),
    ];
    if (indices.length === 0 && keys.length === 0) return undefined;
    return {
      ...(indices.length === 0 ? {} : { indices }),
      ...(keys.length === 0 ? {} : { keys }),
    };
  }, [citationAlwaysRender, restoringAlwaysRender, fullscreenAppRowId]);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const handleAnchorSizeChanged = useCallback(
    (size: number) => {
      if (anchorMessageId !== null) {
        onAnchorSizeChanged(anchorMessageId, size);
      }
    },
    [anchorMessageId, onAnchorSizeChanged],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(
      rows,
      anchorMessageId,
      (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
      { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
    );
    return config
      ? { ...config, onReady: handleAnchorReady, onSizeChanged: handleAnchorSizeChanged }
      : undefined;
  }, [anchorMessageId, handleAnchorReady, handleAnchorSizeChanged, rows]);
  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );
  const [endFooter, setEndFooter] = useState<HTMLDivElement | null>(null);
  const timelineListFooter = useMemo(
    () => (
      <TimelineListFooter
        composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment}
        footerRef={setEndFooter}
      >
        {footer}
        {unmatchedPendingApprovals.size > 0 ? (
          <WorkLogBlock>
            {[...unmatchedPendingApprovals.values()].map((approval) => (
              <TimelinePendingApprovalRow
                key={approval.requestId}
                approval={approval}
                canOperateThread={canOperateThread}
                isResponding={respondingRequestIds.includes(approval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            ))}
          </WorkLogBlock>
        ) : null}
      </TimelineListFooter>
    ),
    [
      anchoredEndSpace,
      canOperateThread,
      contentInsetEndAdjustment,
      footer,
      onRespondToApproval,
      respondingRequestIds,
      unmatchedPendingApprovals,
    ],
  );

  const measureContentOverflow = useCallback(
    () =>
      timelineContentOverflowsViewport(listRef.current?.getState?.(), {
        composerInset: contentInsetEndAdjustment,
        anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      }),
    [contentInsetEndAdjustment, listRef],
  );
  // LegendList lays rows out from layout effects, so a read on the next frame
  // sees the settled positions. One frame is shared across bursts of size
  // changes.
  const contentOverflowFrameRef = useRef<number | null>(null);
  const cancelContentOverflowFrame = useCallback(() => {
    if (contentOverflowFrameRef.current !== null) {
      cancelAnimationFrame(contentOverflowFrameRef.current);
      contentOverflowFrameRef.current = null;
    }
  }, []);
  const reportContentOverflow = useCallback(() => {
    if (!onContentOverflowChange || contentOverflowFrameRef.current !== null) return;
    contentOverflowFrameRef.current = requestAnimationFrame(() => {
      contentOverflowFrameRef.current = null;
      onContentOverflowChange(measureContentOverflow());
    });
  }, [measureContentOverflow, onContentOverflowChange]);
  useEffect(() => cancelContentOverflowFrame, [cancelContentOverflowFrame]);
  // The list's own layout effects have already run here, so estimated row
  // positions are in place. Reporting before the first paint lets a thread
  // open in its final composer layout instead of correcting it a frame later.
  // A frame scheduled with the previous inset would overwrite this read, so
  // it is dropped first.
  useLayoutEffect(() => {
    cancelContentOverflowFrame();
    onContentOverflowChange?.(measureContentOverflow());
  }, [cancelContentOverflowFrame, measureContentOverflow, onContentOverflowChange, rows.length]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== timelineData) return;
    const isAtEnd = resolveTimelineIsAtEnd(state);
    const position = state?.data?.length ? resolveWorkGroupScrollAnchor(state) : undefined;
    if (position && state && isAtEnd !== undefined) {
      const row = state.elementAtIndex(position.index);
      const element = listRef.current?.getScrollableNode();
      if (row && element) {
        rememberTimelinePosition(listIdentityKey, {
          rowId: position.rowId,
          // DOM geometry includes the header and the virtualizer's layout adjustment.
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: isAtEnd,
          disclosures: {
            runs: paintedExpandedRunIds,
            workGroups: paintedExpandedWorkGroupIds,
            activityGroups: paintedExpandedActivityGroupKeys,
            attempts: paintedExpandedAttemptIds,
            workGroupState: workGroupViewState,
          },
        });
      }
    }
    if (isAtEnd !== undefined && !citationPositioning) {
      onIsAtEndChange(isAtEnd);
    }
    reportContentOverflow();
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    const itemBounds = minimapItems.map((item) => ({
      top: resolveTimelineRowTop(state, item.rowIndex),
      height: resolveTimelineRowHeight(state, item.rowIndex),
    }));

    for (const [index, item] of minimapItems.entries()) {
      const strip = minimapStripMap.get(item.id);
      const bounds = itemBounds[index];
      const rowTop = bounds?.top ?? null;
      const rowHeight = bounds?.height ?? null;
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      // Skip no-op attribute writes: this runs for every strip on every scroll
      // tick, and rewriting an unchanged attribute still dirties style state.
      const next = inView ? "true" : "false";
      if (strip && strip.dataset.inView !== next) {
        strip.dataset.inView = next;
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      scrollTop,
      scrollBottom,
      itemBounds,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  }, [
    citationPositioning,
    paintedExpandedRunIds,
    paintedExpandedWorkGroupIds,
    paintedExpandedAttemptIds,
    paintedExpandedActivityGroupKeys,
    workGroupViewState,
    timelineData,
    listIdentityKey,
    restoringThreadPosition,
    listRef,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    reportContentOverflow,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      // Without a mounted row, treat the column as full width so the strip stays inert.
      const contentWidth =
        timelineViewportElement
          .querySelector<HTMLElement>("[data-timeline-root]")
          ?.getBoundingClientRect().width ?? viewportWidth;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
        viewportWidth,
        contentWidth,
      );
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth));
      reportContentOverflow();
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length, reportContentOverflow, chatWidth]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      citationRequest: readyCitationRequest,
      listRef,
      timestampFormat,
      routeThreadKey,
      // Keep Markdown callbacks memoized during unrelated activity updates.
      threadRef: citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      findActive,
      providerStatuses,
      runs,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      onRunShellCommand,
      onImageExpand,
      onFileOpen,
      onUseArtifactTemplate,
      onSendAppMessage,
      onAppFullscreenChange,
      onFileDownload,
      openPullRequest,
      onOpenTurnDiff,
      onOpenThread,
      onForkFromRun,
      onRollbackCheckpoint,
      onToggleTurnFold,
      onLoadActivityPage,
      onToggleAttemptFold,
      onToggleWorkGroup,
      onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
      onOpenNativeTerminal,
      onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
      retryableWorkspacePreparationRunIds,
      onRetryWorkspacePreparation: onRetryWorkspacePreparation ?? null,
      onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
      onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
      workGroupViewState,
      pendingApprovals: pendingApprovalsByRequestId,
      respondingRequestIds,
      canOperateThread,
      onRespondToApproval,
    }),
    [
      readyCitationRequest,
      listRef,
      timestampFormat,
      routeThreadKey,
      citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      providerStatuses,
      runs,
      findActive,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      onRunShellCommand,
      onImageExpand,
      onFileOpen,
      onUseArtifactTemplate,
      onSendAppMessage,
      onAppFullscreenChange,
      onFileDownload,
      openPullRequest,
      onOpenTurnDiff,
      onOpenThread,
      onForkFromRun,
      onRollbackCheckpoint,
      onToggleTurnFold,
      onLoadActivityPage,
      onToggleAttemptFold,
      onToggleWorkGroup,
      suspendEndScrollMaintenanceForDisclosure,
      onOpenNativeTerminal,
      onCancelWorktreeSetup,
      retryableWorkspacePreparationRunIds,
      onRetryWorkspacePreparation,
      onWorktreeSetupWorkLocally,
      onOpenWorktreeSetupTerminal,
      workGroupViewState,
      pendingApprovalsByRequestId,
      respondingRequestIds,
      canOperateThread,
      onRespondToApproval,
    ],
  );
  const compactionAwaitingRow =
    isCompacting && !rows.some((row) => row.kind === "context-compaction" && row.active);
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestRun?.startedAt != null
      ? worktreeSetup
      : null;
  const supersededThoughtId = useMemo(() => {
    const liveWorkRow = rows.findLast((row) => row.kind === "work-live");
    if (liveWorkRow?.kind !== "work-live" || liveWorkRow.thought === undefined) return null;
    const latestThoughtIndex = liveWorkRow.groupedEntries.findLastIndex(
      (entry) => entry.itemType === "reasoning",
    );
    const latestToolIndex = liveWorkRow.groupedEntries.findLastIndex(
      (entry) => entry.itemType !== "reasoning",
    );
    return latestToolIndex > latestThoughtIndex ? liveWorkRow.thought.id : null;
  }, [rows]);
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isCompacting: compactionAwaitingRow,
      isRevertingCheckpoint,
      backgroundWorktreeSetup,
      activeTurnInProgress,
      awaitingUser,
      isPreparingWorktree,
      latestRunId: latestRun?.runId ?? null,
      supersededThoughtId,
    }),
    [
      awaitingUser,
      compactionAwaitingRow,
      backgroundWorktreeSetup,
      activeTurnInProgress,
      isPreparingWorktree,
      isRevertingCheckpoint,
      isWorking,
      latestRun?.runId,
      supersededThoughtId,
    ],
  );
  const listHeader = useMemo(() => {
    const leadingContent = topFadeEnabled ? TIMELINE_LIST_FADE_HEADER : TIMELINE_LIST_HEADER;
    return (
      <>
        {leadingContent}
        {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
      </>
    );
  }, [historyControls, topFadeEnabled]);

  const canvas = useChatCanvas();
  const registerTimeline = canvas?.registerTimeline;
  const [timelineScroller, setTimelineScroller] = useState<HTMLElement | null>(null);
  const timelineEntryIds = useMemo(
    () => new Set(timelineEntries.map((entry) => entry.id)),
    [timelineEntries],
  );
  const readVisibleFindPosition = useCallback(
    (query: string) =>
      timelineScroller
        ? readThreadFindPosition(
            timelineScroller,
            query,
            (rowId) => (timelineEntryIds.has(rowId) ? rowId : undefined),
            contentInsetEndAdjustment,
          )
        : undefined,
    [contentInsetEndAdjustment, timelineEntryIds, timelineScroller],
  );
  useLayoutEffect(() => {
    if (!findPositionReaderRef) return;
    findPositionReaderRef.current = readVisibleFindPosition;
    return () => {
      if (findPositionReaderRef.current === readVisibleFindPosition) {
        findPositionReaderRef.current = null;
      }
    };
  }, [findPositionReaderRef, readVisibleFindPosition]);
  useThreadFindNavigation({
    container: timelineScroller,
    query: normalizedFindQuery,
    match: activeFindMatch,
    navigationId: findNavigationId,
    rowIndex:
      activeFindMatch === null
        ? -1
        : timelineData.findIndex((row) => row.id === activeFindMatch.entryId),
    entries: timelineEntries,
    listRef,
    contentInsetEndAdjustment,
    listReady: timelineScroller !== null && !restoringThreadPosition,
    historyControls,
    activityGroups,
    onLoadActivityPage,
    onExpandActivityGroup,
  });
  const setTimelineList = useCallback(
    (list: LegendListRef | null) => {
      listRef.current = list;
      const scroller = list?.getScrollableNode() ?? null;
      registerTimeline?.(scroller);
      setTimelineScroller(scroller);
    },
    [listRef, registerTimeline],
  );

  // One owner for the live end (see useEndFollow). LegendList's own
  // maintainScrollAtEnd stays off: it scrolls from a frame callback against
  // its estimated content size, so two writers disagreed for a frame. Keeping
  // visible content in place is off while following too: the end pin owns
  // the offset there, and its anchor lock defers row positions a frame. It
  // shares the list's gate, so anchored turns, citations, restores, and
  // full-screen apps hold.
  const followsEnd = !(
    citationPositioning ||
    (restoringThreadPosition && rememberedPosition?.atEnd === false) ||
    anchoredEndSpace ||
    !liveFollowEnabled ||
    fullscreenAppRowId !== null ||
    disclosureToggleSettling
  );
  const { attachedRef: endAttachedRef, settle: settleEnd } = useEndFollow({
    scroller: timelineScroller,
    footer: endFooter,
    follows: followsEnd,
    live: isWorking,
  });
  useEffect(() => {
    endAttachedRef.current = rememberedPosition?.atEnd !== false;
  }, [endAttachedRef, rememberedPosition]);
  // A new row the list estimated exactly reports no size change; a turn
  // ending releases its slack even when no row changes.
  useLayoutEffect(() => {
    settleEnd();
  }, [settleEnd, timelineData, isWorking]);
  const handleItemSizeChanged = useCallback(() => {
    reportContentOverflow();
    settleEnd();
  }, [reportContentOverflow, settleEnd]);

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => <TimelineRowFrame row={item} />,
    [],
  );

  if (
    rows.length === 0 &&
    unmatchedPendingApprovals.size === 0 &&
    !isWorking &&
    parentThreadLink === null &&
    historyControls === undefined &&
    // A status line (settled, snoozed) still needs the list, whose footer renders it.
    footer === null
  ) {
    if (hideEmptyPlaceholder) {
      // Occupy the pane with the theme surface so a thread switch cannot
      // punch a hole through to the window chrome (white in light mode).
      return <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />;
    }
    return (
      <div className="flex h-full items-center justify-center" data-t3-surface="timeline-status">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TranscriptStyleCtx value={transcriptStyle}>
      <TimelineRowCtx value={sharedState}>
        <TimelineRowActivityCtx value={activityState}>
          <TimelineRowMotionCtx value={rowMotion}>
            <div
              className="km-transcript relative h-full min-h-0"
              data-transcript-style={transcriptStyle}
            >
              <TooltipScrollDismissArea
                ref={setTimelineViewportElement}
                className="relative h-full min-h-0"
                data-t3-surface="timeline"
                data-assistant-citation-viewport="true"
              >
                {onCiteAssistantText && citationThreadRef ? (
                  <AssistantSelectionToolbar
                    viewport={timelineViewportElement}
                    threadRef={citationThreadRef}
                    onCite={onCiteAssistantText}
                  />
                ) : null}
                <LegendList<MessagesTimelineRow>
                  ref={setTimelineList}
                  data={timelineData}
                  extraData={`${listIdentityKey}:${timelineData.length}`}
                  keyExtractor={timelineRowKey}
                  getItemType={getItemType}
                  renderItem={renderItem}
                  estimatedItemSize={90}
                  initialScrollAtEnd={
                    citationRequest === null && rememberedPosition?.atEnd !== false
                  }
                  // Legend needs a data refresh to mount new pins without a scroll event.
                  dataVersion={readyCitationRequest?.key ?? listIdentityKey}
                  {...(alwaysRender ? { alwaysRender } : {})}
                  onLoad={onCitationListLoad}
                  {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                  contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
                  maintainVisibleContentPosition={
                    followsEnd ||
                    citationPositioning ||
                    (restoringThreadPosition && rememberedPosition?.atEnd === false)
                      ? false
                      : maintainVisibleContentPosition
                  }
                  onScroll={handleScroll}
                  onItemSizeChanged={handleItemSizeChanged}
                  className={cn(
                    "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
                    topFadeEnabled && "topbar-scroll-fade",
                  )}
                  ListHeaderComponent={listHeader}
                  ListFooterComponent={timelineListFooter}
                />
                {subagentSourceThreadIds.map((threadId) => (
                  <TimelineSubagentLifecycleObserver
                    key={threadId}
                    environmentId={activeThreadEnvironmentId}
                    threadId={threadId}
                    onChange={onSubagentSourceChange}
                  />
                ))}
                <TimelineMinimap
                  items={minimapItems}
                  hasPersistentGutter={minimapHasPersistentGutter}
                  hitStripWidth={minimapHitStripWidth}
                  currentIndex={minimapCurrentIndex}
                  stripMap={minimapStripMap}
                  onSelect={(item) => {
                    onManualNavigation();
                    void listRef.current?.scrollToIndex({
                      index: item.rowIndex,
                      animated: true,
                      viewOffset: 24,
                    });
                  }}
                />
              </TooltipScrollDismissArea>
            </div>
          </TimelineRowMotionCtx>
        </TimelineRowActivityCtx>
      </TimelineRowCtx>
    </TranscriptStyleCtx>
  );
});

function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier turns"
            onClick={() => props.onLoadEarlier()}
            className="w-full py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default"
          >
            {props.loading ? "Loading earlier turns…" : "Load earlier turns"}
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function getItemType(item: MessagesTimelineRow) {
  // An activity header changes kind as it settles; one type keeps its slot.
  if (item.activityAnchorId !== undefined) return "activity";
  if (item.kind !== "message") return item.kind;
  const textLengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${textLengthBucket}`;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  items,
  stripMap,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  currentIndex: number | null;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = useMemo(
    () =>
      resolveTimelineMinimapPreview(
        resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null),
      ),
    [items, resolvedActiveIndex],
  );
  const navigationInteractive = resolveTimelineMinimapNavigationInteractive(hitStripWidth);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert.
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={updateActiveIndexFromPointer}
            onMouseDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              event.preventDefault();
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((item, index) => {
              const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
              const activeDistance =
                resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
              return (
                // Compositor-friendly on purpose: in-view state and the hover
                // fisheye animate constantly (every scroll tick and streaming
                // update flips a band of strips), so the strip animates only
                // transform and opacity. Width tiers are a scale-x on a fixed
                // w-6 box, and the in-view highlight is an opacity-faded bright
                // overlay — never background-color or width, which would force
                // main-thread style/layout/paint at 60fps for each transition.
                <span
                  aria-hidden="true"
                  className={cn(
                    "group/strip pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150",
                    activeDistance === 0 ? "bg-muted-foreground/75" : "bg-muted-foreground/35",
                    activeDistance === 0
                      ? "scale-x-100"
                      : activeDistance === 1
                        ? "scale-x-[0.667]"
                        : activeDistance === 2
                          ? "scale-x-[0.417]"
                          : "scale-x-[0.333]",
                  )}
                  data-in-view="false"
                  data-minimap-strip
                  key={item.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(item.id, node);
                    } else {
                      stripMap.delete(item.id);
                    }
                  }}
                  style={{ top }}
                >
                  <span className="absolute inset-0 rounded-full bg-foreground/90 opacity-0 transition-opacity duration-150 group-data-[in-view=true]/strip:opacity-100" />
                </span>
              );
            })}
            {activeItem ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {activeItem.userText ?? "User message"}
                  </span>
                  {activeItem.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

/**
 * One virtualized slot. While the reader follows live work, every size change
 * glides: arrivals, exits, an excerpt folding or opening, a group reshaping.
 * A jump at rest would move every row below it in one frame. The live row
 * streaming its latest lines keeps native height, so those lines are never
 * clipped; the end follow glides the view after it.
 */
const TimelineRowFrame = memo(function TimelineRowFrame({ row }: { row: TimelineRow }) {
  const { live, seenRowKeys, exitingRowKeys } = use(TimelineRowMotionCtx);
  const rowKey = timelineRowKey(row);
  // The sender's own message anchors a new turn's scroll position; it never glides.
  const scrollAnchor = row.kind === "message" && row.message.role === "user";
  const [arrived] = useState(
    () => live && !scrollAnchor && seenRowKeys.size > 0 && !seenRowKeys.has(rowKey),
  );
  // The sender's own prompt does not glide, but the minimal style still eases it in.
  const [sent] = useState(
    () => live && scrollAnchor && seenRowKeys.size > 0 && !seenRowKeys.has(rowKey),
  );
  const exiting = exitingRowKeys.has(rowKey);
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLDivElement>(
    !live || scrollAnchor || (row.kind === "work-live" && !exiting),
    { collapsed: exiting },
  );

  return (
    <div
      ref={outerRef}
      className="messages-timeline-row-frame"
      data-arriving={arrived || undefined}
      data-sent={sent || undefined}
      data-exiting={exiting || undefined}
    >
      <div
        ref={contentRef}
        className="chat-content-lane overflow-x-clip"
        data-timeline-root="true"
        data-t3-surface="timeline"
      >
        <TimelineRowArrivedCtx value={arrived}>
          <TimelineRowContent row={row} />
        </TimelineRowArrivedCtx>
      </div>
    </div>
  );
});

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isSubagentGroup = row.kind === "event" && row.projectedItem.item.type === "subagent";
  const isWorkLogRow =
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "todo-update";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live") && row.expanded === true;
  const workGroup = row.kind === "work" ? row : null;
  const terminalThoughtEntry =
    isTerminal &&
    row.kind === "work-live" &&
    (!row.expanded ||
      (row.groupedEntries.length === 1 && row.groupedEntries[0]?.itemType === "reasoning"))
      ? row.thought
      : isTerminal &&
          workGroup !== null &&
          !workGroup.isExpandedToolGroup &&
          workGroup.groupedEntries.length === 1 &&
          workGroup.groupedEntries[0]?.itemType === "reasoning"
        ? workGroup.groupedEntries[0]
        : undefined;
  const terminalThoughtBody =
    terminalThoughtEntry === undefined ? null : (
      <section aria-label="Activity" data-t3-part="timeline-tool-call">
        <div data-terminal-thinking-trace="true">
          <ReasoningTraceContent entries={[terminalThoughtEntry]} />
        </div>
      </section>
    );
  const workSectionContent =
    terminalThoughtBody ??
    (workGroup === null ? null : (
      <WorkGroupSection
        anchorKey={row.activityAnchorId ?? row.id}
        groupedEntries={workGroup.groupedEntries}
        isExpandedToolGroup={workGroup.isExpandedToolGroup}
        displayLabel={workGroup.displayLabel}
      />
    ));

  return (
    <div
      className={cn(
        "km-transcript-row",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      // Spacing lives in transcript.css: rapid work packs tight, a run's last
      // row leaves a block gap, and subagent cards get room of their own. A
      // fold sits right on what follows; commentary (no metadata row) and
      // inline events sit close to the work after them.
      data-work-log={isWorkLogRow ? (row.continuesWorkLog ? "continues" : "end") : undefined}
      data-subagent-group={isSubagentGroup ? "true" : undefined}
      data-row-gap={
        row.kind === "turn-fold" || row.kind === "working"
          ? "tight"
          : (row.kind === "message" &&
                row.message.role === "assistant" &&
                !row.showAssistantMeta) ||
              (row.kind === "event" && !isSubagentGroup) ||
              row.kind === "worktree-setup" ||
              row.kind === "attempt-fold" ||
              row.kind === "html-render" ||
              row.kind === "aperture-embed" ||
              row.kind === "mcp-app"
            ? "close"
            : undefined
      }
      data-open-group-header={isExpandedToolGroupHeader ? "true" : undefined}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
      data-t3-part="timeline-message"
      data-streaming={row.kind === "message" && row.message.streaming === true ? "true" : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {workSectionContent}
          {row.kind === "work-live" ? (
            <LiveWorkEntryTimelineRow
              row={row}
              terminalThoughtIsStable={terminalThoughtEntry !== undefined}
            />
          ) : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "todo-update" ? <TodoUpdateTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "activity-page-boundary" ? <ActivityPageBoundaryTimelineRow row={row} /> : null}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "html-render" ? <HtmlRenderTimelineRow row={row} /> : null}
      {row.kind === "aperture-embed" ? <ApertureEmbedTimelineRow row={row} /> : null}
      {row.kind === "mcp-app" ? <McpAppTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
});

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = useMemo(
    () => (openTerminal && terminalId ? () => openTerminal(terminalId) : null),
    [openTerminal, terminalId],
  );
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  return (
    <div
      role="separator"
      aria-label={row.label}
      className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-muted-foreground text-xs"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span
        ref={row.active ? observeVisibleAnimation : undefined}
        className="relative shrink-0 overflow-hidden"
      >
        <span className="flex items-center gap-1.5">
          <Minimize2Icon aria-hidden="true" className="size-3" />
          {row.label}
        </span>
        {row.active ? (
          <ActivityShimmerOverlay>
            <span className="flex items-center gap-1.5">
              <Minimize2Icon aria-hidden="true" className="size-3" />
              {row.label}
            </span>
          </ActivityShimmerOverlay>
        ) : null}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

const TODO_CHANGE_VERB: Record<TodoPlanChange["kind"], string> = {
  planned: "Planned",
  added: "Added",
  completed: "Checked off",
  dropped: "Dropped",
  blocked: "Blocked",
};

const TODO_CHANGE_TONE: Record<TodoPlanChange["kind"], string | null> = {
  planned: null,
  added: null,
  completed: null,
  dropped: "status-failed-mark",
  blocked: "status-blocked-mark",
};

/**
 * One line per thing a todo update changed. A live update rises in still
 * open, then lands once its entrance is done: the ring swaps to its mark,
 * checked-off text is struck through, and a dropped or blocked task eases into
 * the failure or warning tone, as in the plan under the prompt.
 */
function TodoUpdateTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "todo-update" }> }) {
  const ctx = use(TimelineRowCtx);
  const { seenStepIds } = use(TimelineRowMotionCtx);
  const [arriving] = useState(() => row.live && !seenStepIds.has(row.id));
  const [landed, setLanded] = useState(!arriving);
  useEffect(() => {
    seenStepIds.add(row.id);
    if (landed) return;
    const timer = window.setTimeout(() => setLanded(true), MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [landed, row.id, seenStepIds]);
  return row.changes.map((change, index) => {
    const marked =
      change.kind === "completed" || change.kind === "dropped" || change.kind === "blocked";
    // The tone settles in on landing: `motion-tint` and `motion-strike` ease the colour.
    const tone = landed ? TODO_CHANGE_TONE[change.kind] : null;
    return (
      <WorkLogRow
        // Changes never reorder within one update.
        key={index}
        data-t3-part="timeline-tool-call"
        icon={
          <span
            key={landed ? "landed" : "open"}
            className={cn("flex", arriving && landed && marked && "motion-swap", tone)}
          >
            {!marked ? (
              <ListTodoIcon className="size-4" />
            ) : !landed ? (
              <CircleIcon className="size-4" />
            ) : change.kind === "completed" ? (
              <svg viewBox="0 0 16 16" className="check-mark size-4">
                <circle cx="8" cy="8" r="7" />
                <path d="m5.2 8.3 1.9 1.9 3.7-3.9" />
              </svg>
            ) : change.kind === "dropped" ? (
              <CircleXIcon className="size-4" />
            ) : (
              <CircleSlashIcon className="size-4" />
            )}
          </span>
        }
        label={
          <span className="tool-heading flex min-w-0 items-baseline gap-1.5">
            <span
              className={cn("motion-tint shrink-0 font-medium", tone ?? "text-foreground/90")}
              data-tool-verb="true"
            >
              {TODO_CHANGE_VERB[change.kind]}
            </span>
            <span data-tool-object="true" className="min-w-0 truncate text-muted-foreground">
              <span
                className={cn("motion-strike", tone)}
                data-struck={landed && change.kind === "completed" ? "" : undefined}
              >
                {change.kind === "planned"
                  ? `${change.count} ${change.count === 1 ? "to-do" : "to-dos"}`
                  : change.content}
              </span>
              {change.kind === "blocked" && change.blocker !== undefined ? (
                <span> · {change.blocker}</span>
              ) : null}
            </span>
          </span>
        }
        trailing={
          index === 0 ? (
            <TimelineRowTimestamp createdAt={row.createdAt} timestampFormat={ctx.timestampFormat} />
          ) : undefined
        }
      />
    );
  });
}

function UserVideoAttachment({ file }: { readonly file: ChatFileAttachment }) {
  const ctx = use(TimelineRowCtx);
  const asset = useMemo(
    () =>
      file.downloadable === false
        ? null
        : buildAttachmentVideoAsset(ctx.activeThreadEnvironmentId, file),
    [ctx.activeThreadEnvironmentId, file.downloadable, file.id, file.mimeType, file.name],
  );
  const resource = asset?.resource ?? null;
  const assetUrl = useAssetUrlState(ctx.activeThreadEnvironmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(ctx.activeThreadEnvironmentId, resource);
  const src = assetUrl._tag === "Success" ? assetUrl.url : (file.previewUrl ?? null);

  if (asset === null && src === null) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border/80 bg-black px-2 py-3 text-center text-2xs text-white/70">
        {file.name}
      </div>
    );
  }

  return (
    <MediaVideoPlayer
      src={src}
      sourceFailed={
        file.previewUrl === undefined && resource !== null && assetUrl._tag === "Failure"
      }
      label={file.name}
      preload="visible"
      onOpen={() => {
        const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
        if (preview) ctx.onImageExpand(preview);
      }}
      className="block aspect-[4/3] w-full"
      videoClassName="aspect-auto size-full rounded-lg border border-border/80"
      stateClassName="aspect-auto min-h-full rounded-lg border border-border/80 bg-black text-white"
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
  );
}

// Drawn inside the media so dark screenshots keep an edge on the dark background.
const MEDIA_EDGE_CLASS_NAME =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12";

// Screen readers skim a transcript by heading, so every message announces its
// author as one. The thread title in ChatHeader is an <h2>; headings written
// inside a message are exposed below this level. Visually hidden and excluded
// from selection so sighted users and copied text are unaffected.
const MESSAGE_HEADING_LEVEL = 3;

function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const { onImageExpand, onFileOpen } = ctx;
  const senderThreadId = row.message.senderThreadId;
  const resources = useMemo(
    () => selectMessageImageResources(row.message.attachments),
    [row.message.attachments],
  );
  const previewUrls = useAssetUrls(ctx.activeThreadEnvironmentId, resources);
  const [projectPreviews] = useState(createMessageAttachmentPreviewProjector);
  const messageWithPreviews = useMemo(() => {
    const urlsById = new Map(
      resources.flatMap((resource, index) => {
        const url = previewUrls[index];
        return url ? [[resource.attachmentId, url] as const] : [];
      }),
    );
    return projectPreviews(row.message, (attachment) => urlsById.get(attachment.id));
  }, [previewUrls, projectPreviews, resources, row.message]);
  // The attachment union has an open member, so guards (not literal type
  // comparisons) split it. Unknown types render as inert rows below the files.
  const userImages = useMemo(
    () => (messageWithPreviews.attachments ?? []).filter(isImageAttachment),
    [messageWithPreviews.attachments],
  );
  const userFiles = useMemo(
    () => (row.message.attachments ?? []).filter(isFileAttachment),
    [row.message.attachments],
  );
  const userVideos = userFiles.filter(isVideoAttachment);
  const otherUserFiles = userFiles.filter((file) => !isVideoAttachment(file));
  const unknownAttachments = (row.message.attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );
  const userMessage = resolveUserMessagePresentation(row.message);
  const resolvedContext = useMemo(
    () => resolveUserMessageContext({ ...row.message, text: userMessage.text }),
    [row.message, userMessage.text],
  );
  const isAgentMessage =
    row.message.createdBy === "agent" &&
    row.message.creationSource !== "server" &&
    !userMessage.isAutomation;
  const folded = userMessage.isAutomation || isAgentMessage;
  const [expanded, setExpanded] = useState(false);
  const senderShell = useThreadShell(
    isAgentMessage && senderThreadId
      ? scopeThreadRef(ctx.activeThreadEnvironmentId, senderThreadId)
      : null,
  );
  const automationTasksQuery = useEnvironmentQuery(
    userMessage.isAutomation && userMessage.scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({
          environmentId: ctx.activeThreadEnvironmentId,
          input: {},
        })
      : null,
  );
  const automationTitle = automationTasksQuery.data?.tasks
    .find((task) => task.id === userMessage.scheduledTaskId)
    ?.title.trim();
  const senderLabel = userMessage.isAutomation
    ? automationTitle || "Automation"
    : (threadReadTargetTitle(senderShell) ?? "Agent");
  const plainText = replaceComposerContextReferences(
    resolvedContext.text,
    (reference) => reference.label,
  );
  const foldSummary =
    plainText
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const previewImages = useMemo(
    () => userImages.filter((image) => image.name.startsWith("preview-annotation-")),
    [userImages],
  );
  const revertTurnCount = row.revertTurnCount;
  // A file with a chip in the prose needs no standalone row. Media is the exception: the
  // thumbnail is the only way to actually see it, so it shows whether or not it has a chip.
  const chippedAttachmentIds = new Set(
    collectComposerContextReferences(resolvedContext.text).flatMap((occurrence) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(occurrence.contextId));
      return record?.kind === "file" || record?.kind === "image" ? [record.attachmentId] : [];
    }),
  );
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const unchippedFiles = otherUserFiles.filter((file) => !chippedAttachmentIds.has(file.id));
  // Images and videos sent without words are shown without an empty message bubble.
  const mediaOnly =
    !folded &&
    resolvedContext.text.trim() === "" &&
    unchippedFiles.length === 0 &&
    unknownAttachments.length === 0 &&
    regularImages.length + userVideos.length > 0;
  // A lone image keeps its own shape; a 4:3 crop hides most of a wide screenshot.
  const loneImage =
    mediaOnly &&
    userVideos.length === 0 &&
    regularImages.length === 1 &&
    regularImages[0]!.source?.kind !== "snap-shot";
  // Several images sent without words share one rounded shape, split by hairlines.
  const collage =
    mediaOnly &&
    userVideos.length === 0 &&
    regularImages.length > 1 &&
    regularImages.every((image) => image.source?.kind !== "snap-shot");
  const annotationRecordIds = useMemo(
    () =>
      resolvedContext.records
        .filter((record) => record.kind === "preview-annotation")
        .map((record) => record.contextId),
    [resolvedContext.records],
  );
  const contextClipboardFragment =
    resolvedContext.records.length === 0
      ? null
      : encodeComposerContextFragment({
          version: 1,
          source: {
            environmentId: ctx.activeThreadEnvironmentId,
            ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
            messageId: row.message.id,
          },
          records: resolvedContext.records,
        });
  // Chips inside the selection copy as their links (data-markdown-copy); the structured
  // fragment rides beside so a paste into a draft brings the payloads along. Only records
  // for chips that are actually inside the selection travel, so copying prose next to an
  // image never starts importing that image somewhere else.
  const onBodyCopyCapture = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (resolvedContext.records.length === 0 || !event.clipboardData) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const copiedMarkdown: string[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const container = document.createElement("div");
      container.appendChild(selection.getRangeAt(index).cloneContents());
      for (const element of container.querySelectorAll("[data-markdown-copy]")) {
        copiedMarkdown.push(element.getAttribute("data-markdown-copy") ?? "");
      }
    }
    const fragment = selectedMessageContextFragment({
      markdown: copiedMarkdown.join("\n"),
      records: resolvedContext.records,
      environmentId: ctx.activeThreadEnvironmentId,
      ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
      messageId: row.message.id,
    });
    if (!fragment) return;
    // Claim the copy: without preventDefault the browser default overwrites the
    // custom MIME type. The default content must then be written back explicitly.
    const payload = chatMarkdownClipboardPayload(selection);
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload?.text ?? selection.toString());
    if (payload) {
      event.clipboardData.setData(
        "text/html",
        encodeComposerContextClipboardHtml(payload.text, fragment, payload.html),
      );
    }
    event.clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
  };
  const renderContextReference = useCallback(
    (reference: ChatMarkdownContextReference) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(reference.contextId));
      // Structured annotations point at the image record, which in turn points at the persisted
      // attachment. Filename and order are compatibility fallbacks for legacy messages only.
      const annotationImage =
        record?.kind === "preview-annotation"
          ? resolvePreviewAnnotationImage({
              record,
              recordsById: resolvedContext.recordsById,
              userImages,
              previewImages,
              annotationRecordIds,
            })
          : null;
      const attachment =
        record?.kind === "image"
          ? (userImages.find((image) => image.id === record.attachmentId) ?? null)
          : record?.kind === "file"
            ? (userFiles.find((file) => file.id === record.attachmentId) ?? null)
            : null;
      return (
        <UserMessageContextReferenceChip
          reference={reference}
          record={record}
          annotationImage={annotationImage}
          attachment={attachment}
          onExpandImage={(image) => {
            const preview = buildExpandedImagePreview(userImages, image.id);
            if (preview) onImageExpand(preview);
          }}
          onOpenFile={onFileOpen}
          onExpandVideo={(file) => {
            const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
            if (preview) onImageExpand(preview);
          }}
        />
      );
    },
    [
      resolvedContext.recordsById,
      userImages,
      userFiles,
      previewImages,
      annotationRecordIds,
      onImageExpand,
      onFileOpen,
      ctx.activeThreadEnvironmentId,
    ],
  );

  return (
    <div
      className={cn("group flex flex-col gap-1", folded ? "items-start" : "items-end")}
      data-terminal-user-block={isTerminal ? "true" : undefined}
      data-user-message-attribution={
        folded ? (userMessage.isAutomation ? "automation" : "agent") : undefined
      }
      data-user-message-folded={
        folded ? (userMessage.isAutomation ? "automation" : "agent") : undefined
      }
    >
      {folded ? (
        <button
          type="button"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          data-user-message-folded-header="true"
          data-terminal-user-folded-header={isTerminal ? "true" : undefined}
          onClick={() => setExpanded((value) => !value)}
          className="user-message-folded-header flex w-full min-w-0 items-center gap-2 border-0 bg-transparent px-0 py-1 text-left text-sm text-muted-foreground hover:bg-transparent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span
            className="user-message-folded-icon flex size-4 shrink-0 items-center text-muted-foreground"
            aria-hidden="true"
          >
            {userMessage.isAutomation ? (
              <CalendarClockIcon className="size-3.5" />
            ) : (
              <MessagesSquareIcon className="size-3.5" />
            )}
          </span>
          <span className="user-message-folded-label min-w-0 max-w-[36%] shrink truncate text-muted-foreground">
            {senderLabel}
          </span>
          <span
            className="user-message-folded-separator shrink-0 text-muted-foreground/60"
            aria-hidden="true"
          >
            ·
          </span>
          <span className="user-message-folded-summary min-w-0 flex-1 truncate text-muted-foreground">
            {foldSummary}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "user-message-folded-chevron size-3.5 shrink-0 text-muted-foreground",
              expanded && "rotate-180",
            )}
          />
        </button>
      ) : null}
      {row.message.inputIntent && row.message.inputIntent !== "turn_start" ? (
        <UserMessageIntentMarker intent={row.message.inputIntent} />
      ) : null}
      {!folded || expanded ? (
        <>
          {/* The turn's to-dos dock under the prompt; the column keeps both one width. */}
          <div
            className="flex max-w-[80%] flex-col"
            data-terminal-user-content={isTerminal ? "true" : undefined}
          >
            <div
              className={cn(
                "relative w-full rounded-2xl",
                !mediaOnly && "bg-message p-3",
                "text-message-foreground",
                folded && "max-h-96 overflow-auto",
              )}
            >
              {isTerminal ? null : <MessageAuthorHeading>You</MessageAuthorHeading>}
              {(regularImages.length > 0 || userVideos.length > 0) && (
                <div
                  className={cn(
                    "grid",
                    !mediaOnly
                      ? "mb-2 max-w-[210px] grid-cols-2 gap-2"
                      : loneImage
                        ? "max-w-full"
                        : collage
                          ? cn(
                              MEDIA_EDGE_CLASS_NAME,
                              "w-80 max-w-full gap-px overflow-hidden rounded-2xl bg-black/9 dark:bg-white/12",
                              regularImages.length === 2
                                ? "auto-rows-[12rem] grid-cols-2"
                                : regularImages.length === 3
                                  ? "auto-rows-[calc(6rem-0.5px)] grid-cols-[3fr_2fr]"
                                  : "auto-rows-[6rem] grid-cols-2",
                            )
                          : "w-80 max-w-full grid-cols-2 gap-2",
                  )}
                >
                  {regularImages.map((image, index) => (
                    <div
                      key={image.id}
                      className={cn(
                        "bg-background/70",
                        image.source?.kind === "snap-shot" && image.previewUrl
                          ? cn(SNAP_SHOT_ATTACHMENT_FRAME_CLASS, "col-span-2")
                          : loneImage
                            ? cn(MEDIA_EDGE_CLASS_NAME, "overflow-hidden rounded-2xl")
                            : collage
                              ? cn(
                                  "overflow-hidden bg-background",
                                  regularImages.length === 3 && index === 0 && "row-span-2",
                                  regularImages.length > 3 &&
                                    regularImages.length % 2 === 1 &&
                                    index === regularImages.length - 1 &&
                                    "col-span-2",
                                )
                              : "aspect-[4/3] overflow-hidden rounded-lg border border-border/80",
                      )}
                    >
                      {image.previewUrl ? (
                        <button
                          type="button"
                          className="block h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${image.name}`}
                          onClick={() => {
                            const preview = buildExpandedImagePreview(regularImages, image.id);
                            if (!preview) return;
                            ctx.onImageExpand(preview);
                          }}
                        >
                          <img
                            src={image.previewUrl}
                            alt={image.name}
                            className={cn(
                              "block transform-gpu",
                              // A fixed height keeps the row from growing when the image loads.
                              loneImage
                                ? "h-48 w-auto min-w-24 max-w-full object-cover"
                                : "size-full object-cover",
                            )}
                          />
                        </button>
                      ) : (
                        <div
                          className={cn(
                            "flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground/70",
                            loneImage && "h-48 w-64 max-w-full",
                            collage && "h-full",
                          )}
                        >
                          {image.name}
                        </div>
                      )}
                      {image.previewUrl && image.source?.kind === "snap-shot" ? (
                        <SnapShotAttachmentDetails source={image.source} />
                      ) : null}
                    </div>
                  ))}
                  {userVideos.map((file) => (
                    <UserVideoAttachment key={file.id} file={file} />
                  ))}
                </div>
              )}
              {unchippedFiles.length > 0 || unknownAttachments.length > 0 ? (
                <div className="mb-2 flex flex-col gap-1">
                  {unchippedFiles.map((file) => {
                    const fileIdentity = (
                      <>
                        <PierreEntryIcon
                          pathValue={file.name}
                          kind="file"
                          theme={ctx.resolvedTheme}
                        />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      </>
                    );
                    if (file.downloadable !== false) {
                      return (
                        <div key={file.id} className="flex min-w-0 items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Preview ${file.name}`}
                            onClick={() => ctx.onFileOpen(file)}
                            className="focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                          >
                            {fileIdentity}
                            <EyeIcon className="size-4 shrink-0" />
                          </button>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost-muted"
                                  aria-label={`Download ${file.name}`}
                                  onClick={() => ctx.onFileDownload(file)}
                                />
                              }
                            >
                              <DownloadIcon />
                            </TooltipTrigger>
                            <TooltipPopup side="top">Download {file.name}</TooltipPopup>
                          </Tooltip>
                        </div>
                      );
                    }

                    return (
                      <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                        {fileIdentity}
                      </div>
                    );
                  })}
                  {unknownAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="flex min-w-0 items-center gap-2 py-1 text-sm"
                    >
                      <PierreEntryIcon
                        pathValue={attachment.name}
                        kind="file"
                        theme={ctx.resolvedTheme}
                      />
                      <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div onCopyCapture={onBodyCopyCapture}>
                <CollapsibleUserMessageBody
                  text={resolvedContext.text}
                  renderContextReference={renderContextReference}
                  skills={ctx.skills}
                  markdownCwd={ctx.markdownCwd}
                  collapsible={!folded}
                />
              </div>
            </div>
            <DockedTodoPlan plan={row.plan} live={row.planRunLive === true} />
          </div>
        </>
      ) : null}
      {row.projectedItem &&
      row.projectedItem.item.status !== "completed" &&
      row.projectedItem.item.status !== "pending" &&
      row.projectedItem.item.status !== "waiting" ? (
        <div className="me-1 flex items-center gap-1.5">
          <span className="rounded-full border border-destructive/25 bg-destructive/8 px-1.5 py-0.5 text-3xs font-medium text-destructive">
            {row.projectedItem.item.status}
          </span>
        </div>
      ) : null}
      {!folded || expanded ? (
        <div
          className={cn(
            "flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums",
            folded
              ? "opacity-100"
              : "opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100",
          )}
          data-terminal-user-actions={isTerminal && !folded ? "true" : undefined}
        >
          <div className="flex shrink-0 items-center gap-2">
            {folded && isAgentMessage && senderThreadId ? (
              <InlineButton onClick={() => ctx.onOpenThread(senderThreadId)} tone="muted">
                Open thread
              </InlineButton>
            ) : null}
            {folded && userMessage.isAutomation && userMessage.scheduledTaskId ? (
              <Link
                to="/settings/scheduled-tasks"
                search={{
                  environmentId: ctx.activeThreadEnvironmentId,
                  taskId: userMessage.scheduledTaskId,
                }}
                className="rounded-sm text-xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Open automation
              </Link>
            ) : null}
            <Tooltip>
              <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
                {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
              </TooltipTrigger>
              <TooltipPopup>
                {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
              </TooltipPopup>
            </Tooltip>
            <div className="flex items-center gap-0.5">
              {typeof revertTurnCount === "number" && (
                <RevertUserMessageButton turnCount={revertTurnCount} messageId={row.message.id} />
              )}
              {resolvedContext.text && (
                <MessageCopyButton
                  // Structured paste needs the canonical links to retain their positions.
                  text={
                    contextClipboardFragment
                      ? resolvedContext.text
                      : replaceComposerContextReferences(
                          resolvedContext.text,
                          (reference) => reference.label,
                        )
                  }
                  {...(contextClipboardFragment
                    ? {
                        extraFlavors: {
                          [COMPOSER_CONTEXT_CLIPBOARD_MIME]: contextClipboardFragment,
                        },
                      }
                    : {})}
                  variant="ghost"
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UserMessageIntentMarker({
  intent,
}: {
  readonly intent: NonNullable<ChatMessage["inputIntent"]>;
}) {
  const presentation =
    intent === "queued_turn"
      ? {
          label: "Queued",
          icon: null,
        }
      : intent === "promoted_queued_to_steer"
        ? {
            label: "Steer",
            icon: Redo2Icon,
          }
        : {
            label: "Steer",
            icon: Redo2Icon,
          };
  const IntentIcon = presentation.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground"
            data-user-message-intent={intent}
          />
        }
      >
        {IntentIcon ? <IntentIcon aria-hidden="true" className="size-3" /> : null}
        {presentation.label}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {intent === "queued_turn"
          ? "Queued behind the active turn"
          : intent === "promoted_queued_to_steer"
            ? "Originally queued, then promoted to steer the active turn"
            : "Steered the active turn"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function resolvePreviewAnnotationImage(input: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
  userImages: ReadonlyArray<ChatImageAttachment>;
  previewImages: ReadonlyArray<ChatImageAttachment>;
  annotationRecordIds: ReadonlyArray<string>;
}): ChatImageAttachment | null {
  const screenshotRecord = input.record.screenshotContextId
    ? asKnownContextRecord(input.recordsById.get(input.record.screenshotContextId))
    : undefined;
  return (
    (screenshotRecord?.kind === "image"
      ? input.userImages.find((image) => image.id === screenshotRecord.attachmentId)
      : undefined) ??
    input.previewImages.find(
      (image) => image.name === `preview-annotation-${input.record.annotationId}.png`,
    ) ??
    input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)] ??
    null
  );
}

function RevertUserMessageButton({
  turnCount,
  messageId,
}: {
  turnCount: number;
  messageId: MessageId;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertToTurnCount(turnCount, messageId)}
            aria-label="Edit from here"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit from here</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Hover-revealed wall-clock time with a full-date tooltip — the same metadata
 * presentation as message rows, for work entries and turn folds. The parent
 * carries `group/timeline-row`; hover or focus on an existing control reveals
 * the time without adding a tab stop. Hidden timestamps stay outside the row
 * layout. Visibility changes immediately so leaving flow cannot overlap text
 * during a fade-out. Place it before any trailing disclosure control so
 * revealing the time does not move the chevron.
 */
function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-sm leading-6 tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A summary whose trailing `+n −m` takes the diff colours. The shared text
 * stays plain for other clients; only a suffix that matches the formatted
 * counts is restyled, so any other text renders as is. In the minimal style
 * the words and the counts roll as they change.
 */
function DiffStatSummary({ text, diffStats }: { text: string; diffStats: DiffStats | undefined }) {
  const statText = diffStats ? formatDiffStats(diffStats) : "";
  if (!diffStats || statText === "" || !text.endsWith(statText)) return text;
  return (
    <>
      <RollingText text={text.slice(0, -statText.length)} />
      {diffStats.added > 0 ? (
        <span className="status-diff-added">
          <RollingText text={`+${diffStats.added}`} />
        </span>
      ) : null}
      {diffStats.added > 0 && diffStats.removed > 0 ? " " : null}
      {diffStats.removed > 0 ? (
        <span className="status-diff-removed">
          <RollingText text={`−${diffStats.removed}`} />
        </span>
      ) : null}
    </>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const activityGroup = row.activityGroup;

  return (
    <div
      className="group/timeline-row relative flex flex-col gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1"
      data-t3-part="timeline-checkpoint"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={row.expanded}
          data-scroll-anchor-ignore
          onClick={() => ctx.onToggleTurnFold(row.runId, activityGroup)}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span>
            <DiffStatSummary text={row.label} diffStats={row.diffStats} />
          </span>
          <MorphIcon className="size-3.5" icon={row.expanded ? ChevronDown : ChevronRight} />
        </button>
        <TimelineRowTimestamp
          createdAt={row.createdAt}
          timestampFormat={ctx.timestampFormat}
          className="ms-auto"
        />
      </div>
      {activityGroup !== undefined && activityGroup.loadedCount === 0 && activityGroup.loading ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          Loading activity…
        </p>
      ) : null}
      {activityGroup === undefined ||
      activityGroup.loadedCount !== 0 ||
      activityGroup.error === null ? null : (
        <p role="status" className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span>{activityGroup.error}</span>
          <button
            type="button"
            disabled={activityGroup.loading}
            aria-label="Retry loading activity"
            onClick={() => ctx.onLoadActivityPage(activityGroup.initialRequest)}
            className="font-medium text-foreground underline underline-offset-2 disabled:cursor-default disabled:opacity-50"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

function ActivityPageBoundaryTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "activity-page-boundary" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const label = row.direction === "previous" ? "Load earlier activity" : "Load later activity";

  return (
    <div className="flex flex-col gap-1 py-1">
      <button
        type="button"
        aria-label={label}
        disabled={row.loading}
        onClick={() => ctx.onLoadActivityPage(row.request)}
        className="w-full py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default"
      >
        {row.loading ? "Loading activity…" : label}
      </button>
      {row.error === null ? null : (
        <p
          role="status"
          className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
        >
          <span>{row.error}</span>
          <button
            type="button"
            disabled={row.loading}
            aria-label="Retry loading activity"
            onClick={() => ctx.onLoadActivityPage(row.request)}
            className="font-medium text-foreground underline underline-offset-2 disabled:cursor-default disabled:opacity-50"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

function AttemptFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "attempt-fold" }> }) {
  const ctx = use(TimelineRowCtx);

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      data-scroll-anchor-ignore
      data-superseded-attempt-id={row.attemptId}
      onClick={() => ctx.onToggleAttemptFold(row.attemptId)}
      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <MorphIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        icon={row.expanded ? ChevronDown : ChevronRight}
      />
      <span className="text-xs font-medium text-foreground/80">{row.label}</span>
      <span className="text-2xs text-muted-foreground">Partial output retained</span>
    </button>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const transcriptStyle = use(TranscriptStyleCtx);
  const isTerminal = transcriptStyle === "terminal";
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const visibleText = useStreamingReveal(messageText, {
    identity: row.message.id,
    streaming: Boolean(row.message.streaming),
    reducedMotion,
  });
  // A recap that arrives after the answer did (the turn settling on screen)
  // rises in; one already there at mount is history.
  const [recapAtMount] = useState(row.turnRecap !== undefined);

  return (
    <>
      <div
        className="relative min-w-0 px-1 py-0.5"
        data-streaming={row.message.streaming === true ? "true" : undefined}
        data-t3-part="timeline-markdown"
      >
        {isTerminal ? null : <MessageAuthorHeading>{APP_BASE_NAME}</MessageAuthorHeading>}
        <AssistantCitationSource
          messageId={row.message.id}
          {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
          itemKey={row.id}
          request={ctx.citationRequest}
          listRef={ctx.listRef}
        >
          <ChatMarkdown
            text={visibleText}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={Boolean(row.message.streaming)}
            streamWordFade={transcriptStyle !== "terminal"}
            lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
            skills={ctx.skills}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
            onUseArtifactTemplate={ctx.onUseArtifactTemplate}
            onRunShellCommand={ctx.onRunShellCommand}
            onImageExpand={ctx.onImageExpand}
          />
        </AssistantCitationSource>
        {row.turnRecap ? (
          <AssistantTurnRecap recap={row.turnRecap} entering={!recapAtMount} />
        ) : null}
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
          />
        ) : null}
      </div>
    </>
  );
}

function AssistantForkButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  if (!canFork || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void ctx
                .onForkFromRun({ sourceThreadId: projectedItem.sourceThreadId, runId })
                .finally(() => setBusy(false));
            }}
            aria-label="Fork from this response"
          />
        }
      >
        <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork from this response</TooltipPopup>
    </Tooltip>
  );
}

function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {projectedItem?.item.type === "assistant_message" ? (
        <AssistantForkButton projectedItem={projectedItem} />
      ) : null}
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {projectedItem.item.status}
        </span>
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5" data-t3-part="timeline-approval">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function HtmlRenderTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "html-render" }> }) {
  const ctx = use(TimelineRowCtx);
  const { onAppFullscreenChange } = ctx;
  const onFullscreenChange = useCallback(
    (fullscreen: boolean) => onAppFullscreenChange(row.id, fullscreen),
    [onAppFullscreenChange, row.id],
  );

  return (
    <div className="min-w-0 px-1">
      <HtmlRenderFrame
        // A recycled row must not keep another page's frozen frame.
        key={row.htmlRender.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        htmlRender={row.htmlRender}
        onFullscreenChange={onFullscreenChange}
      />
    </div>
  );
}

function ApertureEmbedTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "aperture-embed" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const reference = row.apertureEmbed;
  // The terminal look keeps every step to a line; the figure stays one click away.
  if (use(TranscriptStyleCtx) === "terminal") {
    return (
      <div className="min-w-0 truncate px-1 font-mono text-muted-foreground text-xs">
        Aperture {reference.kind} · {reference.title} · pinned {apertureAsOfLabel(reference.asOf)}
        {reference.webUrl === undefined ? null : (
          <>
            {" · "}
            <a
              href={reference.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              open in Aperture
            </a>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0 px-1">
      <ApertureEmbedFrame
        // A recycled row must not keep another embed's runtime and streams.
        key={reference.refId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        reference={reference}
      />
    </div>
  );
}

function McpAppTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "mcp-app" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);

  return (
    <div className="min-w-0 px-1">
      <McpAppFrame
        // A recycled row must not keep another app's live document.
        key={row.mcpApp.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        conversationThreadId={ctx.threadRef?.threadId ?? row.sourceThreadId}
        itemId={row.itemId}
        revision={row.revision}
        app={row.mcpApp}
        onSendMessage={ctx.onSendAppMessage}
        awaitingUser={awaitingUser}
        onFullscreenChange={(fullscreen) => ctx.onAppFullscreenChange(row.id, fullscreen)}
      />
    </div>
  );
}

type V2EventTone = "muted" | "warning" | "danger" | "success";

function v2EventPresentation(item: OrchestrationV2TurnItem): {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: V2EventTone;
  readonly icon: LucideIcon;
} {
  switch (item.type) {
    case "error": {
      const presentation = providerErrorPresentation(item);
      return {
        ...presentation,
        tone:
          item.status === "completed"
            ? "success"
            : item.status === "running" || item.failure.class === "usage_limit"
              ? "warning"
              : "danger",
        icon: CircleAlertIcon,
      };
    }
    case "run_interrupt_request":
      return {
        label: "Interrupt requested",
        detail: item.message,
        tone: "warning",
        icon: CircleAlertIcon,
      };
    case "run_interrupt_result":
      return {
        label: "Run interrupted",
        detail: item.message,
        tone: "danger",
        icon: XIcon,
      };
    case "handoff":
      return {
        label: "Context handoff",
        detail:
          item.summary ??
          `${item.fromProviderInstanceIds.join(", ")} → ${item.toProviderInstanceId}`,
        tone: item.status === "failed" ? "danger" : "muted",
        icon: ZapIcon,
      };
    case "fork":
      return {
        label: "Conversation fork",
        detail: `Continues in ${item.targetThreadId}`,
        tone: "muted",
        icon: GitForkIcon,
      };
    case "compaction": {
      const tokenSummary =
        item.beforeTokenCount === undefined && item.afterTokenCount === undefined
          ? null
          : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
      return {
        label: "Context compacted",
        detail: item.summary ?? tokenSummary,
        tone: item.status === "failed" ? "danger" : "muted",
        icon: MinusIcon,
      };
    }
    case "todo_list": {
      const steps = item.steps.map((step) => `${step.status}: ${step.text}`).join("\n");
      return {
        label: "Plan updated",
        detail: [item.explanation, steps].filter(Boolean).join("\n\n") || null,
        tone: item.status === "failed" ? "danger" : "success",
        icon: CheckIcon,
      };
    }
    default:
      return {
        label: item.title?.trim() || item.type.replaceAll("_", " "),
        detail: null,
        tone: item.status === "failed" ? "danger" : "muted",
        icon: WrenchIcon,
      };
  }
}

function V2EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility, sourceThreadId } = row.projectedItem;
  const todoPlan = readNativeTodoPlan(item);
  if (todoPlan !== null) {
    return (
      <NativeTodoPane plan={todoPlan} disclosureCache={ctx.workGroupViewState.expandedEntries} />
    );
  }
  if (item.type === "dynamic_tool") {
    return <NativeWorkflowToolTimelineRow row={row} />;
  }
  if (item.type === "subagent") {
    return <V2SubagentGroup key={row.id} row={row} />;
  }
  if (item.type === "secret_request") {
    return (
      <SecretRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  if (isV2LifecycleItem(item)) {
    return (
      <V2LifecycleRow
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        resourceSummary={row.resourceSummary}
        createdAt={row.createdAt}
        timestampFormat={ctx.timestampFormat}
        providerStatuses={ctx.providerStatuses}
        runs={ctx.runs}
        onOpenThread={ctx.onOpenThread}
      />
    );
  }
  const presentation = v2EventPresentation(item);
  const Icon = presentation.icon;
  if (item.type === "error") {
    return (
      <details
        className={cn(
          "group rounded-md border",
          presentation.tone === "warning" && "border-warning/25 bg-warning/5",
          presentation.tone === "danger" && "border-destructive/25 bg-destructive/5",
          presentation.tone === "success" && "border-success/20 bg-success/5",
        )}
        data-v2-item-type={item.type}
        data-v2-item-visibility={visibility}
        data-v2-event-disclosure="true"
      >
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              presentation.tone === "warning" && "text-warning",
              presentation.tone === "danger" && "text-destructive",
              presentation.tone === "success" && "text-success",
            )}
          />
          <span className="shrink-0 font-medium text-foreground/90">{presentation.label}</span>
          {item.status !== "completed" ? (
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-3xs",
                item.status === "failed"
                  ? "border-destructive/40 text-destructive"
                  : "border-border/70 text-muted-foreground",
              )}
            >
              {item.status}
            </span>
          ) : null}
          {presentation.detail ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/65">
              {presentation.detail}
            </span>
          ) : null}
          {visibility !== "local" ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
              {visibility === "inherited" ? "Inherited" : "Synthetic"}
            </span>
          ) : null}
          <ChevronDownIcon className="motion-chevron size-3 shrink-0 text-muted-foreground/60 group-open:rotate-180" />
        </summary>
        <div className="border-t border-border/45 px-3 py-2 ps-8">
          {presentation.detail ? (
            <div className="text-xs leading-relaxed text-muted-foreground">
              <ChatMarkdown
                text={presentation.detail}
                cwd={ctx.markdownCwd}
                threadRef={ctx.threadRef ?? undefined}
                skills={ctx.skills}
                lineBreaks
              />
            </div>
          ) : null}
          {visibility === "inherited" ? (
            <p className="mt-1 font-mono text-3xs text-muted-foreground/65">
              From {sourceThreadId}
            </p>
          ) : null}
          <div className={presentation.detail ? "mt-2" : undefined}>
            <V2ItemInspector
              projectedItem={row.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={ctx.workspaceRoot}
              onOpenThread={ctx.onOpenThread}
              onOpenTurnDiff={ctx.onOpenTurnDiff}
              onRollbackCheckpoint={ctx.onRollbackCheckpoint}
              onImageExpand={ctx.onImageExpand}
            />
          </div>
        </div>
      </details>
    );
  }
  return (
    <section
      className={cn(
        "rounded-lg border px-3 py-2",
        presentation.tone === "warning" && "border-warning/25 bg-warning/5",
        presentation.tone === "danger" && "border-destructive/25 bg-destructive/5",
        presentation.tone === "success" && "border-success/20 bg-success/5",
        presentation.tone === "muted" && "border-border/60 bg-card/30",
      )}
      data-v2-item-type={item.type}
      data-v2-item-visibility={visibility}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            presentation.tone === "warning" && "text-warning",
            presentation.tone === "danger" && "text-destructive",
            presentation.tone === "success" && "text-success",
            presentation.tone === "muted" && "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium text-foreground/90">{presentation.label}</span>
            {item.status !== "completed" ? (
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 font-mono text-3xs",
                  item.status === "failed"
                    ? "border-destructive/40 text-destructive"
                    : "border-border/70 text-muted-foreground",
                )}
              >
                {item.status}
              </span>
            ) : null}
            {visibility !== "local" ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                {visibility === "inherited" ? "Inherited" : "Synthetic"}
              </span>
            ) : null}
          </div>
          {presentation.detail ? (
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              <ChatMarkdown
                text={presentation.detail}
                cwd={ctx.markdownCwd}
                threadRef={ctx.threadRef ?? undefined}
                skills={ctx.skills}
                lineBreaks
              />
            </div>
          ) : null}
          {visibility === "inherited" ? (
            <p className="mt-1 font-mono text-3xs text-muted-foreground/65">
              From {sourceThreadId}
            </p>
          ) : null}
          <div className="mt-2">
            <V2ItemInspector
              projectedItem={row.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={ctx.workspaceRoot}
              onOpenThread={ctx.onOpenThread}
              onOpenTurnDiff={ctx.onOpenTurnDiff}
              onRollbackCheckpoint={ctx.onRollbackCheckpoint}
              onImageExpand={ctx.onImageExpand}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function sameSubagentLifecycles(
  previous: ReadonlyArray<TimelineLiveSubagent> | undefined,
  next: ReadonlyArray<TimelineLiveSubagent> | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined || previous.length !== next.length) return false;
  return previous.every((agent, index) => {
    const candidate = next[index];
    if (candidate === undefined) return false;
    return (
      agent.id === candidate.id &&
      agent.status === candidate.status &&
      agent.startedAt === candidate.startedAt &&
      agent.completedAt === candidate.completedAt
    );
  });
}
type TimelineThreadSubagentProjection = {
  readonly projection: {
    readonly subagents?: ReadonlyArray<TimelineLiveSubagent> | undefined;
  };
};

// Keep useAtomValue's mapped atom stable across renders.
const selectTimelineThreadSubagents = (
  thread: TimelineThreadSubagentProjection | null | undefined,
) => thread?.projection.subagents;

function TimelineSubagentLifecycleObserver({
  environmentId,
  threadId,
  onChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onChange: (threadId: ThreadId, agents: ReadonlyArray<TimelineLiveSubagent> | undefined) => void;
}) {
  const agents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, threadId)),
    selectTimelineThreadSubagents,
  );
  useEffect(() => onChange(threadId, agents), [agents, onChange, threadId]);
  return null;
}

const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const groupKey = row.projectedItem.item.parentItemId ?? row.id;
  const groupId = `subagent-group:${groupKey}`;
  const collapsedGroupId = `subagent-group-collapsed:${groupKey}`;
  const members = (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type === "subagent" ? [item] : [],
  );
  const threadSubagents = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(ctx.activeThreadEnvironmentId, row.projectedItem.item.threadId),
    ),
    selectTimelineThreadSubagents,
  );
  const hasActiveResolvedMember = members.some((member) => {
    const liveMember = threadSubagents?.find(({ id }) => id === member.subagentId);
    return isOrchestrationV2WorkActive(liveMember?.status ?? member.status);
  });
  const [expandedPreference, setExpandedPreference] = useState<boolean | null>(() => {
    if (ctx.workGroupViewState.expandedEntries.has(groupId)) return true;
    if (ctx.workGroupViewState.expandedEntries.has(collapsedGroupId)) return false;
    return null;
  });
  const expanded = expandedPreference ?? hasActiveResolvedMember;
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(row.id, expanded);
    if (open) {
      ctx.workGroupViewState.expandedEntries.add(groupId);
      ctx.workGroupViewState.expandedEntries.delete(collapsedGroupId);
    } else {
      ctx.workGroupViewState.expandedEntries.delete(groupId);
      ctx.workGroupViewState.expandedEntries.add(collapsedGroupId);
    }
    setExpandedPreference(open);
  };
  if (members.length === 0) return null;

  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      <SubagentTaskTracker
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.projectedItem.item.threadId}
        members={members}
        autoExpandedDetailsItemIds={row.autoExpandedSubagentItemIds}
        providerStatuses={ctx.providerStatuses}
        taskCall={row.taskCall}
        expanded={expanded}
        onExpandedChange={toggleExpanded}
        detailsExpansionCache={ctx.workGroupViewState.expandedEntries}
        onOpenThread={ctx.onOpenThread}
        notices={row.absorbedNotices}
      />
    </WorkLogBlock>
  );
});

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders standalone activity or one bounded, virtualized expanded tool group. */
const WorkGroupSection = memo(function WorkGroupSection({
  anchorKey,
  disclosureAnchorKey = anchorKey,
  groupedEntries,
  isExpandedToolGroup,
  displayLabel,
}: {
  anchorKey: string;
  disclosureAnchorKey?: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroup: boolean;
  displayLabel?: string | undefined;
}) {
  const { workspaceRoot, routeThreadKey, onToggleWorkEntry, pendingApprovals } =
    use(TimelineRowCtx);
  const onToggleStandaloneEntry = useCallback(
    (collapsed: boolean) => onToggleWorkEntry(disclosureAnchorKey, collapsed),
    [disclosureAnchorKey, onToggleWorkEntry],
  );
  const nonEmptyEntries = useMemo(
    () =>
      groupedEntries.filter((entry) => {
        const item = entry.projectedItem?.item;
        return (
          (item?.type === "approval_request" && pendingApprovals.has(item.requestId)) ||
          workEntryIsVisibleInGroup(entry, isExpandedToolGroup)
        );
      }),
    [groupedEntries, isExpandedToolGroup, pendingApprovals],
  );

  if (nonEmptyEntries.length === 0) return null;
  if (isExpandedToolGroup) {
    return (
      <ExpandedWorkGroupEntries
        key={`${routeThreadKey}:${anchorKey}`}
        anchorKey={anchorKey}
        disclosureAnchorKey={disclosureAnchorKey}
        entries={nonEmptyEntries}
        workspaceRoot={workspaceRoot}
      />
    );
  }

  return (
    <section aria-label="Activity" data-t3-part="timeline-tool-call">
      {nonEmptyEntries.map((workEntry) => (
        <SimpleWorkEntryRow
          key={workEntry.id}
          workEntry={workEntry}
          workspaceRoot={workspaceRoot}
          displayLabel={displayLabel}
          onToggleEntry={onToggleStandaloneEntry}
        />
      ))}
    </section>
  );
});

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

function formatWorkingTimerNow(startIso: string, workCompletedAt: string | null): string {
  const endIso = workCompletedAt ?? new Date().toISOString();
  return formatWorkingTimer(startIso, endIso) ?? "0s";
}

function WorkingTimer({
  createdAt,
  workCompletedAt,
}: {
  createdAt: string;
  workCompletedAt: string | null;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const rolls = use(TranscriptStyleCtx) !== "terminal";
  const [rolledText, setRolledText] = useState(() =>
    formatWorkingTimerNow(createdAt, workCompletedAt),
  );
  const initialText = formatWorkingTimerNow(createdAt, workCompletedAt);

  useEffect(() => {
    if (workCompletedAt !== null) return;
    // Other styles write the text in place; minimal re-renders it so its digits roll.
    const updateText = () => {
      const text = formatWorkingTimerNow(createdAt, null);
      if (rolls) setRolledText(text);
      else if (textRef.current) textRef.current.textContent = text;
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt, workCompletedAt, rolls]);

  if (rolls) {
    return (
      <RollingText
        text={workCompletedAt === null ? rolledText : initialText}
        className="tabular-nums"
      />
    );
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// A collapsed single-line step row (`.borderless-step-row` header).
const compactWorkEntryHeight = 30;

function ExpandedWorkGroupEntries({
  anchorKey,
  disclosureAnchorKey,
  entries,
  workspaceRoot,
}: {
  anchorKey: string;
  disclosureAnchorKey: string;
  entries: TimelineWorkEntry[];
  workspaceRoot: string | undefined;
}) {
  const { workGroupViewState: viewState, onToggleWorkEntry } = use(TimelineRowCtx);
  const { supersededThoughtId } = use(TimelineRowActivityCtx);
  const isReasoningTraceOnly = entries.every((entry) => entry.itemType === "reasoning");
  const [wasReasoningTraceOnly, setWasReasoningTraceOnly] = useState(isReasoningTraceOnly);
  useLayoutEffect(() => {
    if (isReasoningTraceOnly) {
      setWasReasoningTraceOnly(true);
      return;
    }
    if (!wasReasoningTraceOnly) return;
    for (const entry of entries) {
      if (entry.itemType !== "reasoning") continue;
      viewState.expandedEntries.delete(toCollapsedKey(entry.id));
      viewState.expandedEntries.add(entry.id);
    }
    setWasReasoningTraceOnly(false);
  }, [entries, isReasoningTraceOnly, viewState, wasReasoningTraceOnly]);
  const [initialScrollIndex] = useState(() =>
    resolveWorkGroupScrollIndex(entries, viewState.scrollPositions.get(anchorKey)),
  );
  // Steps that join the open group roll in, including ones that arrive
  // already settled (a quick read). When the group itself just arrived, the
  // steps it opened with roll in one after another; otherwise they stay still.
  const rowArrived = use(TimelineRowArrivedCtx);
  const [arrivals] = useState(() => {
    const at = new Map<string, WorkEntryArrival>();
    if (rowArrived) {
      const now = performance.now();
      entries.forEach(({ id }, index) => {
        at.set(id, {
          at: now,
          delayMs: Math.min(index * GROUP_ARRIVAL_STAGGER_MS, GROUP_ARRIVAL_STAGGER_MAX_MS),
        });
      });
    }
    return { known: new Set(entries.map(({ id }) => id)), at };
  });
  for (const { id } of entries) {
    if (arrivals.known.has(id)) continue;
    arrivals.known.add(id);
    arrivals.at.set(id, { at: performance.now(), delayMs: 0 });
  }
  const [restoringPosition, setRestoringPosition] = useState(initialScrollIndex !== undefined);
  const listRef = useRef<LegendListRef>(null);
  const [expandedContentHeight, setExpandedContentHeight] = useState(0);
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  // A live group follows its newest step, including a step growing in place;
  // a restored or settled group opens where the reader left it.
  const [initialStickMode] = useState<"sticky" | "detached">(() =>
    initialScrollIndex === undefined &&
    entries.some(
      (entry) =>
        entry.toolLifecycleStatus === "inProgress" ||
        entry.projectedItem?.item.status === "running",
    )
      ? "sticky"
      : "detached",
  );
  const bottomStick = useBottomStick(
    scrollNode,
    scrollNode?.firstElementChild ?? null,
    initialStickMode,
  );
  const groupView = useMemo(
    () => ({
      state: viewState,
      onToggleEntry: (collapsed: boolean) => onToggleWorkEntry(disclosureAnchorKey, collapsed),
      arrivals: arrivals.at,
    }),
    [arrivals, disclosureAnchorKey, onToggleWorkEntry, viewState],
  );
  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (position) {
      viewState.scrollPositions.set(anchorKey, {
        entryId: position.rowId,
        offset: position.offsetWithinRow,
      });
    }
  }, [anchorKey, viewState]);

  const handleLoad = useCallback(() => {
    const list = listRef.current;
    const element = list?.getScrollableNode();
    if (initialScrollIndex && list && element) {
      // Bootstrap can report the restored target before the DOM has applied it.
      // Reconcile once at load, before releasing the measured anchor row.
      const offset = Math.max(
        0,
        Math.min(list.getState().scroll, element.scrollHeight - element.clientHeight),
      );
      if (Math.abs(element.scrollTop - offset) > 1) {
        void list.scrollToOffset({ offset, animated: false });
      }
    }
    setRestoringPosition(false);
  }, [initialScrollIndex]);

  // The stick hook owns the edge fades; it needs the list's real scroll node.
  useLayoutEffect(() => {
    const element = listRef.current?.getScrollableNode();
    if (element) setScrollNode(element);
  }, []);

  const renderEntry = useCallback(
    ({ item }: { item: TimelineWorkEntry }) => (
      <SimpleWorkEntryRow
        key={item.id}
        workEntry={item}
        workspaceRoot={workspaceRoot}
        hideReasoningHeader={isReasoningTraceOnly}
        forceReasoningOpen={isReasoningTraceOnly || wasReasoningTraceOnly}
        reasoningIsSuperseded={item.id === supersededThoughtId}
      />
    ),
    [isReasoningTraceOnly, supersededThoughtId, wasReasoningTraceOnly, workspaceRoot],
  );

  const updateExpandedContentHeight = useCallback(() => {
    const state = listRef.current?.getState();
    let height = 0;
    for (const entry of entries) {
      // Open rows, whether opened by hand or auto-opened while running, add room
      // for their details, so a tall live step never hides its own headline.
      if (!viewState.expandedEntries.has(entry.id) && !entry.autoExpanded) continue;
      height += Math.max(
        0,
        (state?.sizes.get(entry.id) ?? compactWorkEntryHeight) - compactWorkEntryHeight,
      );
    }
    setExpandedContentHeight(height);
  }, [entries, viewState]);

  useLayoutEffect(updateExpandedContentHeight, [entries, updateExpandedContentHeight]);

  return (
    <WorkGroupViewCtx value={groupView}>
      <WorkLogList>
        <div className="relative min-w-0">
          <LegendList
            ref={listRef}
            data={entries}
            extraData={workspaceRoot}
            keyExtractor={workEntryKey}
            renderItem={renderEntry}
            estimatedItemSize={compactWorkEntryHeight}
            drawDistance={240}
            // The row trees vary; virtualize without recycling across item kinds.
            // Measure the restored row even when an intra-row offset puts its
            // estimated bounds outside the list's small bootstrap render window.
            {...(restoringPosition && initialScrollIndex
              ? { alwaysRender: { indices: [initialScrollIndex.index] } }
              : {})}
            maintainVisibleContentPosition
            onLoad={handleLoad}
            onScroll={handleScroll}
            onItemSizeChanged={updateExpandedContentHeight}
            tabIndex={isReasoningTraceOnly ? undefined : 0}
            role={isReasoningTraceOnly ? undefined : "region"}
            aria-label={isReasoningTraceOnly ? undefined : "Tool calls"}
            data-tool-group-scroll={!isReasoningTraceOnly || undefined}
            data-bottom-stick-mode={bottomStick.mode}
            {...(!isReasoningTraceOnly
              ? { style: { maxHeight: `calc(min(18rem, 50dvh) + ${expandedContentHeight}px)` } }
              : {})}
            className={cn(
              isReasoningTraceOnly
                ? "overflow-visible"
                : "scroll-py-6 overflow-x-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            )}
          />
          {!isReasoningTraceOnly ? (
            <BottomStickJumpButton
              visible={bottomStick.canJump}
              onJump={bottomStick.jumpToBottom}
            />
          ) : null}
        </div>
      </WorkLogList>
    </WorkGroupViewCtx>
  );
}

const workEntryKey = (entry: TimelineWorkEntry) => entry.id;

function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

const failedToolIconClassName = "text-tool-error-icon/40";

/** Image icons and the gradient computer-use mark cannot take a currentColor
 *  tint, so failed rows using them get a trailing x instead. */
function toolIconAcceptsTint(
  iconName: WorkEntryIconName,
  toolIcon: ToolActivityIcon | undefined,
): boolean {
  return toolIcon === undefined && iconName !== "computer";
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup } =
    use(TimelineRowActivityCtx);
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  // One span for every label so the setup-to-working handoff swaps text in
  // place instead of remounting the row.
  const shimmer = (isPreparingWorktree || isCompacting) && row.status === "working";
  const statusLabel = {
    working: "Working",
    monitoring: "Monitoring",
    waiting: "Waiting for input",
    "waiting-for-agents": "Waiting for agents",
    retry: "Retrying",
    finishing: "Finishing",
    disconnected: "Disconnected",
  }[row.status];
  const elapsedPrefix =
    row.status === "working"
      ? " for "
      : row.status === "finishing" || row.status === "waiting-for-agents"
        ? " · Worked "
        : " · Elapsed ";
  const label =
    row.status === "monitoring" ? (
      statusLabel
    ) : isPreparingWorktree ? (
      "Setting up worktree…"
    ) : isCompacting ? (
      <CompactingLabel />
    ) : row.createdAt ? (
      <>
        {statusLabel}
        {elapsedPrefix}
        <WorkingTimer createdAt={row.createdAt} workCompletedAt={row.workCompletedAt} />
      </>
    ) : (
      `${statusLabel}...`
    );
  return (
    <div
      className="border-b border-border/60 pb-2 pt-1"
      data-t3-part="timeline-status"
      data-terminal-working={isTerminal ? "true" : undefined}
      data-terminal-working-status={isTerminal ? row.status : undefined}
    >
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-0.5 text-sm leading-relaxed text-muted-foreground tabular-nums">
        {isTerminal ? (
          row.status === "disconnected" || row.status === "monitoring" ? (
            <span aria-hidden="true">○</span>
          ) : (
            <TerminalSpinner />
          )
        ) : (
          // The tight crop starts the face on the icon column's edge, where a
          // padded avatar would sit inside it, off the steps' glyphs below.
          // It spins about the face's own centre, left of the box's.
          <img
            src="/mascot/kyle-head.png"
            alt=""
            className={cn(
              "size-4 shrink-0 self-center object-contain object-left origin-[41%_50%] select-none",
              row.status === "working" && "motion-safe:animate-spin",
            )}
            draggable={false}
          />
        )}
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {shimmer && !isTerminal ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Trailing chip in the working header while a setup script still runs after
 * the agent started. Opens the stage list and live output in a popover; the
 * chip leaves with the script, so nothing lingers in the timeline.
 */
function BackgroundWorktreeSetupChip({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const ctx = use(TimelineRowCtx);
  const terminalId = snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = useMemo(
    () => (openTerminal && terminalId ? () => openTerminal(terminalId) : null),
    [openTerminal, terminalId],
  );
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            className="ml-auto min-w-0 shrink-0"
            aria-label={`${scriptName} is still running. Show setup progress.`}
          />
        }
      >
        <Spinner className="size-3 shrink-0" />
        <span className="truncate">{scriptName}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <WorktreeSetupCard
          snapshot={snapshot}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />
      </PopoverPopup>
    </Popover>
  );
}

function CompactingLabel() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      Compacting…
    </span>
  );
}

function LiveActivityRow({
  label,
  intent,
  iconName,
  toolIcon,
  failed = false,
  active = false,
  shimmer = false,
}: {
  label: ReactNode;
  intent?: string | undefined;
  iconName?: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  active?: boolean;
  shimmer?: boolean;
}) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const animated = active && !failed;
  const showShimmer = !isTerminal && animated && shimmer;
  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
      data-live-activity-intent={intent ? "" : undefined}
    >
      <LiveActivityContent
        label={label}
        intent={intent}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        announceFailure={failed}
        active={animated && (isTerminal || !shimmer)}
      />
      {showShimmer ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent
            label={label}
            intent={intent}
            iconName={iconName}
            toolIcon={toolIcon}
            highlighted
          />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  intent,
  iconName,
  toolIcon,
  failed = false,
  announceFailure = false,
  active = false,
  highlighted = false,
}: {
  label: ReactNode;
  intent?: string | undefined;
  iconName: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  active?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(iconName, toolIcon);
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const terminalThinking = isTerminal && active && iconName === "brain" && label === "Thinking";
  const labelClassName = cn(
    isTerminal
      ? "block truncate terminal-live-activity-label"
      : "flex min-w-0 items-baseline gap-1.5",
    highlighted && "text-foreground",
    active && "live-tool-shine",
  );
  // Terminal names the step's intent in its legend; the others trail it on the line.
  const labelText =
    typeof label === "string" ? (
      <RollingText text={label} className={isTerminal ? labelClassName : "min-w-0 truncate"} />
    ) : (
      <span className={isTerminal ? labelClassName : "min-w-0 truncate"}>{label}</span>
    );

  return (
    <WorkLogRow
      icon={
        isTerminal ? (
          active || failed ? (
            <span
              className="terminal-live-status-glyph"
              data-terminal-status={failed ? "failed" : "running"}
              role={announceFailure ? "img" : undefined}
              aria-label={announceFailure ? "Tool call failed" : undefined}
            >
              {active ? terminalThinking ? <ThinkingPulse /> : <TerminalSpinner /> : "✘"}
            </span>
          ) : iconName ? (
            <span className="terminal-live-status-glyph">
              <ToolActivityIconView
                icon={toolIcon}
                fallbackName={iconName}
                className="block size-4 shrink-0 stroke-2"
                muted
              />
            </span>
          ) : null
        ) : iconName ? (
          <span
            className={cn(
              "flex size-4 items-center justify-center",
              failed
                ? failedToolIconClassName
                : highlighted
                  ? "text-foreground"
                  : "text-icon-muted",
            )}
            role={announceFailure ? "img" : undefined}
            aria-label={announceFailure ? "Tool call failed" : undefined}
          >
            <ToolActivityIconView
              icon={toolIcon}
              fallbackName={iconName}
              className="block size-4 shrink-0 stroke-2"
              muted={!highlighted}
            />
          </span>
        ) : null
      }
      label={
        isTerminal ? (
          labelText
        ) : (
          <span className={labelClassName}>
            <ShimmerLayers active={active} copyClassName="flex min-w-0 items-baseline gap-1.5">
              {labelText}
              <ToolIntentTag intent={intent} />
            </ShimmerLayers>
          </span>
        )
      }
      trailing={
        isTerminal ? null : showTrailingFailureMark ? (
          <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
        ) : null
      }
    />
  );
}

/** The thread a `t3_thread_read` call targets, titled from live shell state so renames show. */
function useThreadReadTarget(entry: TimelineWorkEntry, environmentId: EnvironmentId) {
  const rawThreadId = threadReadTargetId(entry);
  const threadId = rawThreadId === null ? null : ThreadId.make(rawThreadId);
  const shell = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const title = threadReadTargetTitle(shell);
  return threadId && title ? { threadId, title } : null;
}

function threadReadLabel(label: string, target: ReturnType<typeof useThreadReadTarget>) {
  const prefix = target && threadReadLabelPrefix(label);
  return prefix ? { ...target, prefix, text: `${prefix} “${target.title}”` } : null;
}

/** Only settled rows link the title; the live row is itself a button. */
function ThreadReadLabel({
  label,
  environmentId,
  linked,
}: {
  label: NonNullable<ReturnType<typeof threadReadLabel>>;
  environmentId: EnvironmentId;
  linked: boolean;
}) {
  return (
    <span className="flex min-w-0">
      <span className="shrink-0">{label.prefix} “</span>
      {linked ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: label.threadId }}
          className="min-w-0 truncate rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={stopRowToggle}
          onKeyDown={stopRowToggle}
        >
          {label.title}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{label.title}</span>
      )}
      <span className="shrink-0">”</span>
    </span>
  );
}

function LiveWorkEntryTimelineRow({
  row,
  terminalThoughtIsStable = false,
}: {
  row: Extract<TimelineRow, { kind: "work-live" }>;
  terminalThoughtIsStable?: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const threadTarget = useThreadReadTarget(row.entry, ctx.activeThreadEnvironmentId);
  const questionHeading = row.entry.questionAnswer
    ? getQuestionTextPreview(row.entry.questionAnswer)
    : "";
  // A group header names the group ("Exploring 4 files"); its newest step is listed beneath.
  const groupLabel = row.groupedEntries.length > 1 ? row.summary : null;
  const label =
    questionHeading || groupLabel || liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const threadLabel = groupLabel === null ? threadReadLabel(label, threadTarget) : null;
  // The step underway, in the agent's words: a group's tag rolls on with each new step.
  const stepIntent =
    questionHeading || !workLogEntryIsToolLike(row.entry)
      ? undefined
      : workEntryPresentation(row.entry).intent;
  const intent = stepIntent === label ? undefined : stepIntent;
  // The open group lists the same files, so the sub-line only shows while closed.
  const subline = row.expanded ? undefined : row.subline;
  const groupIconEntry =
    groupLabel === null
      ? undefined
      : row.groupedEntries.find((entry) => entry.itemType !== "reasoning");
  const iconName =
    groupLabel === null
      ? workEntryIconName(row.entry)
      : toolGroupSummaryIconName(toolGroupSummaryKind(row.groupedEntries));
  const toolIcon =
    groupLabel === null
      ? (row.entry.toolIcon ?? row.entry.toolSource?.icon)
      : (groupIconEntry?.toolIcon ?? groupIconEntry?.toolSource?.icon);

  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  const thoughtLine =
    row.thought && !row.expanded
      ? isTerminal
        ? (row.thought.detail ?? "")
        : liveThoughtLine(row.thought.detail ?? "")
      : "";
  const terminalThoughtTrace =
    isTerminal && !terminalThoughtIsStable && row.thought && !row.expanded ? (
      <div data-terminal-thinking-trace="true">
        <ReasoningTraceContent entries={[row.thought]} />
      </div>
    ) : null;
  // While the thought itself streams, the status line just says Thinking.
  const thoughtIsStatus = thoughtLine !== "" && row.entry === row.thought;
  const reasoningTrace =
    !terminalThoughtIsStable &&
    row.entry.itemType === "reasoning" &&
    groupLabel === null &&
    !thoughtIsStatus ? (
      isTerminal ? (
        <div data-terminal-thinking-trace="true">
          <ReasoningTraceContent entries={[row.entry]} />
        </div>
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, [remarkThoughtPreview, row.active ? "Thinking" : "Thought"]]}
        >
          {row.entry.detail ?? label}
        </ReactMarkdown>
      )
    ) : null;

  const liveRowContent = (
    <>
      {terminalThoughtTrace ? (
        terminalThoughtTrace
      ) : thoughtLine && !terminalThoughtIsStable ? (
        <WorkLogRow
          icon={
            <span className="flex size-4 items-center justify-center text-icon-muted">
              <ToolActivityIconView
                icon={undefined}
                fallbackName="brain"
                className="block size-4 shrink-0 stroke-2"
                muted
              />
            </span>
          }
          label={<span className="line-clamp-4">{thoughtLine}</span>}
          wrapLabel
        />
      ) : null}
      <LiveActivityRow
        label={
          thoughtIsStatus ? (
            row.active ? (
              "Thinking"
            ) : (
              "Thought"
            )
          ) : row.entry.questionAnswer && hasQuestionAnswer(row.entry.questionAnswer) ? (
            <span className="flex min-w-0 gap-1.5">
              <span className="min-w-0 truncate">{label}</span>
              <span className="min-w-0 truncate text-foreground">
                {getQuestionAnswerPreview(row.entry.questionAnswer)}
              </span>
            </span>
          ) : row.entry.itemType === "reasoning" && groupLabel === null ? (
            terminalThoughtIsStable && !thoughtIsStatus ? (
              row.active ? (
                "Thinking"
              ) : (
                "Thought"
              )
            ) : (
              reasoningTrace
            )
          ) : threadLabel ? (
            <ThreadReadLabel
              label={threadLabel}
              environmentId={ctx.activeThreadEnvironmentId}
              linked={false}
            />
          ) : groupLabel !== null && row.diffStats ? (
            <DiffStatSummary text={groupLabel} diffStats={row.diffStats} />
          ) : (
            label
          )
        }
        intent={intent}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        active={row.active}
      />
      {subline ? (
        <span className="block max-w-full truncate pl-6 font-mono text-2xs text-muted-foreground">
          {subline}
        </span>
      ) : null}
    </>
  );
  return isTerminal ? (
    <div
      className="terminal-live-work-row"
      data-terminal-live-work="true"
      data-t3-part="timeline-tool-call"
    >
      {liveRowContent}
      {row.active ? (
        <span className="terminal-live-elapsed" aria-label="Elapsed time">
          <WorkingTimer createdAt={row.createdAt} workCompletedAt={null} />
        </span>
      ) : null}
    </div>
  ) : (
    <button
      type="button"
      className={cn(
        "group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        thoughtLine || subline ? "flex-col items-start" : "min-h-6 items-center",
      )}
      data-t3-part="timeline-tool-call"
      aria-label={
        failed
          ? `${thoughtLine ? `${thoughtLine} ` : ""}${threadLabel?.text ?? label}, tool call failed`
          : undefined
      }
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id, row.expanded)}
    >
      {liveRowContent}
    </button>
  );
}

function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
    case "watch-pr":
    case "unwatch-pr":
      return "pull-request";
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "thread-create":
      return "t3-code";
    case "browser":
      return "browser";
    case "device":
      return "device";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "reasoning":
      return "brain";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkGroupHeader
      label={row.summary}
      intent={row.intent}
      diffStats={row.diffStats}
      subline={row.expanded ? undefined : row.subline}
      iconName={row.summaryToolIcon ?? row.toolSurface ?? toolGroupSummaryIconName(row.summaryKind)}
      toolIcon={row.toolIcon}
      failed={row.hasFailure}
      expanded={row.expanded}
      createdAt={row.createdAt}
      timestampFormat={ctx.timestampFormat}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id, row.expanded)}
    />
  );
}

function WorkGroupHeader(props: {
  label: string;
  /** The agent's own description of the group's calls, trailing the label. */
  intent?: string | undefined;
  /** The label's trailing `+n −m`, drawn in the diff colours. */
  diffStats?: DiffStats | undefined;
  /** `└ a.ts, b.ts, +4` under an Explored row. */
  subline?: string | undefined;
  iconName: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean | undefined;
  active?: boolean | undefined;
  expanded: boolean;
  createdAt: string;
  timestampFormat: TimestampFormat;
  onToggle: () => void;
}) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const intent = isTerminal ? undefined : props.intent;
  const accessibleLabel = intent ? `${props.label}, ${intent}` : props.label;
  return (
    <WorkLogButton
      data-t3-part="timeline-tool-call"
      ref={props.active && !props.failed ? observeVisibleAnimation : undefined}
      aria-label={props.failed ? `${accessibleLabel}, tool call failed` : accessibleLabel}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      icon={
        props.active && !props.failed && !props.toolIcon && props.iconName === "globe" ? (
          // The globe draws in currentColor; its host carries the icon tone.
          <span className="flex text-icon-muted">
            <SpinningGlobe className="size-4 shrink-0" />
          </span>
        ) : (
          <ToolActivityIconView
            icon={props.toolIcon}
            fallbackName={props.iconName}
            className="size-4 shrink-0 stroke-2 text-icon-muted"
            muted
          />
        )
      }
      label={
        <span className="terminal-work-group-label block min-w-0">
          <span
            className={cn(
              "flex min-w-0 items-baseline gap-1.5",
              props.active && !props.failed && "live-tool-shine",
            )}
          >
            <ShimmerLayers
              // Terminal holds its group labels still.
              active={Boolean(props.active && !props.failed && !isTerminal)}
              copyClassName="flex min-w-0 items-baseline gap-1.5"
            >
              <span className="min-w-0 truncate">
                <DiffStatSummary text={props.label} diffStats={props.diffStats} />
              </span>
              <ToolIntentTag intent={intent} />
            </ShimmerLayers>
          </span>
          {props.subline ? (
            <span className="block truncate font-mono text-sm leading-5 text-muted-foreground">
              {props.subline}
            </span>
          ) : null}
        </span>
      }
      trailing={
        <TimelineRowTimestamp createdAt={props.createdAt} timestampFormat={props.timestampFormat} />
      }
    />
  );
}

/**
 * The plan docked under a prompt while its turn works. When the turn settles
 * the list moves into the recap under the answer, so this one folds away.
 */
function DockedTodoPlan({
  plan,
  live,
}: {
  plan: Extract<TimelineRow, { kind: "message" }>["plan"];
  live: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const presence = usePresence(plan !== undefined);
  const [shownPlan, setShownPlan] = useState(plan);
  if (plan !== undefined && shownPlan !== plan) setShownPlan(plan);
  if (!presence.mounted || shownPlan === undefined) return null;
  return (
    // Only the fold-away animates; a plan that mounts or arrives appears in place.
    <ActivityDisclosurePanel open={presence.shown} instant={presence.shown}>
      <CursorTodoPanel
        plan={shownPlan}
        live={live}
        disclosureCache={ctx.workGroupViewState.expandedEntries}
      />
    </ActivityDisclosurePanel>
  );
}

function AssistantTurnRecap({ recap, entering }: { recap: TurnRecapModel; entering: boolean }) {
  const ctx = use(TimelineRowCtx);
  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);

  return (
    <TurnRecap
      recap={recap}
      entering={entering}
      disclosureCache={ctx.workGroupViewState.expandedEntries}
      resolvedTheme={ctx.resolvedTheme}
      onOpenFile={(path) => {
        // A checkpoint has the turn's diff; edit steps alone only name the file.
        if (recap.checkpoint) ctx.onOpenTurnDiff(recap.runId, path);
        else if (ctx.threadRef) useRightPanelStore.getState().openFile(ctx.threadRef, path);
      }}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot:
              thread?.worktreePath == null
                ? activeProject?.repositoryIdentity?.rootPath
                : undefined,
          },
          event,
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

function UserMessageMentionChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "mention" }>;
  copyMarkdown: string;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            render={<button type="button" />}
            aria-label={`Preview ${props.record.path}`}
            data-markdown-copy={props.copyMarkdown}
            onClick={() => {
              if (ctx.threadRef)
                useRightPanelStore.getState().openFile(ctx.threadRef, props.record.path);
            }}
          >
            <PierreEntryIcon
              pathValue={props.record.path}
              kind={inferEntryKindFromPath(props.record.path)}
              theme={ctx.resolvedTheme}
            />
            <ContextChipLabel>{props.record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup>{props.record.path}</TooltipPopup>
    </Tooltip>
  );
}

function UserMessageContextChip(props: {
  icon: ReactNode;
  label: string;
  kindLabel?: string;
  copyMarkdown: string;
  tooltip?: string;
  kind: ContextChipKind;
}) {
  return (
    <ContextChipShell
      kind={props.kind}
      icon={props.icon}
      label={props.label}
      aria-label={props.kindLabel ? `${props.kindLabel}, ${props.label}` : undefined}
      data-markdown-copy={props.copyMarkdown}
      tooltip={props.tooltip}
    />
  );
}

function UserMessagePullRequestContextChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "review-comment" }>;
  copyMarkdown: string;
  kind: ContextChipKind;
}) {
  const { activeThreadEnvironmentId, openPullRequest } = use(TimelineRowCtx);
  const metadata = props.record.pullRequest;
  if (metadata === undefined) return null;
  return (
    <PullRequestChip
      metadata={metadata}
      environmentId={activeThreadEnvironmentId}
      label={reviewCommentContextLabel(props.record)}
      kindLabel={pullRequestContextKindLabel(props.record)}
      kind={props.kind}
      copyMarkdown={props.copyMarkdown}
      onOpen={openPullRequest}
    />
  );
}

function UserMessagePreviewAnnotationDetails(props: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  image: ChatImageAttachment | null;
}) {
  const ctx = use(TimelineRowCtx);
  const visibleElements = props.record.elements ?? [];
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="block max-h-64 w-full cursor-zoom-in overflow-hidden border-b border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="max-h-64 w-full object-contain"
          />
        </button>
      ) : (
        <div className="border-b border-border/70 bg-muted/40 px-3 py-2 text-secondary-label text-xs">
          Screenshot unavailable
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        <div className="text-message-foreground text-xs font-medium">
          {props.record.pageTitle?.trim() || props.record.pageUrl || "Preview annotation"}
        </div>
        {props.record.comment ? (
          <div className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">
            {props.record.comment}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-secondary-label text-3xs">
          {props.record.targetSummary ? (
            <span className="truncate">{props.record.targetSummary}</span>
          ) : null}
          {(props.record.styleChanges?.length ?? 0) > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.record.styleChanges?.length ?? 0}
            </span>
          ) : null}
        </div>
        {visibleElements.length > 0 ? (
          <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
            {visibleElements.map((element) => {
              const source = element.source;
              const sourceLabel = source?.fileName
                ? `${source.fileName}${source.lineNumber === null ? "" : `:${source.lineNumber}`}`
                : null;
              return (
                <div
                  key={`${element.selector}\u0000${element.tagName}\u0000${sourceLabel ?? ""}\u0000${element.htmlPreview}`}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <code className="truncate text-message-foreground">
                      {element.selector || `<${element.tagName}>`}
                    </code>
                    {sourceLabel ? (
                      <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
                    ) : null}
                  </div>
                  {element.htmlPreview?.trim() ? (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1.5 text-3xs leading-relaxed">
                      {element.htmlPreview.trim()}
                    </pre>
                  ) : null}
                </div>
              );
            })}
            {(props.record.elements?.length ?? 0) > visibleElements.length ? (
              <div className="text-secondary-label text-3xs">
                {(props.record.elements?.length ?? 0) - visibleElements.length} more selected
                elements
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMessageElementDetails({
  record,
}: {
  record: Extract<KnownComposerContextRecord, { kind: "element" }>;
}) {
  const sourceLabel = record.source?.fileName
    ? `${record.source.fileName}${record.source.lineNumber === null ? "" : `:${record.source.lineNumber}`}`
    : null;
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      <div className="border-b border-border/70 px-3 py-2.5">
        <div className="truncate text-message-foreground text-xs font-medium">
          {record.pageTitle?.trim() || record.pageUrl}
        </div>
        <div className="mt-0.5 truncate text-secondary-label text-3xs">{record.pageUrl}</div>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <code className="truncate text-message-foreground">
            {record.selector || `<${record.tagName}>`}
          </code>
          {sourceLabel ? (
            <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
          ) : null}
        </div>
        {record.htmlPreview?.trim() ? (
          <div className="flex h-40 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="element.html" text={record.htmlPreview} />
          </div>
        ) : null}
        {record.styles?.trim() ? (
          <div className="flex h-32 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="styles.css" text={record.styles} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface UserMessageContextRenderContext {
  reference: ChatMarkdownContextReference;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  resolvedTheme: "light" | "dark";
  copyMarkdown: string;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}

function UnavailableUserMessageContextChip(props: UserMessageContextRenderContext) {
  return (
    <UnresolvedChip
      label={props.reference.label}
      copyMarkdown={props.copyMarkdown}
      tooltip="This context is no longer available."
    />
  );
}

const userMessageContextPresentationRegistry = createContextPresentationRegistry<
  KnownComposerContextRecord,
  UserMessageContextRenderContext,
  ReactNode
>({
  requiredKinds: COMPOSER_CONTEXT_KINDS,
  handlers: [
    {
      kind: "mention",
      canRender: (record) => record.kind === "mention",
      render: (record, context) =>
        record.kind === "mention" ? (
          <UserMessageMentionChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "skill",
      canRender: (record) => record.kind === "skill",
      render: (record, context) =>
        record.kind === "skill" ? (
          <UserMessageContextChip
            icon={<SkillChipIcon />}
            label={record.label || record.name}
            kindLabel="Skill"
            tooltip={`$${record.name}`}
            copyMarkdown={context.copyMarkdown}
            kind="skill"
          />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "thread",
      canRender: (record) => record.kind === "thread",
      render: (record, context) =>
        record.kind === "thread" ? (
          <ThreadContextChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "image",
      canRender: (record, context) =>
        record.kind === "image" &&
        context.attachment !== null &&
        isImageAttachment(context.attachment),
      render: (record, context) => {
        if (
          record.kind !== "image" ||
          context.attachment === null ||
          !isImageAttachment(context.attachment)
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        return (
          <ImageChipButton
            name={record.name}
            previewUrl={attachment.previewUrl}
            size={formatAttachmentSize(record.sizeBytes)}
            data-markdown-copy={context.copyMarkdown}
            onClick={() => context.onExpandImage(attachment)}
          />
        );
      },
    },
    {
      kind: "file",
      // A file chip names its attachment by id, so it renders whatever came back under that id.
      // `isFileAttachment` excludes pictures, which a legacy `file` attachment may still be.
      canRender: (record, context) =>
        record.kind === "file" && context.attachment !== null && context.attachment.type === "file",
      render: (record, context) => {
        if (
          record.kind !== "file" ||
          context.attachment === null ||
          context.attachment.type !== "file"
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        const isVideo = isVideoAttachment(attachment);
        const disabled =
          attachment.downloadable === false && (!isVideo || attachment.previewUrl === undefined);
        const size = formatAttachmentSize(record.sizeBytes);
        return (
          <FileChip
            name={record.name}
            size={size}
            isVideo={isVideo}
            theme={context.resolvedTheme}
            disabled={disabled}
            accessibleLabel={`${isVideo ? "Video" : "File"} attachment, ${record.name}, ${size}`}
            copyMarkdown={context.copyMarkdown}
            onOpen={() =>
              isVideo ? context.onExpandVideo(attachment) : context.onOpenFile(attachment)
            }
            tooltip={`${record.name}\n${size}`}
          />
        );
      },
    },
    {
      kind: "terminal",
      canRender: (record) => record.kind === "terminal",
      render: (record, context, definition) =>
        record.kind === "terminal" ? (
          <span data-markdown-copy={context.copyMarkdown}>
            <TerminalContextInlineChip
              label={record.label}
              terminalLabel={record.terminalLabel}
              lineStart={record.lineStart}
              lineEnd={record.lineEnd}
              text={record.text}
              detailsMode={definition.capabilities.details}
            />
          </span>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "element",
      canRender: (record) => record.kind === "element",
      render: (record, context) =>
        record.kind === "element" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`Browser element, ${record.label}`}
            kind="element"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessageElementDetails record={record} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "review-comment",
      canRender: (record) => record.kind === "review-comment",
      render: (record, context) => {
        if (record.kind !== "review-comment") {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const isPullRequest = isPullRequestSummaryContext(record);
        const label = reviewCommentContextLabel(record);
        const kindLabel = isPullRequest ? pullRequestContextKindLabel(record) : "Review comment";
        const pullRequestState = pullRequestContextDisplayState(record) ?? "unknown";
        if (isPullRequest && record.pullRequest !== undefined) {
          return (
            <UserMessagePullRequestContextChip
              record={record}
              copyMarkdown={context.copyMarkdown}
              kind={PULL_REQUEST_CHIP_KINDS[pullRequestState]}
            />
          );
        }
        return (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`${kindLabel}, ${label}${record.pullRequest ? `, ${record.pullRequest.title}` : ""}`}
            kind={isPullRequest ? PULL_REQUEST_CHIP_KINDS[pullRequestState] : "review-comment"}
            icon={isPullRequest ? <PullRequestGlyph.pullRequest /> : <MessageCircleIcon />}
            label={label}
          >
            <UserMessageReviewCommentCard
              comment={{
                id: record.contextId,
                sectionId: record.sectionId,
                sectionTitle: record.sectionTitle,
                filePath: record.filePath,
                startIndex: record.startIndex,
                endIndex: record.endIndex,
                rangeLabel: record.rangeLabel,
                text: record.text,
                diff: record.diff,
                ...(record.fenceLanguage !== undefined
                  ? { fenceLanguage: record.fenceLanguage }
                  : {}),
                ...(record.pullRequest !== undefined ? { pullRequest: record.pullRequest } : {}),
              }}
            />
          </UserMessageContextPopover>
        );
      },
    },
    {
      kind: "preview-annotation",
      canRender: (record) => record.kind === "preview-annotation",
      render: (record, context) =>
        record.kind === "preview-annotation" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`Preview annotation, ${record.label}`}
            kind="preview-annotation"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessagePreviewAnnotationDetails record={record} image={context.annotationImage} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
  ],
  fallback: (_kind, _record, context) => <UnavailableUserMessageContextChip {...context} />,
});

/** One inline context chip in a sent message, dispatched by the shared presentation registry. */
function UserMessageContextReferenceChip(props: {
  reference: ChatMarkdownContextReference;
  record: KnownComposerContextRecord | undefined;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const copyMarkdown = formatComposerContextReference({
    kind: props.reference.kind,
    contextId: props.reference.contextId as ComposerContextId,
    label: props.reference.label,
  });
  return (
    <span className="contents" data-thread-find-ignore>
      {userMessageContextPresentationRegistry.render(props.reference.kind, props.record, {
        reference: props.reference,
        annotationImage: props.annotationImage,
        attachment: props.attachment,
        resolvedTheme,
        copyMarkdown,
        onExpandImage: props.onExpandImage,
        onExpandVideo: props.onExpandVideo,
        onOpenFile: props.onOpenFile,
      })}
    </span>
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  collapsible?: boolean;
  footer?: ReactNode;
}) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse =
    props.collapsible !== false &&
    !isTerminal &&
    hasVisibleBody &&
    shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            renderContextReference={props.renderContextReference}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  renderContextReference?: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
      parseRawHtml={false}
      renderContextReference={props.renderContextReference}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-2xs text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" && (
        <DiffWorkerPoolProvider>
          {renderablePatch.files.map((fileDiff) => (
            <FileDiff
              key={resolveFileDiffPath(fileDiff)}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                theme: resolveDiffThemeName(ctx.resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
              }}
            />
          ))}
        </DiffWorkerPoolProvider>
      )}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Content-stable projection of the runs the handoff rows read. The incoming
 *  array is rebuilt on every projection event (status/timestamp churn), but
 *  the returned reference only changes when a run's identity-relevant fields
 *  (id, ordinal, instance, model) do — keeping TimelineRowCtx stable. */
function useStableHandoffRuns(
  runs: ReadonlyArray<HandoffTimelineRun>,
): ReadonlyArray<HandoffTimelineRun> {
  const prev = useRef<{
    signature: string;
    value: ReadonlyArray<HandoffTimelineRun>;
  }>({ signature: "", value: EMPTY_TIMELINE_RUNS });
  return useMemo(() => {
    const signature = runs
      .map(
        (run) =>
          `${run.id}\0${run.providerInstanceId}\0${run.ordinal}\0${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
      )
      .join("\n");
    if (signature === prev.current.signature) {
      return prev.current.value;
    }
    const value = runs.map((run) => ({
      id: run.id,
      ordinal: run.ordinal,
      providerInstanceId: run.providerInstanceId,
      modelSelection: run.modelSelection,
    }));
    prev.current = { signature, value };
    return value;
  }, [runs]);
}
function useStableTimelineRunTimings(
  runs: ReadonlyArray<TimelineProjectionRun>,
): ReadonlyMap<RunId, TimelineRunTiming> {
  const previous = useRef<{
    runs: ReadonlyArray<TimelineProjectionRun>;
    value: ReadonlyMap<RunId, TimelineRunTiming>;
  }>({
    runs: EMPTY_TIMELINE_RUNS,
    value: EMPTY_TIMELINE_RUN_TIMINGS_BY_ID,
  });
  return useMemo(() => {
    let unchanged = runs.length === previous.current.runs.length;
    if (unchanged) {
      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index]!;
        const previousRun = previous.current.runs[index]!;
        const startedAt = run.workStartedAt ?? run.startedAt ?? run.requestedAt ?? null;
        const previousStartedAt =
          previousRun.workStartedAt ?? previousRun.startedAt ?? previousRun.requestedAt ?? null;
        const completedAt = run.completedAt ?? null;
        const previousCompletedAt = previousRun.completedAt ?? null;
        const workCompletedAt = run.workCompletedAt ?? null;
        const previousWorkCompletedAt = previousRun.workCompletedAt ?? null;
        const sameStartedAt =
          startedAt === null
            ? previousStartedAt === null
            : previousStartedAt !== null &&
              DateTime.toEpochMillis(startedAt) === DateTime.toEpochMillis(previousStartedAt);
        const sameCompletedAt =
          completedAt === null
            ? previousCompletedAt === null
            : previousCompletedAt !== null &&
              DateTime.toEpochMillis(completedAt) === DateTime.toEpochMillis(previousCompletedAt);
        const sameWorkCompletedAt =
          workCompletedAt === null
            ? previousWorkCompletedAt === null
            : previousWorkCompletedAt !== null &&
              DateTime.toEpochMillis(workCompletedAt) ===
                DateTime.toEpochMillis(previousWorkCompletedAt);
        if (
          run.id !== previousRun.id ||
          !sameStartedAt ||
          !sameCompletedAt ||
          !sameWorkCompletedAt
        ) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) {
      previous.current.runs = runs;
      return previous.current.value;
    }

    const value = new Map<RunId, TimelineRunTiming>();
    for (const run of runs) {
      const startedAt = run.workStartedAt ?? run.startedAt ?? run.requestedAt ?? null;
      if (startedAt === null) continue;
      value.set(run.id, {
        startedAt: DateTime.formatIso(startedAt),
        completedAt: run.completedAt == null ? null : DateTime.formatIso(run.completedAt),
        workCompletedAt:
          run.workCompletedAt == null ? null : DateTime.formatIso(run.workCompletedAt),
      });
    }
    previous.current.runs = runs;
    previous.current.value = value;
    return value;
  }, [runs]);
}

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[], identity: string): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });
  const prevIdentity = useRef(identity);

  return useMemo(() => {
    const previous =
      prevIdentity.current === identity
        ? prevState.current
        : { byId: new Map<string, MessagesTimelineRow>(), result: [] };
    prevIdentity.current = identity;
    const nextState = computeStableMessagesTimelineRows(rows, previous);
    prevState.current = nextState;
    return nextState.result;
  }, [identity, rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type WorkEntryIconName =
  | "bot"
  | "brain"
  | "browser"
  | "check"
  | "circle-alert"
  | "computer"
  | "device"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "pull-request"
  | "t3-code"
  | "wrench"
  | "x"
  | "zap";

function BrowserAppIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <circle cx="7.4" cy="7.2" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11.2 7.2h4.3" />
      <path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ToolActivityIconView(props: {
  icon: ToolActivityIcon | undefined;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const fallbackClassName = cn(props.className, props.muted && "opacity-70 light:brightness-60");
  if (!props.icon) {
    return <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />;
  }
  if (props.icon._tag === "website") {
    const src = toolActivityFaviconUrl(props.icon, resolvedTheme, 32);
    return src ? (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    ) : (
      <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />
    );
  }
  if (props.icon._tag === "themed-logo") {
    const src =
      resolvedTheme === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      app={props.icon.app}
      fallbackName={props.fallbackName}
      className={cn(props.className, "size-5")}
      muted={props.muted}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  app: Extract<ToolActivityIcon, { readonly _tag: "native-app" }>["app"];
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const asset = useAssetUrlState(activeThreadEnvironmentId, {
    _tag: "native-app-icon",
    app: props.app,
  });
  if (asset._tag !== "Success") {
    return (
      <WorkEntryIcon
        name={props.fallbackName}
        className={cn(props.className, props.muted && "opacity-70 light:brightness-60")}
      />
    );
  }
  const cacheKey = getProjectFaviconCacheKey(
    activeThreadEnvironmentId,
    JSON.stringify(props.app),
    asset.url,
  );
  return (
    <ToolActivityImageIcon
      key={cacheKey}
      cacheKey={cacheKey}
      src={asset.url}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

const loadedToolActivityIconSrcs = new Map<string, string>();

function ToolActivityImageIcon(props: {
  cacheKey: string;
  src: string;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedToolActivityIconSrcs.get(props.cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== props.src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedToolActivityIconSrcs.get(props.cacheKey) === failedSrc) {
      loadedToolActivityIconSrcs.delete(props.cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };
  return (
    <>
      {displayedSrc === null ? (
        <WorkEntryIcon
          name={props.fallbackName}
          className={cn(props.className, props.muted && "opacity-70 light:brightness-60")}
        />
      ) : null}
      {displayedSrc ? (
        <span
          className={cn(
            props.className,
            "inline-block overflow-hidden rounded-xs bg-background",
            props.muted && "opacity-70",
          )}
        >
          <img
            src={displayedSrc}
            alt=""
            aria-hidden
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn("block size-full object-contain", props.muted && "light:brightness-60")}
            onError={() => handleLoadError(displayedSrc)}
          />
        </span>
      ) : null}
      {isLoading ? (
        <img
          src={props.src}
          alt=""
          aria-hidden
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden"
          onLoad={() => {
            loadedToolActivityIconSrcs.set(props.cacheKey, props.src);
            setDisplayedSrc(props.src);
          }}
          onError={() => handleLoadError(props.src)}
        />
      ) : null}
    </>
  );
}

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "pull-request":
      return <PullRequestGlyph.pullRequest className={className} aria-hidden />;
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "browser":
      return <BrowserAppIcon className={className} />;
    case "computer":
      return <ComputerUseAppIcon className={className} />;
    case "device":
      return <SmartphoneIcon className={className} aria-hidden />;
    case "t3-code":
      return <T3Wordmark className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "brain",
      className: "text-icon-muted",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) {
    const input =
      workEntry.structuredPayload?.type === "dynamic_tool"
        ? workEntry.structuredPayload.input
        : workEntry.toolData !== null &&
            typeof workEntry.toolData === "object" &&
            "input" in workEntry.toolData
          ? workEntry.toolData.input
          : undefined;
    if (input !== undefined) addBlock(`Tool input\n${JSON.stringify(input, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const detail = workEntry.detail?.trim();
  if (detail !== viewedImagePath?.trim()) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.structuredPayload?.type === "notification") {
    if (workEntry.structuredPayload.outcome === "failed") return "circle-alert";
    const source = workEntry.structuredPayload.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "bot";
      case "command":
        return "terminal";
      case "monitor":
        return "eye";
      case "background_task":
        return "zap";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (workEntry.itemType === "user_input_request" || workEntry.itemType === "approval_request") {
    return "message-circle";
  }
  if (workEntry.toolSurface) return workEntry.toolSurface;
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

function ReasoningEntryContent(props: {
  readonly entry: TimelineWorkEntry;
  readonly isStreaming: boolean;
  readonly reducedMotion: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const streamWordFade = use(TranscriptStyleCtx) !== "terminal";
  const text = props.entry.detail ?? "";
  const visibleText = useStreamingReveal(text, {
    identity: props.entry.id,
    streaming: props.isStreaming,
    reducedMotion: props.reducedMotion,
  });
  const markdown = (
    <ChatMarkdown
      key={props.entry.id}
      text={visibleText}
      cwd={ctx.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={ctx.skills}
      isStreaming={props.isStreaming}
      streamWordFade={streamWordFade}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
      onUseArtifactTemplate={ctx.onUseArtifactTemplate}
      onImageExpand={ctx.onImageExpand}
      lineBreaks
    />
  );
  // Keep the scroller mounted across completion so the markdown subtree is reused.
  return (
    <div
      className="cursor-thinking-scroller"
      data-streaming={props.isStreaming ? "true" : undefined}
    >
      <BottomStickScrollArea live={props.isStreaming}>{markdown}</BottomStickScrollArea>
    </div>
  );
}

function ReasoningTraceContent({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const { isWorking, latestRunId } = use(TimelineRowActivityCtx);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return (
    <WorkLogDetails>
      {entries.map((entry) => (
        <ReasoningEntryContent
          key={entry.id}
          entry={entry}
          isStreaming={
            isWorking && entry.runId === latestRunId && entry.toolLifecycleStatus === "inProgress"
          }
          reducedMotion={reducedMotion}
        />
      ))}
    </WorkLogDetails>
  );
}

type WorkEntryRowProps = {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
  hideReasoningHeader?: boolean | undefined;
  forceReasoningOpen?: boolean | undefined;
  reasoningIsSuperseded?: boolean | undefined;
};
function isToolWorkEntry(workEntry: TimelineWorkEntry): boolean {
  if (workEntry.nativeTerminalFallback !== undefined) return false;
  if (workEntry.questionAnswer !== undefined) return false;
  const itemType = workEntry.itemType ?? workEntry.projectedItem?.item.type;
  if (itemType !== undefined) {
    return (
      itemType === "command_execution" ||
      itemType === "file_change" ||
      itemType === "dynamic_tool" ||
      itemType === "subagent" ||
      itemType === "web_search" ||
      itemType === "file_search"
    );
  }
  return workEntry.command !== undefined || workEntry.toolData !== undefined;
}

const NO_LIFECYCLE_ITEMS: ReadonlyArray<OrchestrationV2TurnItem> = [];

type TimelineThreadTurnItemProjection = {
  readonly projection: {
    readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem> | undefined;
  };
};

const selectTimelineThreadTurnItems = (
  thread: TimelineThreadTurnItemProjection | null | undefined,
) => thread?.projection.turnItems ?? NO_LIFECYCLE_ITEMS;
const selectNoTimelineThreadTurnItems = (
  _thread: TimelineThreadTurnItemProjection | null | undefined,
) => NO_LIFECYCLE_ITEMS;

function NativeWorkflowToolTimelineRow({
  row,
}: {
  readonly row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const item = row.projectedItem.item;
  // A live wait reconciles its jobs with lifecycle items; a thread wait reads
  // its delegated child from them even once settled, since it has no snapshot.
  const readsLifecycle =
    isT3ThreadWait(item) || (isNativeWaitTool(item) && isOrchestrationV2WorkActive(item.status));
  const lifecycleItems = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(ctx.activeThreadEnvironmentId, item.threadId),
    ),
    readsLifecycle ? selectTimelineThreadTurnItems : selectNoTimelineThreadTurnItems,
  );
  const workEntry = useMemo(() => projectedWorkEntry(row.projectedItem), [row.projectedItem]);
  return (
    <TimelineToolWorkEntryCard
      workEntry={workEntry}
      workspaceRoot={ctx.workspaceRoot}
      lifecycleItems={lifecycleItems}
      autoExpanded={row.autoExpanded}
      onToggleEntry={(collapsed) => ctx.onToggleWorkEntry(row.id, collapsed)}
    />
  );
}

function TimelineToolWorkEntryCard(props: {
  readonly workEntry: TimelineWorkEntry;
  readonly workspaceRoot: string | undefined;
  readonly lifecycleItems?: ReadonlyArray<OrchestrationV2TurnItem> | undefined;
  readonly autoExpanded?: boolean | undefined;
  readonly onToggleEntry?: ((collapsed: boolean) => void) | undefined;
}) {
  const { onImageExpand, activeThreadEnvironmentId, workGroupViewState, markdownCwd } =
    use(TimelineRowCtx);
  const groupView = use(WorkGroupViewCtx);
  const { seenStepIds } = use(TimelineRowMotionCtx);
  const { workEntry } = props;
  // Defined while the step should roll in: it joined its group a moment ago
  // and was not already on screen in another row.
  const [enterDelayMs] = useState(() => {
    const arrival = groupView?.arrivals.get(workEntry.id);
    return arrival !== undefined &&
      !seenStepIds.has(workEntry.id) &&
      performance.now() - arrival.at < GROUP_ARRIVAL_WINDOW_MS
      ? arrival.delayMs
      : undefined;
  });
  useEffect(() => {
    seenStepIds.add(workEntry.id);
  }, [seenStepIds, workEntry.id]);
  // The status glyph carries state; only identity marks (integrations, the KM
  // monogram on KM Code's own tools) earn a second icon beside the verb.
  const iconName = workEntryIconName(workEntry);
  const identityIcon = workEntry.toolIcon ?? workEntry.toolSource?.icon;
  const icon =
    identityIcon !== undefined ||
    iconName === "t3-code" ||
    iconName === "browser" ||
    iconName === "device" ||
    iconName === "pull-request" ? (
      <ToolActivityIconView
        icon={identityIcon}
        fallbackName={iconName}
        className="icon size-3.5 shrink-0"
        muted
      />
    ) : null;
  const detailSource =
    workEntry.projectedItem !== undefined
      ? {
          kind: "projected" as const,
          projectedItem: workEntry.projectedItem,
          environmentId: activeThreadEnvironmentId,
        }
      : undefined;

  return (
    <ToolWorkEntryCard
      environmentId={activeThreadEnvironmentId}
      entry={workEntry}
      workspaceRoot={props.workspaceRoot}
      cwd={markdownCwd ?? props.workspaceRoot}
      icon={icon}
      detailSource={detailSource}
      disclosureCache={workGroupViewState.expandedEntries}
      lifecycleItems={props.lifecycleItems}
      autoExpanded={props.autoExpanded ?? workEntry.autoExpanded}
      onToggleEntry={props.onToggleEntry ?? groupView?.onToggleEntry}
      enterDelayMs={enterDelayMs}
      onImageExpand={(source, alt) =>
        onImageExpand({ images: [{ src: source, name: alt }], index: 0 })
      }
    />
  );
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {
  const ctx = use(TimelineRowCtx);
  const item = props.workEntry.projectedItem?.item;
  if (item?.type === "approval_request") {
    const approval = ctx.pendingApprovals.get(item.requestId);
    if (approval) {
      return (
        <TimelinePendingApprovalRow
          approval={approval}
          canOperateThread={ctx.canOperateThread}
          isResponding={ctx.respondingRequestIds.includes(approval.requestId)}
          onRespondToApproval={ctx.onRespondToApproval}
        />
      );
    }
  }
  const notification = item?.type === "notification" ? item : undefined;
  const taskIds =
    notification?.source.kind === "delegated_task" ? notification.source.taskIds : undefined;
  const childThreadId =
    notification === undefined ? undefined : notificationChildThreadId(notification.source);
  if (notification !== undefined) {
    const notificationLinkProps = {
      parentRef: scopeThreadRef(ctx.activeThreadEnvironmentId, notification.threadId),
      outcome: notification.outcome,
      createdAt: props.workEntry.createdAt,
      timestampFormat: ctx.timestampFormat,
      providerStatuses: ctx.providerStatuses,
      onOpenThread: ctx.onOpenThread,
      fallback: <WorkEntryLogRow {...props} />,
    };
    if (taskIds !== undefined) {
      return <SubagentNotificationLink {...notificationLinkProps} taskIds={taskIds} />;
    }
    if (childThreadId !== undefined) {
      return <SubagentNotificationLink {...notificationLinkProps} childThreadId={childThreadId} />;
    }
  }
  if (isToolWorkEntry(props.workEntry)) {
    return (
      <TimelineToolWorkEntryCard
        workEntry={props.workEntry}
        workspaceRoot={props.workspaceRoot}
        autoExpanded={props.workEntry.autoExpanded}
        onToggleEntry={props.onToggleEntry}
      />
    );
  }
  return <WorkEntryLogRow {...props} />;
});

function WorkEntryLogRow(props: WorkEntryRowProps) {
  const { workEntry, workspaceRoot, displayLabel } = props;
  const ctx = use(TimelineRowCtx);
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const rolls = !isTerminal;
  const { threadRef, onImageExpand, timestampFormat, onOpenNativeTerminal } = ctx;
  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;
  const threadTarget = useThreadReadTarget(workEntry, ctx.activeThreadEnvironmentId);
  const createdThread =
    workEntry.projectedItem?.item.type === "thread_created"
      ? workEntry.projectedItem.item
      : undefined;
  const notifiedSubagentThreadId =
    workEntry.projectedItem?.item.type === "notification"
      ? notificationChildThreadId(workEntry.projectedItem.item.source)
      : undefined;
  const isReasoning = workEntry.itemType === "reasoning";
  const reasoningPanelId = useId();
  const groupView = use(WorkGroupViewCtx);
  const cache = groupView?.state?.expandedEntries ?? ctx.workGroupViewState.expandedEntries;
  const reasoningIsStreaming = isReasoning && workEntry.toolLifecycleStatus === "inProgress";
  const reasoningLive = reasoningIsStreaming && props.reasoningIsSuperseded !== true;
  // Keep the body's initial open state even after a tool takes over the live row.
  const defaultOpen = reasoningIsStreaming || (workEntry.autoExpanded ?? false);
  const reasoningItem = isReasoning ? workEntry.projectedItem?.item : undefined;
  const thoughtMs =
    reasoningItem?.startedAt && reasoningItem.completedAt
      ? DateTime.toEpochMillis(reasoningItem.completedAt) -
        DateTime.toEpochMillis(reasoningItem.startedAt)
      : null;
  const thoughtVerb = reasoningLive
    ? "Thinking"
    : thoughtMs === null
      ? "Thought"
      : thoughtMs < 2_000
        ? "Thought briefly"
        : `Thought for ${formatDuration(thoughtMs)}`;
  // "Thinking" hands off to its settled verb in place when the settle is seen live.
  const thoughtSettledLive = useChangedSinceMount(reasoningLive);
  // Rows that mount mid-work rise in; history and virtualized remounts stay still.
  const [enteredLive] = useState(workEntry.toolLifecycleStatus === "inProgress");
  const {
    open: disclosureOpen,
    toggle: toggleExpanded,
    onOpenChange,
    instant,
  } = useActivityDisclosure({
    cache,
    disclosureKey: workEntry.id,
    defaultOpen,
  });
  const forceReasoningOpen = isReasoning && props.forceReasoningOpen === true;
  useLayoutEffect(() => {
    if (forceReasoningOpen && !disclosureOpen) onOpenChange(true);
  }, [disclosureOpen, forceReasoningOpen, onOpenChange]);
  const expanded = forceReasoningOpen || disclosureOpen;
  const handleToggleExpanded = (event?: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    toggleExpanded(event);
    if (groupView) {
      groupView.onToggleEntry(expanded);
    } else {
      props.onToggleEntry?.(expanded);
    }
  };
  if (isTerminal && isReasoning) {
    return (
      <div data-terminal-thinking-trace="true">
        <ReasoningTraceContent entries={[workEntry]} />
      </div>
    );
  }
  const failureItem = workEntry.projectedItem?.item;
  if (failureItem?.type === "system_notice") {
    return (
      <NativeNotice
        item={failureItem}
        timestampFormat={timestampFormat}
        expanded={expanded}
        onExpandedChange={(open) => {
          if (open !== expanded) handleToggleExpanded();
        }}
      />
    );
  }
  if (failureItem?.type === "error" && failureItem.status === "failed") {
    const warning = failureItem.failure.class === "usage_limit";
    const resetAt = failureItem.failure.resetAt;
    const resetTime = resetAt ? formatUpcomingTimestamp(resetAt, timestampFormat) : null;
    const label = warning
      ? `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`
      : workEntry.label;
    const retryRunId =
      failureItem.runId !== null &&
      retryableWorkspacePreparationRunIds.has(failureItem.runId) &&
      failureItem.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
        ? failureItem.runId
        : null;
    return (
      <WorkLogRow
        data-v2-item-type="error"
        data-v2-item-visibility={workEntry.projectedItem?.visibility}
        wrapLabel
        icon={
          <CircleAlertIcon
            className={cn("size-4", warning ? "text-warning" : "text-destructive")}
          />
        }
        label={
          <span
            className={cn("text-sm font-medium", warning ? "text-warning" : "text-destructive")}
          >
            {label}
          </span>
        }
        trailing={
          <TimelineRowTimestamp
            createdAt={workEntry.createdAt}
            timestampFormat={timestampFormat}
            alwaysVisible
          />
        }
      >
        {!warning ? (
          <p className="ms-6 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
            {failureItem.failure.message}
          </p>
        ) : null}
        {retryRunId !== null && onRetryWorkspacePreparation ? (
          <div className="ms-6 pb-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onRetryWorkspacePreparation(retryRunId)}
            >
              <RotateCcwIcon aria-hidden />
              Retry
            </Button>
          </div>
        ) : null}
      </WorkLogRow>
    );
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator =
    !showWarningIndicator && workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    !showWarningIndicator &&
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon =
    showWarningIndicator || showDestructiveRowStyle
      ? undefined
      : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  // The question is the row's identity: a generic "User input submitted"
  // label buries what was asked, so lead with the question text (even over a
  // lone tool row's display label) and keep the answer as the trailing preview.
  const questionHeading = workEntry.questionAnswer
    ? getQuestionTextPreview(workEntry.questionAnswer)
    : "";
  const previewText =
    questionHeading || (displayLabel ?? workEntryDisplayLabel(workEntry, workspaceRoot));
  const answerPreview =
    workEntry.questionAnswer && hasQuestionAnswer(workEntry.questionAnswer)
      ? getQuestionAnswerPreview(workEntry.questionAnswer)
      : null;
  const viewedImagePath = workEntryViewedImagePath(workEntry);
  const payload = workEntry.structuredPayload;
  const skill =
    payload?.type === "dynamic_tool"
      ? claudeSkillInvocation(payload.toolName, payload.input)
      : undefined;
  // Reads and skills expand to plain text instead of the item inspector. A
  // skill's heading already names it, so only its arguments are left to show.
  const plainOutput =
    toolGroupAction(workEntry) === "read"
      ? workEntryReadOutput(workEntry, workspaceRoot)
      : skill
        ? (skill.args ?? null)
        : undefined;
  const viewedImage =
    viewedImagePath && threadRef
      ? resolveViewedImageAsset(viewedImagePath, {
          threadId: threadRef.threadId,
          workspaceRoot,
        })
      : null;
  const terminalFallback = workEntry.nativeTerminalFallback;
  const canExpand =
    previewText.trim().length > 0 ||
    (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) ||
    Boolean(
      workEntryRawCommand(workEntry) ||
      workEntry.command?.trim() ||
      workEntry.detail?.trim() ||
      workEntry.changedFiles?.length ||
      viewedImage,
    );
  const expandedBody =
    expanded && !isReasoning
      ? plainOutput !== undefined
        ? plainOutput
        : buildToolCallExpandedBody(
            workEntry,
            workspaceRoot,
            previewText,
            viewedImage ? viewedImagePath : null,
          )
      : null;
  // Projected rows expand to the item inspector, so only offer a disclosure
  // when it has something to show, even if that output still has to load.
  // Reads and skills still fetch the output the timeline withheld.
  const plainOutputFetches =
    plainOutput !== undefined &&
    workEntry.projectedItem !== undefined &&
    turnItemNeedsDetailFetch(workEntry.projectedItem.item);
  const canExpandProjectedItem =
    terminalFallback === undefined &&
    (plainOutput !== undefined
      ? Boolean(plainOutput || viewedImage || workEntry.questionAnswer || plainOutputFetches)
      : workEntry.projectedItem === undefined
        ? canExpand
        : isReasoning
          ? Boolean(workEntry.detail?.trim())
          : Boolean(
              viewedImage ||
              workEntry.questionAnswer ||
              turnItemHasDetail(workEntry.projectedItem.item),
            ));
  // Reserve destructive row styling for severe failures, not routine tool errors.
  const iconWrapperClass = cn(
    "flex size-4 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-icon-muted"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const threadLabel = isReasoning ? null : threadReadLabel(previewText, threadTarget);
  const accessiblePreview = [
    isReasoning ? thoughtVerb : (threadLabel?.text ?? previewText),
    answerPreview,
  ]
    .filter(Boolean)
    .join(": ");
  const accessibleDisplayText = showFailedIndicator
    ? `${accessiblePreview}, tool call failed`
    : accessiblePreview;
  const hideReasoningHeader = isReasoning && props.hideReasoningHeader === true;
  const rowToggleProps =
    canExpandProjectedItem && !hideReasoningHeader
      ? {
          role: "button" as const,
          tabIndex: 0 as const,
          "aria-label": accessibleDisplayText,
          "aria-expanded": expanded,
          "aria-controls": isReasoning ? reasoningPanelId : undefined,
          "data-instant": instant || undefined,
          onClick: handleToggleExpanded,
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggleExpanded(e);
            }
          },
        }
      : {};

  return (
    <WorkLogRow
      data-v2-item-type={workEntry.projectedItem?.item.type}
      data-v2-item-visibility={workEntry.projectedItem?.visibility}
      data-motion-enter={enteredLive || undefined}
      hideHeader={hideReasoningHeader}
      {...rowToggleProps}
      icon={
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-4 shrink-0 stroke-2"
            muted
          />
        </span>
      }
      label={
        <div
          className={cn(
            "flex min-w-0 flex-1 gap-2 overflow-hidden",
            terminalFallback ? "flex-col items-start sm:flex-row sm:items-center" : "items-center",
          )}
        >
          <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
            <span
              className={cn(
                answerPreview ? "min-w-0" : "min-w-0 flex-1",
                // A thought's open panel holds the full text, so its header stays one line.
                (expanded && !isReasoning) || terminalFallback
                  ? "whitespace-pre-wrap break-words select-text"
                  : "truncate",
                headingClass,
              )}
            >
              {isReasoning ? (
                <span
                  // Minimal rolls "Thinking" into its settled verb in place; the
                  // other styles remount it to fade the new verb in.
                  key={rolls ? "verb" : reasoningLive ? "live" : "settled"}
                  ref={reasoningLive ? observeVisibleAnimation : undefined}
                  className={cn(
                    "cursor-thinking-header",
                    reasoningLive && "cursor-subagent-shimmer",
                    thoughtSettledLive && !rolls && "motion-swap-text",
                  )}
                >
                  <ShimmerLayers active={reasoningLive} copyClassName="cursor-thinking-header">
                    <RollingText text={thoughtVerb} />
                  </ShimmerLayers>
                </span>
              ) : threadLabel ? (
                <ThreadReadLabel
                  label={threadLabel}
                  environmentId={ctx.activeThreadEnvironmentId}
                  linked
                />
              ) : (
                previewText
              )}
            </span>
            {answerPreview ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  !expanded &&
                    workEntry.questionAnswer &&
                    hasQuestionAnswer(workEntry.questionAnswer)
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {answerPreview}
              </span>
            ) : null}
          </p>
          {terminalFallback ? (
            <button
              type="button"
              className="max-w-full shrink-0 whitespace-normal rounded-md border border-border/70 px-2 py-1 text-left text-xs font-medium text-foreground transition hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              aria-label={`Open ${terminalFallback.runtime.toUpperCase()} client in terminal for provider ${terminalFallback.providerInstanceId}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenNativeTerminal(terminalFallback);
              }}
            >
              Open {terminalFallback.runtime.toUpperCase()} client in terminal
            </button>
          ) : null}
        </div>
      }
      trailing={
        <>
          {createdThread ? (
            <button
              type="button"
              className="shrink-0 rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open ${createdThread.title ?? "created thread"}`}
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(createdThread.targetThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open chat
            </button>
          ) : null}
          {notifiedSubagentThreadId ? (
            <InlineButton
              aria-label="Open subagent thread"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(notifiedSubagentThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open subagent
            </InlineButton>
          ) : null}
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryIconName, entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              terminalFallback ? "hidden" : !canExpandProjectedItem && "invisible",
            )}
            aria-hidden
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70",
                instant ? "transition-none" : "motion-chevron",
                expanded && "rotate-90",
              )}
            />
          </span>
        </>
      }
    >
      {expanded && viewedImage && threadRef ? (
        <WorkLogDetails kind="media">
          <ChatMarkdownAssetImage
            environmentId={threadRef.environmentId}
            resource={viewedImage.resource}
            alt={viewedImage.alt}
            srcFragment={viewedImage.srcFragment}
            workspaceRoot={workspaceRoot}
            maxHeightRem={16}
            onImageExpand={onImageExpand}
          />
        </WorkLogDetails>
      ) : null}
      {expanded && workEntry.questionAnswer ? (
        <QuestionAnswerHistory answer={workEntry.questionAnswer} />
      ) : null}
      {isReasoning ? (
        <ActivityDisclosurePanel
          id={reasoningPanelId}
          role="region"
          aria-label="Reasoning details"
          open={expanded}
          instant={instant}
          onClick={stopRowToggle}
        >
          <ReasoningTraceContent entries={[workEntry]} />
        </ActivityDisclosurePanel>
      ) : null}
      {expanded &&
      !isReasoning &&
      !workEntry.questionAnswer &&
      canExpandProjectedItem &&
      (expandedBody ||
        plainOutputFetches ||
        (workEntry.projectedItem && plainOutput === undefined)) ? (
        <WorkLogDetails kind="panel">
          {workEntry.projectedItem && plainOutput === undefined ? (
            <V2ItemInspector
              projectedItem={workEntry.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={workspaceRoot}
              onOpenThread={ctx.onOpenThread}
              onOpenTurnDiff={ctx.onOpenTurnDiff}
              onRollbackCheckpoint={ctx.onRollbackCheckpoint}
              onImageExpand={ctx.onImageExpand}
            />
          ) : (
            <>
              {expandedBody ? (
                <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
              ) : null}
              {plainOutputFetches && workEntry.projectedItem ? (
                <FetchedToolOutput
                  projectedItem={workEntry.projectedItem}
                  environmentId={ctx.activeThreadEnvironmentId}
                  onImageExpand={onImageExpand}
                />
              ) : null}
            </>
          )}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

function QuestionAnswerHistory({
  answer,
}: {
  answer: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const attachments = useMemo(() => Object.values(answer.attachmentsByQuestionId).flat(), [answer]);
  const resources = useMemo(
    () =>
      attachments.map((attachment) => ({
        _tag: "attachment" as const,
        attachmentId: attachment.id,
      })),
    [attachments],
  );
  const urls = useAssetUrls(activeThreadEnvironmentId, resources);
  return (
    <div className="ms-6 mt-2 space-y-2" onClick={stopRowToggle}>
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p className="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {getQuestionAnswerText(answer.answers[questionId])}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => {
              const url = urls[attachments.indexOf(attachment)];
              return (
                <a
                  key={attachment.id}
                  href={url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  {attachment.type === "image" && url ? (
                    <img
                      src={url}
                      alt={attachment.name}
                      className="h-20 max-w-32 rounded object-contain"
                    />
                  ) : (
                    attachment.name
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
