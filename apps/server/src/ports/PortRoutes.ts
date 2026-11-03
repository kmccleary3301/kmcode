import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeNet from "node:net";
import type { ListeningPort, PortForwardHost } from "@t3tools/contracts";
import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  PORT_FORWARD_CONNECT_FAILED,
  PORT_FORWARD_DRAINED,
  PORT_FORWARD_END,
  PORT_FORWARD_PROTOCOL_ERROR,
  PORT_FORWARD_READY,
  PORT_FORWARD_ROUTE,
  PortForwardHost as PortForwardHostSchema,
  PortSchema,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as ProcessRunner from "../processRunner.ts";

const LSOF_TIMEOUT_MS = 5_000;
const SS_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;

const decodePort = Schema.decodeUnknownOption(PortSchema);
const decodeHost = Schema.decodeUnknownOption(PortForwardHostSchema);

const LSOF_LOCAL_HOST_TOKENS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
  "[::1]": true,
  "*": true,
  "[::]": true,
};

function parseHostAndPortFromLsofName(
  name: string,
): { readonly host: PortForwardHost; readonly port: number } | null {
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (LSOF_LOCAL_HOST_TOKENS[hostPart] !== true) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;

  let host: PortForwardHost = "localhost";
  if (hostPart === "127.0.0.1") {
    host = "127.0.0.1";
  } else if (hostPart === "[::1]" || hostPart === "::1") {
    host = "::1";
  }

  return { host, port };
}
export function parseLsofOutput(output: string): readonly ListeningPort[] {
  const results: ListeningPort[] = [];
  const lines = output.split("\n");

  let currentPid: number | null = null;
  let currentProcessName: string | null = null;

  for (const line of lines) {
    if (line.length === 0) continue;
    const type = line[0];
    const value = line.slice(1);

    if (type === "p") {
      const parsedPid = Number.parseInt(value, 10);
      currentPid = Number.isFinite(parsedPid) ? parsedPid : null;
      currentProcessName = null;
    } else if (type === "c") {
      currentProcessName = value.trim() || null;
    } else if (type === "n") {
      const parsed = parseHostAndPortFromLsofName(value);
      if (parsed !== null) {
        results.push({
          port: parsed.port,
          host: parsed.host,
          processName: currentProcessName,
          pid: currentPid,
        });
      }
    }
  }

  // Deduplicate by port and host
  const seen: Record<string, true> = {};
  const deduplicated: ListeningPort[] = [];
  for (const item of results) {
    const key = `${item.host}:${item.port}`;
    if (!seen[key]) {
      seen[key] = true;
      deduplicated.push(item);
    }
  }

  return deduplicated;
}

export function parseNetstatOutput(output: string): readonly ListeningPort[] {
  const results: ListeningPort[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const state = parts[3];
    if (state !== "LISTENING") continue;

    const localAddress = parts[1];
    if (localAddress === undefined) continue;
    const lastColon = localAddress.lastIndexOf(":");
    if (lastColon < 0) continue;
    const hostPart = localAddress.slice(0, lastColon);
    const portPart = localAddress.slice(lastColon + 1);

    let host: PortForwardHost | null = null;
    if (hostPart === "127.0.0.1" || hostPart === "0.0.0.0") {
      host = "127.0.0.1";
    } else if (hostPart === "[::1]" || hostPart === "[::]") {
      host = "::1";
    }

    if (host === null) continue;
    const port = Number.parseInt(portPart, 10);
    if (!Number.isFinite(port) || port <= 0 || port >= 65536) continue;

    let pid: number | null = null;
    if (parts.length >= 5) {
      const parsedPid = Number.parseInt(parts[4] ?? "", 10);
      if (Number.isFinite(parsedPid)) {
        pid = parsedPid;
      }
    }

    results.push({
      port,
      host,
      processName: null,
      pid,
    });
  }

  const seen: Record<string, true> = {};
  const deduplicated: ListeningPort[] = [];
  for (const item of results) {
    const key = `${item.host}:${item.port}`;
    if (!seen[key]) {
      seen[key] = true;
      deduplicated.push(item);
    }
  }

  return deduplicated;
}

export function parseSsOutput(output: string): readonly ListeningPort[] {
  const results: ListeningPort[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LISTEN")) continue;

    const usersIndex = trimmed.indexOf("users:");
    const beforeUsers = usersIndex >= 0 ? trimmed.slice(0, usersIndex).trim() : trimmed;
    const usersPart = usersIndex >= 0 ? trimmed.slice(usersIndex) : null;

    const parts = beforeUsers.split(/\s+/);
    if (parts.length < 4 || parts[0] !== "LISTEN") continue;

    const localAddress = parts[3];
    if (localAddress === undefined) continue;
    const lastColon = localAddress.lastIndexOf(":");
    if (lastColon < 0) continue;
    const hostPart = localAddress.slice(0, lastColon);
    const portPart = localAddress.slice(lastColon + 1);

    let host: PortForwardHost | null = null;
    if (hostPart === "127.0.0.1" || hostPart === "0.0.0.0") {
      host = "127.0.0.1";
    } else if (hostPart === "[::1]" || hostPart === "::1" || hostPart === "[::]") {
      host = "::1";
    } else if (hostPart === "localhost") {
      host = "localhost";
    } else if (hostPart === "*") {
      const peerAddress = parts[4] ?? "";
      if (
        peerAddress.startsWith("[::]") ||
        peerAddress.includes("::") ||
        peerAddress.startsWith("[")
      ) {
        host = "::1";
      } else if (peerAddress.startsWith("0.0.0.0:")) {
        host = "127.0.0.1";
      } else {
        host = "localhost";
      }
    }

    if (host === null) continue;

    const port = Number.parseInt(portPart, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) continue;

    let processName: string | null = null;
    let pid: number | null = null;

    if (usersPart !== null) {
      const match = usersPart.match(/\((?:"((?:[^"\\]|\\.)*)"|([^",]+)),pid=(\d+)/);
      if (match !== null) {
        const rawName = (match[1] ?? match[2] ?? "").replace(/\\"/g, '"');
        processName = rawName.trim() || null;
        const parsedPid = match[3] !== undefined ? Number.parseInt(match[3], 10) : NaN;
        pid = Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null;
      }
    }

    results.push({
      port,
      host,
      processName,
      pid,
    });
  }

  const seen: Record<string, true> = {};
  const deduplicated: ListeningPort[] = [];
  for (const item of results) {
    const key = `${item.host}:${item.port}`;
    if (!seen[key]) {
      seen[key] = true;
      deduplicated.push(item);
    }
  }

  return deduplicated;
}

const discoverListeningPorts = Effect.fnUntraced(function* (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  hostPlatform: NodeJS.Platform,
) {
  if (hostPlatform !== "darwin" && hostPlatform !== "linux" && hostPlatform !== "win32") {
    return yield* failEnvironmentInternal(
      "internal_error",
      new Error("Port discovery is unavailable on this platform."),
    );
  }

  const { command, args, timeout } =
    hostPlatform === "darwin"
      ? {
          command: "lsof",
          args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
          timeout: LSOF_TIMEOUT_MS,
        }
      : hostPlatform === "linux"
        ? {
            command: "ss",
            args: ["-H", "-ltnp"],
            timeout: SS_TIMEOUT_MS,
          }
        : {
            command: "netstat",
            args: ["-ano", "-p", "tcp"],
            timeout: WINDOWS_LISTENER_TIMEOUT_MS,
          };

  const output = yield* processRunner
    .run({
      command,
      args,
      timeout: Duration.millis(timeout),
    })
    .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));

  // lsof returns 1 without diagnostics when no listeners match.
  if (
    output.code !== 0 &&
    !(
      hostPlatform === "darwin" &&
      output.code === 1 &&
      output.stdout === "" &&
      output.stderr === ""
    )
  ) {
    return yield* failEnvironmentInternal(
      "internal_error",
      new Error("Port discovery command failed."),
    );
  }

  if (hostPlatform === "darwin") {
    return parseLsofOutput(output.stdout);
  }
  if (hostPlatform === "linux") {
    return parseSsOutput(output.stdout);
  }
  return parseNetstatOutput(output.stdout);
});

export const authenticatePortsTunnel = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthTerminalOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthTerminalOperateScope);
  }
  return session;
});

class PortTunnelIoError extends Schema.TaggedError<PortTunnelIoError>()("PortTunnelIoError", {
  cause: Schema.Defect(),
}) {}

function connectLoopbackTcp(
  targetHost: PortForwardHost,
  targetPort: number,
  signal: AbortSignal,
): Promise<NodeNet.Socket> {
  const tryConnect = (host: string): Promise<NodeNet.Socket> => {
    const resolvers = Promise.withResolvers<NodeNet.Socket>();
    const socket = NodeNet.connect({ host, port: targetPort, allowHalfOpen: true, signal });
    socket.pause();
    socket.once("connect", () => resolvers.resolve(socket));
    // Retain an error observer until the scoped data adapter is attached.
    socket.once("error", (error) => {
      socket.destroy();
      resolvers.reject(error);
    });
    return resolvers.promise;
  };
  if (targetHost !== "localhost") return tryConnect(targetHost);
  return tryConnect("127.0.0.1").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ECONNREFUSED") {
      return tryConnect("::1");
    }
    throw error;
  });
}

/** Native writes must drain before either direction pulls another chunk. */
const awaitDrain = (socket: NodeNet.Socket) =>
  Effect.callback<void, PortTunnelIoError>((resume) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new PortTunnelIoError({ cause })));
    };
    const onClose = () => onError(new Error("TCP transport closed."));
    if (socket.destroyed) {
      onClose();
      return;
    }
    if (!socket.writableNeedDrain) {
      resume(Effect.void);
      return;
    }
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
    return Effect.sync(cleanup);
  });

const finishTcp = (socket: NodeNet.Socket) =>
  Effect.callback<void, PortTunnelIoError>((resume) => {
    const cleanup = () => {
      socket.off("finish", onFinish);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onFinish = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new PortTunnelIoError({ cause })));
    };
    const onClose = () => onError(new Error("TCP target closed before input finished."));
    if (socket.destroyed) {
      onClose();
      return;
    }
    socket.once("finish", onFinish);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.end();
    return Effect.sync(cleanup);
  });

// This remains observable even while the receive fiber is waiting on target backpressure.
const awaitTransportClose = (socket: NodeNet.Socket) =>
  Effect.callback<never, PortTunnelIoError>((resume) => {
    const cleanup = () => {
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new PortTunnelIoError({ cause })));
    };
    const onClose = () => onError(new Error("WebSocket transport closed."));
    if (socket.destroyed) {
      onClose();
      return;
    }
    socket.once("close", onClose);
    socket.once("error", onError);
    return Effect.sync(cleanup);
  });

type TcpReadEvent =
  | { readonly _tag: "data"; readonly data: Buffer }
  | { readonly _tag: "end" }
  | { readonly _tag: "error"; readonly cause: Error };

const handlePortTunnel = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
  const params = url.value.searchParams;
  const rawPort = params.get("port") ?? "";
  const port = decodePort(/^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN);
  const host = decodeHost(params.get("host") ?? "localhost");
  if (Option.isNone(port) || Option.isNone(host) || params.getAll("port").length !== 1) {
    return HttpServerResponse.empty({ status: 400 });
  }
  yield* authenticatePortsTunnel;
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.empty({ status: 400 });
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      // Match the existing preview transport: no compression queue hidden from native drain.
      delete incoming.headers["sec-websocket-extensions"];
      const transport = incoming.socket;
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const connected = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) => connectLoopbackTcp(host.value, port.value, signal),
          catch: (cause) => new PortTunnelIoError({ cause }),
        }).pipe(Effect.timeout("10 seconds")),
        (tcp) => Effect.sync(() => tcp.destroy()),
      ).pipe(Effect.option);
      if (Option.isNone(connected)) {
        yield* writer.write(
          new Socket.CloseEvent(PORT_FORWARD_CONNECT_FAILED, "Target port is not listening."),
        );
        return HttpServerResponse.empty();
      }
      const tcp = connected.value;
      const events = yield* Queue.unbounded<TcpReadEvent>();
      const onData = (data: Buffer) => {
        tcp.pause();
        Queue.offerUnsafe(events, { _tag: "data", data });
      };
      const onEnd = () => {
        Queue.offerUnsafe(events, { _tag: "end" });
      };
      const onError = (cause: Error) => {
        Queue.offerUnsafe(events, { _tag: "error", cause });
      };
      const onClose = () => {
        if (!tcp.readableEnded) onError(new Error("Target TCP connection closed."));
      };
      tcp.on("data", onData);
      tcp.once("end", onEnd);
      tcp.on("error", onError);
      tcp.once("close", onClose);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          tcp.off("data", onData);
          tcp.off("end", onEnd);
          tcp.off("error", onError);
          tcp.off("close", onClose);
          Queue.shutdownUnsafe(events);
        }),
      );
      if (tcp.destroyed) onClose();
      const write = (data: Uint8Array | string) =>
        writer.write(data).pipe(Effect.andThen(awaitDrain(transport)));
      yield* write(PORT_FORWARD_READY);
      const inputEnded = yield* Deferred.make<void, PortTunnelIoError | Socket.SocketError>();
      const outputDrained = yield* Deferred.make<void>();
      let receivedEnd = false;
      let sentEnd = false;
      let receivedDrained = false;
      const send = Effect.gen(function* () {
        while (true) {
          tcp.resume();
          const event = yield* Queue.take(events);
          if (event._tag === "error") return yield* new PortTunnelIoError({ cause: event.cause });
          if (event._tag === "end") {
            sentEnd = true;
            yield* write(PORT_FORWARD_END);
            return;
          }
          yield* write(event.data);
        }
      });
      const receive = Effect.gen(function* () {
        while (true) {
          const chunks = yield* reader.pull;
          for (const chunk of chunks) {
            if (typeof chunk === "string") {
              if (chunk === PORT_FORWARD_DRAINED && sentEnd && !receivedDrained) {
                receivedDrained = true;
                yield* Deferred.succeed(outputDrained, undefined);
                continue;
              }
              if (receivedEnd || chunk !== PORT_FORWARD_END) {
                yield* writer.write(
                  new Socket.CloseEvent(PORT_FORWARD_PROTOCOL_ERROR, "Invalid tunnel control."),
                );
                return yield* new PortTunnelIoError({
                  cause: new Error("Invalid tunnel control."),
                });
              }
              // FIN is queued after all preceding writes, while response reads stay alive.
              receivedEnd = true;
              yield* finishTcp(tcp).pipe(
                Effect.andThen(write(PORT_FORWARD_DRAINED)),
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(inputEnded, exit)),
                Effect.forkScoped,
              );
              continue;
            }
            if (receivedEnd) {
              yield* writer.write(
                new Socket.CloseEvent(PORT_FORWARD_PROTOCOL_ERROR, "Data after tunnel EOF."),
              );
              return yield* new PortTunnelIoError({ cause: new Error("Data after tunnel EOF.") });
            }
            yield* Effect.try({
              try: () => tcp.write(chunk),
              catch: (cause) => new PortTunnelIoError({ cause }),
            });
            yield* awaitDrain(tcp);
          }
        }
      });
      yield* Effect.raceFirst(
        Effect.all([send, Deferred.await(inputEnded), Deferred.await(outputDrained)], {
          concurrency: "unbounded",
        }),
        Effect.raceFirst(receive, awaitTransportClose(transport)),
      );
      yield* writer.write(new Socket.CloseEvent(1000, "Complete"));
      return HttpServerResponse.empty();
    }),
  ).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty())));
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

export const layerPortsHttpApi = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "ports",
  Effect.fnUntraced(function* (handlers) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const hostPlatform = yield* HostProcessPlatform;

    return handlers.handle("list", () =>
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("ports.list");
        const principal = yield* EnvironmentAuthenticatedPrincipal;
        const hasTerminalRead = principal.scopes.has(AuthTerminalReadScope);
        const hasOrchestrationRead = principal.scopes.has(AuthOrchestrationReadScope);
        if (!hasTerminalRead && !hasOrchestrationRead) {
          return yield* failEnvironmentScopeRequired(AuthTerminalReadScope);
        }
        return yield* discoverListeningPorts(processRunner, hostPlatform);
      }),
    );
  }),
);

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const platform = yield* Effect.context<HttpPlatform.HttpPlatform>();

    const services = Layer.succeed(EnvironmentAuth.EnvironmentAuth, serverAuth);

    const wsHandler = handlePortTunnel.pipe(
      Effect.provide(services),
      Effect.provideContext(platform),
    );

    yield* router.add("GET", PORT_FORWARD_ROUTE, wsHandler);
  }),
);
