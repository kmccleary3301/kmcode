import { EnvironmentId, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/http";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { remoteStateKey } from "@t3tools/ssh/remote-scripts";
import type { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import type { MobileSshNative } from "./nativeSsh";
import { makeMobileSshGateway } from "./ssh-gateway";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "test",
  hostname: "ssh.example.test",
  username: "developer",
  port: 22,
};
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const EXPECTED_FINGERPRINT = "SHA256:test-host-key";
type NativeSession = {
  readonly sessionId: string;
  readonly fingerprint: string;
};
type NativeExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};
const SESSION: NativeSession = {
  sessionId: "session-1",
  fingerprint: EXPECTED_FINGERPRINT,
};
const CREDENTIALS: ClientCapabilities.MobileSshCredentials = {
  password: "ssh-password",
  expectedFingerprint: EXPECTED_FINGERPRINT,
};

type NativeFixtureOptions = {
  readonly connect?: MobileSshNative["connect"];
  readonly exec?: MobileSshNative["exec"];
};

function makeNativeFixture(options: NativeFixtureOptions = {}) {
  const acquiredSessionIds: Array<string> = [];
  const disconnectedSessionIds: Array<string> = [];
  const execCommands: Array<string> = [];

  const connect: MobileSshNative["connect"] =
    options.connect ??
    ((_host, _port, _username, _password, _privateKey, _passphrase, _expectedFingerprint) =>
      Promise.resolve(SESSION));
  const exec: MobileSshNative["exec"] =
    options.exec ??
    ((_sessionId, _command, _stdin) =>
      Promise.resolve<NativeExecResult>({ stdout: "", stderr: "", exitCode: 0 }));

  const native: MobileSshNative = {
    inspectHost: (_host, _port) => Promise.resolve({ fingerprint: EXPECTED_FINGERPRINT }),
    connect: async (...args) => {
      const session = await connect(...args);
      acquiredSessionIds.push(session.sessionId);
      return session;
    },
    exec: (sessionId, command, stdin) => {
      execCommands.push(command);
      return exec(sessionId, command, stdin);
    },
    forward: (_sessionId, _remoteHost, _remotePort) => Promise.resolve({ localPort: 43123 }),
    disconnect: async (sessionId) => {
      disconnectedSessionIds.push(sessionId);
    },
  };

  return { acquiredSessionIds, disconnectedSessionIds, execCommands, native };
}

function makeStorage(initial: ReadonlyMap<string, string>): MobileSecureStorage["Service"] {
  const values = new Map<string, string>();
  for (const [key, value] of initial) {
    values.set(key, value);
  }

  return {
    getItem: (key) => Effect.succeed(values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  };
}

const TEST_CRYPTO = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(async () => {
      const input = new Uint8Array(data.length);
      input.set(data);
      return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input));
    }),
});

function makeGateway(
  native: MobileSshNative,
  storage: MobileSecureStorage["Service"] = makeStorage(new Map()),
) {
  return makeMobileSshGateway({
    storage,
    httpClient: HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    presentation: ClientCapabilities.ClientPresentation.of({
      metadata: { label: "KM Code Test", deviceType: "mobile" },
    }),
    crypto: TEST_CRYPTO,
    native,
  });
}

describe("mobile SSH gateway", () => {
  it.effect("maps a failed remote command to a transient error and closes the session", () =>
    Effect.gen(function* () {
      const native = makeNativeFixture({
        exec: (_sessionId, _command, _stdin) =>
          Promise.resolve({
            stdout: "",
            stderr: "remote launch failed",
            exitCode: 42,
          }),
      });
      const gateway = makeGateway(native.native);

      const error = yield* Effect.flip(
        gateway.provision(TARGET, undefined, { credentials: CREDENTIALS }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect(native.acquiredSessionIds).toEqual([SESSION.sessionId]);
      expect(native.disconnectedSessionIds).toEqual([SESSION.sessionId]);
    }),
  );

  it.effect("maps a malformed launch response to a transient error and closes the session", () =>
    Effect.gen(function* () {
      const native = makeNativeFixture({
        exec: (_sessionId, _command, _stdin) =>
          Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 }),
      });
      const gateway = makeGateway(native.native);

      const error = yield* Effect.flip(
        gateway.provision(TARGET, undefined, { credentials: CREDENTIALS }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect(native.acquiredSessionIds).toEqual([SESSION.sessionId]);
      expect(native.disconnectedSessionIds).toEqual([SESSION.sessionId]);
    }),
  );

  it.effect("closes a session acquired after cancellation during native connect", () =>
    Effect.gen(function* () {
      const connectStarted = Promise.withResolvers<void>();
      const pendingNativeConnect = Promise.withResolvers<NativeSession>();
      const native = makeNativeFixture({
        connect: () => {
          connectStarted.resolve();
          return pendingNativeConnect.promise;
        },
        exec: () =>
          Promise.reject(new Error("remote execution should not begin after cancellation")),
      });
      const gateway = makeGateway(native.native);
      const connecting = yield* Effect.forkChild(
        gateway.provision(TARGET, undefined, { credentials: CREDENTIALS }),
        { startImmediately: true },
      );

      yield* Effect.promise(() => connectStarted.promise);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(connecting), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      pendingNativeConnect.resolve(SESSION);
      yield* Fiber.join(interrupting);

      const exit = yield* Fiber.await(connecting);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      }
      expect(native.acquiredSessionIds).toEqual([SESSION.sessionId]);
      expect(native.disconnectedSessionIds).toEqual([SESSION.sessionId]);
      expect(native.execCommands).toEqual([]);
    }),
  );

  it.effect("blocks corrupt saved credentials without echoing their secret content", () =>
    Effect.gen(function* () {
      const secret = "corrupt-saved-ssh-secret";
      const credentialsKey = `t3code.ssh.credentials.${yield* remoteStateKey(TARGET).pipe(
        Effect.provideService(Crypto.Crypto, TEST_CRYPTO),
      )}`;
      const gateway = makeGateway(
        makeNativeFixture().native,
        makeStorage(new Map([[credentialsKey, `{"password":"${secret}"`]])),
      );

      const error = yield* Effect.flip(
        gateway.prepare({
          connectionId: "connection-1",
          expectedEnvironmentId: ENVIRONMENT_ID,
          target: TARGET,
        }),
      );

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error.reason).toBe("authentication");
      expect(error.message).not.toContain(secret);
    }),
  );
});
