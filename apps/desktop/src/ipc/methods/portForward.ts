import type {
  PortForwardConnectionResolution,
  PortForwardKey,
  PortForwardStart,
} from "@t3tools/contracts";
import {
  ForwardedPort as ForwardedPortSchema,
  ForwardedPorts,
  PortForwardConnectionResolution as PortForwardConnectionResolutionSchema,
  PortForwardKey as PortForwardKeySchema,
  PortForwardStart as PortForwardStartSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as PortForwardManager from "../../ports/PortForwardManager.ts";

export const portForwardList = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_LIST_CHANNEL,
  payload: Schema.Void,
  result: ForwardedPorts,
  handler: Effect.fn("desktop.ipc.portForwardList")(function* () {
    const manager = yield* PortForwardManager.PortForwardManager;
    return yield* manager.list;
  }),
});

export const portForwardStart = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_START_CHANNEL,
  payload: PortForwardStartSchema,
  result: ForwardedPortSchema,
  handler: Effect.fn("desktop.ipc.portForwardStart")(function* (
    input: PortForwardStart,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const manager = yield* PortForwardManager.PortForwardManager;
    return yield* manager.start(input, event?.sender.id);
  }),
});

export const portForwardStop = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_STOP_CHANNEL,
  payload: PortForwardKeySchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForwardStop")(function* (input: PortForwardKey) {
    const manager = yield* PortForwardManager.PortForwardManager;
    yield* manager.stop(input);
  }),
});

export const portForwardStopAll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_STOP_ALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Number,
  handler: Effect.fn("desktop.ipc.portForwardStopAll")(function* () {
    const manager = yield* PortForwardManager.PortForwardManager;
    return yield* manager.stopAll;
  }),
});

export const portForwardResolveConnection = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_RESOLVE_CONNECTION_CHANNEL,
  payload: PortForwardConnectionResolutionSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForwardResolveConnection")(function* (
    input: PortForwardConnectionResolution,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const manager = yield* PortForwardManager.PortForwardManager;
    yield* manager.resolveConnection(input, event?.sender.id);
  }),
});
