// @effect-diagnostics nodeBuiltinImport:off - Native fixtures hash streamed TCP bytes.
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  EnvironmentHttpApi,
  PORT_FORWARD_CONNECT_FAILED,
  PORT_FORWARD_DRAINED,
  PORT_FORWARD_END,
  PORT_FORWARD_READY,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpRouter, HttpServer } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ProcessRunner from "../processRunner.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { layerPortsHttpApi, routeLayer } from "./PortRoutes.ts";

class PortsTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.ports) {}
const platformLayer = NodeHttpPlatform.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Etag.layerWeak),
);

const makeAuth = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  error?: EnvironmentAuth.ServerAuthCredentialError,
) => {
  return Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: (_request) =>
      error
        ? Effect.fail(error)
        : Effect.succeed({
            sessionId: AuthSessionId.make("port-test"),
            subject: "port-test",
            method: "bearer-access-token",
            scopes,
          }),
    authenticateWebSocketUpgrade: (_request) =>
      error
        ? Effect.fail(error)
        : Effect.succeed({
            sessionId: AuthSessionId.make("port-test"),
            subject: "port-test",
            method: "bearer-access-token",
            scopes,
          }),
  });
};

const makeMockProcessRunner = (lsofStdout: string) => {
  return Layer.mock(ProcessRunner.ProcessRunner, {
    run: () =>
      Effect.succeed({
        stdout: lsofStdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });
};

const makeTestServerOrigin = () =>
  Effect.gen(function* () {
    const runnerLayer = makeMockProcessRunner("");
    const hostLayer = Layer.succeed(HostProcessPlatform, "darwin");
    const authLayer = makeAuth([AuthTerminalOperateScope]);

    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(runnerLayer),
          Layer.provide(hostLayer),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(authLayer)),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    return HttpServer.formatAddress(server.address).replace(/^http/, "ws");
  });

describe("PortRoutes live tests", () => {
  it.live("GET /api/ports enforces authentication and scopes", () =>
    Effect.gen(function* () {
      const mockLsof = "p1234\ncnode\nn127.0.0.1:3000\n";
      const runnerLayer = makeMockProcessRunner(mockLsof);
      const hostLayer = Layer.succeed(HostProcessPlatform, "darwin");

      const makeWebHandler = (auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth>) => {
        const layerApp = HttpApiBuilder.layer(PortsTestApi).pipe(
          Layer.provide(layerPortsHttpApi),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(auth),
          Layer.provide(runnerLayer),
          Layer.provide(hostLayer),
          Layer.provide(platformLayer),
        );
        return HttpRouter.toWebHandler(layerApp, { disableLogger: true });
      };

      // 1. Unauthorized
      const unauth = makeWebHandler(
        makeAuth([], new EnvironmentAuth.ServerAuthMissingCredentialError({})),
      );
      yield* Effect.addFinalizer(() => Effect.promise(unauth.dispose));
      const resUnauth = yield* Effect.promise(() =>
        unauth.handler(new Request("http://t3.test/api/ports")),
      );
      expect(resUnauth.status).toBe(401);

      // 2. Read-only terminal scope: allowed
      const readHandler = makeWebHandler(makeAuth([AuthTerminalReadScope]));
      yield* Effect.addFinalizer(() => Effect.promise(readHandler.dispose));
      const resRead = yield* Effect.promise(() =>
        readHandler.handler(
          new Request("http://t3.test/api/ports", {
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      );
      expect(resRead.status).toBe(200);
      const data = yield* Effect.promise(() => resRead.json());
      expect(data).toEqual([
        {
          port: 3000,
          host: "127.0.0.1",
          processName: "node",
          pid: 1234,
        },
      ]);

      // 3. Orchestration read scope: allowed
      const orchReadHandler = makeWebHandler(makeAuth([AuthOrchestrationReadScope]));
      yield* Effect.addFinalizer(() => Effect.promise(orchReadHandler.dispose));
      const resOrchRead = yield* Effect.promise(() =>
        orchReadHandler.handler(
          new Request("http://t3.test/api/ports", {
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      );
      expect(resOrchRead.status).toBe(200);

      // 4. Operate only scope: insufficient scope (403)
      const operateHandler = makeWebHandler(makeAuth([AuthTerminalOperateScope]));
      yield* Effect.addFinalizer(() => Effect.promise(operateHandler.dispose));
      const resOperate = yield* Effect.promise(() =>
        operateHandler.handler(
          new Request("http://t3.test/api/ports", {
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      );
      expect(resOperate.status).toBe(403);
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports/ws enforces operate scope and validates parameters", () =>
    Effect.gen(function* () {
      const runnerLayer = makeMockProcessRunner("");
      const hostLayer = Layer.succeed(HostProcessPlatform, "darwin");

      // 1. Read-only scope cannot tunnel (must return 403)
      const readOnlyHandler = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            routeLayer.pipe(
              Layer.provide(makeAuth([AuthTerminalReadScope])),
              Layer.provide(runnerLayer),
              Layer.provide(hostLayer),
              Layer.provide(platformLayer),
            ),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(dispose),
      );
      const resReadOnly = yield* Effect.promise(() =>
        readOnlyHandler.handler(
          new Request("http://t3.test/api/ports/ws?port=3000&host=localhost", {
            headers: { upgrade: "websocket" },
          }),
        ),
      );
      expect(resReadOnly.status).toBe(403);

      // 2. Operative scope with invalid host (non-loopback) must return 400
      const operateHandler = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            routeLayer.pipe(
              Layer.provide(makeAuth([AuthTerminalOperateScope])),
              Layer.provide(runnerLayer),
              Layer.provide(hostLayer),
              Layer.provide(platformLayer),
            ),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(dispose),
      );
      const resBadHost = yield* Effect.promise(() =>
        operateHandler.handler(
          new Request("http://t3.test/api/ports/ws?port=3000&host=192.168.1.100", {
            headers: { upgrade: "websocket" },
          }),
        ),
      );
      expect(resBadHost.status).toBe(400);

      // 3. Operative scope with invalid port must return 400
      const resBadPort = yield* Effect.promise(() =>
        operateHandler.handler(
          new Request("http://t3.test/api/ports/ws?port=99999&host=localhost", {
            headers: { upgrade: "websocket" },
          }),
        ),
      );
      expect(resBadPort.status).toBe(400);
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports/ws closes with 4404 when target TCP port is refused", () =>
    Effect.gen(function* () {
      const runnerLayer = makeMockProcessRunner("");
      const hostLayer = Layer.succeed(HostProcessPlatform, "darwin");
      const authLayer = makeAuth([AuthTerminalOperateScope]);

      const services = yield* Layer.build(
        HttpRouter.serve(
          routeLayer.pipe(
            Layer.provide(runnerLayer),
            Layer.provide(hostLayer),
            Layer.provide(platformLayer),
          ),
          { disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(authLayer)),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");

      // Pick an unused local port
      const dummyServer = NodeNet.createServer();
      const freePort = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            dummyServer.listen(0, "127.0.0.1", () => {
              const port = (dummyServer.address() as NodeNet.AddressInfo).port;
              dummyServer.close(() => resolve(port));
            });
          }),
      );

      const closed = Promise.withResolvers<{ code: number; reason: string }>();
      const ws = new WebSocket(`${origin}/api/ports/ws?port=${freePort}&host=127.0.0.1`);
      ws.addEventListener("close", (event) => {
        closed.resolve({ code: event.code, reason: event.reason });
      });

      const { code } = yield* Effect.promise(() => closed.promise);
      expect(code).toBe(PORT_FORWARD_CONNECT_FAILED);
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports/ws duplex tunnels raw TCP bytes and handles half-close", () =>
    Effect.gen(function* () {
      // 1. Create a real TCP echo server that supports half-close:
      // When client sends data and ends (half-close), the server receives all data,
      // writes back an echo response, and closes.
      const tcpServer = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        const received: Buffer[] = [];
        socket.on("data", (chunk) => {
          received.push(chunk);
        });
        socket.on("end", () => {
          const body = Buffer.concat(received);
          socket.write(Buffer.concat([Buffer.from("ECHO:"), body]));
          socket.end();
        });
      });

      const tcpPort = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            tcpServer.listen(0, "127.0.0.1", () => {
              const port = (tcpServer.address() as NodeNet.AddressInfo).port;
              resolve(port);
            });
          }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          tcpServer.close();
        }),
      );

      const runnerLayer = makeMockProcessRunner("");
      const hostLayer = Layer.succeed(HostProcessPlatform, "darwin");
      const authLayer = makeAuth([AuthTerminalOperateScope]);

      const services = yield* Layer.build(
        HttpRouter.serve(
          routeLayer.pipe(
            Layer.provide(runnerLayer),
            Layer.provide(hostLayer),
            Layer.provide(platformLayer),
          ),
          { disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(authLayer)),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");

      const readyResolvers = Promise.withResolvers<void>();
      const drainedResolvers = Promise.withResolvers<void>();
      const endResolvers = Promise.withResolvers<void>();

      const ws = new WebSocket(`${origin}/api/ports/ws?port=${tcpPort}&host=127.0.0.1`);
      ws.binaryType = "arraybuffer";

      const receivedBuffers: Uint8Array[] = [];

      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          if (event.data === PORT_FORWARD_READY) {
            readyResolvers.resolve();
          } else if (event.data === PORT_FORWARD_END) {
            endResolvers.resolve();
            ws.send(PORT_FORWARD_DRAINED);
          } else if (event.data === PORT_FORWARD_DRAINED) {
            drainedResolvers.resolve();
          }
        } else if (event.data instanceof ArrayBuffer) {
          receivedBuffers.push(new Uint8Array(event.data));
        }
      });

      yield* Effect.promise(() => readyResolvers.promise);

      // Send binary data
      const payload = new TextEncoder().encode("Hello Raw TCP");
      ws.send(payload);

      // Send half-close text frame
      ws.send(PORT_FORWARD_END);

      // Wait for end control frame and check echoed binary data
      yield* Effect.promise(() => endResolvers.promise);
      yield* Effect.promise(() => drainedResolvers.promise);

      const totalLength = receivedBuffers.reduce((acc, b) => acc + b.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const buf of receivedBuffers) {
        merged.set(buf, offset);
        offset += buf.length;
      }

      const responseText = new TextDecoder().decode(merged);
      expect(responseText).toBe("ECHO:Hello Raw TCP");

      ws.close();
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports/ws supports server-first data", () =>
    Effect.gen(function* () {
      // TCP server writes greeting immediately upon connection
      const tcpServer = NodeNet.createServer((socket) => {
        socket.write("WELCOME TO SERVER");
        socket.end();
      });

      const tcpPort = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            tcpServer.listen(0, "127.0.0.1", () => {
              const port = (tcpServer.address() as NodeNet.AddressInfo).port;
              resolve(port);
            });
          }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          tcpServer.close();
        }),
      );

      const runnerLayer = makeMockProcessRunner("");
      const hostLayer = Layer.succeed(HostProcessPlatform, "darwin");
      const authLayer = makeAuth([AuthTerminalOperateScope]);

      const services = yield* Layer.build(
        HttpRouter.serve(
          routeLayer.pipe(
            Layer.provide(runnerLayer),
            Layer.provide(hostLayer),
            Layer.provide(platformLayer),
          ),
          { disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(authLayer)),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");

      const readyResolvers = Promise.withResolvers<void>();
      const endResolvers = Promise.withResolvers<void>();
      const drainedResolvers = Promise.withResolvers<void>();
      const receivedChunks: Uint8Array[] = [];

      const ws = new WebSocket(`${origin}/api/ports/ws?port=${tcpPort}&host=localhost`);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          if (event.data === PORT_FORWARD_READY) {
            readyResolvers.resolve();
          } else if (event.data === PORT_FORWARD_END) {
            endResolvers.resolve();
            ws.send(PORT_FORWARD_DRAINED);
          } else if (event.data === PORT_FORWARD_DRAINED) {
            drainedResolvers.resolve();
          }
        } else if (event.data instanceof ArrayBuffer) {
          receivedChunks.push(new Uint8Array(event.data));
        }
      });

      yield* Effect.promise(() => readyResolvers.promise);
      ws.send(PORT_FORWARD_END);
      yield* Effect.promise(() => endResolvers.promise);
      yield* Effect.promise(() => drainedResolvers.promise);

      const totalLength = receivedChunks.reduce((acc, b) => acc + b.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of receivedChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      expect(new TextDecoder().decode(merged)).toBe("WELCOME TO SERVER");

      ws.close();
    }).pipe(Effect.scoped),
  );

  it.live(
    "GET /api/ports/ws preserves buffered input and awaits drain before normal close when target half-closes response first and reads slowly",
    () =>
      Effect.gen(function* () {
        let targetSocket: NodeNet.Socket | null = null;
        const targetReceivedChunks: Buffer[] = [];
        const targetFinished = Promise.withResolvers<Buffer>();

        const tcpServer = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
          targetSocket = socket;
          socket.on("error", (err) => {
            targetFinished.reject(err);
          });

          // Target half-closes its response first
          socket.write("TARGET-RESPONSE");
          socket.end();

          // Slow reader: start paused, then for every chunk, pause and resume on next tick
          socket.pause();
          setImmediate(() => {
            if (!socket.destroyed) {
              socket.resume();
            }
          });

          socket.on("data", (chunk: Buffer) => {
            targetReceivedChunks.push(chunk);
            socket.pause();
            setImmediate(() => {
              if (!socket.destroyed) {
                socket.resume();
              }
            });
          });

          socket.on("end", () => {
            targetFinished.resolve(Buffer.concat(targetReceivedChunks));
          });
        });

        const tcpPort = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              tcpServer.listen(0, "127.0.0.1", () => {
                const port = (tcpServer.address() as NodeNet.AddressInfo).port;
                resolve(port);
              });
            }),
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (targetSocket && !targetSocket.destroyed) {
              targetSocket.destroy();
            }
            tcpServer.close();
          }),
        );

        const origin = yield* makeTestServerOrigin();

        const readyResolvers = Promise.withResolvers<void>();
        const serverEndResolvers = Promise.withResolvers<void>();
        const serverDrainedResolvers = Promise.withResolvers<void>();
        const wsClosedResolvers = Promise.withResolvers<{
          code: number;
          drainedReceivedBeforeClose: boolean;
        }>();

        let serverDrainedReceived = false;
        const clientReceivedChunks: Uint8Array[] = [];

        const ws = new WebSocket(`${origin}/api/ports/ws?port=${tcpPort}&host=127.0.0.1`);
        ws.binaryType = "arraybuffer";

        ws.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            if (event.data === PORT_FORWARD_READY) {
              readyResolvers.resolve();
            } else if (event.data === PORT_FORWARD_END) {
              serverEndResolvers.resolve();
              ws.send(PORT_FORWARD_DRAINED);
            } else if (event.data === PORT_FORWARD_DRAINED) {
              serverDrainedReceived = true;
              serverDrainedResolvers.resolve();
            }
          } else if (event.data instanceof ArrayBuffer) {
            clientReceivedChunks.push(new Uint8Array(event.data));
          }
        });

        ws.addEventListener("close", (event) => {
          wsClosedResolvers.resolve({
            code: event.code,
            drainedReceivedBeforeClose: serverDrainedReceived,
          });
        });

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          }),
        );

        yield* Effect.promise(() => readyResolvers.promise);

        // 256KB payload forces real socket backpressure across loopback
        const payloadSize = 256 * 1024;
        const clientBinaryData = NodeCrypto.randomBytes(payloadSize);
        const expectedHash = NodeCrypto.createHash("sha256").update(clientBinaryData).digest("hex");

        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < clientBinaryData.length; offset += chunkSize) {
          ws.send(clientBinaryData.subarray(offset, offset + chunkSize));
        }
        ws.send(PORT_FORWARD_END);

        yield* Effect.promise(() => serverEndResolvers.promise);
        yield* Effect.promise(() => serverDrainedResolvers.promise);

        const closeInfo = yield* Effect.promise(() => wsClosedResolvers.promise);
        expect(closeInfo.code).toBe(1000);
        expect(closeInfo.drainedReceivedBeforeClose).toBe(true);

        const targetData = yield* Effect.promise(() => targetFinished.promise);
        expect(targetData.byteLength).toBe(payloadSize);
        const actualHash = NodeCrypto.createHash("sha256").update(targetData).digest("hex");
        expect(actualHash).toBe(expectedHash);

        const totalClientBytes = clientReceivedChunks.reduce((acc, b) => acc + b.length, 0);
        const mergedClientBytes = new Uint8Array(totalClientBytes);
        let offset = 0;
        for (const b of clientReceivedChunks) {
          mergedClientBytes.set(b, offset);
          offset += b.length;
        }
        expect(new TextDecoder().decode(mergedClientBytes)).toBe("TARGET-RESPONSE");
      }).pipe(Effect.scoped),
  );

  it.live(
    "GET /api/ports/ws terminates target TCP connection when client cancels with WS.close without END while receive is blocked in drain",
    () =>
      Effect.gen(function* () {
        let targetSocket: NodeNet.Socket | null = null;
        let targetReceivedBytes = 0;
        let pausedForPressure = false;
        const targetTerminatedResolver = Promise.withResolvers<string>();
        const targetDataReceivedResolver = Promise.withResolvers<void>();
        const targetConnectedResolver = Promise.withResolvers<NodeNet.Socket>();

        const tcpServer = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
          targetSocket = socket;

          // Register close/error/counting data resolver before operations/pause
          socket.on("data", (chunk: Buffer) => {
            targetReceivedBytes += chunk.length;
            if (!pausedForPressure) {
              pausedForPressure = true;
              socket.pause();
              targetDataReceivedResolver.resolve();
            }
          });
          socket.on("error", (err) => {
            targetTerminatedResolver.resolve(`error:${err.message}`);
          });
          socket.once("close", (hadError) => {
            targetTerminatedResolver.resolve(hadError ? "close-with-error" : "close");
          });

          // Target half-closes its response then stops reading input
          socket.end();
          targetConnectedResolver.resolve(socket);
        });

        const tcpPort = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              tcpServer.listen(0, "127.0.0.1", () => {
                const port = (tcpServer.address() as NodeNet.AddressInfo).port;
                resolve(port);
              });
            }),
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (targetSocket && !targetSocket.destroyed) {
              targetSocket.destroy();
            }
            tcpServer.close();
          }),
        );

        const origin = yield* makeTestServerOrigin();

        const readyResolvers = Promise.withResolvers<void>();
        const wsClosedResolvers = Promise.withResolvers<{ code: number; reason: string }>();

        const ws = new WebSocket(`${origin}/api/ports/ws?port=${tcpPort}&host=127.0.0.1`);
        ws.binaryType = "arraybuffer";

        ws.addEventListener("message", (event) => {
          if (typeof event.data === "string" && event.data === PORT_FORWARD_READY) {
            readyResolvers.resolve();
          }
        });

        ws.addEventListener("close", (event) => {
          wsClosedResolvers.resolve({ code: event.code, reason: event.reason });
        });

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          }),
        );

        yield* Effect.promise(() => readyResolvers.promise);
        const acceptedTarget = yield* Effect.promise(() => targetConnectedResolver.promise);

        // Client sends large (16MB) binary frame so server receive blocks in native TCP drain
        const totalSentBytes = 16 * 1024 * 1024;
        const largeFrame = new Uint8Array(totalSentBytes);
        ws.send(largeFrame);

        // Ensure remote write is pressured before cancel: wait until target receives initial data and pauses
        yield* Effect.promise(() => targetDataReceivedResolver.promise);

        // Gracefully WS.close1000 WITHOUT client END (cancel before protocol completion)
        ws.close(1000, "Client cancelled");

        // Assert WS closure is confirmed first
        const wsClosed = yield* Effect.promise(() => wsClosedResolvers.promise).pipe(
          Effect.timeout("10 seconds"),
        );
        expect(wsClosed.code).toBe(1000);

        // Resume target to consume FIN after WS is actually closed
        if (!acceptedTarget.destroyed) acceptedTarget.resume();

        // Assert target actually observes connection termination within bounded deadline
        yield* Effect.promise(() => targetTerminatedResolver.promise).pipe(
          Effect.timeout("10 seconds"),
        );
        expect(acceptedTarget.destroyed).toBe(true);

        // Assert target received strictly less than complete sent payload (native drain was dropped, not leaked)
        expect(targetReceivedBytes).toBeLessThan(totalSentBytes);
      }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports/ws connects to actual IPv6-only target through localhost fallback", () =>
    Effect.gen(function* () {
      let targetSocket: NodeNet.Socket | null = null;
      const targetReceived: Buffer[] = [];
      const targetFinished = Promise.withResolvers<Buffer>();

      const tcpServer = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        targetSocket = socket;
        socket.on("error", (err) => {
          targetFinished.reject(err);
        });
        socket.on("data", (chunk: Buffer) => {
          targetReceived.push(chunk);
        });
        socket.on("end", () => {
          const body = Buffer.concat(targetReceived);
          socket.write(Buffer.concat([Buffer.from("IPV6-ECHO:"), body]));
          socket.end();
          targetFinished.resolve(body);
        });
      });

      const tcpPort = yield* Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            tcpServer.listen({ host: "::1", port: 0, ipv6Only: true }, () => {
              const port = (tcpServer.address() as NodeNet.AddressInfo).port;
              resolve(port);
            });
            tcpServer.on("error", reject);
          }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (targetSocket && !targetSocket.destroyed) {
            targetSocket.destroy();
          }
          tcpServer.close();
        }),
      );

      const origin = yield* makeTestServerOrigin();

      const readyResolvers = Promise.withResolvers<void>();
      const serverEndResolvers = Promise.withResolvers<void>();
      const serverDrainedResolvers = Promise.withResolvers<void>();
      const clientReceivedChunks: Uint8Array[] = [];

      // Connect with host=localhost to trigger IPv4 ECONNREFUSED -> IPv6 ::1 fallback
      const ws = new WebSocket(`${origin}/api/ports/ws?port=${tcpPort}&host=localhost`);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          if (event.data === PORT_FORWARD_READY) {
            readyResolvers.resolve();
          } else if (event.data === PORT_FORWARD_END) {
            serverEndResolvers.resolve();
            ws.send(PORT_FORWARD_DRAINED);
          } else if (event.data === PORT_FORWARD_DRAINED) {
            serverDrainedResolvers.resolve();
          }
        } else if (event.data instanceof ArrayBuffer) {
          clientReceivedChunks.push(new Uint8Array(event.data));
        }
      });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }),
      );

      yield* Effect.promise(() => readyResolvers.promise);

      const payload = new TextEncoder().encode("Hello IPv6 Loopback");
      ws.send(payload);
      ws.send(PORT_FORWARD_END);

      yield* Effect.promise(() => serverEndResolvers.promise);
      yield* Effect.promise(() => serverDrainedResolvers.promise);

      const totalClientBytes = clientReceivedChunks.reduce((acc, b) => acc + b.length, 0);
      const mergedClientBytes = new Uint8Array(totalClientBytes);
      let offset = 0;
      for (const b of clientReceivedChunks) {
        mergedClientBytes.set(b, offset);
        offset += b.length;
      }

      expect(new TextDecoder().decode(mergedClientBytes)).toBe("IPV6-ECHO:Hello IPv6 Loopback");

      const targetData = yield* Effect.promise(() => targetFinished.promise);
      expect(targetData.toString("utf8")).toBe("Hello IPv6 Loopback");

      ws.close();
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports discovers Linux listening ports via ss -H -ltnp regressions", () =>
    Effect.gen(function* () {
      const mockSsOutput = [
        "State      Recv-Q Send-Q Local Address:Port               Peer Address:Port              Process",
        'LISTEN     0      511    127.0.0.1:44556                 0.0.0.0:*                      users:(("next-server (v1",pid=1179925,fd=22))',
        'LISTEN     0      128    10.0.0.1:8080                   0.0.0.0:*                      users:(("external-app",pid=99999,fd=3))',
        'LISTEN     0      511    [::1]:44557                     [::]:*                         users:(("MainThread",pid=1180962,fd=21))',
        'LISTEN     0      128    0.0.0.0:3000                    0.0.0.0:*                      users:(("node",pid=1234,fd=10))',
        'LISTEN     0      128    [::]:9000                       [::]:*                         users:(("node-v6",pid=5678,fd=11))',
        'LISTEN     0      128    *:9001                          *:*                            users:(("v6-only-wildcard",pid=5679,fd=12))',
        'LISTEN     0      128    *:8000                          0.0.0.0:*                      users:(("any-v4",pid=2345,fd=12))',
        "LISTEN     0      4096   127.0.0.1:11000                 0.0.0.0:*",
        'LISTEN     0      511    127.0.0.1:44556                 0.0.0.0:*                      users:(("next-server (v1",pid=1179925,fd=23))',
        'LISTEN     0      128    127.0.0.1:0                     0.0.0.0:*                      users:(("invalid-zero",pid=111,fd=1))',
        'LISTEN     0      128    127.0.0.1:70000                 0.0.0.0:*                      users:(("invalid-high",pid=222,fd=2))',
      ].join("\n");

      const runnerLayer = makeMockProcessRunner(mockSsOutput);
      const hostLayer = Layer.succeed(HostProcessPlatform, "linux");
      const layerApp = HttpApiBuilder.layer(PortsTestApi).pipe(
        Layer.provide(layerPortsHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(makeAuth([AuthTerminalReadScope])),
        Layer.provide(runnerLayer),
        Layer.provide(hostLayer),
        Layer.provide(platformLayer),
      );
      const webHandler = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(webHandler.dispose));

      const res = yield* Effect.promise(() =>
        webHandler.handler(
          new Request("http://t3.test/api/ports", {
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      );
      expect(res.status).toBe(200);
      const data = yield* Effect.promise(() => res.json());
      expect(data).toEqual([
        {
          port: 44556,
          host: "127.0.0.1",
          processName: "next-server (v1",
          pid: 1179925,
        },
        {
          port: 44557,
          host: "::1",
          processName: "MainThread",
          pid: 1180962,
        },
        {
          port: 3000,
          host: "127.0.0.1",
          processName: "node",
          pid: 1234,
        },
        {
          port: 9000,
          host: "::1",
          processName: "node-v6",
          pid: 5678,
        },
        {
          port: 9001,
          host: "localhost",
          processName: "v6-only-wildcard",
          pid: 5679,
        },
        {
          port: 8000,
          host: "127.0.0.1",
          processName: "any-v4",
          pid: 2345,
        },
        {
          port: 11000,
          host: "127.0.0.1",
          processName: null,
          pid: null,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports returns typed error on Linux when ss exits with failure", () =>
    Effect.gen(function* () {
      const runnerLayer = Layer.mock(ProcessRunner.ProcessRunner, {
        run: () =>
          Effect.succeed({
            stdout: "",
            stderr: "ss: command failed",
            code: ChildProcessSpawner.ExitCode(1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      });
      const hostLayer = Layer.succeed(HostProcessPlatform, "linux");
      const layerApp = HttpApiBuilder.layer(PortsTestApi).pipe(
        Layer.provide(layerPortsHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(makeAuth([AuthTerminalReadScope])),
        Layer.provide(runnerLayer),
        Layer.provide(hostLayer),
        Layer.provide(platformLayer),
      );
      const webHandler = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(webHandler.dispose));

      const res = yield* Effect.promise(() =>
        webHandler.handler(
          new Request("http://t3.test/api/ports", {
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      );
      expect(res.status).toBe(500);
      const data = yield* Effect.promise(() => res.json());
      expect(data).toHaveProperty("_tag", "EnvironmentInternalError");
    }).pipe(Effect.scoped),
  );

  it.live("GET /api/ports returns typed error on Linux when ss command is missing", () =>
    Effect.gen(function* () {
      const runnerLayer = Layer.mock(ProcessRunner.ProcessRunner, {
        run: () =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "ss",
              argumentCount: 2,
              cause: new Error("spawn ss ENOENT"),
            }),
          ),
      });
      const hostLayer = Layer.succeed(HostProcessPlatform, "linux");
      const layerApp = HttpApiBuilder.layer(PortsTestApi).pipe(
        Layer.provide(layerPortsHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(makeAuth([AuthTerminalReadScope])),
        Layer.provide(runnerLayer),
        Layer.provide(hostLayer),
        Layer.provide(platformLayer),
      );
      const webHandler = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(webHandler.dispose));

      const res = yield* Effect.promise(() =>
        webHandler.handler(
          new Request("http://t3.test/api/ports", {
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      );
      expect(res.status).toBe(500);
      const data = yield* Effect.promise(() => res.json());
      expect(data).toHaveProperty("_tag", "EnvironmentInternalError");
      expect(data).not.toEqual([]);
    }).pipe(Effect.scoped),
  );
});
