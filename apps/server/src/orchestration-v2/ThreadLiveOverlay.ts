import type { OrchestrationV2ThreadLiveItem, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";

const VIEWER_LINGER = Duration.seconds(15);
const LIVE_ITEM_BUFFER = 64;

interface ThreadState {
  readonly items: PubSub.PubSub<OrchestrationV2ThreadLiveItem>;
  readonly viewed: SubscriptionRef.SubscriptionRef<boolean>;
  readonly viewerCount: number;
  readonly observerCount: number;
  readonly isViewed: boolean;
  readonly lingerGeneration: number;
  readonly lingerFiber: Fiber.Fiber<void, never> | null;
}

export interface ThreadLiveOverlayServiceShape {
  /** Register a live viewer until the supplied scope closes. */
  readonly view: (threadId: ThreadId) => Effect.Effect<void, never, Scope.Scope>;
  /** Best-effort live items; this stream is not replayable. */
  readonly items: (threadId: ThreadId) => Stream.Stream<OrchestrationV2ThreadLiveItem>;
  /** Drop live items unless at least one viewer is currently registered. */
  readonly publish: (
    threadId: ThreadId,
    item: OrchestrationV2ThreadLiveItem,
  ) => Effect.Effect<void>;
  /** Emits the current viewing state followed by changes. */
  readonly viewed: (threadId: ThreadId) => Stream.Stream<boolean>;
}

export class ThreadLiveOverlay extends Context.Service<
  ThreadLiveOverlay,
  ThreadLiveOverlayServiceShape
>()("t3/orchestration-v2/ThreadLiveOverlay") {}

export const layer: Layer.Layer<ThreadLiveOverlay> = Layer.effect(
  ThreadLiveOverlay,
  Effect.gen(function* () {
    const serviceScope = yield* Effect.scope;
    const states = yield* SynchronizedRef.make(new Map<ThreadId, ThreadState>());

    const makeThreadState = Effect.gen(function* () {
      const items = yield* PubSub.sliding<OrchestrationV2ThreadLiveItem>(LIVE_ITEM_BUFFER);
      const viewed = yield* SubscriptionRef.make(false);
      return {
        items,
        viewed,
        viewerCount: 0,
        observerCount: 0,
        isViewed: false,
        lingerGeneration: 0,
        lingerFiber: null,
      } satisfies ThreadState;
    });

    const acquireWatcher = (threadId: ThreadId) =>
      SynchronizedRef.modifyEffect(states, (current) => {
        const existing = current.get(threadId);
        const ensureState = existing === undefined ? makeThreadState : Effect.succeed(existing);
        return ensureState.pipe(
          Effect.map((state) => {
            const watchedState = { ...state, observerCount: state.observerCount + 1 };
            const next = new Map(current);
            next.set(threadId, watchedState);
            return [watchedState, next] as const;
          }),
        );
      });

    const canRemoveState = (state: ThreadState) =>
      state.viewerCount === 0 && state.observerCount === 0 && state.lingerFiber === null;

    const shutdownState = (state: ThreadState) =>
      Effect.all([PubSub.shutdown(state.items), PubSub.shutdown(state.viewed.pubsub)], {
        discard: true,
      });

    const releaseWatcher = (threadId: ThreadId) =>
      SynchronizedRef.modifyEffect(states, (current) => {
        const state = current.get(threadId);
        if (state === undefined || state.observerCount === 0) {
          return Effect.succeed([undefined, current] as const);
        }
        const nextState = { ...state, observerCount: state.observerCount - 1 };
        const next = new Map(current);
        if (canRemoveState(nextState)) {
          next.delete(threadId);
          return shutdownState(state).pipe(Effect.as([undefined, next] as const));
        }
        next.set(threadId, nextState);
        return Effect.succeed([undefined, next] as const);
      });

    const expireLinger = (threadId: ThreadId, generation: number) =>
      Effect.sleep(VIEWER_LINGER).pipe(
        Effect.andThen(
          SynchronizedRef.modifyEffect(states, (current) => {
            const state = current.get(threadId);
            if (
              state === undefined ||
              state.viewerCount > 0 ||
              state.lingerGeneration !== generation ||
              !state.isViewed
            ) {
              return Effect.succeed([undefined, current] as const);
            }
            if (state.observerCount === 0) {
              const next = new Map(current);
              next.delete(threadId);
              return shutdownState(state).pipe(Effect.as([undefined, next] as const));
            }
            return SubscriptionRef.set(state.viewed, false).pipe(
              Effect.map(() => {
                const next = new Map(current);
                next.set(threadId, {
                  ...state,
                  isViewed: false,
                  lingerFiber: null,
                });
                return [undefined, next] as const;
              }),
            );
          }),
        ),
      );

    const cancelLinger = (fiber: Fiber.Fiber<void, never> | null) =>
      fiber === null
        ? Effect.void
        : Fiber.interrupt(fiber).pipe(Effect.forkIn(serviceScope), Effect.asVoid);

    const registerViewer = (threadId: ThreadId) =>
      SynchronizedRef.modifyEffect(states, (current) => {
        const existing = current.get(threadId);
        const ensureState = existing === undefined ? makeThreadState : Effect.succeed(existing);
        return Effect.gen(function* () {
          const state = yield* ensureState;
          yield* cancelLinger(state.lingerFiber);
          if (!state.isViewed) yield* SubscriptionRef.set(state.viewed, true);
          const next = new Map(current);
          const nextState: ThreadState = {
            ...state,
            viewerCount: state.viewerCount + 1,
            isViewed: true,
            lingerGeneration: state.lingerGeneration + 1,
            lingerFiber: null,
          };
          next.set(threadId, nextState);
          return [undefined, next] as const;
        });
      });

    const releaseViewer = (threadId: ThreadId) =>
      SynchronizedRef.modifyEffect(states, (current) => {
        const state = current.get(threadId);
        if (state === undefined || state.viewerCount === 0) {
          return Effect.succeed([undefined, current] as const);
        }
        if (state.viewerCount > 1) {
          const next = new Map(current);
          next.set(threadId, { ...state, viewerCount: state.viewerCount - 1 });
          return Effect.succeed([undefined, next] as const);
        }
        const generation = state.lingerGeneration + 1;
        return Effect.gen(function* () {
          yield* cancelLinger(state.lingerFiber);
          const lingerFiber = yield* Effect.forkIn(expireLinger(threadId, generation), serviceScope);
          const next = new Map(current);
          next.set(threadId, {
            ...state,
            viewerCount: 0,
            lingerGeneration: generation,
            lingerFiber,
          });
          return [undefined, next] as const;
        });
      });

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.get(states).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(
            current.values(),
            (state) =>
              Effect.gen(function* () {
                yield* cancelLinger(state.lingerFiber);
                yield* PubSub.shutdown(state.items);
                yield* PubSub.shutdown(state.viewed.pubsub);
              }),
            { discard: true },
          ),
        ),
      ),
    );

    return ThreadLiveOverlay.of({
      view: (threadId) =>
        Effect.gen(function* () {
          yield* registerViewer(threadId);
          yield* Effect.addFinalizer(() => releaseViewer(threadId));
        }),
      items: (threadId) =>
        Stream.unwrap(
          acquireWatcher(threadId).pipe(
            Effect.map((state) =>
              Stream.fromPubSub(state.items).pipe(Stream.ensuring(releaseWatcher(threadId))),
            ),
          ),
        ),
      publish: (threadId, item) =>
        SynchronizedRef.get(states).pipe(
          Effect.flatMap((current) => {
            const state = current.get(threadId);
            return state === undefined || state.viewerCount === 0
              ? Effect.void
              : PubSub.publish(state.items, item).pipe(Effect.asVoid);
          }),
        ),
      viewed: (threadId) =>
        Stream.unwrap(
          acquireWatcher(threadId).pipe(
            Effect.map((state) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(state.viewed.pubsub);
                  const initial = yield* SubscriptionRef.get(state.viewed);
                  return Stream.concat(
                    Stream.make(initial),
                    Stream.fromSubscription(subscription),
                  );
                }),
              ).pipe(
                Stream.scoped,
                Stream.ensuring(releaseWatcher(threadId)),
              ),
            ),
          ),
        ),
    });
  }),
);
