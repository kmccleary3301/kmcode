import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const eventLoggers = Layer.succeed(
  ProviderEventLoggers.ProviderEventLoggers,
  ProviderEventLoggers.NoOpProviderEventLoggers,
);

describe.skipIf(process.platform === "win32")("Claude CLI agent tracking", () => {
  it.effect("allows CLI queries without a server scanner", () => {
    let capturedEnvironment: NodeJS.ProcessEnv | undefined;
    const threadId = ThreadId.make("thread-query-failure");
    const input = {
      threadId,
      providerSessionId: ProviderSessionId.make("session-query-failure"),
      options: {
        sessionId: "native-session-query-failure",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        env: { KM_AGENT_TEST_PROVIDER_ENV: "provided" },
      },
    } satisfies ClaudeAgentSdkQueryOpenInput;
    const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      capturedEnvironment = options?.env;
      throw new Error("query failed");
    });
    const runner = layerQueryRunner.pipe(
      Layer.provide(eventLoggers),
      Layer.provide(NodeServices.layer),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
        const queryRunner = yield* ClaudeAgentSdkQueryRunner;
        const result = yield* queryRunner.open(input).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(result));
        assert.equal(capturedEnvironment?.[PortScanner.AGENT_THREAD_ENV], threadId);
        assert.equal(capturedEnvironment?.KM_AGENT_TEST_PROVIDER_ENV, "provided");
        assert.isUndefined(capturedEnvironment?.KM_AGENT_TEST_HOST_ENV);
      }).pipe(Effect.provide(runner)),
    );
  });

  it.effect(
    "uses host environment, tags CLI work, and releases tracking once on query failure",
    () => {
      let activeAgents = 0;
      let trackCalls = 0;
      let releaseCalls = 0;
      let capturedEnvironment: NodeJS.ProcessEnv | undefined;
      const threadId = ThreadId.make("thread-fake-cli");
      const input = {
        threadId,
        providerSessionId: ProviderSessionId.make("session-fake-cli"),
        options: {
          sessionId: "native-session-fake-cli",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      } satisfies ClaudeAgentSdkQueryOpenInput;
      const discovery = Layer.mock(PortScanner.PortDiscovery)({
        trackAgent: () => {
          trackCalls += 1;
          activeAgents += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            activeAgents -= 1;
            releaseCalls += 1;
          };
        },
      });
      const hostEnvironment = {
        ...process.env,
        KM_AGENT_TEST_HOST_ENV: "from-host",
      };
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        assert.equal(activeAgents, 1);
        capturedEnvironment = options?.env;
        throw new Error("query failed");
      });
      const runner = layerQueryRunner.pipe(
        Layer.provide(discovery),
        Layer.provide(eventLoggers),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HostProcessEnvironment, hostEnvironment)),
      );
      return Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
          const queryRunner = yield* ClaudeAgentSdkQueryRunner;
          const result = yield* queryRunner.open(input).pipe(Effect.exit);

          assert.isTrue(Exit.isFailure(result));
          assert.equal(capturedEnvironment?.[PortScanner.AGENT_THREAD_ENV], threadId);
          assert.equal(capturedEnvironment?.KM_AGENT_TEST_HOST_ENV, "from-host");
          assert.equal(trackCalls, 1);
          assert.equal(activeAgents, 0);
          assert.equal(releaseCalls, 1);
        }).pipe(Effect.provide(runner)),
      );
    },
  );
});
