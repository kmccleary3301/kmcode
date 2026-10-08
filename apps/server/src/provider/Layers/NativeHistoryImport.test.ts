import {
  EventId,
  MessageId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";

import {
  appendNativeHistoryPage,
  NativeHistoryIdentities,
  type ImportedNativeTurn,
} from "./NativeHistoryImport.ts";

const userMessage = {
  role: "user" as const,
  text: "Continue",
  timestamp: "2026-08-01T12:00:00.000Z",
};
const assistantMessage = {
  role: "assistant" as const,
  text: "Done",
  timestamp: "2026-08-01T12:00:01.000Z",
};

function firstPage(threadId: ThreadId) {
  return appendNativeHistoryPage({
    threadId,
    messages: [userMessage],
    messageOffset: 0,
    turnOffset: 0,
    currentTurn: null,
  });
}

describe("appendNativeHistoryPage", () => {
  it("retains captured tool results when the native runtime prunes its history", () => {
    const threadId = ThreadId.make("native-pruned-result");
    const result = { content: [{ type: "text", text: "Original file contents" }] };
    const completed = {
      role: "tool" as const,
      phase: "completed" as const,
      timestamp: "2026-08-01T12:00:00.500Z",
      sourceId: "read-result",
      toolCallId: "read-call",
      payload: {
        itemType: "dynamic_tool_call" as const,
        status: "completed" as const,
        rawOutput: "Original file contents",
        data: { item: { input: { path: "file.txt" }, result } },
      },
    };
    const page = {
      threadId,
      messages: [userMessage, completed, assistantMessage],
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    };
    const captured = appendNativeHistoryPage(page);
    const pruned = {
      ...completed,
      payload: {
        ...completed.payload,
        rawOutput: "[Superseded by a newer read of this file]",
        data: {
          item: {
            ...completed.payload.data.item,
            result: {
              content: [{ type: "text", text: "[Superseded by a newer read of this file]" }],
              prunedAt: 1785590000000,
            },
          },
        },
      },
    };
    const imported = appendNativeHistoryPage({
      ...page,
      messages: [userMessage, pruned, assistantMessage],
      identities: new NativeHistoryIdentities({
        threadId,
        messages: captured.messages,
        activities: captured.activities,
        turns: captured.turns,
      }),
    });
    expect(imported.activities[0]?.payload).toMatchObject({
      rawOutput: "Original file contents",
      data: { item: { input: { path: "file.txt" }, result } },
    });
  });

  it("scopes imported identities to the T3 thread, not the provider session id", () => {
    const first = firstPage(ThreadId.make("native:omp-work:shared-session"));
    const second = firstPage(ThreadId.make("native:omp-personal:shared-session"));

    expect(first.messages[0]?.id).not.toBe(second.messages[0]?.id);
    expect(first.turns[0]?.turnId).not.toBe(second.turns[0]?.turnId);
  });

  it("continues one turn and monotonically advances message identities across pages", () => {
    const threadId = ThreadId.make("native:omp:session-1");
    const first = firstPage(threadId);
    const second = appendNativeHistoryPage({
      threadId,
      messages: [assistantMessage],
      messageOffset: first.messageOffset,
      turnOffset: first.turnOffset,
      currentTurn: first.currentTurn,
    });

    expect(first.messages[0]?.id).toBe("native-message:native:omp:session-1:1");
    expect(second.messages[0]?.id).toBe("native-message:native:omp:session-1:2");
    expect(second.messages[0]?.turnId).toBe(first.turns[0]?.turnId);
    expect(second.turns[0]?.state).toBe("completed");
  });

  it("persists ordered tool lifecycle activities across pages without collapsing calls", () => {
    const threadId = ThreadId.make("native:omp:session-tools");
    const startedRead = {
      role: "tool" as const,
      timestamp: "2026-08-01T12:00:01.000Z",
      toolCallId: "call-1",
      phase: "started" as const,
      sourceId: "assistant-1",
      sourceIndex: 0,
      payload: {
        itemType: "dynamic_tool_call" as const,
        status: "inProgress" as const,
        title: "Read File",
        data: {
          toolCallId: "call-1",
          item: { name: "read", input: { path: "src/a.ts" } },
        },
      },
    };
    const startedTerminal = {
      role: "tool" as const,
      timestamp: "2026-08-01T12:00:02.000Z",
      toolCallId: "call-2",
      phase: "started" as const,
      sourceId: "assistant-1",
      sourceIndex: 1,
      payload: {
        itemType: "command_execution" as const,
        status: "inProgress" as const,
        title: "Terminal",
        data: {
          toolCallId: "call-2",
          item: { name: "bash", input: { command: "printf x" } },
        },
      },
    };
    const firstPageMessages = [userMessage, startedRead, startedTerminal];
    const first = appendNativeHistoryPage({
      threadId,
      messages: firstPageMessages,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    });
    const secondPageMessages = [
      {
        role: "tool" as const,
        timestamp: "2026-08-01T12:00:03.000Z",
        toolCallId: "call-1",
        phase: "completed" as const,
        sourceId: "tool-result-1",
        sourceIndex: 0,
        payload: {
          itemType: "dynamic_tool_call" as const,
          status: "completed" as const,
          title: "Read File",
          data: {
            toolCallId: "call-1",
            item: { name: "read", result: { content: "file contents" } },
          },
        },
      },
      {
        role: "tool" as const,
        timestamp: "2026-08-01T12:00:04.000Z",
        toolCallId: "call-2",
        phase: "completed" as const,
        sourceId: "tool-result-2",
        sourceIndex: 0,
        payload: {
          itemType: "command_execution" as const,
          status: "failed" as const,
          title: "Terminal",
          data: {
            toolCallId: "call-2",
            item: { name: "bash", result: { error: "exit 1" } },
          },
        },
      },
      assistantMessage,
    ];
    const second = appendNativeHistoryPage({
      threadId,
      messages: secondPageMessages,
      messageOffset: first.messageOffset,
      turnOffset: first.turnOffset,
      currentTurn: first.currentTurn,
    });
    const repeated = appendNativeHistoryPage({
      threadId,
      messages: firstPageMessages,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    });

    expect(first.activities.map((activity) => activity.kind)).toEqual([
      "tool.started",
      "tool.started",
    ]);
    expect(second.activities.map((activity) => activity.kind)).toEqual([
      "tool.completed",
      "tool.completed",
    ]);
    expect(first.activities[0]?.turnId).toBe(second.activities[0]?.turnId);
    expect(second.turns[0]?.state).toBe("completed");
    expect(second.turns[0]?.assistantMessageId).toBe(second.messages[0]?.id);
    expect(repeated.activities[0]?.id).toBe(first.activities[0]?.id);
    expect(repeated.activities[0]?.payload).toEqual(first.activities[0]?.payload);
    expect(second.activities[1]?.payload).toMatchObject({
      status: "failed",
      data: { toolCallId: "call-2" },
    });
  });
  it("imports persisted native child snapshots and reuses task identities on replay", () => {
    const threadId = ThreadId.make("native-task-replay");
    const taskMessage = {
      role: "tool" as const,
      timestamp: "2026-08-01T12:00:02.000Z",
      toolCallId: "task-call",
      phase: "completed" as const,
      payload: {
        itemType: "collab_agent_tool_call" as const,
        status: "completed" as const,
        title: "Task",
        data: { toolCallId: "task-call" },
      },
      tasks: [
        {
          taskId: RuntimeTaskId.make("ProofA"),
          description: "Return the proof marker",
          taskType: "subagent",
          status: "interrupted" as const,
          role: "scout",
          toolUseId: "task-call",
          summary: "partial child output",
          error: "Request was aborted",
          runHandles: { transcriptDir: "/tmp/ProofA" },
        },
      ],
    };
    const first = appendNativeHistoryPage({
      threadId,
      messages: [userMessage, taskMessage],
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    });
    const replay = appendNativeHistoryPage({
      threadId,
      messages: [userMessage, taskMessage],
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
      identities: new NativeHistoryIdentities({
        threadId,
        messages: first.messages,
        activities: first.activities,
        turns: first.turns.map((turn) => ({
          ...turn,
          assistantMessageId: turn.assistantMessageId ?? null,
        })),
      }),
    });
    expect(first.activities.map((activity) => activity.kind)).toEqual([
      "tool.completed",
      "task.completed",
    ]);
    expect(first.activities[1]?.payload).toMatchObject({
      taskId: "ProofA",
      status: "stopped",
      summary: "partial child output",
      error: "Request was aborted",
      toolUseId: "task-call",
    });
    expect(replay.activities.map((activity) => activity.id)).toEqual(
      first.activities.map((activity) => activity.id),
    );
  });
});

describe("native history identity reconciliation", () => {
  it("reuses live identities but preserves an externally repeated turn", () => {
    const threadId = ThreadId.make("native-live-reopen");
    const liveTurnId = TurnId.make("live-turn");
    const existingMessages: OrchestrationMessage[] = [
      {
        id: MessageId.make("live-user"),
        role: "user",
        text: "Continue",
        turnId: liveTurnId,
        streaming: false,
        createdAt: userMessage.timestamp,
        updatedAt: userMessage.timestamp,
      },
      {
        id: MessageId.make("live-assistant"),
        role: "assistant",
        text: "Done",
        turnId: liveTurnId,
        streaming: false,
        createdAt: assistantMessage.timestamp,
        updatedAt: assistantMessage.timestamp,
      },
    ];
    const existingTurns: ImportedNativeTurn[] = [
      {
        turnId: liveTurnId,
        state: "completed",
        requestedAt: userMessage.timestamp,
        startedAt: userMessage.timestamp,
        completedAt: "2026-08-01T12:00:02.000Z",
        assistantMessageId: MessageId.make("live-assistant"),
      },
    ];
    const existingActivities: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("live-tool-result"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Read File",
        turnId: liveTurnId,
        createdAt: assistantMessage.timestamp,
        payload: { itemType: "dynamic_tool_call", toolCallId: "call-1", status: "completed" },
      },
    ];
    const nativeMessages = [
      { ...userMessage, sourceId: "original-user", timestamp: "2026-08-01T12:00:00.010Z" },
      {
        role: "tool" as const,
        sourceId: "original-result",
        timestamp: assistantMessage.timestamp,
        toolCallId: "call-1",
        phase: "completed" as const,
        payload: {
          itemType: "dynamic_tool_call" as const,
          status: "completed" as const,
          title: "Read File",
          data: {
            item: {
              input: { path: "a.txt" },
              result: { content: [{ type: "text", text: "Full file" }] },
            },
          },
        },
      },
      { ...assistantMessage, sourceId: "original-assistant" },
      { ...userMessage, sourceId: "external-user", timestamp: "2026-08-01T12:00:03.000Z" },
      {
        ...assistantMessage,
        sourceId: "external-assistant",
        timestamp: "2026-08-01T12:00:04.000Z",
      },
    ];
    const imported = appendNativeHistoryPage({
      threadId,
      messages: nativeMessages,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
      identities: new NativeHistoryIdentities({
        threadId,
        messages: existingMessages,
        activities: existingActivities,
        turns: existingTurns,
      }),
    });
    expect(imported.messages.map((message) => message.id)).toEqual([
      "live-user",
      "live-assistant",
      "native-message:native-live-reopen:external-user:0",
      "native-message:native-live-reopen:external-assistant:0",
    ]);
    expect(imported.activities[0]?.id).toBe("live-tool-result");
    expect(imported.activities[0]?.payload).toMatchObject({
      toolCallId: "call-1",
      data: { item: { input: { path: "a.txt" } } },
    });
    expect(imported.turns.map((turn) => turn.turnId)).toEqual([
      "native-turn:native-live-reopen:external-user",
    ]);
    const reopened = appendNativeHistoryPage({
      threadId,
      messages: nativeMessages,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
      identities: new NativeHistoryIdentities({
        threadId,
        messages: imported.messages,
        activities: imported.activities,
        turns: [...existingTurns, ...imported.turns],
      }),
    });
    expect(reopened.messages.map((message) => message.id)).toEqual(
      imported.messages.map((message) => message.id),
    );
    expect(reopened.activities.map((activity) => activity.id)).toEqual(
      imported.activities.map((activity) => activity.id),
    );
    expect(reopened.turns).toEqual([]);
  });

  it("repairs legacy imported Markdown without adding another message", () => {
    const threadId = ThreadId.make("legacy-history");
    const original = firstPage(threadId);
    const assistant = appendNativeHistoryPage({
      threadId,
      messages: [{ ...assistantMessage, text: "# Heading Body" }],
      messageOffset: original.messageOffset,
      turnOffset: original.turnOffset,
      currentTurn: original.currentTurn,
    });
    const repaired = appendNativeHistoryPage({
      threadId,
      messages: [
        { ...userMessage, sourceId: "user" },
        { ...assistantMessage, sourceId: "assistant", text: "# Heading\n\nBody" },
      ],
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
      identities: new NativeHistoryIdentities({
        threadId,
        messages: [...original.messages, ...assistant.messages],
        activities: [],
        turns: assistant.turns,
      }),
    });
    expect(repaired.messages[1]?.id).toBe(assistant.messages[0]?.id);
    expect(repaired.messages[1]?.text).toBe("# Heading\n\nBody");
  });
  it("reconciles an orphaned live user with one native turn and terminal children", () => {
    const threadId = ThreadId.make("native-live-user-without-turn");
    const liveTurnId = TurnId.make("live-turn");
    const existingMessages: OrchestrationMessage[] = [
      {
        id: MessageId.make("live-user"),
        role: "user",
        text: "Run the native fidelity probe.",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        id: MessageId.make("live-preface"),
        role: "assistant",
        text: "Reading files before the child round.",
        turnId: liveTurnId,
        streaming: false,
        createdAt: "2026-08-01T12:00:00.100Z",
        updatedAt: "2026-08-01T12:00:00.100Z",
      },
      {
        id: MessageId.make("live-final"),
        role: "assistant",
        text: "Native proof complete.",
        turnId: liveTurnId,
        streaming: false,
        createdAt: "2026-08-01T12:00:04.000Z",
        updatedAt: "2026-08-01T12:00:04.000Z",
      },
    ];
    const existingTurns: ImportedNativeTurn[] = [
      {
        turnId: liveTurnId,
        state: "completed",
        requestedAt: "2026-08-01T12:00:00.000Z",
        startedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:05.000Z",
        assistantMessageId: MessageId.make("live-final"),
      },
    ];
    const existingActivities: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("live-read-start"),
        tone: "tool",
        kind: "tool.started",
        summary: "Read File started",
        turnId: liveTurnId,
        createdAt: "2026-08-01T12:00:00.200Z",
        payload: {
          itemType: "dynamic_tool_call",
          toolCallId: "read-call",
          status: "inProgress",
        },
      },
      {
        id: EventId.make("live-read-complete"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Read File",
        turnId: liveTurnId,
        createdAt: "2026-08-01T12:00:00.300Z",
        payload: {
          itemType: "dynamic_tool_call",
          toolCallId: "read-call",
          status: "completed",
          data: { item: { result: { content: "full read result" } } },
        },
      },
      {
        id: EventId.make("live-task-start"),
        tone: "tool",
        kind: "tool.started",
        summary: "Task started",
        turnId: liveTurnId,
        createdAt: "2026-08-01T12:00:01.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "task-call",
          status: "inProgress",
        },
      },
      {
        id: EventId.make("live-task-complete"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Task",
        turnId: liveTurnId,
        createdAt: "2026-08-01T12:00:02.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "task-call",
          status: "completed",
        },
      },
      {
        id: EventId.make("live-child-a"),
        tone: "info",
        kind: "task.completed",
        summary: "Proof A",
        turnId: liveTurnId,
        createdAt: "2026-08-01T12:00:02.000Z",
        payload: {
          taskId: "ProofA",
          status: "completed",
          toolUseId: "task-call",
        },
      },
      {
        id: EventId.make("live-child-b"),
        tone: "info",
        kind: "task.completed",
        summary: "Proof B",
        turnId: liveTurnId,
        createdAt: "2026-08-01T12:00:03.000Z",
        payload: {
          taskId: "ProofB",
          status: "completed",
          toolUseId: "task-call",
        },
      },
    ];
    const nativeMessages = [
      {
        role: "user" as const,
        text: "Run the native fidelity probe.",
        timestamp: "2026-08-01T12:00:00.010Z",
        sourceId: "native-user",
      },
      {
        role: "assistant" as const,
        text: "Reading files before the child round.",
        timestamp: "2026-08-01T12:00:00.100Z",
        sourceId: "native-preface",
      },
      {
        role: "tool" as const,
        timestamp: "2026-08-01T12:00:00.200Z",
        toolCallId: "read-call",
        phase: "started" as const,
        sourceId: "native-read-start",
        payload: {
          itemType: "dynamic_tool_call" as const,
          status: "inProgress" as const,
          title: "Read File",
          data: { item: { input: { path: "proof.txt" } } },
        },
      },
      {
        role: "tool" as const,
        timestamp: "2026-08-01T12:00:00.300Z",
        toolCallId: "read-call",
        phase: "completed" as const,
        sourceId: "native-read-complete",
        payload: {
          itemType: "dynamic_tool_call" as const,
          status: "completed" as const,
          title: "Read File",
          data: { item: { result: { content: "full read result" } } },
        },
      },
      {
        role: "tool" as const,
        timestamp: "2026-08-01T12:00:01.000Z",
        toolCallId: "task-call",
        phase: "started" as const,
        sourceId: "native-task-start",
        payload: {
          itemType: "collab_agent_tool_call" as const,
          status: "inProgress" as const,
          title: "Task",
          data: { item: { input: { tasks: ["ProofA", "ProofB"] } } },
        },
      },
      {
        role: "tool" as const,
        timestamp: "2026-08-01T12:00:02.000Z",
        toolCallId: "task-call",
        phase: "completed" as const,
        sourceId: "native-task-complete",
        payload: {
          itemType: "collab_agent_tool_call" as const,
          status: "completed" as const,
          title: "Task",
          data: { item: { result: { children: ["ProofA", "ProofB"] } } },
        },
        tasks: [
          {
            taskId: RuntimeTaskId.make("ProofA"),
            description: "Proof A",
            taskType: "subagent",
            status: "completed" as const,
            toolUseId: "task-call",
            endedAt: "2026-08-01T12:00:02.400Z",
          },
          {
            taskId: RuntimeTaskId.make("ProofB"),
            description: "Proof B",
            taskType: "subagent",
            status: "completed" as const,
            toolUseId: "task-call",
          },
        ],
      },
      {
        role: "assistant" as const,
        text: "Native proof complete.",
        timestamp: "2026-08-01T12:00:04.000Z",
        sourceId: "native-final",
      },
    ];
    const importPage = (identities: NativeHistoryIdentities) =>
      appendNativeHistoryPage({
        threadId,
        messages: nativeMessages,
        messageOffset: 0,
        turnOffset: 0,
        currentTurn: null,
        identities,
      });
    const lateProgress = ["ProofA", "ProofB"].map((taskId): OrchestrationThreadActivity => ({
      id: EventId.make(`progress-${taskId}`),
      tone: "info",
      kind: "task.progress",
      summary: "Running child",
      payload: { taskId, taskType: "subagent", status: "running", toolUseId: "task-call" },
      turnId: liveTurnId,
      createdAt: "2026-08-01T12:00:02.500Z",
    }));
    existingActivities.push(...lateProgress, {
      id: EventId.make("live-child-a-repeat"),
      tone: "info",
      kind: "task.completed",
      summary: "Proof A",
      turnId: liveTurnId,
      createdAt: "2026-08-01T12:00:02.000Z",
      payload: { taskId: "ProofA", status: "completed", toolUseId: "task-call" },
    });
    const first = importPage(
      new NativeHistoryIdentities({
        threadId,
        messages: existingMessages,
        activities: existingActivities,
        turns: existingTurns,
      }),
    );

    expect(first.turns).toEqual([]);
    expect(first.messages.map((message) => message.id)).toEqual([
      "live-user",
      "live-preface",
      "live-final",
    ]);
    expect(first.messages.map((message) => message.turnId)).toEqual([
      liveTurnId,
      liveTurnId,
      liveTurnId,
    ]);
    expect(first.activities.map((activity) => activity.id).toSorted()).toEqual(
      existingActivities
        .filter((activity) => activity.kind !== "task.progress")
        .map((activity) => activity.id)
        .toSorted(),
    );
    const restored = [...first.activities, ...lateProgress].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    expect(
      foldSubagentActivities(restored).map(({ status, activationCount }) => ({
        status,
        activationCount,
      })),
    ).toEqual([
      { status: "completed", activationCount: 1 },
      { status: "completed", activationCount: 1 },
    ]);
    expect(first.activities[1]?.payload).toMatchObject({
      data: { item: { result: { content: "full read result" } } },
    });

    const replay = importPage(
      new NativeHistoryIdentities({
        threadId,
        messages: first.messages,
        activities: [...first.activities, ...lateProgress],
        turns: existingTurns,
      }),
    );
    expect(replay.turns).toEqual([]);
    expect(replay.messages.map((message) => message.id)).toEqual(
      first.messages.map((message) => message.id),
    );
    expect(replay.activities.map((activity) => activity.id)).toEqual(
      first.activities.map((activity) => activity.id),
    );
    expect(replay.activities.map((activity) => activity.payload)).toEqual(
      first.activities.map((activity) => activity.payload),
    );
  });
});
