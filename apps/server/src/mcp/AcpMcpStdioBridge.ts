// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeReadline from "node:readline";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Stdio-to-HTTP bridge for T3's MCP endpoint.
 *
 * ACP agents must support stdio MCP servers, while optional http/sse support
 * is unevenly implemented. `t3 acp-mcp-bridge` runs as the stdio MCP server an
 * ACP agent spawns and forwards each JSON-RPC line to T3's authenticated
 * streamable-HTTP endpoint: single JSON responses and SSE streams are written
 * back as newline-delimited JSON-RPC, notification acknowledgements (202/204)
 * produce no output, and the `mcp-session-id` / negotiated protocol version
 * are replayed on subsequent requests.
 *
 * This entry sits on the ACP first-message critical path (bin.ts fast-paths
 * it before the CLI graph), so it imports only effect core modules; keep the
 * import list lean when changing it.
 */

export class AcpMcpBridgeError extends Error {
  readonly _tag = "AcpMcpBridgeError";
}

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  cause instanceof AcpMcpBridgeError
    ? cause
    : new AcpMcpBridgeError(cause instanceof Error ? cause.message : String(cause), { cause });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    while (separatorIndex !== -1) {
      const rawEvent = buffered.slice(0, separatorIndex);
      buffered = buffered.slice(separatorIndex).replace(/^(?:\r?\n){2}/u, "");
      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    }
  }
}

const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/**
 * Every JSON-RPC payload carried by a response, in arrival order: nothing for
 * notification acknowledgements, each SSE `data:` event as it streams in, or
 * the single JSON body.
 */
export function responsePayloads(response: Response): Stream.Stream<unknown, AcpMcpBridgeError> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return Stream.fromAsyncIterable(sseDataLines(response), bridgeError).pipe(
      Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: bridgeError })),
    );
  }
  return Stream.unwrap(
    Effect.tryPromise({ try: () => response.text(), catch: bridgeError }).pipe(
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(Stream.empty)
          : Effect.try({ try: () => JSON.parse(text) as unknown, catch: bridgeError }).pipe(
              Effect.map((payload) => Stream.fromIterable([payload])),
            ),
      ),
    ),
  );
}

export interface AcpMcpToolCallOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly clientName: string;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolSession {
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, AcpMcpBridgeError>;
}

/** Starts one authenticated MCP session, terminated when its scope closes. */
export const mcpToolSession = (
  options: McpToolSessionOptions,
): Effect.Effect<McpToolSession, AcpMcpBridgeError, Scope.Scope> => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: options.authorization,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const send = Effect.fn("AcpMcpStdioBridge.send")(function* (
    message: unknown,
  ): Effect.fn.Return<ReadonlyArray<unknown>, AcpMcpBridgeError> {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body: JSON.stringify(message),
        }),
      catch: bridgeError,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      yield* discardResponseBody(response);
      return yield* Effect.fail(
        new AcpMcpBridgeError(`KM Code MCP endpoint responded with HTTP ${response.status}.`),
      );
    }
    const payloads = yield* Stream.runCollect(responsePayloads(response));
    for (const payload of payloads) {
      protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
    }
    return payloads;
  });

  const request = Effect.fn("AcpMcpStdioBridge.request")(function* (
    method: string,
    params: unknown,
  ): Effect.fn.Return<JsonRpcEnvelope, AcpMcpBridgeError> {
    const id = `kmcode-cli-${nextId++}`;
    const responses = yield* send({ jsonrpc: "2.0", id, method, params });
    const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
    if (envelope === null || envelope.error !== undefined) {
      return yield* Effect.fail(
        new AcpMcpBridgeError(
          `KM Code MCP ${method} failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        ),
      );
    }
    return envelope;
  });

  const terminate = Effect.suspend(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise(() =>
          fetchImplementation(options.endpoint, { method: "DELETE", headers: headers() }),
        ).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
  );

  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => terminate);
    yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName, version: "0.0.0" },
    });
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return {
      call: (tool, args) =>
        request("tools/call", { name: tool, arguments: args }).pipe(
          Effect.map((envelope) => envelope.result),
        ),
    } satisfies McpToolSession;
  });
};

/**
 * Call one MCP tool through a fresh authenticated HTTP session.
 *
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
export function callAcpMcpTool(
  options: AcpMcpToolCallOptions,
): Effect.Effect<unknown, AcpMcpBridgeError> {
  return mcpToolSession({
    endpoint: options.endpoint,
    authorization: options.authorization,
    clientName: "t3-code-acp-cli",
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
  }).pipe(
    Effect.flatMap((session) => session.call(options.tool, options.arguments)),
    Effect.scoped,
  );
}

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    // Dispatch happens synchronously on the single stream fiber, so plain
    // locals carry the shared session state; forwards mutate them in
    // completion order exactly like the wire does.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = (payload: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const entry of Array.isArray(payload) ? payload : [payload]) {
          protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
          yield* writeMessage(entry);
        }
      });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward = (line: string, envelope: JsonRpcEnvelope): Effect.Effect<void> =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: line,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(
              envelope.id,
              `KM Code MCP endpoint responded with HTTP ${response.status}.`,
            );
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response), handleServerPayload);
      }).pipe(
        Effect.catchCause((cause) => {
          if (envelope.id === undefined) return Effect.void;
          const error = Cause.squash(cause);
          return respondWithError(
            envelope.id,
            `KM Code MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );

    // Only session establishment is ordered; client responses to
    // server-initiated SSE requests must bypass the barrier or they would
    // deadlock the still-open HTTP exchange, and normal MCP calls stay
    // concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = (task: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(task);
        running.add(fiber);
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
              }),
            ),
          ),
        );
      });

    const dispatch = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return yield* respondWithError(null, "Parse error", -32700);
        }
        const envelope = asEnvelope(parsed);
        if (envelope === null) return;
        const isResponse =
          envelope.id !== undefined && ("result" in envelope || "error" in envelope);
        const isSessionHandshake =
          envelope.method === "initialize" || envelope.method === "notifications/initialized";
        if (isResponse) {
          return yield* launch(forward(line, envelope));
        }
        if (isSessionHandshake) {
          const prior = sessionBarrier;
          const fiber = yield* Effect.forkChild(
            prior.pipe(Effect.andThen(forward(line, envelope))),
          );
          running.add(fiber);
          const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
          sessionBarrier = barrier;
          sessionBarrierPending = true;
          yield* Effect.forkChild(
            Fiber.await(fiber).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  running.delete(fiber);
                  if (sessionBarrier === barrier) sessionBarrierPending = false;
                }),
              ),
            ),
          );
          return;
        }
        const task = sessionBarrierPending
          ? sessionBarrier.pipe(Effect.andThen(forward(line, envelope)))
          : forward(line, envelope);
        return yield* launch(task);
      });

    const reader = NodeReadline.createInterface({ input: options.input });
    yield* Stream.runForEach(Stream.fromAsyncIterable(reader, bridgeError), dispatch).pipe(
      Effect.catchCause(() => Effect.void),
    );
    yield* Fiber.awaitAll(running);
  });
}

/**
 * Argv runner for `t3 acp-mcp-bridge` and `t3 acp-mcp-call`, shared by the
 * fast-path dispatch in bin.ts and the full CLI's command handlers. Kept free
 * of heavy imports: these commands run on the ACP first-message critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(`${command} requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsJson] = args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("acp-mcp-call requires <tool> and <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  let result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  // Terminal callers see both fields, unlike native MCP clients that choose one.
  if (
    typeof result === "object" &&
    result !== null &&
    "structuredContent" in result &&
    result.structuredContent !== undefined &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    const encoded = JSON.stringify(result.structuredContent);
    result = {
      ...result,
      content: result.content.filter(
        (part: unknown) =>
          !(
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            part.text === encoded
          ),
      ),
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
