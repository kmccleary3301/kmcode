import {
  type EnvironmentId,
  type NodeId,
  type OrchestrationV2SubagentLiveContent,
  type OrchestrationV2ThreadLiveItem,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { threadKey } from "./entities.ts";

export interface ThreadLiveOverlayState {
  readonly subagentContentByTurnItemId: ReadonlyMap<
    TurnItemId,
    { readonly subagentId: NodeId; readonly liveContent: OrchestrationV2SubagentLiveContent }
  >;
  readonly mode: { readonly mode: "events" | "progress"; readonly reason: "viewing" | "idle" | "rate-limited" } | null;
}

export const EMPTY_THREAD_LIVE_OVERLAY: ThreadLiveOverlayState = Object.freeze({
  subagentContentByTurnItemId: new Map(),
  mode: null,
});

export function resetThreadLiveOverlay(): ThreadLiveOverlayState {
  return EMPTY_THREAD_LIVE_OVERLAY;
}

export function reduceThreadLiveOverlay(
  current: ThreadLiveOverlayState,
  item: OrchestrationV2ThreadLiveItem,
): ThreadLiveOverlayState {
  if (item.kind === "live-mode") {
    return { ...current, mode: { mode: item.mode, reason: item.reason } };
  }

  const subagentContentByTurnItemId = new Map(current.subagentContentByTurnItemId);
  for (const [turnItemId, entry] of subagentContentByTurnItemId) {
    if (entry.subagentId === item.subagentId) subagentContentByTurnItemId.delete(turnItemId);
  }
  if (item.liveContent !== null) {
    subagentContentByTurnItemId.set(item.turnItemId, {
      subagentId: item.subagentId,
      liveContent: item.liveContent,
    });
  }
  return { ...current, subagentContentByTurnItemId };
}


const overlayAtoms = Atom.family((key: string) =>
  Atom.make(EMPTY_THREAD_LIVE_OVERLAY).pipe(Atom.withLabel(`thread-live-overlay:${key}`)),
);

export function environmentThreadLiveOverlayAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  return overlayAtoms(threadKey({ environmentId, threadId }));
}

