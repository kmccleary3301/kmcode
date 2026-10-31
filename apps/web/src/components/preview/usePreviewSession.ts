"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  applyPreviewServerEvent,
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

class PreviewSessionThreadKeyParseError extends Schema.TaggedError<PreviewSessionThreadKeyParseError>()(
  "PreviewSessionThreadKeyParseError",
  { threadKey: Schema.String },
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  if (threadRef === null) {
    throw new PreviewSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const eventsAtom = previewEnvironment.events({
    environmentId: threadRef.environmentId,
    input: {},
  });

  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (!AsyncResult.isSuccess(result)) return;
      reconcilePreviewServerSessions(threadRef, result.value);
      if (!result.waiting && !readThreadPreviewState(threadRef).listLoaded) {
        // An event overtook the first list. Retry the authoritative baseline;
        // do not declare a partial event-only index ready for surface cleanup.
        queueMicrotask(() => {
          if (!disposed) get.refresh(sessionsAtom);
        });
      }
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      const currentEpoch = readThreadPreviewState(threadRef).serverEpoch;
      if (currentEpoch !== null && currentEpoch !== result.value.serverEpoch) {
        get.refresh(sessionsAtom);
        return;
      }
      applyPreviewServerEvent(threadRef, result.value);
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialEvent = get.once(eventsAtom);
    get.subscribe(sessionsAtom, (result) => {
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    get.mount(sessionsAtom);
    get.mount(eventsAtom);
    queueMicrotask(() => {
      if (disposed) return;
      // The cached list can predate an automation-created tab. Keep the local
      // snapshot visible until an authoritative refresh arrives instead of
      // reconciling against a stale empty result when the panel first mounts.
      get.refresh(sessionsAtom);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  useAtomValue(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}

// Discover background tabs without listing every thread at startup. Keep each
// sync while the thread has tabs so later events still arrive while chat is
// absent, then release it so closed previews stop costing a list and a fan-out.
const desktopHostedPreviewSyncAtom = Atom.family((environmentId: EnvironmentId) => {
  const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
  return Atom.make((get) => {
    const releaseByThreadId = new Map<string, () => void>();
    get.addFinalizer(() => {
      for (const release of releaseByThreadId.values()) release();
    });
    get.subscribe(
      eventsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result) || result.value.type === "closed") return;
        const threadId = result.value.threadId;
        if (releaseByThreadId.has(threadId)) return;
        const threadRef: ScopedThreadRef = {
          environmentId,
          threadId: ThreadId.make(threadId),
        };
        const threadKey = scopedThreadKey(threadRef);
        const unmount = get.registry.mount(previewSessionSyncAtom(threadKey));
        let hadSessions = false;
        let unwatch: () => void = () => undefined;
        const release = () => {
          unwatch();
          unmount();
          releaseByThreadId.delete(threadId);
        };
        unwatch = get.registry.subscribe(
          previewStateAtom(threadKey),
          (state) => {
            if (Object.keys(state.sessions).length > 0) hadSessions = true;
            else if (hadSessions && state.suppressedTabIds.size === 0) release();
          },
          { immediate: true },
        );
        releaseByThreadId.set(threadId, release);
      },
      { immediate: true },
    );
  }).pipe(
    Atom.setIdleTTL(1_000),
    Atom.withLabel(`preview:desktop-hosted-session-sync:${environmentId}`),
  );
});

export function useDesktopHostedPreviewSessions(environmentId: EnvironmentId): void {
  useAtomValue(desktopHostedPreviewSyncAtom(environmentId));
}
