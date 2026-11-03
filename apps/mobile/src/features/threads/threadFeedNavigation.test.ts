import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed } from "../../lib/threadActivity";
import {
  deriveThreadFeedNavigationItems,
  filterThreadFeedNavigationItems,
  resolveThreadFeedNavigationIndex,
} from "./threadFeedNavigation";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

function base(id: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(`2026-06-20T00:00:0${ordinal}.000Z`);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

const items: ReadonlyArray<OrchestrationV2TurnItem> = [
  {
    ...base("prompt", 1),
    type: "user_message",
    messageId: MessageId.make("message-prompt"),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent: "turn_start",
    text: "Fix   the flaky\nlogin test",
    attachments: [],
  },
  { ...base("command", 2), type: "command_execution", input: "vp test login", exitCode: 0 },
  {
    ...base("answer", 3),
    type: "assistant_message",
    messageId: MessageId.make("message-answer"),
    text: "The login test now waits for the session.",
    streaming: false,
  },
];
const feed = buildThreadFeed(
  items.map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  })),
);

describe("thread feed navigation", () => {
  it("lists prompts, answers, and tool work in feed order with compact titles", () => {
    expect(
      deriveThreadFeedNavigationItems(feed).map(({ kind, title, subtitle }) => ({
        kind,
        title,
        subtitle,
      })),
    ).toEqual([
      { kind: "prompt", title: "Fix the flaky login test", subtitle: null },
      { kind: "tool", title: "Command", subtitle: "vp test login" },
      { kind: "answer", title: "The login test now waits for the session.", subtitle: null },
    ]);
  });

  it("matches every query term across kinds and tool commands", () => {
    const navigation = deriveThreadFeedNavigationItems(feed);
    expect(
      filterThreadFeedNavigationItems(navigation, "LOGIN   test").map((item) => item.kind),
    ).toEqual(["prompt", "tool", "answer"]);
    expect(filterThreadFeedNavigationItems(navigation, "tool vp").map((item) => item.kind)).toEqual(
      ["tool"],
    );
    expect(filterThreadFeedNavigationItems(navigation, "login missing")).toEqual([]);
  });

  it("jumps to the group holding an activity and falls back to its run when folded away", () => {
    const tool = deriveThreadFeedNavigationItems(feed).find((item) => item.kind === "tool");
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    const groupIndex = feed.findIndex((entry) => entry.type === "activity-group");
    expect(resolveThreadFeedNavigationIndex(feed, tool)).toBe(groupIndex);

    const folded = feed.filter((entry) => entry.type !== "activity-group");
    expect(resolveThreadFeedNavigationIndex(folded, tool)).toBe(0);
    expect(resolveThreadFeedNavigationIndex(folded, { ...tool, runId: null })).toBeNull();
  });
});
