import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_THREAD_LIVE_OVERLAY,
  environmentThreadLiveOverlayAtom,
  type ThreadLiveOverlayState,
} from "@t3tools/client-runtime/state/threads";
import { environmentThreadLiveOverlayViewAtom } from "../state/threads";
import type {
  OrchestrationV2SubagentLiveContent,
  ScopedThreadRef,
  TurnItemId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

const EMPTY_THREAD_LIVE_OVERLAY_ATOM = Atom.make(EMPTY_THREAD_LIVE_OVERLAY);

export function useThreadLiveOverlay(threadRef: ScopedThreadRef | null): {
  readonly overlay: ThreadLiveOverlayState;
  readonly rateLimited: boolean;
} {
  const overlay =
    useAtomValue(
      threadRef === null
        ? EMPTY_THREAD_LIVE_OVERLAY_ATOM
        : environmentThreadLiveOverlayViewAtom(threadRef.environmentId, threadRef.threadId),
    ) ?? EMPTY_THREAD_LIVE_OVERLAY;
  return { overlay, rateLimited: overlay.mode?.reason === "rate-limited" };
}

export function selectSubagentLiveContent(
  overlay: ThreadLiveOverlayState,
  input: {
    readonly active: boolean;
    readonly subagentId?: string | null | undefined;
    readonly turnItemId?: TurnItemId | null | undefined;
    readonly persisted?: OrchestrationV2SubagentLiveContent | null | undefined;
  },
): OrchestrationV2SubagentLiveContent | null {
  const { active, subagentId, turnItemId, persisted } = input;
  let liveContent: OrchestrationV2SubagentLiveContent | null = null;
  if (active && turnItemId != null) {
    const entry = overlay.subagentContentByTurnItemId.get(turnItemId);
    if (entry !== undefined && (subagentId == null || entry.subagentId === subagentId)) {
      liveContent = entry.liveContent;
    }
  } else if (active && subagentId != null) {
    for (const entry of overlay.subagentContentByTurnItemId.values()) {
      if (entry.subagentId === subagentId) {
        liveContent = entry.liveContent;
        break;
      }
    }
  }
  return liveContent ?? persisted ?? null;
}
export function useSubagentLiveContent(
  threadRef: ScopedThreadRef | null,
  input: {
    readonly active: boolean;
    readonly subagentId?: string | null | undefined;
    readonly turnItemId?: TurnItemId | null | undefined;
    readonly persisted?: OrchestrationV2SubagentLiveContent | null | undefined;
  },
): {
  readonly liveContent: OrchestrationV2SubagentLiveContent | null;
  readonly rateLimited: boolean;
} {
  const overlay =
    useAtomValue(
      threadRef === null
        ? EMPTY_THREAD_LIVE_OVERLAY_ATOM
        : environmentThreadLiveOverlayAtom(threadRef.environmentId, threadRef.threadId),
    ) ?? EMPTY_THREAD_LIVE_OVERLAY;
  return {
    liveContent: selectSubagentLiveContent(overlay, input),
    rateLimited: overlay.mode?.reason === "rate-limited",
  };
}

export function LiveViewPausedNote() {
  return <span className="text-3xs text-muted-foreground">Live view paused (too much data)</span>;
}
