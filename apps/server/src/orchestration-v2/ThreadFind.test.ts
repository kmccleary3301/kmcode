import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { findProjectedThreadItems } from "./ThreadFind.ts";

const threadId = ThreadId.make("thread:find");
const runId = RunId.make("run:find");
const at = DateTime.makeUnsafe(Date.UTC(2026, 8, 27));

function assistantMessage(
  id: string,
  position: number,
  text: string,
): OrchestrationV2ProjectedTurnItem {
  const item: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> = {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position + 1,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: false,
  };
  return {
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  };
}

it("selects searchable rendered text and wraps navigation from the reading match", () => {
  const items = [
    assistantMessage("first", 0, "Check **the build** at [docs](https://hidden.example/needle)."),
    assistantMessage("skill", 1, "Use $deploy-prod now."),
    assistantMessage("last", 2, "The build is ready."),
  ];
  const result = findProjectedThreadItems(
    items,
    {
      threadId,
      query: "build",
      start: { entryId: "last", occurrence: 0 },
      offset: 1,
    },
    42,
  );
  expect(result.snapshotSequence).toBe(42);
  expect(result.totalMatches).toBe(2);
  expect(result.activeIndex).toBe(0);
  expect(result.match).toEqual({ entryId: "first", runId, occurrence: 0 });
  expect(result.navigation).toEqual([
    { entryId: "first", runId, startIndex: 0, count: 1 },
    { entryId: "last", runId, startIndex: 1, count: 1 },
  ]);

  const skill = findProjectedThreadItems(
    items,
    {
      threadId,
      query: "Deploy Production",
      skills: [{ name: "deploy-prod", displayName: "Deploy Production" }],
    },
    42,
  );
  expect(skill.totalMatches).toBe(1);
  expect(skill.match).toEqual({ entryId: "skill", runId, occurrence: 0 });
});
