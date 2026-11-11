import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadActivityPageRequest } from "./threadActivityMerge.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadHistoryController from "./threadHistoryController.ts";

const ENV = "env-history" as EnvironmentId;
const THREAD = "thread-history" as ThreadId;

function handler(tag: string): ThreadHistoryController.ThreadHistoryHandler & {
  readonly tag: string;
  readonly calls: number;
  readonly historyTargets: ReadonlyArray<string | undefined>;
  readonly activityRequests: ReadonlyArray<ThreadActivityPageRequest>;
} {
  const state: {
    tag: string;
    calls: number;
    historyTargets: Array<string | undefined>;
    activityRequests: ThreadActivityPageRequest[];
  } = { tag, calls: 0, historyTargets: [], activityRequests: [] };
  return {
    get tag() {
      return state.tag;
    },
    get calls() {
      return state.calls;
    },
    get activityRequests() {
      return state.activityRequests;
    },
    get historyTargets() {
      return state.historyTargets;
    },
    loadEarlier: (throughEntryId) => {
      state.calls += 1;
      state.historyTargets.push(throughEntryId);
      return Effect.succeed({
        _tag: "loaded",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult);
    },
    loadActivityPage: (request) => {
      state.activityRequests.push(request);
      return Effect.succeed({
        _tag: "loaded",
      } satisfies ThreadHistoryController.ThreadActivityLoadResult);
    },
  };
}

describe("ThreadHistoryController", () => {
  it.effect("does not let an older finalizer delete a newer registration", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController.ThreadHistoryController;
      const older = handler("older");
      const newer = handler("newer");

      const olderRegistration = yield* controller.register(ENV, THREAD, older);
      const newerRegistration = yield* controller.register(ENV, THREAD, newer);

      // Older fiber finalizes after the newer handler is already registered.
      yield* controller.unregister(olderRegistration);

      const result = yield* controller.loadEarlier(ENV, THREAD);
      expect(result).toEqual({ _tag: "loaded" });
      expect(yield* controller.loadEarlier(ENV, THREAD, "direct-entry")).toEqual({
        _tag: "loaded",
      });
      expect(newer.calls).toBe(2);
      expect(newer.historyTargets).toEqual([undefined, "direct-entry"]);
      expect(older.calls).toBe(0);
      yield* controller.unregister(newerRegistration);
      expect(yield* controller.loadEarlier(ENV, THREAD)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(ThreadHistoryController.layer)),
  );

  it.effect("dispatches an indexed activity request to the registered thread", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController.ThreadHistoryController;
      const activity = handler("activity");
      const registration = yield* controller.register(ENV, THREAD, activity);
      const request = {
        sourceThreadId: THREAD,
        groupStartItemId: "group-start" as never,
        anchorItemId: "item-target" as never,
      } satisfies ThreadActivityPageRequest;

      expect(yield* controller.loadActivityPage(ENV, THREAD, request)).toEqual({
        _tag: "loaded",
      });
      expect(activity.activityRequests).toEqual([request]);

      yield* controller.unregister(registration);
      expect(yield* controller.loadActivityPage(ENV, THREAD, request)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(Layer.fresh(ThreadHistoryController.layer))),
  );

  it.effect("unregister removes only its own matching registration", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController.ThreadHistoryController;
      const first = handler("first");
      const registration = yield* controller.register(ENV, THREAD, first);
      yield* controller.unregister(registration);
      expect(yield* controller.loadEarlier(ENV, THREAD)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(Layer.fresh(ThreadHistoryController.layer))),
  );
});
