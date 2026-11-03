import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  remoteStateKey,
} from "@t3tools/ssh/remote-scripts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as SecureStorage from "../persistence/mobile-secure-storage";
import type { MobileSshNative } from "./nativeSsh";

const decodeLaunch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      remotePort: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(65535),
      ),
      serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
    }),
  ),
);
const decodePairing = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);
const decodeCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      password: Schema.optional(Schema.String),
      privateKey: Schema.optional(Schema.String),
      passphrase: Schema.optional(Schema.String),
      expectedFingerprint: Schema.optional(Schema.String),
    }),
  ),
);

export function makeMobileSshGateway(input: {
  readonly storage: SecureStorage.MobileSecureStorage["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly presentation: ClientCapabilities.ClientPresentation["Service"];
  readonly crypto: Crypto.Crypto;
  readonly native: MobileSshNative;
}) {
  const sessions = new Map<string, string>();
  const stateKey = (target: DesktopSshEnvironmentTarget) =>
    remoteStateKey(target).pipe(Effect.provideService(Crypto.Crypto, input.crypto));
  const mapError = (cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return detail.includes("HOST_KEY") ||
      detail.includes("AUTH_REQUIRED") ||
      detail.includes("T3_SSH_AUTH")
      ? new ConnectionBlockedError({ reason: "authentication", detail })
      : new ConnectionTransientError({ reason: "remote-unavailable", detail });
  };
  const invalidResponse = () =>
    new ConnectionTransientError({
      reason: "remote-unavailable",
      detail: "The SSH server returned an invalid KM Code response.",
    });
  const readCredentials = (target: DesktopSshEnvironmentTarget) =>
    stateKey(target).pipe(
      Effect.flatMap((key) => input.storage.getItem(`t3code.ssh.credentials.${key}`)),
      Effect.mapError(mapError),
      Effect.flatMap((value) =>
        value === null
          ? Effect.succeed(undefined)
          : decodeCredentials(value).pipe(
              Effect.mapError(
                () =>
                  new ConnectionBlockedError({
                    reason: "authentication",
                    detail: "Saved SSH credentials are invalid. Re-enter them.",
                  }),
              ),
            ),
      ),
    );
  const connect = (
    target: DesktopSshEnvironmentTarget,
    credentials: ClientCapabilities.MobileSshCredentials,
  ) =>
    Effect.tryPromise({
      try: () =>
        input.native.connect(
          target.hostname,
          target.port ?? 22,
          target.username ?? "",
          credentials.password ?? null,
          credentials.privateKey ?? null,
          credentials.passphrase ?? null,
          credentials.expectedFingerprint ?? null,
        ),
      catch: mapError,
    });
  const closeSession = (key: string, sessionId: string) =>
    Effect.tryPromise({
      try: () => input.native.disconnect(sessionId),
      catch: mapError,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (sessions.get(key) === sessionId) sessions.delete(key);
        }),
      ),
    );
  const exec = (sessionId: string, command: string, stdin: string) =>
    Effect.tryPromise({
      try: () => input.native.exec(sessionId, command, stdin),
      catch: mapError,
    }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail:
                  result.stderr.trim() || `SSH command exited with status ${result.exitCode}.`,
              }),
            ),
      ),
    );
  const jsonObject = (stdout: string) =>
    Effect.try({ try: () => extractJsonObject(stdout), catch: invalidResponse });

  const establish = (
    target: DesktopSshEnvironmentTarget,
    credentials: ClientCapabilities.MobileSshCredentials,
    options: {
      readonly expectedEnvironmentId?: EnvironmentId;
      readonly rememberCredentials: boolean;
    },
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!credentials.expectedFingerprint) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Confirm this SSH host fingerprint before connecting.",
          });
        }
        const key = yield* stateKey(target);
        const previous = sessions.get(key);
        if (previous !== undefined) yield* closeSession(key, previous);
        // Native connect has a deadline. Register its result before honoring cancellation so it cannot leak.
        const connected = yield* connect(target, credentials);
        const sessionId = connected.sessionId;
        sessions.set(key, sessionId);
        return yield* restore(
          Effect.gen(function* () {
            const launchOutput = yield* exec(
              sessionId,
              `sh -l -s -- ${key}`,
              buildRemoteLaunchScript({ installedCli: true }),
            );
            const launch = yield* jsonObject(launchOutput).pipe(
              Effect.flatMap(decodeLaunch),
              Effect.mapError(invalidResponse),
            );
            const forwarding = yield* Effect.tryPromise({
              try: () => input.native.forward(sessionId, "127.0.0.1", launch.remotePort),
              catch: mapError,
            });
            const httpBaseUrl = `http://127.0.0.1:${forwarding.localPort}/`;
            const wsBaseUrl = `ws://127.0.0.1:${forwarding.localPort}/`;
            const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
              Effect.provideService(HttpClient.HttpClient, input.httpClient),
              Effect.mapError(mapError),
            );
            if (
              options.expectedEnvironmentId !== undefined &&
              descriptor.environmentId !== options.expectedEnvironmentId
            ) {
              return yield* new ConnectionBlockedError({
                reason: "configuration",
                detail: "The SSH host resolved to a different environment.",
              });
            }
            const pairingOutput = yield* exec(
              sessionId,
              "sh -s",
              buildRemotePairingScript(key, { installedCli: true }),
            );
            const pairing = yield* jsonObject(pairingOutput).pipe(
              Effect.flatMap(decodePairing),
              Effect.mapError(invalidResponse),
            );
            const access = yield* bootstrapRemoteBearerSession({
              httpBaseUrl,
              credential: pairing.credential,
              clientMetadata: input.presentation.metadata,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, input.httpClient),
              Effect.mapError(mapError),
            );
            if (options.rememberCredentials) {
              yield* input.storage
                .setItem(`t3code.ssh.credentials.${key}`, JSON.stringify(credentials))
                .pipe(Effect.mapError(mapError));
            }
            const bootstrap: DesktopSshEnvironmentBootstrap = {
              target,
              httpBaseUrl,
              wsBaseUrl,
              pairingToken: pairing.credential,
              remotePort: launch.remotePort,
              remoteServerKind: launch.serverKind,
            };
            return {
              environmentId: descriptor.environmentId,
              label: descriptor.label,
              bootstrap,
              bearerToken: access.access_token,
            };
          }),
        ).pipe(Effect.onError(() => closeSession(key, sessionId).pipe(Effect.orDie)));
      }),
    );

  return ClientCapabilities.SshEnvironmentGateway.of({
    provision: (target, expectedEnvironmentId, options) =>
      options?.credentials === undefined
        ? Effect.fail(
            new ConnectionBlockedError({
              reason: "authentication",
              detail: "SSH credentials are required.",
            }),
          )
        : establish(target, options.credentials, {
            ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }),
            rememberCredentials: true,
          }),
    prepare: ({ target, expectedEnvironmentId }) =>
      Effect.gen(function* () {
        const credentials = yield* readCredentials(target);
        if (credentials === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Saved SSH credentials are unavailable.",
          });
        }
        const result = yield* establish(target, credentials, {
          expectedEnvironmentId,
          rememberCredentials: false,
        });
        return { bootstrap: result.bootstrap, bearerToken: result.bearerToken };
      }),
    disconnect: (target) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const key = yield* stateKey(target);
          let sessionId = sessions.get(key);
          if (sessionId === undefined) {
            const credentials = yield* readCredentials(target);
            if (credentials === undefined) return;
            sessionId = (yield* connect(target, credentials)).sessionId;
            sessions.set(key, sessionId);
          }
          yield* restore(exec(sessionId, "sh -s", buildRemoteStopScript(key))).pipe(
            Effect.ensuring(closeSession(key, sessionId).pipe(Effect.orDie)),
          );
        }),
      ),
  });
}
