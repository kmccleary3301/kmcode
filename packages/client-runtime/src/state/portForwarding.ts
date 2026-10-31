import type { HttpClient } from "effect/http";
import type { ListeningPort, PortForwardHost } from "@t3tools/contracts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";

import { LISTENING_PORTS_ROUTE, PORT_FORWARD_ROUTE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const TICKET_TIMEOUT_MS = 8_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

export const sanitizeConnectionError = (error: unknown): string => {
  if (!error) return "Unknown port forwarding connection failure";
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/wsTicket=[^&\s]+/gi, "wsTicket=[REDACTED]")
    .replace(/bearer\s+[\w\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/dpop\s+[\w\-._~+/]+=*/gi, "DPoP [REDACTED]");
};

export const resolvePortForwardWebSocketUrl = Effect.fn(
  "clientRuntime.state.resolvePortForwardWebSocketUrl",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly remotePort: number;
  readonly remoteHost: PortForwardHost;
}): Effect.fn.Return<string, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );

  const ticket = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "auth",
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket"),
    timeoutMs: TICKET_TIMEOUT_MS,
    request: ({ client, headers }) => client.webSocketTicket({ headers }),
  });

  const httpUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, PORT_FORWARD_ROUTE);
  const wsUrl = new URL(httpUrl.replace(/^http/, "ws"));
  wsUrl.searchParams.set("port", String(input.remotePort));
  wsUrl.searchParams.set("host", input.remoteHost);
  wsUrl.searchParams.set("wsTicket", Redacted.value(ticket.ticket));

  return wsUrl.toString();
});

export const fetchListeningPorts = Effect.fn("clientRuntime.state.fetchListeningPorts")(
  function* (input: {
    readonly prepared: PreparedConnection;
  }): Effect.fn.Return<
    readonly ListeningPort[],
    RemoteEnvironmentRequestError,
    HttpClient.HttpClient
  > {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );

    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      group: "ports",
      method: "GET",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, LISTENING_PORTS_ROUTE),
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      request: ({ client, headers }) => client.list({ headers }),
    });
  },
);
