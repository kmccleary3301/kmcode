import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  OMP_CHUNK_PAYLOAD_BYTES,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
  OmpChunkAssembler,
  OmpChunkError,
} from "./OmpChunkAssembler.ts";
import { makePiRpcConnection } from "./PiRpc.ts";
import { ompNativeChunkedTraceJsonl } from "../../../scripts/nativeTraceFixtures.ts";
import { OMP_DIALECT } from "../../provider/piDialect.ts";

const FAKE_PID = 999_999_999;

function expectProtocolError(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    assert.strictEqual(error instanceof OmpChunkError, true);
    if (error instanceof OmpChunkError) assert.strictEqual(error.code, code);
    return;
  }
  throw new Error(`Expected protocol error ${code}`);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

function chunkFrames(value: object, chunkId = "rpc-test"): Record<string, unknown>[] {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const frames: Record<string, unknown>[] = [];
  const count = Math.ceil(bytes.byteLength / OMP_CHUNK_PAYLOAD_BYTES);
  for (let index = 0; index < count; index += 1) {
    frames.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: encodeBase64(
        bytes.subarray(index * OMP_CHUNK_PAYLOAD_BYTES, (index + 1) * OMP_CHUNK_PAYLOAD_BYTES),
      ),
    });
  }
  return frames;
}

describe("OmpChunkAssembler", () => {
  it("reassembles base64 UTF-8 objects without replacement decoding", () => {
    const original = { type: "message_end", message: `π${"x".repeat(OMP_MAX_FRAME_BYTES)}` };
    const frames = chunkFrames(original);
    assert.isAtLeast(frames.length, 2);
    const assembler = new OmpChunkAssembler();
    for (const [index, frame] of frames.entries()) {
      const result = assembler.accept(frame);
      if (index < frames.length - 1) {
        assert.isUndefined(result);
      } else {
        assert.deepEqual(result, original);
      }
    }
    assert.strictEqual(assembler.pendingMessageCount, 0);
  });

  it("accepts a chunked frame smaller than the single-frame limit", () => {
    const original = { type: "response", command: "get_state", value: "small" };
    const bytes = new TextEncoder().encode(JSON.stringify(original));
    const split = Math.ceil(bytes.byteLength / 2);
    const frames = [bytes.subarray(0, split), bytes.subarray(split)].map((chunk, index) => ({
      type: "rpc_chunk",
      chunkId: "small-rpc-test",
      index,
      count: 2,
      byteLength: bytes.byteLength,
      data: encodeBase64(chunk),
    }));
    const assembler = new OmpChunkAssembler();
    assert.isUndefined(assembler.accept(frames[0]));
    assert.deepEqual(assembler.accept(frames[1]), original);
  });

  it("rejects interrupted, reordered, and identity-mismatched sequences", () => {
    const frames = chunkFrames({
      type: "response",
      command: "get_state",
      success: true,
      value: "x".repeat(OMP_MAX_FRAME_BYTES),
    });
    const assembler = new OmpChunkAssembler();

    // Start with non-zero index
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "rpc-test",
          index: 1,
          count: frames.length,
          byteLength: frames[0]!.byteLength,
          data: frames[0]!.data,
        }),
      "OMP_CHUNK_START",
    );

    // Accept first chunk
    assembler.accept(frames[0]!);

    // Next chunk with wrong index
    expectProtocolError(() => assembler.accept({ ...frames[1]!, index: 2 }), "OMP_CHUNK_SEQUENCE");

    // Next chunk with mismatched chunkId (interleaved)
    const interleavedAssembler = new OmpChunkAssembler();
    interleavedAssembler.accept(frames[0]!);
    expectProtocolError(
      () =>
        interleavedAssembler.accept({
          ...frames[1]!,
          chunkId: "different-chunk-id",
        }),
      "OMP_CHUNK_SEQUENCE",
    );
  });

  it("enforces metadata, decoded payload, and total-size limits", () => {
    const assembler = new OmpChunkAssembler();
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "x",
          index: 0,
          count: 2,
          byteLength: OMP_MAX_FRAME_BYTES,
          data: "not-base64-???",
        }),
      "OMP_CHUNK_DATA",
    );
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "x",
          index: 0,
          count: 1,
          byteLength: OMP_MAX_FRAME_BYTES,
          data: "eA==",
        }),
      "OMP_CHUNK_METADATA",
    );
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "x",
          index: 0,
          count: 2,
          byteLength: OMP_MAX_REASSEMBLED_BYTES + 1,
          data: "eA==",
        }),
      "OMP_CHUNK_METADATA",
    );
  });

  it("enforces the configured reassembled-message limit", () => {
    const assembler = new OmpChunkAssembler(4);
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "limited",
          index: 0,
          count: 2,
          byteLength: 5,
          data: encodeBase64(new Uint8Array([1])),
        }),
      "OMP_CHUNK_METADATA",
    );
  });

  it("clears pending state when reset", () => {
    const frames = chunkFrames({
      type: "response",
      command: "get_state",
      value: "x".repeat(OMP_MAX_FRAME_BYTES),
    });
    const assembler = new OmpChunkAssembler();
    assembler.accept(frames[0]!);
    assert.strictEqual(assembler.pendingMessageCount, 1);
    assembler.clear();
    assert.strictEqual(assembler.pendingMessageCount, 0);
  });
});

describe("OMP Protocol Negotiation and Chunked RPC in PiRpc", () => {
  it.effect("sets up chunk assembler on ready frame and reassembles chunked event records", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );

      const connection = yield* makePiRpcConnection({
        command: "omp",
        args: ["--mode", "rpc", "--no-session"],
        cwd: undefined,
        env: {},
        dialect: OMP_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      // Simulate OMP ready frame
      yield* push(
        JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }),
      );

      // Prepare a large event split into 2 chunks
      const largePayload = {
        type: "message_end",
        message: {
          role: "assistant",
          content: "Hello from OMP! " + "x".repeat(300_000),
        },
      };

      const chunks = chunkFrames(largePayload, "large-event-1");
      assert.strictEqual(chunks.length, 2);

      // First event on connection.events should be the ready frame
      const readyEvent = yield* Queue.take(connection.events);
      assert.strictEqual(readyEvent.type, "ready");

      // Push first chunk - should NOT emit to events yet
      yield* push(JSON.stringify(chunks[0]));
      const polled = yield* Queue.poll(connection.events);
      assert.isTrue(polled._tag === "None");

      // Push second chunk - should complete reassembly and emit to events
      yield* push(JSON.stringify(chunks[1]));
      const reassembledEvent = yield* Queue.take(connection.events);
      assert.deepEqual(reassembledEvent, largePayload);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("handles available_commands_update from OMP", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );

      const connection = yield* makePiRpcConnection({
        command: "omp",
        args: ["--mode", "rpc", "--no-session"],
        cwd: undefined,
        env: {},
        dialect: OMP_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      // Emit available_commands_update frame
      yield* push(
        JSON.stringify({
          type: "available_commands_update",
          commands: [
            { name: "review", description: "Review pending pull request", input: null },
            { name: "test", description: "Run automated tests", input: null },
          ],
        }),
      );

      // Event should be emitted to connection.events
      const event = yield* Queue.take(connection.events);
      assert.strictEqual(event.type, "available_commands_update");
      const lastCmds = connection.getAvailableCommands();
      assert.isDefined(lastCmds);
      const commandsList = (lastCmds as Record<string, unknown>).commands as ReadonlyArray<
        Record<string, unknown>
      >;
      assert.strictEqual(commandsList.length, 2);
      assert.strictEqual(commandsList[0]!.name, "review");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("replays recorded OMP chunked trace through OmpChunkAssembler", () => {
    const assembler = new OmpChunkAssembler();
    let events = 0;
    const lines = ompNativeChunkedTraceJsonl.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const frame = JSON.parse(trimmed) as Record<string, unknown>;
      const event = assembler.accept(frame) ?? frame;
      if (event === undefined) continue;
      events += 1;
    }
    assert.strictEqual(assembler.pendingMessageCount, 0);
    assert.isAbove(events, 0);
  });
});
