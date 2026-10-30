import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  NodeId,
  OmpSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ThreadLiveOverlay from "../ThreadLiveOverlay.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { makePiAdapterV2, type PiAdapterV2Options } from "./PiAdapterV2.ts";

import {
  OMP_CHUNK_PAYLOAD_BYTES,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
  OmpChunkAssembler,
  OmpChunkError,
} from "./OmpChunkAssembler.ts";
import { makePiRpcConnection } from "./PiRpc.ts";
import { piToolTurnItemFields } from "./PiToolTurnItem.ts";
import {
  ompNativeChunkedTraceJsonl,
  ompRecordedNativeTrace,
} from "../../../scripts/nativeTraceFixtures.ts";
import { OMP_DIALECT, PI_DIALECT } from "../../provider/piDialect.ts";

const FAKE_PID = 999_999_999;

describe("Pi tool turn item intents", () => {
  it("keeps OMP intent on command and file items and omits missing or blank intent", () => {
    const bash = piToolTurnItemFields({
      toolName: "bash",
      args: { command: "git status", i: "  Inspect repository status  " },
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.equal(bash.type, "command_execution");
    assert.equal(bash.intent, "Inspect repository status");
    const explicit = piToolTurnItemFields({
      toolName: "bash",
      args: { command: "git status", i: "Args fallback" },
      intent: "  Tool-start intent  ",
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.equal(explicit.intent, "Tool-start intent");

    const edit = piToolTurnItemFields({
      toolName: "edit",
      args: { path: "src/main.ts", i: "  Update main module  " },
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.equal(edit.type, "file_change");
    assert.equal(edit.intent, "Update main module");

    const missing = piToolTurnItemFields({
      toolName: "bash",
      args: { command: "pwd" },
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.isFalse(Object.hasOwn(missing, "intent"));

    const blank = piToolTurnItemFields({
      toolName: "bash",
      args: { command: "pwd", i: " \t " },
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.isFalse(Object.hasOwn(blank, "intent"));

    const device = piToolTurnItemFields({
      toolName: "write",
      args: {
        path: "xd://mcp__example__lookup",
        content: "{}",
        i: "  Invoke mounted tool  ",
      },
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.equal(device.type, "dynamic_tool");
    assert.equal(device.intent, "Invoke mounted tool");

    const fallback = piToolTurnItemFields({
      toolName: "custom",
      args: { i: " \t ", _i: "  Invoke custom tool  " },
      outputText: "",
      details: undefined,
      isError: false,
    });
    assert.equal(fallback.type, "dynamic_tool");
    assert.equal(fallback.intent, "Invoke custom tool");
  });
});

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
      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      yield* push(
        JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }),
      );

      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.gen(function* () {
                const text = new TextDecoder().decode(chunk);
                for (const line of text.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed.length === 0) continue;
                  const record = JSON.parse(trimmed) as Record<string, unknown>;
                  if (record["type"] === "negotiate_protocol") {
                    yield* push(
                      JSON.stringify({
                        id: record["id"],
                        type: "response",
                        command: "negotiate_protocol",
                        success: true,
                      }),
                    );
                  }
                }
              }),
            ),
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
      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      yield* push(
        JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }),
      );

      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.gen(function* () {
                const text = new TextDecoder().decode(chunk);
                for (const line of text.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed.length === 0) continue;
                  const record = JSON.parse(trimmed) as Record<string, unknown>;
                  if (record["type"] === "negotiate_protocol") {
                    yield* push(
                      JSON.stringify({
                        id: record["id"],
                        type: "response",
                        command: "negotiate_protocol",
                        success: true,
                      }),
                    );
                  }
                }
              }),
            ),
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

      const readyEvent = yield* Queue.take(connection.events);
      assert.strictEqual(readyEvent.type, "ready");
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

  it.effect(
    "reassembles v2 large catalog response on immediate caller request when ready frame is delayed",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        let negotiatedVersion = 1;

        const largeCatalog = {
          models: Array.from({ length: 40 }, (_, index) => ({
            id: `omp-provider/model-${index}`,
            name: `Model ${index}`,
            description: "x".repeat(30_000),
          })),
        };

        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (record["type"] === "negotiate_protocol") {
                      if (record["protocolVersion"] === 2) {
                        negotiatedVersion = 2;
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: "negotiate_protocol",
                          success: true,
                        }),
                      );
                    } else if (record["type"] === "get_available_models") {
                      if (negotiatedVersion < 2) {
                        yield* push(
                          JSON.stringify({
                            id: record["id"],
                            type: "response",
                            command: "get_available_models",
                            success: false,
                            error: "RPC response exceeded the transport limit",
                          }),
                        );
                      } else {
                        const responseRecord = {
                          id: record["id"],
                          type: "response",
                          command: "get_available_models",
                          success: true,
                          data: largeCatalog,
                        };
                        const chunks = chunkFrames(responseRecord, "catalog-chunks-1");
                        assert.isAtLeast(chunks.length, 2);
                        for (const chunk of chunks) {
                          yield* push(JSON.stringify(chunk));
                        }
                      }
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        // Subprocess fixture delays ready frame emission
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(30)).pipe(
              Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
            );
            yield* push(
              JSON.stringify({
                type: "ready",
                protocolVersion: 1,
                supportedProtocolVersions: [1, 2],
                maxFrameBytes: 1048576,
                maxReassembledFrameBytes: 67108864,
              }),
            );
          }),
        );

        // Caller immediately connects and requests large catalog
        const connection = yield* makePiRpcConnection({
          command: "omp",
          args: ["--mode", "rpc", "--no-session"],
          cwd: undefined,
          env: {},
          dialect: OMP_DIALECT,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        const catalog = yield* connection.request({ type: "get_available_models" });
        assert.deepEqual(catalog, largeCatalog);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails boundedly when protocol negotiation is rejected by OMP", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      yield* push(
        JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
        }),
      );

      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.gen(function* () {
                const text = new TextDecoder().decode(chunk);
                for (const line of text.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed.length === 0) continue;
                  const record = JSON.parse(trimmed) as Record<string, unknown>;
                  if (record["type"] === "negotiate_protocol") {
                    yield* push(
                      JSON.stringify({
                        id: record["id"],
                        type: "response",
                        command: "negotiate_protocol",
                        success: false,
                        error: "protocol 2 unsupported",
                      }),
                    );
                  }
                }
              }),
            ),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );

      const error = yield* makePiRpcConnection({
        command: "omp",
        args: ["--mode", "rpc", "--no-session"],
        cwd: undefined,
        env: {},
        dialect: OMP_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip);

      assert.strictEqual(error._tag, "PiRpcError");
      assert.strictEqual(error.operation, "negotiate_protocol");
      assert.include(error.detail ?? "", "protocol 2 unsupported");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects connection with PiRpcError when OMP advertises only protocol version 1", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      yield* push(
        JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1],
        }),
      );

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

      const error = yield* makePiRpcConnection({
        command: "omp",
        args: ["--mode", "rpc", "--no-session"],
        cwd: undefined,
        env: {},
        dialect: OMP_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip);

      assert.strictEqual(error._tag, "PiRpcError");
      assert.strictEqual(error.operation, "negotiate_protocol");
      assert.include(error.detail ?? "", "OMP did not advertise protocol version 2");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails boundedly when OMP exits early before ready", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );

      const error = yield* makePiRpcConnection({
        command: "omp",
        args: ["--mode", "rpc", "--no-session"],
        cwd: undefined,
        env: {},
        dialect: OMP_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip);

      assert.strictEqual(error._tag, "PiRpcError");
      assert.include(error.detail ?? "", "exited with code 1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves upstream Pi behavior without waiting for ready frame", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.gen(function* () {
                const text = new TextDecoder().decode(chunk);
                for (const line of text.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed.length === 0) continue;
                  const record = JSON.parse(trimmed) as Record<string, unknown>;
                  if (record["type"] === "get_state") {
                    yield* push(
                      JSON.stringify({
                        id: record["id"],
                        type: "response",
                        command: "get_state",
                        success: true,
                        data: { sessionFile: "/tmp/pi-session.jsonl" },
                      }),
                    );
                  }
                }
              }),
            ),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );

      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
        dialect: PI_DIALECT,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const state = yield* connection.request({ type: "get_state" });
      assert.deepEqual(state, { sessionFile: "/tmp/pi-session.jsonl" });
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

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-omp-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  layerServerConfig,
  ThreadLiveOverlay.layer,
);

const makeOmpAdapter = (options: Omit<PiAdapterV2Options, "threadLiveOverlay">) =>
  Effect.gen(function* () {
    const threadLiveOverlay = yield* ThreadLiveOverlay.ThreadLiveOverlay;
    return makePiAdapterV2({ ...options, threadLiveOverlay });
  });

const OMP_INSTANCE_ID = ProviderInstanceId.make("omp");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("provider-session-omp-test");

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: OMP_INSTANCE_ID,
  model,
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-omp-test"),
    title: "OMP Thread",
    providerInstanceId: OMP_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/tmp",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Explain ParadeDB FTS",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

describe("OMP Protocol v2 Turn and Subagent Completion", () => {
  it.effect(
    "finalizes turn on agent_end isTerminal and marks subagent completed from captured trace",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        // OMP protocol v2 ready frame
        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      for (const frame of ompRecordedNativeTrace) {
                        yield* push(JSON.stringify(frame));
                      }
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);

        let terminalEvent: ProviderAdapterV2Event | undefined;
        let subagentCompleted = false;

        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated" && event.subagent.status === "completed") {
            subagentCompleted = true;
          }
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }

        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        if (terminalEvent?.type === "turn.terminal") {
          assert.strictEqual(terminalEvent.status, "completed");
        }
        assert.isTrue(subagentCompleted);

        const resumed = yield* runtime.resumeThread({ providerThread });
        assert.strictEqual(resumed.status, "idle");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "tracks OMP async subagent jobs, preserves authoritative native durations, and handles new activation reopen",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                        };
                      } else if (record["type"] === "negotiate_protocol") {
                        responseData = undefined;
                      } else if (record["type"] === "get_entries") {
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      } else if (
                        record["type"] === "switch_session" ||
                        record["type"] === "new_session"
                      ) {
                        responseData = { cancelled: false };
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      // 1. Task spawn: tool_execution_start then tool_execution_end with details.async and details.progress
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "task-spawn-1",
                          toolName: "task",
                          args: {
                            tasks: [
                              {
                                id: "WrapperLedger",
                                label: "WrapperLedger",
                                task: "WrapperLedger",
                              },
                              { id: "GymLedger", label: "GymLedger", task: "GymLedger" },
                              { id: "SwapHistory", label: "SwapHistory", task: "SwapHistory" },
                              {
                                id: "ReliabilityEvidence",
                                label: "ReliabilityEvidence",
                                task: "ReliabilityEvidence",
                              },
                            ],
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "task-spawn-1",
                          toolName: "task",
                          result: {
                            content: [{ type: "text", text: "Spawned 4 background agents" }],
                            details: {
                              async: { state: "running", jobId: "task-spawn-1", type: "task" },
                              progress: [
                                {
                                  id: "WrapperLedger",
                                  label: "WrapperLedger",
                                  status: "pending",
                                  durationMs: 0,
                                  index: 0,
                                },
                                {
                                  id: "GymLedger",
                                  label: "GymLedger",
                                  status: "pending",
                                  durationMs: 0,
                                  index: 1,
                                },
                                {
                                  id: "SwapHistory",
                                  label: "SwapHistory",
                                  status: "pending",
                                  durationMs: 0,
                                  index: 2,
                                },
                                {
                                  id: "ReliabilityEvidence",
                                  label: "ReliabilityEvidence",
                                  agent: "fallback-scout",
                                  status: "pending",
                                  durationMs: 0,
                                  index: 3,
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 2. First wait result at 20:50:52.836Z: ReliabilityEvidence completes (214604ms), 3 still running
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "wait-1",
                          toolName: "wait",
                          args: {},
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "wait-1",
                          toolName: "wait",
                          result: {
                            content: [{ type: "text", text: "Completed 1" }],
                            details: {
                              jobs: [
                                {
                                  id: "WrapperLedger",
                                  label: "WrapperLedger",
                                  status: "running",
                                  durationMs: 214605,
                                  resolvedModel: "google-antigravity/gemini-3.8-flash:high",
                                },
                                {
                                  id: "GymLedger",
                                  label: "GymLedger",
                                  status: "running",
                                  durationMs: 214604,
                                  resolvedModel: "google-antigravity/gemini-3.8-flash:high",
                                },
                                {
                                  id: "SwapHistory",
                                  label: "SwapHistory",
                                  status: "running",
                                  durationMs: 214604,
                                  resolvedModel: "google-antigravity/gemini-3.8-flash:high",
                                },
                                {
                                  id: "ReliabilityEvidence",
                                  label: "ReliabilityEvidence",
                                  status: "completed",
                                  durationMs: 214604,
                                  resolvedModel: "google-antigravity/gemini-3.8-flash:high",
                                  resultText: "Reliability report",
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 3. Second wait result at 20:51:14.928Z: SwapHistory completed (236695ms), ReliabilityEvidence-2 resumes!
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "wait-2",
                          toolName: "wait",
                          args: {},
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "wait-2",
                          toolName: "wait",
                          result: {
                            content: [
                              {
                                type: "text",
                                text: "SwapHistory completed, ReliabilityEvidence resumed",
                              },
                            ],
                            details: {
                              jobs: [
                                {
                                  id: "WrapperLedger",
                                  label: "WrapperLedger",
                                  status: "running",
                                  durationMs: 236696,
                                },
                                {
                                  id: "GymLedger",
                                  label: "GymLedger",
                                  status: "running",
                                  durationMs: 236695,
                                },
                                {
                                  id: "SwapHistory",
                                  label: "SwapHistory",
                                  status: "completed",
                                  durationMs: 236695,
                                  resultText: "Swap report",
                                },
                                {
                                  id: "ReliabilityEvidence-2",
                                  label: "ReliabilityEvidence",
                                  status: "running",
                                  durationMs: 13535,
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 4. Late partial progress update attempting to report SwapHistory as running - must be ignored (sticky terminal for same activation)!
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_update",
                          toolCallId: "task-spawn-1",
                          toolName: "task",
                          partialResult: {
                            details: {
                              progress: [
                                {
                                  id: "SwapHistory",
                                  label: "SwapHistory",
                                  status: "running",
                                  durationMs: 240000,
                                },
                              ],
                            },
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_update",
                          toolCallId: "task-spawn-1",
                          toolName: "task",
                          partialResult: {
                            details: {
                              progress: [
                                {
                                  id: "ReliabilityEvidence",
                                  label: "ReliabilityEvidence",
                                  status: "running",
                                  durationMs: 250000,
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 5. Final wait completions
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "wait-3",
                          toolName: "wait",
                          result: {
                            details: {
                              jobs: [
                                {
                                  id: "WrapperLedger",
                                  label: "WrapperLedger",
                                  status: "completed",
                                  durationMs: 357279,
                                },
                                {
                                  id: "GymLedger",
                                  label: "GymLedger",
                                  status: "completed",
                                  durationMs: 481676,
                                },
                                {
                                  id: "ReliabilityEvidence-2",
                                  label: "ReliabilityEvidence",
                                  status: "completed",
                                  durationMs: 49671,
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 6. Turn completes with assistant answer and terminal agent_end
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [
                              { type: "text", text: "All 4 child tasks completed successfully." },
                            ],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const subagentEvents: Extract<ProviderAdapterV2Event, { type: "subagent.updated" }>[] = [];
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);

        let terminalEvent: ProviderAdapterV2Event | undefined;
        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            subagentEvents.push(event);
          }
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }
        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        if (terminalEvent?.type === "turn.terminal") {
          assert.strictEqual(terminalEvent.status, "completed");
        }
        // Resume thread and verify projection reports idle/completed
        const resumed = yield* runtime.resumeThread({ providerThread });
        assert.strictEqual(resumed.status, "idle");
        // Verify subagent events
        const reliabilityEvents = subagentEvents.filter(
          (e) => e.subagent.title === "ReliabilityEvidence",
        );
        const swapEvents = subagentEvents.filter(
          (e) => e.subagent.title === "SwapHistory",
        );
        const wrapperEvents = subagentEvents.filter(
          (e) => e.subagent.title === "WrapperLedger",
        );
        const gymEvents = subagentEvents.filter(
          (e) => e.subagent.title === "GymLedger",
        );

        assert.isAbove(reliabilityEvents.length, 0);
        assert.isAbove(swapEvents.length, 0);
        assert.isAbove(wrapperEvents.length, 0);
        assert.isAbove(gymEvents.length, 0);

        // 1. ReliabilityEvidence completed first, then resumed as ReliabilityEvidence-2 (running), then completed
        assert.isAtLeast(reliabilityEvents.length, 3);
        const relFirstComplete = reliabilityEvents.find(
          (e) => e.subagent.status === "completed",
        );
        assert.isDefined(relFirstComplete);
        const relResumedRunning = reliabilityEvents.find(
          (e) =>
            e.subagent.status === "running" &&
            reliabilityEvents.indexOf(e) > reliabilityEvents.indexOf(relFirstComplete!),
        );
        assert.isDefined(relResumedRunning);
        if (relResumedRunning !== undefined && relFirstComplete !== undefined) {
          assert.strictEqual(relResumedRunning.subagent.id, relFirstComplete.subagent.id);
        }
        const relFinal = reliabilityEvents[reliabilityEvents.length - 1];
        assert.isDefined(relFinal);
        if (relFinal !== undefined && relFirstComplete !== undefined) {
          assert.strictEqual(relFinal.subagent.id, relFirstComplete.subagent.id);
          assert.strictEqual(relFinal.subagent.status, "completed");
          if (relFinal.subagent.completedAt !== null && relFinal.subagent.startedAt !== null) {
            const duration = Duration.toMillis(
              DateTime.distance(relFinal.subagent.startedAt, relFinal.subagent.completedAt),
            );
            assert.strictEqual(duration, 49671);
          }
        }

        // 2. SwapHistory completed and was NOT reopened by the late partial progress update
        const swapFinal = swapEvents[swapEvents.length - 1]!;
        assert.strictEqual(swapFinal.type, "subagent.updated");
        if (swapFinal.type === "subagent.updated") {
          assert.strictEqual(swapFinal.subagent.status, "completed");
          assert.strictEqual(swapFinal.subagent.result, "Swap report");
        }

        // 3. WrapperLedger and GymLedger completed with their authoritative statuses
        const wrapperFinal = wrapperEvents[wrapperEvents.length - 1]!;
        if (wrapperFinal.type === "subagent.updated") {
          assert.strictEqual(wrapperFinal.subagent.status, "completed");
        }
        const gymFinal = gymEvents[gymEvents.length - 1]!;
        if (gymFinal.type === "subagent.updated") {
          assert.strictEqual(gymFinal.subagent.status, "completed");
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "preserves OMP tool-start intent after the end frame omits it",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);
        const toolCallId = "bash-intent";
        const toolIntent = "Checking repository status";

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId,
                          toolName: "bash",
                          args: { command: "git status" },
                          intent: toolIntent,
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId,
                          toolName: "bash",
                          result: {
                            content: [{ type: "text", text: "On branch main" }],
                            details: { exitCode: 0 },
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Done." }],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);

        let terminalEvent: ProviderAdapterV2Event | undefined;
        let finalToolItem: OrchestrationV2TurnItem | undefined;
        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId
          ) {
            finalToolItem = event.turnItem;
          }
          if (event.type === "turn.terminal") terminalEvent = event;
        }

        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        if (terminalEvent?.type === "turn.terminal") {
          assert.strictEqual(terminalEvent.status, "completed");
        }
        assert.strictEqual(finalToolItem?.type, "command_execution");
        assert.strictEqual(finalToolItem?.status, "completed");
        assert.strictEqual(
          finalToolItem?.type === "command_execution" ? finalToolItem.intent : undefined,
          toolIntent,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "finalizes turn when OMP reports isSettled true even if child subagent is still marked running locally",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      // Spawn a child task that stays locally running
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "task-spawn-running",
                          toolName: "task",
                          args: {
                            tasks: [
                              { id: "BackgroundWorker", label: "BackgroundWorker", task: "Worker" },
                            ],
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "task-spawn-running",
                          toolName: "task",
                          result: {
                            content: [{ type: "text", text: "Started background worker" }],
                            details: {
                              async: {
                                state: "running",
                                jobId: "task-spawn-running",
                                type: "task",
                              },
                              jobs: [
                                {
                                  id: "BackgroundWorker",
                                  label: "BackgroundWorker",
                                  status: "running",
                                  durationMs: 5000,
                                },
                              ],
                            },
                          },
                        }),
                      );
                      // Send terminal agent_end
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "All operations initiated." }],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);

        let terminalEvent: ProviderAdapterV2Event | undefined;
        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }

        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        if (terminalEvent?.type === "turn.terminal") {
          assert.strictEqual(terminalEvent.status, "completed");
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "routes late completed OLD child after NEXT user turn started to OLD subagent.runId only without contaminating next root",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        let promptCount = 0;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      promptCount += 1;
                      if (promptCount === 1) {
                        // Turn 1 prompt
                        yield* push(JSON.stringify({ type: "agent_start" }));
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_start",
                            toolCallId: "task-spawn-old",
                            toolName: "task",
                            args: {
                              tasks: [{ id: "TaskChild", label: "TaskChild", task: "Old work" }],
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-old",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Spawned background child" }],
                              details: {
                                async: { state: "running", jobId: "task-spawn-old", type: "task" },
                                progress: [
                                  {
                                    id: "TaskChild",
                                    label: "TaskChild",
                                    status: "running",
                                    durationMs: 0,
                                  },
                                ],
                              },
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "message_end",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text: "Turn 1 assistant answer" }],
                              stopReason: "stop",
                            },
                          }),
                        );
                        yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                      } else if (promptCount === 2) {
                        // Turn 2 prompt
                        yield* push(JSON.stringify({ type: "agent_start" }));
                        // Late completion for old child TaskChild from Turn 1
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-old",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Old child completed" }],
                              details: {
                                jobs: [
                                  {
                                    id: "TaskChild",
                                    label: "TaskChild",
                                    status: "completed",
                                    durationMs: 120000,
                                    resultText: "Done worker",
                                  },
                                ],
                              },
                            },
                          }),
                        );
                        // Turn 2 assistant response
                        yield* push(
                          JSON.stringify({
                            type: "message_end",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text: "Turn 2 assistant answer" }],
                              stopReason: "stop",
                            },
                          }),
                        );
                        yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                      }
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        // 1. Start Turn 1
        yield* startTurn(runtime, providerThread, "default", [], "turn 1 prompt", undefined, 1);
        let turn1Terminal: ProviderAdapterV2Event | undefined;
        while (turn1Terminal === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal") {
            turn1Terminal = event;
          }
        }
        assert.strictEqual(turn1Terminal?.type, "turn.terminal");

        // 2. Start Turn 2
        yield* startTurn(runtime, providerThread, "default", [], "turn 2 prompt", undefined, 2);
        let turn2Terminal: ProviderAdapterV2Event | undefined;
        const subagentEvents: ProviderAdapterV2Event[] = [];
        while (turn2Terminal === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            subagentEvents.push(event);
          }
          if (event.type === "turn.terminal") {
            turn2Terminal = event;
          }
        }
        assert.strictEqual(turn2Terminal?.type, "turn.terminal");

        // Verify that all subagent.updated events for TaskChild belong to Turn 1's runId only
        const taskChildEvents = subagentEvents.filter(
          (e) => e.type === "subagent.updated" && e.subagent.title === "TaskChild",
        );
        assert.isAbove(taskChildEvents.length, 0);
        for (const ev of taskChildEvents) {
          if (ev.type === "subagent.updated") {
            assert.strictEqual(ev.subagent.runId, "run:thread-omp-test:1");
          }
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "freezes completed subagent duration without mistaking shell or REPL receipts for agents",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      // Spawn async job
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "task-spawn-async",
                          toolName: "task",
                          args: {
                            tasks: [{ id: "AsyncChild", label: "AsyncChild", task: "Async task" }],
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "task-spawn-async",
                          toolName: "task",
                          result: {
                            content: [{ type: "text", text: "Spawned async child" }],
                            details: {
                              async: { state: "running", jobId: "task-spawn-async", type: "task" },
                              progress: [
                                {
                                  id: "AsyncChild",
                                  label: "AsyncChild",
                                  status: "running",
                                  durationMs: 0,
                                },
                              ],
                            },
                          },
                        }),
                      );
                      // Receive structured custom async-result via message_end with details.jobs
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "custom",
                            customType: "async-result",
                            details: {
                              jobs: [
                                {
                                  jobId: "AsyncChild",
                                  type: "task",
                                  label: "AsyncChild",
                                  status: "completed",
                                  durationMs: 214604,
                                  resultText: "Async output verified",
                                },
                                {
                                  id: "bg-shell",
                                  type: "bash",
                                  label: "Shell output",
                                  status: "completed",
                                  durationMs: 900,
                                },
                                {
                                  id: "bg-repl",
                                  type: "eval",
                                  label: "Python result",
                                  status: "completed",
                                  durationMs: 1200,
                                },
                              ],
                            },
                          },
                        }),
                      );
                      // Turn finishes with assistant answer
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Finished async operations" }],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);
        let terminalEvent: ProviderAdapterV2Event | undefined;
        const subagentEvents: ProviderAdapterV2Event[] = [];
        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            subagentEvents.push(event);
          }
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }
        assert.strictEqual(terminalEvent?.type, "turn.terminal");

        const asyncCompleted = subagentEvents.find(
          (e) =>
            e.type === "subagent.updated" &&
            e.subagent.title === "AsyncChild" &&
            e.subagent.status === "completed",
        );
        assert.isDefined(asyncCompleted);
        assert.isFalse(
          subagentEvents.some(
            (event) =>
              event.type === "subagent.updated" &&
              (event.subagent.title === "Shell output" || event.subagent.title === "Python result"),
          ),
        );
        if (asyncCompleted?.type === "subagent.updated") {
          assert.strictEqual(asyncCompleted.subagent.status, "completed");
          assert.strictEqual(asyncCompleted.subagent.result, "Async output verified");
          assert.isNotNull(asyncCompleted.subagent.completedAt);
          if (
            asyncCompleted.subagent.completedAt !== null &&
            asyncCompleted.subagent.startedAt !== null
          ) {
            const elapsed = Duration.toMillis(
              DateTime.distance(
                asyncCompleted.subagent.startedAt,
                asyncCompleted.subagent.completedAt,
              ),
            );
            assert.strictEqual(elapsed, 214604);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "invalidates probe generation on auto_retry_start so idle probe during retry backoff does not finish root",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      // Retry starts - must invalidate settleProbeGeneration
                      yield* push(
                        JSON.stringify({
                          type: "auto_retry_start",
                          attempt: 1,
                          maxAttempts: 3,
                          delayMs: 2000,
                          errorMessage: "Rate limit exceeded, retrying...",
                        }),
                      );
                      // Simulated earlier probe response arriving during retry backoff:
                      yield* push(
                        JSON.stringify({
                          type: "t3.settle_probe",
                          providerTurnId: "provider-turn-probe",
                          settleProbeGeneration: 0, // stale generation!
                          data: { isSettled: true },
                        }),
                      );
                      // Retry succeeds
                      yield* push(
                        JSON.stringify({
                          type: "auto_retry_end",
                          success: true,
                          attempt: 1,
                        }),
                      );
                      // Finish turn normally
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Recovered and completed" }],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);
        let terminalEvent: ProviderAdapterV2Event | undefined;
        let sawRetryRunning = false;
        let sawRetryCompleted = false;
        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.retry !== undefined
          ) {
            if (event.turnItem.status === "running") sawRetryRunning = true;
            if (event.turnItem.status === "completed") sawRetryCompleted = true;
          }
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }
        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        assert.isTrue(sawRetryRunning);
        assert.isTrue(sawRetryCompleted);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "routes correctly when consecutive roots reuse the same agent label with different parentToolCallId and jobId",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        let promptCount = 0;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      promptCount += 1;
                      if (promptCount === 1) {
                        // Root 1 spawns child GymLedger with task-spawn-root1
                        yield* push(JSON.stringify({ type: "agent_start" }));
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_start",
                            toolCallId: "task-spawn-root1",
                            toolName: "task",
                            args: {
                              tasks: [
                                { id: "GymLedger-1", label: "GymLedger", task: "Root 1 task" },
                              ],
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-root1",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Root 1 spawned child" }],
                              details: {
                                progress: [
                                  {
                                    id: "GymLedger-1",
                                    label: "GymLedger",
                                    status: "running",
                                    durationMs: 1000,
                                  },
                                ],
                              },
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "message_end",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text: "Root 1 finished" }],
                              stopReason: "stop",
                            },
                          }),
                        );
                        yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                      } else if (promptCount === 2) {
                        // Root 2 starts and spawns a NEW child with SAME label "GymLedger",
                        // but NEW parentToolCallId "task-spawn-root2" and distinct jobId "GymLedger-2"
                        yield* push(JSON.stringify({ type: "agent_start" }));
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_start",
                            toolCallId: "task-spawn-root2",
                            toolName: "task",
                            args: {
                              tasks: [
                                { id: "GymLedger-2", label: "GymLedger", task: "Root 2 task" },
                              ],
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-root2",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Root 2 spawned child" }],
                              details: {
                                progress: [
                                  {
                                    id: "GymLedger-2",
                                    label: "GymLedger",
                                    status: "running",
                                    durationMs: 500,
                                  },
                                ],
                              },
                            },
                          }),
                        );

                        // WHILE ROOT 2 CONTINUES RUNNING:
                        // Late old receipt for Root 1 arrives (same label "GymLedger", but parentToolCallId "task-spawn-root1")
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-root1",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Root 1 child finished" }],
                              details: {
                                jobs: [
                                  {
                                    id: "GymLedger-1",
                                    label: "GymLedger",
                                    status: "completed",
                                    durationMs: 35000,
                                    resultText: "Root 1 child result",
                                  },
                                ],
                              },
                            },
                          }),
                        );

                        // Root 2 continues running and finishes its own child
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-root2",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Root 2 child finished" }],
                              details: {
                                jobs: [
                                  {
                                    id: "GymLedger-2",
                                    label: "GymLedger",
                                    status: "completed",
                                    durationMs: 15000,
                                    resultText: "Root 2 child result",
                                  },
                                ],
                              },
                            },
                          }),
                        );

                        yield* push(
                          JSON.stringify({
                            type: "message_end",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text: "Root 2 finished" }],
                              stopReason: "stop",
                            },
                          }),
                        );
                        yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                      }
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        // 1. Run Root 1
        yield* startTurn(runtime, providerThread, "default", [], "prompt 1", undefined, 1);
        let turn1Terminal: ProviderAdapterV2Event | undefined;
        let turn1RunId: RunId | null | undefined;
        while (turn1Terminal === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            turn1RunId = event.subagent.runId;
          }
          if (event.type === "turn.terminal") {
            turn1Terminal = event;
          }
        }
        assert.strictEqual(turn1Terminal?.type, "turn.terminal");
        assert.isDefined(turn1RunId);

        // 2. Run Root 2
        yield* startTurn(runtime, providerThread, "default", [], "prompt 2", undefined, 2);
        let turn2Terminal: ProviderAdapterV2Event | undefined;
        let turn2RunId: RunId | null | undefined;
        let root1LateCompleted: OrchestrationV2Subagent | undefined;
        let root2Running: OrchestrationV2Subagent | undefined;
        let root2Completed: OrchestrationV2Subagent | undefined;

        while (turn2Terminal === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            const sub = event.subagent;
            const nativeTaskId = sub.nativeTaskRef?.nativeId ?? "";
            if (nativeTaskId.startsWith("task-spawn-root1:subagent:")) {
              root1LateCompleted = sub;
            } else if (nativeTaskId.startsWith("task-spawn-root2:subagent:")) {
              turn2RunId = sub.runId;
              if (sub.status === "running") {
                root2Running = sub;
              } else if (sub.status === "completed") {
                root2Completed = sub;
              }
            }
          }
          if (event.type === "turn.terminal") {
            turn2Terminal = event;
          }
        }

        assert.strictEqual(turn2Terminal?.type, "turn.terminal");
        assert.isDefined(turn2RunId);
        assert.notStrictEqual(turn1RunId, turn2RunId);
        assert.isDefined(root2Running);
        assert.strictEqual(root2Running?.runId, turn2RunId);
        assert.isDefined(root2Completed);
        assert.strictEqual(root2Completed?.runId, turn2RunId);

        assert.isDefined(root1LateCompleted);
        assert.strictEqual(root1LateCompleted?.runId, turn1RunId);
        assert.strictEqual(root1LateCompleted?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "routes mixed details.jobs where Root 2 wait tool includes both old Root 1 and new Root 2 jobs",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        let promptCount = 0;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          pendingMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      promptCount += 1;
                      if (promptCount === 1) {
                        // Root 1 spawns child OldJob with task-spawn-old
                        yield* push(JSON.stringify({ type: "agent_start" }));
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_start",
                            toolCallId: "task-spawn-old",
                            toolName: "task",
                            args: {
                              tasks: [
                                { id: "OldJob", label: "WorkerAgent", task: "Old work" },
                              ],
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-old",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "Old job started" }],
                              details: {
                                progress: [
                                  {
                                    id: "OldJob",
                                    label: "WorkerAgent",
                                    status: "running",
                                    durationMs: 100,
                                  },
                                ],
                              },
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "message_end",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text: "Turn 1 answer" }],
                              stopReason: "stop",
                            },
                          }),
                        );
                        yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                      } else if (promptCount === 2) {
                        // Root 2 starts and spawns NewJob with task-spawn-new
                        yield* push(JSON.stringify({ type: "agent_start" }));
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_start",
                            toolCallId: "task-spawn-new",
                            toolName: "task",
                            args: {
                              tasks: [
                                { id: "NewJob", label: "WorkerAgent", task: "New work" },
                              ],
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "task-spawn-new",
                            toolName: "task",
                            result: {
                              content: [{ type: "text", text: "New job started" }],
                              details: {
                                progress: [
                                  {
                                    id: "NewJob",
                                    label: "WorkerAgent",
                                    status: "running",
                                    durationMs: 200,
                                  },
                                ],
                              },
                            },
                          }),
                        );

                        // Root 2 calls wait tool (carrier: wait-carrier-root2)
                        // Its details.jobs contains BOTH OldJob (from Root 1) AND NewJob (from Root 2)
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_start",
                            toolCallId: "wait-carrier-root2",
                            toolName: "wait",
                            args: {},
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "tool_execution_end",
                            toolCallId: "wait-carrier-root2",
                            toolName: "wait",
                            result: {
                              content: [{ type: "text", text: "Wait resolved jobs" }],
                              details: {
                                jobs: [
                                  {
                                    id: "OldJob",
                                    label: "WorkerAgent",
                                    status: "completed",
                                    durationMs: 45000,
                                    resultText: "Old job finished in Root 1 context",
                                  },
                                  {
                                    id: "NewJob",
                                    label: "WorkerAgent",
                                    status: "completed",
                                    durationMs: 12000,
                                    resultText: "New job finished in Root 2 context",
                                  },
                                ],
                              },
                            },
                          }),
                        );
                        yield* push(
                          JSON.stringify({
                            type: "message_end",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text: "Turn 2 answer" }],
                              stopReason: "stop",
                            },
                          }),
                        );
                        yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                      }
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        // 1. Run Root 1
        yield* startTurn(runtime, providerThread, "default", [], "prompt 1", undefined, 1);
        let turn1Terminal: ProviderAdapterV2Event | undefined;
        let turn1RunId: RunId | null | undefined;
        while (turn1Terminal === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            turn1RunId = event.subagent.runId;
          }
          if (event.type === "turn.terminal") {
            turn1Terminal = event;
          }
        }
        assert.strictEqual(turn1Terminal?.type, "turn.terminal");
        assert.isDefined(turn1RunId);

        // 2. Run Root 2
        yield* startTurn(runtime, providerThread, "default", [], "prompt 2", undefined, 2);
        let turn2Terminal: ProviderAdapterV2Event | undefined;
        let turn2RunId: RunId | null | undefined;
        let oldJobCompleted: OrchestrationV2Subagent | undefined;
        let newJobCompleted: OrchestrationV2Subagent | undefined;
        const waitToolItems: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>[] = [];

        while (turn2Terminal === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            const sub = event.subagent;
            const nativeId = sub.nativeTaskRef?.nativeId ?? "";
            if (nativeId.includes("OldJob") && sub.status === "completed") {
              oldJobCompleted = sub;
            } else if (nativeId.includes("NewJob") && sub.status === "completed") {
              newJobCompleted = sub;
              turn2RunId = sub.runId;
            }
          } else if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === "wait-carrier-root2"
          ) {
            waitToolItems.push(event.turnItem);
          }
          if (event.type === "turn.terminal") {
            turn2Terminal = event;
          }
        }

        assert.strictEqual(turn2Terminal?.type, "turn.terminal");
        assert.isDefined(turn2RunId);
        assert.notStrictEqual(turn1RunId, turn2RunId);

        // Verify OldJob routed to Root 1 with canonical completion
        assert.isDefined(oldJobCompleted);
        assert.strictEqual(oldJobCompleted?.runId, turn1RunId);
        assert.strictEqual(oldJobCompleted?.status, "completed");
        assert.isTrue(oldJobCompleted?.nativeTaskRef?.nativeId?.startsWith("task-spawn-old:subagent:"));

        // Verify NewJob routed to Root 2 with canonical completion
        assert.isDefined(newJobCompleted);
        assert.strictEqual(newJobCompleted?.runId, turn2RunId);
        assert.strictEqual(newJobCompleted?.status, "completed");
        assert.isTrue(newJobCompleted?.nativeTaskRef?.nativeId?.startsWith("task-spawn-new:subagent:"));

        // Verify wait tool item was emitted ONLY on Root 2
        assert.isTrue(waitToolItems.length > 0);
        for (const item of waitToolItems) {
          assert.strictEqual(item.runId, turn2RunId);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "inspectSettlement returns settlement proof on strict quiet native state, and returns null when busy or failing",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        let triggerIntermediateRetry = false;
        let promptSeen = false;
        let getStateResponse: Record<string, unknown> = {
          sessionFile: "/tmp/omp-session.jsonl",
          isStreaming: false,
          isCompacting: false,
          hasPendingAsyncWork: false,
          queuedMessageCount: 0,
          isSettled: true,
        };

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        if (triggerIntermediateRetry) {
                          yield* push(
                            JSON.stringify({
                              type: "auto_retry_start",
                              attempt: 1,
                              maxAttempts: 3,
                              retryDelayMs: 1000,
                            }),
                          );
                          yield* push(
                            JSON.stringify({
                              type: "auto_retry_end",
                              success: true,
                            }),
                          );
                        }
                        responseData = getStateResponse;
                      } else if (record["type"] === "get_entries") {
                        if (!promptSeen) {
                          responseData = {
                            entries: [],
                            leafId: "entry-before-user",
                          };
                        } else if (record["since"] === "entry-assistant-1") {
                          responseData = {
                            entries: [],
                            leafId: "entry-assistant-1",
                          };
                        } else {
                          responseData = {
                            entries: [
                              {
                                id: "entry-user-1",
                                type: "message",
                                message: { role: "user" },
                              },
                              {
                                id: "entry-assistant-1",
                                type: "message",
                                message: { role: "assistant" },
                              },
                            ],
                            leafId: "entry-assistant-1",
                          };
                        }
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      promptSeen = true;
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      yield* push(
                        JSON.stringify({
                          type: "message_start",
                          message: { role: "assistant" },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "message_update",
                          assistantMessageEvent: {
                            type: "text_end",
                            contentIndex: 0,
                            content: "Quiet response",
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Quiet response" }],
                            stopReason: "stop",
                          },
                        }),
                      );
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const sessionRuntime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* sessionRuntime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* sessionRuntime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const runId = RunId.make(`run:${THREAD_ID}:1`);
        yield* startTurn(sessionRuntime, providerThread, "default", [], "Explain ParadeDB FTS", undefined, 1);
        let assistantCompleted = false;
        while (!assistantCompleted) {
          const ev = yield* Queue.take(events);
          if (
            ev.type === "turn_item.updated" &&
            ev.turnItem.type === "assistant_message" &&
            ev.turnItem.status === "completed"
          ) {
            assistantCompleted = true;
          }
        }

        assert.isDefined(sessionRuntime.inspectSettlement);

        // 1. Strict quiet proof -> should return settlement result with settledAt
        const quietProof1 = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNotNull(quietProof1);
        assert.isDefined(quietProof1?.settledAt);
        assert.isDefined(quietProof1?.providerTurnId);
        assert.deepEqual(quietProof1?.nativeTurnRef, {
          driver: ProviderDriverKind.make("omp"),
          nativeId: "entry-user-1",
          strength: "strong",
        });
        assert.deepEqual(quietProof1?.nativeConversationHeadRef, {
          driver: ProviderDriverKind.make("omp"),
          nativeId: "entry-assistant-1",
          strength: "strong",
        });

        // 1b. Second inspection on same quiet bound run preserves original cached nativeTurnStartEntryId
        // even when subsequent get_entries query passes since=entry-assistant-1 returning empty entries.
        const quietProof2 = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNotNull(quietProof2);
        assert.isDefined(quietProof2?.settledAt);
        assert.isDefined(quietProof2?.providerTurnId);
        assert.deepEqual(quietProof2?.nativeTurnRef, {
          driver: ProviderDriverKind.make("omp"),
          nativeId: "entry-user-1",
          strength: "strong",
        });
        assert.deepEqual(quietProof2?.nativeConversationHeadRef, {
          driver: ProviderDriverKind.make("omp"),
          nativeId: "entry-assistant-1",
          strength: "strong",
        });
        // 2. Dialect missing hasPendingAsyncWork -> should return null
        getStateResponse = {
          sessionFile: "/tmp/omp-session.jsonl",
          isStreaming: false,
          isCompacting: false,
          queuedMessageCount: 0,
          isSettled: true,
        };
        const missingProof = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNull(missingProof);

        // 3. Dialect busy with queued messages -> should return null
        getStateResponse = {
          sessionFile: "/tmp/omp-session.jsonl",
          isStreaming: false,
          isCompacting: false,
          hasPendingAsyncWork: false,
          queuedMessageCount: 2,
          isSettled: true,
        };
        const busyQueueProof = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNull(busyQueueProof);

        // 4. Dialect compacting -> should return null
        getStateResponse = {
          sessionFile: "/tmp/omp-session.jsonl",
          isStreaming: false,
          isCompacting: true,
          hasPendingAsyncWork: false,
          queuedMessageCount: 0,
          isSettled: true,
        };
        const compactingProof = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNull(compactingProof);

        // 5. Retry starts and ends DURING get_state RPC: generation changes -> should return null
        getStateResponse = {
          sessionFile: "/tmp/omp-session.jsonl",
          isStreaming: false,
          isCompacting: false,
          hasPendingAsyncWork: false,
          queuedMessageCount: 0,
          isSettled: true,
        };
        triggerIntermediateRetry = true;
        const probeGenerationMismatchProof = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNull(probeGenerationMismatchProof);

        // 6. Error message_end queued BEFORE idle get_state reply: pump processes error first -> inspectedResult MUST be null
        getStateResponse = {
          sessionFile: "/tmp/omp-session.jsonl",
          isStreaming: false,
          isCompacting: false,
          hasPendingAsyncWork: false,
          queuedMessageCount: 0,
          isSettled: true,
        };
        triggerIntermediateRetry = false;
        yield* push(
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Model rate limited",
            },
          }),
        );
        const errorQueuedProof = yield* sessionRuntime.inspectSettlement!({
          providerThread,
          runId,
        });
        assert.isNull(errorQueuedProof);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "tracks two concurrent children missing index with independent nativeTaskId, duration, and status without merging",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          hasPendingAsyncWork: false,
                          queuedMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "task-spawn-concurrent",
                          toolName: "task",
                          args: {},
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "subagent_lifecycle",
                          payload: {
                            parentToolCallId: "task-spawn-concurrent",
                            id: "child-worker-alpha",
                            label: "WorkerAgent",
                            status: "running",
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "subagent_lifecycle",
                          payload: {
                            parentToolCallId: "task-spawn-concurrent",
                            id: "child-worker-beta",
                            label: "WorkerAgent",
                            status: "running",
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "subagent_lifecycle",
                          payload: {
                            parentToolCallId: "task-spawn-concurrent",
                            id: "child-worker-alpha",
                            label: "WorkerAgent",
                            status: "completed",
                            durationMs: 4000,
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "subagent_lifecycle",
                          payload: {
                            parentToolCallId: "task-spawn-concurrent",
                            id: "child-worker-beta",
                            label: "WorkerAgent",
                            status: "completed",
                            durationMs: 18000,
                          },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "task-spawn-concurrent",
                          toolName: "task",
                          result: { content: [{ type: "text", text: "Finished tasks" }] },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "All workers done" }],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);
        let terminalEvent: ProviderAdapterV2Event | undefined;
        let alphaCompleted: OrchestrationV2Subagent | undefined;
        let betaCompleted: OrchestrationV2Subagent | undefined;

        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            const sub = event.subagent;
            if (
              sub.nativeTaskRef?.nativeId === "task-spawn-concurrent:subagent:child-worker-alpha" &&
              sub.status === "completed"
            ) {
              alphaCompleted = sub;
            } else if (
              sub.nativeTaskRef?.nativeId === "task-spawn-concurrent:subagent:child-worker-beta" &&
              sub.status === "completed"
            ) {
              betaCompleted = sub;
            }
          }
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }

        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        assert.isDefined(alphaCompleted);
        assert.isDefined(betaCompleted);

        assert.strictEqual(
          alphaCompleted?.nativeTaskRef?.nativeId,
          "task-spawn-concurrent:subagent:child-worker-alpha",
        );
        assert.strictEqual(
          betaCompleted?.nativeTaskRef?.nativeId,
          "task-spawn-concurrent:subagent:child-worker-beta",
        );
        assert.notStrictEqual(
          alphaCompleted?.nativeTaskRef?.nativeId,
          betaCompleted?.nativeTaskRef?.nativeId,
        );

        if (alphaCompleted?.completedAt !== null && alphaCompleted?.startedAt !== null) {
          const alphaDuration = Duration.toMillis(
            DateTime.distance(alphaCompleted.startedAt, alphaCompleted.completedAt),
          );
          assert.strictEqual(alphaDuration, 4000);
        }
        if (betaCompleted?.completedAt !== null && betaCompleted?.startedAt !== null) {
          const betaDuration = Duration.toMillis(
            DateTime.distance(betaCompleted.startedAt, betaCompleted.completedAt),
          );
          assert.strictEqual(betaDuration, 18000);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "preserves visible role, completion percent, and tool across sparse hub-wait job snapshots, clears on explicit null, and resets on fresh activation",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const push = (text: string) =>
          Queue.offer(stdout, new TextEncoder().encode(text + "\n")).pipe(Effect.asVoid);

        yield* push(
          JSON.stringify({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1048576,
          }),
        );

        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(FAKE_PID),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    const record = JSON.parse(trimmed) as Record<string, unknown>;
                    if (typeof record["id"] === "string") {
                      let responseData: unknown = undefined;
                      if (record["type"] === "get_state") {
                        responseData = {
                          sessionFile: "/tmp/omp-session.jsonl",
                          isStreaming: false,
                          isCompacting: false,
                          hasPendingAsyncWork: false,
                          queuedMessageCount: 0,
                          isSettled: true,
                        };
                      } else if (record["type"] === "get_entries") {
                        responseData = { entries: [], leafId: "leaf-1" };
                      } else if (record["type"] === "get_available_models") {
                        responseData = { models: [] };
                      } else if (record["type"] === "get_commands") {
                        responseData = { commands: [] };
                      } else if (record["type"] === "get_session_stats") {
                        responseData = {};
                      }
                      yield* push(
                        JSON.stringify({
                          id: record["id"],
                          type: "response",
                          command: record["type"],
                          success: true,
                          ...(responseData === undefined ? {} : { data: responseData }),
                        }),
                      );
                    }
                    if (record["type"] === "prompt") {
                      yield* push(JSON.stringify({ type: "agent_start" }));

                      // 1. Task spawn: tool_execution_start for task
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "task-spawn-canonical",
                          toolName: "task",
                          args: {},
                        }),
                      );

                      // 2. Native progress: reported role: reviewer, completion: 65%, currentTool: read, retry: attempt 1
                      yield* push(
                        JSON.stringify({
                          type: "subagent_progress",
                          payload: {
                            index: 0,
                            jobId: "act-1",
                            id: "canonical-task-1",
                            parentToolCallId: "task-spawn-canonical",
                            agent: "reviewer",
                            label: "CodeReviewer",
                            status: "running",
                            durationMs: 38000,
                            currentTool: {
                              name: "read",
                              intent: "Inspect canonical file",
                              argsPreview: "src/index.ts",
                            },
                            completionPercent: 65,
                            retry: {
                              attempt: 1,
                              delayMs: 5000,
                              message: "Transient failure",
                            },
                            metrics: {
                              toolCount: 4,
                            },
                          },
                        }),
                      );

                      // 3. Sparse hub-wait job snapshot: only id, type: task, status: running, label, duration
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_start",
                          toolCallId: "wait-carrier-canonical",
                          toolName: "wait",
                          args: {},
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_update",
                          toolCallId: "wait-carrier-canonical",
                          toolName: "wait",
                          partialResult: {
                            details: {
                              jobs: [
                                {
                                  id: "canonical-task-1",
                                  jobId: "act-1",
                                  type: "task",
                                  status: "running",
                                  label: "CodeReviewer",
                                  duration: 40000,
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 4. Explicit null clearing for currentTool and retry
                      yield* push(
                        JSON.stringify({
                          type: "subagent_progress",
                          payload: {
                            index: 0,
                            id: "canonical-task-1",
                            jobId: "act-1",
                            parentToolCallId: "task-spawn-canonical",
                            status: "running",
                            label: "CodeReviewer",
                            currentTool: null,
                            retry: null,
                          },
                        }),
                      );

                      // 5. Sparse hub-wait job snapshot after clearing: should preserve cleared state
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_update",
                          toolCallId: "wait-carrier-canonical",
                          toolName: "wait",
                          partialResult: {
                            details: {
                              jobs: [
                                {
                                  id: "canonical-task-1",
                                  jobId: "act-1",
                                  type: "task",
                                  status: "running",
                                  label: "CodeReviewer",
                                  duration: 42000,
                                },
                              ],
                            },
                          },
                        }),
                      );

                      // 6. Fresh activation for the same task with sparse fields: per-activation fields must reset
                      yield* push(
                        JSON.stringify({
                          type: "subagent_progress",
                          payload: {
                            index: 0,
                            id: "canonical-task-1",
                            jobId: "act-2",
                            parentToolCallId: "task-spawn-canonical",
                            type: "task",
                            status: "running",
                            label: "CodeReviewer",
                            durationMs: 1000,
                          },
                        }),
                      );

                      // 7. Complete turn
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "wait-carrier-canonical",
                          toolName: "wait",
                          result: { content: [{ type: "text", text: "Wait finished" }] },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "tool_execution_end",
                          toolCallId: "task-spawn-canonical",
                          toolName: "task",
                          result: { content: [{ type: "text", text: "All tasks completed" }] },
                        }),
                      );
                      yield* push(
                        JSON.stringify({
                          type: "message_end",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Tasks handled successfully" }],
                            stopReason: "stop",
                          },
                        }),
                      );
                      yield* push(JSON.stringify({ type: "agent_end", isTerminal: true }));
                    }
                  }
                }),
              ),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const serverConfig = yield* ServerConfig.ServerConfig;

        const adapter = yield* makeOmpAdapter({
          instanceId: OMP_INSTANCE_ID,
          settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
          environment: {},
          spawner,
          fileSystem,
          idAllocator,
          serverConfig,
          dialect: OMP_DIALECT,
        });

        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );

        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });

        yield* startTurn(runtime, providerThread);

        let terminalEvent: ProviderAdapterV2Event | undefined;
        const subagentEvents: Extract<ProviderAdapterV2Event, { type: "subagent.updated" }>[] = [];
        const turnItemEvents: Extract<
          OrchestrationV2TurnItem,
          { readonly type: "subagent" }
        >[] = [];

        while (terminalEvent === undefined) {
          const event = yield* Queue.take(events);
          if (event.type === "subagent.updated") {
            subagentEvents.push(event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            turnItemEvents.push(event.turnItem);
          }
          if (event.type === "turn.terminal") {
            terminalEvent = event;
          }
        }

        assert.strictEqual(terminalEvent?.type, "turn.terminal");
        assert.isAtLeast(subagentEvents.length, 5);

        // 1. Native progress event
        const ev1 = subagentEvents[0]!.subagent;
        assert.strictEqual(ev1.status, "running");
        assert.strictEqual(ev1.agentType, "reviewer");
        assert.strictEqual(ev1.completionPercent, 65);
        assert.deepEqual(ev1.currentTool, {
          name: "read",
          intent: "Inspect canonical file",
          argsPreview: "src/index.ts",
        });
        assert.deepEqual(ev1.retry, {
          attempt: 1,
          delayMs: 5000,
          message: "Transient failure",
        });

        // 2. Sparse hub-wait job snapshot: preserves role, percent, currentTool, and retry
        const ev2 = subagentEvents[1]!.subagent;
        assert.strictEqual(ev2.status, "running");
        assert.strictEqual(ev2.agentType, "reviewer");
        assert.strictEqual(ev2.completionPercent, 65);
        assert.deepEqual(ev2.currentTool, {
          name: "read",
          intent: "Inspect canonical file",
          argsPreview: "src/index.ts",
        });
        assert.deepEqual(ev2.retry, {
          attempt: 1,
          delayMs: 5000,
          message: "Transient failure",
        });

        const ti2 = turnItemEvents[1]!;
        assert.strictEqual(ti2.agentType, "reviewer");
        assert.strictEqual(ti2.completionPercent, 65);
        assert.deepEqual(ti2.currentTool, {
          name: "read",
          intent: "Inspect canonical file",
          argsPreview: "src/index.ts",
        });

        // 3. Explicit null clears currentTool and retry
        const ev3 = subagentEvents[2]!.subagent;
        assert.strictEqual(ev3.status, "running");
        assert.strictEqual(ev3.agentType, "reviewer");
        assert.strictEqual(ev3.completionPercent, 65);
        assert.isNull(ev3.currentTool);
        assert.isNull(ev3.retry);

        // 4. Sparse hub-wait job snapshot after clear: preserves cleared state (null)
        const ev4 = subagentEvents[3]!.subagent;
        assert.strictEqual(ev4.status, "running");
        assert.strictEqual(ev4.agentType, "reviewer");
        assert.strictEqual(ev4.completionPercent, 65);
        assert.isNull(ev4.currentTool);
        assert.isNull(ev4.retry);

        // 5. Fresh activation: resets per-activation fields (must not inherit stale fields)
        const ev5 = subagentEvents[4]!.subagent;
        assert.strictEqual(ev5.status, "running");
        assert.isUndefined(ev5.agentType);
        assert.isUndefined(ev5.completionPercent);
        assert.isUndefined(ev5.currentTool);
        assert.isUndefined(ev5.retry);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
