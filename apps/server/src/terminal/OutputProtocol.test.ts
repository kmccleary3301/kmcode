import { assert, describe, it } from "@effect/vitest";
import {
  TerminalAttachStreamEvent as TerminalAttachStreamEventSchema,
  WS_METHODS,
  type TerminalAttachStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

import { terminalOutputStream, withTerminalOutputWindow } from "./OutputProtocol.ts";

const eventWith = (
  field: "data" | "message" | "threadId",
  text: string,
): TerminalAttachStreamEvent =>
  field === "message"
    ? { threadId: "thread-1", terminalId: "term-1", type: "error", message: text }
    : {
        threadId: field === "threadId" ? text : "thread-1",
        terminalId: "term-1",
        type: "output",
        data: field === "data" ? text : "x",
      };

describe("terminal output window", () => {
  it.effect.each([
    { tag: WS_METHODS.terminalAttach, field: "data", size: 1, limit: 8 },
    { tag: WS_METHODS.terminalObserve, field: "data", size: 1, limit: 8 },
    { tag: WS_METHODS.subscribeTerminalEvents, field: "data", size: 1, limit: 8 },
    { tag: WS_METHODS.terminalAttach, field: "data", size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.terminalAttach, field: "message", size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.terminalAttach, field: "threadId", size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.subscribeTerminalMetadata, field: "data", size: 1, limit: 1 },
  ] as const)(
    "limits $tag with $size-byte $field values to $limit pending chunks",
    ({ tag, field, size, limit }) =>
      Effect.gen(function* () {
        const group = RpcGroup.make(
          Rpc.make(tag, { success: TerminalAttachStreamEventSchema, stream: true }),
        );
        const output = yield* Queue.unbounded<TerminalAttachStreamEvent>();
        const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
        const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
        const protocol = yield* RpcServer.Protocol.make((write) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(receive, write);
            const serialization = yield* RpcSerialization.RpcSerialization;
            return {
              disconnects: yield* Queue.unbounded<number>(),
              send: (_clientId, response) => Queue.offer(responses, response),
              end: () => Effect.void,
              clientIds: Effect.succeed(new Set([0])),
              initialMessage: Effect.succeedNone,
              supportsAck: true,
              supportsTransferables: false,
              supportsSpanPropagation: false,
              supportsNotifications: true,
              codecFor: serialization.codecFor,
            };
          }),
        );
        yield* RpcServer.make(group).pipe(
          Effect.provide(group.toLayerHandler(tag, () => Stream.fromQueue(output))),
          Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
          Effect.forkScoped,
        );
        const write = yield* Deferred.await(receive);
        yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });

        for (let index = 0; index < limit; index++) {
          const value = eventWith(field, String(index).repeat(size));
          yield* Queue.offer(output, value);
          yield* TestClock.adjust(0);
          assert.equal(yield* Queue.size(responses), 1);
          assert.deepEqual(yield* Queue.take(responses), {
            _tag: "Chunk",
            requestId: "1",
            values: [value],
          });
        }
        const resumedValue = eventWith(field, "i".repeat(size));
        yield* Queue.offer(output, resumedValue);
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 0);
        yield* write(0, { _tag: "Ack", requestId: "1" });
        const resumed = yield* Queue.take(responses);
        assert.equal(resumed._tag, "Chunk");
        if (resumed._tag === "Chunk") assert.deepEqual(resumed.values, [resumedValue]);

        yield* Queue.offer(output, eventWith(field, "j"));
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 0);
        yield* write(0, { _tag: "Interrupt", requestId: "1" });
        assert.equal((yield* Queue.take(responses))._tag, "Exit");
      }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );
});

const output = (data: string): TerminalAttachStreamEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "term-1",
  data,
});

const snapshot = (history: string): TerminalAttachStreamEvent => ({
  type: "snapshot",
  snapshot: {
    threadId: "thread-1",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    label: "bash",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

type TerminalTestListener = (event: TerminalAttachStreamEvent) => Effect.Effect<void>;
type TerminalTestPublisher = {
  readonly listeners: Set<TerminalTestListener>;
  readonly subscribe: (
    listener: TerminalTestListener,
    registerCleanup: (stop: () => void) => void,
  ) => Effect.Effect<() => void>;
  readonly publish: (event: TerminalAttachStreamEvent) => Effect.Effect<void>;
};

const makePublisher = (): TerminalTestPublisher => {
  const listeners = new Set<TerminalTestListener>();
  return {
    listeners,
    subscribe: (listener: TerminalTestListener, registerCleanup: (stop: () => void) => void) =>
      Effect.sync(() => {
        listeners.add(listener);
        const stop = () => {
          listeners.delete(listener);
        };
        registerCleanup(stop);
        return stop;
      }),
    publish: (event: TerminalAttachStreamEvent) =>
      Effect.forEach([...listeners], (listener) => listener(event), { discard: true }),
  };
};

const attach =
  (publisher: TerminalTestPublisher, history: string) =>
  (
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    registerCleanup: (stop: () => void) => void,
  ) =>
    publisher
      .subscribe(listener, registerCleanup)
      .pipe(Effect.tap(() => listener(snapshot(history))));

describe("terminal output stream", () => {
  it.effect("resyncs a lagging subscriber without retaining its queued output", () =>
    Effect.gen(function* () {
      const publisher = makePublisher();
      const laggingPull = yield* Stream.toPull(
        terminalOutputStream(attach(publisher, ""), attach(publisher, "current terminal history")),
      );
      const healthyPull = yield* Stream.toPull(
        terminalOutputStream(attach(publisher, "healthy subscriber")),
      );

      assert.deepEqual(yield* laggingPull, [snapshot("")]);
      assert.deepEqual(yield* healthyPull, [snapshot("healthy subscriber")]);
      assert.equal(publisher.listeners.size, 2);

      for (let index = 0; index < 9; index += 1) {
        const event = output("x".repeat(1024 * 1024));
        yield* publisher.publish(event);
        assert.deepEqual(yield* healthyPull, [event]);
      }
      assert.equal(publisher.listeners.size, 1);

      assert.deepEqual(yield* laggingPull, [snapshot("current terminal history")]);
      assert.equal(publisher.listeners.size, 2);
      const afterResync = output("current output");
      yield* publisher.publish(afterResync);
      assert.deepEqual(yield* healthyPull, [afterResync]);
      assert.deepEqual(yield* laggingPull, [afterResync]);
    }).pipe(Effect.scoped),
  );
});
