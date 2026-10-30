import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { TranscriptStyle } from "@t3tools/contracts/settings";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { useRef } from "react";

import { useTheme } from "../../hooks/useTheme";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { readTimelinePosition, rememberTimelinePosition } from "../chat/timelineScrollAnchoring";
import { TRANSCRIPT_STYLE_OPTIONS } from "../chat/transcriptStyle";

const PREVIEW_THREAD_ID = ThreadId.make("transcript-style-preview");
const PREVIEW_RUN_ID = RunId.make("transcript-style-preview-run");
const PREVIEW_ENVIRONMENT_ID = EnvironmentId.make("transcript-style-preview");

function previewItemBase(id: string, second: number) {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 9, 0, second));
  return {
    id: TurnItemId.make(id),
    threadId: PREVIEW_THREAD_ID,
    runId: PREVIEW_RUN_ID,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

// One short, finished turn exercised by every style: a prompt, a thought,
// grouped reads and a search, a command, an edit, and a markdown reply.
const PREVIEW_ITEMS: ReadonlyArray<OrchestrationV2TurnItem> = [
  {
    ...previewItemBase("preview-user", 0),
    type: "user_message",
    messageId: MessageId.make("preview-user"),
    text: "Make the web search loader feel alive.",
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  },
  {
    ...previewItemBase("preview-reasoning", 4),
    type: "reasoning",
    text: "The globe is drawn in **spinning-globe.tsx**; its motion lives in `motion.css`.",
    streaming: false,
  },
  {
    ...previewItemBase("preview-read-globe", 5),
    type: "dynamic_tool",
    toolName: "read",
    input: { path: "apps/web/src/components/ui/spinning-globe.tsx" },
    output:
      'export function SpinningGlobe({ className }) {\n  return <svg viewBox="0 0 24 24" />;\n}',
  },
  {
    ...previewItemBase("preview-read-motion", 6),
    type: "dynamic_tool",
    toolName: "read",
    input: { path: "apps/web/src/motion.css" },
    output:
      ".spinning-globe-meridian {\n  animation: spinning-globe-meridian 2.4s linear infinite;\n}",
  },
  {
    ...previewItemBase("preview-grep", 7),
    type: "dynamic_tool",
    toolName: "grep",
    input: { pattern: "SpinningGlobe", path: "apps/web/src" },
    output: "components/chat/ToolWorkEntryCard.tsx\ncomponents/chat/MessagesTimeline.tsx",
  },
  {
    ...previewItemBase("preview-command", 9),
    type: "command_execution",
    input: "vp test run spinning-globe",
    output: "✓ spinning-globe.test.tsx (3 tests)\n\nTest Files  1 passed (1)",
    exitCode: 0,
  },
  {
    ...previewItemBase("preview-edit", 12),
    type: "file_change",
    fileName: "apps/web/src/motion.css",
    additions: 2,
    deletions: 1,
    diffStr: [
      "--- a/apps/web/src/motion.css",
      "+++ b/apps/web/src/motion.css",
      "@@ -142,3 +142,4 @@",
      " .spinning-globe-meridian {",
      "-  animation: spinning-globe-meridian 2.4s linear infinite;",
      "+  animation: spinning-globe-meridian 3s linear infinite;",
      "+  stroke-opacity: 0.8;",
      " }",
    ].join("\n"),
  },
  {
    ...previewItemBase("preview-assistant", 16),
    type: "assistant_message",
    messageId: MessageId.make("preview-assistant"),
    text: [
      "The globe now turns about its axis.",
      "",
      "- Meridians sweep with an even `sin` curve",
      "- Back lines fade, so it reads as a sphere",
    ].join("\n"),
    streaming: false,
  },
];

const PREVIEW_TURN_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = PREVIEW_ITEMS.map(
  (item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: PREVIEW_THREAD_ID,
    sourceItemId: item.id,
    item,
  }),
);

const PREVIEW_TIMELINE_ENTRIES = deriveTimelineEntriesFromVisibleTurnItems({
  visibleTurnItems: PREVIEW_TURN_ITEMS,
  optimisticMessages: [],
});

const PREVIEW_THREAD_KEY = "transcript-style-preview";

// A settled turn folds to "Worked for …"; the preview opens it so the steps
// show. The timeline writes the reader's own toggles back under this key.
if (readTimelinePosition(PREVIEW_THREAD_KEY) === undefined) {
  rememberTimelinePosition(PREVIEW_THREAD_KEY, {
    rowId: "",
    offsetWithinRow: 0,
    scrollOffset: 0,
    atEnd: true,
    disclosures: {
      runs: new Set([PREVIEW_RUN_ID]),
      workGroups: new Set(),
      attempts: new Set(),
      workGroupState: { scrollPositions: new Map(), expandedEntries: new Set() },
    },
  });
}

const noop = () => {};

/**
 * Picks the transcript style and shows it on a fixed sample turn rendered by
 * the real `MessagesTimeline`, so the preview is exactly what threads show.
 */
export function TranscriptStylePicker(props: {
  readonly value: TranscriptStyle;
  readonly onChange: (value: TranscriptStyle) => void;
}) {
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  return (
    <div className="grid gap-3">
      <ToggleGroup
        aria-label="Transcript style"
        variant="segmented"
        value={[props.value]}
        onValueChange={(next) => {
          const value = next[0];
          if (
            value === "km" ||
            value === "terminal" ||
            value === "minimal" ||
            value === "minimal-plus"
          ) {
            props.onChange(value);
          }
        }}
      >
        <Toggle value="minimal">{TRANSCRIPT_STYLE_OPTIONS.minimal.label}</Toggle>
        <Toggle value="minimal-plus">{TRANSCRIPT_STYLE_OPTIONS["minimal-plus"].label}</Toggle>
        <Toggle value="km">{TRANSCRIPT_STYLE_OPTIONS.km.label}</Toggle>
        <Toggle value="terminal">{TRANSCRIPT_STYLE_OPTIONS.terminal.label}</Toggle>
      </ToggleGroup>
      <div
        className="h-120 overflow-hidden rounded-md border border-border bg-background"
        data-t3-part="transcript-style-preview"
      >
        <MessagesTimeline
          transcriptStyle={props.value}
          isWorking={false}
          activeTurnInProgress={false}
          listRef={listRef}
          timelineEntries={PREVIEW_TIMELINE_ENTRIES}
          latestRun={null}
          turnDiffSummaries={[]}
          routeThreadKey={PREVIEW_THREAD_KEY}
          onOpenTurnDiff={noop}
          onOpenThread={noop}
          onForkFromRun={async () => {}}
          onRollbackCheckpoint={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          activeThreadEnvironmentId={PREVIEW_ENVIRONMENT_ID}
          markdownCwd={undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat="locale"
          workspaceRoot={undefined}
          providerStatuses={[]}
          runs={[]}
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          onIsAtEndChange={noop}
          liveFollowEnabled={false}
          onManualNavigation={noop}
        />
      </div>
    </div>
  );
}
