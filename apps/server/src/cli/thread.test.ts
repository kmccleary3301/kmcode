import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestratorMcpThreadTimelineItem as OrchestratorMcpThreadTimelineItemType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  readLatestMessages,
  ThreadToolFailedError,
  type ThreadTools,
  waitForRun,
} from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

const threadReadResult = (
  input: {
    readonly itemCount?: number;
    readonly pendingRequestCount?: number;
    readonly items?: ReadonlyArray<OrchestratorMcpThreadTimelineItemType>;
    readonly nextPosition?: number | null;
    readonly hasMore?: boolean;
  } = {},
) => ({
  thread: {
    threadId,
    link: "t3code://thread",
    projectId: ProjectId.make("project-1"),
    title: "Test thread",
    createdBy: "user",
    creationSource: "mcp",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: input.itemCount ?? input.items?.length ?? 0,
    pendingRequestCount: input.pendingRequestCount ?? 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  },
  recentRuns: [],
  items: input.items ?? [],
  nextPosition: input.nextPosition ?? null,
  hasMore: input.hasMore ?? false,
});

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call: ThreadTools["call"] = <S extends Schema.Decoder<unknown>>(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    schema: S,
  ): Effect.Effect<S["Type"], ThreadToolFailedError> => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    if (next === undefined) return Effect.die(`unscripted ${tool} call`);
    return Schema.decodeUnknownEffect(schema)(next).pipe(
      Effect.mapError(
        () => new ThreadToolFailedError({ tool, detail: "Invalid scripted tool result." }),
      ),
    );
  };
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [threadReadResult()],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [threadReadResult({ pendingRequestCount: 1 })],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [threadReadResult({ pendingRequestCount: 1 })],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

/** Serves t3_thread_read pages with positions that count every timeline item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map<OrchestratorMcpThreadTimelineItemType>((type, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    itemId: TurnItemId.make(`item-${position}`),
    runId: null,
    messageId: null,
    createdBy: "agent",
    creationSource: "mcp",
    type,
    status: "completed",
    title: null,
    text: null,
    textTruncated: false,
    updatedAt: "2026-10-31T00:00:00.000Z",
  }));
  const served: Array<number> = [];
  const call: ThreadTools["call"] = <S extends Schema.Decoder<unknown>>(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    schema: S,
  ): Effect.Effect<S["Type"], ThreadToolFailedError> => {
    const afterPosition = typeof args.afterPosition === "number" ? args.afterPosition : -1;
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const matching = items.filter(
      (item) =>
        item.position > afterPosition &&
        ["user_message", "assistant_message", "proposed_plan"].includes(item.type),
    );
    const page = matching.slice(0, limit);
    served.push(page.length);
    return Schema.decodeUnknownEffect(schema)(
      threadReadResult({
        itemCount: items.length,
        items: page,
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: matching.length > page.length,
      }),
    ).pipe(
      Effect.mapError(
        () => new ThreadToolFailedError({ tool, detail: "Invalid timeline tool result." }),
      ),
    );
  };
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (toolCalls: number) => [
  ...Array<string>(toolCalls).fill("tool_call"),
  "assistant_message",
];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);
