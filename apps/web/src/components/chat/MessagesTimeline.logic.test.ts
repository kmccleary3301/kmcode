import { ThreadId, PlanId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { deriveTimelineActivityDecisions } from "./timelineActivityPolicy";
import {
  CheckpointRef,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  TurnItemId,
  RuntimeRequestId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  workEntryDisplayIndicatesToolFailure,
  type TimelineEntry,
} from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import type { Root as MarkdownRoot } from "mdast";
import { describe, expect, it } from "vite-plus/test";
import { EMPTY_THREAD_ACTIVITY_STATE } from "@t3tools/client-runtime/state/threads";
import { mergeActivityRowsIntoVisibleItems } from "./timelineActivity";
import type { TimelineActivityGroup } from "./timelineActivity";
import { MessageId, RunId } from "@t3tools/contracts";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  hasRequiredForegroundAgents,
  deriveMessagesTimelineActivityStatus,
  isCurrentProviderRetryActive,
  liveWorkEntryLabel,
  resolveAssistantMessageCopyState,
  THOUGHT_PREVIEW_MAX_LENGTH,
  remarkThoughtPreview,
  resolveWorkGroupScrollIndex,
  shouldPreserveAssistantLineBreaks,
  threadReadLabelPrefix,
  threadReadTargetId,
  threadReadTargetTitle,
  type MessagesTimelineRow,
  type TimelineLiveSubagent,
  resolveTimelineToolPresentation,
  workEntryDisplayLabel,
  workEntryReadOutput,
  workEntryIsVisibleInGroup,
  timelineRowKey,
  timelineEntryTurnFoldRunId,
} from "./MessagesTimeline.logic";
import type { WorkLogEntry } from "../../session-logic";

describe("expanded tool group scrolling", () => {
  const entries = [{ id: "first" }, { id: "second" }];

  it("restores the visible tool and its offset inside expanded output", () => {
    const anchor = { entryId: "second", offset: 120 };
    expect(resolveWorkGroupScrollIndex(entries, anchor)).toEqual({ index: 1, viewOffset: -120 });
    expect(resolveWorkGroupScrollIndex([{ id: "older" }, ...entries], anchor)).toEqual({
      index: 2,
      viewOffset: -120,
    });
  });

  it("starts normally when the saved tool no longer exists", () => {
    expect(resolveWorkGroupScrollIndex(entries, undefined)).toBeUndefined();
    expect(
      resolveWorkGroupScrollIndex(entries, { entryId: "removed", offset: 120 }),
    ).toBeUndefined();
  });
});

describe("reasoning thought previews", () => {
  it("flattens Markdown content into compact plain text", () => {
    const tree: MarkdownRoot = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "  Lead " },
            { type: "emphasis", children: [{ type: "text", value: "bold" }] },
            { type: "text", value: "\n\n tail  " },
          ],
        },
        { type: "paragraph", children: [{ type: "text", value: "next" }] },
      ],
    };
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toEqual([{ type: "text", value: "Lead bold tail next" }]);
  });

  it("uses the fallback when Markdown has no visible text", () => {
    const tree: MarkdownRoot = {
      type: "root",
      children: [{ type: "html", value: "<div>only html</div>" }],
    };
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toEqual([{ type: "text", value: "Thought" }]);
  });

  it("does not split an emoji at the thought preview cutoff", () => {
    const tree: MarkdownRoot = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: `${"x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 1)}😀 tail` },
          ],
        },
      ],
    };
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toEqual([
      { type: "text", value: "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 1) },
    ]);
  });
});

describe("work entry labels", () => {
  it("uses live titles only for active thread shells", () => {
    const shell = { title: " Review auth flow ", archivedAt: null, deletedAt: null };
    expect(threadReadTargetTitle(shell)).toBe("Review auth flow");
    expect(threadReadTargetTitle({ ...shell, title: "Harden session refresh" })).toBe(
      "Harden session refresh",
    );
    expect(threadReadTargetTitle({ ...shell, archivedAt: "2026-10-07T12:00:00Z" })).toBeNull();
    expect(threadReadTargetTitle({ ...shell, deletedAt: "2026-10-07T12:00:00Z" })).toBeNull();
    expect(threadReadTargetTitle({ ...shell, title: "  " })).toBeNull();
    expect(threadReadTargetTitle(null)).toBeNull();
  });

  const entry = {
    id: "tool-1",
    createdAt: "2026-09-01T12:00:00Z",
    label: "Tool call",
    tone: "tool" as const,
  };

  it("previews reasoning in the live row and falls back to a short label while empty", () => {
    const thought = {
      ...entry,
      itemType: "reasoning" as const,
      tone: "thinking" as const,
      detail: "Check **ordering** first.",
      toolLifecycleStatus: "inProgress" as const,
    };
    expect(liveWorkEntryLabel(thought, undefined, true)).toBe(thought.detail);
    expect(
      liveWorkEntryLabel(
        { ...thought, detail: "First paragraph.\n\nSecond paragraph." },
        undefined,
        true,
      ),
    ).toBe("First paragraph. Second paragraph.");
    expect(liveWorkEntryLabel({ ...thought, detail: "  " }, undefined, true)).toBe("Thinking");
    expect(
      liveWorkEntryLabel(
        { ...thought, detail: "", toolLifecycleStatus: "completed" },
        undefined,
        false,
      ),
    ).toBe("Thought");
    expect(
      liveWorkEntryLabel({ ...thought, toolLifecycleStatus: "completed" }, undefined, false),
    ).toBe(thought.detail);
    expect(workEntryDisplayLabel(thought, undefined)).toBe(thought.detail);
    expect(workEntryIsVisibleInGroup(thought)).toBe(true);
    expect(workEntryIsVisibleInGroup({ ...thought, toolLifecycleStatus: "completed" })).toBe(true);
    expect(workEntryIsVisibleInGroup({ ...thought, detail: "  " })).toBe(false);
  });

  it.each([
    ["inProgress", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
    ["declined", "Declined to click in the preview browser"],
    ["stopped", "Stopped clicking in the preview browser"],
  ] as const)("uses the same friendly %s label in both views", (toolLifecycleStatus, label) => {
    const browserEntry = {
      ...entry,
      toolTitle: "T3-code.preview_click",
      detail: '{"ok":true}',
      toolLifecycleStatus,
    };
    expect(liveWorkEntryLabel(browserEntry, undefined, toolLifecycleStatus === "inProgress")).toBe(
      label,
    );
    expect(workEntryDisplayLabel(browserEntry, undefined)).toBe(label);
  });

  it.each([
    ["inProgress", true, "Reading thread"],
    ["completed", false, "Read thread"],
    ["failed", false, "Failed to read thread"],
    ["declined", false, "Declined to read thread"],
    ["stopped", false, "Stopped reading thread"],
  ] as const)("names the read thread in the %s label", (toolLifecycleStatus, active, prefix) => {
    const threadRead = {
      ...entry,
      itemType: "dynamic_tool" as const,
      toolLifecycleStatus,
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "t3-code.t3_thread_read",
        input: { threadId: " thread-child ", view: "activity" },
      } as never,
    };
    expect(threadReadTargetId(threadRead)).toBe("thread-child");
    expect(threadReadLabelPrefix(liveWorkEntryLabel(threadRead, undefined, active))).toBe(prefix);
    expect(threadReadLabelPrefix(workEntryDisplayLabel(threadRead, undefined))).toBe(prefix);
  });

  it("finds no target for other tools or thread reads without one", () => {
    const payload = (toolName: string, input: unknown) => ({
      structuredPayload: { type: "dynamic_tool", toolName, input } as never,
    });
    expect(threadReadTargetId(payload("t3-code.t3_thread_wait", { threadId: "t" }))).toBeNull();
    expect(threadReadTargetId(payload("t3-code.t3_thread_read", { threadId: "  " }))).toBeNull();
    expect(threadReadTargetId(payload("t3-code.t3_thread_read", null))).toBeNull();
  });

  it("uses the active summary state for legacy tools without a lifecycle status", () => {
    const browserEntry = { ...entry, toolTitle: "T3-code.preview_click" };
    expect(liveWorkEntryLabel(browserEntry, undefined, true)).toBe(
      "Clicking in the preview browser",
    );
    expect(liveWorkEntryLabel(browserEntry, undefined, false)).toBe(
      "Clicked in the preview browser",
    );
  });

  it("keeps the latest live activity in the present tense after the call completes", () => {
    const browserEntry = {
      ...entry,
      toolTitle: "T3-code.preview_click",
      toolLifecycleStatus: "completed" as const,
    };
    expect(liveWorkEntryLabel(browserEntry, undefined, true)).toBe(
      "Clicking in the preview browser",
    );
    expect(liveWorkEntryLabel(browserEntry, undefined, false)).toBe(
      "Clicked in the preview browser",
    );
  });

  it("labels file reads with the path and never the file body", () => {
    const readEntry = {
      ...entry,
      itemType: "dynamic_tool" as const,
      toolTitle: "Read",
      label: "Read",
      detail: "---\nname: env\n---\n cons t x = 1",
      toolData: { input: { file_path: "src/env.ts" } },
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "src/env.ts" },
      } as NonNullable<WorkLogEntry["structuredPayload"]>,
    };
    expect(workEntryDisplayLabel(readEntry, undefined)).toBe("Read src/env.ts");
    expect(workEntryReadOutput(readEntry, undefined)).toBe("src/env.ts");
    expect(workEntryReadOutput(readEntry, "/workspace/ohseearr")).toBe(
      "/workspace/ohseearr/src/env.ts",
    );
    expect(
      workEntryReadOutput(
        {
          structuredPayload: {
            type: "dynamic_tool",
            toolName: "Read",
            input: {},
          } as NonNullable<WorkLogEntry["structuredPayload"]>,
          toolData: { locations: [{ path: "src/from-location.ts" }] },
        },
        "/workspace/ohseearr",
      ),
    ).toBe("/workspace/ohseearr/src/from-location.ts");
    expect(workEntryReadOutput({ detail: "---", toolData: {} }, undefined)).toBeNull();
  });

  it("labels Claude Grep from structured input instead of a generic tool heading", () => {
    expect(
      workEntryDisplayLabel(
        {
          ...entry,
          itemType: "dynamic_tool",
          toolTitle: "Grep",
          label: "Grep",
          toolData: { input: { pattern: "TODO", path: "apps/web" } },
          structuredPayload: {
            type: "dynamic_tool",
            toolName: "Grep",
            input: { pattern: "TODO", path: "apps/web" },
          } as NonNullable<WorkLogEntry["structuredPayload"]>,
        },
        undefined,
      ),
    ).toBe("Searched TODO in web");
  });

  it("labels file searches with the adapter title and its search target", () => {
    expect(
      workEntryDisplayLabel(
        {
          ...entry,
          itemType: "file_search",
          label: "Searched TODO in web",
          toolTitle: "Searched TODO in web",
          detail: "TODO",
          toolData: { type: "file_search", pattern: "TODO" },
        },
        undefined,
      ),
    ).toBe("Searched TODO in web");
  });

  it("keeps a multi-line approval prompt as its label", () => {
    const prompt = "Allow this command?\nrm -rf dist";
    expect(
      workEntryDisplayLabel(
        { ...entry, itemType: "approval_request", requestKind: "command", detail: prompt },
        undefined,
      ),
    ).toBe(prompt);
  });

  it("keeps custom titles and output for unrecognized tools", () => {
    const unknownEntry = { ...entry, toolTitle: "mcp__github__search_issues" };
    expect(liveWorkEntryLabel(unknownEntry, undefined, true)).toBe("Mcp__github__search_issues");
    expect(workEntryDisplayLabel({ ...unknownEntry, detail: "Found 3 issues" }, undefined)).toBe(
      "Found 3 issues",
    );
  });

  it("keeps command summaries compact without replacing the full command in expanded rows", () => {
    const commandEntry = { ...entry, command: "vp test run", detail: "All tests passed" };
    expect(liveWorkEntryLabel(commandEntry, undefined, true)).toBe("Running vp");
    expect(liveWorkEntryLabel(commandEntry, undefined, false)).toBe("Ran vp");
    expect(workEntryDisplayLabel(commandEntry, undefined)).toBe("vp test run");
  });

  it("summarizes the program inside a shell wrapper while preserving the expanded command", () => {
    const command = "/bin/zsh -lc 'vp test run apps/web/src/session-logic.test.ts'";
    const commandEntry = { ...entry, command };
    expect(liveWorkEntryLabel(commandEntry, undefined, true)).toBe("Running vp");
    expect(liveWorkEntryLabel(commandEntry, undefined, false)).toBe("Ran vp");
    expect(workEntryDisplayLabel(commandEntry, undefined)).toBe(
      "vp test run apps/web/src/session-logic.test.ts",
    );
    expect(commandEntry.command).toBe(command);
  });

  it.each([
    ["inProgress", "Running vp", "Running vp"],
    ["completed", "Running vp", "Ran vp"],
    ["failed", "Failed vp", "Failed vp"],
    ["declined", "Declined vp", "Declined vp"],
    ["stopped", "Stopped vp", "Stopped vp"],
  ] as const)(
    "uses present tense for a live %s command and the outcome once it is no longer live",
    (toolLifecycleStatus, liveLabel, settledLabel) => {
      const commandEntry = {
        ...entry,
        command: "/bin/bash -lc 'vp test run'",
        toolLifecycleStatus,
      };
      expect(liveWorkEntryLabel(commandEntry, undefined, true)).toBe(liveLabel);
      expect(liveWorkEntryLabel(commandEntry, undefined, false)).toBe(settledLabel);
    },
  );

  it.each([
    ["preview_click", "Clicked in the preview browser"],
    ["task_status", "Got delegated task status"],
  ] as const)(
    "renders a settled legacy %s call directly with its completed presentation",
    (tool, label) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "browser-entry",
            kind: "work",
            createdAt: entry.createdAt,
            entry: {
              ...entry,
              itemType: "dynamic_tool",
              toolData: { server: "t3-code", tool },
            },
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const directRow = rows.find((row) => row.kind === "work");
      expect(directRow).toMatchObject({
        groupedEntries: [expect.objectContaining({ id: "tool-1" })],
        isExpandedToolGroup: false,
        displayLabel: label,
      });
    },
  );
});

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });

  it("copies the rendered representation of Codex directives", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: [
          'Created :codex-file-citation{path="outputs/report.xlsx" purpose="output"}.',
          "",
          '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
        ].join("\n"),
        streaming: false,
      }),
    ).toEqual({
      text: "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
      visible: true,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("shows the CUA action title for a retained tool item", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "dynamic_tool")!;
    if (source.item.type !== "dynamic_tool") throw new Error("Expected tool fixture");
    const item = {
      ...source.item,
      title: null,
      toolName: "cua_repl.js",
      input: { code: "await game.getAXStateAndScreenshot();", title: "Inspect Saga music screen" },
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [{ ...source, item }],
      optimisticMessages: [],
    });
    const work = entries.find((entry) => entry.kind === "work");
    expect(work?.kind === "work" && workEntryDisplayLabel(work.entry, undefined)).toBe(
      "Inspect Saga music screen",
    );
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: false,
      runningRunId: fixture.runId,
      activeTurnStartedAt: fixture.time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "work")).toMatchObject({
      displayLabel: "Inspect Saga music screen",
    });
  });

  it("presents project MCP calls and summarizes successful clones through the web timeline", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "dynamic_tool")!;
    if (source.item.type !== "dynamic_tool") throw new Error("Expected tool fixture");
    const items: OrchestrationV2ProjectedTurnItem["item"][] = [
      {
        ...source.item,
        type: "dynamic_tool",
        id: TurnItemId.make("list"),
        status: "completed",
        title: "Custom provider title",
        toolName: "T3-code.t3_project_list",
        input: {},
        output: { projects: [] },
      },
      {
        ...source.item,
        type: "dynamic_tool",
        id: TurnItemId.make("clone"),
        status: "completed",
        title: "Custom provider title",
        toolName: "mcp__t3_code__t3_project_clone",
        input: {},
        output: { cwd: "/tmp/repo" },
      },
      {
        ...source.item,
        type: "dynamic_tool",
        id: TurnItemId.make("failed-clone"),
        status: "completed",
        title: "Custom provider title",
        toolName: "t3_project_clone",
        input: {},
        output: { isError: true },
      },
    ];
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map((item, position) => ({
        ...source,
        item,
        position,
        sourceItemId: item.id,
      })),
      optimisticMessages: [],
    });
    const work = entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));
    expect(workEntryDisplayLabel(work[0]!, undefined)).toBe("Listed projects");
    expect(workEntryDisplayLabel(work[1]!, undefined)).toBe("Cloned a repository");
    expect(workEntryDisplayLabel(work[2]!, undefined)).toBe("Failed to clone a repository");
    expect(
      resolveTimelineToolPresentation(items[1]!.type === "dynamic_tool" ? items[1].toolName : null)
        ?.logo,
    ).toBe("t3-code");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: false,
      runningRunId: fixture.runId,
      activeTurnStartedAt: fixture.time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      summary: "Listed projects 1 time and cloned 1 repository",
      hasFailure: true,
    });
  });

  it.each(["waiting", "completed"] as const)(
    "groups approval and user-input requests beside a standalone command without expanding them when %s",
    (status) => {
      const fixture = makeStreamingTimelineFixture();
      const source = fixture.visibleTurnItems[0]!;
      const common = {
        ...source.item,
        threadId: fixture.threadId,
        runId: fixture.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status,
      };
      const items: OrchestrationV2ProjectedTurnItem["item"][] = [
        {
          ...common,
          id: TurnItemId.make("command"),
          type: "command_execution",
          input: "pwd",
          output: "",
        },
        {
          ...common,
          id: TurnItemId.make("approval"),
          type: "approval_request",
          requestId: RuntimeRequestId.make("approval-request"),
          requestKind: "command",
          prompt: "Allow pwd?",
        },
        {
          ...common,
          id: TurnItemId.make("input"),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("input-request"),
          questions: [],
        },
      ];
      const entries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.map((item, position) => ({
          ...source,
          item,
          position,
          sourceItemId: item.id,
        })),
        optimisticMessages: [],
      });
      expect(entries.map((entry) => entry.kind)).toEqual(["work", "work", "work"]);
      const rows = deriveMessagesTimelineRows({
        timelineEntries: entries,
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      // The command is its own step; the two requests share one group after it.
      const commandRow = rows.find(
        (row) =>
          (row.kind === "work" || row.kind === "work-live") &&
          row.groupedEntries.map(({ id }) => id).join() === "command",
      );
      expect(commandRow).toBeDefined();
      const requestGroupId = "work-group:approval";
      const requestGroup = rows.find(
        (row) =>
          (row.kind === "work-toggle" || row.kind === "work-live") &&
          row.groupId === requestGroupId,
      );
      expect(requestGroup).toBeDefined();
      const expandedRows = deriveMessagesTimelineRows({
        timelineEntries: entries,
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set([requestGroupId]),
      });
      const expanded = expandedRows.find(
        (row) => row.kind === "work" && row.id === `${requestGroupId}:details`,
      );
      expect(
        expanded?.kind === "work" && expanded.groupedEntries.map((entry) => entry.itemType),
      ).toEqual(["approval_request", "user_input_request"]);
      expect(rows.some((row) => row.kind === "event")).toBe(false);
      expect(requestGroup).not.toMatchObject({ isExpandedToolGroup: true });
    },
  );

  it("keeps a pending approval in its own timeline row", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems[0]!;
    const requestId = RuntimeRequestId.make("pending-approval");
    const common = {
      ...source.item,
      threadId: fixture.threadId,
      runId: fixture.runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "waiting",
    };
    const items: OrchestrationV2ProjectedTurnItem["item"][] = [
      {
        ...common,
        status: "waiting",
        id: TurnItemId.make("pending-command"),
        type: "command_execution",
        input: "pwd",
        output: "",
      },
      {
        ...common,
        status: "waiting",
        id: TurnItemId.make("pending-approval"),
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "Allow pwd?",
        reason: "This command matched an ask rule.",
        fullAccessOverride: "ask_rule",
      },
    ];
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map((item, position) => ({
        ...source,
        item,
        position,
        sourceItemId: item.id,
      })),
      optimisticMessages: [],
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      pendingApprovalRequestIds: new Set([requestId]),
      isWorking: true,
      activityStatus: "waiting",
      runningRunId: fixture.runId,
      activeTurnStartedAt: fixture.time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const approvalRow = rows.find(
      (row) =>
        row.kind === "work" &&
        row.groupedEntries.some((entry) => entry.projectedItem?.item.type === "approval_request"),
    );
    if (!approvalRow || approvalRow.kind !== "work") {
      throw new Error("Expected an approval work row");
    }
    expect(approvalRow.groupedEntries).toHaveLength(1);
    expect(
      rows.some(
        (row) =>
          row.kind === "work-live" &&
          row.groupedEntries.some((entry) => entry.projectedItem?.item.type === "approval_request"),
      ),
    ).toBe(false);
  });

  it.each(["running", "completed", "superseded"] as const)(
    "keeps system notices visible as non-failing warnings through %s work",
    (state) => {
      const fixture = makeStreamingTimelineFixture();
      const message =
        "Claude changed its safety mode.\nReview the active permission settings before continuing.";
      const source: OrchestrationV2ProjectedTurnItem = {
        ...fixture.visibleTurnItems[0]!,
        sourceItemId: TurnItemId.make("safety-notice"),
        item: {
          id: TurnItemId.make("safety-notice"),
          threadId: fixture.threadId,
          runId: fixture.runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          startedAt: DateTime.makeUnsafe(fixture.time(1)),
          completedAt: DateTime.makeUnsafe(fixture.time(1)),
          updatedAt: DateTime.makeUnsafe(fixture.time(1)),
          type: "system_notice",
          message,
          title: message,
          status: "completed",
        },
      };
      const [notice] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [source],
        optimisticMessages: [],
      });
      if (notice?.kind !== "work") throw new Error("Expected a notice work entry");
      expect(notice.entry.projectedItem).toBe(source);
      expect(notice.entry.sourceActivityKind).toBe("runtime.warning");
      expect(workEntryDisplayLabel(notice.entry, undefined)).toBe(message);
      expect(workEntryDisplayIndicatesToolFailure(notice.entry)).toBe(false);
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            ...notice,
            ...(state === "superseded"
              ? {
                  attempt: {
                    id: "old-attempt" as never,
                    runId: fixture.runId,
                    status: "superseded" as const,
                    attemptOrdinal: 0,
                    rootNodeId: "old-root" as never,
                  },
                }
              : {}),
          },
          {
            id: "nearby-tool",
            kind: "work",
            createdAt: notice.createdAt,
            entry: {
              id: "nearby-tool",
              runId: fixture.runId,
              createdAt: notice.createdAt,
              label: "Ran command",
              tone: "tool",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "terminal-message",
            kind: "message",
            createdAt: notice.createdAt,
            message: {
              id: MessageId.make("terminal-message"),
              runId: fixture.runId,
              role: "assistant",
              text: "Continuing with the selected settings.",
              createdAt: notice.createdAt,
              updatedAt: notice.createdAt,
              streaming: state === "running",
            },
          },
        ],
        isWorking: state === "running",
        activeTurnStartedAt: notice.createdAt,
        latestRun: {
          runId: fixture.runId,
          status: state === "running" ? "running" : "completed",
          startedAt: notice.createdAt,
          completedAt: state === "running" ? null : notice.createdAt,
        },
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const row = rows.find(
        (row) => row.kind === "work" && row.groupedEntries.includes(notice.entry),
      );
      expect(row).toMatchObject({ kind: "work", groupedEntries: [notice.entry] });
    },
  );

  it("keeps context compaction visible outside folded work", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "compaction-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "compaction",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Compacted context 899K → 19K tokens",
            tone: "info",
            sourceActivityKind: "context-compaction",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows).toEqual([
      {
        kind: "context-compaction",
        id: "compaction-entry",
        createdAt: "2026-01-01T00:00:00Z",
        label: "Compacted context 899K → 19K tokens",
        active: false,
      },
    ]);
  });

  it("keeps the activity status after live compaction completes", () => {
    const fixture = makeStreamingTimelineFixture();
    const last = fixture.visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const compact = {
      ...last,
      item: {
        ...last.item,
        type: "compaction" as const,
        status: "running" as const,
        driver: null,
        beforeTokenCount: 899_000,
      },
    };
    const input = {
      isWorking: true,
      runningRunId: fixture.runId,
      activeTurnStartedAt: fixture.time(5),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const runningEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [...fixture.visibleTurnItems.slice(0, -1), compact],
      optimisticMessages: [],
    });
    const runningRows = deriveMessagesTimelineRows({ ...input, timelineEntries: runningEntries });
    expect(runningRows.find((row) => row.kind === "context-compaction")).toMatchObject({
      active: true,
      label: "Compacting context",
    });
    expect(runningRows.some((row) => row.id === "live-activity-row")).toBe(false);

    const completedRows = deriveMessagesTimelineRows({
      ...input,
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [
          ...fixture.visibleTurnItems.slice(0, -1),
          {
            ...compact,
            item: { ...compact.item, status: "completed", afterTokenCount: 19_000 },
          },
        ],
        optimisticMessages: [],
      }),
    });
    expect(completedRows.find((row) => row.kind === "context-compaction")).toMatchObject({
      active: false,
      label: "Context compacted 899K → 19K tokens",
    });
    const workingIndex = completedRows.findIndex((row) => row.id === "working-indicator-row");
    const latestActiveInputIndex = completedRows.findLastIndex(
      (row) =>
        row.kind === "message" &&
        row.message.role === "user" &&
        row.message.inputIntent !== "queued_turn",
    );
    expect(completedRows.filter((row) => row.id === "working-indicator-row")).toHaveLength(1);
    expect(workingIndex).toBeGreaterThan(latestActiveInputIndex);
    expect(completedRows[workingIndex]).toMatchObject({ kind: "working", status: "working" });

    const settledRows = deriveMessagesTimelineRows({
      ...input,
      isWorking: false,
      timelineEntries: runningEntries,
    });
    expect(settledRows.find((row) => row.kind === "context-compaction")).toMatchObject({
      active: false,
    });
    const stable = computeStableMessagesTimelineRows(runningRows, { result: [], byId: new Map() });
    expect(computeStableMessagesTimelineRows(settledRows, stable).result).toEqual(settledRows);
  });

  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("recaps a settled turn's checkpoint files under its answer and counts user reverts", () => {
    const assistantTurnDiffSummary = {
      runId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            runId: "turn-1" as never,
            inputIntent: "turn_start",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [assistantTurnDiffSummary],
      supportsConversationRollback: true,
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.turnRecap).toEqual({
      runId: "turn-1",
      todos: [],
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
      checkpoint: true,
    });
  });

  it("folds the first assistant message and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it.each([1, 2, 3])("folds %i completed activities after the terminal response", (count) => {
    const runId = RunId.make("turn-1");
    const timelineEntries = [
      {
        id: "work-entry-before-text",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-before-text",
          createdAt: "2026-01-01T00:00:01Z",
          runId,
          label: "Status updated",
          tone: "info" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "CI is re-running. Waiting.",
          runId,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `work-entry-after-text-${index}`,
        kind: "work" as const,
        createdAt: `2026-01-01T00:00:0${index + 7}Z`,
        entry: {
          id: `work-after-text-${index}`,
          createdAt: `2026-01-01T00:00:0${index + 7}Z`,
          runId,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          toolLifecycleStatus: "completed" as const,
        },
      })),
    ];

    const input = {
      latestRun: {
        runId,
        status: "completed" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const rows = deriveMessagesTimelineRows({ ...input, timelineEntries });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
    const expanded = deriveMessagesTimelineRows({
      ...input,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(
      expanded.some(
        (row) =>
          row.id === "work-entry-after-text-0" ||
          (row.kind === "work-toggle" &&
            row.id === "work-toggle:work-entry-after-text-0" &&
            row.hiddenCount === count),
      ),
    ).toBe(true);

    // A late failure must remain visible even though successful work is folded.
    const failedEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "failed" as const } }
        : entry,
    );
    const failedRows = deriveMessagesTimelineRows({ ...input, timelineEntries: failedEntries });
    expect(failedRows.some((row) => row.id === "work-entry-after-text-0")).toBe(true);

    const pendingEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "inProgress" as const } }
        : entry,
    );
    const pendingRows = deriveMessagesTimelineRows({
      ...input,
      timelineEntries: pendingEntries,
      latestRun: { ...input.latestRun, status: "running", completedAt: null },
      isWorking: true,
      activeTurnStartedAt: input.latestRun.startedAt,
    });
    expect(
      pendingRows.some((row) => row.kind === "work-live" && row.entry.id === "work-after-text-0"),
    ).toBe(true);
  });

  it("folds all assistant messages before the terminal message", () => {
    const timelineEntries = [
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:01Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "The main result is ready.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:01Z",
          updatedAt: "2026-01-01T00:00:02Z",
          streaming: false,
        },
      },
      {
        id: "assistant-middle-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:03Z",
        message: {
          id: "assistant-middle" as never,
          role: "assistant" as const,
          text: "I am checking one more detail.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:03Z",
          updatedAt: "2026-01-01T00:00:04Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Verification finished.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-before-message",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "work-before-message",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Status updated",
            tone: "info" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            runId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s · 1 step");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        runId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("places one active run slot after the steered interaction without moving old content", () => {
    const runId = RunId.make("steered-run");
    const startedAt = "2026-01-01T00:00:00Z";
    const message = (
      id: string,
      role: "user" | "assistant",
      text: string,
      createdAt: string,
      inputIntent?: "turn_start" | "steer",
    ): TimelineEntry => ({
      kind: "message",
      id,
      createdAt,
      message: {
        id: MessageId.make(id),
        role,
        text,
        runId,
        ...(inputIntent ? { inputIntent } : {}),
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    });
    const work = (
      id: string,
      createdAt: string,
      itemType: "reasoning" | "command_execution",
      detail?: string,
    ): TimelineEntry => ({
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        runId,
        label: itemType === "reasoning" ? "Thinking" : "Running tests",
        tone: itemType === "reasoning" ? "thinking" : "tool",
        itemType,
        ...(detail ? { detail } : {}),
        ...(itemType === "command_execution" ? { command: "pnpm test" } : {}),
        toolLifecycleStatus: "inProgress",
      },
    });
    const initialInput = message(
      "initial-input",
      "user",
      "Check this change",
      startedAt,
      "turn_start",
    );
    const oldResponse = message(
      "old-response",
      "assistant",
      "The initial review is complete.",
      "2026-01-01T00:00:10Z",
    );
    const steer = message(
      "steer-input",
      "user",
      "Also check the retry path.",
      "2026-01-01T00:00:20Z",
      "steer",
    );
    const reasoning = work(
      "steer-reasoning",
      "2026-01-01T00:00:21Z",
      "reasoning",
      "Rechecking the retry path.",
    );
    const tool = work("steer-tool", "2026-01-01T00:00:22Z", "command_execution");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [initialInput, oldResponse, steer, reasoning, tool],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const indexOf = (id: string) => rows.findIndex((row) => row.id === id);

    expect(indexOf("initial-input")).toBeLessThan(indexOf("old-response"));
    expect(indexOf("old-response")).toBeLessThan(indexOf("steer-input"));
    expect(indexOf("steer-input")).toBeLessThan(indexOf("working-indicator-row"));
    expect(indexOf("working-indicator-row")).toBeLessThan(indexOf("live-activity-row"));
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      kind: "working",
      createdAt: startedAt,
    });
    expect(rows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(rows.find((row) => row.id === "live-activity-row")).toMatchObject({
      kind: "work-live",
      active: true,
      entry: { id: "steer-tool" },
      thought: { detail: "Rechecking the retry path." },
    });
    expect(rows.filter((row) => row.kind === "working")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "message").map((row) => row.id)).toEqual([
      "initial-input",
      "old-response",
      "steer-input",
    ]);
  });
  it("places working status after a promoted queued input for the active run", () => {
    const activeRunId = RunId.make("promoted-queued-run");
    const historicalRunId = RunId.make("historical-run");
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const message = (
      id: string,
      role: "user" | "assistant",
      text: string,
      createdAt: string,
      runId: RunId | null,
      inputIntent?: "turn_start" | "steer" | "queued_turn",
    ): TimelineEntry => ({
      kind: "message",
      id,
      createdAt,
      message: {
        id: MessageId.make(id),
        role,
        text,
        runId,
        ...(inputIntent ? { inputIntent } : {}),
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    });
    const entries = [
      message("historical-user", "user", "A is the earlier request.", time(0), null),
      message("historical-assistant", "assistant", "A is complete.", time(10), historicalRunId),
      message("promoted-input", "user", "B is now running.", time(20), activeRunId, "queued_turn"),
    ];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId: activeRunId,
        status: "running",
        startedAt: time(20),
        completedAt: null,
      },
      runningRunId: activeRunId,
      isWorking: true,
      activityStatus: "working",
      activeTurnStartedAt: time(20),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const indexOf = (id: string) => rows.findIndex((row) => row.id === id);
    const historicalAssistant = rows.find(
      (row): row is Extract<MessagesTimelineRow, { kind: "message" }> =>
        row.kind === "message" && row.id === "historical-assistant",
    );

    expect(indexOf("historical-user")).toBeLessThan(indexOf("historical-assistant"));
    expect(indexOf("historical-assistant")).toBeLessThan(indexOf("promoted-input"));
    expect(indexOf("promoted-input")).toBeLessThan(indexOf("working-indicator-row"));
    expect(historicalAssistant?.message).toMatchObject({
      role: "assistant",
      text: "A is complete.",
      runId: historicalRunId,
      streaming: false,
    });
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      kind: "working",
      status: "working",
      createdAt: time(20),
    });
  });

  it("anchors queued input after the active steer and freezes the run clock", () => {
    const runId = RunId.make("steered-run");
    const queuedRunId = RunId.make("queued-successor");
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const prompt = (
      id: string,
      second: number,
      inputIntent: "turn_start" | "steer" | "queued_turn",
      promptRunId: RunId = runId,
    ): TimelineEntry => ({
      kind: "message",
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role: "user",
        text: id,
        runId: promptRunId,
        inputIntent,
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const entries: TimelineEntry[] = [
      prompt("initial-prompt", 0, "turn_start"),
      {
        kind: "message",
        id: "old-response",
        createdAt: time(4),
        message: {
          id: MessageId.make("old-response"),
          role: "assistant",
          text: "The first response remains visible.",
          runId,
          createdAt: time(4),
          updatedAt: time(4),
          streaming: false,
        },
      },
      prompt("steer", 5, "steer"),
      prompt("queued", 6, "queued_turn", queuedRunId),
    ];
    const derive = (activityStatus: "waiting" | "finishing", workCompletedAt: string | null) =>
      deriveMessagesTimelineRows({
        timelineEntries: entries,
        latestRun: {
          runId,
          status: "running",
          startedAt: time(0),
          completedAt: null,
          workCompletedAt,
        },
        runningRunId: runId,
        isWorking: true,
        activityStatus,
        activeTurnStartedAt: time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const waitingRows = derive("waiting", null);
    const indexOf = (rows: ReadonlyArray<MessagesTimelineRow>, id: string) =>
      rows.findIndex((row) => row.id === id);
    expect(indexOf(waitingRows, "steer")).toBeLessThan(
      indexOf(waitingRows, "working-indicator-row"),
    );
    expect(indexOf(waitingRows, "working-indicator-row")).toBeLessThan(
      indexOf(waitingRows, "queued"),
    );
    expect(waitingRows.find((row) => row.id === "queued")).toMatchObject({
      kind: "message",
      message: { runId: queuedRunId, inputIntent: "queued_turn" },
    });
    expect(waitingRows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      kind: "working",
      createdAt: time(0),
      status: "waiting",
      workCompletedAt: null,
    });
    expect(waitingRows.some((row) => row.id === "live-activity-row")).toBe(false);
    const oldResponse = waitingRows.find(
      (row): row is Extract<MessagesTimelineRow, { kind: "message" }> =>
        row.kind === "message" && row.id === "old-response",
    );
    expect(oldResponse?.message.text).toBe("The first response remains visible.");

    const completedAt = time(8);
    const finishingRow = derive("finishing", completedAt).find(
      (row) => row.id === "working-indicator-row",
    );
    expect(finishingRow).toMatchObject({
      kind: "working",
      createdAt: time(0),
      workCompletedAt: completedAt,
      status: "finishing",
    });
  });
  it("keeps the owning work end when a newer run is queued", () => {
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const queuedRunId = RunId.make("queued-after-work-end");
    const startedAt = time(0);
    const workCompletedAt = time(15);
    const input = {
      timelineEntries: [],
      latestRun: {
        runId: queuedRunId,
        status: "queued" as const,
        startedAt: null,
        completedAt: null,
        workCompletedAt: null,
      },
      isWorking: true,
      activityStatus: "finishing" as const,
      activeTurnStartedAt: startedAt,
      activityRunWorkCompletedAt: workCompletedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const row = deriveMessagesTimelineRows(input).find(
      (candidate) => candidate.id === "working-indicator-row",
    );

    expect(row).toMatchObject({
      kind: "working",
      createdAt: startedAt,
      workCompletedAt,
      status: "finishing",
    });
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestRun still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: "working", status: "working" });
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.some((row) => row.id === "live-activity-row")).toBe(true);
  });

  it("keeps a promptless restart in one active visual response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "keep going",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "old-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "old-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-before-restart" as never,
            label: "Searched files",
            command: "rg restart",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "old-stale-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "old-stale-work",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-before-restart" as never,
            label: "Running stale command",
            command: "rg stale",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "old-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:08Z",
          message: {
            id: "old-commentary" as never,
            role: "assistant",
            text: "the server restarted, continuing here.",
            runId: "turn-before-restart" as never,
            createdAt: "2026-01-01T00:00:08Z",
            updatedAt: "2026-01-01T00:00:08Z",
            streaming: false,
          },
        },
        {
          id: "new-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "new-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-after-restart" as never,
            label: "Running tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-after-restart" as never,
        status: "running",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.filter((row) => row.id === "working-indicator-row")).toHaveLength(1);
    expect(rows.findIndex((row) => row.id === "working-indicator-row")).toBeLessThan(
      rows.findIndex((row) => row.id === "old-work-entry"),
    );
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      createdAt: "2026-01-01T00:01:00Z",
    });
    expect(rows.find((row) => row.id === "old-commentary-entry")).toMatchObject({
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: true,
    });
    expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: "new-work" }) }),
    ]);
  });

  it("carries the latest thought on the live row while a later tool runs", () => {
    type WorkEntry = Extract<
      Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"][number],
      { kind: "work" }
    >;
    const work = (
      id: string,
      at: string,
      fields: Omit<WorkEntry["entry"], "id" | "createdAt" | "runId" | "label">,
    ): WorkEntry => ({
      id: `${id}-entry`,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, runId: "turn-1" as never, label: id, ...fields },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("old-thought", "2026-01-01T00:00:01Z", {
          itemType: "reasoning",
          detail: "First idea.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("new-thought", "2026-01-01T00:00:02Z", {
          itemType: "reasoning",
          detail: "Found the cause.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("running-command", "2026-01-01T00:00:03Z", {
          command: "rg cause",
          requestKind: "command",
          tone: "tool" as const,
          toolLifecycleStatus: "inProgress" as const,
        }),
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      thought: { id: "new-thought" },
    });
  });

  it("keeps an actually running command on its own live row beside settled steps", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Ran tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    // Commands stand alone: the running one keeps its live row and the settled
    // edit and command keep their own rows instead of joining it.
    expect(rows.find((row) => row.kind === "work-live" && row.active)).toMatchObject({
      entry: { id: "running-command" },
      groupedEntries: [{ id: "running-command" }],
    });
    const renderedEntryIds = rows.flatMap((row) =>
      row.kind === "work" || row.kind === "work-live" ? row.groupedEntries.map(({ id }) => id) : [],
    );
    expect(renderedEntryIds).toEqual(
      expect.arrayContaining(["running-command", "completed-edit", "completed-command"]),
    );
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    // A Claude subagent's child thread, as projected: no runs, one runless
    // root turn, and a user prompt for the launch and for a SendMessage resume.
    const threadId = ThreadId.make("subagent-child");
    const rootNodeId = NodeId.make("task-root");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 8, 25, 22, 51, second)).toISOString());
    const base = (id: string, ordinal: number, second: number, endSecond = second) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(endSecond),
      updatedAt: at(endSecond),
    });
    const prompt = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "user_message" as const,
      messageId: MessageId.make(id),
      text: `Prompt ${id}`,
      attachments: [],
      inputIntent: "turn_start" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    });
    const answer = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "assistant_message" as const,
      messageId: MessageId.make(id),
      text: `Answer ${id}`,
      streaming: false,
    });
    type ResumeState = "running" | "completed" | "failed";
    const items = (resume: ResumeState) =>
      [
        prompt("launch", 1, 0),
        { ...base("launch-ls", 2, 4), type: "command_execution" as const, input: "ls src" },
        {
          ...base("launch-thinking", 3, 8),
          type: "reasoning" as const,
          title: "Thinking",
          text: "Not there.",
          streaming: false,
        },
        answer("launch-answer", 4, 8),
        prompt("resume", 5, 72),
        {
          ...base("resume-ls", 6, 77),
          type: "command_execution" as const,
          input: "ls src",
          status: resume === "running" ? ("running" as const) : ("completed" as const),
          completedAt: resume === "running" ? null : at(77),
        },
        ...(resume === "failed"
          ? [
              {
                ...base("resume-error", 7, 80),
                type: "error" as const,
                status: "failed" as const,
                failure: {
                  class: "provider_error" as const,
                  message: "Subagent failed",
                  code: null,
                  retryable: null,
                },
              },
            ]
          : []),
        ...(resume === "running" ? [] : [answer("resume-answer", 8, 80)]),
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (input: {
      resume: ResumeState;
      working: boolean;
      expandedRunIds?: ReadonlySet<RunId>;
    }) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(input.resume),
          optimisticMessages: [],
        }),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        ...(input.expandedRunIds === undefined ? {} : { expandedRunIds: input.expandedRunIds }),
        activeTurnStartedAt: input.working ? DateTime.formatIso(at(72)) : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? `fold:${row.label}`
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind,
      );

    // Settled: each run folds its work, keeping its prompt and final answer.
    const settled = rows({ resume: "completed", working: false });
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8s · 1 step",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s · 1 step",
      "assistant:resume-answer",
    ]);

    // Each fold opens on its own.
    const launchFold = settled.find((row) => row.kind === "turn-fold");
    if (launchFold?.kind !== "turn-fold" || launchFold.runId === null)
      throw new Error("Expected the launch fold to have a run");
    const expanded = rows({
      resume: "completed",
      working: false,
      expandedRunIds: new Set([launchFold.runId]),
    });
    expect(shape(expanded)).toEqual([
      "user:launch",
      "fold:Worked for 8s · 1 step",
      "work-toggle",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s · 1 step",
      "assistant:resume-answer",
    ]);

    // While the resume runs, only the settled launch folds.
    const runningShape = shape(rows({ resume: "running", working: true }));
    expect(runningShape).toContain("fold:Worked for 8s · 1 step");
    expect(runningShape).toContain("work-live");
    expect(runningShape.filter((s) => s.startsWith("fold:")).length).toBe(1);

    // A failed run stays open, as on a normal thread.
    expect(shape(rows({ resume: "failed", working: false }))).toEqual([
      "user:launch",
      "fold:Worked for 8s · 1 step",
      "assistant:launch-answer",
      "user:resume",
      "work",
      "work",
      "assistant:resume-answer",
    ]);
  });

  it("keeps imported V1 turns folded once the thread's first V2 run starts", () => {
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      second: number,
      runId: string | null = null,
    ) => ({
      id,
      kind: "message" as const,
      createdAt: at(second),
      message: {
        id: id as never,
        role,
        text: id,
        runId: runId as never,
        createdAt: at(second),
        updatedAt: at(second),
        streaming: false,
      },
    });
    const rows = (tail: ReadonlyArray<ReturnType<typeof message>>) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          message("imported-prompt", "user", 0),
          message("imported-update", "assistant", 4),
          {
            id: "imported-command",
            kind: "work",
            createdAt: at(5),
            entry: {
              id: "imported-command",
              createdAt: at(5),
              runId: null,
              label: "Ran git",
              command: "git status",
              requestKind: "command",
              tone: "tool" as const,
              toolLifecycleStatus: "completed" as const,
            },
          },
          message("imported-answer", "assistant", 8),
          ...tail,
        ],
        latestRun: {
          runId: "run-1" as never,
          status: "running",
          startedAt: at(20),
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: at(20),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }).map((row) =>
        row.kind === "message" ? `${row.message.role}:${row.message.id}` : row.kind,
      );

    // V2 work starts from a sent prompt, or with no new prompt (a wake or a resume).
    expect(rows([message("new-prompt", "user", 20, "run-1")]).slice(0, 4)).toEqual([
      "user:imported-prompt",
      "turn-fold",
      "assistant:imported-answer",
      "user:new-prompt",
    ]);
    const withoutPrompt = rows([]);
    expect(withoutPrompt).toContain("turn-fold");
    expect(withoutPrompt).not.toContain("assistant:imported-update");
    expect(
      timelineEntryTurnFoldRunId(
        [
          message("imported-prompt", "user", 0),
          message("imported-update", "assistant", 4),
          message("imported-answer", "assistant", 8),
        ],
        "imported-update",
      ),
    ).toBe(RunId.make("runless:imported-prompt"));
  });

  it("shows a provider-native subagent's runless tools as live work while it works", () => {
    const entries = (commandStatus: "inProgress" | "completed") => [
      {
        id: "task-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "task" as never,
          role: "user" as const,
          text: "Audit the adapters",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "command-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:05Z",
        entry: {
          id: "command",
          createdAt: "2026-01-01T00:00:05Z",
          runId: null,
          label: "Running git",
          command: "git diff --stat",
          requestKind: "command" as const,
          tone: "tool" as const,
          toolLifecycleStatus: commandStatus,
        },
      },
    ];
    const rows = (input: { commandStatus: "inProgress" | "completed"; working: boolean }) =>
      deriveMessagesTimelineRows({
        timelineEntries: entries(input.commandStatus),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        activeTurnStartedAt: input.working ? "2026-01-01T00:00:00Z" : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const running = rows({ commandStatus: "inProgress", working: true });
    expect(running.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "command" },
      active: true,
    });
    expect(running.find((row) => row.kind === "working")).toMatchObject({
      createdAt: "2026-01-01T00:00:00Z",
      status: "working",
    });

    // Once the subagent settles, the same entries fold as finished history.
    const settled = rows({ commandStatus: "completed", working: false });
    expect(settled.map((row) => row.kind)).toEqual(["message", "turn-fold"]);
  });

  it("does not treat runless entries as live work on a thread with runs", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "runless-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "runless-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: null,
            label: "Running git",
            command: "git status",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      kind: "working",
      status: "working",
    });
  });

  it("renders a single completed tool call directly", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Checking another thing.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [{ id: "completed-command", command: "rg toolCall" }],
      isExpandedToolGroup: false,
      displayLabel: "rg toolCall",
    });
  });

  it("keeps separated in-progress tool runs visible", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "first-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "first-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running first command",
            command: "rg first",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "second-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "second-running",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "first-running",
      "second-running",
    ]);
  });

  it("does not revive stale in-progress tools before a fresh send has a turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running stale command",
            command: "rg stale",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
  });

  it("does not revive separated historical task progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-progress-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-progress",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Old progress",
            tone: "thinking" as const,
            sourceActivityKind: "task.progress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running command",
            command: "rg current",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "running-command",
    ]);
  });

  it.each([
    [undefined, true],
    ["inProgress", true],
    ["completed", false],
    ["failed", false],
    ["stopped", false],
  ] as const)(
    "respects the %s lifecycle of trailing task progress",
    (toolLifecycleStatus, active) => {
      const runId = RunId.make("turn-task-progress");
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "task-progress-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:05Z",
            entry: {
              id: "task-progress",
              createdAt: "2026-01-01T00:00:05Z",
              runId,
              label: "Task progress",
              tone: "thinking",
              sourceActivityKind: "task.progress",
              ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
            },
          },
        ],
        latestRun: {
          runId,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

      const workLiveRow = rows.find((row) => row.kind === "work-live");
      expect(workLiveRow).toMatchObject({ active });
    },
  );

  it("keeps the status row separate from recorded tool outcomes", () => {
    const deriveRows = (
      toolLifecycleStatus: "inProgress" | "completed" | "failed" | "declined" | null,
      expandedWorkGroupIds?: ReadonlySet<string>,
    ) =>
      deriveMessagesTimelineRows({
        ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
        timelineEntries:
          toolLifecycleStatus === null
            ? []
            : [
                {
                  id: "latest-command-entry",
                  kind: "work",
                  createdAt: "2026-01-01T00:00:05Z",
                  entry: {
                    id: "latest-command",
                    createdAt: "2026-01-01T00:00:05Z",
                    runId: "turn-1" as never,
                    label: toolLifecycleStatus === "inProgress" ? "Running rg" : "Ran rg",
                    command: "rg toolCall",
                    requestKind: "command",
                    tone: "tool" as const,
                    toolLifecycleStatus,
                    ...(toolLifecycleStatus === "inProgress" ? { detail: "exit code 1" } : {}),
                  },
                },
              ],
        latestRun: {
          runId: "turn-1" as never,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const initialRows = deriveRows(null);
    const runningRows = deriveRows("inProgress");
    const completedRows = deriveRows("completed");
    const failedRows = deriveRows("failed");
    const declinedRows = deriveRows("declined");
    expect(initialRows.map((row) => row.kind)).toEqual(["working"]);
    expect(initialRows.some((row) => row.id === "live-activity-row")).toBe(false);
    expect(runningRows.find((row) => row.kind === "work-live")).toMatchObject({
      active: true,
      entry: { id: "latest-command" },
    });
    expect(completedRows.find((row) => row.kind === "work-live")).toMatchObject({
      active: true,
      entry: { id: "latest-command" },
    });
    const failedWork = failedRows.find((row) => row.kind === "work-live");
    expect(failedWork).toMatchObject({
      id: "live-activity-row",
      active: false,
      entry: { id: "latest-command", toolLifecycleStatus: "failed" },
    });
    expect(failedWork?.kind === "work-live" ? failedWork.groupId : undefined).toBeDefined();
    const declinedWork = declinedRows.find((row) => row.kind === "work-live");
    expect(declinedWork).toMatchObject({ active: false, entry: { id: "latest-command" } });
  });

  it("keeps an activity's list key from live card to settled summary", () => {
    const command = (id: string, second: number, status: "inProgress" | "completed") => ({
      id: `${id}-entry`,
      kind: "work" as const,
      createdAt: `2026-01-01T00:00:0${second}Z`,
      entry: {
        id,
        createdAt: `2026-01-01T00:00:0${second}Z`,
        runId: "turn-1" as never,
        label: status === "inProgress" ? `Running ${id}` : `Ran ${id}`,
        command: `rg ${id}`,
        requestKind: "command" as const,
        tone: "tool" as const,
        toolLifecycleStatus: status,
      },
    });
    const [live, settled] = [
      [command("first", 1, "inProgress")],
      [command("first", 1, "completed"), command("second", 2, "inProgress")],
    ].map((timelineEntries) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestRun: {
          runId: "turn-1" as never,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }),
    );
    // The header row that draws an entry, live or settled; expanded detail rows are not headers.
    const headerKeys = (rows: MessagesTimelineRow[] | undefined, entryId: string) =>
      (rows ?? [])
        .filter(
          (row) =>
            (row.kind === "work-live" &&
              row.groupedEntries.some((entry) => entry.id === entryId)) ||
            (row.kind === "work" &&
              !row.isExpandedToolGroup &&
              row.groupedEntries.some((entry) => entry.id === entryId)) ||
            (row.kind === "work-toggle" && row.groupId.endsWith(`${entryId}-entry`)),
        )
        .map(timelineRowKey);

    expect(headerKeys(live, "first")).toHaveLength(1);
    expect(headerKeys(settled, "first")).toEqual(headerKeys(live, "first"));
    expect(headerKeys(settled, "second")).toHaveLength(1);
    expect(headerKeys(settled, "second")).not.toEqual(headerKeys(live, "first"));
    const keys = (settled ?? []).map(timelineRowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps activity keys stable while reasoning and tools start, finish, and settle", () => {
    const runId = RunId.make("live-work-key");
    type WorkEntry = Extract<TimelineEntry, { kind: "work" }>;
    const reasoning = (status: "idle" | "inProgress" | "completed"): WorkEntry => ({
      id: "reasoning-entry",
      kind: "work",
      createdAt: "2026-01-01T00:00:01Z",
      entry: {
        id: "reasoning-item",
        createdAt: "2026-01-01T00:00:01Z",
        runId,
        label: "Thinking",
        detail: "Review the active request.",
        tone: "thinking",
        itemType: "reasoning",
        toolLifecycleStatus: status,
      },
    });
    const command = (status: "inProgress" | "completed"): WorkEntry => ({
      id: "command-entry",
      kind: "work",
      createdAt: "2026-01-01T00:00:02Z",
      entry: {
        id: "command-item",
        createdAt: "2026-01-01T00:00:02Z",
        runId,
        label: status === "inProgress" ? "Running pnpm" : "Ran pnpm",
        command: "pnpm test",
        requestKind: "command",
        tone: "tool",
        toolLifecycleStatus: status,
      },
    });
    const derive = (
      timelineEntries: ReadonlyArray<WorkEntry>,
      status: "running" | "completed",
      isWorking: boolean,
    ) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestRun: {
          runId,
          status,
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: status === "running" ? null : "2026-01-01T00:00:03Z",
        },
        expandedRunIds: new Set([runId]),
        isWorking,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const phases = [
      derive([reasoning("idle")], "running", true),
      derive([reasoning("inProgress")], "running", true),
      derive([reasoning("completed"), command("inProgress")], "running", true),
      derive([reasoning("completed"), command("completed")], "completed", false),
    ];
    const activityRows = phases.map((rows) =>
      rows.find((row) => row.kind === "work-live" || row.kind === "work-toggle"),
    );

    expect(activityRows.map((row) => (row ? timelineRowKey(row) : null))).toEqual([
      "activity:reasoning-entry",
      "activity:reasoning-entry",
      "activity:reasoning-entry",
      "activity:reasoning-entry",
    ]);
    expect(activityRows.map((row) => row?.id)).toEqual([
      "work-live:reasoning-entry",
      "live-activity-row",
      "live-activity-row",
      "work-toggle:reasoning-entry",
    ]);
  });

  it("does not fold the session's running turn when latestRun regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningRunId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.runId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("live-activity-row");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      kind: "working",
      status: "working",
    });
  });

  it.each([
    ["tools", "tool", "Used 3 tools"],
    ["tools and status updates", "info", "Used 2 tools and received 1 update"],
  ] as const)("expands %s through the same activity group", (_, middleTone, summary) => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "Status updated",
          detail: "Editing MessagesTimeline.tsx",
          tone: middleTone,
          toolSurface: "computer" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
          toolSurface: "browser" as const,
          toolIcon: { _tag: "website" as const, pageUrl: "https://example.com/checkout" },
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 3,
      expanded: false,
      summary,
      toolSurface: "browser",
      toolIcon: { _tag: "website", pageUrl: "https://example.com/checkout" },
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-toggle:work-entry-1",
      "work-group:work-entry-1:details",
    ]);
    expect(expandedRows.find((row) => row.kind === "work")).toMatchObject({
      isExpandedToolGroup: true,
      groupedEntries: timelineEntries.map(({ entry }) => entry),
    });
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });

  it("deduplicates integration sources and uses the first source icon for the group", () => {
    const chromeSource = {
      key: "browser-use:chrome",
      name: "Chrome",
      kind: "integration" as const,
      icon: {
        _tag: "native-app" as const,
        app: { _tag: "display-name" as const, displayName: "Google Chrome" },
      },
    };
    const timelineEntries = [
      {
        id: "browser-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "browser-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "Open MATLAB",
          tone: "tool" as const,
          toolSurface: "browser" as const,
          toolSource: chromeSource,
          toolIcon: {
            _tag: "website" as const,
            pageUrl: "https://www.mathworks.com/help/matlab/",
          },
        },
      },
      {
        id: "browser-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "browser-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "Show summary",
          tone: "tool" as const,
          toolSurface: "browser" as const,
          toolSource: chromeSource,
          toolIcon: {
            _tag: "website" as const,
            pageUrl: "https://www.mathworks.com/help/matlab/summary.html",
          },
        },
      },
      {
        id: "command-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "command-1",
          createdAt: "2026-01-01T00:00:03Z",
          label: "Ran command",
          command: "git status",
          itemType: "command_execution" as const,
          tone: "tool" as const,
        },
      },
    ];
    const [row] = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(row).toMatchObject({
      kind: "work-toggle",
      summary: "Used Chrome integration",
      toolSurface: "browser",
      toolIcon: {
        _tag: "website",
        pageUrl: "https://www.mathworks.com/help/matlab/",
      },
    });
  });

  it.each([
    {
      intents: ["Checking the build", undefined, "Checking the build"],
      expected: "Checking the build",
    },
    { intents: ["Checking the build", "Reading the logs", undefined], expected: undefined },
    { intents: [undefined, undefined, undefined], expected: undefined },
  ])("tags a settled group with the intent its steps share: $intents", ({ intents, expected }) => {
    const timelineEntries = intents.map((intent, index) => ({
      id: `read-${index}`,
      kind: "work" as const,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      entry: {
        id: `read-${index}`,
        createdAt: `2026-01-01T00:00:0${index}Z`,
        label: "read",
        toolTitle: "read",
        itemType: "dynamic_tool" as const,
        tone: "tool" as const,
        toolData: { input: { path: `src/file-${index}.ts`, ...(intent ? { i: intent } : {}) } },
      },
    }));
    const [row] = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(row?.kind).toBe("work-toggle");
    expect(row?.kind === "work-toggle" ? row.intent : null).toBe(expected);
  });

  it.each([true, false])(
    "keeps a large expanded tool run inside one timeline item, live=%s",
    (isWorking) => {
      const runId = RunId.make("turn-many-tools");
      const createdAt = "2026-09-01T12:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `tool-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `tool-${index}`,
          toolCallId: `call-${index}`,
          createdAt,
          runId,
          label: "t3-code.preview_snapshot",
          tone: "tool" as const,
          toolLifecycleStatus:
            isWorking && index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const input = {
        timelineEntries,
        isWorking,
        expandedRunIds: new Set([runId]),
        runningRunId: isWorking ? runId : null,
        activeTurnStartedAt: isWorking ? createdAt : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      };
      const collapsedRows = deriveMessagesTimelineRows(input);
      const collapsedGroup = collapsedRows.find(
        (row) => row.kind === "work-toggle" || row.kind === "work-live",
      );
      expect(collapsedGroup).toBeDefined();
      const groupId = collapsedGroup!.groupId;
      const expandedRows = deriveMessagesTimelineRows({
        ...input,
        expandedWorkGroupIds: new Set([groupId]),
      });
      const groupRows = expandedRows.filter((row) => row.kind === "work");
      expect(groupRows).toHaveLength(1);
      expect(groupRows[0]?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(groupRows[0]?.id).toBe(`${groupId}:details`);
    },
  );

  it.each([
    ["recovered", ["failed", "completed"], false],
    ["ending in failure", ["completed", "failed"], true],
    ["failed", ["failed", "failed"], true],
  ] as const)("uses the final call for %s tool groups", (_, statuses, hasFailure) => {
    const timelineEntries = statuses.map((status, index) => ({
      id: `work-entry-${index}`,
      kind: "work" as const,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      entry: {
        id: `work-${index}`,
        createdAt: `2026-01-01T00:00:0${index}Z`,
        label: "Called tool",
        tone: "tool" as const,
        itemType: "dynamic_tool" as const,
        toolLifecycleStatus: status,
      },
    }));

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      hasFailure,
    });
  });

  it.each([
    ["the later success is hidden", ["failed", "completed", "info"], false],
    ["the later success is visible", ["failed", "info", "completed"], false],
    ["an error-toned entry recovers", ["error", "info", "completed"], false],
    ["the final failure is hidden", ["completed", "failed", "info"], true],
    ["the final failure is visible", ["failed", "info", "failed"], true],
    ["the only failure is visible", ["completed", "info", "failed"], true],
  ] as const)(
    "uses the final tool call for mixed work groups when %s",
    (_, statuses, hasFailure) => {
      const timelineEntries = statuses.map((status, index) => {
        const id = `work-${index}`;
        const createdAt = `2026-01-01T00:00:0${index}Z`;

        return {
          id: `work-entry-${index}`,
          kind: "work" as const,
          createdAt,
          entry:
            status === "info"
              ? { id, createdAt, label: "Status updated", tone: "info" as const }
              : status === "error"
                ? { id, createdAt, label: "Command failed", tone: "error" as const }
                : {
                    id,
                    createdAt,
                    label: "Ran command",
                    tone: "tool" as const,
                    toolLifecycleStatus: status,
                  },
        };
      });

      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

      expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
        hiddenCount: statuses.some((status) => status === "error") ? 2 : 3,
        summary: statuses.some((status) => status === "error")
          ? "Received 1 update and used 1 tool"
          : "Used 2 tools and received 1 update",
        hasFailure,
      });
      if (statuses.some((status) => status === "error")) {
        expect(rows[0]).toMatchObject({
          kind: "work",
          groupedEntries: [{ tone: "error", label: "Command failed" }],
        });
      }
    },
  );
});

describe("computeStableMessagesTimelineRows", () => {
  it("updates a native card's disclosure when its foreground position changes without a tool revision", () => {
    const projectedItem = makeStreamingTimelineFixture().visibleTurnItems.find(
      (row) => row.item.type === "dynamic_tool",
    );
    if (projectedItem === undefined) throw new Error("Fixture requires a native tool");
    const row: MessagesTimelineRow = {
      kind: "event",
      id: projectedItem.item.id,
      createdAt: DateTime.formatIso(projectedItem.item.updatedAt),
      projectedItem,
      autoExpanded: true,
    };
    const before = computeStableMessagesTimelineRows([row], { byId: new Map(), result: [] });
    const after = computeStableMessagesTimelineRows([{ ...row, autoExpanded: false }], before);
    expect(after.result[0]).toMatchObject({ kind: "event", autoExpanded: false });
  });

  it("replaces a live row when a grouped entry's streamed detail changes", () => {
    const entry: WorkLogEntry = {
      id: "live-command",
      createdAt: "2026-01-01T00:00:00Z",
      label: "bash",
      detail: "before",
      tone: "tool",
      toolLifecycleStatus: "completed",
    };
    const row: MessagesTimelineRow = {
      kind: "work-live",
      id: "live-activity-row",
      createdAt: entry.createdAt,
      entry,
      groupedEntries: [entry],
      groupId: "work-group:live-command",
      expanded: false,
      active: true,
      summary: "Ran bash",
    };
    const before = computeStableMessagesTimelineRows([row], { byId: new Map(), result: [] });
    const updatedEntry = { ...entry, detail: "after" };
    const after = computeStableMessagesTimelineRows(
      [{ ...row, entry: updatedEntry, groupedEntries: [updatedEntry] }],
      before,
    );
    expect(after.result[0]).not.toBe(before.result[0]);
    expect(after.result[0]).toMatchObject({ entry: { detail: "after" } });
  });

  it("replaces a cached work toggle when its icon presentation changes", () => {
    const initialRow: MessagesTimelineRow = {
      kind: "work-toggle",
      id: "work-toggle:1",
      createdAt: "2026-01-01T00:00:00Z",
      groupId: "work-group:1",
      hiddenCount: 1,
      expanded: false,
      summary: "Used Browser",
      summaryKind: "other",
      toolSurface: "browser",
      hasFailure: false,
    };
    const initial = computeStableMessagesTimelineRows([initialRow], {
      byId: new Map(),
      result: [],
    });
    const enrichedRow: MessagesTimelineRow = {
      ...initialRow,
      toolIcon: { _tag: "website", pageUrl: "https://example.com" },
    };

    const updated = computeStableMessagesTimelineRows([enrichedRow], initial);

    expect(updated).not.toBe(initial);
    expect(updated.result[0]).toBe(enrichedRow);
  });

  it.each(["", " \n"])("keeps Working status after assistant content grows from %j", (text) => {
    const startedAt = "2026-01-01T00:00:00Z";
    const runId = RunId.make("turn-1");
    const input = {
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const assistantEntry = {
      id: "assistant-entry",
      kind: "message" as const,
      createdAt: startedAt,
      message: {
        id: MessageId.make("assistant-1"),
        role: "assistant" as const,
        text,
        runId,
        createdAt: startedAt,
        updatedAt: startedAt,
        streaming: true,
      },
    };
    const initial = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({ ...input, timelineEntries: [assistantEntry] }),
      { byId: new Map(), result: [] },
    );
    const updated = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: [
          {
            ...assistantEntry,
            message: { ...assistantEntry.message, text: "I will inspect the repository." },
          },
        ],
      }),
      initial,
    );

    const initialStatus = initial.byId.get("working-indicator-row");
    const updatedStatus = updated.byId.get("working-indicator-row");
    expect(initialStatus).toMatchObject({ kind: "working", status: "working" });
    expect(updatedStatus).toBe(initialStatus);
    expect(updated.result).toContain(updatedStatus);
  });

  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      runId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      runId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});

describe("resolveTimelineToolPresentation", () => {
  it("pretty prints Claude and Cursor T3 MCP tool names", () => {
    expect(resolveTimelineToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a T3 thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex T3 MCP tool names", () => {
    expect(resolveTimelineToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create T3 threads",
      logo: "t3-code",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveTimelineToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveTimelineToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});

describe("v2 run and attempt history", () => {
  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s · 1 step");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    // Expanding the activity preserves tool output and provider recovery details.
    const expandedWork = openedActivity.find((row) => row.kind === "work");
    expect(expandedWork?.kind === "work" ? expandedWork.groupedEntries : []).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });
  it("uses a prior run's native work end when a newer run is queued", () => {
    const historicalStartedAt = "2026-01-01T00:00:00Z";
    const historicalWorkAt = "2026-01-01T00:00:08Z";
    const finalMessageAt = "2026-01-01T00:00:20Z";
    const workCompletedAt = "2026-01-01T00:00:15Z";
    const lateMetadataAt = "2026-01-01T00:01:10Z";
    const finalizationAt = "2026-01-01T00:01:15Z";
    const queuedPromptAt = "2026-01-01T00:01:20Z";
    const historicalRunId = RunId.make("historical-run");
    const queuedRunId = RunId.make("queued-run");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: historicalStartedAt,
          message: {
            id: "user-message" as never,
            role: "user",
            text: "Build it",
            runId: null,
            createdAt: historicalStartedAt,
            updatedAt: historicalStartedAt,
            streaming: false,
          },
        },
        {
          id: "historical-work-entry",
          kind: "work",
          createdAt: historicalWorkAt,
          entry: {
            id: "historical-work",
            createdAt: historicalWorkAt,
            runId: historicalRunId,
            label: "Ran command",
            tone: "tool",
          },
        },
        {
          id: "historical-final-entry",
          kind: "message",
          createdAt: finalMessageAt,
          message: {
            id: "historical-final" as never,
            role: "assistant",
            text: "Done",
            runId: historicalRunId,
            createdAt: finalMessageAt,
            updatedAt: finalizationAt,
            streaming: false,
          },
        },
        {
          id: "late-historical-work-entry",
          kind: "work",
          createdAt: lateMetadataAt,
          entry: {
            id: "late-historical-work",
            createdAt: lateMetadataAt,
            runId: historicalRunId,
            label: "Late metadata",
            tone: "info",
          },
        },
        {
          id: "queued-user-entry",
          kind: "message",
          createdAt: queuedPromptAt,
          message: {
            id: "queued-user-message" as never,
            role: "user",
            text: "Do the next task",
            runId: queuedRunId,
            inputIntent: "queued_turn",
            createdAt: queuedPromptAt,
            updatedAt: queuedPromptAt,
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: queuedRunId,
        status: "queued",
        startedAt: null,
        completedAt: null,
        workCompletedAt: null,
      },
      runTimingsById: new Map([
        [
          historicalRunId,
          {
            startedAt: historicalStartedAt,
            completedAt: finalizationAt,
            workCompletedAt,
          },
        ],
      ]),
      isWorking: true,
      activityStatus: "waiting",
      activeTurnStartedAt: queuedPromptAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );

    expect(foldRow?.runId).toBe(historicalRunId);
    const durationParts = foldRow?.label.match(/^Worked for (?:(\d+)h\s+)?(?:(\d+)m\s+)?(\d+)s/);
    const [hours = "0", minutes = "0", seconds] = durationParts?.slice(1) ?? [];
    expect(Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)).toBe(15);
    const foldRowIndex = rows.findIndex((row) => row.id === `turn-fold:${historicalRunId}`);
    const finalMessageIndex = rows.findIndex((row) => row.id === "historical-final-entry");
    const queuedPromptIndex = rows.findIndex((row) => row.id === "queued-user-entry");
    expect(foldRowIndex).toBeLessThan(finalMessageIndex);
    expect(finalMessageIndex).toBeLessThan(queuedPromptIndex);
  });
  it("hides subagents in folded turns when they arrive before commentary", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Spawn a subagent",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "subagent-card-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:03Z",
        projectedItem: {
          item: {
            type: "subagent",
            runId: "turn-1",
          },
        } as never,
      },
      {
        id: "assistant-commentary-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-commentary" as never,
          role: "assistant" as const,
          text: "I spawned the subagent.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Subagent says: Hello.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);
  });
  it("collapses only output from a superseded V2 attempt within the active logical run", () => {
    const runId = "run-steered" as never;
    const supersededAttemptId = "attempt-1" as never;
    const activeAttemptId = "attempt-2" as never;
    const supersededAttempt = {
      id: supersededAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
    };
    const activeAttempt = {
      id: activeAttemptId,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
    };
    const timelineEntries = [
      {
        id: "initial-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        message: {
          id: "initial-user" as never,
          role: "user" as const,
          text: "Build it",
          runId,
          inputIntent: "turn_start" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:02Z",
        attempt: supersededAttempt,
        message: {
          id: "superseded-assistant" as never,
          role: "assistant" as const,
          text: "Partial old response",
          runId,
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:03Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        attempt: supersededAttempt,
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:04Z",
          runId,
          label: "Old command",
          tone: "tool" as const,
        },
      },
      {
        id: "superseded-thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:04.500Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "steer-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        attempt: activeAttempt,
        message: {
          id: "steer-user" as never,
          role: "user" as const,
          text: "Change direction",
          runId,
          inputIntent: "steer" as const,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
      },
      {
        id: "active-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:06Z",
        attempt: activeAttempt,
        message: {
          id: "active-assistant" as never,
          role: "assistant" as const,
          text: "Current response",
          runId,
          createdAt: "2026-01-01T00:00:06Z",
          updatedAt: "2026-01-01T00:00:07Z",
          streaming: true,
        },
      },
    ];
    const common = {
      timelineEntries,
      latestRun: {
        runId,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    const collapsedRows = deriveMessagesTimelineRows(common);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    expect(collapsedRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      attemptId: supersededAttemptId,
      runId,
      label: "Superseded attempt",
      expanded: false,
    });

    const expandedRows = deriveMessagesTimelineRows({
      ...common,
      expandedAttemptIds: new Set([supersededAttemptId]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-assistant-entry",
      "superseded-work-entry",
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
  });
  it("hides the interruption request while keeping intervening work and the result", () => {
    const runId = "turn-1" as never;
    const interruptEvent = (type: "run_interrupt_request" | "run_interrupt_result") => ({
      position: type === "run_interrupt_request" ? 0 : 2,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-${type}` as never,
      item: {
        id: `item-${type}`,
        threadId: "thread-1",
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: type === "run_interrupt_request" ? 0 : 2,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type,
        message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: interruptEvent("run_interrupt_request") as never,
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:02Z",
            runId,
            label: "Finishing tool output",
            tone: "tool",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["work-entry", "interrupt-result"]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);

    // The command the interrupt cut short stays visible with its outcome.
    const stoppedRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stopped-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "stopped-command",
            createdAt: "2026-01-01T00:00:01Z",
            runId,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "/bin/bash -lc 'sleep 90 && echo slept'",
            toolLifecycleStatus: "stopped",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(stoppedRows.map((row) => row.id)).toEqual(["stopped-command-entry", "interrupt-result"]);
    expect(stoppedRows[0]).toMatchObject({
      kind: "work",
      displayLabel: "sleep 90 && echo slept",
    });
  });
});

describe("streaming v2 row projection", () => {
  function fixture(text = "") {
    const source = makeStreamingTimelineFixture(text);
    const timelineInput = { visibleTurnItems: source.visibleTurnItems, optimisticMessages: [] };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
    const input = {
      timelineEntries: timeline.entries,
      latestRun: {
        runId: source.runId,
        status: "running" as const,
        startedAt: source.time(5),
        completedAt: null,
      },
      runningRunId: source.runId,
      isWorking: true,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaries: [
        {
          runId: source.historyRunId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/history"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("history-assistant"),
          completedAt: source.time(4),
        },
      ] satisfies ReadonlyArray<TurnDiffSummary>,
      supportsConversationRollback: true,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { ...source, timelineInput, timeline, input };
  }

  function updateText(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, text: string) {
    return items.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? {
            ...row,
            item: { ...row.item, text, updatedAt: DateTime.makeUnsafe("2026-09-04T00:00:08.000Z") },
          }
        : row,
    );
  }

  it.each([
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ])("keeps streamed row behavior consistent from %j to %j", (before, after) => {
    const initial = fixture(before);
    const previous = deriveMessagesTimelineRowsWithState(initial.input);
    Object.freeze(previous.rows);
    for (const row of previous.rows) Object.freeze(row);
    const timelineInput = {
      ...initial.timelineInput,
      visibleTurnItems: updateText(initial.visibleTurnItems, after),
    };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      timelineInput,
      initial.timeline,
    );
    // The actual v2 selectors recreate shell/checkpoint summaries on every
    // projection event, even when their contents did not change.
    const input = {
      ...initial.input,
      timelineEntries: timeline.entries,
      latestRun: { ...initial.input.latestRun },
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({ ...summary })),
    };
    const next = deriveMessagesTimelineRowsWithState(input, previous);
    expect(next.rows).toEqual(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
      }),
    );
    for (const [index, row] of previous.rows.entries()) {
      if (
        (row.kind === "message" || row.kind === "assistant-meta") &&
        row.message.id === "live-assistant"
      ) {
        expect(next.rows[index]).toMatchObject({ message: { text: after } });
        expect(next.rows[index]).toHaveProperty(
          "projectedItem",
          timelineInput.visibleTurnItems.at(-1),
        );
        expect(row.message.text).toBe(before);
      }
    }
  });

  it.each(["file", "image", "handoff", "streaming-image"] as const)(
    "keeps history references with %s previews through the v2 materializer",
    (kind) => {
      const initial = fixture("Partial");
      const image = {
        type: "image" as const,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 42,
      };
      const file = {
        type: "file" as const,
        id: "file",
        name: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
      };
      const timelineInput = {
        ...initial.timelineInput,
        visibleTurnItems: initial.visibleTurnItems.map((row, index) =>
          (row.item.type === "user_message" && index === 0) ||
          (row.item.type === "assistant_message" &&
            row.item.streaming &&
            kind === "streaming-image")
            ? {
                ...row,
                item: { ...row.item, attachments: kind === "file" ? [file] : [image, file] },
              }
            : row,
        ),
        attachmentUrlById: new Map([
          [image.id, kind === "handoff" ? "blob:handoff" : "https://server.test/image"],
        ]),
      };
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const previous = deriveMessagesTimelineRowsWithState(input);
      const nextTimelineInput = {
        ...timelineInput,
        visibleTurnItems: updateText(timelineInput.visibleTurnItems, "Next token"),
        attachmentUrlById: new Map(timelineInput.attachmentUrlById),
      };
      const nextTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        nextTimelineInput,
        timeline,
      );
      const nextInput = { ...input, timelineEntries: nextTimeline.entries };
      const next = deriveMessagesTimelineRowsWithState(nextInput, previous);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(nextInput));
      for (const [index, row] of previous.rows.entries()) {
        if (
          (row.kind === "message" || row.kind === "assistant-meta") &&
          row.message.id === "live-assistant"
        )
          continue;
        expect(next.rows[index]).toBe(row);
      }
      const renewedInput = {
        ...nextTimelineInput,
        attachmentUrlById: new Map([[image.id, "https://renewed.test/image"]]),
      };
      const renewedTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        renewedInput,
        nextTimeline,
      );
      const renewedRowsInput = { ...input, timelineEntries: renewedTimeline.entries };
      const renewed = deriveMessagesTimelineRowsWithState(renewedRowsInput, next);
      expect(renewed.rows).toEqual(deriveMessagesTimelineRows(renewedRowsInput));
      if (kind !== "file") {
        expect(renewed.rows.find((row) => row.id === "history-user")).toMatchObject({
          message: { attachments: [{ previewUrl: "https://renewed.test/image" }, file] },
        });
      }
    },
  );

  it("leaves emitted rows immutable when a projection branches", () => {
    const initial = fixture("Initial");
    const previous = deriveMessagesTimelineRowsWithState(initial.input);
    const branch = (text: string) => {
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        { ...initial.timelineInput, visibleTurnItems: updateText(initial.visibleTurnItems, text) },
        initial.timeline,
      );
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const next = deriveMessagesTimelineRowsWithState(input, previous);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(input));
      return next;
    };
    const first = branch("First");
    branch("Second");
    expect(first.rows.find((row) => row.id === "live-assistant")).toMatchObject({
      message: { text: "First" },
    });
    expect(previous.rows.find((row) => row.id === "live-assistant")).toMatchObject({
      message: { text: "Initial" },
    });
  });

  it("rebuilds for completion, late failure, metadata, expansion, and older history", () => {
    const initial = fixture("Partial");
    let timeline = initial.timeline;
    let timelineInput = initial.timelineInput;
    let input: Parameters<typeof deriveMessagesTimelineRows>[0] = initial.input;
    let projection = deriveMessagesTimelineRowsWithState(input);
    const check = (changes: Partial<typeof input> = {}) => {
      const previous = projection;
      timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
      input = { ...input, ...changes, timelineEntries: timeline.entries };
      projection = deriveMessagesTimelineRowsWithState(input, previous);
      expect(projection.rows).toEqual(
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
        }),
      );
      expect(previous.rows).toEqual(deriveMessagesTimelineRows(previous.input));
    };
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? {
              ...row,
              item: {
                ...row.item,
                streaming: false,
                status: "completed",
                text: "Complete",
                updatedAt: DateTime.makeUnsafe(initial.time(9)),
              },
            }
          : row,
      ),
    };
    check({
      latestRun: { ...initial.input.latestRun, status: "completed", completedAt: initial.time(9) },
      runningRunId: null,
      isWorking: false,
    });
    const lateFailure = initial.visibleTurnItems[1]!;
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        ...timelineInput.visibleTurnItems,
        {
          ...lateFailure,
          position: 6,
          sourceItemId: TurnItemId.make("late-failure"),
          item: {
            ...lateFailure.item,
            id: TurnItemId.make("late-failure"),
            runId: initial.runId,
            ordinal: 10,
            startedAt: DateTime.makeUnsafe(initial.time(10)),
          },
        },
      ],
    };
    check();
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.messageId === "live-assistant"
          ? {
              ...row,
              item: {
                ...row.item,
                text: "Corrected final text",
                updatedAt: DateTime.makeUnsafe(initial.time(11)),
              },
            }
          : row,
      ),
    };
    check();
    check({
      latestRun: {
        ...initial.input.latestRun,
        status: "interrupted",
        completedAt: initial.time(12),
      },
    });
    check({ expandedRunIds: new Set([initial.historyRunId, initial.runId]) });
    const group = projection.rows.find((row) => row.kind === "work-toggle");
    check({ expandedWorkGroupIds: new Set(group ? [group.groupId] : []) });
    const first = initial.visibleTurnItems[0]!;
    if (first.item.type !== "user_message") throw new Error("Expected user fixture");
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        {
          ...first,
          sourceItemId: TurnItemId.make("older-user-item"),
          item: {
            ...first.item,
            id: TurnItemId.make("older-user-item"),
            messageId: MessageId.make("older-user"),
            startedAt: DateTime.makeUnsafe(initial.time(-60)),
          },
        },
        ...timelineInput.visibleTurnItems,
      ].map((row, position) => ({ ...row, position })),
    };
    check();
    check({ supportsConversationRollback: false });
    check({
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({
        ...summary,
        status: "stale" as const,
      })),
    });
  });
});

describe("linked timeline resources", () => {
  const runId = RunId.make("resource-run");
  const event = (id: string, type: "subagent" | "thread_created", eventRunId = runId) => ({
    id,
    kind: "event" as const,
    createdAt: "2026-09-08T10:00:02Z",
    projectedItem: { item: { id, type, runId: eventRunId } } as OrchestrationV2ProjectedTurnItem,
  });
  const common = { isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false };

  it("previews a thought and separates subagent cards from worklogs", () => {
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        {
          kind: "work",
          id: "thought",
          createdAt: "2026-09-08T10:00:01Z",
          entry: {
            id: "thought",
            runId,
            createdAt: "2026-09-08T10:00:01Z",
            label: "Thought",
            itemType: "reasoning",
            tone: "thinking",
            detail: "First paragraph.\n\nSecond paragraph.",
          },
        },
        event("child", "subagent"),
        {
          kind: "message",
          id: "answer",
          createdAt: "2026-09-08T10:00:03Z",
          message: {
            id: MessageId.make("answer"),
            role: "assistant",
            text: "Done",
            runId,
            streaming: false,
            createdAt: "2026-09-08T10:00:03Z",
            updatedAt: "2026-09-08T10:00:03Z",
          },
        },
      ],
      expandedRunIds: new Set([runId]),
    });
    expect(rows.find((row) => row.kind === "work")).toMatchObject({
      displayLabel: "First paragraph. Second paragraph.",
    });
    expect(rows.find((row) => row.kind === "work")?.continuesWorkLog).toBeUndefined();
    expect(rows.find((row) => row.id === "child")?.continuesWorkLog).toBeUndefined();
  });

  it("groups adjacent subagents without merging across a resource or run boundary", () => {
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        event("a", "subagent"),
        event("b", "subagent"),
        event("c", "thread_created"),
        event("d", "subagent"),
        event("e", "subagent", RunId.make("other-run")),
      ],
      expandedRunIds: new Set([runId, RunId.make("other-run")]),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "a",
      "c",
      "d",
      "turn-fold:other-run",
      "e",
    ]);
    expect(rows[1]).toMatchObject({ subagents: [{ item: { id: "a" } }, { item: { id: "b" } }] });
  });

  it("folds agent IRC and job notices into the agent group instead of adding rows", () => {
    const notice = (id: string, fields: Record<string, unknown>) => ({
      kind: "work" as const,
      id,
      createdAt: "2026-09-08T10:00:03Z",
      entry: {
        id,
        runId,
        createdAt: "2026-09-08T10:00:03Z",
        label: "Notice",
        tone: "info" as const,
        itemType: "system_notice" as const,
        structuredPayload: { id, type: "system_notice", runId, ...fields } as never,
      },
    });
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        event("a", "subagent"),
        event("b", "subagent"),
        notice("irc", { message: "Found the parser branch", irc: { from: "Scout", to: "main" } }),
        notice("job", {
          message: "Background job completed",
          jobCompletion: { jobId: "a", type: "task", status: "completed", durationMs: 19_200 },
        }),
      ],
      expandedRunIds: new Set([runId]),
    });
    expect(rows.some((row) => row.id === "irc" || row.id === "job")).toBe(false);
    const group = rows.find((row) => row.id === "a");
    expect(group?.kind === "event" && group.absorbedNotices?.map(({ id }) => id)).toEqual([
      "irc",
      "job",
    ]);
  });

  it("keeps a late runless job completion inside its agent group after the turn folds", () => {
    const lateCompletion = {
      kind: "work" as const,
      id: "late-job",
      createdAt: "2026-09-08T10:00:09Z",
      entry: {
        id: "late-job",
        createdAt: "2026-09-08T10:00:09Z",
        label: "Background job completed",
        tone: "info" as const,
        itemType: "system_notice" as const,
        structuredPayload: {
          id: "late-job",
          type: "system_notice",
          runId: null,
          message: "Background job completed",
          jobCompletion: { jobId: "a", type: "task", status: "completed", durationMs: 45_000 },
        } as never,
      },
    };
    const timelineEntries = [event("a", "subagent"), lateCompletion];
    const folded = deriveMessagesTimelineRows({ ...common, timelineEntries });
    expect(folded.map((row) => row.id)).toEqual(["turn-fold:resource-run"]);

    const opened = deriveMessagesTimelineRows({
      ...common,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(opened.some((row) => row.id === "late-job")).toBe(false);
    const group = opened.find((row) => row.id === "a");
    expect(group?.kind === "event" && group.absorbedNotices?.map(({ id }) => id)).toEqual([
      "late-job",
    ]);
  });

  it("shows one plan per run at the first plan's position with the latest plan's content", () => {
    const plan = (id: string, createdAt: string) => ({
      id,
      kind: "event" as const,
      createdAt,
      projectedItem: {
        item: { id, type: "todo_list", runId, steps: [] as ReadonlyArray<unknown> },
      } as OrchestrationV2ProjectedTurnItem,
    });
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        plan("plan-1", "2026-09-08T10:00:01Z"),
        event("child", "subagent"),
        plan("plan-2", "2026-09-08T10:00:04Z"),
      ],
      expandedRunIds: new Set([runId]),
    });
    const planRows = rows.filter(
      (row) => row.kind === "event" && row.projectedItem.item.type === "todo_list",
    );
    expect(planRows).toHaveLength(1);
    expect(planRows[0]).toMatchObject({ id: "plan-1", projectedItem: { item: { id: "plan-2" } } });
    expect(rows.findIndex((row) => row.id === "plan-1")).toBeLessThan(
      rows.findIndex((row) => row.id === "child"),
    );
  });

  it("docks the run's latest plan under the prompt that started it instead of a row of its own", () => {
    const plan = (id: string, createdAt: string) => ({
      id,
      kind: "event" as const,
      createdAt,
      projectedItem: {
        item: { id, type: "todo_list", runId, steps: [] as ReadonlyArray<unknown> },
      } as OrchestrationV2ProjectedTurnItem,
    });
    const promptAt = "2026-09-08T10:00:00Z";
    const prompt: TimelineEntry = {
      kind: "message",
      id: "prompt",
      createdAt: promptAt,
      message: {
        id: MessageId.make("prompt"),
        role: "user",
        text: "Plan the change",
        createdAt: promptAt,
        updatedAt: promptAt,
        streaming: false,
        runId,
      },
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        prompt,
        plan("plan-1", "2026-09-08T10:00:01Z"),
        event("child", "subagent"),
        plan("plan-2", "2026-09-08T10:00:04Z"),
      ],
      expandedRunIds: new Set([runId]),
    });
    expect(
      rows.some((row) => row.kind === "event" && row.projectedItem.item.type === "todo_list"),
    ).toBe(false);
    expect(rows.find((row) => row.id === "prompt")).toMatchObject({
      kind: "message",
      plan: { item: { id: "plan-2" } },
      planRunLive: false,
    });
  });

  it("turns OMP todo work steps into the same single strip and keeps the last reported plan in flight", () => {
    const todoStep = (id: string, createdAt: string, status: "completed" | "running") => {
      const projectedItem = {
        item: { id, type: "dynamic_tool", toolName: "todo", runId, status },
      } as OrchestrationV2ProjectedTurnItem;
      return {
        kind: "work" as const,
        id,
        createdAt,
        entry: {
          id,
          runId,
          createdAt,
          label: "todo",
          tone: "tool" as const,
          itemType: "dynamic_tool" as const,
          projectedItem,
        },
      };
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        todoStep("todo-1", "2026-09-08T10:00:01Z", "completed"),
        event("child", "subagent"),
        todoStep("todo-2", "2026-09-08T10:00:04Z", "completed"),
        todoStep("todo-3", "2026-09-08T10:00:06Z", "running"),
      ],
      expandedRunIds: new Set([runId]),
    });
    expect(rows.filter((row) => row.id.startsWith("todo-")).map((row) => row.id)).toEqual([
      "todo-1",
    ]);
    expect(rows.find((row) => row.id === "todo-1")).toMatchObject({
      kind: "event",
      projectedItem: { item: { id: "todo-2" } },
    });
    expect(rows.some((row) => row.kind === "work" || row.kind === "work-toggle")).toBe(false);
  });

  it("reports each later OMP todo update inline and keeps the docked plan current", () => {
    type Task = { content: string; status: string; blocker?: string };
    const todoStep = (id: string, tasks: ReadonlyArray<Task> | null) => {
      const createdAt = "2026-09-08T10:00:03Z";
      const projectedItem = {
        item: {
          id,
          type: "dynamic_tool",
          toolName: "todo",
          runId,
          status: tasks === null ? "running" : "completed",
          ...(tasks === null ? {} : { details: { phases: [{ name: "Work", tasks }] } }),
        },
      } as OrchestrationV2ProjectedTurnItem;
      return {
        kind: "work" as const,
        id,
        createdAt,
        entry: {
          id,
          runId,
          createdAt,
          label: "todo",
          tone: "tool" as const,
          itemType: "dynamic_tool" as const,
          projectedItem,
        },
      };
    };
    const promptAt = "2026-09-08T10:00:00Z";
    const prompt: TimelineEntry = {
      kind: "message",
      id: "prompt",
      createdAt: promptAt,
      message: {
        id: MessageId.make("prompt"),
        role: "user",
        text: "Ship it",
        createdAt: promptAt,
        updatedAt: promptAt,
        streaming: false,
        runId,
      },
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        prompt,
        todoStep("todo-1", [
          { content: "Read", status: "completed" },
          { content: "Edit", status: "in_progress" },
          { content: "Bench", status: "pending" },
          { content: "Wait", status: "pending" },
        ]),
        todoStep("todo-2", [
          { content: "Read", status: "completed" },
          { content: "Edit", status: "completed" },
          { content: "Bench", status: "abandoned" },
          { content: "Wait", status: "blocked", blocker: "Jobs running" },
          { content: "Docs", status: "pending" },
        ]),
        // Starting, unblocking and pruning finished work say nothing; an
        // unfinished task leaving the list was dropped.
        todoStep("todo-3", [
          { content: "Bench", status: "abandoned" },
          { content: "Wait", status: "in_progress" },
        ]),
        todoStep("todo-4", [
          { content: "Bench", status: "abandoned" },
          { content: "Wait", status: "in_progress" },
        ]),
        todoStep("todo-5", null),
      ],
      expandedRunIds: new Set([runId]),
    });
    expect(
      rows.flatMap((row) => (row.kind === "todo-update" ? [[row.id, row.changes]] : [])),
    ).toEqual([
      ["todo-1", [{ kind: "planned", count: 4 }]],
      [
        "todo-2",
        [
          { kind: "completed", content: "Edit" },
          { kind: "dropped", content: "Bench" },
          { kind: "blocked", content: "Wait", blocker: "Jobs running" },
          { kind: "added", content: "Docs" },
        ],
      ],
      ["todo-3", [{ kind: "dropped", content: "Docs" }]],
    ]);
    expect(rows.find((row) => row.id === "prompt")).toMatchObject({
      plan: { item: { id: "todo-4" } },
    });

    // The prompt row is reused between derives; a newer plan must still reach
    // the docked list, and settling hands the list to the recap under the answer.
    const firstPlan = todoStep("todo-1", [{ content: "Read", status: "in_progress" }]);
    const secondPlan = todoStep("todo-2", [{ content: "Read", status: "completed" }]);
    const edit = (id: string, fileName: string, additions: number, deletions: number) => ({
      kind: "work" as const,
      id,
      createdAt: "2026-09-08T10:00:04Z",
      entry: {
        id,
        runId,
        createdAt: "2026-09-08T10:00:04Z",
        label: "edit",
        tone: "tool" as const,
        itemType: "file_change" as const,
        structuredPayload: {
          type: "file_change",
          status: "completed",
          fileName,
          additions,
          deletions,
        } as OrchestrationV2TurnItem,
      },
    });
    const answerAt = "2026-09-08T10:00:05Z";
    const answer: TimelineEntry = {
      kind: "message",
      id: "answer",
      createdAt: answerAt,
      message: {
        id: MessageId.make("answer"),
        role: "assistant",
        text: "Done",
        createdAt: answerAt,
        updatedAt: answerAt,
        streaming: false,
        runId,
      },
    };
    const working = { ...common, isWorking: true, runningRunId: runId };
    const started = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({ ...working, timelineEntries: [prompt, firstPlan] }),
      { byId: new Map(), result: [] },
    );
    const updated = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({
        ...working,
        timelineEntries: [prompt, firstPlan, secondPlan, edit("edit-1", "a.ts", 3, 1), answer],
      }),
      started,
    );
    const settled = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({
        ...common,
        timelineEntries: [
          prompt,
          firstPlan,
          secondPlan,
          edit("edit-1", "a.ts", 3, 1),
          edit("edit-2", "a.ts", 2, 0),
          edit("edit-3", "b.ts", 0, 4),
          answer,
        ],
      }),
      updated,
    );
    const row = (state: typeof started, id: string) =>
      state.result.find((candidate) => candidate.id === id);
    expect(row(updated, "prompt")).toMatchObject({
      plan: { item: { id: "todo-2" } },
      planRunLive: true,
    });
    expect(row(updated, "answer")).toMatchObject({ turnRecap: undefined });
    expect(row(settled, "prompt")).not.toHaveProperty("plan");
    expect(row(settled, "answer")).toMatchObject({
      turnRecap: {
        runId,
        todos: [{ content: "Read", status: "completed" }],
        files: [
          { path: "a.ts", additions: 5, deletions: 1 },
          { path: "b.ts", additions: 0, deletions: 4 },
        ],
        checkpoint: false,
      },
    });
  });

  it.each([
    { status: "completed", envelope: "direct", role: "general" },
    { status: "completed", envelope: "structured", role: "general" },
    { status: "completed", envelope: "text", role: "general" },
    { status: "completed", envelope: "structured", role: "research" },
    { status: "running", envelope: "direct", role: "general" },
    { status: "running", envelope: "direct", role: "research" },
  ] as const)(
    "matches $status $role delegation calls by child identity with $envelope output",
    ({ status, envelope, role }) => {
      const child = (id: string) => {
        const entry = event(id, "subagent");
        return {
          ...entry,
          projectedItem: {
            item: {
              ...entry.projectedItem.item,
              origin: "app_owned",
              subagentId: id,
              prompt:
                role === "general" ? id : `Act as the ${role} sub-agent for this task.\n\n${id}`,
              childThreadId: null,
            },
          } as OrchestrationV2ProjectedTurnItem,
        };
      };
      const delegation = (id: string, taskId: string, failed = false): TimelineEntry => ({
        id,
        kind: "work",
        createdAt: "2026-09-08T10:00:02Z",
        entry: {
          id,
          runId,
          createdAt: "2026-09-08T10:00:02Z",
          label: "Delegated a child task",
          tone: failed ? "error" : "tool",
          itemType: "dynamic_tool",
          toolLifecycleStatus: failed
            ? "failed"
            : status === "running"
              ? "inProgress"
              : "completed",
          projectedItem: {
            item: {
              id,
              runId,
              type: "dynamic_tool",
              status: failed ? "failed" : status,
              toolName: "t3-code.delegate_task",
              input: { task: taskId === "b" ? "a" : taskId, role },
              ...(status === "completed"
                ? {
                    output:
                      envelope === "structured"
                        ? { content: JSON.stringify({ taskId }), structuredContent: { taskId } }
                        : envelope === "text"
                          ? { content: [{ type: "text", text: JSON.stringify({ taskId }) }] }
                          : { taskId },
                  }
                : {}),
            },
          } as OrchestrationV2ProjectedTurnItem,
        },
      });
      const rows = deriveMessagesTimelineRows({
        ...common,
        isWorking: status === "running",
        runningRunId: status === "running" ? runId : null,
        timelineEntries: [
          child("a"),
          delegation("delegate-a", "a"),
          ...(status === "completed" ? [child("b")] : []),
          delegation("delegate-b", "b"),
          delegation("unmatched", "other-child"),
          child("c"),
          delegation("failed", "c", true),
          child("d"),
        ],
        expandedRunIds: new Set([runId]),
      });
      const agentGroups = rows.filter(
        (row) => row.kind === "event" && row.projectedItem.item.type === "subagent",
      );
      const agentIds = agentGroups.flatMap((row) => {
        if (row.kind !== "event" || row.projectedItem.item.type !== "subagent") return [];
        return (row.subagents ?? [row.projectedItem]).flatMap((member) =>
          member.item.type === "subagent" ? [String(member.item.subagentId)] : [],
        );
      });
      expect(agentGroups).toHaveLength(1);
      expect(agentIds).toEqual(status === "completed" ? ["a", "b", "c", "d"] : ["a", "c", "d"]);
      const visibleTools = rows.flatMap((row) =>
        row.kind === "work" || row.kind === "work-live"
          ? row.groupedEntries.map((entry) => entry.id)
          : [],
      );
      expect(visibleTools).toContain("unmatched");
      expect(visibleTools).toContain("failed");
      expect(visibleTools.includes("delegate-a")).toBe(status === "running");
      expect(visibleTools.includes("delegate-b")).toBe(status === "running");
    },
  );

  it("matches persisted output-less delegate_task device writes to children by clientRequestId", () => {
    const clientRequestId = "delegation-request-123";
    const childThreadId = ThreadId.make(
      `thread:delegated-task:command%3Amcp%3Acommand-uuid%3Adelegate-task%3A${clientRequestId}`,
    );
    const child = event("delegate-child", "subagent");
    const childEntry = {
      ...child,
      projectedItem: {
        item: {
          ...child.projectedItem.item,
          origin: "app_owned",
          subagentId: NodeId.make("task:delegate-child"),
          childThreadId,
        },
      } as OrchestrationV2ProjectedTurnItem,
    };
    const delegateCall: TimelineEntry = {
      id: "delegate-write",
      kind: "work",
      createdAt: "2026-09-08T10:00:01Z",
      entry: {
        id: "delegate-write",
        runId,
        createdAt: "2026-09-08T10:00:01Z",
        label: "Wrote xd://mcp__t3-code__delegate_task",
        tone: "tool",
        itemType: "file_change",
        toolLifecycleStatus: "completed",
        projectedItem: {
          item: {
            id: TurnItemId.make("delegate-write"),
            threadId: ThreadId.make("parent-thread"),
            runId,
            type: "file_change",
            status: "completed",
            title: "write",
            fileName: "xd://mcp__t3-code__delegate_task",
            additions: 1,
            deletions: 0,
            newStr: JSON.stringify({ task: "Inspect the timeline", clientRequestId }),
          },
        } as OrchestrationV2ProjectedTurnItem,
      },
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [delegateCall, childEntry],
      expandedRunIds: new Set([runId]),
    });
    const visibleTools = rows.flatMap((row) =>
      row.kind === "work" || row.kind === "work-live"
        ? row.groupedEntries.map((entry) => entry.id)
        : [],
    );
    expect(visibleTools).not.toContain("delegate-write");
  });

  it("drops a native task call row once its children render in the agent panel", () => {
    const child = (id: string) => {
      const entry = event(id, "subagent");
      return {
        ...entry,
        projectedItem: {
          item: { ...entry.projectedItem.item, subagentId: id, parentItemId: "task-call" },
        } as OrchestrationV2ProjectedTurnItem,
      };
    };
    const taskCall: TimelineEntry = {
      id: "task-call",
      kind: "work",
      createdAt: "2026-09-08T10:00:02Z",
      entry: {
        id: "task-call",
        runId,
        createdAt: "2026-09-08T10:00:02Z",
        label: "Delegated Schema Reviewer +1",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        projectedItem: {
          item: {
            id: "task-call",
            runId,
            type: "dynamic_tool",
            status: "completed",
            toolName: "task",
            input: { context: "Shared context" },
          },
        } as OrchestrationV2ProjectedTurnItem,
      },
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [taskCall, child("schema"), child("timeline")],
      expandedRunIds: new Set([runId]),
    });
    const visibleTools = rows.flatMap((row) =>
      row.kind === "work" || row.kind === "work-live"
        ? row.groupedEntries.map((entry) => entry.id)
        : [],
    );
    expect(visibleTools).not.toContain("task-call");
    expect(rows.find((row) => row.id === "schema")).toMatchObject({
      subagents: [{ item: { id: "schema" } }, { item: { id: "timeline" } }],
      taskCall: { id: "task-call" },
    });
  });

  it("keeps created-chat summaries after the final answer and folds only their timeline rows", () => {
    const timelineEntries = [
      {
        kind: "message" as const,
        id: "intro",
        createdAt: "2026-09-08T10:00:00Z",
        message: {
          id: MessageId.make("intro"),
          role: "assistant" as const,
          text: "Creating the chat",
          runId,
          streaming: false,
          createdAt: "2026-09-08T10:00:00Z",
          updatedAt: "2026-09-08T10:00:00Z",
        },
      },
      event("created", "thread_created"),
      {
        kind: "message" as const,
        id: "final",
        createdAt: "2026-09-08T10:00:04Z",
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Chat is ready",
          runId,
          streaming: false,
          createdAt: "2026-09-08T10:00:04Z",
          updatedAt: "2026-09-08T10:00:04Z",
        },
      },
    ];
    const collapsed = deriveMessagesTimelineRows({ ...common, timelineEntries });
    expect(collapsed.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
    expect(collapsed.find((row) => row.id === "summary:created")).toMatchObject({
      resourceSummary: true,
    });
    const expanded = deriveMessagesTimelineRows({
      ...common,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(expanded.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "intro",
      "created",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
  });
  it("deduplicates notifications for same-turn children but keeps unmatched child wakes", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "user_message");
    if (!source || source.item.type !== "user_message") {
      throw new Error("Expected user message fixture");
    }
    const sameTurnTaskId = NodeId.make("task-in-current-turn");
    const olderTaskId = NodeId.make("task-from-older-turn");
    const olderRunId = RunId.make("older-child-run");
    const notification = (id: string, runId: RunId, taskId: NodeId) => ({
      ...source,
      item: {
        ...source.item,
        id: TurnItemId.make(id),
        providerThreadId: null,
        type: "notification" as const,
        runId,
        source: { kind: "delegated_task" as const, taskIds: [taskId] },
        outcome: "completed" as const,
        summary: "Delegated task finished",
      },
    });
    const child = event("in-turn-child", "subagent", fixture.runId);
    const childEntry = {
      ...child,
      projectedItem: {
        item: {
          ...child.projectedItem.item,
          origin: "app_owned",
          subagentId: sameTurnTaskId,
          childThreadId: null,
        },
      } as OrchestrationV2ProjectedTurnItem,
    };
    const notificationEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        notification("same-turn-notification", fixture.runId, sameTurnTaskId),
        notification("older-child-notification", olderRunId, olderTaskId),
      ],
      optimisticMessages: [],
    });
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [childEntry, ...notificationEntries],
      expandedRunIds: new Set([fixture.runId, olderRunId]),
    });
    const visibleWorkIds = rows.flatMap((row) =>
      row.kind === "work" || row.kind === "work-live"
        ? row.groupedEntries.map((entry) => entry.id)
        : [],
    );
    expect(visibleWorkIds).not.toContain("same-turn-notification");
    expect(visibleWorkIds).toContain("older-child-notification");
  });
});

it.each([true, false])(
  "keeps a wake notification visible outside folded work, working=%s",
  (isWorking) => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "user_message")!;
    if (source.item.type !== "user_message") throw new Error("Expected user message fixture");
    const notification = {
      ...source,
      item: {
        ...source.item,
        type: "notification" as const,
        source: { kind: "background_task" as const },
        outcome: "completed" as const,
        summary: "Delegated task finished",
      },
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: fixture.visibleTurnItems.map((row) =>
        row === source ? notification : row,
      ),
      optimisticMessages: [],
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking,
      runningRunId: fixture.runId,
      activeTurnStartedAt: fixture.time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(
      rows.some(
        (row) =>
          row.kind === "work" &&
          row.groupedEntries.some((entry) => entry.label === "Delegated task finished"),
      ),
    ).toBe(true);
  },
);

it.each([true, false])(
  "keeps completed responses folded across notification wakes, working=%s",
  (isWorking) => {
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const work = (id: string, run: string, second: number, notification = false) => ({
      kind: "work" as const,
      id,
      createdAt: time(second),
      entry: {
        id,
        runId: RunId.make(run),
        createdAt: time(second),
        label: id,
        tone: "info" as const,
        ...(notification ? { itemType: "notification" as const } : {}),
      },
    });
    const answer = (id: string, run: string, second: number) => ({
      kind: "message" as const,
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role: "assistant" as const,
        text: id,
        runId: RunId.make(run),
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("launch-tools", "initial", 1),
        answer("launched", "initial", 5),
        work("notification-a", "wake-a", 20, true),
        work("read-a", "wake-a", 21),
        answer("ack-a", "wake-a", 25),
        work("notification-b", "wake-b", 40, true),
        work("read-b", "wake-b", 41),
        ...(!isWorking ? [answer("ack-b", "wake-b", 45)] : []),
      ],
      latestRun: {
        runId: RunId.make("wake-b"),
        status: isWorking ? "running" : "completed",
        startedAt: time(40),
        completedAt: isWorking ? null : time(45),
      },
      isWorking,
      activeTurnStartedAt: time(40),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain("turn-fold:initial");
    expect(ids).not.toContain("launch-tools");
    expect(ids).toContain("turn-fold:wake-a");
    expect(ids.indexOf("notification-a")).toBeLessThan(ids.indexOf("turn-fold:wake-a"));
    expect(ids.indexOf("turn-fold:wake-a")).toBeLessThan(ids.indexOf("ack-a"));
    const boundary = isWorking ? "working-indicator-row" : "turn-fold:wake-b";
    expect(ids).toContain(boundary);
    expect(ids.indexOf("notification-b")).toBeLessThan(ids.indexOf(boundary));
    if (isWorking) expect(rows.find((row) => row.id === boundary)?.createdAt).toBe(time(40));
  },
);

it("preserves worktree setup visibility across handoff", () => {
  const snapshot: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("thread-setup"),
    phase: "running",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
    sequence: 3,
  };
  const userEntry = {
    id: "user-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: "user-1" as never,
      role: "user",
      text: "Build it",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  } as const;
  const assistantEntry = {
    id: "assistant-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:30Z",
    message: {
      id: "assistant-1" as never,
      role: "assistant",
      text: "On it",
      runId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:30Z",
      updatedAt: "2026-01-01T00:00:30Z",
      streaming: true,
    },
  } as const;
  const expectStatusAfterUser = (rows: ReadonlyArray<MessagesTimelineRow>) => {
    const workingRows = rows.filter((row) => row.id === "working-indicator-row");
    expect(workingRows).toHaveLength(1);
    expect(workingRows[0]).toMatchObject({ kind: "working", status: "working" });
    expect(rows.findIndex((row) => row.id === "working-indicator-row")).toBeGreaterThan(
      rows.findIndex((row) => row.id === userEntry.id),
    );
  };
  const withoutMessages = deriveMessagesTimelineRows({
    timelineEntries: [],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: snapshot,
  });
  expect(withoutMessages.find((row) => row.id === "working-indicator-row")).toMatchObject({
    kind: "working",
    status: "working",
  });
  expect(withoutMessages.find((row) => row.id === "worktree-setup-row")).toMatchObject({
    kind: "worktree-setup",
    snapshot: { phase: "running" },
    embedded: false,
  });

  // A failed setup never handed off, so the card stays under the send.
  const withMessages = deriveMessagesTimelineRows({
    timelineEntries: [userEntry, assistantEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: { ...snapshot, phase: "failed" },
  });
  expectStatusAfterUser(withMessages);
  expect(withMessages.find((row) => row.id === "worktree-setup-row")).toMatchObject({
    kind: "worktree-setup",
    snapshot: { phase: "failed" },
    embedded: false,
  });

  // With the agent turn live, an unfinished setup script belongs to the working header.
  const stage = (id: "agent" | "setup-script", status: "done" | "running") =>
    ({
      id,
      status,
      startedAt: "2026-01-01T00:00:10Z",
      endedAt: status === "done" ? "2026-01-01T00:00:11Z" : null,
      percent: null,
      detail: null,
      tail: [],
    }) as const;
  const asyncSnapshot: WorktreeSetupSnapshot = {
    ...snapshot,
    stages: [stage("setup-script", "running"), stage("agent", "done")],
  };
  const liveTurn = {
    runId: "turn-1" as never,
    status: "running",
    startedAt: "2026-01-01T00:00:11Z",
    completedAt: null,
  } as const;
  const asyncRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expectStatusAfterUser(asyncRows);
  expect(asyncRows.find((row) => row.id === "worktree-setup-row")).toBeUndefined();

  // Dispatched but not yet visible as a turn: the full card stays put so
  // nothing collapses during the handoff.
  const handoffRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expectStatusAfterUser(handoffRows);
  expect(handoffRows.find((row) => row.id === "worktree-setup-row")).toMatchObject({
    kind: "worktree-setup",
    snapshot: { phase: "running" },
    embedded: false,
  });

  // A clean finish before the turn is live keeps that same layout, so the card
  // does not jump above the header in the gap before the run starts.
  const settledRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...snapshot,
      phase: "done",
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expectStatusAfterUser(settledRows);
  expect(settledRows.find((row) => row.id === "worktree-setup-row")).toMatchObject({
    kind: "worktree-setup",
    snapshot: { phase: "done" },
    embedded: false,
  });

  // A script that already finished has nothing left to show once the turn is live.
  const finishedRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...asyncSnapshot,
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expectStatusAfterUser(finishedRows);
  expect(finishedRows.find((row) => row.id === "worktree-setup-row")).toBeUndefined();
});

describe("failed turn transcript", () => {
  it.each(["provider_error", "usage_limit"] as const)(
    "keeps historical %s failures and preceding work visible without disclosures",
    (failureClass) => {
      const runId = RunId.make("failed-run");
      const threadId = ThreadId.make("failed-thread");
      const at = DateTime.makeUnsafe("2026-09-20T12:00:00Z");
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      const items: OrchestrationV2ProjectedTurnItem[] = [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("user"),
          item: {
            ...base,
            id: TurnItemId.make("user"),
            type: "user_message",
            status: "completed",
            messageId: MessageId.make("user"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            text: "Build it",
            attachments: [],
          },
        },
        {
          position: 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("command"),
          item: {
            ...base,
            id: TurnItemId.make("command"),
            type: "command_execution",
            status: "completed",
            input: "pwd",
            output: "",
            exitCode: 0,
          },
        },
        {
          position: 2,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("failure"),
          item: {
            ...base,
            id: TurnItemId.make("failure"),
            type: "error",
            status: "failed",
            failure: {
              class: failureClass,
              message: "The provider stopped this turn.\nRetry later.",
              code: null,
              retryable: true,
            },
          },
        },
      ];
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items,
          optimisticMessages: [],
        }).map((entry) => ({
          ...entry,
          attempt: {
            id: RunAttemptId.make("superseded-attempt"),
            runId,
            attemptOrdinal: 1,
            rootNodeId: NodeId.make("superseded-root"),
            status: "superseded" as const,
          },
        })),
        latestRun: {
          runId: RunId.make("newer-run"),
          status: "completed",
          startedAt: DateTime.formatIso(at),
          completedAt: DateTime.formatIso(at),
        },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(
        rows.some(
          (row) =>
            row.kind === "turn-fold" || row.kind === "attempt-fold" || row.kind === "work-toggle",
        ),
      ).toBe(false);
      const work = rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
      expect(work.map((entry) => entry.id)).toEqual(["command", "failure"]);
      expect(work.at(-1)?.detail).toBe("The provider stopped this turn.\nRetry later.");
      expect(work.at(-1)?.createdAt).toBe("2026-09-20T12:00:00.000Z");
      const entriesWithoutTools = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.filter((row) => row.item.type !== "command_execution"),
        optimisticMessages: [],
      });
      entriesWithoutTools.splice(1, 0, {
        kind: "message",
        id: "assistant-before-failure",
        createdAt: DateTime.formatIso(at),
        message: {
          id: MessageId.make("assistant-before-failure"),
          role: "assistant",
          runId,
          text: "Checking the workspace.",
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
          streaming: false,
        },
      });
      const compactRows = deriveMessagesTimelineRows({
        timelineEntries: entriesWithoutTools,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(compactRows.map((row) => row.kind)).toEqual([
        "message",
        "message",
        "work",
        "assistant-meta",
      ]);
      expect(compactRows[1]).toMatchObject({ showAssistantMeta: false });
      expect(compactRows.at(-1)).toMatchObject({
        kind: "assistant-meta",
        showAssistantCopyButton: true,
        message: { id: "assistant-before-failure" },
      });
    },
  );
});

describe("live subagents after their parent turn settles", () => {
  const runId = RunId.make("parent-run");
  const threadId = ThreadId.make("parent-thread");
  const providerTurnId = ProviderTurnId.make("parent-provider-turn");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-10-06T10:00:${String(second).padStart(2, "0")}Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const projected = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  });
  const child = (
    id: string,
    second: number,
    status: OrchestrationV2TurnItem["status"],
    origin: "app_owned" | "provider_native" = "app_owned",
  ): OrchestrationV2TurnItem => ({
    ...base(id, second),
    status,
    completedAt: status === "running" ? null : at(second),
    type: "subagent",
    subagentId: NodeId.make(id),
    origin,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: origin === "app_owned" ? ThreadId.make(`${id}-thread`) : null,
    prompt: `Inspect ${id}`,
    result: null,
  });
  it("merges native Task children from separate parent calls in the same run", () => {
    const firstTask = TurnItemId.make("native-task-one");
    const secondTask = TurnItemId.make("native-task-two");
    const rows = rowsFor(
      [
        { ...child("alpha", 2, "running", "provider_native"), parentItemId: firstTask },
        { ...child("beta", 3, "running", "provider_native"), parentItemId: firstTask },
        { ...child("gamma", 4, "running", "provider_native"), parentItemId: secondTask },
      ],
      [],
      new Set([runId]),
    );
    const rosters = rows.filter(
      (row) => row.kind === "event" && row.projectedItem.item.type === "subagent",
    );
    expect(rosters).toHaveLength(1);
    expect(rosters[0]).toMatchObject({
      subagents: [{ item: { id: "alpha" } }, { item: { id: "beta" } }, { item: { id: "gamma" } }],
    });
  });

  const liveChild = (
    id: string,
    status: TimelineLiveSubagent["status"],
    startedAt: number,
    completedAt: number | null,
  ): TimelineLiveSubagent => ({
    id: NodeId.make(id),
    status,
    startedAt: DateTime.formatIso(at(startedAt)),
    completedAt: completedAt === null ? null : DateTime.formatIso(at(completedAt)),
  });
  const rowsFor = (
    children: ReadonlyArray<OrchestrationV2TurnItem>,
    liveSubagents: ReadonlyArray<TimelineLiveSubagent> = [],
    expandedRunIds?: ReadonlySet<RunId>,
  ) =>
    deriveMessagesTimelineRows({
      ...(expandedRunIds === undefined ? {} : { expandedRunIds }),
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: (
          [
            {
              ...base("user", 0),
              status: "completed",
              type: "user_message",
              messageId: MessageId.make("user"),
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              text: "Delegate the review",
              attachments: [],
            },
            {
              ...base("reasoning", 1),
              status: "completed",
              type: "reasoning",
              text: "Two children can split this.",
              streaming: false,
            },
            {
              ...base("command", 2),
              status: "completed",
              type: "command_execution",
              input: "pwd",
              output: "/repo",
              exitCode: 0,
            },
            ...children,
            {
              ...base("assistant", 8),
              status: "completed",
              type: "assistant_message",
              messageId: MessageId.make("assistant"),
              text: "Both children are running.",
              streaming: false,
            },
          ] satisfies OrchestrationV2TurnItem[]
        ).map(projected),
        optimisticMessages: [],
      }),
      latestRun: {
        runId,
        status: "completed",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: DateTime.formatIso(at(8)),
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      liveSubagentSources: new Map([[threadId, liveSubagents]]),
    });

  it.each(["app_owned", "provider_native"] as const)(
    "keeps a running %s child visible while the rest of the settled turn folds",
    (origin) => {
      const rows = rowsFor([child("child", 3, "running", origin)]);
      // The reasoning and command still fold; only the live card stays out.
      expect(rows.map((row) => row.id)).toEqual([
        "user",
        `turn-fold:${runId}`,
        "child",
        "assistant",
      ]);
    },
  );

  it.each(["completed", "failed"] as const)("folds a %s child with its settled turn", (status) => {
    const rows = rowsFor([child("child", 3, status)]);
    expect(rows.some((row) => row.id === "child")).toBe(false);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(true);
  });

  it("keeps only live members of a launch batch visible", () => {
    const children = [child("done", 3, "completed"), child("live", 4, "running")];
    const rows = rowsFor(children);
    const visibleLiveChild = rows.find((row) => row.id === "live");
    expect(visibleLiveChild?.kind).toBe("event");
    if (visibleLiveChild?.kind !== "event") throw new Error("Expected the live child event");
    expect(visibleLiveChild.projectedItem.item).toMatchObject({
      type: "subagent",
      subagentId: NodeId.make("live"),
      status: "running",
    });
    expect(rows.some((row) => row.id === "done")).toBe(false);
    expect(rows.some((row) => row.kind === "turn-fold" && row.runId === runId)).toBe(true);

    const expandedRows = rowsFor(children, [], new Set([runId]));
    const foldedCompletedChild = expandedRows.find((row) => row.id === "done");
    expect(foldedCompletedChild?.kind).toBe("event");
    if (foldedCompletedChild?.kind !== "event") {
      throw new Error("Expected the completed child in the expanded turn");
    }
    expect(foldedCompletedChild.projectedItem.item).toMatchObject({
      type: "subagent",
      subagentId: NodeId.make("done"),
      status: "completed",
    });
  });
  it("uses live terminal child lifecycles to hide stale running snapshots", () => {
    const rows = rowsFor(
      [child("ended-a", 3, "running"), child("ended-b", 4, "running")],
      [liveChild("ended-a", "completed", 3, 6), liveChild("ended-b", "failed", 4, 7)],
    );
    expect(rows.map((row) => row.id)).toEqual(["user", `turn-fold:${runId}`, "assistant"]);
  });

  it("keeps a running child visible when a steer supersedes its attempt", () => {
    const attempt = {
      id: RunAttemptId.make("superseded-attempt"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("superseded-root"),
      status: "superseded" as const,
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: (
        [
          {
            ...base("command", 2),
            status: "completed",
            type: "command_execution",
            input: "pwd",
            output: "/repo",
            exitCode: 0,
          },
          child("child", 3, "running"),
        ] satisfies OrchestrationV2TurnItem[]
      ).map(projected),
      optimisticMessages: [],
    }).map((entry) => ({ ...entry, attempt }));
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId,
        status: "running",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([`attempt-fold:${attempt.id}`, "child"]);
  });
});
describe("current timeline lifecycle status", () => {
  it("waits for required foreground agents but not independent background work", () => {
    const runId = RunId.make("activity-run");
    const activeSubagent = { runId, status: "running" as const };

    expect(
      hasRequiredForegroundAgents({
        runId,
        subagents: [{ ...activeSubagent, completionWake: "always" as const }],
      }),
    ).toBe(false);
    expect(
      hasRequiredForegroundAgents({
        runId,
        subagents: [{ ...activeSubagent, completionWake: "settled_only" as const }],
      }),
    ).toBe(true);
    expect(hasRequiredForegroundAgents({ runId, subagents: [activeSubagent] })).toBe(true);
  });
  it("clears a retry label after resumed activity and lets native work end win", () => {
    const runId = RunId.make("retry-run");
    const providerTurnId = ProviderTurnId.make("retry-turn");
    const retryItem = {
      position: 1,
      visibility: "local",
      sourceThreadId: ThreadId.make("retry-thread"),
      sourceItemId: TurnItemId.make("retry-item"),
      item: {
        id: TurnItemId.make("retry-item"),
        type: "error",
        runId,
        providerTurnId,
        status: "completed",
        retry: { attempt: 1 },
      },
    } as unknown as OrchestrationV2ProjectedTurnItem;
    const resumedActivity = {
      position: 2,
      visibility: "local",
      sourceThreadId: ThreadId.make("retry-thread"),
      sourceItemId: TurnItemId.make("resumed-item"),
      item: {
        id: TurnItemId.make("resumed-item"),
        type: "reasoning",
        runId,
        providerTurnId,
        status: "completed",
      },
    } as unknown as OrchestrationV2ProjectedTurnItem;
    expect(
      isCurrentProviderRetryActive({
        runId,
        providerTurnId,
        visibleTurnItems: [retryItem],
      }),
    ).toBe(true);
    expect(
      isCurrentProviderRetryActive({
        runId,
        providerTurnId,
        visibleTurnItems: [retryItem, resumedActivity],
      }),
    ).toBe(false);

    const base = {
      isWorking: true,
      hasUnsettledRun: true,
      runlessWorkActive: false,
      awaitingUser: false,
      retrying: true,
      workCompletedAt: null,
      waitingForAgents: false,
      waitingOnBackgroundJob: false,
    };
    expect(deriveMessagesTimelineActivityStatus(base)).toBe("retry");
    expect(
      deriveMessagesTimelineActivityStatus({ ...base, workCompletedAt: "2026-10-06T10:00:05Z" }),
    ).toBe("finishing");
    expect(
      deriveMessagesTimelineActivityStatus({
        ...base,
        workCompletedAt: "2026-10-06T10:00:05Z",
        waitingForAgents: true,
      }),
    ).toBe("waiting-for-agents");
    expect(deriveMessagesTimelineActivityStatus({ ...base, waitingOnBackgroundJob: true })).toBe(
      "monitoring",
    );
  });
});

describe("timeline activity disclosure policy and progressive disclosure transitions", () => {
  const runId = RunId.make("test-run-1");
  const startedAt = "2026-10-15T10:00:00.000Z";

  const makeMsg = (
    id: string,
    role: "user" | "assistant" | "system",
    text: string,
    createdAt: string,
    streaming = false,
  ): TimelineEntry => ({
    kind: "message",
    id,
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text,
      createdAt,
      updatedAt: createdAt,
      streaming,
      runId,
    },
  });

  const makeReasoning = (
    id: string,
    createdAt: string,
    text: string,
    streaming = false,
  ): TimelineEntry => ({
    kind: "work",
    id,
    createdAt,
    entry: {
      id,
      createdAt,
      runId,
      label: "Thinking",
      detail: text,
      itemType: "reasoning",
      tone: "thinking",
      toolLifecycleStatus: streaming ? "inProgress" : "completed",
    },
  });

  const makeWork = (
    id: string,
    createdAt: string,
    itemType: "command_execution" | "dynamic_tool" | "reasoning" | "system_notice",
    status: "inProgress" | "completed" = "completed",
    options?: {
      sourceActivityKind?: string;
      command?: string;
      detail?: string;
    },
  ): TimelineEntry => ({
    kind: "work",
    id,
    createdAt,
    entry: {
      id,
      createdAt,
      runId,
      label:
        itemType === "reasoning" ? "Thinking" : itemType === "system_notice" ? "Notice" : "Command",
      tone: itemType === "reasoning" ? "thinking" : itemType === "system_notice" ? "info" : "tool",
      itemType,
      toolLifecycleStatus: status,
      ...(options?.command
        ? { command: options.command }
        : itemType === "command_execution"
          ? { command: "ls" }
          : {}),
      ...(options?.detail ? { detail: options.detail } : {}),
      ...(options?.sourceActivityKind ? { sourceActivityKind: options.sourceActivityKind } : {}),
    },
  });

  it("completion-without-successor keeps latest completed result expanded at paused completion", () => {
    const userMsg = makeMsg("user-1", "user", "Run tests", startedAt);
    const toolEntry = makeWork(
      "tool-1",
      "2026-10-15T10:00:05.000Z",
      "command_execution",
      "completed",
      {
        command: "pnpm test",
      },
    );

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, toolEntry],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:10.000Z" },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const workRow = rows.find((r) => r.kind === "work");
    expect(workRow).toBeDefined();
    if (workRow && workRow.kind === "work") {
      const entry = workRow.groupedEntries[0];
      expect(entry?.autoExpanded).toBe(true);
    }
  });

  it("actual successor folds predecessor into compact overview and opens new activity", () => {
    const userMsg = makeMsg("user-1", "user", "Search and edit", startedAt);
    const tool1 = makeWork("tool-1", "2026-10-15T10:00:05.000Z", "command_execution", "completed");
    const asstMsg = makeMsg(
      "asst-1",
      "assistant",
      "I am editing the file now.",
      "2026-10-15T10:00:08.000Z",
    );

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, tool1, asstMsg],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:10.000Z" },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const workRow = rows.find((r) => r.kind === "work");
    expect(workRow).toBeDefined();
    if (workRow && workRow.kind === "work") {
      const entry = workRow.groupedEntries[0];
      expect(entry?.autoExpanded).toBe(false);
    }
  });

  it("keeps explicitly reopened child activity visible across successor groups unless its parent is closed", () => {
    const first = makeWork("pinned-first", "2026-10-15T10:00:02.000Z", "dynamic_tool");
    const second = makeWork("pinned-second", "2026-10-15T10:00:03.000Z", "dynamic_tool");
    const narrative = makeMsg(
      "next-message",
      "assistant",
      "Next operation.",
      "2026-10-15T10:00:04.000Z",
    );
    const successor = makeWork("next-tool", "2026-10-15T10:00:05.000Z", "dynamic_tool");
    const input = {
      timelineEntries: [first, second, narrative, successor],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      expandedRunIds: new Set([runId]),
      explicitActivityCache: new Set(["tool:pinned-first"]),
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const openRows = deriveMessagesTimelineRows(input);
    expect(
      openRows.find(
        (row) => row.kind === "work-toggle" && row.groupId === "work-group:pinned-first",
      ),
    ).toMatchObject({ expanded: true });
    expect(openRows.find((row) => row.id === "work-group:pinned-first:details")).toMatchObject({
      groupedEntries: expect.arrayContaining([expect.objectContaining({ id: "pinned-first" })]),
    });

    const closedRows = deriveMessagesTimelineRows({
      ...input,
      expandedWorkGroupIds: new Set(["work-group-collapsed:work-group:pinned-first"]),
    });
    expect(
      closedRows.find(
        (row) => row.kind === "work-toggle" && row.groupId === "work-group:pinned-first",
      ),
    ).toMatchObject({ expanded: false });
    expect(closedRows.some((row) => row.id === "work-group:pinned-first:details")).toBe(false);
  });

  it("holds a group open between its steps until the workflow moves on when no step opens itself", () => {
    const first = makeWork("held-first", "2026-10-15T10:00:02.000Z", "dynamic_tool", "completed");
    const second = makeWork("held-second", "2026-10-15T10:00:03.000Z", "dynamic_tool", "completed");
    const input = {
      timelineEntries: [first, second],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      expandedRunIds: new Set([runId]),
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      autoOpen: "none",
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const groupHeader = (rows: ReadonlyArray<MessagesTimelineRow>) =>
      rows.find((row) => "groupId" in row && row.groupId === "work-group:held-first");
    const betweenSteps = deriveMessagesTimelineRows(input);
    expect(groupHeader(betweenSteps)).toMatchObject({ expanded: true });
    // Open as a group, but no step opens its own body.
    expect(betweenSteps.find((row) => row.id === "work-group:held-first:details")).toMatchObject({
      groupedEntries: [
        expect.objectContaining({ id: "held-first", autoExpanded: false }),
        expect.objectContaining({ id: "held-second", autoExpanded: false }),
      ],
    });

    const movedOn = deriveMessagesTimelineRows({
      ...input,
      timelineEntries: [
        first,
        second,
        makeMsg("held-reply", "assistant", "Done reading.", "2026-10-15T10:00:04.000Z"),
      ],
    });
    expect(groupHeader(movedOn)).toMatchObject({ expanded: false });
  });

  it("opens running commands, edits and code cells in KM, keeps reads shut, and folds them after the settle delay", () => {
    const makeTool = (
      id: string,
      createdAt: string,
      toolName: string,
      toolData: Record<string, unknown>,
      status: "inProgress" | "completed",
    ): TimelineEntry => ({
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        runId,
        label: toolName,
        toolTitle: toolName,
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: status,
        toolData,
      },
    });
    const steps = (status: "inProgress" | "completed") => [
      makeTool("km-read", "2026-10-15T10:00:02.000Z", "read", { path: "src/a.ts" }, status),
      makeTool(
        "km-edit",
        "2026-10-15T10:00:03.000Z",
        "edit",
        { path: "src/a.ts", old_string: "a", new_string: "b" },
        status,
      ),
      makeWork("km-command", "2026-10-15T10:00:04.000Z", "command_execution", status, {
        command: "pnpm test",
      }),
      makeTool(
        "km-eval-read",
        "2026-10-15T10:00:05.000Z",
        "eval",
        { cells: [{ language: "py", code: 'src = read("src/a.ts")\nprint(src)' }] },
        status,
      ),
      makeTool(
        "km-eval",
        "2026-10-15T10:00:06.000Z",
        "eval",
        {
          cells: [
            { language: "py", code: 'src = read("src/a.ts")\nprint(len(src.splitlines()))\nx = 2' },
          ],
        },
        status,
      ),
    ];
    const input = {
      timelineEntries: steps("inProgress"),
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      expandedRunIds: new Set([runId]),
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      autoOpen: "live-excerpts",
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const opened = (rows: ReadonlyArray<MessagesTimelineRow>) =>
      rows
        .flatMap((row) => (row.kind === "work" ? row.groupedEntries : []))
        .filter((entry) => entry.autoExpanded)
        .map((entry) => entry.id);

    expect(opened(deriveMessagesTimelineRows(input))).toEqual(["km-edit", "km-command", "km-eval"]);
    const settled = { ...input, timelineEntries: steps("completed") };
    expect(opened(deriveMessagesTimelineRows(settled))).toEqual([]);
    expect(
      opened(
        deriveMessagesTimelineRows({
          ...settled,
          settlingExcerptIds: new Set(["km-command", "km-eval-read"]),
        }),
      ),
    ).toEqual(["km-command"]);
  });

  it("keeps the current turn's latest excerpts open in Minimal+ and never reopens earlier turns", () => {
    const tool = (id: string, createdAt: string, toolName: "edit" | "read"): TimelineEntry => ({
      kind: "work",
      id,
      createdAt,
      entry: {
        id,
        createdAt,
        runId,
        label: toolName,
        toolTitle: toolName,
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        toolData:
          toolName === "edit"
            ? { path: "src/a.ts", old_string: "a", new_string: "b" }
            : { path: "src/a.ts" },
      },
    });
    const input = {
      timelineEntries: [
        makeMsg("earlier-prompt", "user", "first", "2026-10-15T10:00:00.000Z"),
        tool("earlier-edit", "2026-10-15T10:00:01.000Z", "edit"),
        makeMsg("current-prompt", "user", "second", "2026-10-15T10:00:02.000Z"),
        tool("first-edit", "2026-10-15T10:00:03.000Z", "edit"),
        tool("read", "2026-10-15T10:00:04.000Z", "read"),
        makeWork("command", "2026-10-15T10:00:05.000Z", "command_execution", "completed", {
          command: "pnpm test",
        }),
        tool("last-edit", "2026-10-15T10:00:06.000Z", "edit"),
      ],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      expandedRunIds: new Set([runId]),
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      autoOpen: "live-excerpts",
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const opened = (excerptsKeptOpen: number) =>
      deriveMessagesTimelineRows({ ...input, excerptsKeptOpen })
        .flatMap((row) => (row.kind === "work" ? row.groupedEntries : []))
        .filter((entry) => entry.autoExpanded)
        .map((entry) => entry.id);

    expect(opened(0)).toEqual([]);
    expect(opened(2)).toEqual(["command", "last-edit"]);
    expect(opened(8)).toEqual(["first-edit", "command", "last-edit"]);
  });

  it("opens live subagent details in KM and keeps them expanded while their excerpt settles", () => {
    const subagentItem = {
      id: TurnItemId.make("km-subagent"),
      type: "subagent",
      status: "running",
      subagentId: NodeId.make("km-agent"),
    } as unknown as OrchestrationV2TurnItem;
    const entry: TimelineEntry = {
      kind: "event",
      id: "km-subagent-entry",
      createdAt: startedAt,
      projectedItem: {
        position: 1,
        visibility: "local",
        sourceThreadId: ThreadId.make("parent-thread"),
        sourceItemId: subagentItem.id,
        item: subagentItem,
      },
    };
    const itemId = String(subagentItem.id);

    expect(
      deriveTimelineActivityDecisions({
        timelineEntries: [entry],
        liveSubagentEntryIds: new Set([entry.id]),
        autoOpen: "live-excerpts",
      }).autoExpandedSubagentItemIds.has(itemId),
    ).toBe(true);
    expect(
      deriveTimelineActivityDecisions({
        timelineEntries: [entry],
        settlingExcerptIds: new Set([itemId]),
        autoOpen: "live-excerpts",
      }).autoExpandedSubagentItemIds.has(itemId),
    ).toBe(true);
    expect(
      deriveTimelineActivityDecisions({
        timelineEntries: [entry],
        liveSubagentEntryIds: new Set([entry.id]),
        autoOpen: "none",
      }).autoExpandedSubagentItemIds.has(itemId),
    ).toBe(false);
  });

  it("folds a completed latest activity when the first narrative text arrives after an empty streaming start", () => {
    const tool = makeWork("before-stream", "2026-10-15T10:00:02.000Z", "command_execution");
    const empty = makeMsg("streamed-answer", "assistant", "", "2026-10-15T10:00:03.000Z", true);
    const input = {
      timelineEntries: [tool, empty],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      expandedRunIds: new Set([runId]),
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const before = deriveMessagesTimelineRowsWithState(input);
    expect(before.rows.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [expect.objectContaining({ id: "before-stream", autoExpanded: true })],
    });
    const text = makeMsg(
      "streamed-answer",
      "assistant",
      "The operation is complete.",
      "2026-10-15T10:00:03.000Z",
      true,
    );
    const after = deriveMessagesTimelineRowsWithState(
      { ...input, timelineEntries: [tool, text] },
      before,
    );
    expect(after.rows.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [expect.objectContaining({ id: "before-stream", autoExpanded: false })],
    });
  });

  it("keeps pinned activity visible when the turn finishes but respects explicit whole-turn collapse", () => {
    const tool = makeWork("pinned-at-finish", "2026-10-15T10:00:02.000Z", "command_execution");
    const answer = makeMsg("finished-answer", "assistant", "Finished.", "2026-10-15T10:00:03.000Z");
    const input = {
      timelineEntries: [tool, answer],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:04.000Z" },
      explicitActivityCache: new Set(["tool:pinned-at-finish"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    expect(
      deriveMessagesTimelineRows(input).some(
        (row) =>
          row.kind === "work" &&
          row.groupedEntries.some((entry) => entry.id === "pinned-at-finish"),
      ),
    ).toBe(true);
    const closed = deriveMessagesTimelineRows({
      ...input,
      explicitActivityCache: new Set(["tool:pinned-at-finish", `turn-collapsed:${runId}`]),
    });
    expect(
      closed.some(
        (row) =>
          row.kind === "work" &&
          row.groupedEntries.some((entry) => entry.id === "pinned-at-finish"),
      ),
    ).toBe(false);
  });

  it("passive updates (system notices, progress snapshots) do not steal focus or count as successors", () => {
    const userMsg = makeMsg("user-1", "user", "Deploy service", startedAt);
    const tool1 = makeWork("tool-1", "2026-10-15T10:00:05.000Z", "command_execution", "completed");
    const sysNotice = makeWork(
      "notice-1",
      "2026-10-15T10:00:08.000Z",
      "system_notice",
      "completed",
    );
    const progressSnapshot = makeWork(
      "prog-1",
      "2026-10-15T10:00:09.000Z",
      "system_notice",
      "completed",
      {
        sourceActivityKind: "task.progress",
      },
    );

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, tool1, sysNotice, progressSnapshot],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:10.000Z" },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const toolRow = rows.find((r) => r.kind === "work" && r.id === "tool-1");
    expect(toolRow).toBeDefined();
    if (toolRow && toolRow.kind === "work") {
      expect(toolRow.groupedEntries[0]?.autoExpanded).toBe(true);
    }
  });

  it("parallel activity: concurrent live tasks retain live state and are not hidden", () => {
    const userMsg = makeMsg("user-1", "user", "Run two tasks", startedAt);
    const task1 = makeWork("task-1", "2026-10-15T10:00:05.000Z", "command_execution", "completed");
    const task2 = makeWork("task-2", "2026-10-15T10:00:06.000Z", "command_execution", "inProgress");

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, task1, task2],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const liveWork = rows.find((r) => r.kind === "work-live");
    expect(liveWork).toBeDefined();
    if (liveWork && liveWork.kind === "work-live") {
      expect(liveWork.active).toBe(true);
    }
  });

  it("manual override in cache wins over auto-expanded default", () => {
    const userMsg = makeMsg("user-1", "user", "Run tool", startedAt);
    const tool1 = makeWork("tool-1", "2026-10-15T10:00:05.000Z", "dynamic_tool", "completed");
    const tool2 = makeWork("tool-2", "2026-10-15T10:00:10.000Z", "dynamic_tool", "completed");
    const asstMsg = makeMsg("asst-1", "assistant", "Tool work done.", "2026-10-15T10:00:12.000Z");

    // Default: with assistant message successor, predecessor tools default to folded
    const rowsDefault = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, tool1, tool2, asstMsg],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:15.000Z" },
      expandedRunIds: new Set([runId]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const toggleRow = rowsDefault.find((r) => r.kind === "work-toggle");
    expect(toggleRow).toBeDefined();
    if (toggleRow && toggleRow.kind === "work-toggle") {
      expect(toggleRow.expanded).toBe(false);
    }

    // Manual open override: group is explicitly in expandedWorkGroupIds
    const rowsManuallyExpanded = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, tool1, tool2, asstMsg],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:15.000Z" },
      expandedRunIds: new Set([runId]),
      expandedWorkGroupIds: new Set([toggleRow?.groupId ?? "work-group:tool-1"]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const expandedToggleRow = rowsManuallyExpanded.find((r) => r.kind === "work-toggle");
    expect(expandedToggleRow).toBeDefined();
    if (expandedToggleRow && expandedToggleRow.kind === "work-toggle") {
      expect(expandedToggleRow.expanded).toBe(true);
    }
    const expandedDetails = rowsManuallyExpanded.find((r) => r.id.endsWith(":details"));
    expect(expandedDetails).toBeDefined();

    // Manual close override: without successor, terminal latest auto-expands by default,
    // but explicit work-group-collapsed override collapses it
    const rowsManuallyCollapsed = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, tool1, tool2],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:15.000Z" },
      expandedRunIds: new Set([runId]),
      expandedWorkGroupIds: new Set([
        `work-group-collapsed:${toggleRow?.groupId ?? "work-group:tool-1"}`,
      ]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const collapsedToggleRow = rowsManuallyCollapsed.find((r) => r.kind === "work-toggle");
    expect(collapsedToggleRow).toBeDefined();
    if (collapsedToggleRow && collapsedToggleRow.kind === "work-toggle") {
      expect(collapsedToggleRow.expanded).toBe(false);
    }
  });

  it("settled history on hydration does not auto-open every old turn", () => {
    const user1 = makeMsg("u-1", "user", "First request", "2026-10-14T10:00:00.000Z");
    const tool1 = makeWork("t-1", "2026-10-14T10:00:05.000Z", "command_execution", "completed");
    const assistant1 = makeMsg(
      "asst-1",
      "assistant",
      "Done with first request.",
      "2026-10-14T10:00:10.000Z",
    );
    const user2 = makeMsg("u-2", "user", "Second request", "2026-10-14T10:05:00.000Z");
    const tool2 = makeWork("t-2", "2026-10-14T10:05:05.000Z", "command_execution", "completed");
    const assistant2 = makeMsg(
      "asst-2",
      "assistant",
      "Done with second request.",
      "2026-10-14T10:05:10.000Z",
    );

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [user1, tool1, assistant1, user2, tool2, assistant2],
      latestRun: {
        runId,
        status: "completed",
        startedAt: "2026-10-14T10:05:00.000Z",
        completedAt: "2026-10-14T10:05:15.000Z",
      },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const allWorkEntries = rows.flatMap((r) => (r.kind === "work" ? r.groupedEntries : []));
    for (const entry of allWorkEntries) {
      expect(entry.autoExpanded).toBe(false);
    }
  });

  it("keeps live background child visible and exempt from folds while parent is terminal and followed by foreground narrative", () => {
    const userMsg = makeMsg("user-1", "user", "Spawn background task and summarize", startedAt);
    const parentTool = makeWork(
      "parent-spawn-tool",
      "2026-10-15T10:00:05.000Z",
      "command_execution",
      "completed",
      {
        command: "spawn-background-worker",
      },
    );

    const subagentItem = {
      id: TurnItemId.make("bg-subagent-1"),
      type: "subagent" as const,
      runId,
      threadId: ThreadId.make("thread-child-1"),
      subagentId: NodeId.make("subagent-1"),
      origin: "app_owned" as const,
      driver: "claude" as const,
      providerInstanceId: ProviderInstanceId.make("pi-1"),
      childThreadId: ThreadId.make("thread-child-1"),
      providerTurnId: "turn-child-1",
      nativeItemRef: null,
      nodeId: null,
      ordinal: 1,
      status: "running" as const,
      parentItemId: TurnItemId.make("parent-spawn-tool"),
      prompt: "Background work",
      result: null,
      startedAt: DateTime.makeUnsafe("2026-10-15T10:00:06.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-15T10:00:06.000Z"),
    };
    const bgChildEntry: TimelineEntry = {
      kind: "event",
      id: "event:bg-subagent-1",
      createdAt: "2026-10-15T10:00:06.000Z",
      projectedItem: {
        item: subagentItem,
        sequence: 1,
        updatedAt: "2026-10-15T10:00:06.000Z",
      } as unknown as OrchestrationV2ProjectedTurnItem,
    };

    const asstNarrative = makeMsg(
      "asst-narrative",
      "assistant",
      "I have started the background worker and here is the plan.",
      "2026-10-15T10:00:10.000Z",
    );

    const liveSubagentSources = new Map([
      [
        "thread-child-1",
        [
          {
            id: NodeId.make("subagent-1"),
            status: "running" as const,
            startedAt: "2026-10-15T10:00:06.000Z",
            completedAt: null,
          },
        ],
      ],
    ]);
    // When the run folds (not in expandedRunIds), the live child event is still visible because it's in liveChildEntryIds
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, parentTool, bgChildEntry, asstNarrative],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:12.000Z" },
      liveSubagentSources,
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((r) => r.kind === "working")).toBe(false);
    const childEventRow = rows.find((r) => r.id === "event:bg-subagent-1");
    expect(childEventRow).toBeDefined();

    // When the run is expanded, parentTool is folded into compact overview (autoExpanded: false)
    const rowsExpanded = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, parentTool, bgChildEntry, asstNarrative],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:12.000Z" },
      liveSubagentSources,
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const workRow = rowsExpanded.find((r) => r.id === "parent-spawn-tool");
    expect(workRow).toBeDefined();
    if (workRow && workRow.kind === "work") {
      expect(workRow.groupedEntries[0]?.autoExpanded).toBe(false);
    }
  });

  it("reasoning retention: reasoning activity stays autoExpanded while live and persists when terminal latest without successor, but folds when assistant narrative follows", () => {
    const userMsg = makeMsg("user-1", "user", "Solve this hard problem", startedAt);
    const reasoningLive = makeReasoning(
      "reason-1",
      "2026-10-15T10:00:02.000Z",
      "Thinking through steps...",
      true,
    );

    // Case 1: While reasoning is live, it is autoExpanded
    const rowsLive = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, reasoningLive],
      latestRun: { runId, status: "running", startedAt, completedAt: null },
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    // A lone live thought draws itself on the live row, with no group beneath to repeat it.
    const liveWorkLiveRow = rowsLive.find((r) => r.kind === "work-live");
    expect(liveWorkLiveRow).toBeDefined();
    if (liveWorkLiveRow && liveWorkLiveRow.kind === "work-live") {
      expect(liveWorkLiveRow.expanded).toBe(true);
      expect(liveWorkLiveRow.entry.itemType).toBe("reasoning");
    }
    expect(rowsLive.some((r) => r.kind === "work" && r.isExpandedToolGroup)).toBe(false);
    // Case 2: Reasoning completed and is terminal latest without successor - stays autoExpanded
    const reasoningSettled = makeReasoning(
      "reason-1",
      "2026-10-15T10:00:02.000Z",
      "Step 1 complete, ready to proceed.",
      false,
    );
    const rowsTerminal = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, reasoningSettled],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:05.000Z" },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const terminalReasoningRow = rowsTerminal.find((r) => r.id === "reason-1");
    expect(terminalReasoningRow).toBeDefined();
    if (terminalReasoningRow && terminalReasoningRow.kind === "work") {
      expect(terminalReasoningRow.groupedEntries[0]?.autoExpanded).toBe(true);
    }

    // Case 3: Substantive assistant narrative follows as successor - reasoning folds to compact overview (autoExpanded: false)
    const asstMsg = makeMsg(
      "asst-1",
      "assistant",
      "Here is the complete solution.",
      "2026-10-15T10:00:06.000Z",
    );
    const rowsWithSuccessor = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, reasoningSettled, asstMsg],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:10.000Z" },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const foldedReasoningRow = rowsWithSuccessor.find((r) => r.id === "reason-1");
    expect(foldedReasoningRow).toBeDefined();
    if (foldedReasoningRow && foldedReasoningRow.kind === "work") {
      expect(foldedReasoningRow.groupedEntries[0]?.autoExpanded).toBe(false);
    }
  });

  it("revised plan successor folds preceding completed tool activity into compact overview", () => {
    const userMsg = makeMsg("user-1", "user", "Research options and update plan", startedAt);
    const toolEntry = makeWork(
      "tool-1",
      "2026-10-15T10:00:05.000Z",
      "command_execution",
      "completed",
      {
        command: "curl https://api.example.com",
      },
    );
    const planEntry: TimelineEntry = {
      kind: "proposed-plan",
      id: "plan-turn-item-1",
      createdAt: "2026-10-15T10:00:08.000Z",
      proposedPlan: {
        id: PlanId.make("plan-1"),
        runId,
        planMarkdown: "### Revised Architecture Plan\n1. Use Postgres\n2. Add cache",
        status: "active",
        createdAt: "2026-10-15T10:00:08.000Z",
        updatedAt: "2026-10-15T10:00:08.000Z",
      },
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, toolEntry, planEntry],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:10.000Z" },
      expandedRunIds: new Set([runId]),
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const workRow = rows.find((r) => r.id === "tool-1");
    expect(workRow).toBeDefined();
    if (workRow && workRow.kind === "work") {
      expect(workRow.groupedEntries[0]?.autoExpanded).toBe(false);
    }
    const planRow = rows.find((r) => r.kind === "proposed-plan");
    expect(planRow).toBeDefined();
  });

  it("stale captured-running child + canonical-completed record stops fold exemptions, while genuine live background remains independent", () => {
    const userMsg = makeMsg("user-1", "user", "Run background agents", startedAt);
    const parentTool = makeWork(
      "parent-tool",
      "2026-10-15T10:00:05.000Z",
      "command_execution",
      "completed",
    );

    // Stale subagent turn item: item.status is historically "running", but canonical source says "completed"
    const staleSubagentItem = {
      id: TurnItemId.make("stale-subagent-item"),
      type: "subagent" as const,
      runId,
      threadId: ThreadId.make("thread-child-stale"),
      subagentId: NodeId.make("subagent-stale"),
      origin: "app_owned" as const,
      driver: "claude" as const,
      providerInstanceId: ProviderInstanceId.make("pi-1"),
      childThreadId: ThreadId.make("thread-child-stale"),
      providerTurnId: "turn-child-stale",
      nativeItemRef: null,
      nodeId: null,
      ordinal: 1,
      status: "running" as const,
      parentItemId: TurnItemId.make("parent-tool"),
      prompt: "Stale background work",
      result: null,
      startedAt: DateTime.makeUnsafe("2026-10-15T10:00:06.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-15T10:00:06.000Z"),
    };
    const staleEntry: TimelineEntry = {
      kind: "event",
      id: "event:stale-subagent",
      createdAt: "2026-10-15T10:00:06.000Z",
      projectedItem: {
        item: staleSubagentItem,
        sequence: 1,
        updatedAt: "2026-10-15T10:00:06.000Z",
      } as unknown as OrchestrationV2ProjectedTurnItem,
    };

    // Genuine live subagent turn item: canonical source says "running"
    const liveSubagentItem = {
      id: TurnItemId.make("live-subagent-item"),
      type: "subagent" as const,
      runId,
      threadId: ThreadId.make("thread-child-live"),
      subagentId: NodeId.make("subagent-live"),
      origin: "app_owned" as const,
      driver: "claude" as const,
      providerInstanceId: ProviderInstanceId.make("pi-1"),
      childThreadId: ThreadId.make("thread-child-live"),
      providerTurnId: "turn-child-live",
      nativeItemRef: null,
      nodeId: null,
      ordinal: 2,
      status: "running" as const,
      parentItemId: TurnItemId.make("parent-tool"),
      prompt: "Genuine live background work",
      result: null,
      startedAt: DateTime.makeUnsafe("2026-10-15T10:00:07.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-15T10:00:07.000Z"),
    };
    const liveEntry: TimelineEntry = {
      kind: "event",
      id: "event:live-subagent",
      createdAt: "2026-10-15T10:00:07.000Z",
      projectedItem: {
        item: liveSubagentItem,
        sequence: 2,
        updatedAt: "2026-10-15T10:00:07.000Z",
      } as unknown as OrchestrationV2ProjectedTurnItem,
    };

    const asstMsg = makeMsg("asst-1", "assistant", "Done spawning.", "2026-10-15T10:00:10.000Z");

    const liveSubagentSources = new Map([
      [
        "thread-child-stale",
        [
          {
            id: NodeId.make("subagent-stale"),
            status: "completed" as const,
            startedAt: "2026-10-15T10:00:06.000Z",
            completedAt: "2026-10-15T10:00:08.000Z",
          },
        ],
      ],
      [
        "thread-child-live",
        [
          {
            id: NodeId.make("subagent-live"),
            status: "running" as const,
            startedAt: "2026-10-15T10:00:07.000Z",
            completedAt: null,
          },
        ],
      ],
    ]);

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [userMsg, parentTool, staleEntry, liveEntry, asstMsg],
      latestRun: { runId, status: "completed", startedAt, completedAt: "2026-10-15T10:00:12.000Z" },
      liveSubagentSources,
      runningRunId: null,
      isWorking: false,
      activeTurnStartedAt: startedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    // The settled run folds. The stale subagent is not exempt and folds away with the run.
    expect(rows.find((r) => r.id === "event:stale-subagent")).toBeUndefined();
    // The genuine live background subagent remains exempt and visible!
    expect(rows.find((r) => r.id === "event:live-subagent")).toBeDefined();
  });

  it("wait snapshot running + matching completion notice must not remain live", () => {
    const userMsg = makeMsg("user-1", "user", "Run wait job", startedAt);
    const waitToolItem = {
      id: TurnItemId.make("wait-turn-item"),
      type: "dynamic_tool" as const,
      toolName: "wait",
      title: "wait",
      status: "running" as const,
      input: { op: "wait" },
      details: {
        op: "wait",
        jobs: [
          {
            id: "job-1",
            status: "running",
            type: "build",
            label: "Building assets",
          },
        ],
      },
      runId,
      threadId: ThreadId.make("thread-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      startedAt: DateTime.makeUnsafe("2026-10-15T10:00:05.000Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-15T10:00:05.000Z"),
    } satisfies OrchestrationV2TurnItem;
    const waitWorkEntry: TimelineEntry = {
      kind: "work",
      id: "wait-work-entry",
      createdAt: "2026-10-15T10:00:05.000Z",
      entry: {
        id: "wait-work-entry",
        createdAt: "2026-10-15T10:00:05.000Z",
        runId,
        label: "Wait",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "inProgress",
        projectedItem: {
          position: waitToolItem.ordinal,
          visibility: "local",
          sourceThreadId: waitToolItem.threadId,
          sourceItemId: waitToolItem.id,
          item: waitToolItem,
        },
      },
    };

    // System notice reporting job-1 completion
    const noticeItem = {
      id: TurnItemId.make("notice-turn-item"),
      type: "system_notice" as const,
      status: "completed" as const,
      title: "Job finished",
      message: "Job finished",
      jobCompletion: {
        jobId: "job-1",
        status: "completed",
        type: "build",
      },
      runId,
      threadId: ThreadId.make("thread-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      startedAt: DateTime.makeUnsafe("2026-10-15T10:00:07.000Z"),
      completedAt: DateTime.makeUnsafe("2026-10-15T10:00:07.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-15T10:00:07.000Z"),
    } satisfies OrchestrationV2TurnItem;
    const noticeEntry: TimelineEntry = {
      kind: "work",
      id: "notice-work-entry",
      createdAt: "2026-10-15T10:00:07.000Z",
      entry: {
        id: "notice-work-entry",
        createdAt: "2026-10-15T10:00:07.000Z",
        runId,
        label: "Job finished",
        tone: "info",
        itemType: "system_notice",
        toolLifecycleStatus: "completed",
        projectedItem: {
          position: noticeItem.ordinal,
          visibility: "local",
          sourceThreadId: noticeItem.threadId,
          sourceItemId: noticeItem.id,
          item: noticeItem,
        },
      },
    };

    const decisions = deriveTimelineActivityDecisions({
      timelineEntries: [userMsg, waitWorkEntry, noticeEntry],
      lifecycleItems: [waitToolItem, noticeItem],
    });

    // The wait job was reconciled with the completion notice; it must not remain live!
    expect(decisions.liveChildEntryIds.has("wait-work-entry")).toBe(false);
  });
  it("keeps terminal work flat: no folds and one row per read", () => {
    const makeRead = (id: string, createdAt: string, filePath: string): TimelineEntry => {
      const work = makeWork(id, createdAt, "dynamic_tool");
      if (work.kind !== "work") {
        throw new Error("Expected work entry");
      }
      return {
        ...work,
        entry: {
          ...work.entry,
          label: "Read",
          toolTitle: "Read",
          structuredPayload: {
            type: "dynamic_tool",
            toolName: "Read",
            input: { file_path: filePath },
          } as NonNullable<WorkLogEntry["structuredPayload"]>,
        },
      };
    };
    const timelineEntries = [
      makeMsg("user-1", "user", "Inspect these files", startedAt),
      makeRead("read-1", "2026-10-15T10:00:01.000Z", "src/a.ts"),
      makeRead("read-2", "2026-10-15T10:00:02.000Z", "src/b.ts"),
    ];
    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      layout: "flat",
    });
    const workRows = rows.filter((row) => row.kind === "work");

    expect(rows.some((row) => row.kind === "turn-fold" || row.kind === "work-toggle")).toBe(false);
    expect(workRows.map((row) => row.id)).toEqual(["read-1", "read-2"]);
  });
});
describe("summary-backed activity folds", () => {
  const threadId = ThreadId.make("summary-thread");
  const activityGroup = (
    groupStartItemId: string,
    firstItemId: string,
    firstOrdinal: number,
    lastItemId: string,
    lastOrdinal: number,
    runId: RunId | null = null,
  ): TimelineActivityGroup => {
    const groupStart = TurnItemId.make(groupStartItemId);
    const firstItem = TurnItemId.make(firstItemId);
    const lastItem = TurnItemId.make(lastItemId);
    const key = JSON.stringify([threadId, groupStart]);
    const initialRequest = {
      sourceThreadId: threadId,
      groupStartItemId: groupStart,
      anchorItemId: lastItem,
    };
    return {
      key,
      summary: {
        sourceThreadId: threadId,
        groupStartItemId: groupStart,
        turnStartItemId: groupStart,
        runId,
        firstItemId: firstItem,
        firstOrdinal,
        lastItemId: lastItem,
        lastOrdinal,
        activityCount: lastOrdinal - firstOrdinal + 1,
        countsByType: [{ type: "command_execution", count: 2 }],
        statusCounts: [{ status: "completed", count: 2 }],
        runStatus: "completed",
        stepCount: 4,
        filesEditedCount: 2,
        diffStats: { added: 17, removed: 5 },
        hasFailure: true,
        labelPreview: "Inspecting the workspace",
        intentPreview: "Check the failing activity",
        startedAt: DateTime.makeUnsafe("2026-10-20T10:00:00.000Z"),
        endedAt: DateTime.makeUnsafe("2026-10-20T10:00:24.000Z"),
      },
      loadedCount: 0,
      loadedFirstOrdinal: null,
      loadedFirstItemId: null,
      loadedLastOrdinal: null,
      loadedLastItemId: null,
      initialRequest,
      previousRequest: initialRequest,
      nextRequest: null,
      loading: false,
      error: null,
    };
  };
  const entry = (
    entryId: string,
    itemId: string,
    ordinal: number,
    role: "user" | "assistant",
    runId: RunId | null = null,
  ): TimelineEntry => {
    const createdAt = `2026-10-20T10:00:${String(ordinal).padStart(2, "0")}.000Z`;
    const sourceItemId = TurnItemId.make(itemId);
    return {
      id: entryId,
      kind: "message",
      createdAt,
      message: {
        id: MessageId.make(entryId),
        role,
        text: entryId,
        runId,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      } as ChatMessage,
      projectedItem: {
        position: ordinal,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId,
        item: { ordinal } as OrchestrationV2TurnItem,
        orderKey: { sourceThreadId: threadId, ordinal, itemId: sourceItemId },
      },
    };
  };
  const deriveRows = (
    timelineEntries: ReadonlyArray<TimelineEntry>,
    activityGroups: ReadonlyArray<TimelineActivityGroup>,
    expandedActivityGroupKeys?: ReadonlySet<string>,
  ) =>
    deriveMessagesTimelineRows({
      timelineEntries,
      activityGroups,
      ...(expandedActivityGroupKeys === undefined ? {} : { expandedActivityGroupKeys }),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

  it("renders complete summary metadata when the activity page has no raw rows", () => {
    const group = activityGroup("start", "user-item", 1, "answer-item", 2);
    const rows = deriveRows(
      [entry("prompt", "user-item", 1, "user"), entry("answer", "answer-item", 2, "assistant")],
      [group],
    );
    const fold = rows.find((row) => row.kind === "turn-fold");

    expect(fold).toMatchObject({
      kind: "turn-fold",
      id: `turn-fold:${group.key}`,
      runId: null,
      expanded: false,
      label: "Worked for 24s · 4 steps · edited 2 files +17 −5",
      diffStats: { added: 17, removed: 5 },
      activityGroup: {
        loadedCount: 0,
        summary: {
          hasFailure: true,
          labelPreview: "Inspecting the workspace",
          intentPreview: "Check the failing activity",
          stepCount: 4,
          filesEditedCount: 2,
          diffStats: { added: 17, removed: 5 },
        },
      },
    });
  });

  it("keeps null-run user turns in separate stable summary groups", () => {
    const first = activityGroup("first-start", "first-user-item", 1, "first-answer-item", 2);
    const second = activityGroup("second-start", "second-user-item", 3, "second-answer-item", 4);
    const rows = deriveRows(
      [
        entry("first-prompt", "first-user-item", 1, "user"),
        entry("first-answer", "first-answer-item", 2, "assistant"),
        entry("second-prompt", "second-user-item", 3, "user"),
        entry("second-answer", "second-answer-item", 4, "assistant"),
      ],
      [first, second],
    );
    const folds = rows.filter((row) => row.kind === "turn-fold");

    expect(folds.map((row) => row.id)).toEqual([
      `turn-fold:${first.key}`,
      `turn-fold:${second.key}`,
    ]);
    expect(folds.map((row) => row.runId)).toEqual([null, null]);
  });

  it("emits previous and next page boundary rows for an expanded group", () => {
    const base = activityGroup("start", "first-item", 1, "last-item", 3, RunId.make("run"));
    const group: TimelineActivityGroup = {
      ...base,
      loadedCount: 1,
      loadedFirstOrdinal: 2,
      loadedFirstItemId: "middle-item",
      loadedLastOrdinal: 2,
      loadedLastItemId: "middle-item",
      previousRequest: {
        sourceThreadId: threadId,
        groupStartItemId: base.summary.groupStartItemId,
        cursor: "previous-cursor",
        direction: "previous",
      },
      nextRequest: {
        sourceThreadId: threadId,
        groupStartItemId: base.summary.groupStartItemId,
        cursor: "next-cursor",
        direction: "next",
      },
    };
    const rows = deriveRows(
      [
        entry("prompt", "first-item", 1, "user", RunId.make("run")),
        entry("loaded-step", "middle-item", 2, "assistant", RunId.make("run")),
        entry("answer", "last-item", 3, "assistant", RunId.make("run")),
      ],
      [group],
      new Set([group.key]),
    );
    const boundaries = rows.filter((row) => row.kind === "activity-page-boundary");

    expect(boundaries).toMatchObject([
      {
        direction: "previous",
        request: { cursor: "previous-cursor", direction: "previous" },
      },
      {
        direction: "next",
        request: { cursor: "next-cursor", direction: "next" },
      },
    ]);
  });
});

describe("legacy activity timeline mode", () => {
  it("passes the visible projection through unchanged", () => {
    const visibleTurnItems = [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: ThreadId.make("legacy-thread"),
        sourceItemId: TurnItemId.make("legacy-item"),
        item: { ordinal: 0 } as OrchestrationV2TurnItem,
      },
    ];

    expect(mergeActivityRowsIntoVisibleItems(visibleTurnItems, EMPTY_THREAD_ACTIVITY_STATE)).toBe(
      visibleTurnItems,
    );
  });
});
