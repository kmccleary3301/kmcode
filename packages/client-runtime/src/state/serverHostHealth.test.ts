import {
  EnvironmentId,
  WS_METHODS,
  type ServerConfig,
  type ServerHostHealthSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("host-health-environment"),
  label: "Host health environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function snapshot(sampledAt: number, serverInstanceId: string): ServerHostHealthSnapshot {
  return {
    sampledAt,
    sampleWindowMs: 5_000,
    platform: "linux",
    serverInstanceId,
    serverStartedAt: 1_000,
    hostBootId: "boot-1",
    loadAverage: [0, 0, 0],
    memoryAvailableBytes: null,
    swapUsedBytes: null,
    pressure: {
      io: { someAvg10Percent: 0, fullAvg10Percent: null },
      memory: { someAvg10Percent: 0, fullAvg10Percent: null },
      cpu: { someAvg10Percent: 0, fullAvg10Percent: null },
    },
    eventLoopDelayP99Ms: 0,
    eventLoopDelayMaxMs: 0,
    diskWriters: [],
    diskReaders: [],
    dStateTasks: 0,
    currentStall: null,
    completedStalls: [],
  };
}

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

it.effect("retains the last host-health beacon across transport loss and reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = snapshot(1_000, "server-1");
      const second = snapshot(6_000, "server-2");
      const firstStreamEnded = yield* Deferred.make<void>();
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const firstClient = {
        [WS_METHODS.serverSubscribeHostHealth]: () =>
          Stream.concat(Stream.make(first), Stream.fail(disconnect)).pipe(
            Stream.ensuring(Deferred.succeed(firstStreamEnded, undefined).pipe(Effect.asVoid)),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.serverSubscribeHostHealth]: () => Stream.make(second),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const sessionState = yield* SubscriptionRef.make(Option.none<RpcSession>());
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
        }),
        session: sessionState,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
          Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make<ServerConfig | null>(null),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (current) =>
        Effect.sync(() => current.dispose()),
      );
      const subscription = atoms.hostHealth({ environmentId: TARGET.environmentId, input: {} });
      const latest = atoms.hostHealthLatest(TARGET.environmentId);
      const unmount = registry.mount(subscription);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      yield* SubscriptionRef.set(sessionState, Option.some(firstSession));
      const firstObservation = yield* AtomRegistry.toStream(registry, latest).pipe(
        Stream.filter((observation) => observation?.snapshot.sampledAt === first.sampledAt),
        Stream.runHead,
      );
      const firstReceived = Option.getOrElse(firstObservation, () => null);
      expect(firstReceived?.snapshot).toEqual(first);
      expect(firstReceived?.receivedAt).toBeGreaterThan(0);
      yield* Deferred.await(firstStreamEnded);
      expect(registry.get(latest)?.snapshot).toEqual(first);
      expect(registry.get(latest)?.receivedAt).toBe(firstReceived?.receivedAt);

      yield* SubscriptionRef.set(sessionState, Option.some(secondSession));
      const secondObservation = yield* AtomRegistry.toStream(registry, latest).pipe(
        Stream.filter((observation) => observation?.snapshot.sampledAt === second.sampledAt),
        Stream.runHead,
      );
      expect(Option.getOrElse(secondObservation, () => null)).toMatchObject({
        snapshot: second,
        previousSnapshot: first,
      });
    }),
  ),
);
