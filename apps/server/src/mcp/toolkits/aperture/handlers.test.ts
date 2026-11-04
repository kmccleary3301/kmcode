import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import type { ApertureEmbedTokenIssueInput } from "@t3tools/shared/apertureEmbed";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ApertureConnection from "../../../aperture/ApertureConnection.ts";
import * as ApertureEmbedToken from "../../../aperture/ApertureEmbedToken.ts";
import * as AperturePreview from "../../../aperture/AperturePreview.ts";
import * as ApertureRuntime from "../../../aperture/ApertureRuntime.ts";
import * as ApertureWidgetStore from "../../../aperture/ApertureWidgetStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ApertureHandlers from "./handlers.ts";
import { ApertureFigureRenderTool, ApertureQueryTool, ApertureToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:aperture");
const runtimeVersion = "a".repeat(64);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeQueryBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ kind: Schema.String, as_of: Schema.optional(Schema.Number) }),
  ),
);

const apertureSettings = (enabled: boolean) => ({
  aperture: {
    enabled,
    webUrl: "http://aperture.test",
    defaultEntity: "admin",
    defaultProject: "demo",
  },
});

const historyResponse = {
  kind: "history",
  series: [
    {
      run: "run-1",
      key: "train/loss",
      step: [0, 10, 20],
      y: [3.1, 2.2, 1.9],
      y_min: [2.9, 2.0, 1.4],
      y_max: [4.2, 2.4, 2.0],
      x_last: [9, 19, 29],
      y_last: [2.8, 2.1, 1.7],
      count: [10, 10, 10],
    },
  ],
};

const makeHarness = (fixture: {
  readonly enabled?: boolean;
  readonly embedErrors?: AperturePreview.AperturePreviewResult["embedErrors"];
}) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<ApertureConnection.ApertureRequestInput>>([]);
    const issued = yield* Ref.make<ReadonlyArray<ApertureEmbedTokenIssueInput>>([]);
    const dependencies = Layer.mergeAll(
      liveThreadsLayer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:aperture"),
        requestNamespace: "provider:aperture",
        thread: {
          threadId,
          providerSessionId: "provider:aperture",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      ServerSettings.layerTest(apertureSettings(fixture.enabled ?? true)),
      Layer.mock(ApertureConnection.ApertureConnection)({
        request: (input) =>
          Ref.update(requests, (all) => [...all, input]).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                HttpClientRequest.post(input.path),
                new Response(encodeJson(historyResponse), { status: 200 }),
              ),
            ),
          ),
      }),
      Layer.mock(ApertureRuntime.ApertureRuntime)({
        getLatest: Effect.succeed({ version: runtimeVersion, bytes: new Uint8Array() }),
      }),
      Layer.mock(AperturePreview.AperturePreview)({
        preview: (input) =>
          Effect.succeed({
            png: new Uint8Array([137, 80, 78, 71]),
            width: input.width,
            contentHeight: 312.4,
            capturedHeight: 313,
            consoleMessages: [],
            embedErrors: fixture.embedErrors ?? [],
            failedRequests: [],
            runtimeVersion,
          }),
      }),
      Layer.mock(ApertureEmbedToken.ApertureEmbedToken)({
        issue: (input) =>
          Ref.update(issued, (all) => [...all, input]).pipe(Effect.as("signed-embed-token")),
      }),
      Layer.mock(ApertureWidgetStore.ApertureWidgetStore)({
        module: () => Effect.succeed("export default function Widget() {}"),
      }),
      NodeServices.layer,
    );
    const layer = Layer.mergeAll(
      McpToolAccess.HandlersLayer.layer(ApertureHandlers.layerStandard),
      McpToolAccess.HandlersLayer.layer(ApertureHandlers.layerFigurePreview),
      McpToolAccess.HandlersLayer.layer(ApertureHandlers.layerWidgetPreview),
    ).pipe(Layer.provideMerge(dependencies));
    return { layer, requests, issued };
  });

describe("Aperture MCP tools", () => {
  it("pins history to the asOf it reports, and renders with that same asOf", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          const toolkit = yield* ApertureToolkit;
          const queried = yield* toolkit
            .handle("aperture_query", {
              operation: "history",
              runIds: ["run-1"],
              keys: ["train/loss"],
            })
            .pipe(Stream.unwrap, Stream.runCollect);
          if (queried.at(-1)?.isFailure !== false) throw new Error("aperture_query failed");
          const query = yield* Schema.decodeUnknownEffect(ApertureQueryTool.successSchema)(
            queried.at(-1)?.result,
          );
          const { asOf } = query;
          expect(query.history).toEqual([
            {
              runId: "run-1",
              key: "train/loss",
              min: 1.4,
              max: 4.2,
              last: 1.7,
              count: 30,
              lastStep: 29,
            },
          ]);
          const [request] = yield* Ref.get(harness.requests);
          expect(decodeQueryBody(request?.body)).toMatchObject({
            kind: "history",
            // Aperture's cutoff is inclusive f64 seconds, so the pin keeps the millisecond.
            as_of: Date.parse(asOf) / 1000,
          });

          const rendered = yield* toolkit
            .handle("aperture_figure_render", {
              spec: { kind: "line", runs: ["run-1"], key: "train/loss" },
              title: "Loss",
              height: 300,
              asOf,
            })
            .pipe(Stream.unwrap, Stream.runCollect);
          if (rendered.at(-1)?.isFailure !== false)
            throw new Error("aperture_figure_render failed");
          const render = yield* Schema.decodeUnknownEffect(ApertureFigureRenderTool.successSchema)(
            rendered.at(-1)?.result,
          );
          expect(render.apertureEmbed).toMatchObject({
            kind: "figure",
            entity: "admin",
            project: "demo",
            mode: "pinned",
            asOf,
            height: 313,
            runtime: { version: runtimeVersion },
            embedToken: "signed-embed-token",
          });
          expect(yield* Ref.get(harness.issued)).toMatchObject([
            { threadId, entity: "admin", project: "demo", asOf },
          ]);
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  });

  it("refuses to render a figure the runtime rejects, and issues no embed token", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          embedErrors: [{ code: "spec_invalid", message: "Unknown figure kind." }],
        });
        yield* Effect.gen(function* () {
          const toolkit = yield* ApertureToolkit;
          const rendered = yield* toolkit
            .handle("aperture_figure_render", { spec: { kind: "pie" }, title: "Pie", height: 300 })
            .pipe(Stream.unwrap, Stream.runCollect);
          expect(rendered.at(-1)).toMatchObject({
            isFailure: true,
            result: { code: "invalid_request", message: expect.stringContaining("spec_invalid") },
          });
          expect(yield* Ref.get(harness.issued)).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  });

  it("refuses an asOf later than the server clock", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          const toolkit = yield* ApertureToolkit;
          const rendered = yield* toolkit
            .handle("aperture_figure_render", {
              spec: { kind: "line" },
              title: "Loss",
              height: 300,
              asOf: "2999-01-01T00:00:00.000Z",
            })
            .pipe(Stream.unwrap, Stream.runCollect);
          expect(rendered.at(-1)).toMatchObject({
            isFailure: true,
            result: { code: "invalid_request" },
          });
          expect(yield* Ref.get(harness.issued)).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  });

  it("refuses queries while Aperture is disabled, without contacting it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ enabled: false });
        yield* Effect.gen(function* () {
          const toolkit = yield* ApertureToolkit;
          const queried = yield* toolkit
            .handle("aperture_query", { operation: "runs" })
            .pipe(Stream.unwrap, Stream.runCollect);
          expect(queried.at(-1)).toMatchObject({
            isFailure: true,
            result: { code: "capability_denied" },
          });
          expect(yield* Ref.get(harness.requests)).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  });

  it("rejects a render height outside the transcript bounds before running", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        const rendered = yield* Effect.gen(function* () {
          const toolkit = yield* ApertureToolkit;
          return yield* toolkit
            .handle("aperture_figure_render", { spec: { kind: "line" }, title: "Loss", height: 40 })
            .pipe(Stream.unwrap, Stream.runCollect);
        }).pipe(Effect.provide(harness.layer));
        expect(rendered.at(-1)).toMatchObject({
          isFailure: true,
          result: { reason: { _tag: "ToolParameterValidationError" } },
        });
        expect(yield* Ref.get(harness.issued)).toEqual([]);
      }),
    );
  });
});

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

const APERTURE_TOOL_NAMES = [
  "aperture_figure_preview",
  "aperture_figure_render",
  "aperture_query",
  "aperture_status",
  "aperture_widget_preview",
  "aperture_widget_push",
  "aperture_widget_render",
];

/** Test settings whose updates reach subscribers, as the persisted service's do. */
const layerChangingSettings = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* PubSub.unbounded<ServerSettingsValue>();
    return {
      ...settings,
      updateSettings: (patch) =>
        settings.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    } satisfies ServerSettings.ServerSettingsService["Service"];
  }),
).pipe(Layer.provide(ServerSettings.layerTest(apertureSettings(false))));

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(ApertureConnection.ApertureConnection)({}),
  Layer.mock(ApertureRuntime.ApertureRuntime)({}),
  Layer.mock(ApertureWidgetStore.ApertureWidgetStore)({}),
);

describe("Aperture MCP registration", () => {
  it("lists the Aperture tools only while Aperture is enabled, without a restart", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // One settings instance, so the update below reaches the server's subscription.
          const settingsContext = yield* Layer.build(layerChangingSettings);
          yield* HttpRouter.serve(
            McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
            {
              disableListenLog: true,
              disableLogger: true,
            },
          ).pipe(
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-aperture")),
              }),
            ),
            Layer.provide(PreviewAutomationBroker.layer),
            Layer.provide(PreviewBrowser.layer),
            Layer.provide(layerStubServices),
            Layer.provide(Layer.succeedContext(settingsContext)),
            Layer.build,
          );
          const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
            threadId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          });
          if (credential === undefined) throw new Error("no MCP credential was issued");
          const authorization = credential.config.authorizationHeader;
          const httpClient = yield* HttpClient.HttpClient;
          const initialized = yield* httpClient.post("/mcp", {
            headers: { accept: "application/json, text/event-stream", authorization },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"aperture-test","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const sessionId = initialized.headers["mcp-session-id"];
          const listApertureTools = Effect.gen(function* () {
            const listed = yield* httpClient.post("/mcp", {
              headers: {
                accept: "application/json, text/event-stream",
                authorization,
                "mcp-protocol-version": "2025-06-18",
                ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
              },
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
                "application/json",
              ),
            });
            const text = yield* listed.text;
            const payload = yield* decodeToolsListPayload(text.match(/\{.*\}/su)?.[0] ?? text);
            return payload.result.tools.filter((tool) => tool.name.startsWith("aperture_"));
          });

          expect(yield* listApertureTools).toEqual([]);

          const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
          yield* settings.updateSettings({ aperture: { enabled: true } });
          const enabled = yield* listApertureTools.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 millis"),
              until: (tools) => tools.length > 0,
              times: 100,
            }),
          );
          expect(enabled.map((tool) => tool.name).sort()).toEqual(APERTURE_TOOL_NAMES);
          for (const tool of enabled) {
            expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
          }
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeHttpServer.layerTest,
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-aperture-mcp-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeServices.layer,
          ),
        ),
      ),
    );
  });
});
