import { type TerminalAttachStreamEvent, type TerminalEvent, WS_METHODS } from "@t3tools/contracts";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";
import type { RpcServer } from "effect/rpc";

const MAX_PENDING_CHUNKS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
// Charge an envelope so tiny events cannot bypass the byte budget.
const EVENT_OVERHEAD = 128;

const byteLengthOf = (value: unknown) => (typeof value === "string" ? Buffer.byteLength(value) : 0);
const queuedSize = (value: unknown) => {
  if (typeof value !== "object" || value === null) return EVENT_OVERHEAD;
  let size = EVENT_OVERHEAD;
  if ("threadId" in value) size += byteLengthOf(value.threadId);
  if ("terminalId" in value) size += byteLengthOf(value.terminalId);
  if ("data" in value) size += byteLengthOf(value.data);
  if ("message" in value) size += byteLengthOf(value.message);
  if ("label" in value) size += byteLengthOf(value.label);
  if ("snapshot" in value && typeof value.snapshot === "object" && value.snapshot !== null) {
    const snapshot = value.snapshot;
    if ("threadId" in snapshot) size += byteLengthOf(snapshot.threadId);
    if ("terminalId" in snapshot) size += byteLengthOf(snapshot.terminalId);
    if ("history" in snapshot) size += byteLengthOf(snapshot.history);
    if ("cwd" in snapshot) size += byteLengthOf(snapshot.cwd);
    if ("worktreePath" in snapshot) size += byteLengthOf(snapshot.worktreePath);
    if ("label" in snapshot) size += byteLengthOf(snapshot.label);
  }
  return size;
};
const chunkSize = (values: ReadonlyArray<unknown>) =>
  values.reduce<number>((total, value) => total + queuedSize(value), EVENT_OVERHEAD);
const isFull = (sizes: number[], maxChunks = MAX_PENDING_CHUNKS) =>
  sizes.length >= maxChunks || sizes.reduce((total, size) => total + size, 0) >= MAX_PENDING_BYTES;

export function withTerminalOutputWindow(
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] {
  const windows = new Map<string, { readonly maxChunks: number; readonly sizes: number[] }>();
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (
            message._tag === "Request" &&
            (message.tag === WS_METHODS.terminalAttach ||
              message.tag === WS_METHODS.terminalObserve ||
              message.tag === WS_METHODS.subscribeTerminalEvents ||
              message.tag === WS_METHODS.subscribeTerminalMetadata)
          ) {
            const key = `${clientId}:${message.id}`;
            if (!windows.has(key)) {
              windows.set(key, {
                maxChunks:
                  message.tag === WS_METHODS.subscribeTerminalMetadata ? 1 : MAX_PENDING_CHUNKS,
                sizes: [],
              });
            }
          } else if (message._tag === "Ack") {
            const window = windows.get(`${clientId}:${message.requestId}`);
            if (window) {
              const wasFull = isFull(window.sizes, window.maxChunks);
              window.sizes.shift();
              if (!wasFull || isFull(window.sizes, window.maxChunks)) return Effect.void;
            }
          }
          return write(clientId, message);
        }),
      );
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        const send = protocol.send(clientId, response, transferables);
        if (response._tag === "Exit") {
          windows.delete(`${clientId}:${response.requestId}`);
        } else if (response._tag === "Chunk") {
          const window = windows.get(`${clientId}:${response.requestId}`);
          if (window) {
            window.sizes.push(chunkSize(response.values));
            if (!isFull(window.sizes, window.maxChunks)) {
              return send.pipe(
                Effect.andThen(() =>
                  receive(clientId, {
                    _tag: "Ack",
                    requestId: response.requestId,
                  }),
                ),
              );
            }
          }
        }
        return send;
      }),
  };
}

const MAX_QUEUED_OUTPUT = 8 * 1024 * 1024;
type Listener<A> = (event: A) => Effect.Effect<void>;

// Acquisition must register cleanup synchronously with installing the listener.
type Subscribe<A, E> = (
  listener: Listener<A>,
  registerCleanup: (stop: () => void) => void,
) => Effect.Effect<() => void, E>;

export function terminalOutputStream<A extends TerminalEvent | TerminalAttachStreamEvent, E>(
  subscribe: Subscribe<A, E>,
  resync?: Subscribe<A, E>,
  maxQueued = MAX_QUEUED_OUTPUT,
): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Latch.make();
      let pending: Array<A | undefined> = [];
      let sizes: number[] = [];
      let head = 0;
      let queued = 0;
      let overflowed = false;
      let subscription = 0;
      let unsubscribe: (() => void) | null = null;
      const release = () => {
        subscription += 1;
        unsubscribe?.();
        unsubscribe = null;
        pending = [];
        sizes = [];
        head = 0;
        queued = 0;
      };
      yield* Effect.addFinalizer(() => Effect.sync(release));

      const listen = (from: Subscribe<A, E>) =>
        Effect.suspend(() => {
          const id = ++subscription;
          return from(
            (event) =>
              Effect.sync(() => {
                if (id !== subscription) return;
                const size = queuedSize(event);
                pending.push(event);
                sizes.push(size);
                queued += size;
                // A single snapshot must fit even when history fills the budget.
                if (queued - sizes[head]! > maxQueued) {
                  release();
                  overflowed = true;
                }
                ready.openUnsafe();
              }),
            (stop) => {
              // Overflow or cancellation may invalidate acquisition before registration.
              if (id === subscription) unsubscribe = stop;
              else stop();
            },
          ).pipe(
            Effect.asVoid,
            Effect.onError(() => Effect.sync(release)),
          );
        });

      const take = () => {
        const event = pending[head]!;
        pending[head] = undefined;
        head += 1;
        return event;
      };
      const takeBatch = (): Arr.NonEmptyReadonlyArray<A> => {
        let bytes = sizes[head]!;
        const batch: [A, ...A[]] = [take()];
        while (head < pending.length && bytes + sizes[head]! <= MAX_PENDING_BYTES) {
          bytes += sizes[head]!;
          batch.push(take());
        }
        queued -= bytes;
        if (head * 2 >= pending.length) {
          pending = pending.slice(head);
          sizes = sizes.slice(head);
          head = 0;
        }
        return batch;
      };

      const pull: Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E | Cause.Done> = Effect.suspend(
        () => {
          if (overflowed) {
            overflowed = false;
            return resync ? listen(resync).pipe(Effect.andThen(pull)) : Cause.done();
          }
          if (head < pending.length) return Effect.succeed(takeBatch());
          ready.closeUnsafe();
          return ready.await.pipe(Effect.andThen(pull));
        },
      );

      yield* listen(subscribe);
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
}
