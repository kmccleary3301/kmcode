// @effect-diagnostics nodeBuiltinImport:off - Measures real local HTTP/WebSocket sockets.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadBoundedSnapshot as ThreadBoundedSnapshot,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  AuthSessionId,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadActivityPage,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2GetThreadProjectionError,
  ProviderDriverKind,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpRouter, HttpServer } from "effect/http";
import { Rpc, RpcGroup, RpcServer, RpcSerialization } from "effect/rpc";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../src/persistence/OrchestrationEventStore.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { THREAD_HISTORY_SNAPSHOT_ROW_LIMIT } from "../src/orchestration-v2/threadHistoryPaging.ts";
import * as ThreadManagementService from "../src/orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ProjectEnrichmentService from "../src/project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "../src/orchestration-v2/http.ts";
import * as ServerHttp from "../src/http.ts";
import { subscribeOrchestrationV2Thread, subscribeOrchestrationV2Shell } from "../src/ws.ts";
import {
  measureHttpGet,
  type HttpTransferMeasurement,
  openMeasuredWsClient,
  type MeasuredWsClient,
  type WebSocketTransferTotals,
} from "./NetworkTransferMeasurement.integration.ts";
import { makeSqlStatementCounter } from "./SqlStatementCounter.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  transferBudgetViolations,
  type TransferBudgetRun,
} from "./TransferBudgetReport.integration.ts";
import { TRANSFER_HISTORY_TURN_COUNT } from "./fixtures/transferBudget.ts";
import { THREAD_ID, threadCreated, turnEvents } from "./TransferBudgetV2Fixture.integration.ts";

const decodeThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);
const decodeBoundedThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeActivityPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadActivityPage)),
);
const decodeHistoryPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage)),
);
const decodeShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellSnapshot)),
);

const measureBoundedSnapshotOpens = Effect.fn("transfer.measureBoundedSnapshotOpens")(function* (
  url: string,
) {
  const endToEndSamples: number[] = [];
  const httpAndGunzipSamples: number[] = [];
  const schemaDecodeSamples: number[] = [];
  let firstResponse: HttpTransferMeasurement | undefined;
  let firstSnapshot: ThreadBoundedSnapshot | undefined;
  for (let sample = 0; sample < 6; sample += 1) {
    const startedAt = performance.now();
    const response = yield* measureHttpGet({
      url,
      headers: {
        [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
      },
    });
    const responseAt = performance.now();
    assert.equal(response.status, 200, Buffer.from(response.decodedBody).toString());
    assert.equal(response.contentEncoding, "gzip");
    const snapshot = yield* decodeBoundedThreadSnapshot(
      Buffer.from(response.decodedBody).toString(),
    );
    const decodedAt = performance.now();
    httpAndGunzipSamples.push(responseAt - startedAt);
    schemaDecodeSamples.push(decodedAt - responseAt);
    endToEndSamples.push(decodedAt - startedAt);
    if (sample === 0) {
      firstResponse = response;
      firstSnapshot = snapshot;
    }
  }
  if (firstResponse === undefined || firstSnapshot === undefined) {
    return yield* Effect.die("Missing bounded snapshot measurement");
  }
  const warmSorted = endToEndSamples.slice(1).toSorted((left, right) => left - right);
  const warmMedianMs = warmSorted[Math.floor(warmSorted.length / 2)] ?? 0;
  return {
    firstResponse,
    firstSnapshot,
    endToEndSamples,
    httpAndGunzipSamples,
    schemaDecodeSamples,
    warmMedianMs,
    warmSpreadMs: (warmSorted.at(-1) ?? warmMedianMs) - (warmSorted[0] ?? warmMedianMs),
    schemaDecodedSnapshotBytes: Buffer.byteLength(JSON.stringify(firstSnapshot), "utf8"),
  };
});

const layerPersistence = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
// The facade's import/command paths are outside this measurement. Its reads and
// stream delegate to the real SQL projection and event sink, as the runtime does.
const layerManagement = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
      getShellSnapshot: (options) => projections.getShellSnapshot(options).pipe(Effect.orDie),
      countThreads: () => projections.countThreads().pipe(Effect.orDie),
      listActiveShellIndex: () => projections.listActiveShellIndex().pipe(Effect.orDie),
      streamStoredEventsFrom: (input) =>
        sink.stream({ ...input, bounded: true }).pipe(Stream.orDie),
    });
  }),
);
const layerEnrichment = Layer.unwrap(
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<never>();
    return Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        }),
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);
// The transfer history has no project events, so shell streams never read a project shell.
const layerServices = layerManagement.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provideMerge(layerEnrichment),
  Layer.provideMerge(layerPersistence),
);
class TransferApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const layerAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("transfer-session"),
      subject: "transfer-test",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);
const group = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
    payload: OrchestrationV2RpcSchemas.subscribeThread.input,
    success: OrchestrationV2RpcSchemas.subscribeThread.output,
    error: OrchestrationV2GetThreadProjectionError,
    stream: true,
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
    payload: OrchestrationV2RpcSchemas.subscribeShell.input,
    success: OrchestrationV2RpcSchemas.subscribeShell.output,
    error: OrchestrationV2GetShellSnapshotError,
    stream: true,
  }),
);
const layerHandlers = group.toLayer({
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
    Stream.unwrap(
      subscribeOrchestrationV2Thread({
        ...input,
        requestCompletionMarker: true,
      }),
    ),
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
    Stream.unwrap(subscribeOrchestrationV2Shell(input)),
});
const layerRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(TransferApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(layerAuth),
  ),
  RpcServer.layerHttp({ group, path: "/ws", protocol: "websocket" }).pipe(
    Layer.provide(layerHandlers),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(ServerHttp.layerHttpCompression), Layer.provide(NodeHttpPlatform.layer));

function difference(
  after: WebSocketTransferTotals,
  before: WebSocketTransferTotals,
): WebSocketTransferTotals {
  return {
    wireBytes: after.wireBytes - before.wireBytes,
    decodedBytes: after.decodedBytes - before.decodedBytes,
    messages: after.messages - before.messages,
    largestMessageBytes: after.largestMessageBytes,
  };
}
type StreamItem = OrchestrationV2ThreadStreamItem | OrchestrationV2ShellStreamItem;
const collectUntil = Effect.fn("transfer.collectUntil")(function* <T extends StreamItem>(
  queue: Queue.Queue<T>,
  done: (item: T) => boolean,
) {
  const items: T[] = [];
  while (true) {
    const item = yield* Queue.take(queue);
    items.push(item);
    if (done(item)) return items;
  }
});
const subscribe = Effect.fn("transfer.subscribe")(function* (
  client: MeasuredWsClient,
  kind: "thread" | "shell",
  afterSequence?: number,
  activityMode?: "summary-v1",
) {
  const queue = yield* Queue.unbounded<StreamItem>();
  const stream: Stream.Stream<StreamItem, unknown> =
    kind === "thread"
      ? client.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId: THREAD_ID,
          ...(afterSequence === undefined ? {} : { afterSequence }),
          acceptBoundedSnapshot: true,
          ...(activityMode === undefined ? {} : { activityMode }),
        })
      : client.client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
          ...(afterSequence === undefined ? {} : { afterSequence }),
          requestCompletionMarker: true,
        });
  yield* stream.pipe(
    Stream.runForEach((item) => Queue.offer(queue, item)),
    Scope.provide(client.scope),
    Effect.forkIn(client.scope),
  );
  return queue;
});
const synchronized = (queue: Queue.Queue<StreamItem>) =>
  collectUntil(queue, (item) => item.kind === "synchronized").pipe(
    Effect.map((items) =>
      items.some((item) => item.kind === "snapshot") ? ("snapshot" as const) : ("replay" as const),
    ),
  );

it.live(
  "reports V2 thread HTTP and WebSocket transfer budgets",
  () =>
    Effect.gen(function* () {
      const runs: TransferBudgetRun[] = [];
      for (const provider of [
        ProviderDriverKind.make("codex"),
        ProviderDriverKind.make("claudeAgent"),
      ]) {
        const counter = makeSqlStatementCounter();
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const projection = yield* ProjectionStore.ProjectionStoreV2;
            yield* sink.write({ events: [threadCreated(provider)] });
            for (let index = 0; index < TRANSFER_HISTORY_TURN_COUNT; index++)
              yield* sink.write({ events: turnEvents(provider, index, false) });
            const context = yield* Effect.context<Layer.Success<typeof layerServices>>();
            const server = yield* Layer.build(
              HttpRouter.serve(layerRoutes, { disableListenLog: true }).pipe(
                Layer.provide(Layer.succeedContext(context)),
                Layer.provideMerge(
                  NodeHttpServer.layer(NodeHttp.createServer, {
                    port: 0,
                    host: "127.0.0.1",
                    websocket: { perMessageDeflate: true },
                  }),
                ),
              ),
            );
            const address = Context.get(server, HttpServer.HttpServer).address;
            if (!("port" in address)) return yield* Effect.die("Expected TCP server");
            const base = `http://127.0.0.1:${address.port}`;
            const threadSnapshot = yield* measureHttpGet({
              url: `${base}/api/orchestration/threads/${THREAD_ID}`,
              headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
            });
            assert.equal(
              threadSnapshot.status,
              200,
              Buffer.from(threadSnapshot.decodedBody).toString(),
            );
            assert.equal(threadSnapshot.contentEncoding, "gzip");
            const decodedThread = yield* decodeThreadSnapshot(
              Buffer.from(threadSnapshot.decodedBody).toString(),
            );
            assert.equal(decodedThread.projection.messages.length, TRANSFER_HISTORY_TURN_COUNT * 2);
            assert.equal(
              decodedThread.projection.turnItems.length,
              TRANSFER_HISTORY_TURN_COUNT * 6,
            );
            assert.notInclude(Buffer.from(threadSnapshot.decodedBody).toString(), "digest=");
            const shellSnapshot = yield* measureHttpGet({
              url: `${base}/api/orchestration/shell`,
              headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
            });
            assert.equal(shellSnapshot.status, 200);
            const decodedShell = yield* decodeShellSnapshot(
              Buffer.from(shellSnapshot.decodedBody).toString(),
            );
            assert.equal(decodedShell.threads.length, 1);
            const sequence = decodedThread.snapshotSequence;
            assert.equal(decodedShell.snapshotSequence, sequence);
            const url = `${base.replace("http:", "ws:")}/ws`;
            const thread = yield* openMeasuredWsClient({ url, cookie: "" });
            const shell = yield* openMeasuredWsClient({ url, cookie: "" });
            const second = yield* openMeasuredWsClient({ url, cookie: "" });
            assert.include(thread.recorder.negotiatedExtensions(), "permessage-deflate");
            const tq = yield* subscribe(thread, "thread", sequence);
            const sq = yield* subscribe(shell, "shell", sequence);
            const ttq = yield* subscribe(second, "thread", sequence);
            const ssq = yield* subscribe(second, "shell", sequence);
            for (const queue of [tq, sq, ttq, ssq])
              assert.equal(yield* synchronized(queue), "replay");
            const threadBefore = thread.recorder.totals();
            const shellBefore = shell.recorder.totals();
            const secondBefore = second.recorder.totals();
            const sqlBefore = counter.count();
            const events = turnEvents(provider, TRANSFER_HISTORY_TURN_COUNT, true);
            const stored = yield* sink.write({ events });
            const last = stored.at(-1)!;
            const terminal = (item: StreamItem) =>
              "sequence" in item && item.sequence >= last.sequence;
            for (const queue of [tq, sq, ttq, ssq]) yield* collectUntil(queue, terminal);
            const measuredTurnWebSocket = difference(thread.recorder.totals(), threadBefore);
            const measuredTurnShellWebSocket = difference(shell.recorder.totals(), shellBefore);
            const measuredTurnSecondClientWebSocket = difference(
              second.recorder.totals(),
              secondBefore,
            );
            const measuredTurnSqlStatements = counter.count() - sqlBefore;
            // Verify large output is retained durably even though the transport omits it.
            const durable = yield* projection.getThreadProjection(THREAD_ID);
            assert.isTrue(
              durable.turnItems.some(
                (item) =>
                  item.type === "dynamic_tool" && JSON.stringify(item.output).length > 1_000_000,
              ),
            );
            yield* second.close;
            const reconnectSqlStart = counter.count();
            const resumedThread = yield* openMeasuredWsClient({ url, cookie: "" });
            const resumedShell = yield* openMeasuredWsClient({ url, cookie: "" });
            const rq = yield* subscribe(resumedThread, "thread", sequence);
            const rsq = yield* subscribe(resumedShell, "shell", sequence);
            const threadMode = yield* synchronized(rq);
            const shellMode = yield* synchronized(rsq);
            const reconnectThread = { ...resumedThread.recorder.totals(), mode: threadMode };
            const reconnectShell = { ...resumedShell.recorder.totals(), mode: shellMode };
            assert.equal(threadMode, "snapshot"); // retained MCP payload exceeds raw replay budget
            return {
              provider,
              threadSnapshot,
              shellSnapshot,
              measuredTurnWebSocket,
              measuredTurnShellWebSocket,
              measuredTurnSecondClientWebSocket,
              measuredTurnSqlStatements,
              reconnectThread,
              reconnectShell,
              reconnectSqlStatements: counter.count() - reconnectSqlStart,
            } satisfies TransferBudgetRun;
          }).pipe(
            Effect.provide(Layer.fresh(layerServices).pipe(Layer.provideMerge(NodeServices.layer))),
            Effect.withTracer(counter.tracer),
          ),
        );
        runs.push(run);
      }
      const fs = yield* FileSystem.FileSystem;
      const report = formatTransferBudgetReport(runs);
      for (const [path, contents] of [
        [process.env.T3CODE_TRANSFER_BUDGET_REPORT_PATH, report],
        [process.env.T3CODE_TRANSFER_BUDGET_RESULT_PATH, formatTransferBudgetResult(runs)],
      ])
        if (path && contents) yield* fs.writeFileString(path, contents);
      yield* Effect.log(report);
      assert.deepEqual(transferBudgetViolations(runs), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
const LONG_TURN_TOOL_COUNT = 10_000;
const LONG_TURN_PROMPT_ID = TurnItemId.make("turn-item:semantic-sync:prompt");
const LONG_TURN_FINAL_ID = TurnItemId.make("turn-item:semantic-sync:final");
const LONG_TURN_FINAL_MESSAGE_ID = MessageId.make("message:semantic-sync:final");
const LONG_TURN_LAST_TOOL_ID = TurnItemId.make(
  `turn-item:semantic-sync:tool:${LONG_TURN_TOOL_COUNT - 1}`,
);
const LONG_TURN_PROMPT = "Review the full activity history and summarize the implementation.";
const LONG_TURN_FINAL = "The implementation is complete; all checks passed.";
const LONG_TURN_TIMESTAMP = "2026-06-01T00:01:00.000Z";
interface LongTurnItemSqlRow {
  readonly turn_item_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly provider_thread_id: null;
  readonly provider_turn_id: null;
  readonly parent_item_id: string | null;
  readonly ordinal: number;
  readonly type: string;
  readonly status: string;
  readonly updated_at: string;
  readonly payload_json: string;
}

interface LongTurnFixtureRows {
  readonly items: ReadonlyArray<LongTurnItemSqlRow>;
  readonly positions: ReadonlyArray<{
    readonly thread_id: string;
    readonly turn_item_id: string;
    readonly run_id: null;
    readonly ordinal: number;
  }>;
}

function makeLongTurnFixtureRows(): LongTurnFixtureRows {
  const items: LongTurnItemSqlRow[] = [];
  const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const baseItem = (
    id: string,
    ordinal: number,
    status = "completed",
    title: string | null = null,
  ) => ({
    id: TurnItemId.make(id),
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status,
    title,
    startedAt: LONG_TURN_TIMESTAMP,
    completedAt: LONG_TURN_TIMESTAMP,
    updatedAt: LONG_TURN_TIMESTAMP,
  });
  const addItem = <
    Item extends {
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly nodeId: string | null;
      readonly parentItemId: string | null;
      readonly ordinal: number;
      readonly type: string;
      readonly status: string;
      readonly updatedAt: string;
    },
  >(
    item: Item,
  ) => {
    items.push({
      turn_item_id: item.id,
      thread_id: item.threadId,
      run_id: item.runId,
      node_id: item.nodeId,
      provider_thread_id: null,
      provider_turn_id: null,
      parent_item_id: item.parentItemId,
      ordinal: item.ordinal,
      type: item.type,
      status: item.status,
      updated_at: item.updatedAt,
      payload_json: encodeUnknownJsonString(item),
    });
  };
  addItem({
    ...baseItem(String(LONG_TURN_PROMPT_ID), 1),
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make("message:semantic-sync:prompt"),
    inputIntent: "turn_start",
    text: LONG_TURN_PROMPT,
    attachments: [],
  });
  for (let index = 0; index < LONG_TURN_TOOL_COUNT; index += 1) {
    const isFailure = index === LONG_TURN_TOOL_COUNT - 1;
    const fileName = `src/module-${index % 20}.ts`;
    const base = baseItem(
      `turn-item:semantic-sync:tool:${index}`,
      index + 2,
      isFailure ? "failed" : "completed",
      `Inspect ${fileName}`,
    );
    const output =
      `step=${index} file=${fileName} lines=${index + 1}-${index + 12} ` +
      Array.from({ length: 24 }, (_, part) => ((index * 37 + part * 13) % 997).toString(16)).join(
        ",",
      );
    if (index < 40) {
      addItem({
        ...base,
        type: "file_change",
        fileName,
        additions: (index % 7) + 1,
        deletions: index % 3,
        diffStr: `@@ -${index},1 +${index},2 @@\n+ updated ${fileName}`,
        intent: `Update ${fileName} after inspection`,
      });
    } else if (isFailure || index % 3 === 0) {
      addItem({
        ...base,
        type: "command_execution",
        input: `node scripts/check-file.ts --file ${fileName} --step ${index}`,
        output,
        exitCode: isFailure ? 1 : 0,
        ...(isFailure ? { outputIndicatesFailure: true } : {}),
        intent: `Verify ${fileName}`,
      });
    } else if (index % 3 === 1) {
      addItem({
        ...base,
        type: "dynamic_tool",
        toolName: "mcp__test__search",
        input: { query: `symbol-${index}`, path: fileName },
        output: { text: output },
      });
    } else {
      addItem({
        ...base,
        type: "file_search",
        pattern: `symbol-${index}`,
        results: [{ fileName, line: (index % 300) + 1, preview: output }],
      });
    }
  }
  addItem({
    ...baseItem(String(LONG_TURN_FINAL_ID), LONG_TURN_TOOL_COUNT + 2),
    type: "assistant_message",
    messageId: LONG_TURN_FINAL_MESSAGE_ID,
    text: LONG_TURN_FINAL,
    attachments: [],
    streaming: false,
  });
  return {
    items,
    positions: items.map((item) => ({
      thread_id: item.thread_id,
      turn_item_id: item.turn_item_id,
      run_id: null,
      ordinal: item.ordinal,
    })),
  };
}

const seedLongTurnFixture = Effect.fn("transfer.seedLongTurnFixture")(function* (
  provider: ProviderDriverKind,
  rows: LongTurnFixtureRows,
) {
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const fixtureEvents = turnEvents(provider, 0, false);
  yield* sink.write({
    events: [
      threadCreated(provider),
      fixtureEvents[0]!,
      fixtureEvents[1]!,
      fixtureEvents[2]!,
      fixtureEvents.at(-1)!,
    ],
  });
  for (let offset = 0; offset < rows.items.length; offset += 250) {
    yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows.items.slice(offset, offset + 250).map((row) => ({ ...row })))}
      `;
  }
  // Native/imported rows use the indexed per-thread order without a canonical run.
  for (let offset = 0; offset < rows.positions.length; offset += 250) {
    yield* sql`
        INSERT INTO orchestration_v2_turn_item_positions ${sql.insert(rows.positions.slice(offset, offset + 250))}
      `;
  }
});

const startLongTurnHttpServer = Effect.fn("transfer.startLongTurnHttpServer")(function* () {
  const context = yield* Effect.context<Layer.Success<typeof layerServices>>();
  const server = yield* Layer.build(
    HttpRouter.serve(layerRoutes, { disableListenLog: true }).pipe(
      Layer.provide(Layer.succeedContext(context)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          port: 0,
          host: "127.0.0.1",
          websocket: { perMessageDeflate: true },
        }),
      ),
    ),
  );
  const address = Context.get(server, HttpServer.HttpServer).address;
  if (!("port" in address)) return yield* Effect.die("Expected TCP server");
  return `http://127.0.0.1:${address.port}`;
});

it.live(
  "profiles legacy and semantic bounded reads and indexed hydration for a 10,000-tool turn",
  () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("codex");
      const counter = makeSqlStatementCounter();
      const report = yield* Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* ProjectionStore.ProjectionStoreV2;
          yield* seedLongTurnFixture(provider, makeLongTurnFixtureRows());
          const base = yield* startLongTurnHttpServer();
          const boundedUrl = `${base}/api/orchestration/threads/${THREAD_ID}/bounded`;
          const activityBase = `${base}/api/orchestration/threads/${THREAD_ID}/activity`;
          const historyBase = `${base}/api/orchestration/threads/${THREAD_ID}/history`;

          const legacyCounter = makeSqlStatementCounter();
          const legacy = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* seedLongTurnFixture(provider, makeLongTurnFixtureRows());
              const legacyBase = yield* startLongTurnHttpServer();
              const legacySqlStart = legacyCounter.count();
              const measurement = yield* measureBoundedSnapshotOpens(
                `${legacyBase}/api/orchestration/threads/${THREAD_ID}/bounded`,
              );
              return {
                ...measurement,
                sqlStatements: legacyCounter.count() - legacySqlStart,
              };
            }).pipe(
              Effect.provide(
                Layer.fresh(layerServices).pipe(Layer.provideMerge(NodeServices.layer)),
              ),
              Effect.withTracer(legacyCounter.tracer),
            ),
          );
          assert.isUndefined(legacy.firstSnapshot.activityMode);
          assert.isUndefined(legacy.firstSnapshot.activitySummaries);
          assert.equal(legacy.firstSnapshot.projection.turnItems.length, LONG_TURN_TOOL_COUNT + 2);
          assert.isAbove(legacy.firstResponse.decodedBodyBytes, 1_048_576);
          const compactSqlStart = counter.count();
          const compact = yield* measureBoundedSnapshotOpens(
            `${boundedUrl}?activityMode=summary-v1`,
          );
          const compactSqlStatements = counter.count() - compactSqlStart;
          const compactSnapshot = compact.firstSnapshot;
          assert.equal(compactSnapshot.activityMode, "summary-v1");
          assert.isNotEmpty(compactSnapshot.activitySummaries);
          assert.isAtMost(compact.firstResponse.encodedBodyBytes, 1_048_576);
          assert.isAtMost(compact.firstResponse.decodedBodyBytes, 1_048_576);
          assert.isAtMost(compact.schemaDecodedSnapshotBytes, 1_048_576);
          const summaryWsClient = yield* openMeasuredWsClient({
            url: `${base.replace("http:", "ws:")}/ws`,
            cookie: "",
          });
          const summaryWsQueue = yield* subscribe(
            summaryWsClient,
            "thread",
            undefined,
            "summary-v1",
          );
          const summaryWsItem = yield* Queue.take(summaryWsQueue);
          if (summaryWsItem.kind !== "snapshot" || !("projection" in summaryWsItem)) {
            return yield* Effect.die("Summary-mode WebSocket fallback did not open a snapshot");
          }
          assert.equal(summaryWsItem.activityMode, "summary-v1");
          assert.isNotEmpty(summaryWsItem.activitySummaries);
          // Bounded like any snapshot: the row limit plus the prompt and final anchors.
          assert.isAtMost(
            summaryWsItem.projection.turnItems.length,
            THREAD_HISTORY_SNAPSHOT_ROW_LIMIT + 2,
          );
          yield* summaryWsClient.close;

          const prompt = compactSnapshot.projection.visibleTurnItems.find(
            (row) => row.sourceItemId === LONG_TURN_PROMPT_ID,
          )?.item;
          const final = compactSnapshot.projection.visibleTurnItems.find(
            (row) => row.sourceItemId === LONG_TURN_FINAL_ID,
          )?.item;
          if (prompt?.type !== "user_message" || final?.type !== "assistant_message") {
            return yield* Effect.die("Compact snapshot omitted the user prompt or final response");
          }
          assert.equal(prompt.text, LONG_TURN_PROMPT);
          assert.equal(final.text, LONG_TURN_FINAL);

          const summaries = compactSnapshot.activitySummaries;
          assert.isDefined(summaries);
          const summary = summaries.find(
            (candidate) =>
              candidate.sourceThreadId === THREAD_ID &&
              candidate.groupStartItemId === LONG_TURN_PROMPT_ID,
          );
          if (summary === undefined) {
            return yield* Effect.die("Compact snapshot omitted the null-run user-turn group");
          }
          assert.equal(summary.runId, null);
          assert.equal(summary.turnStartItemId, LONG_TURN_PROMPT_ID);
          assert.equal(summary.activityCount, LONG_TURN_TOOL_COUNT);
          assert.equal(summary.firstItemId, TurnItemId.make("turn-item:semantic-sync:tool:0"));
          assert.equal(summary.firstOrdinal, 2);
          assert.equal(summary.lastItemId, LONG_TURN_LAST_TOOL_ID);
          assert.equal(summary.lastOrdinal, LONG_TURN_TOOL_COUNT + 1);
          assert.equal(summary.stepCount, LONG_TURN_TOOL_COUNT);
          assert.equal(summary.filesEditedCount, 20);
          assert.equal(summary.diffStats.added, 155);
          assert.equal(summary.diffStats.removed, 39);
          assert.isTrue(summary.hasFailure);
          assert.isNull(summary.runStatus);
          assert.equal(summary.labelPreview, "Inspect src/module-0.ts");
          assert.equal(summary.intentPreview, "Update src/module-0.ts after inspection");
          if (summary.startedAt === null || summary.endedAt === null) {
            return yield* Effect.die("Null-run activity summary omitted its time bounds");
          }
          assert.equal(DateTime.formatIso(summary.startedAt), LONG_TURN_TIMESTAMP);
          assert.equal(DateTime.formatIso(summary.endedAt), LONG_TURN_TIMESTAMP);
          assert.deepEqual(
            summary.countsByType.toSorted((left, right) => left.type.localeCompare(right.type)),
            [
              { type: "command_execution", count: 3_320 },
              { type: "dynamic_tool", count: 3_320 },
              { type: "file_change", count: 40 },
              { type: "file_search", count: 3_320 },
            ],
          );
          assert.deepEqual(
            summary.statusCounts.toSorted((left, right) => left.status.localeCompare(right.status)),
            [
              { status: "completed", count: 9_999 },
              { status: "failed", count: 1 },
            ],
          );

          const summaryOnlyUrl = new URL(activityBase);
          summaryOnlyUrl.searchParams.set("sourceThreadId", String(THREAD_ID));
          summaryOnlyUrl.searchParams.set("groupStartItemId", String(LONG_TURN_PROMPT_ID));
          summaryOnlyUrl.searchParams.set("summaryOnly", "true");
          const summaryOnlyResponse = yield* measureHttpGet({
            url: summaryOnlyUrl.toString(),
            headers: {
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          });
          assert.equal(summaryOnlyResponse.status, 200);
          const refreshed = yield* decodeActivityPage(
            Buffer.from(summaryOnlyResponse.decodedBody).toString(),
          );
          assert.lengthOf(refreshed.items, 0);
          assert.equal(refreshed.summary.activityCount, LONG_TURN_TOOL_COUNT);
          assert.equal(refreshed.snapshotSequence, compactSnapshot.snapshotSequence);

          const firstActivityUrl = new URL(activityBase);
          firstActivityUrl.searchParams.set("sourceThreadId", String(THREAD_ID));
          firstActivityUrl.searchParams.set("groupStartItemId", String(LONG_TURN_PROMPT_ID));
          firstActivityUrl.searchParams.set("limit", "75");
          const activitySqlStart = counter.count();
          const firstPageStartedAt = performance.now();
          const firstActivityResponse = yield* measureHttpGet({
            url: firstActivityUrl.toString(),
            headers: {
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          });
          assert.equal(firstActivityResponse.status, 200);
          const firstPage = yield* decodeActivityPage(
            Buffer.from(firstActivityResponse.decodedBody).toString(),
          );
          const firstPageLatencyMs = performance.now() - firstPageStartedAt;
          const firstPageSqlStatements = counter.count() - activitySqlStart;
          assert.lengthOf(firstPage.items, 75);
          assert.equal(firstPage.summary.groupStartItemId, LONG_TURN_PROMPT_ID);
          assert.equal(
            firstPage.items[0]?.sourceItemId,
            TurnItemId.make("turn-item:semantic-sync:tool:0"),
          );
          assert.equal(firstPage.items[0]?.orderKey.ordinal, 2);
          const invalidCursorUrl = new URL(activityBase);
          invalidCursorUrl.searchParams.set("cursor", "not-a-valid-activity-cursor");
          const invalidCursorResponse = yield* measureHttpGet({
            url: invalidCursorUrl.toString(),
            headers: {
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          });
          assert.equal(invalidCursorResponse.status, 400);
          assert.include(
            Buffer.from(invalidCursorResponse.decodedBody).toString(),
            "invalid_thread_activity_cursor",
          );

          if (firstPage.nextCursor === null) {
            return yield* Effect.die("A 10,000-row activity group returned no continuation cursor");
          }
          const conflictingActivityUrl = new URL(activityBase);
          conflictingActivityUrl.searchParams.set("sourceThreadId", String(THREAD_ID));
          conflictingActivityUrl.searchParams.set("groupStartItemId", String(LONG_TURN_PROMPT_ID));
          conflictingActivityUrl.searchParams.set("cursor", firstPage.nextCursor);
          conflictingActivityUrl.searchParams.set("anchorItemId", String(LONG_TURN_LAST_TOOL_ID));
          const conflictingActivityResponse = yield* measureHttpGet({
            url: conflictingActivityUrl.toString(),
            headers: {
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          });
          assert.equal(conflictingActivityResponse.status, 400);
          assert.include(
            Buffer.from(conflictingActivityResponse.decodedBody).toString(),
            "invalid_thread_activity_request",
          );

          const maxSqlStatementsPerPage = { value: firstPageSqlStatements };
          assert.isAtMost(firstPageSqlStatements, 20);
          const hydratedIds = new Set<string>();
          const observedItems = new Map<string, (typeof firstPage.items)[number]["item"]>();
          let page = firstPage;
          let pageCount = 0;
          let hydratedSqlStatements = 0;
          while (true) {
            for (const row of page.items) {
              const id = String(row.sourceItemId);
              const prefix = "turn-item:semantic-sync:tool:";
              const index = Number(id.slice(prefix.length));
              assert.equal(id, `${prefix}${index}`);
              assert.isTrue(Number.isInteger(index));
              assert.isAtLeast(index, 0);
              assert.isBelow(index, LONG_TURN_TOOL_COUNT);
              assert.isFalse(hydratedIds.has(id), `duplicate hydrated activity item ${id}`);
              hydratedIds.add(id);
              assert.equal(row.sourceThreadId, THREAD_ID);
              assert.equal(row.visibility, "local");
              assert.equal(row.ordinal, index + 2);
              assert.equal(row.item.ordinal, index + 2);
              assert.equal(row.item.runId, null);
              assert.equal(row.orderKey.sourceThreadId, THREAD_ID);
              assert.equal(row.orderKey.ordinal, index + 2);
              assert.equal(row.orderKey.itemId, row.sourceItemId);
              const fileName = `src/module-${index % 20}.ts`;
              const output =
                `step=${index} file=${fileName} lines=${index + 1}-${index + 12} ` +
                Array.from({ length: 24 }, (_, part) =>
                  ((index * 37 + part * 13) % 997).toString(16),
                ).join(",");
              if (index < 40) {
                if (row.item.type !== "file_change") {
                  return yield* Effect.die(`Activity ${index} is not its expected file change`);
                }
                assert.equal(row.item.status, "completed");
                assert.equal(row.item.title, `Inspect ${fileName}`);
                assert.equal(row.item.fileName, fileName);
                assert.equal(row.item.additions, (index % 7) + 1);
                assert.equal(row.item.deletions, index % 3);
                assert.equal(
                  row.item.diffStr,
                  `@@ -${index},1 +${index},2 @@\n+ updated ${fileName}`,
                );
                assert.equal(row.item.intent, `Update ${fileName} after inspection`);
              } else if (index % 3 === 0) {
                if (row.item.type !== "command_execution") {
                  return yield* Effect.die(`Activity ${index} is not its expected command`);
                }
                const failed = index === LONG_TURN_TOOL_COUNT - 1;
                assert.equal(row.item.status, failed ? "failed" : "completed");
                assert.equal(row.item.title, `Inspect ${fileName}`);
                assert.equal(
                  row.item.input,
                  `node scripts/check-file.ts --file ${fileName} --step ${index}`,
                );
                assert.equal(row.item.output, output);
                assert.equal(row.item.exitCode, failed ? 1 : 0);
                assert.equal(row.item.outputIndicatesFailure ?? false, failed);
                assert.equal(row.item.intent, `Verify ${fileName}`);
              } else if (index % 3 === 1) {
                if (row.item.type !== "dynamic_tool") {
                  return yield* Effect.die(`Activity ${index} is not its expected dynamic tool`);
                }
                assert.equal(row.item.status, "completed");
                assert.equal(row.item.title, `Inspect ${fileName}`);
                assert.equal(row.item.toolName, "mcp__test__search");
                assert.deepEqual(row.item.input, {
                  query: `symbol-${index}`,
                  path: fileName,
                });
                assert.deepEqual(row.item.output, { text: output });
              } else {
                if (row.item.type !== "file_search") {
                  return yield* Effect.die(`Activity ${index} is not its expected file search`);
                }
                assert.equal(row.item.status, "completed");
                assert.equal(row.item.title, `Inspect ${fileName}`);
                assert.equal(row.item.pattern, `symbol-${index}`);
                assert.deepEqual(row.item.results, [
                  { fileName, line: (index % 300) + 1, preview: output },
                ]);
              }
              observedItems.set(id, row.item);
            }
            pageCount += 1;
            if (page.nextCursor === null) break;
            const nextUrl = new URL(activityBase);
            nextUrl.searchParams.set("cursor", page.nextCursor);
            nextUrl.searchParams.set("limit", "75");
            const pageSqlStart = counter.count();
            const response = yield* measureHttpGet({
              url: nextUrl.toString(),
              headers: {
                [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
              },
            });
            assert.equal(response.status, 200);
            page = yield* decodeActivityPage(Buffer.from(response.decodedBody).toString());
            const pageStatements = counter.count() - pageSqlStart;
            hydratedSqlStatements += pageStatements;
            maxSqlStatementsPerPage.value = Math.max(maxSqlStatementsPerPage.value, pageStatements);
            assert.isAtMost(pageStatements, 20);
          }
          assert.equal(pageCount, Math.ceil(LONG_TURN_TOOL_COUNT / 75));
          assert.equal(hydratedIds.size, LONG_TURN_TOOL_COUNT);
          assert.equal(
            observedItems.get(String(LONG_TURN_LAST_TOOL_ID))?.type,
            "command_execution",
          );
          const lastTool = observedItems.get(String(LONG_TURN_LAST_TOOL_ID));
          if (lastTool?.type !== "command_execution") {
            return yield* Effect.die("Hydrated final activity row has the wrong item type");
          }
          assert.equal(lastTool.exitCode, 1);
          assert.isTrue(lastTool.outputIndicatesFailure);
          assert.include(lastTool.output, "step=9999");
          const firstFileChange = observedItems.get("turn-item:semantic-sync:tool:0");
          if (firstFileChange?.type !== "file_change") {
            return yield* Effect.die("Hydrated file change has the wrong item type");
          }
          assert.equal(firstFileChange.diffStr, "@@ -0,1 +0,2 @@\n+ updated src/module-0.ts");

          const deepAnchorUrl = new URL(activityBase);
          deepAnchorUrl.searchParams.set("sourceThreadId", String(THREAD_ID));
          deepAnchorUrl.searchParams.set("groupStartItemId", String(LONG_TURN_PROMPT_ID));
          deepAnchorUrl.searchParams.set("anchorItemId", String(LONG_TURN_LAST_TOOL_ID));
          deepAnchorUrl.searchParams.set("limit", "75");
          const deepAnchorSqlStart = counter.count();
          const deepJumpStartedAt = performance.now();
          const deepJumpResponse = yield* measureHttpGet({
            url: deepAnchorUrl.toString(),
            headers: {
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          });
          assert.equal(deepJumpResponse.status, 200);
          const deepJump = yield* decodeActivityPage(
            Buffer.from(deepJumpResponse.decodedBody).toString(),
          );
          const deepJumpLatencyMs = performance.now() - deepJumpStartedAt;
          assert.isTrue(deepJump.items.some((row) => row.sourceItemId === LONG_TURN_LAST_TOOL_ID));
          const deepAnchorSqlStatements = counter.count() - deepAnchorSqlStart;

          const historyUrl = new URL(historyBase);
          historyUrl.searchParams.set("throughEntryId", String(LONG_TURN_FINAL_MESSAGE_ID));
          const historyStart = performance.now();
          const historyResponse = yield* measureHttpGet({
            url: historyUrl.toString(),
            headers: {
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          });
          assert.equal(historyResponse.status, 200);
          const historyJump = yield* decodeHistoryPage(
            Buffer.from(historyResponse.decodedBody).toString(),
          );
          const historyJumpLatencyMs = performance.now() - historyStart;
          assert.isAtMost(historyJump.items.length, 77);
          assert.isTrue(
            historyJump.items.some(
              (row) =>
                (row.item.type === "user_message" || row.item.type === "assistant_message") &&
                row.item.messageId === LONG_TURN_FINAL_MESSAGE_ID,
            ),
          );
          assert.isTrue(historyJump.items.some((row) => row.sourceItemId === LONG_TURN_PROMPT_ID));
          const finalHistoryRow = historyJump.items.find(
            (row) =>
              (row.item.type === "user_message" || row.item.type === "assistant_message") &&
              row.item.messageId === LONG_TURN_FINAL_MESSAGE_ID,
          );
          assert.deepEqual(finalHistoryRow?.orderKey, {
            sourceThreadId: THREAD_ID,
            ordinal: LONG_TURN_TOOL_COUNT + 2,
            itemId: LONG_TURN_FINAL_ID,
          });

          const oldLegacySqlStart = counter.count();
          const oldJumpStartedAt = performance.now();
          const oldJump = yield* projection.getTurnItem({
            threadId: THREAD_ID,
            itemId: LONG_TURN_LAST_TOOL_ID,
          });
          const oldJumpLatencyMs = performance.now() - oldJumpStartedAt;
          const oldJumpSqlStatements = counter.count() - oldLegacySqlStart;
          if (oldJump?.type !== "command_execution") {
            return yield* Effect.die("Legacy direct turn-item jump lost the last tool");
          }
          assert.equal(oldJump.exitCode, 1);
          assert.isTrue(oldJump.outputIndicatesFailure);
          assert.include(oldJump.output, "step=9999");

          const fileAdditions = Array.from({ length: 40 }, (_, index) => (index % 7) + 1);
          const fileDeletions = Array.from({ length: 40 }, (_, index) => index % 3);
          return {
            scenario:
              "native/imported one user turn with NULL run_id, 10,000 tool rows, prompt, and final",
            seedTimeMeasured: false,
            legacyUnopted: {
              coldMs: legacy.endToEndSamples[0],
              warmSamplesMs: legacy.endToEndSamples.slice(1),
              warmMedianMs: legacy.warmMedianMs,
              encodedBytes: legacy.firstResponse.encodedBodyBytes,
              decodedBytes: legacy.firstResponse.decodedBodyBytes,
              rawTurnItemRows: legacy.firstSnapshot.projection.turnItems.length,
              sqlStatements: legacy.sqlStatements,
            },
            compact: {
              coldMs: compact.endToEndSamples[0],
              coldTargetMs: 200,
              coldTargetMet: (compact.endToEndSamples[0] ?? Infinity) <= 200,
              warmSamplesMs: compact.endToEndSamples.slice(1),
              warmMedianMs: compact.warmMedianMs,
              warmSpreadMs: compact.warmSpreadMs,
              httpAndGunzipColdMs: compact.httpAndGunzipSamples[0],
              schemaDecodeColdMs: compact.schemaDecodeSamples[0],
              encodedBytes: compact.firstResponse.encodedBodyBytes,
              decodedBytes: compact.firstResponse.decodedBodyBytes,
              schemaDecodedSnapshotBytes: compact.schemaDecodedSnapshotBytes,
              rawTurnItemRows: compactSnapshot.projection.turnItems.length,
              visibleRows: compactSnapshot.projection.visibleTurnItems.length,
              activitySummaries: summaries.length,
              sqlStatements: compactSqlStatements,
            },
            activityPage: {
              coldFirstPageMs: firstPageLatencyMs,
              requestedRows: 75,
              returnedRows: firstPage.items.length,
              pageCount,
              hydratedRows: hydratedIds.size,
              firstPageSqlStatements,
              remainingPagesSqlStatements: hydratedSqlStatements,
              allIdsUnique: hydratedIds.size === LONG_TURN_TOOL_COUNT,
              summaryOnlyReturnedRows: refreshed.items.length,
            },
            directJumps: {
              indexedDeepAnchorMs: deepJumpLatencyMs,
              indexedAnchorContainsLastTool: deepJump.items.some(
                (row) => row.sourceItemId === LONG_TURN_LAST_TOOL_ID,
              ),
              indexedAnchorSqlStatements: deepAnchorSqlStatements,
              historyTargetMs: historyJumpLatencyMs,
              historyTargetContainsFinal: historyJump.items.some(
                (row) =>
                  (row.item.type === "user_message" || row.item.type === "assistant_message") &&
                  row.item.messageId === LONG_TURN_FINAL_MESSAGE_ID,
              ),
              oldLegacyItemLookupMs: oldJumpLatencyMs,
              oldLegacyItemLookupSqlStatements: oldJumpSqlStatements,
            },
            oracle: {
              prompt,
              final,
              activityCount: summary.activityCount,
              runId: summary.runId,
              hasFailure: summary.hasFailure,
              expectedFilesEditedCount: 20,
              expectedDiffStats: {
                added: fileAdditions.reduce((sum, value) => sum + value, 0),
                removed: fileDeletions.reduce((sum, value) => sum + value, 0),
              },
            },
          };
        }).pipe(
          Effect.provide(Layer.fresh(layerServices).pipe(Layer.provideMerge(NodeServices.layer))),
          Effect.withTracer(counter.tracer),
        ),
      );
      yield* Effect.log(JSON.stringify(report));
    }).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);
/** Pairs each fixture conversation message with the transcript row a live turn records. */
function withMessageTurnItems(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  return events.flatMap((event): ReadonlyArray<OrchestrationV2DomainEvent> => {
    if (event.type !== "message.updated") return [event];
    const message = event.payload;
    const base = {
      id: TurnItemId.make(`message-item:${message.id}`),
      threadId: message.threadId,
      runId: message.runId ?? null,
      nodeId: event.nodeId ?? null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "completed" as const,
      title: null,
      startedAt: message.createdAt,
      completedAt: message.createdAt,
      updatedAt: message.updatedAt,
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
    };
    return [
      event,
      {
        ...event,
        id: EventId.make(`${event.id}:turn-item`),
        type: "turn-item.updated",
        payload:
          message.role === "user"
            ? {
                ...base,
                ordinal: 0,
                type: "user_message",
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                inputIntent: "turn_start",
              }
            : { ...base, ordinal: 1_000_000, type: "assistant_message", streaming: false },
      },
    ];
  });
}
it.live(
  "serves fork-ancestor history anchors and rejects out-of-scope activity groups",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = ProviderDriverKind.make("codex");
        const sink = yield* EventSink.EventSinkV2;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const forkThreadId = ThreadId.make("semantic-sync-fork-target");
        const sourceCreated = threadCreated(provider);
        if (sourceCreated.type !== "thread.created") {
          return yield* Effect.die("The transfer fixture did not create a source thread");
        }
        yield* sink.write({ events: [sourceCreated] });
        yield* sink.write({ events: withMessageTurnItems(turnEvents(provider, 0, false)) });
        const forkCreated = {
          ...sourceCreated,
          id: EventId.make("semantic-sync-fork-created"),
          threadId: forkThreadId,
          payload: {
            ...sourceCreated.payload,
            id: forkThreadId,
            title: "Semantic sync fork target",
            lineage: {
              parentThreadId: THREAD_ID,
              relationshipToParent: "fork" as const,
              rootThreadId: THREAD_ID,
            },
            forkedFrom: {
              type: "run" as const,
              threadId: THREAD_ID,
              runId: RunId.make("run-0"),
            },
          },
        } satisfies OrchestrationV2DomainEvent;
        yield* sink.write({ events: [forkCreated] });
        yield* sink.write({ events: withMessageTurnItems(turnEvents(provider, 1, false)) });

        const sourceProjection = yield* projection.getThreadProjection(THREAD_ID);
        const ancestorPrompt = sourceProjection.visibleTurnItems.find(
          (row) => row.item.type === "user_message" && row.item.text === "Inspect transfer 0",
        );
        const afterForkPrompt = sourceProjection.visibleTurnItems.find(
          (row) => row.item.type === "user_message" && row.item.text === "Inspect transfer 1",
        );
        if (ancestorPrompt === undefined || afterForkPrompt === undefined) {
          return yield* Effect.die("The fork fixture omitted a source user turn");
        }

        const base = yield* startLongTurnHttpServer();
        const headers = {
          [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
        };
        const activityBase = `${base}/api/orchestration/threads/${forkThreadId}/activity`;
        const ancestorActivityUrl = new URL(activityBase);
        ancestorActivityUrl.searchParams.set("sourceThreadId", String(THREAD_ID));
        ancestorActivityUrl.searchParams.set(
          "groupStartItemId",
          String(ancestorPrompt.sourceItemId),
        );
        const ancestorActivityResponse = yield* measureHttpGet({
          url: ancestorActivityUrl.toString(),
          headers,
        });
        assert.equal(
          ancestorActivityResponse.status,
          200,
          Buffer.from(ancestorActivityResponse.decodedBody).toString(),
        );
        const ancestorActivity = yield* decodeActivityPage(
          Buffer.from(ancestorActivityResponse.decodedBody).toString(),
        );
        assert.isNotEmpty(ancestorActivity.items);
        assert.isTrue(ancestorActivity.items.every((row) => row.sourceThreadId === THREAD_ID));

        const outOfScopeActivityUrl = new URL(activityBase);
        outOfScopeActivityUrl.searchParams.set("sourceThreadId", String(THREAD_ID));
        outOfScopeActivityUrl.searchParams.set(
          "groupStartItemId",
          String(afterForkPrompt.sourceItemId),
        );
        const outOfScopeActivityResponse = yield* measureHttpGet({
          url: outOfScopeActivityUrl.toString(),
          headers,
        });
        assert.equal(outOfScopeActivityResponse.status, 404);
        assert.include(
          Buffer.from(outOfScopeActivityResponse.decodedBody).toString(),
          "thread_not_found",
        );

        const historyUrl = new URL(`${base}/api/orchestration/threads/${forkThreadId}/history`);
        historyUrl.searchParams.set("view", "activity");
        historyUrl.searchParams.set("throughEntryId", String(MessageId.make("assistant-0")));
        const historyResponse = yield* measureHttpGet({
          url: historyUrl.toString(),
          headers,
        });
        assert.equal(
          historyResponse.status,
          200,
          Buffer.from(historyResponse.decodedBody).toString(),
        );
        const history = yield* decodeHistoryPage(
          Buffer.from(historyResponse.decodedBody).toString(),
        );
        assert.isAtMost(history.items.length, 77);
        const ancestorMessageId = MessageId.make("assistant-0");
        const ancestorHistoryRow = history.items.find(
          (row) =>
            (row.item.type === "user_message" || row.item.type === "assistant_message") &&
            row.item.messageId === ancestorMessageId,
        );
        if (ancestorHistoryRow === undefined) {
          return yield* Effect.die("The direct fork history anchor omitted its ancestor message");
        }
        assert.equal(ancestorHistoryRow.sourceThreadId, THREAD_ID);
        assert.deepEqual(ancestorHistoryRow.orderKey, {
          sourceThreadId: THREAD_ID,
          ordinal: ancestorHistoryRow.item.ordinal,
          itemId: ancestorHistoryRow.sourceItemId,
        });
      }).pipe(
        Effect.provide(Layer.fresh(layerServices).pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
