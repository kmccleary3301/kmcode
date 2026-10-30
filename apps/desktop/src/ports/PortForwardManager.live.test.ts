// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PORT_FORWARD_DRAINED,
  PORT_FORWARD_END,
  PORT_FORWARD_READY,
  type PortForwardConnectionRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WebSocketServer, type WebSocket } from "ws";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as PortForwardManager from "./PortForwardManager.ts";

const makeRequestRecorder = () => {
  const pendingQueue: PortForwardConnectionRequest[] = [];
  const waiters: Array<(req: PortForwardConnectionRequest) => void> = [];

  const record = (channel: string, ...args: readonly unknown[]): void => {
    if (channel === IpcChannels.PORT_FORWARD_CONNECTION_REQUEST_CHANNEL) {
      const req = args[0] as PortForwardConnectionRequest;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(req);
      } else {
        pendingQueue.push(req);
      }
    }
  };

  const awaitNextRequest = Effect.callback<PortForwardConnectionRequest>((resume) => {
    const existing = pendingQueue.shift();
    if (existing) {
      resume(Effect.succeed(existing));
      return;
    }
    waiters.push((req) => resume(Effect.succeed(req)));
  });

  return { record, awaitNextRequest };
};

const makeMockElectronWindow = () => {
  const sentMessages: Array<{ channel: string; args: readonly unknown[] }> = [];
  const recorder = makeRequestRecorder();

  const layer = Layer.mock(ElectronWindow.ElectronWindow)({
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        sentMessages.push({ channel, args });
        recorder.record(channel, ...args);
      }),
  });

  return { layer, sentMessages, awaitNextRequest: recorder.awaitNextRequest };
};

const getAvailablePort = () =>
  Effect.promise(async () => {
    const server = NodeNet.createServer();
    const { promise, resolve } = Promise.withResolvers<number>();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as NodeNet.AddressInfo;
      resolve(addr.port);
    });
    const port = await promise;
    const closeResolvers = Promise.withResolvers<void>();
    server.close(() => closeResolvers.resolve());
    await closeResolvers.promise;
    return port;
  });

class FakeWebContents extends NodeEvents.EventEmitter {
  private destroyed = false;
  readonly sentIpc: Array<{ channel: string; args: readonly unknown[] }> = [];
  private readonly recorder = makeRequestRecorder();

  constructor(onSend?: (channel: string, ...args: readonly unknown[]) => void) {
    super();
    if (onSend) {
      this.on("send", onSend);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }

  send(channel: string, ...args: readonly unknown[]): void {
    this.sentIpc.push({ channel, args });
    this.emit("send", channel, ...args);
    this.emit(channel, ...args);
    this.recorder.record(channel, ...args);
  }

  readonly awaitNextRequest: Effect.Effect<PortForwardConnectionRequest> =
    this.recorder.awaitNextRequest;
}

describe("PortForwardManager live tests", () => {
  it.live(
    "stopAll closes every forward in every environment, frees the ports, and broadcasts once",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, sentMessages } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const forwards = [
          { environmentId: EnvironmentId.make("env-a"), remotePort: 3000, origin: "auto" },
          { environmentId: EnvironmentId.make("env-a"), remotePort: 5173, origin: "user" },
          { environmentId: EnvironmentId.make("env-b"), remotePort: 8080, origin: "auto" },
        ] as const;
        const localPorts: number[] = [];
        for (const forward of forwards) {
          const localPort = yield* getAvailablePort();
          localPorts.push(localPort);
          yield* manager.start({ ...forward, remoteHost: "127.0.0.1", localPort });
        }
        expect(yield* manager.list).toHaveLength(3);

        const changedBefore = sentMessages.filter(
          (message) => message.channel === IpcChannels.PORT_FORWARD_CHANGED_CHANNEL,
        ).length;
        expect(yield* manager.stopAll).toBe(3);
        const changes = sentMessages
          .filter((message) => message.channel === IpcChannels.PORT_FORWARD_CHANGED_CHANNEL)
          .slice(changedBefore);
        expect(changes).toEqual([
          { channel: IpcChannels.PORT_FORWARD_CHANGED_CHANNEL, args: [[]] },
        ]);
        expect(yield* manager.list).toEqual([]);

        // Every local listener was released: each port can be bound again.
        for (const localPort of localPorts) {
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const probe = NodeNet.createServer();
                probe.once("error", reject);
                probe.listen(localPort, "127.0.0.1", () => probe.close(() => resolve()));
              }),
          );
        }

        expect(yield* manager.stopAll).toBe(0);
        expect(
          sentMessages.filter(
            (message) => message.channel === IpcChannels.PORT_FORWARD_CHANGED_CHANNEL,
          ),
        ).toHaveLength(changedBefore + 1);
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live(
    "handles local TCP connection, raw duplex, and half-close",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        let remoteWs: WebSocket | null = null;

        const receivedFromClient: Buffer[] = [];
        const receivedTextFromClient: string[] = [];
        const halfCloseReceivedResolver = Promise.withResolvers<void>();
        const clientDrainedResolver = Promise.withResolvers<void>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            remoteWs = ws;
            ws.send(PORT_FORWARD_READY);

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                receivedFromClient.push(buf);
              } else {
                const text = data.toString("utf-8");
                receivedTextFromClient.push(text);
                if (text === PORT_FORWARD_END) {
                  halfCloseReceivedResolver.resolve();
                  ws.send(PORT_FORWARD_DRAINED);
                } else if (text === PORT_FORWARD_DRAINED) {
                  clientDrainedResolver.resolve();
                }
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 1455;
        const envId = EnvironmentId.make("env-1");

        const started = yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        expect(started.origin).toBe("user");
        expect(started.localPort).toBe(localPort);
        expect(started.localAddress).toBe(`127.0.0.1:${localPort}`);
        expect(started.status).toBe("listening");

        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());

        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        expect(reqMessage.environmentId).toBe(envId);
        expect(reqMessage.remotePort).toBe(remotePort);
        expect(reqMessage.remoteHost).toBe("localhost");

        const mockedWsUrl = `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: mockedWsUrl,
        });

        const requestPayload = Buffer.from(
          "GET /auth/callback?code=test-auth-code HTTP/1.1\r\n\r\n",
        );
        tcpClient.write(requestPayload);
        tcpClient.end();

        yield* Effect.promise(() => halfCloseReceivedResolver.promise);

        const receivedData = Buffer.concat(receivedFromClient);
        expect(receivedData.toString("utf-8")).toBe(requestPayload.toString("utf-8"));
        expect(receivedTextFromClient).toContain(PORT_FORWARD_END);

        const responseDataResolver = Promise.withResolvers<Buffer>();
        const tcpChunks: Buffer[] = [];
        tcpClient.on("data", (chunk: Buffer) => {
          tcpChunks.push(chunk);
        });
        tcpClient.on("end", () => {
          responseDataResolver.resolve(Buffer.concat(tcpChunks));
        });

        const responsePayload = Buffer.from(
          "HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nAuthenticated",
        );
        remoteWs!.send(responsePayload, { binary: true });
        remoteWs!.send(PORT_FORWARD_END);

        yield* Effect.promise(() => clientDrainedResolver.promise);

        const receivedResponse = yield* Effect.promise(() => responseDataResolver.promise);
        expect(receivedResponse.toString("utf-8")).toBe(responsePayload.toString("utf-8"));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live("detects local port conflict across different environments", () =>
    Effect.gen(function* () {
      const { layer: electronWindowLayer } = makeMockElectronWindow();
      const services = yield* Layer.build(
        PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
      );
      const manager = Context.get(services, PortForwardManager.PortForwardManager);
      const localPort = yield* getAvailablePort();

      const env1 = EnvironmentId.make("env-1");
      const env2 = EnvironmentId.make("env-2");

      yield* manager.start({
        environmentId: env1,
        remotePort: 3000,
        remoteHost: "localhost",
        localPort,
        origin: "user",
      });

      const conflictResult = yield* manager
        .start({
          environmentId: env2,
          remotePort: 4000,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        })
        .pipe(
          Effect.map(() => null),
          Effect.catch((err) => Effect.succeed(err)),
        );

      expect(conflictResult?._tag).toBe("PortForwardConflictError");
      if (conflictResult?._tag === "PortForwardConflictError") {
        expect(conflictResult.localPort).toBe(localPort);
      }
    }).pipe(Effect.scoped),
  );

  it.live("releasing forwarded port on stop allows rebinding", () =>
    Effect.gen(function* () {
      const { layer: electronWindowLayer } = makeMockElectronWindow();
      const services = yield* Layer.build(
        PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
      );
      const manager = Context.get(services, PortForwardManager.PortForwardManager);
      const localPort = yield* getAvailablePort();

      const env1 = EnvironmentId.make("env-1");
      const env2 = EnvironmentId.make("env-2");

      yield* manager.start({
        environmentId: env1,
        remotePort: 3000,
        remoteHost: "localhost",
        localPort,
        origin: "user",
      });

      yield* manager.stop({
        environmentId: env1,
        remotePort: 3000,
        remoteHost: "localhost",
      });

      const rebound = yield* manager.start({
        environmentId: env2,
        remotePort: 4000,
        remoteHost: "localhost",
        localPort,
        origin: "auto",
      });

      expect(rebound.origin).toBe("auto");
      expect(rebound.environmentId).toBe(env2);
      expect(rebound.localPort).toBe(localPort);
      expect(rebound.status).toBe("listening");
    }).pipe(Effect.scoped),
  );

  it.live(
    "timing out connection request cleans up pending socket",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layerWithOptions({ ticketTimeoutMs: 150 }).pipe(
            Layer.provide(electronWindowLayer),
          ),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);
        const localPort = yield* getAvailablePort();

        const env1 = EnvironmentId.make("env-1");
        yield* manager.start({
          environmentId: env1,
          remotePort: 5000,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({ host: "127.0.0.1", port: localPort });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        const clientCloseResolver = Promise.withResolvers<void>();
        const onClientDone = () => {
          clientCloseResolver.resolve();
        };
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        tcpClient.once("close", onClientDone);
        tcpClient.once("end", onClientDone);
        tcpClient.once("error", onClientDone);

        yield* Effect.promise(() => tcpConnectedResolvers.promise);

        const reqMessage = yield* awaitNextRequest;
        expect(reqMessage.remotePort).toBe(5000);

        // We intentionally do not resolve the connection.
        // Real ticket timeout (configured to 150ms) expires and cleans up the pending socket.
        yield* Effect.promise(() => clientCloseResolver.promise);
        expect(tcpClient.destroyed || !tcpClient.readable).toBe(true);

        const list = yield* manager.list;
        const portInfo = list.find((p) => p.localPort === localPort);
        expect(portInfo?.activeConnections).toBe(0);

        // Late resolution after real timeout must be safely ignored
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: "ws://localhost:5000/api/ports/ws?port=5000&host=localhost",
        });
        expect(tcpClient.destroyed || !tcpClient.readable).toBe(true);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "handles >2MB binary response after client half close",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        let remoteWs: WebSocket | null = null;
        const halfCloseReceivedResolver = Promise.withResolvers<void>();
        const clientDrainedResolver = Promise.withResolvers<void>();

        const payloadSize = 2.5 * 1024 * 1024;
        const expectedBinaryData = NodeCrypto.randomBytes(payloadSize);
        const expectedHash = NodeCrypto.createHash("sha256")
          .update(expectedBinaryData)
          .digest("hex");

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            remoteWs = ws;
            ws.send(PORT_FORWARD_READY);

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (!isBinary) {
                const text = data.toString("utf-8");
                if (text === PORT_FORWARD_END) {
                  halfCloseReceivedResolver.resolve();
                  ws.send(PORT_FORWARD_DRAINED);
                } else if (text === PORT_FORWARD_DRAINED) {
                  clientDrainedResolver.resolve();
                }
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 8080;
        const envId = EnvironmentId.make("env-large");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        tcpClient.write("GET /large-payload HTTP/1.1\r\n\r\n");
        tcpClient.end();

        yield* Effect.promise(() => halfCloseReceivedResolver.promise);

        const clientDataResolver = Promise.withResolvers<Buffer>();
        const receivedChunks: Buffer[] = [];
        tcpClient.on("data", (chunk: Buffer) => {
          receivedChunks.push(chunk);
        });
        tcpClient.on("end", () => {
          clientDataResolver.resolve(Buffer.concat(receivedChunks));
        });

        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < expectedBinaryData.length; offset += chunkSize) {
          const slice = expectedBinaryData.subarray(offset, offset + chunkSize);
          remoteWs!.send(slice, { binary: true });
        }
        remoteWs!.send(PORT_FORWARD_END);

        yield* Effect.promise(() => clientDrainedResolver.promise);

        const fullReceivedData = yield* Effect.promise(() => clientDataResolver.promise);
        expect(fullReceivedData.length).toBe(payloadSize);
        const actualHash = NodeCrypto.createHash("sha256").update(fullReceivedData).digest("hex");
        expect(actualHash).toBe(expectedHash);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "handles server-first bytes protocol",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        const clientBannerResolver = Promise.withResolvers<string>();

        const serverGreeting = "SSH-2.0-OpenSSH_9.0\r\n";
        const clientGreeting = "SSH-2.0-KMClient_1.0\r\n";

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send(PORT_FORWARD_READY);
            ws.send(Buffer.from(serverGreeting), { binary: true });

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                clientBannerResolver.resolve(buf.toString("utf-8"));
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 2222;
        const envId = EnvironmentId.make("env-ssh");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        const firstReceivedChunkResolver = Promise.withResolvers<string>();
        tcpClient.once("data", (chunk: Buffer) => {
          firstReceivedChunkResolver.resolve(chunk.toString("utf-8"));
        });

        const firstChunk = yield* Effect.promise(() => firstReceivedChunkResolver.promise);
        expect(firstChunk).toBe(serverGreeting);

        tcpClient.write(Buffer.from(clientGreeting));
        const receivedClientBanner = yield* Effect.promise(() => clientBannerResolver.promise);
        expect(receivedClientBanner).toBe(clientGreeting);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "cleans up local TCP socket when WS disconnects while client is idle",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        let remoteWs: WebSocket | null = null;
        const wsConnectedResolver = Promise.withResolvers<void>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            remoteWs = ws;
            ws.send(PORT_FORWARD_READY);
            wsConnectedResolver.resolve();
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 3306;
        const envId = EnvironmentId.make("env-idle");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({ host: "127.0.0.1", port: localPort });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        const clientCloseResolver = Promise.withResolvers<void>();
        const onClientDone = () => {
          clientCloseResolver.resolve();
        };
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        tcpClient.once("close", onClientDone);
        tcpClient.once("end", onClientDone);
        tcpClient.once("error", onClientDone);

        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        yield* Effect.promise(() => wsConnectedResolver.promise);

        remoteWs!.terminate();

        yield* Effect.promise(() => clientCloseResolver.promise);

        for (let i = 0; i < 50; i++) {
          const list = yield* manager.list;
          const portInfo = list.find((p) => p.localPort === localPort);
          if (portInfo?.activeConnections === 0) break;
          yield* Effect.sleep(Duration.millis(10));
        }

        const list = yield* manager.list;
        const portInfo = list.find((p) => p.localPort === localPort);
        expect(portInfo?.activeConnections).toBe(0);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "stop releases both TCP addresses AND server observed WS close",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        const wsConnectedResolver = Promise.withResolvers<void>();
        const wsClosedResolver = Promise.withResolvers<void>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send(PORT_FORWARD_READY);
            wsConnectedResolver.resolve();
            ws.on("close", () => {
              wsClosedResolver.resolve();
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 9000;
        const envId = EnvironmentId.make("env-stop");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        yield* Effect.promise(() => wsConnectedResolver.promise);

        yield* manager.stop({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
        });

        yield* Effect.promise(() => wsClosedResolver.promise);

        const ipv4Server = NodeNet.createServer();
        const ipv4BoundResolver = Promise.withResolvers<void>();
        ipv4Server.listen({ host: "127.0.0.1", port: localPort }, () => {
          ipv4BoundResolver.resolve();
        });
        yield* Effect.promise(() => ipv4BoundResolver.promise);

        const ipv4CloseResolver = Promise.withResolvers<void>();
        ipv4Server.close(() => ipv4CloseResolver.resolve());
        yield* Effect.promise(() => ipv4CloseResolver.promise);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live("handles concurrent start conflict cleanly", () =>
    Effect.gen(function* () {
      const { layer: electronWindowLayer } = makeMockElectronWindow();
      const services = yield* Layer.build(
        PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
      );
      const manager = Context.get(services, PortForwardManager.PortForwardManager);
      const localPort = yield* getAvailablePort();

      const env1 = EnvironmentId.make("env-c1");
      const env2 = EnvironmentId.make("env-c2");

      const start1 = manager.start({
        environmentId: env1,
        remotePort: 4100,
        remoteHost: "localhost",
        localPort,
        origin: "user",
      });

      const start2 = manager.start({
        environmentId: env2,
        remotePort: 4200,
        remoteHost: "localhost",
        localPort,
        origin: "auto",
      });

      const [res1, res2] = yield* Effect.all(
        [
          start1.pipe(
            Effect.map((port) => ({ ok: true as const, port })),
            Effect.catch((err) => Effect.succeed({ ok: false as const, err })),
          ),
          start2.pipe(
            Effect.map((port) => ({ ok: true as const, port })),
            Effect.catch((err) => Effect.succeed({ ok: false as const, err })),
          ),
        ],
        { concurrency: 2 },
      );

      const isSuccess1 = res1.ok;
      const isSuccess2 = res2.ok;

      expect(isSuccess1 !== isSuccess2).toBe(true);

      const failed = isSuccess1 ? res2 : res1;
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.err._tag).toBe("PortForwardConflictError");
        expect(failed.err.localPort).toBe(localPort);
      }

      const list = yield* manager.list;
      expect(list.length).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live(
    "rejects resolution from wrong owner and cleans up on pending client close",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer } = makeMockElectronWindow();
        const owner = new FakeWebContents();
        const services = yield* Layer.build(
          PortForwardManager.layerWithOptions({
            getWebContents: (id) => (id === 42 ? owner : null),
          }).pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        let remoteWsConnected = false;

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            remoteWsConnected = true;
            ws.send(PORT_FORWARD_READY);
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 6000;
        const envId = EnvironmentId.make("env-owner");
        const correctOwnerId = 42;

        yield* manager.start(
          {
            environmentId: envId,
            remotePort,
            remoteHost: "localhost",
            localPort,
            origin: "user",
          },
          correctOwnerId,
        );

        // Part 1: Pending client close cleans up immediately via TCP reset
        const tcpClient1 = NodeNet.connect({ host: "127.0.0.1", port: localPort });
        const tcpConnectedResolvers1 = Promise.withResolvers<void>();
        tcpClient1.once("connect", () => tcpConnectedResolvers1.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers1.promise);

        const reqMessage1 = yield* owner.awaitNextRequest;
        if ("resetAndDestroy" in tcpClient1 && typeof tcpClient1.resetAndDestroy === "function") {
          tcpClient1.resetAndDestroy();
        } else {
          tcpClient1.destroy(new Error("client reset"));
        }

        // Server detects early RST/error from client, cleans up pending request and decrements activeConnections to 0
        for (let i = 0; i < 50; i++) {
          const list = yield* manager.list;
          const portInfo = list.find((p) => p.localPort === localPort);
          if (portInfo?.activeConnections === 0) break;
          yield* Effect.sleep(Duration.millis(10));
        }

        const listAfterDrop = yield* manager.list;
        const portInfoAfterDrop = listAfterDrop.find((p) => p.localPort === localPort);
        expect(portInfoAfterDrop?.activeConnections).toBe(0);

        yield* manager.resolveConnection(
          {
            requestId: reqMessage1.requestId,
            socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
          },
          correctOwnerId,
        );
        expect(remoteWsConnected).toBe(false);

        // Part 2: Wrong owner resolution is rejected
        const tcpClient2 = NodeNet.connect({ host: "127.0.0.1", port: localPort });
        const tcpConnectedResolvers2 = Promise.withResolvers<void>();
        tcpClient2.once("connect", () => tcpConnectedResolvers2.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers2.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient2.destroy()));

        const reqMessage2 = yield* owner.awaitNextRequest;

        yield* manager.resolveConnection(
          {
            requestId: reqMessage2.requestId,
            socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
          },
          99,
        );
        expect(remoteWsConnected).toBe(false);

        yield* manager.resolveConnection({
          requestId: reqMessage2.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });
        expect(remoteWsConnected).toBe(false);

        yield* manager.resolveConnection(
          {
            requestId: reqMessage2.requestId,
            socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
          },
          correctOwnerId,
        );

        for (let i = 0; i < 50; i++) {
          if (remoteWsConnected) break;
          yield* Effect.sleep(Duration.millis(10));
        }
        expect(remoteWsConnected).toBe(true);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "ready timeout cleans up stream when server never sends ready signal",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layerWithOptions({ readyTimeoutMs: 150 }).pipe(
            Layer.provide(electronWindowLayer),
          ),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (_ws) => {
            // Intentionally never send PORT_FORWARD_READY
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 7777;
        const envId = EnvironmentId.make("env-timeout");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({ host: "127.0.0.1", port: localPort });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        const clientCloseResolver = Promise.withResolvers<void>();
        const onClientDone = () => {
          clientCloseResolver.resolve();
        };
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        tcpClient.once("close", onClientDone);
        tcpClient.once("end", onClientDone);
        tcpClient.once("error", onClientDone);

        yield* Effect.promise(() => tcpConnectedResolvers.promise);

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        yield* Effect.promise(() => clientCloseResolver.promise);

        const list = yield* manager.list;
        const portInfo = list.find((p) => p.localPort === localPort);
        expect(portInfo?.activeConnections).toBe(0);
        expect(portInfo?.status).toBe("error");
        expect(portInfo?.error).toContain("Ready timeout");
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "fast client / slow server backpressure preserves full payload hash",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        const serverReceivedChunks: Buffer[] = [];
        const serverDoneResolver = Promise.withResolvers<void>();
        const wsConnectedResolver = Promise.withResolvers<void>();

        const payloadSize = 512 * 1024;
        const clientBinaryData = NodeCrypto.randomBytes(payloadSize);
        const expectedHash = NodeCrypto.createHash("sha256").update(clientBinaryData).digest("hex");

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send(PORT_FORWARD_READY);
            wsConnectedResolver.resolve();

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                serverReceivedChunks.push(buf);
              } else {
                const text = data.toString("utf-8");
                if (text === PORT_FORWARD_END) {
                  ws.send(PORT_FORWARD_DRAINED);
                  serverDoneResolver.resolve();
                }
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 9999;
        const envId = EnvironmentId.make("env-backpressure");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        yield* Effect.promise(() => wsConnectedResolver.promise);

        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < clientBinaryData.length; offset += chunkSize) {
          const slice = clientBinaryData.subarray(offset, offset + chunkSize);
          tcpClient.write(slice);
        }
        tcpClient.end();

        yield* Effect.promise(() => serverDoneResolver.promise);

        const totalServerData = Buffer.concat(serverReceivedChunks);
        expect(totalServerData.length).toBe(payloadSize);
        const actualHash = NodeCrypto.createHash("sha256").update(totalServerData).digest("hex");
        expect(actualHash).toBe(expectedHash);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "server-first / slow-input regression with complete input hash, drain ACK before normal close",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });

        const serverGreeting = "SERVER-BANNER-READY\r\n";
        const clientPayloadSize = 512 * 1024;
        const clientBinaryData = NodeCrypto.randomBytes(clientPayloadSize);
        const expectedHash = NodeCrypto.createHash("sha256").update(clientBinaryData).digest("hex");

        const serverReceivedChunks: Buffer[] = [];
        const clientDrainedFromServerResolver = Promise.withResolvers<void>();
        const serverDoneResolver = Promise.withResolvers<void>();
        const wsNormalCloseResolver = Promise.withResolvers<number>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("close", (code) => {
              wsNormalCloseResolver.resolve(code);
            });

            ws.send(PORT_FORWARD_READY);
            // Server sends initial banner bytes then half-closes immediately
            ws.send(Buffer.from(serverGreeting), { binary: true });
            ws.send(PORT_FORWARD_END);

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                serverReceivedChunks.push(buf);
              } else {
                const text = data.toString("utf-8");
                if (text === PORT_FORWARD_DRAINED) {
                  // Desktop acknowledged server's END flushes to local TCP
                  clientDrainedFromServerResolver.resolve();
                } else if (text === PORT_FORWARD_END) {
                  // Client finished sending its slow input
                  ws.send(PORT_FORWARD_DRAINED);
                  serverDoneResolver.resolve();
                }
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 5555;
        const envId = EnvironmentId.make("env-slow-input");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        // 1. Client receives server-first greeting
        const greetingResolver = Promise.withResolvers<string>();
        tcpClient.once("data", (chunk: Buffer) => {
          greetingResolver.resolve(chunk.toString("utf-8"));
        });
        const receivedGreeting = yield* Effect.promise(() => greetingResolver.promise);
        expect(receivedGreeting).toBe(serverGreeting);

        // 2. Server observes that desktop acknowledged server's END via DRAINED
        yield* Effect.promise(() => clientDrainedFromServerResolver.promise);

        // 3. Client continues sending large input after server half-close
        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < clientBinaryData.length; offset += chunkSize) {
          const slice = clientBinaryData.subarray(offset, offset + chunkSize);
          tcpClient.write(slice);
          yield* Effect.sleep(Duration.millis(5));
        }
        tcpClient.end();

        // 4. Server receives all client bytes + END, sends DRAINED
        yield* Effect.promise(() => serverDoneResolver.promise);

        const totalServerData = Buffer.concat(serverReceivedChunks);
        expect(totalServerData.length).toBe(clientPayloadSize);
        const actualHash = NodeCrypto.createHash("sha256").update(totalServerData).digest("hex");
        expect(actualHash).toBe(expectedHash);

        // 5. Normal close completes without byte truncation
        const closeCode = yield* Effect.promise(() => wsNormalCloseResolver.promise);
        expect(closeCode).toBe(1000);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "owner destroyed or navigated during start rejects and closes acquired listeners without orphan ports",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer } = makeMockElectronWindow();
        const fakeOwners: Record<number, FakeWebContents> = {};

        const services = yield* Layer.build(
          PortForwardManager.layerWithOptions({
            getWebContents: (id: number) => {
              if (fakeOwners[id] === undefined) {
                fakeOwners[id] = new FakeWebContents();
              }
              return fakeOwners[id];
            },
          }).pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const localPort1 = yield* getAvailablePort();
        const localPort2 = yield* getAvailablePort();
        const envId = EnvironmentId.make("env-owner-lifecycle");

        // Case A: Owner already destroyed before start
        const ownerAlreadyDead = 101;
        fakeOwners[ownerAlreadyDead] = new FakeWebContents();
        fakeOwners[ownerAlreadyDead].destroy();

        const deadStartResult = yield* manager
          .start(
            {
              environmentId: envId,
              remotePort: 3101,
              remoteHost: "localhost",
              localPort: localPort1,
              origin: "user",
            },
            ownerAlreadyDead,
          )
          .pipe(
            Effect.map(() => null),
            Effect.catch((err) => Effect.succeed(err)),
          );

        expect(deadStartResult?._tag).toBe("PortForwardBindError");

        // Verify port was NOT left listening
        const testServer1 = NodeNet.createServer();
        const testBound1 = Promise.withResolvers<void>();
        testServer1.listen({ host: "127.0.0.1", port: localPort1 }, () => testBound1.resolve());
        yield* Effect.promise(() => testBound1.promise);
        const testClose1 = Promise.withResolvers<void>();
        testServer1.close(() => testClose1.resolve());
        yield* Effect.promise(() => testClose1.promise);

        // Case B: Owner is active, starts forward successfully
        const activeOwner = 102;
        fakeOwners[activeOwner] = new FakeWebContents();

        const successStart = yield* manager.start(
          {
            environmentId: envId,
            remotePort: 3102,
            remoteHost: "localhost",
            localPort: localPort2,
            origin: "user",
          },
          activeOwner,
        );
        expect(successStart.localPort).toBe(localPort2);

        // Case C: Iframe navigation is ignored and does NOT cancel the forward
        fakeOwners[activeOwner].emit("did-start-navigation", {
          isSameDocument: false,
          isMainFrame: false,
        });

        let list = yield* manager.list;
        expect(list.some((p) => p.localPort === localPort2)).toBe(true);

        // Case D: Mainframe navigation stops the forward and cleans up ports
        fakeOwners[activeOwner].emit("did-start-navigation", {
          isSameDocument: false,
          isMainFrame: true,
        });

        for (let i = 0; i < 50; i++) {
          list = yield* manager.list;
          if (!list.some((p) => p.localPort === localPort2)) break;
          yield* Effect.sleep(Duration.millis(10));
        }

        list = yield* manager.list;
        expect(list.some((p) => p.localPort === localPort2)).toBe(false);

        // Verify port is freed
        const testServer2 = NodeNet.createServer();
        const testBound2 = Promise.withResolvers<void>();
        testServer2.listen({ host: "127.0.0.1", port: localPort2 }, () => testBound2.resolve());
        yield* Effect.promise(() => testBound2.promise);
        const testClose2 = Promise.withResolvers<void>();
        testServer2.close(() => testClose2.resolve());
        yield* Effect.promise(() => testClose2.promise);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "zero-byte pre-ticket FIN server-first greeting and drain ACK preserves legitimate half-close",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });

        const serverGreeting = "GREETING-NO-CLIENT-PAYLOAD\r\n";
        const clientDrainedFromServerResolver = Promise.withResolvers<void>();
        const serverReceivedClientEndResolver = Promise.withResolvers<void>();
        const wsNormalCloseResolver = Promise.withResolvers<number>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("close", (code) => {
              wsNormalCloseResolver.resolve(code);
            });

            ws.send(PORT_FORWARD_READY);

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (!isBinary) {
                const text = data.toString("utf-8");
                if (text === PORT_FORWARD_END) {
                  // Desktop forwarded client's pre-ticket FIN
                  serverReceivedClientEndResolver.resolve();
                  ws.send(PORT_FORWARD_DRAINED);

                  // Server now sends greeting then half-closes its side
                  ws.send(Buffer.from(serverGreeting), { binary: true });
                  ws.send(PORT_FORWARD_END);
                } else if (text === PORT_FORWARD_DRAINED) {
                  // Desktop acknowledged server's END
                  clientDrainedFromServerResolver.resolve();
                }
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 6666;
        const envId = EnvironmentId.make("env-zero-byte-fin");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        // 1. Client connects with allowHalfOpen and immediately sends ZERO bytes and calls end()
        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        // Pre-ticket client half-close with 0 bytes:
        tcpClient.end();

        // 2. Ticket connection request was emitted and is still pending (not cancelled!)
        const reqMessage = yield* awaitNextRequest;
        expect(reqMessage.remotePort).toBe(remotePort);

        // 3. Resolve ticket
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        // 4. Remote WS receives the pre-ticket END from Desktop
        yield* Effect.promise(() => serverReceivedClientEndResolver.promise);

        // 5. Remote WS receives Desktop's DRAINED acknowledging server's END
        yield* Effect.promise(() => clientDrainedFromServerResolver.promise);

        // 6. Client receives the server greeting and ends
        const clientReceivedChunks: Buffer[] = [];
        const clientEndResolver = Promise.withResolvers<void>();
        tcpClient.on("data", (chunk: Buffer) => {
          clientReceivedChunks.push(chunk);
        });
        tcpClient.on("end", () => {
          clientEndResolver.resolve();
        });

        yield* Effect.promise(() => clientEndResolver.promise);
        const receivedGreeting = Buffer.concat(clientReceivedChunks).toString("utf-8");
        expect(receivedGreeting).toBe(serverGreeting);

        // 7. Normal close with 1000 completes cleanly on both sides
        const closeCode = yield* Effect.promise(() => wsNormalCloseResolver.promise);
        expect(closeCode).toBe(1000);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "forwards distinct pre-ticket binary payload and FIN before ticket resolution with normal drained teardown",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });

        const requestPayload = NodeCrypto.randomBytes(48 * 1024);
        const expectedRequestHash = NodeCrypto.createHash("sha256")
          .update(requestPayload)
          .digest("hex");

        const responsePayload = NodeCrypto.randomBytes(32 * 1024);
        const expectedResponseHash = NodeCrypto.createHash("sha256")
          .update(responsePayload)
          .digest("hex");

        const serverReceivedChunks: Buffer[] = [];
        const serverReceivedClientEndResolver = Promise.withResolvers<void>();
        const clientDrainedFromServerResolver = Promise.withResolvers<void>();
        const wsNormalCloseResolver = Promise.withResolvers<number>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("close", (code) => {
              wsNormalCloseResolver.resolve(code);
            });

            ws.send(PORT_FORWARD_READY);

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (isBinary) {
                serverReceivedChunks.push(
                  Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
                );
                return;
              }
              const text = data.toString("utf-8");
              if (text === PORT_FORWARD_END) {
                serverReceivedClientEndResolver.resolve();
                ws.send(PORT_FORWARD_DRAINED);

                // WS backend responds only after receiving client's END
                ws.send(responsePayload, { binary: true });
                ws.send(PORT_FORWARD_END);
              } else if (text === PORT_FORWARD_DRAINED) {
                clientDrainedFromServerResolver.resolve();
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address() as NodeNet.AddressInfo;
          remoteListenResolver.resolve(addr.port);
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 7777;
        const envId = EnvironmentId.make("env-pre-ticket-fin");

        yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });

        // 1. Subscribe to net.server.socket BEFORE local client connect
        const serverSocketEndResolver = Promise.withResolvers<void>();
        const onNetServerSocket = (message: unknown): void => {
          if (typeof message === "object" && message !== null && "socket" in message) {
            const candidateSocket = message.socket;
            if (
              candidateSocket instanceof NodeNet.Socket &&
              candidateSocket.localPort === localPort
            ) {
              candidateSocket.once("end", () => {
                serverSocketEndResolver.resolve();
              });
            }
          }
        };

        NodeDiagnosticsChannel.subscribe("net.server.socket", onNetServerSocket);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeDiagnosticsChannel.unsubscribe("net.server.socket", onNetServerSocket);
          }),
        );

        // 2. Client connects with allowHalfOpen
        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        // 3. Ticket connection request was emitted and is still pending
        const reqMessage = yield* awaitNextRequest;
        expect(reqMessage.remotePort).toBe(remotePort);

        // 4. Client writes distinct binary request and calls end() BEFORE ticket resolution
        tcpClient.end(requestPayload);

        // Wait native EOF externally via actual TCP half close event ordering not arbitrary sleep:
        // Wait actual SERVER's end (manager pending EOF already registered first)
        yield* Effect.promise(() => serverSocketEndResolver.promise);

        // 5. THEN resolve ticket to actual WS backend
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`,
        });

        // 5. Remote WS receives the pre-ticket END and validates request payload hash
        yield* Effect.promise(() => serverReceivedClientEndResolver.promise);
        const actualRequestHash = NodeCrypto.createHash("sha256")
          .update(Buffer.concat(serverReceivedChunks))
          .digest("hex");
        expect(actualRequestHash).toBe(expectedRequestHash);

        // 6. Client receives distinct binary response and server EOF
        const clientReceivedChunks: Buffer[] = [];
        const clientEndResolver = Promise.withResolvers<void>();
        tcpClient.on("data", (chunk: Buffer) => {
          clientReceivedChunks.push(chunk);
        });
        tcpClient.on("end", () => {
          clientEndResolver.resolve();
        });

        yield* Effect.promise(() => clientEndResolver.promise);
        const actualResponseHash = NodeCrypto.createHash("sha256")
          .update(Buffer.concat(clientReceivedChunks))
          .digest("hex");
        expect(actualResponseHash).toBe(expectedResponseHash);

        // 7. Verify normal drained teardown
        yield* Effect.promise(() => clientDrainedFromServerResolver.promise);

        const closeCode = yield* Effect.promise(() => wsNormalCloseResolver.promise);
        expect(closeCode).toBe(1000);

        const list = yield* manager.list;
        const portInfo = list.find((p) => p.localPort === localPort);
        expect(portInfo?.activeConnections).toBe(0);
        expect(portInfo?.status).toBe("listening");
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "fails with PortForwardConflictError when IPv6-only listener occupies port, leaving no surviving entry and allowing immediate IPv4 rebind",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);
        const localPort = yield* getAvailablePort();

        // 1. Occupy localPort exclusively on IPv6 (::1) with ipv6Only: true
        const ipv6Server = NodeNet.createServer();
        const ipv6Bound = Promise.withResolvers<void>();
        ipv6Server.once("error", (err) => ipv6Bound.reject(err));
        ipv6Server.listen({ host: "::1", port: localPort, ipv6Only: true }, () => {
          ipv6Bound.resolve();
        });
        yield* Effect.promise(() => ipv6Bound.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              ipv6Server.close();
            } catch {
              // ignore
            }
          }),
        );

        // 2. manager.start attempts to bind IPv4 (succeeds) then IPv6 (fails EADDRINUSE)
        const startResult = yield* manager
          .start({
            environmentId: EnvironmentId.make("env-ipv6-conflict"),
            remotePort: 8080,
            remoteHost: "localhost",
            localPort,
            origin: "user",
          })
          .pipe(
            Effect.map((port) => ({ ok: true as const, port })),
            Effect.catch((err) => Effect.succeed({ ok: false as const, err })),
          );

        expect(startResult.ok).toBe(false);
        if (!startResult.ok) {
          expect(startResult.err._tag).toBe("PortForwardConflictError");
          expect(startResult.err.localPort).toBe(localPort);
        }

        // 3. No entry survives in manager
        const list = yield* manager.list;
        expect(list.some((entry) => entry.localPort === localPort)).toBe(false);

        // 4. IPv4 listener was rolled back and can immediately rebind
        const ipv4Server = NodeNet.createServer();
        const ipv4Bound = Promise.withResolvers<void>();
        ipv4Server.once("error", (err) => ipv4Bound.reject(err));
        ipv4Server.listen({ host: "127.0.0.1", port: localPort }, () => {
          ipv4Bound.resolve();
        });
        yield* Effect.promise(() => ipv4Bound.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              ipv4Server.close();
            } catch {
              // ignore
            }
          }),
        );
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "fails clearly when starting same environment and remote target on a different explicit localPort, preserving original listener and requested port",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const initialLocalPort = yield* getAvailablePort();
        const envId = EnvironmentId.make("env-diff-port");
        const remotePort = 9000;
        const remoteHost = "localhost";

        // 1. Start original rule on initialLocalPort
        const firstStarted = yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost,
          localPort: initialLocalPort,
          origin: "user",
        });
        expect(firstStarted.localPort).toBe(initialLocalPort);

        // 2. Obtain a different available local port
        const secondLocalPort = yield* getAvailablePort();
        expect(secondLocalPort).not.toBe(initialLocalPort);

        // 3. Attempt to start the same target rule on secondLocalPort
        const secondResult = yield* manager
          .start({
            environmentId: envId,
            remotePort,
            remoteHost,
            localPort: secondLocalPort,
            origin: "user",
          })
          .pipe(
            Effect.map((port) => ({ ok: true as const, port })),
            Effect.catch((err) => Effect.succeed({ ok: false as const, err })),
          );

        expect(secondResult.ok).toBe(false);
        if (!secondResult.ok) {
          expect(
            secondResult.err._tag === "PortForwardConflictError" ||
              secondResult.err._tag === "PortForwardBindError",
          ).toBe(true);
        }

        // 4. Original listener is unaffected in manager list
        const list = yield* manager.list;
        expect(list.length).toBe(1);
        expect(list[0]?.localPort).toBe(initialLocalPort);
        expect(list[0]?.status).toBe("listening");

        // Original listener accepts TCP connections
        const tcpClient = NodeNet.connect({ host: "127.0.0.1", port: initialLocalPort });
        const tcpConnected = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnected.resolve());
        tcpClient.once("error", (err) => tcpConnected.reject(err));
        yield* Effect.promise(() => tcpConnected.promise);
        tcpClient.destroy();

        // 5. Requested secondLocalPort was not bound and remains completely free
        const probeIpv4 = NodeNet.createServer();
        const probeIpv4Bound = Promise.withResolvers<void>();
        probeIpv4.once("error", (err) => probeIpv4Bound.reject(err));
        probeIpv4.listen({ host: "127.0.0.1", port: secondLocalPort }, () => {
          probeIpv4Bound.resolve();
        });
        yield* Effect.promise(() => probeIpv4Bound.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              probeIpv4.close();
            } catch {
              // ignore
            }
          }),
        );
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "promotes auto-origin forward to user on identical target restart, surviving auto-off cleanup and serving fresh requests to real WS backend",
    () =>
      Effect.gen(function* () {
        const { layer: electronWindowLayer, awaitNextRequest } = makeMockElectronWindow();
        const services = yield* Layer.build(
          PortForwardManager.layer.pipe(Layer.provide(electronWindowLayer)),
        );
        const manager = Context.get(services, PortForwardManager.PortForwardManager);

        const remoteHttpServer = NodeHttp.createServer();
        const wss = new WebSocketServer({ noServer: true });
        let remoteWs: WebSocket | null = null;

        const receivedFromClient: Buffer[] = [];
        const halfCloseReceivedResolver = Promise.withResolvers<void>();
        const clientDrainedResolver = Promise.withResolvers<void>();

        remoteHttpServer.on("upgrade", (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            remoteWs = ws;
            ws.send(PORT_FORWARD_READY);

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                receivedFromClient.push(buf);
              } else {
                const text = data.toString("utf-8");
                if (text === PORT_FORWARD_END) {
                  halfCloseReceivedResolver.resolve();
                  ws.send(PORT_FORWARD_DRAINED);
                } else if (text === PORT_FORWARD_DRAINED) {
                  clientDrainedResolver.resolve();
                }
              }
            });
          });
        });

        const remoteListenResolver = Promise.withResolvers<number>();
        remoteHttpServer.listen(0, "127.0.0.1", () => {
          const addr = remoteHttpServer.address();
          if (addr !== null && typeof addr === "object") {
            remoteListenResolver.resolve(addr.port);
          }
        });

        const serverPort = yield* Effect.promise(() => remoteListenResolver.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            remoteHttpServer.close();
            wss.close();
          }),
        );

        const localPort = yield* getAvailablePort();
        const remotePort = 8443;
        const envId = EnvironmentId.make("env-promote-test");

        // 1. Start forward with origin auto
        const autoStarted = yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "auto",
        });
        expect(autoStarted.origin).toBe("auto");
        expect(autoStarted.localPort).toBe(localPort);

        // 2. Start identical target and localPort with origin user -> promotes to user
        const promotedStarted = yield* manager.start({
          environmentId: envId,
          remotePort,
          remoteHost: "localhost",
          localPort,
          origin: "user",
        });
        expect(promotedStarted.origin).toBe("user");
        expect(promotedStarted.localPort).toBe(localPort);

        // Manager list reflects promoted origin
        const listAfterPromotion = yield* manager.list;
        expect(listAfterPromotion.length).toBe(1);
        expect(listAfterPromotion[0]?.origin).toBe("user");

        // 3. Simulate Auto-off caller stopping only auto-owned entries
        const currentEntries = yield* manager.list;
        for (const entry of currentEntries) {
          if (entry.origin === "auto") {
            yield* manager.stop({
              environmentId: entry.environmentId,
              remotePort: entry.remotePort,
              remoteHost: entry.remoteHost,
            });
          }
        }

        // Promoted user listener survives Auto-off caller
        const listAfterAutoOff = yield* manager.list;
        expect(listAfterAutoOff.length).toBe(1);
        expect(listAfterAutoOff[0]?.origin).toBe("user");

        // 4. Prove user listener still works with actual fresh request -> real WS backend
        const tcpClient = NodeNet.connect({
          host: "127.0.0.1",
          port: localPort,
          allowHalfOpen: true,
        });
        const tcpConnectedResolvers = Promise.withResolvers<void>();
        tcpClient.once("connect", () => tcpConnectedResolvers.resolve());
        yield* Effect.promise(() => tcpConnectedResolvers.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => tcpClient.destroy()));

        const reqMessage = yield* awaitNextRequest;

        const mockedWsUrl = `ws://127.0.0.1:${serverPort}/api/ports/ws?port=${remotePort}&host=localhost`;
        yield* manager.resolveConnection({
          requestId: reqMessage.requestId,
          socketUrl: mockedWsUrl,
        });

        const requestPayload = Buffer.from("GET /api/user-promoted HTTP/1.1\r\n\r\n");
        tcpClient.write(requestPayload);
        tcpClient.end();

        yield* Effect.promise(() => halfCloseReceivedResolver.promise);
        const receivedData = Buffer.concat(receivedFromClient);
        expect(receivedData.toString("utf-8")).toBe(requestPayload.toString("utf-8"));

        const responseDataResolver = Promise.withResolvers<Buffer>();
        const tcpChunks: Buffer[] = [];
        tcpClient.on("data", (chunk: Buffer) => {
          tcpChunks.push(chunk);
        });
        tcpClient.on("end", () => {
          responseDataResolver.resolve(Buffer.concat(tcpChunks));
        });

        const responsePayload = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nSUCCESS");
        expect(remoteWs).not.toBeNull();
        remoteWs!.send(responsePayload, { binary: true });
        remoteWs!.send(PORT_FORWARD_END);

        yield* Effect.promise(() => clientDrainedResolver.promise);
        const receivedResponse = yield* Effect.promise(() => responseDataResolver.promise);
        expect(receivedResponse.toString("utf-8")).toBe(responsePayload.toString("utf-8"));
      }).pipe(Effect.scoped),
    20_000,
  );
});
