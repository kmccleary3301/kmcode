// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Port forwarding owns raw TCP loopback listeners and timers.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import type {
  EnvironmentId,
  ForwardedPort,
  PortForwardConnectionRequest,
  PortForwardConnectionResolution,
  PortForwardHost,
  PortForwardKey,
  PortForwardStart,
} from "@t3tools/contracts";
import {
  PORT_FORWARD_DRAINED,
  PORT_FORWARD_END,
  PORT_FORWARD_PROTOCOL_ERROR,
  PORT_FORWARD_READY,
  PORT_FORWARD_ROUTE,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Electron from "electron";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const DEFAULT_TICKET_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const HIGH_WATER_MARK_BYTES = 64 * 1024;
const LOW_WATER_MARK_BYTES = 16 * 1024;

export class PortForwardConflictError extends Schema.TaggedError<PortForwardConflictError>()(
  "PortForwardConflictError",
  {
    message: Schema.String,
    localPort: Schema.Int,
  },
) {}

export class PortForwardBindError extends Schema.TaggedError<PortForwardBindError>()(
  "PortForwardBindError",
  {
    message: Schema.String,
    localPort: Schema.Int,
  },
) {}

interface StreamContext {
  readonly streamId: string;
  readonly ws: WebSocket;
  readonly localSocket: NodeNet.Socket;
  readonly close: () => void;
}

interface ForwardedPortEntry {
  readonly environmentId: EnvironmentId;
  readonly remotePort: number;
  readonly remoteHost: PortForwardHost;
  readonly localPort: number;
  readonly ownerWebContentsId?: number | undefined;
  origin: "user" | "auto";
  readonly ipv4Server: NodeNet.Server;
  readonly ipv6Server: NodeNet.Server | null;
  activeConnections: number;
  status: "listening" | "forwarding" | "error";
  error: string | null;
  readonly streams: Record<string, StreamContext>;
}

interface PendingConnection {
  readonly requestId: string;
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly remotePort: number;
  readonly remoteHost: PortForwardHost;
  readonly localPort: number;
  readonly tcpSocket: NodeNet.Socket;
  readonly timeoutFiber: Fiber.Fiber<void, never>;
  readonly ownerWebContentsId?: number | undefined;
  readonly bufferedChunks: Buffer[];
  clientHalfClosed: boolean;
  readonly detachEarlyListeners: () => void;
  isResolved: boolean;
}

export interface PortForwardOwner extends NodeJS.EventEmitter {
  isDestroyed(): boolean;
  send(channel: string, ...args: readonly unknown[]): void;
}

interface OwnerHook {
  readonly ownerWebContentsId: number;
  readonly contents: PortForwardOwner;
  isInvalidated: boolean;
  readonly onExit: () => void;
  readonly onNavigation: (event: {
    readonly isSameDocument?: boolean;
    readonly isMainFrame?: boolean;
  }) => void;
  readonly keys: Record<string, boolean>;
}

export interface PortForwardManagerOptions {
  readonly ticketTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly getWebContents?: (id: number) => PortForwardOwner | null | undefined;
}

const portKey = (
  environmentId: EnvironmentId,
  remoteHost: PortForwardHost,
  remotePort: number,
): string => `${environmentId}:${remoteHost}:${remotePort}`;

const entryToForwardedPort = (entry: ForwardedPortEntry): ForwardedPort => ({
  environmentId: entry.environmentId,
  remotePort: entry.remotePort,
  remoteHost: entry.remoteHost,
  localPort: entry.localPort,
  localAddress: `127.0.0.1:${entry.localPort}`,
  status: entry.status,
  error: entry.error,
  activeConnections: entry.activeConnections,
  origin: entry.origin,
});

const toBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

const sanitizeUrlForLogs = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid URL>";
  }
};

const validateSocketUrl = (
  rawUrl: string,
  expectedPort: number,
  expectedHost: PortForwardHost,
): boolean => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return false;
    }
    if (parsed.pathname !== PORT_FORWARD_ROUTE) {
      return false;
    }
    const portParam = parsed.searchParams.get("port");
    const hostParam = parsed.searchParams.get("host");
    if (portParam !== String(expectedPort)) {
      return false;
    }
    if (hostParam !== expectedHost) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

export interface PortForwardManagerService {
  readonly list: Effect.Effect<ForwardedPort[]>;
  readonly start: (
    input: PortForwardStart,
    ownerWebContentsId?: number | undefined,
  ) => Effect.Effect<ForwardedPort, PortForwardConflictError | PortForwardBindError>;
  readonly stop: (input: PortForwardKey) => Effect.Effect<void>;
  /** Closes every forward and broadcasts one change; succeeds with the number closed. */
  readonly stopAll: Effect.Effect<number>;
  readonly stopForOwner: (ownerWebContentsId: number) => Effect.Effect<void>;
  readonly resolveConnection: (
    input: PortForwardConnectionResolution,
    ownerWebContentsId?: number | undefined,
  ) => Effect.Effect<void>;
  readonly cancelPendingRequestsForSender: (senderWebContentsId: number) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

export class PortForwardManager extends Context.Service<
  PortForwardManager,
  PortForwardManagerService
>()("@t3tools/desktop/ports/PortForwardManager") {}

export const make = (options?: PortForwardManagerOptions) =>
  Effect.gen(function* () {
    const managerScope = yield* Effect.scope;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const runPromise = Effect.runPromiseWith(context);
    const lifecycleMutex = yield* Semaphore.make(1);

    const ticketTimeoutMs = options?.ticketTimeoutMs ?? DEFAULT_TICKET_TIMEOUT_MS;
    const readyTimeoutMs = options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    const getWebContents = (id: number): PortForwardOwner | null => {
      if (options?.getWebContents !== undefined) {
        return options.getWebContents(id) ?? null;
      }
      try {
        return Electron.webContents.fromId(id) ?? null;
      } catch {
        return null;
      }
    };

    const entries: Record<string, ForwardedPortEntry> = {};
    const portToKey: Record<number, string> = {};
    const pendingRequests: Record<string, PendingConnection> = {};
    const ownerHooks: Record<number, OwnerHook> = {};
    let isDisposed = false;

    const getSnapshotList = (): ForwardedPort[] => {
      const result: ForwardedPort[] = [];
      for (const port in portToKey) {
        const key = portToKey[port];
        if (key !== undefined) {
          const entry = entries[key];
          if (entry !== undefined) {
            result.push(entryToForwardedPort(entry));
          }
        }
      }
      return result;
    };

    const notifyChanged = () => {
      const snapshot = getSnapshotList();
      void runPromise(
        electronWindow
          .sendAll(IpcChannels.PORT_FORWARD_CHANGED_CHANNEL, snapshot)
          .pipe(Effect.ignore),
      );
    };

    const cleanupPending = (requestId: string) => {
      const req = pendingRequests[requestId];
      if (req === undefined || req.isResolved) return;
      req.isResolved = true;
      delete pendingRequests[requestId];

      runFork(Fiber.interrupt(req.timeoutFiber));
      req.detachEarlyListeners();
      req.tcpSocket.destroy();

      const entry = entries[req.key];
      if (entry !== undefined) {
        entry.activeConnections = Math.max(0, entry.activeConnections - 1);
        if (entry.activeConnections === 0 && entry.status === "forwarding") {
          entry.status = "listening";
        }
      }
      notifyChanged();
    };

    const detachOwner = (ownerWebContentsId: number) => {
      const hook = ownerHooks[ownerWebContentsId];
      if (hook === undefined) return;
      delete ownerHooks[ownerWebContentsId];
      try {
        if (!hook.contents.isDestroyed()) {
          hook.contents.off("destroyed", hook.onExit);
          hook.contents.off("render-process-gone", hook.onExit);
          hook.contents.off("did-start-navigation", hook.onNavigation);
        }
      } catch {
        // ignore
      }
    };

    const registerOwnerForForward = (ownerWebContentsId: number, key: string): boolean => {
      let hook = ownerHooks[ownerWebContentsId];
      if (hook === undefined) {
        const contents = getWebContents(ownerWebContentsId);
        if (!contents || contents.isDestroyed()) return false;

        const onOwnerExit = () => {
          newHook.isInvalidated = true;
          detachOwner(ownerWebContentsId);
          void runPromise(
            cancelPendingRequestsForSender(ownerWebContentsId).pipe(
              Effect.andThen(stopForOwner(ownerWebContentsId)),
              Effect.ignore,
            ),
          );
        };

        const onNavigation = (event: {
          readonly isSameDocument?: boolean;
          readonly isMainFrame?: boolean;
        }) => {
          if (event.isSameDocument) return;
          if (event.isMainFrame === false) return;
          newHook.isInvalidated = true;
          detachOwner(ownerWebContentsId);
          void runPromise(
            cancelPendingRequestsForSender(ownerWebContentsId).pipe(
              Effect.andThen(stopForOwner(ownerWebContentsId)),
              Effect.ignore,
            ),
          );
        };

        const newHook: OwnerHook = {
          ownerWebContentsId,
          contents,
          isInvalidated: false,
          onExit: onOwnerExit,
          onNavigation,
          keys: {},
        };
        hook = newHook;
        ownerHooks[ownerWebContentsId] = newHook;
        contents.once("destroyed", onOwnerExit);
        contents.once("render-process-gone", onOwnerExit);
        contents.on("did-start-navigation", onNavigation);
      }

      if (hook.isInvalidated) return false;
      hook.keys[key] = true;
      return true;
    };

    const unregisterOwnerForForward = (ownerWebContentsId: number, key: string) => {
      const hook = ownerHooks[ownerWebContentsId];
      if (hook === undefined) return;
      delete hook.keys[key];
      if (Object.keys(hook.keys).length === 0) {
        detachOwner(ownerWebContentsId);
      }
    };

    const detachAllOwners = () => {
      for (const id in ownerHooks) {
        detachOwner(Number(id));
      }
    };

    const handleIncomingTcpConnection = (
      entry: ForwardedPortEntry,
      tcpSocket: NodeNet.Socket,
      key: string,
      environmentId: EnvironmentId,
      remotePort: number,
      remoteHost: PortForwardHost,
      localPort: number,
      ownerWebContentsId?: number | undefined,
    ) => {
      if (entry === undefined) {
        tcpSocket.destroy();
        return;
      }

      entry.activeConnections += 1;
      entry.status = "forwarding";
      notifyChanged();

      const requestId = NodeCrypto.randomUUID();

      const bufferedChunks: Buffer[] = [];
      let bufferedBytes = 0;
      let clientHalfClosed = false;

      const onData = (chunk: Buffer) => {
        bufferedChunks.push(chunk);
        bufferedBytes += chunk.length;
        if (bufferedBytes >= HIGH_WATER_MARK_BYTES) {
          tcpSocket.pause();
        }
      };

      const onEnd = () => {
        clientHalfClosed = true;
        const pending = pendingRequests[requestId];
        if (pending !== undefined) {
          pending.clientHalfClosed = true;
        }
      };

      const onEarlyDrop = () => {
        cleanupPending(requestId);
      };

      tcpSocket.on("data", onData);
      tcpSocket.once("end", onEnd);
      tcpSocket.once("error", onEarlyDrop);
      tcpSocket.once("close", onEarlyDrop);
      tcpSocket.resume();

      const detachEarlyListeners = () => {
        tcpSocket.removeListener("data", onData);
        tcpSocket.removeListener("end", onEnd);
        tcpSocket.removeListener("error", onEarlyDrop);
        tcpSocket.removeListener("close", onEarlyDrop);
      };

      const timeoutFiber = runFork(
        Effect.sleep(Duration.millis(ticketTimeoutMs)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              cleanupPending(requestId);
            }),
          ),
        ),
      );

      const pending: PendingConnection = {
        requestId,
        key,
        environmentId,
        remotePort,
        remoteHost,
        localPort,
        tcpSocket,
        timeoutFiber,
        ownerWebContentsId,
        bufferedChunks,
        clientHalfClosed,
        detachEarlyListeners,
        isResolved: false,
      };

      pendingRequests[requestId] = pending;

      const requestPayload: PortForwardConnectionRequest = {
        requestId,
        environmentId,
        remotePort,
        remoteHost,
      };

      if (ownerWebContentsId !== undefined) {
        try {
          const contents = getWebContents(ownerWebContentsId);
          if (contents && !contents.isDestroyed()) {
            contents.send(IpcChannels.PORT_FORWARD_CONNECTION_REQUEST_CHANNEL, requestPayload);
            return;
          }
        } catch {
          // ignore
        }
      }

      void runPromise(
        electronWindow
          .sendAll(IpcChannels.PORT_FORWARD_CONNECTION_REQUEST_CHANNEL, requestPayload)
          .pipe(Effect.ignore),
      );
    };

    const startStream = (
      entry: ForwardedPortEntry,
      localSocket: NodeNet.Socket,
      socketUrl: string,
      preBufferedChunks: Buffer[],
      initialClientHalfClosed: boolean,
    ) => {
      const streamId = NodeCrypto.randomUUID();
      const ws = new WebSocket(socketUrl);

      let isCleanedUp = false;
      let isReady = false;
      let tcpReadDone = initialClientHalfClosed;
      let sentEnd = false;
      let receivedEnd = false;
      let tcpWriteDone = false;
      let sentDrained = false;
      let receivedDrained = false;
      let clientEnded = initialClientHalfClosed;
      let drainTimer: NodeJS.Timeout | null = null;

      const abortCleanup = (errorReason?: string, protocolErrorCode?: number) => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        runFork(Fiber.interrupt(readyTimeoutFiber));
        if (drainTimer !== null) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }

        localSocket.destroy();
        try {
          if (protocolErrorCode !== undefined) {
            ws.close(protocolErrorCode, errorReason);
          } else {
            ws.terminate();
          }
        } catch {
          // ignore
        }

        delete entry.streams[streamId];
        entry.activeConnections = Math.max(0, entry.activeConnections - 1);
        if (errorReason !== undefined) {
          entry.status = "error";
          entry.error = errorReason;
        } else if (entry.activeConnections === 0 && entry.status === "forwarding") {
          entry.status = "listening";
        }
        notifyChanged();
      };

      const checkNormalCompletion = () => {
        if (isCleanedUp) return;
        if (
          tcpReadDone &&
          sentEnd &&
          receivedEnd &&
          tcpWriteDone &&
          sentDrained &&
          receivedDrained
        ) {
          isCleanedUp = true;

          runFork(Fiber.interrupt(readyTimeoutFiber));
          if (drainTimer !== null) {
            clearTimeout(drainTimer);
            drainTimer = null;
          }

          try {
            ws.close(1000);
          } catch {
            // ignore
          }

          delete entry.streams[streamId];
          entry.activeConnections = Math.max(0, entry.activeConnections - 1);
          if (entry.activeConnections === 0 && entry.status === "forwarding") {
            entry.status = "listening";
          }
          notifyChanged();
        }
      };

      const sendLocalEnd = () => {
        if (sentEnd) return;
        sentEnd = true;
        tcpReadDone = true;
        ws.send(PORT_FORWARD_END, (err) => {
          if (isCleanedUp) return;
          if (err) {
            abortCleanup(`WebSocket send END error: ${err.message}`);
            return;
          }
          checkNormalCompletion();
        });
      };

      const readyTimeoutFiber = runFork(
        Effect.sleep(Duration.millis(readyTimeoutMs)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!isCleanedUp && !isReady) {
                abortCleanup("Ready timeout: remote tunnel did not send ready signal");
              }
            }),
          ),
        ),
      );

      entry.streams[streamId] = {
        streamId,
        ws,
        localSocket,
        close: () => abortCleanup(),
      };

      ws.on("open", () => {
        // Waiting for server ready control frame
      });

      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isCleanedUp) return;

        if (!isBinary) {
          const text = data.toString("utf-8");
          if (!isReady) {
            if (text === PORT_FORWARD_READY) {
              isReady = true;
              runFork(Fiber.interrupt(readyTimeoutFiber));
              for (const chunk of preBufferedChunks) {
                ws.send(chunk, { binary: true });
              }
              if (clientEnded) {
                sendLocalEnd();
              } else {
                localSocket.resume();
              }
            } else {
              abortCleanup(`Unexpected control before ready: ${text}`, PORT_FORWARD_PROTOCOL_ERROR);
            }
            return;
          }

          if (text === PORT_FORWARD_END) {
            if (receivedEnd) {
              abortCleanup(
                "Protocol error: duplicate END control received",
                PORT_FORWARD_PROTOCOL_ERROR,
              );
              return;
            }
            receivedEnd = true;
            localSocket.end(() => {
              if (isCleanedUp) return;
              tcpWriteDone = true;
              ws.send(PORT_FORWARD_DRAINED, (err) => {
                if (isCleanedUp) return;
                if (err) {
                  abortCleanup(`WebSocket send DRAINED error: ${err.message}`);
                  return;
                }
                sentDrained = true;
                checkNormalCompletion();
              });
            });
            return;
          }

          if (text === PORT_FORWARD_DRAINED) {
            if (!sentEnd || receivedDrained) {
              abortCleanup(
                "Protocol error: unexpected or duplicate DRAINED control",
                PORT_FORWARD_PROTOCOL_ERROR,
              );
              return;
            }
            receivedDrained = true;
            checkNormalCompletion();
            return;
          }

          abortCleanup(`Unknown control message: ${text}`, PORT_FORWARD_PROTOCOL_ERROR);
          return;
        }

        if (!isReady) {
          abortCleanup(
            "Protocol error: binary data received before ready frame",
            PORT_FORWARD_PROTOCOL_ERROR,
          );
          return;
        }

        const chunk = toBuffer(data);
        const canAccept = localSocket.write(chunk);
        if (!canAccept) {
          ws.pause();
          localSocket.once("drain", () => {
            if (!isCleanedUp) {
              ws.resume();
            }
          });
        }
      });

      localSocket.on("data", (chunk: Buffer) => {
        if (isCleanedUp) return;
        if (!isReady) {
          preBufferedChunks.push(chunk);
          let totalBytes = 0;
          for (const c of preBufferedChunks) totalBytes += c.length;
          if (totalBytes >= HIGH_WATER_MARK_BYTES) {
            localSocket.pause();
          }
          return;
        }

        localSocket.pause();
        ws.send(chunk, { binary: true }, (err) => {
          if (isCleanedUp) return;
          if (err) {
            abortCleanup(`WebSocket send error: ${err.message}`);
            return;
          }
          if (ws.bufferedAmount > HIGH_WATER_MARK_BYTES) {
            const checkDrain = () => {
              drainTimer = null;
              if (isCleanedUp) return;
              if (ws.bufferedAmount <= LOW_WATER_MARK_BYTES) {
                localSocket.resume();
              } else {
                drainTimer = setTimeout(checkDrain, 10);
              }
            };
            drainTimer = setTimeout(checkDrain, 10);
          } else {
            localSocket.resume();
          }
        });
      });

      localSocket.on("end", () => {
        if (isCleanedUp) return;
        clientEnded = true;
        tcpReadDone = true;
        if (!isReady) {
          return;
        }
        sendLocalEnd();
      });

      localSocket.on("error", (err: NodeJS.ErrnoException) => {
        if (isCleanedUp) return;
        abortCleanup(`Local socket error: ${err.message}`);
      });

      localSocket.on("close", (hadError: boolean) => {
        if (isCleanedUp) return;
        if (!tcpWriteDone || hadError) {
          abortCleanup(
            hadError ? "Local socket closed with error" : "Local socket closed prematurely",
          );
        } else {
          tcpReadDone = true;
          checkNormalCompletion();
        }
      });

      ws.on("error", (err: Error) => {
        if (isCleanedUp) return;
        abortCleanup(`Tunnel error: ${err.message}`);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        if (isCleanedUp) return;
        const isNormal =
          code === 1000 &&
          tcpReadDone &&
          sentEnd &&
          receivedEnd &&
          tcpWriteDone &&
          sentDrained &&
          receivedDrained;

        if (!isNormal) {
          abortCleanup(
            `Remote tunnel closed prematurely (${code}): ${reason.toString("utf-8") || "connection lost"}`,
          );
        } else {
          checkNormalCompletion();
        }
      });
    };

    const bindIpv4 = (
      localPort: number,
    ): Effect.Effect<NodeNet.Server, PortForwardConflictError | PortForwardBindError> =>
      Effect.callback<NodeNet.Server, PortForwardConflictError | PortForwardBindError>((resume) => {
        const server = NodeNet.createServer({ allowHalfOpen: true, pauseOnConnect: true });
        server.once("error", (err: NodeJS.ErrnoException) => {
          try {
            server.close();
          } catch {
            // ignore
          }
          if (err.code === "EADDRINUSE") {
            resume(
              Effect.fail(
                new PortForwardConflictError({
                  message: `Port ${localPort} already in use on 127.0.0.1`,
                  localPort,
                }),
              ),
            );
          } else {
            resume(
              Effect.fail(
                new PortForwardBindError({
                  message: `Failed to bind port ${localPort} on 127.0.0.1: ${err.message}`,
                  localPort,
                }),
              ),
            );
          }
        });
        server.listen({ host: "127.0.0.1", port: localPort }, () => {
          resume(Effect.succeed(server));
        });
      });

    const bindIpv6 = (
      localPort: number,
    ): Effect.Effect<NodeNet.Server | null, PortForwardConflictError | PortForwardBindError> =>
      Effect.callback<NodeNet.Server | null, PortForwardConflictError | PortForwardBindError>(
        (resume) => {
          const server = NodeNet.createServer({ allowHalfOpen: true, pauseOnConnect: true });
          server.once("error", (err: NodeJS.ErrnoException) => {
            try {
              server.close();
            } catch {
              // ignore
            }
            if (err.code === "EADDRINUSE") {
              resume(
                Effect.fail(
                  new PortForwardConflictError({
                    message: `Port ${localPort} already in use on ::1`,
                    localPort,
                  }),
                ),
              );
            } else {
              const isUnsupported =
                err.code === "EAFNOSUPPORT" ||
                err.code === "EADDRNOTAVAIL" ||
                err.code === "ENOTSUP" ||
                err.code === "EPROTONOSUPPORT";
              if (isUnsupported) {
                resume(Effect.succeed(null));
              } else {
                resume(
                  Effect.fail(
                    new PortForwardBindError({
                      message: `Failed to bind port ${localPort} on ::1: ${err.message}`,
                      localPort,
                    }),
                  ),
                );
              }
            }
          });
          server.listen({ host: "::1", port: localPort }, () => {
            resume(Effect.succeed(server));
          });
        },
      );

    const startUnlocked = (
      input: PortForwardStart,
      ownerWebContentsId?: number | undefined,
    ): Effect.Effect<ForwardedPort, PortForwardConflictError | PortForwardBindError> =>
      Effect.gen(function* () {
        if (isDisposed) {
          return yield* new PortForwardBindError({
            message: "Port forward manager is disposed",
            localPort: input.localPort,
          });
        }

        const key = portKey(input.environmentId, input.remoteHost, input.remotePort);
        const existing = entries[key];
        if (existing !== undefined) {
          if (existing.localPort !== input.localPort) {
            return yield* new PortForwardConflictError({
              message: `This target is already forwarded on port ${existing.localPort}; stop it before choosing port ${input.localPort}`,
              localPort: input.localPort,
            });
          }
          if (input.origin === "user" && existing.origin === "auto") {
            existing.origin = "user";
            notifyChanged();
          }
          return entryToForwardedPort(existing);
        }

        if (portToKey[input.localPort] !== undefined) {
          return yield* new PortForwardConflictError({
            message: `Port ${input.localPort} is already forwarded by another rule`,
            localPort: input.localPort,
          });
        }

        if (ownerWebContentsId !== undefined) {
          const registered = registerOwnerForForward(ownerWebContentsId, key);
          if (!registered) {
            return yield* new PortForwardBindError({
              message: `Owner webContents ${ownerWebContentsId} is not available`,
              localPort: input.localPort,
            });
          }
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (entries[key] === undefined && ownerWebContentsId !== undefined) {
              unregisterOwnerForForward(ownerWebContentsId, key);
            }
          }),
        );
        const ipv4Server = yield* Effect.acquireRelease(bindIpv4(input.localPort), (server) =>
          Effect.sync(() => {
            if (entries[key]?.ipv4Server !== server && server.listening) server.close();
          }),
        );

        if (ownerWebContentsId !== undefined) {
          const hook = ownerHooks[ownerWebContentsId];
          if (hook === undefined || hook.isInvalidated) {
            try {
              ipv4Server.close();
            } catch {
              // ignore
            }
            unregisterOwnerForForward(ownerWebContentsId, key);
            return yield* new PortForwardBindError({
              message: `Owner webContents ${ownerWebContentsId} was invalidated during bind`,
              localPort: input.localPort,
            });
          }
        }

        const ipv6Server = yield* Effect.acquireRelease(bindIpv6(input.localPort), (server) =>
          Effect.sync(() => {
            if (server !== null && entries[key]?.ipv6Server !== server && server.listening) {
              server.close();
            }
          }),
        );

        if (ownerWebContentsId !== undefined) {
          const hook = ownerHooks[ownerWebContentsId];
          if (hook === undefined || hook.isInvalidated) {
            try {
              ipv4Server.close();
            } catch {
              // ignore
            }
            try {
              ipv6Server?.close();
            } catch {
              // ignore
            }
            unregisterOwnerForForward(ownerWebContentsId, key);
            return yield* new PortForwardBindError({
              message: `Owner webContents ${ownerWebContentsId} was invalidated during bind`,
              localPort: input.localPort,
            });
          }
        }

        const entry: ForwardedPortEntry = {
          environmentId: input.environmentId,
          remotePort: input.remotePort,
          remoteHost: input.remoteHost,
          localPort: input.localPort,
          ownerWebContentsId,
          origin: input.origin,
          ipv4Server,
          ipv6Server,
          activeConnections: 0,
          status: "listening",
          error: null,
          streams: {},
        };

        entries[key] = entry;
        portToKey[input.localPort] = key;

        ipv4Server.on("connection", (socket: NodeNet.Socket) => {
          handleIncomingTcpConnection(
            entry,
            socket,
            key,
            input.environmentId,
            input.remotePort,
            input.remoteHost,
            input.localPort,
            ownerWebContentsId,
          );
        });

        if (ipv6Server !== null) {
          ipv6Server.on("connection", (socket: NodeNet.Socket) => {
            handleIncomingTcpConnection(
              entry,
              socket,
              key,
              input.environmentId,
              input.remotePort,
              input.remoteHost,
              input.localPort,
              ownerWebContentsId,
            );
          });
        }

        notifyChanged();
        return entryToForwardedPort(entry);
      }).pipe(Effect.scoped);

    // Tears down one entry without broadcasting, so bulk stops can notify once.
    const removeEntryUnlocked = (key: string): boolean => {
      const entry = entries[key];
      if (entry === undefined) return false;

      try {
        entry.ipv4Server.close();
      } catch {
        // ignore
      }
      try {
        entry.ipv6Server?.close();
      } catch {
        // ignore
      }

      for (const streamId in entry.streams) {
        const stream = entry.streams[streamId];
        if (stream !== undefined) {
          stream.close();
        }
      }

      for (const reqId in pendingRequests) {
        const req = pendingRequests[reqId];
        if (req !== undefined && req.key === key) {
          delete pendingRequests[reqId];
          runFork(Fiber.interrupt(req.timeoutFiber));
          req.detachEarlyListeners();
          req.tcpSocket.destroy();
        }
      }

      if (entry.ownerWebContentsId !== undefined) {
        unregisterOwnerForForward(entry.ownerWebContentsId, key);
      }

      delete entries[key];
      delete portToKey[entry.localPort];
      return true;
    };

    const removeMatchingUnlocked = (matches: (entry: ForwardedPortEntry) => boolean): number => {
      let removed = 0;
      for (const key in entries) {
        const entry = entries[key];
        if (entry !== undefined && matches(entry) && removeEntryUnlocked(key)) removed += 1;
      }
      if (removed > 0) notifyChanged();
      return removed;
    };

    const start = (
      input: PortForwardStart,
      ownerWebContentsId?: number | undefined,
    ): Effect.Effect<ForwardedPort, PortForwardConflictError | PortForwardBindError> =>
      lifecycleMutex.withPermits(1)(startUnlocked(input, ownerWebContentsId));

    const stop = (input: PortForwardKey): Effect.Effect<void> =>
      lifecycleMutex.withPermits(1)(
        Effect.sync(() => {
          if (
            removeEntryUnlocked(portKey(input.environmentId, input.remoteHost, input.remotePort))
          ) {
            notifyChanged();
          }
        }),
      );

    const stopAll: Effect.Effect<number> = lifecycleMutex.withPermits(1)(
      Effect.sync(() => removeMatchingUnlocked(() => true)),
    );

    const stopForOwner = (ownerWebContentsId: number): Effect.Effect<void> =>
      lifecycleMutex.withPermits(1)(
        Effect.sync(() => {
          removeMatchingUnlocked((entry) => entry.ownerWebContentsId === ownerWebContentsId);
        }),
      );

    const cancelPendingRequestsForSender = (senderWebContentsId: number): Effect.Effect<void> =>
      Effect.sync(() => {
        const toCancel: PendingConnection[] = [];
        for (const reqId in pendingRequests) {
          const req = pendingRequests[reqId];
          if (req !== undefined && req.ownerWebContentsId === senderWebContentsId) {
            toCancel.push(req);
            delete pendingRequests[reqId];
          }
        }

        for (const req of toCancel) {
          runFork(Fiber.interrupt(req.timeoutFiber));
          req.detachEarlyListeners();
          req.tcpSocket.destroy();
          const entry = entries[req.key];
          if (entry !== undefined) {
            entry.activeConnections = Math.max(0, entry.activeConnections - 1);
            if (entry.activeConnections === 0 && entry.status === "forwarding") {
              entry.status = "listening";
            }
          }
        }
        if (toCancel.length > 0) {
          notifyChanged();
        }
      });

    const resolveConnection = (
      input: PortForwardConnectionResolution,
      ownerWebContentsId?: number | undefined,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const req = pendingRequests[input.requestId];
        if (req === undefined || req.isResolved) return;

        const entry = entries[req.key];
        if (entry === undefined) {
          req.detachEarlyListeners();
          req.tcpSocket.destroy();
          delete pendingRequests[input.requestId];
          return;
        }

        if (
          entry.ownerWebContentsId !== undefined &&
          (ownerWebContentsId === undefined || ownerWebContentsId !== entry.ownerWebContentsId)
        ) {
          return;
        }

        delete pendingRequests[input.requestId];
        req.isResolved = true;
        runFork(Fiber.interrupt(req.timeoutFiber));
        req.detachEarlyListeners();

        if (input.error !== undefined || input.socketUrl === undefined) {
          req.tcpSocket.destroy();
          entry.activeConnections = Math.max(0, entry.activeConnections - 1);
          if (input.error !== undefined) {
            entry.status = "error";
            entry.error = input.error;
          } else if (entry.activeConnections === 0 && entry.status === "forwarding") {
            entry.status = "listening";
          }
          notifyChanged();
          return;
        }

        const socketUrl = input.socketUrl;
        if (!validateSocketUrl(socketUrl, req.remotePort, req.remoteHost)) {
          req.tcpSocket.destroy();
          entry.activeConnections = Math.max(0, entry.activeConnections - 1);
          entry.status = "error";
          entry.error = `Invalid tunnel socket URL: ${sanitizeUrlForLogs(socketUrl)}`;
          notifyChanged();
          return;
        }

        startStream(entry, req.tcpSocket, socketUrl, req.bufferedChunks, req.clientHalfClosed);
      });

    const dispose = Effect.sync(() => {
      if (isDisposed) return;
      isDisposed = true;

      for (const key in entries) {
        const entry = entries[key];
        if (entry !== undefined) {
          try {
            entry.ipv4Server.close();
          } catch {
            // ignore
          }
          try {
            entry.ipv6Server?.close();
          } catch {
            // ignore
          }
          for (const streamId in entry.streams) {
            const stream = entry.streams[streamId];
            if (stream !== undefined) {
              stream.close();
            }
          }
        }
      }

      for (const reqId in pendingRequests) {
        const req = pendingRequests[reqId];
        if (req !== undefined) {
          runFork(Fiber.interrupt(req.timeoutFiber));
          req.detachEarlyListeners();
          req.tcpSocket.destroy();
        }
      }

      detachAllOwners();

      for (const key in entries) {
        delete entries[key];
      }
      for (const port in portToKey) {
        delete portToKey[port];
      }
      for (const reqId in pendingRequests) {
        delete pendingRequests[reqId];
      }

      notifyChanged();
    });

    yield* Scope.addFinalizer(managerScope, dispose);

    return {
      list: Effect.sync(() => getSnapshotList()),
      start,
      stop,
      stopAll,
      stopForOwner,
      resolveConnection,
      cancelPendingRequestsForSender,
      dispose,
    } satisfies PortForwardManagerService;
  });

export const layer = Layer.effect(PortForwardManager, make());
export const layerWithOptions = (options: PortForwardManagerOptions) =>
  Layer.effect(PortForwardManager, make(options));
