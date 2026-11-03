// scripts/omp-replay/scenario.mjs
// Synthetic native OMP replay scenario demonstrating streamed subagent progress,
// metrics, TODO phases, shell/eval execution, and concurrent wait job lifecycle.

const initialThinking = [
  "Analyzing the synthetic replay scenario requirements.\n",
  "I will inspect five native OMP displays in structured chronological sequence:\n",
  "1. Phased plan initialization via the native todo tool\n",
  "2. Delegated task subagents reporting live progress, metrics, and costs\n",
  "3. Progressive shell execution and native multi-language eval calls\n",
  "4. Concurrent background wait job tracking with live shimmer and terminal reconciliation\n",
  "5. Final synthesized session summary after all background tasks reach terminal states.",
];

const initialText = [
  "Beginning synthetic native OMP session inspection.\n\n",
  "Initializing the phased task plan, spawning delegated child subagents, ",
  "and preparing local execution environments.",
];

const sharedTaskContext = `# Goal
Verify native OMP UI component rendering across task metrics, execution panels, and background wait lifecycles.

# Contract
- Schema Reviewer: Validate event schemas and data structures.
- Timeline Reviewer: Verify chronological projection and state reconciliation.`;

const finalText = [
  "## Native Session Summary\n\n",
  "All synthetic components have concluded their runs across the session:\n\n",
  "- **Task Subagents**: Schema Reviewer finished in 19.2s ($0.0384 cost), while Timeline Reviewer finished in 45.2s ($0.0462 cost). Both reported live metrics, context windows, and tool usage.\n",
  "- **Command & Runtime Displays**: Bash command produced progressive streaming output and exitCode 0 in details. Python and JavaScript evaluations ran via native eval.\n",
  "- **Waiting & Reconciliation**: The native hub wait monitored all 4 jobs, cleared shimmer as soon as all jobs reached terminal states, and retained the final frozen snapshot.",
];

const fullInitialThinking = initialThinking.join("");
const fullInitialText = initialText.join("");
const fullFinalText = finalText.join("");

// Scenario clock base: 10:42 AM local (17:42 UTC) realistic daytime timestamp
const scenarioBaseTimeMs = Date.parse("2026-10-15T17:42:00.000Z");

const reconcilerPatch = `--- a/apps/web/src/components/chat/NativeWaitingPane.logic.ts
+++ b/apps/web/src/components/chat/NativeWaitingPane.logic.ts
@@ -101,9 +101,18 @@
   const candidate = lifecycleUpdate(item);
   if (candidate === null) continue;
   const previous = updates.get(candidate.jobId);
-  if (previous !== undefined && previous.status === "completed") {
-    continue;
-  }
+  if (previous !== undefined) {
+    // Terminal notices take priority over stale running snapshots
+    if (previous.status === "completed" || previous.status === "failed") {
+      if (candidate.status === "running") {
+        continue;
+      }
+    }
+    if (candidate.status === "completed" && previous.status === "running") {
+      updates.set(candidate.jobId, candidate);
+      continue;
+    }
+  }
   updates.set(candidate.jobId, candidate);`;

// Arguments for calls whose arguments stream in before they run; the start
// frame repeats the finished arguments, as Pi does.
const reconcilerEditArgs = {
  path: "apps/web/src/components/chat/NativeWaitingPane.logic.ts",
  edits: [{ diff: reconcilerPatch.split("\n").slice(2).join("\n") }],
};
const priorityWriteArgs = {
  path: "apps/web/src/components/chat/waitingPriority.ts",
  content: `import type { WaitingJobStatus } from "./NativeWaitingPane.logic";

/** Terminal states outrank live ones when two reports disagree. */
const STATUS_RANK: Record<WaitingJobStatus, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

/** Whether a fresh report may replace the one already shown. */
export function supersedes(next: WaitingJobStatus, previous: WaitingJobStatus): boolean {
  return STATUS_RANK[next] >= STATUS_RANK[previous];
}
`,
};
const verifyCommandArgs = { command: "git status --short && echo 'Local workspace verified'" };
const evalPyArgs = {
  language: "py",
  code: "samples = [14.2, 16.8, 15.0]\nmean_latency = sum(samples) / len(samples)\nprint(f'Average tool dispatch: {mean_latency:.2f}ms')\nmean_latency",
};

/** A copy of `value` whose string at `path` is cut to `length` characters. */
function truncatedAt(value, path, length) {
  if (path.length === 0) return value.slice(0, length);
  const [key, ...rest] = path;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  copy[key] = truncatedAt(value[key], rest, length);
  return copy;
}

/**
 * One assistant message that streams a tool call's arguments the way Pi
 * reports them: toolcall_start, then toolcall_delta events whose partial call
 * carries the arguments parsed so far, then toolcall_end. The streamed string
 * grows a few whole lines per event, about eight steps per call.
 */
function streamedToolCallFrames({ id, name, args, streamPath, durationMs }) {
  const full = streamPath.reduce((value, key) => value[key], args);
  const lineEnds = [];
  for (let index = full.indexOf("\n"); index !== -1; index = full.indexOf("\n", index + 1)) {
    lineEnds.push(index + 1);
  }
  if (lineEnds.at(-1) !== full.length) lineEnds.push(full.length);
  const stride = Math.max(1, Math.ceil(lineEnds.length / 8));
  const lengths = lineEnds.filter(
    (_, index) => index % stride === stride - 1 || index === lineEnds.length - 1,
  );
  const call = (length) => ({
    type: "toolCall",
    id,
    name,
    arguments: truncatedAt(args, streamPath, length),
  });
  const stepMs = (durationMs - 300) / (lengths.length + 1);
  return [
    { atMs: 0, frame: { type: "message_start", message: { role: "assistant" } } },
    {
      atMs: 50,
      frame: {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: { content: [call(0)] },
        },
      },
    },
    ...lengths.map((length, index) => ({
      atMs: Math.round(50 + (index + 1) * stepMs),
      frame: {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          partial: { content: [call(length)] },
        },
      },
    })),
    {
      atMs: durationMs - 200,
      frame: {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: call(full.length),
        },
      },
    },
    {
      atMs: durationMs - 100,
      frame: {
        type: "message_end",
        message: { role: "assistant", content: [call(full.length)], stopReason: "tool_use" },
      },
    },
  ];
}

/**
 * Splice segments into the schedule at their anchors. Frames at or after an
 * anchor move back by the segment's duration, so the tour keeps its pacing.
 */
function withSegments(frames, segments) {
  let result = frames;
  for (const segment of [...segments].sort((a, b) => b.atMs - a.atMs)) {
    result = [
      ...result.map((entry) =>
        entry.atMs >= segment.atMs ? { ...entry, atMs: entry.atMs + segment.durationMs } : entry,
      ),
      ...segment.frames.map((entry) => ({ ...entry, atMs: segment.atMs + entry.atMs })),
    ];
  }
  return result.sort((a, b) => a.atMs - b.atMs);
}

// The demo's todo list. Every update reports the whole plan, as OMP's todo
// tool does; statuses run parallel to TODO_TASKS.
const TODO_TASKS = [
  ["Analysis & Delegation", "Inspect native event schemas and protocol contracts"],
  ["Analysis & Delegation", "Coordinate delegated child task subagents"],
  ["Analysis & Delegation", "Verify local shell and runtime evaluations"],
  ["Analysis & Delegation", "Benchmark the waiting pane against OMP's TUI"],
  [
    "Background Jobs & Reconciliation",
    "Wait on concurrent background jobs to reach terminal state",
  ],
  ["Background Jobs & Reconciliation", "Synthesize final native session summary"],
];
const TODO_BLOCKER = "Awaiting task delegates and worker jobs";

function todoPhases(statuses) {
  const phases = [];
  TODO_TASKS.forEach(([name, content], index) => {
    let phase = phases.find((candidate) => candidate.name === name);
    if (phase === undefined) {
      phase = { name, tasks: [] };
      phases.push(phase);
    }
    const status = statuses[index];
    phase.tasks.push(
      status === "blocked" ? { content, status, blocker: TODO_BLOCKER } : { content, status },
    );
  });
  return phases;
}

function todoUpdateFrames({ id, startMs, endMs, args, text, statuses }) {
  return [
    {
      atMs: startMs,
      frame: { type: "tool_execution_start", toolCallId: id, toolName: "todo", args },
    },
    {
      atMs: endMs,
      frame: {
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "todo",
        result: { content: [{ type: "text", text }], details: { phases: todoPhases(statuses) } },
      },
    },
  ];
}

const nativeFrames = [
  // ── 0.0s – 2.2s: Agent initialization and initial streamed thought/text ──
  { atMs: 0, frame: { type: "agent_start" } },
  { atMs: 100, frame: { type: "message_start", message: { role: "assistant" } } },
  {
    atMs: 250,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: initialThinking[0],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 550,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: initialThinking[1] + initialThinking[2] + initialThinking[3],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 850,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: initialThinking[4] + initialThinking[5] + initialThinking[6],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 1_200,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: initialText[0],
        contentIndex: 1,
      },
    },
  },
  {
    atMs: 1_500,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: initialText[1],
        contentIndex: 1,
      },
    },
  },
  {
    atMs: 1_800,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: initialText[2],
        contentIndex: 1,
      },
    },
  },
  // Proper message boundary: close assistant streaming turn before tool calls
  {
    atMs: 2_200,
    frame: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: fullInitialThinking },
          { type: "text", text: fullInitialText },
        ],
        stopReason: "tool_use",
      },
    },
  },

  // ── 2.6s – 3.4s: Initial Phased TODO Plan ──
  ...todoUpdateFrames({
    id: "call-todo-init",
    startMs: 2_600,
    endMs: 3_400,
    args: {
      op: "replace",
      phases: todoPhases(["completed", "in_progress", "pending", "pending", "pending", "pending"]),
    },
    text: "Initialized native TODO plan with 2 phases.",
    statuses: ["completed", "in_progress", "pending", "pending", "pending", "pending"],
  }),

  // ── 3.6s – 4.0s: Native Web Search Demonstration ──
  {
    atMs: 3_600,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-web-search-demo",
      toolName: "web_search",
      args: {
        query: "FIFA World Cup 2026 ticket prices official",
        limit: 5,
      },
    },
  },
  {
    atMs: 4_000,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-web-search-demo",
      toolName: "web_search",
      result: {
        content: [
          {
            type: "text",
            text: "Official ticket prices for FIFA World Cup 2026 range from $60 for group stage matches to $6,730 for category 1 final tickets.",
          },
        ],
        details: {
          response: {
            provider: "openai-codex",
            model: "gpt-6-luna",
            answer:
              "Official ticket prices for the FIFA World Cup 2026 vary by match tier and seating category. Group stage matches begin at $60, while premium knockout matches and the final reach up to $6,730.",
            sources: [
              {
                title: "Tickets - FIFA World Cup 2026™",
                url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/tickets",
                snippet:
                  "Official information regarding ticketing phases, hospitality packages, and pricing for the 2026 FIFA World Cup in North America.",
                publishedDate: "2026-05-01",
              },
              {
                title: "FIFA chief defends World Cup ticket prices",
                url: "https://www.aljazeera.com/sports/2026/5/6/fifa-chief-infantino-defends-world-cup-ticket-prices",
                snippet:
                  "FIFA leadership addresses ticketing structure, tiered pricing models, and accessibility initiatives for fans worldwide.",
                ageSeconds: 86400,
              },
            ],
            citations: [
              {
                url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/tickets",
                title: "Tickets - FIFA World Cup 2026™",
                citedText: "Group stage tickets start at $60.",
              },
            ],
            searchQueries: ["FIFA World Cup 2026 ticket prices official"],
            usage: {
              inputTokens: 1420,
              outputTokens: 185,
              searchRequests: 1,
              totalTokens: 1605,
            },
          },
        },
      },
    },
  },

  // ── 4.3s – 4.9s: Narrative before exploration ──
  { atMs: 4_300, frame: { type: "message_start", message: { role: "assistant" } } },
  {
    atMs: 4_600,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Mapping the waiting-pane code before changing it.",
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 4_900,
    frame: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Mapping the waiting-pane code before changing it." }],
        stopReason: "tool_use",
      },
    },
  },

  // ── 5.2s – 10.9s: Exploration burst (4 reads, 2 greps) ──
  {
    atMs: 5_200,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-read-waiting-pane",
      toolName: "read",
      args: {
        path: "apps/web/src/components/chat/NativeWaitingPane.tsx",
        i: "Reading waiting pane UI structure",
      },
    },
  },
  {
    atMs: 5_800,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-read-waiting-pane",
      toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: 'export function NativeWaitingPane({ jobs, isTerminal }: NativeWaitingPaneProps) {\n  const reconciled = useReconciledJobs(jobs);\n  return <div className="waiting-pane">{reconciled.map(renderJob)}</div>;\n}',
          },
        ],
      },
    },
  },
  {
    atMs: 6_100,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-read-waiting-logic",
      toolName: "read",
      args: {
        path: "apps/web/src/components/chat/NativeWaitingPane.logic.ts",
        i: "Reading waiting lifecycle reconciler",
      },
    },
  },
  {
    atMs: 6_700,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-read-waiting-logic",
      toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: "export function reconcileWaitingJobs(snapshot: Job[], notices: Notice[]): Job[] {\n  const map = new Map(snapshot.map((j) => [j.id, j]));\n  for (const n of notices) map.set(n.jobId, { ...map.get(n.jobId), ...n });\n  return [...map.values()];\n}",
          },
        ],
      },
    },
  },
  {
    atMs: 7_000,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-read-notice",
      toolName: "read",
      args: {
        path: "apps/web/src/components/chat/NativeNotice.tsx",
        i: "Reading native notice component",
      },
    },
  },
  {
    atMs: 7_700,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-read-notice",
      toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: 'export function NativeNotice({ item, timestampFormat }: NativeNoticeProps) {\n  const visibleTime = formatShortTimestamp(item.updatedAt, timestampFormat);\n  return <span className="notice-time">{visibleTime}</span>;\n}',
          },
        ],
      },
    },
  },
  {
    atMs: 8_000,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-read-timeline",
      toolName: "read",
      args: {
        path: "apps/web/src/components/chat/MessagesTimeline.tsx",
        i: "Reading timeline entry dispatch",
      },
    },
  },
  {
    atMs: 8_800,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-read-timeline",
      toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: 'export function shouldFoldEntry(entry: TimelineEntry): boolean {\n  if (entry.itemType === "system_notice") return true;\n  return entry.status === "completed";\n}',
          },
        ],
      },
    },
  },
  {
    atMs: 9_100,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-grep-matches",
      toolName: "grep",
      args: {
        pattern: "reconcileWaitingJobs",
        path: "apps/web/src/components/chat",
        i: "Searching waiting reconciler call sites",
      },
    },
  },
  {
    atMs: 9_900,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-grep-matches",
      toolName: "grep",
      result: {
        content: [
          {
            type: "text",
            // OMP's grouped grep listing: directory, file#TAG, `*` marks a hit.
            text: [
              "# apps/web/src/components/chat/",
              "## NativeWaitingPane.tsx#4C1A",
              " 45:  const jobs = useMemo(",
              "*46:    () => reconcileWaitingJobs(snapshotJobs, lifecycleUpdates),",
              " 47:    [snapshotJobs, lifecycleUpdates],",
              "## NativeWaitingPane.logic.ts#9E02",
              "*12:export function reconcileWaitingJobs(",
              " 13:  snapshot: ReadonlyArray<WaitingJob>,",
            ].join("\n"),
          },
        ],
        details: { matchCount: 2, fileCount: 2, scopePath: "apps/web/src/components/chat" },
      },
    },
  },
  {
    atMs: 10_200,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-grep-no-matches",
      toolName: "grep",
      args: {
        pattern: "staleSnapshotOverride",
        path: "apps/web/src/components/chat",
        i: "Searching legacy snapshot overrides",
      },
    },
  },
  {
    atMs: 10_900,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-grep-no-matches",
      toolName: "grep",
      result: {
        content: [
          {
            type: "text",
            text: "No matches found",
          },
        ],
        details: { matchCount: 0, fileCount: 0, scopePath: "apps/web/src/components/chat" },
      },
    },
  },

  // ── 11.2s – 11.9s: Narrative before single edit ──
  { atMs: 11_200, frame: { type: "message_start", message: { role: "assistant" } } },
  {
    atMs: 11_500,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta:
          "Completion notices must win over the stale running snapshot. Patching the reconciler.",
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 11_900,
    frame: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Completion notices must win over the stale running snapshot. Patching the reconciler.",
          },
        ],
        stopReason: "tool_use",
      },
    },
  },

  // ── 12.2s – 13.7s: Single-file edit with real unified diff (+12, -3) ──
  {
    atMs: 12_200,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-edit-reconciler",
      toolName: "edit",
      args: reconcilerEditArgs,
    },
  },
  {
    atMs: 13_700,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-edit-reconciler",
      toolName: "edit",
      result: {
        content: [
          {
            type: "text",
            text: "Successfully patched apps/web/src/components/chat/NativeWaitingPane.logic.ts (+12 −3)",
          },
        ],
        details: { patch: reconcilerPatch },
      },
    },
  },

  // ── 14.0s – 14.7s: Narrative before multi-file edits ──
  { atMs: 14_000, frame: { type: "message_start", message: { role: "assistant" } } },
  {
    atMs: 14_300,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Propagating reconciliation status across waiting pane components.",
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 14_700,
    frame: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Propagating reconciliation status across waiting pane components.",
          },
        ],
        stopReason: "tool_use",
      },
    },
  },

  // ── 15.0s – 19.6s: Multi-file edit burst (3 files with real diffs) ──
  {
    atMs: 15_000,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-edit-waiting-pane",
      toolName: "edit",
      args: {
        path: "apps/web/src/components/chat/NativeWaitingPane.tsx",
        i: "Sorting reconciled waiting jobs",
      },
    },
  },
  {
    atMs: 16_400,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-edit-waiting-pane",
      toolName: "edit",
      result: {
        content: [
          {
            type: "text",
            text: "Successfully patched apps/web/src/components/chat/NativeWaitingPane.tsx (+5 −2)",
          },
        ],
        details: {
          patch: `--- a/apps/web/src/components/chat/NativeWaitingPane.tsx
+++ b/apps/web/src/components/chat/NativeWaitingPane.tsx
@@ -45,8 +45,11 @@
   const activeJobs = useMemo(
-    () => reconcileWaitingJobs(snapshotJobs, lifecycleUpdates),
-    [snapshotJobs, lifecycleUpdates],
+    () => {
+      const reconciled = reconcileWaitingJobs(snapshotJobs, lifecycleUpdates);
+      return sortJobsByTerminalPriority(reconciled);
+    },
+    [snapshotJobs, lifecycleUpdates],
   );`,
        },
      },
    },
  },
  {
    atMs: 16_700,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-edit-notice",
      toolName: "edit",
      args: {
        path: "apps/web/src/components/chat/NativeNotice.tsx",
        i: "Formatting notice timestamps and terminal status",
      },
    },
  },
  {
    atMs: 18_000,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-edit-notice",
      toolName: "edit",
      result: {
        content: [
          {
            type: "text",
            text: "Successfully patched apps/web/src/components/chat/NativeNotice.tsx (+6 −1)",
          },
        ],
        details: {
          patch: `--- a/apps/web/src/components/chat/NativeNotice.tsx
+++ b/apps/web/src/components/chat/NativeNotice.tsx
@@ -92,7 +92,12 @@
   const timestamp = DateTime.formatIso(item.updatedAt);
-  const visibleTimestamp = formatShortTimestamp(timestamp, timestampFormat);
+  const visibleTimestamp = item.updatedAt
+    ? formatShortTimestamp(timestamp, timestampFormat)
+    : "";
+  const isTerminalNotice =
+    isBackgroundCompletion &&
+    (jobCompletion?.status === "completed" || jobCompletion?.status === "failed");`,
        },
      },
    },
  },
  {
    atMs: 18_300,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-edit-timeline",
      toolName: "edit",
      args: {
        path: "apps/web/src/components/chat/MessagesTimeline.tsx",
        i: "Adjusting timeline fold rules for terminal notices",
      },
    },
  },
  {
    atMs: 19_600,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-edit-timeline",
      toolName: "edit",
      result: {
        content: [
          {
            type: "text",
            text: "Successfully patched apps/web/src/components/chat/MessagesTimeline.tsx (+4 −1)",
          },
        ],
        details: {
          patch: `--- a/apps/web/src/components/chat/MessagesTimeline.tsx
+++ b/apps/web/src/components/chat/MessagesTimeline.tsx
@@ -881,7 +881,10 @@
       (liveChildEntryIds && liveChildEntryIds.has(entry.id)) ||
-      (entry.kind === "work" && entry.entry.itemType === "system_notice")
+      (entry.kind === "work" &&
+        entry.entry.itemType === "system_notice" &&
+        !entry.entry.isTerminalNotice)
     ) {
       continue;
     }`,
        },
      },
    },
  },

  // ── 20.0s – 24.8s: Failing bash test run ──
  {
    atMs: 20_000,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-bash-test-fail",
      toolName: "bash",
      args: { command: "pnpm vp test run NativeWaitingPane" },
    },
  },
  {
    atMs: 22_400,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-bash-test-fail",
      toolName: "bash",
      partialResult: {
        content: [
          {
            type: "text",
            text: "> @t3tools/web test\n> vitest run NativeWaitingPane\n\n",
          },
        ],
      },
    },
  },
  {
    atMs: 24_800,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-bash-test-fail",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: "> @t3tools/web test\n> vitest run NativeWaitingPane\n\nFAIL  apps/web/src/components/chat/NativeWaitingPane.logic.test.ts\n  ✕ reconciles waiting jobs with terminal completion notice (42ms)\n    AssertionError: expected 'running' to be 'completed'",
          },
        ],
        details: { exitCode: 1 },
      },
    },
  },

  // ── 25.3s – 30.5s: Passing bash test re-run ──
  {
    atMs: 25_300,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-bash-test-pass",
      toolName: "bash",
      args: { command: "pnpm vp test run NativeWaitingPane" },
    },
  },
  {
    atMs: 27_800,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-bash-test-pass",
      toolName: "bash",
      partialResult: {
        content: [
          {
            type: "text",
            text: "> @t3tools/web test\n> vitest run NativeWaitingPane\n\n",
          },
        ],
      },
    },
  },
  {
    atMs: 30_500,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-bash-test-pass",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: `> @t3tools/web test
> vitest run NativeWaitingPane

 ✓ apps/web/src/components/chat/NativeWaitingPane.logic.test.ts (6 tests)
   ✓ parses active background jobs from waiting snapshot
   ✓ reconciles waiting jobs with terminal completion notice
   ✓ prefers terminal notice status over stale snapshot
   ✓ tracks elapsed duration for running jobs
   ✓ clears waiting shimmer when all jobs reach terminal state
   ✓ preserves final terminal snapshot after wait ends
 ✓ apps/web/src/components/chat/NativeNotice.test.tsx (2 tests)
   ✓ renders irc message notice with timestamp
   ✓ renders background job completion notice
 Test Files  2 passed (2)`,
          },
        ],
        details: { exitCode: 0 },
      },
    },
  },

  // ── 30.6s – 30.9s: The wait task blocks on the delegates about to start ──
  ...todoUpdateFrames({
    id: "call-todo-block",
    startMs: 30_600,
    endMs: 30_900,
    args: { op: "block", task: TODO_TASKS[4][1], blocker: TODO_BLOCKER },
    text: "Blocked 1 task.",
    statuses: ["completed", "in_progress", "pending", "pending", "blocked", "pending"],
  }),

  // ── 31.2s – 32.0s: Spawning Two Task Subagents with Shared Context ──
  {
    atMs: 31_200,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-task-spawn",
      toolName: "task",
      args: {
        context: sharedTaskContext,
        tasks: [
          {
            name: "Schema Reviewer",
            agent: "researcher",
            task: "Review native event schemas and protocol payload contracts.",
            solutionSpace: "one fix: verify schema parity without network dependencies",
          },
          {
            name: "Timeline Reviewer",
            agent: "reviewer",
            task: "Verify timeline projection and chronological event sequence.",
            solutionSpace: "one fix: validate ordering and status freeze guarantees",
          },
        ],
      },
    },
  },
  {
    atMs: 32_000,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-task-spawn",
      toolName: "task",
      result: {
        content: [{ type: "text", text: "Spawned 2 delegated task subagents." }],
        details: {
          async: { state: "running", jobId: "call-task-spawn", type: "task" },
          tasks: [
            {
              id: "task-worker-1",
              name: "Schema Reviewer",
              agent: "researcher",
              task: "Review native event schemas and protocol payload contracts.",
              status: "running",
            },
            {
              id: "task-worker-2",
              name: "Timeline Reviewer",
              agent: "reviewer",
              task: "Verify timeline projection and chronological event sequence.",
              status: "running",
            },
          ],
        },
      },
    },
  },

  // ── 33.2s – 35.2s: Initial subagent progress with zero cost ──
  {
    atMs: 33_200,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-1",
        nativeAgentId: "task-worker-1",
        parentToolCallId: "call-task-spawn",
        index: 0,
        agent: "researcher",
        label: "Schema Reviewer",
        task: "Review native event schemas and protocol payload contracts.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-1",
          agent: "researcher",
          status: "running",
          task: "Review native event schemas and protocol payload contracts.",
          description: "Schema Reviewer",
          currentTool: "read",
          currentToolIntent: "Read OMP event contracts",
          currentToolArgs: "path: packages/protocol/events.ts:1-120",
          completionPercent: 20,
          toolCount: 1,
          requests: 1,
          tokens: 420,
          contextTokens: 1_400,
          contextWindow: 64_000,
          cost: 0,
        },
      },
    },
  },
  {
    atMs: 35_200,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-2",
        nativeAgentId: "task-worker-2",
        parentToolCallId: "call-task-spawn",
        index: 1,
        agent: "reviewer",
        label: "Timeline Reviewer",
        task: "Verify timeline projection and chronological event sequence.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-2",
          agent: "reviewer",
          status: "running",
          task: "Verify timeline projection and chronological event sequence.",
          description: "Timeline Reviewer",
          currentTool: "grep",
          currentToolIntent: "Search timeline order assertions",
          currentToolArgs: "pattern: 'turn_item.updated'",
          completionPercent: 15,
          toolCount: 1,
          requests: 1,
          tokens: 360,
          contextTokens: 1_100,
          contextWindow: 64_000,
          cost: 0,
        },
      },
    },
  },

  // ── 39.5s – 43.5s: Nonzero cost snapshots and retry reporting ──
  {
    atMs: 39_500,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-1",
        nativeAgentId: "task-worker-1",
        parentToolCallId: "call-task-spawn",
        index: 0,
        agent: "researcher",
        label: "Schema Reviewer",
        task: "Review native event schemas and protocol payload contracts.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-1",
          agent: "researcher",
          status: "running",
          task: "Review native event schemas and protocol payload contracts.",
          description: "Schema Reviewer",
          currentTool: "ast_grep",
          currentToolIntent: "Verify schema interfaces",
          currentToolArgs: "find: 'interface NativeJobSnapshot'",
          completionPercent: 60,
          toolCount: 4,
          requests: 3,
          tokens: 1_950,
          contextTokens: 5_200,
          contextWindow: 64_000,
          cost: 0.0184,
          retryState: {
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2_000,
            errorMessage: "Transient synthetic rate-limit",
          },
        },
      },
    },
  },
  {
    atMs: 43_500,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-2",
        nativeAgentId: "task-worker-2",
        parentToolCallId: "call-task-spawn",
        index: 1,
        agent: "reviewer",
        label: "Timeline Reviewer",
        task: "Verify timeline projection and chronological event sequence.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-2",
          agent: "reviewer",
          status: "running",
          task: "Verify timeline projection and chronological event sequence.",
          description: "Timeline Reviewer",
          currentTool: "find",
          currentToolIntent: "Audit event sequence ordering",
          currentToolArgs: "query: 'chronological event order'",
          completionPercent: 40,
          toolCount: 3,
          requests: 3,
          tokens: 1_600,
          contextTokens: 4_100,
          contextWindow: 64_000,
          cost: 0.0152,
        },
      },
    },
  },

  // ── 47.0s – 51.4s: Task 1 finishes while Task 2 advances ──
  {
    atMs: 47_000,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-1",
        nativeAgentId: "task-worker-1",
        parentToolCallId: "call-task-spawn",
        index: 0,
        agent: "researcher",
        label: "Schema Reviewer",
        task: "Review native event schemas and protocol payload contracts.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-1",
          agent: "researcher",
          status: "running",
          task: "Review native event schemas and protocol payload contracts.",
          description: "Schema Reviewer",
          currentTool: "write",
          currentToolIntent: "Write schema verification artifact",
          currentToolArgs: "path: local://schema-check.json",
          completionPercent: 90,
          toolCount: 6,
          requests: 5,
          tokens: 3_100,
          contextTokens: 7_600,
          contextWindow: 64_000,
          cost: 0.0315,
        },
      },
    },
  },
  // Task 1 completes at 51.0s (clock stays fixed at 19.2s duration)
  {
    atMs: 51_000,
    frame: {
      type: "subagent_lifecycle",
      payload: {
        id: "task-worker-1",
        nativeAgentId: "task-worker-1",
        parentToolCallId: "call-task-spawn",
        index: 0,
        agent: "researcher",
        label: "Schema Reviewer",
        status: "completed",
        durationMs: 19_200,
        resultText: "Schema contract validated: all native fields match OMP specifications.",
        model: "mock/synthetic-preview-v1",
        metrics: {
          toolCount: 7,
          requests: 6,
          tokens: 3_500,
          contextTokens: 8_200,
          contextWindow: 64_000,
          cost: 0.0384,
        },
      },
    },
  },
  {
    atMs: 51_400,
    frame: {
      type: "message_end",
      message: {
        role: "custom",
        customType: "async-result",
        id: "notice-async-worker-1",
        timestamp: scenarioBaseTimeMs + 51_400,
        details: {
          jobs: [
            {
              jobId: "task-worker-1",
              type: "task",
              status: "completed",
              label: "Schema Reviewer",
              durationMs: 19_200,
              resultText: "Schema contract validated: all native fields match OMP specifications.",
            },
          ],
        },
      },
    },
  },

  // ── 53.0s: Task 2 advances while Task 1 remains completed & frozen ──
  {
    atMs: 53_000,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-2",
        nativeAgentId: "task-worker-2",
        parentToolCallId: "call-task-spawn",
        index: 1,
        agent: "reviewer",
        label: "Timeline Reviewer",
        task: "Verify timeline projection and chronological event sequence.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-2",
          agent: "reviewer",
          status: "running",
          task: "Verify timeline projection and chronological event sequence.",
          description: "Timeline Reviewer",
          currentTool: "read",
          currentToolIntent: "Verify waiting job reconciliation",
          currentToolArgs: "path: packages/chat/waiting.ts:50-140",
          completionPercent: 65,
          toolCount: 5,
          requests: 5,
          tokens: 2_800,
          contextTokens: 6_800,
          contextWindow: 64_000,
          cost: 0.0275,
        },
      },
    },
  },

  // ── 54.0s – 54.4s: The benchmark task is dropped ──
  ...todoUpdateFrames({
    id: "call-todo-drop",
    startMs: 54_000,
    endMs: 54_400,
    args: { op: "drop", task: TODO_TASKS[3][1] },
    text: "Dropped 1 task.",
    statuses: ["completed", "in_progress", "pending", "abandoned", "blocked", "pending"],
  }),

  // ── 55.0s – 58.4s: Shell (bash) call with progressive output & result.details.exitCode ──
  {
    atMs: 55_000,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-bash-verify",
      toolName: "bash",
      args: verifyCommandArgs,
    },
  },
  {
    atMs: 56_200,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-bash-verify",
      toolName: "bash",
      partialResult: {
        content: [
          { type: "text", text: "M  apps/web/src/components/chat/NativeWaitingPane.tsx\n" },
        ],
      },
    },
  },
  {
    atMs: 57_200,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-bash-verify",
      toolName: "bash",
      partialResult: {
        content: [
          {
            type: "text",
            text: "M  apps/web/src/components/chat/NativeWaitingPane.tsx\n?? scripts/omp-replay/scenario.mjs\n",
          },
        ],
      },
    },
  },
  {
    atMs: 58_400,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-bash-verify",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: "M  apps/web/src/components/chat/NativeWaitingPane.tsx\n?? scripts/omp-replay/scenario.mjs\nLocal workspace verified\n",
          },
        ],
        details: { exitCode: 0 },
      },
    },
  },

  // ── 59.2s – 63.6s: Native Python & JS calls via eval tool ──
  {
    atMs: 59_200,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-eval-py",
      toolName: "eval",
      args: evalPyArgs,
    },
  },
  {
    atMs: 60_100,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-eval-py",
      toolName: "eval",
      partialResult: { content: [{ type: "text", text: "Average tool dispatch: 15.33ms\n" }] },
    },
  },
  {
    atMs: 61_000,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-eval-py",
      toolName: "eval",
      result: {
        content: [{ type: "text", text: "Average tool dispatch: 15.33ms\n15.333333333333334" }],
        details: { language: "py", exitCode: 0 },
      },
    },
  },
  {
    atMs: 61_800,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-eval-js",
      toolName: "eval",
      args: {
        language: "js",
        code: "const phases = ['pending', 'running', 'completed'];\nphases.map((name, i) => `${i + 1}. ${name}`).join('\\n')",
      },
    },
  },
  {
    atMs: 63_600,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-eval-js",
      toolName: "eval",
      result: {
        content: [{ type: "text", text: "1. pending\n2. running\n3. completed" }],
        details: { language: "js", exitCode: 0 },
      },
    },
  },

  // ── 64.0s – 64.4s: Verification checked off; the wait task unblocks ──
  ...todoUpdateFrames({
    id: "call-todo-verify",
    startMs: 64_000,
    endMs: 64_400,
    args: { op: "done", task: TODO_TASKS[2][1] },
    text: "Completed 1 task; started 1 task.",
    statuses: ["completed", "in_progress", "completed", "abandoned", "in_progress", "pending"],
  }),

  // ── 65.0s – 79.6s: Native hub op=wait lifecycle ──
  // Starts at ~65s with 1 already completed task, 1 running task, 1 running bash, 1 running eval.
  // No JobSnapshot percent field; subagent completionPercent matches by nativeAgentId.
  {
    atMs: 65_000,
    frame: {
      type: "tool_execution_start",
      toolCallId: "call-hub-wait",
      toolName: "hub",
      args: {
        op: "wait",
        ids: ["task-worker-1", "task-worker-2", "job-bash-1", "job-eval-1"],
        timeoutMs: 30_000,
      },
    },
  },
  {
    atMs: 65_500,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-hub-wait",
      toolName: "hub",
      partialResult: {
        content: [{ type: "text", text: "Waiting on 3 running background jobs..." }],
        details: {
          op: "wait",
          jobs: [
            {
              id: "task-worker-1",
              type: "task",
              status: "completed",
              label: "Schema Reviewer",
              durationMs: 19_200,
            },
            {
              id: "task-worker-2",
              type: "task",
              status: "running",
              label: "Timeline Reviewer",
              durationMs: 33_500,
            },
            {
              id: "job-bash-1",
              type: "bash",
              status: "running",
              label: "Background benchmark run",
              durationMs: 14_000,
            },
            {
              id: "job-eval-1",
              type: "eval",
              status: "running",
              label: "Background schema evaluation",
              durationMs: 9_500,
            },
          ],
        },
      },
    },
  },

  // ── 66.5s: IRC relay native structured event ──
  {
    atMs: 66_500,
    frame: {
      type: "irc_message",
      message: {
        role: "custom",
        customType: "irc:relay",
        content:
          "[IRC Timeline Reviewer → orchestrator] Reconciled native wait jobs; finalizing chronological timeline validation.",
        timestamp: scenarioBaseTimeMs + 66_500,
        details: {
          from: "Timeline Reviewer",
          to: "orchestrator",
          body: "Reconciled native wait jobs; finalizing chronological timeline validation.",
          timestamp: scenarioBaseTimeMs + 66_500,
        },
      },
    },
  },

  // ── 69.5s – 69.8s: job-eval-1 completes ──
  {
    atMs: 69_500,
    frame: {
      type: "message_end",
      message: {
        role: "custom",
        customType: "async-result",
        id: "async-notice-eval",
        timestamp: scenarioBaseTimeMs + 69_500,
        details: {
          jobs: [
            {
              jobId: "job-eval-1",
              type: "eval",
              status: "completed",
              label: "Background schema evaluation",
              durationMs: 13_500,
            },
          ],
        },
      },
    },
  },
  {
    atMs: 69_800,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-hub-wait",
      toolName: "hub",
      partialResult: {
        content: [{ type: "text", text: "Waiting on 2 running background jobs..." }],
        details: {
          op: "wait",
          jobs: [
            {
              id: "task-worker-1",
              type: "task",
              status: "completed",
              label: "Schema Reviewer",
              durationMs: 19_200,
            },
            {
              id: "task-worker-2",
              type: "task",
              status: "running",
              label: "Timeline Reviewer",
              durationMs: 37_800,
            },
            {
              id: "job-bash-1",
              type: "bash",
              status: "running",
              label: "Background benchmark run",
              durationMs: 18_300,
            },
            {
              id: "job-eval-1",
              type: "eval",
              status: "completed",
              label: "Background schema evaluation",
              durationMs: 13_500,
            },
          ],
        },
      },
    },
  },

  // ── 73.5s – 73.8s: job-bash-1 fails ──
  {
    atMs: 73_500,
    frame: {
      type: "message_end",
      message: {
        role: "custom",
        customType: "async-result",
        id: "async-notice-bash",
        timestamp: scenarioBaseTimeMs + 73_500,
        details: {
          jobs: [
            {
              jobId: "job-bash-1",
              type: "bash",
              status: "failed",
              label: "Background benchmark run",
              durationMs: 22_000,
              errorText: "Synthetic exit status 1: test suite assertion failed",
            },
          ],
        },
      },
    },
  },
  {
    atMs: 73_800,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-hub-wait",
      toolName: "hub",
      partialResult: {
        content: [{ type: "text", text: "Waiting on 1 running background job..." }],
        details: {
          op: "wait",
          jobs: [
            {
              id: "task-worker-1",
              type: "task",
              status: "completed",
              label: "Schema Reviewer",
              durationMs: 19_200,
            },
            {
              id: "task-worker-2",
              type: "task",
              status: "running",
              label: "Timeline Reviewer",
              durationMs: 41_800,
            },
            {
              id: "job-bash-1",
              type: "bash",
              status: "failed",
              label: "Background benchmark run",
              durationMs: 22_000,
            },
            {
              id: "job-eval-1",
              type: "eval",
              status: "completed",
              label: "Background schema evaluation",
              durationMs: 13_500,
            },
          ],
        },
      },
    },
  },

  // ── 76.5s – 77.5s: Task 2 completes ──
  {
    atMs: 76_500,
    frame: {
      type: "subagent_progress",
      payload: {
        id: "task-worker-2",
        nativeAgentId: "task-worker-2",
        parentToolCallId: "call-task-spawn",
        index: 1,
        agent: "reviewer",
        label: "Timeline Reviewer",
        task: "Verify timeline projection and chronological event sequence.",
        status: "running",
        model: "mock/synthetic-preview-v1",
        progress: {
          id: "task-worker-2",
          agent: "reviewer",
          status: "running",
          task: "Verify timeline projection and chronological event sequence.",
          description: "Timeline Reviewer",
          completionPercent: 100,
          toolCount: 8,
          requests: 6,
          tokens: 3_800,
          contextTokens: 8_400,
          contextWindow: 64_000,
          cost: 0.0462,
        },
      },
    },
  },
  {
    atMs: 77_200,
    frame: {
      type: "subagent_lifecycle",
      payload: {
        id: "task-worker-2",
        nativeAgentId: "task-worker-2",
        parentToolCallId: "call-task-spawn",
        index: 1,
        agent: "reviewer",
        label: "Timeline Reviewer",
        status: "completed",
        durationMs: 45_200,
        resultText:
          "Timeline projection verified: native ordering preserved without regressing states.",
        model: "mock/synthetic-preview-v1",
        metrics: {
          toolCount: 8,
          requests: 6,
          tokens: 3_800,
          contextTokens: 8_400,
          contextWindow: 64_000,
          cost: 0.0462,
        },
      },
    },
  },
  {
    atMs: 77_500,
    frame: {
      type: "message_end",
      message: {
        role: "custom",
        customType: "async-result",
        id: "async-notice-task-2",
        timestamp: scenarioBaseTimeMs + 77_500,
        details: {
          jobs: [
            {
              jobId: "task-worker-2",
              type: "task",
              status: "completed",
              label: "Timeline Reviewer",
              durationMs: 45_200,
              resultText:
                "Timeline projection verified: native ordering preserved without regressing states.",
            },
          ],
        },
      },
    },
  },

  // ── 77.6s – 77.9s: Delegation checked off once Task 2 lands ──
  ...todoUpdateFrames({
    id: "call-todo-delegates",
    startMs: 77_600,
    endMs: 77_900,
    args: { op: "done", task: TODO_TASKS[1][1] },
    text: "Completed 1 task.",
    statuses: ["completed", "completed", "completed", "abandoned", "in_progress", "pending"],
  }),

  // ── 78.0s – 79.6s: All referenced jobs terminal while tool remains running briefly ──
  // Shimmer clears immediately upon this update, tool stays running briefly, then freezes
  {
    atMs: 78_000,
    frame: {
      type: "tool_execution_update",
      toolCallId: "call-hub-wait",
      toolName: "hub",
      partialResult: {
        content: [{ type: "text", text: "All 4 background jobs reached terminal states." }],
        details: {
          op: "wait",
          jobs: [
            {
              id: "task-worker-1",
              type: "task",
              status: "completed",
              label: "Schema Reviewer",
              durationMs: 19_200,
            },
            {
              id: "task-worker-2",
              type: "task",
              status: "completed",
              label: "Timeline Reviewer",
              durationMs: 45_200,
            },
            {
              id: "job-bash-1",
              type: "bash",
              status: "failed",
              label: "Background benchmark run",
              durationMs: 22_000,
            },
            {
              id: "job-eval-1",
              type: "eval",
              status: "completed",
              label: "Background schema evaluation",
              durationMs: 13_500,
            },
          ],
        },
      },
    },
  },
  {
    atMs: 79_600,
    frame: {
      type: "tool_execution_end",
      toolCallId: "call-hub-wait",
      toolName: "hub",
      result: {
        content: [
          {
            type: "text",
            text: "Background jobs finished: 2 tasks completed, 1 eval completed, 1 bash failed.",
          },
        ],
        details: {
          op: "wait",
          jobs: [
            {
              id: "task-worker-1",
              type: "task",
              status: "completed",
              label: "Schema Reviewer",
              durationMs: 19_200,
            },
            {
              id: "task-worker-2",
              type: "task",
              status: "completed",
              label: "Timeline Reviewer",
              durationMs: 45_200,
            },
            {
              id: "job-bash-1",
              type: "bash",
              status: "failed",
              label: "Background benchmark run",
              durationMs: 22_000,
            },
            {
              id: "job-eval-1",
              type: "eval",
              status: "completed",
              label: "Background schema evaluation",
              durationMs: 13_500,
            },
          ],
        },
      },
    },
  },

  // ── 80.4s – 81.4s: Completing TODO plan phases ──
  ...todoUpdateFrames({
    id: "call-todo-finish",
    startMs: 80_400,
    endMs: 81_400,
    args: { op: "replace" },
    text: "All native TODO plan phases marked completed.",
    statuses: ["completed", "completed", "completed", "abandoned", "completed", "completed"],
  }),

  // ── 82.0s – 86.2s: Final actual assistant streamed summary ──
  { atMs: 82_000, frame: { type: "message_start", message: { role: "assistant" } } },
  {
    atMs: 82_400,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: finalText[0],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 83_400,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: finalText[1],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 84_400,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: finalText[2],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 85_200,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: finalText[3],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 85_800,
    frame: {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: finalText[4],
        contentIndex: 0,
      },
    },
  },
  {
    atMs: 86_200,
    frame: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: fullFinalText }],
        stopReason: "stop",
      },
    },
  },

  // ── 87.0s: Root terminal agent_end only after all lifecycles terminal ──
  { atMs: 87_000, frame: { type: "agent_end", isTerminal: true } },
];

// Calls whose arguments stream into their pane before they run.
const tourFrames = withSegments(nativeFrames, [
  {
    atMs: 12_200,
    durationMs: 3_000,
    frames: streamedToolCallFrames({
      id: "call-edit-reconciler",
      name: "edit",
      args: reconcilerEditArgs,
      streamPath: ["edits", 0, "diff"],
      durationMs: 3_000,
    }),
  },
  {
    atMs: 14_000,
    durationMs: 4_200,
    frames: [
      ...streamedToolCallFrames({
        id: "call-write-priority",
        name: "write",
        args: priorityWriteArgs,
        streamPath: ["content"],
        durationMs: 3_000,
      }),
      {
        atMs: 3_100,
        frame: {
          type: "tool_execution_start",
          toolCallId: "call-write-priority",
          toolName: "write",
          args: priorityWriteArgs,
        },
      },
      {
        atMs: 3_900,
        frame: {
          type: "tool_execution_end",
          toolCallId: "call-write-priority",
          toolName: "write",
          result: {
            content: [{ type: "text", text: `Wrote 17 lines to ${priorityWriteArgs.path}` }],
          },
        },
      },
    ],
  },
  {
    atMs: 55_000,
    durationMs: 1_200,
    frames: streamedToolCallFrames({
      id: "call-bash-verify",
      name: "bash",
      args: verifyCommandArgs,
      streamPath: ["command"],
      durationMs: 1_200,
    }),
  },
  {
    atMs: 59_200,
    durationMs: 2_400,
    frames: streamedToolCallFrames({
      id: "call-eval-py",
      name: "eval",
      args: evalPyArgs,
      streamPath: ["code"],
      durationMs: 2_400,
    }),
  },
]);

export const builtInScenario = Object.freeze({
  scenario: "Synthetic OMP fixture",
  title: "OMP native event tour",
  prompt: "Inspect the synthetic OMP replay fixture and summarize its native activity.",
  warnings: ["Synthetic fixture data only; the offline worker never invokes a model or provider."],
  turns: [
    {
      prompt: "Inspect the synthetic OMP replay fixture and summarize its native activity.",
      schedule: tourFrames,
    },
  ],
  schedule: tourFrames,
});
