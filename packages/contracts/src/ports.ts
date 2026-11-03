import * as Schema from "effect/Schema";

import { EnvironmentId, PortSchema } from "./baseSchemas.ts";

/** Raw TCP tunnels only target the server's own loopback interfaces. */
export const PortForwardHost = Schema.Literals(["localhost", "127.0.0.1", "::1"]);
export type PortForwardHost = typeof PortForwardHost.Type;

export const ListeningPort = Schema.Struct({
  port: PortSchema,
  host: PortForwardHost,
  processName: Schema.NullOr(Schema.String),
  pid: Schema.NullOr(Schema.Int),
});
export type ListeningPort = typeof ListeningPort.Type;
export const ListeningPorts = Schema.Array(ListeningPort);

export const PortForwardStart = Schema.Struct({
  environmentId: EnvironmentId,
  remotePort: PortSchema,
  remoteHost: PortForwardHost,
  localPort: PortSchema,
  origin: Schema.Literals(["user", "auto"]),
});
export type PortForwardStart = typeof PortForwardStart.Type;

export const PortForwardKey = Schema.Struct({
  environmentId: EnvironmentId,
  remotePort: PortSchema,
  remoteHost: PortForwardHost,
});
export type PortForwardKey = typeof PortForwardKey.Type;

export const ForwardedPort = Schema.Struct({
  environmentId: EnvironmentId,
  remotePort: PortSchema,
  remoteHost: PortForwardHost,
  localPort: PortSchema,
  localAddress: Schema.String,
  origin: Schema.Literals(["user", "auto"]),
  status: Schema.Literals(["listening", "forwarding", "error"]),
  activeConnections: Schema.Int,
  error: Schema.NullOr(Schema.String),
});
export type ForwardedPort = typeof ForwardedPort.Type;
export const ForwardedPorts = Schema.Array(ForwardedPort);

/** A fresh, single-use WebSocket ticket is requested for each accepted TCP connection. */
export const PortForwardConnectionRequest = Schema.Struct({
  requestId: Schema.String,
  environmentId: EnvironmentId,
  remotePort: PortSchema,
  remoteHost: PortForwardHost,
});
export type PortForwardConnectionRequest = typeof PortForwardConnectionRequest.Type;

export const PortForwardConnectionResolution = Schema.Struct({
  requestId: Schema.String,
  socketUrl: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type PortForwardConnectionResolution = typeof PortForwardConnectionResolution.Type;

export const PORT_FORWARD_ROUTE = "/api/ports/ws";
export const LISTENING_PORTS_ROUTE = "/api/ports";
/** Binary frames are unmodified TCP bytes; text frames carry lifecycle control. */
export const PORT_FORWARD_READY = "ready";
export const PORT_FORWARD_END = "end";
/** Acknowledges that the peer's END and preceding bytes have flushed to TCP. */
export const PORT_FORWARD_DRAINED = "drained";
export const PORT_FORWARD_CONNECT_FAILED = 4404;
export const PORT_FORWARD_PROTOCOL_ERROR = 4400;
