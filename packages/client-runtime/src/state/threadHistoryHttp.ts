import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import type { ThreadActivityPageRequest } from "./threadActivityMerge.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor?: string | undefined;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}/history`),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadHistoryPage({
        params: { threadId: input.threadId },
        query: {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.view === undefined ? {} : { view: input.view }),
          ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
        },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});
export const fetchEnvironmentThreadActivityPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadActivityPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly pageRequest: ThreadActivityPageRequest;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: input.signer,
    ...(input.remoteAuthorization === undefined
      ? {}
      : { remoteAuthorization: input.remoteAuthorization }),
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}/activity`),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadActivityPage({
        params: { threadId: input.threadId },
        query: {
          ...(input.pageRequest.sourceThreadId === undefined
            ? {}
            : { sourceThreadId: input.pageRequest.sourceThreadId }),
          ...(input.pageRequest.groupStartItemId === undefined
            ? {}
            : { groupStartItemId: input.pageRequest.groupStartItemId }),
          ...(input.pageRequest.cursor === undefined ? {} : { cursor: input.pageRequest.cursor }),
          ...(input.pageRequest.anchorItemId === undefined
            ? {}
            : { anchorItemId: input.pageRequest.anchorItemId }),
          ...(input.pageRequest.summaryOnly === undefined
            ? {}
            : { summaryOnly: input.pageRequest.summaryOnly }),
        },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});
