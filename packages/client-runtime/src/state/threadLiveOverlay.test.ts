import {
  NodeId,
  TurnItemId,
  type OrchestrationV2SubagentLiveContent,
  type OrchestrationV2ThreadLiveItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_THREAD_LIVE_OVERLAY,
  reduceThreadLiveOverlay,
  resetThreadLiveOverlay,
} from "./threadLiveOverlay.ts";

const turnItemId = TurnItemId.make("turn-item-1");
const subagentId = NodeId.make("subagent-1");
const liveContent: OrchestrationV2SubagentLiveContent = {
  kind: "assistant",
  text: "Drafting a response",
  truncated: false,
};

const update: OrchestrationV2ThreadLiveItem = {
  kind: "subagent-live",
  turnItemId,
  subagentId,
  liveContent,
};

describe("thread live overlay reducer", () => {
  it("sets live content, clears it on null, and resets on resubscribe", () => {
    const withContent = reduceThreadLiveOverlay(EMPTY_THREAD_LIVE_OVERLAY, update);
    expect(withContent.subagentContentByTurnItemId.get(turnItemId)).toEqual({
      subagentId,
      liveContent,
    });
    const unknownTurnItemId = TurnItemId.make("turn-item-not-yet-projected");
    const unknownSubagentId = NodeId.make("subagent-not-yet-projected");
    const withUnknownSubagent = reduceThreadLiveOverlay(withContent, {
      ...update,
      turnItemId: unknownTurnItemId,
      subagentId: unknownSubagentId,
    });
    expect(withUnknownSubagent.subagentContentByTurnItemId.get(unknownTurnItemId)).toEqual({
      subagentId: unknownSubagentId,
      liveContent,
    });

    const withMode = reduceThreadLiveOverlay(withUnknownSubagent, {
      kind: "live-mode",
      mode: "events",
      reason: "viewing",
    });
    const cleared = reduceThreadLiveOverlay(withMode, { ...update, liveContent: null });
    expect(cleared.subagentContentByTurnItemId.has(turnItemId)).toBe(false);
    expect(cleared.subagentContentByTurnItemId.has(unknownTurnItemId)).toBe(true);
    expect(cleared.mode).toEqual({ mode: "events", reason: "viewing" });
    expect(resetThreadLiveOverlay()).toEqual(EMPTY_THREAD_LIVE_OVERLAY);

  });
});
