import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { expect, vi } from "vite-plus/test";
import { FetchHttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const layerTestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});

let integrationListeningPort: number | null = null;

const layerTestIntegrationNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: (port) => Effect.sync(() => port !== integrationListeningPort),
  hasListenerOnHost: (port) => Effect.sync(() => port === integrationListeningPort),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

const layerProbeFailure = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        FileSystem.layerNoop({}),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const layerTestPortDiscovery = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerTestProcessRunner,
      layerTestIntegrationNet,
      Layer.succeed(HostProcessPlatform, "win32"),
      FileSystem.layerNoop({}),
      FetchHttpClient.layer,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

const layerLsofScanner = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly environment?: NodeJS.ProcessEnv;
  readonly agentThreadId?: string;
  readonly onRun?: () => void;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () => {
            input.onRun?.();
            return Effect.succeed({
              stdout: `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FileSystem.layerNoop({
          readFileString: (path) =>
            Effect.succeed(
              path === `/proc/${input.pid()}/environ` && input.agentThreadId !== undefined
                ? `T3CODE_THREAD_ID=${input.agentThreadId}\0`
                : "",
            ),
        }),
        Layer.succeed(HostProcessEnvironment, input.environment ?? {}),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer(onConnection);
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
  onConnection: (socket: NodeNet.Socket) => void,
) {
  for (const port of ports) {
    const server = yield* openServer(port, onConnection);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS, (socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

const commonNonHttpServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS.toReversed(), (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end("MYSQL\r\n\r\n"));
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(layerTestPortDiscovery)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns an HTTP server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "scan() excludes a listening port that does not speak HTTP",
    Effect.fn("PortScannerTest.scanExcludesNonHttpServer")(function* () {
      const { port } = yield* commonNonHttpServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      expect(result.some((server) => server.port === port)).toBe(false);
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe({ configuredUrls: [], initialSnapshot: [] }, (servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt.effect("revalidates a successful HTML probe after its cache entry expires", () => {
  let responds = true;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    responds = false;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps a full configured URL when the discovered server root fails", () => {
  const requests: string[] = [];
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === configuredUrl
        ? new Response("docs", { headers: { "content-type": "text/html" } })
        : new Response("not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes configured custom ports through a canonical loopback host", () => {
  const customPort = 43_124;
  const configuredUrl = `http://0.0.0.0:${customPort}/docs`;
  const expectedUrl = `http://localhost:${customPort}/docs`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.host).toBe("localhost");
    expect(servers[0]?.port).toBe(customPort);
    expect(servers[0]?.url).toBe(expectedUrl);
    expect(requests).toEqual([expectedUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("preserves explicit loopback hosts and bounds wildcard rewrites", () => {
  const ipv4Url = "https://127.0.0.1:43125/docs";
  const ipv6Url = "http://[::1]:43126/docs";
  const wildcardPrefix = "http://0.0.0.0/";
  const maximumWildcardUrl = `${wildcardPrefix}${"a".repeat(
    PREVIEW_URL_MAX_LENGTH - wildcardPrefix.length,
  )}`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([ipv4Url, ipv6Url, maximumWildcardUrl]);
    expect(servers.map((server) => server.url)).toEqual([ipv4Url, ipv6Url]);
    expect(requests).toEqual([ipv4Url, ipv6Url]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("projects configured paths independently for simultaneous subscribers", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    yield* scanner.subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    );
    yield* scanner.subscribe({ configuredUrls: [adminUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    );
    yield* scanner.retain;

    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect(
  "keeps each subscriber's candidates when their combined union exceeds the per-client cap",
  () => {
    const firstSubscriberUrls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:${LSOF_TEST_PORT}/app-${index}`,
    );
    const secondSubscriberUrl = `http://localhost:${LSOF_TEST_PORT}/app-${CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS}`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(
        String(input) === secondSubscriberUrl
          ? new Response("app", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      )) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const secondSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
      yield* scanner.subscribe(
        { configuredUrls: firstSubscriberUrls, initialSnapshot: [] },
        () => Effect.void,
      );
      yield* scanner.subscribe(
        { configuredUrls: [secondSubscriberUrl], initialSnapshot: [] },
        (servers) => Effect.sync(() => secondSnapshots.push(servers)),
      );
      yield* scanner.retain;

      expect(secondSnapshots.at(-1)?.[0]?.url).toBe(secondSubscriberUrl);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

effectIt.effect("stops probing a subscriber's configured paths after its scope closes", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsScope = yield* Scope.make();
    yield* scanner
      .subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, () => Effect.void)
      .pipe(Effect.provideService(Scope.Scope, docsScope));
    yield* scanner.subscribe(
      { configuredUrls: [adminUrl], initialSnapshot: [] },
      () => Effect.void,
    );
    yield* scanner.retain;
    yield* Scope.close(docsScope, Exit.void);

    requests.length = 0;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(requests).toContain(adminUrl);
    expect(requests).not.toContain(docsUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("writes no poll span while no client retains the scanner", () => {
  let pollSpans = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "PortDiscovery.pollTick") pollSpans += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  const layer = layerProbeFailure(processProbeFailure);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(pollSpans).toBe(0);

    yield* scanner.retain;
    expect(pollSpans).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.withTracer(tracer));
});

effectIt.effect("uses the current configured fragment when readiness comes from cache", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });
  const oldUrl = `http://localhost:${LSOF_TEST_PORT}/docs#old`;
  const newUrl = `http://localhost:${LSOF_TEST_PORT}/docs#new`;

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect((yield* scanner.scan([oldUrl]))[0]?.url).toBe(oldUrl);
    const requestCount = requests.length;
    expect((yield* scanner.scan([newUrl]))[0]?.url).toBe(newUrl);
    expect(requests).toHaveLength(requestCount);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("shares a configured root probe with discovered-root classification", () => {
  const requests: string[] = [];
  const rootUrl = `http://localhost:${LSOF_TEST_PORT}/`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl]);

    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl, rootUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("starts fresh cache entries after the probing batch completes", () =>
  Effect.gen(function* () {
    const baseClock = yield* Clock.Clock;
    const times = [0, 20_000, 20_000, 20_000];
    let timeIndex = 0;
    const currentTimeMillis = () => times[Math.min(timeIndex++, times.length - 1)]!;
    const clock: Clock.Clock = {
      ...baseClock,
      currentTimeMillisUnsafe: currentTimeMillis,
      currentTimeMillis: Effect.sync(currentTimeMillis),
    };
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  }),
);

effectIt.effect("caches a failed web probe until its bounded cache entry expires", () => {
  let responds = false;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(2);

    responds = true;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("falls back to HTTPS and does not follow redirects while probing", () => {
  const redirects: Array<string | undefined> = [];
  const fetchFn = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    redirects.push(init?.redirect);
    if (String(input).startsWith("http:")) throw new TypeError("TLS listener");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`);
    expect(redirects).toEqual(["manual", "manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "excludes HTTP errors, non-navigation responses, and successful non-documents",
  () => {
    let pid = 1;
    let makeResponse = () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(makeResponse())) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("ready", { status: 200, headers: { "content-type": "text/plain" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 304, headers: { location: "/cached" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response(null, { status: 204, headers: { "content-type": "text/html" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 302 });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("<html />", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        });
      expect(yield* scanner.scan()).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("aborts HTTP and HTTPS probes when they time out", () => {
  const aborted: string[] = [];
  const fetchFn = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborted.push(String(input));
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    })) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const scanFiber = yield* Effect.forkChild(scanner.scan());
    yield* TestClock.adjust(Duration.seconds(2));
    expect(yield* Fiber.join(scanFiber)).toHaveLength(0);
    expect(aborted).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = layerProbeFailure(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = layerProbeFailure(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);
effectIt.effect("lists terminal-owned listeners without sending HTTP or TLS probes", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds: [1234],
    });
    expect(yield* scanner.scan()).toMatchObject([
      {
        port: LSOF_TEST_PORT,
        pid: 1234,
        url: `http://localhost:${LSOF_TEST_PORT}`,
        terminal: { threadId: "scanner-thread", terminalId: "scanner-terminal" },
      },
    ]);
    expect(requests).toEqual([]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps Linux listener ownership after trackAgent is released", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({
    pid: () => 1234,
    fetch: fetchFn,
    agentThreadId: "scanner-agent-thread",
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const releaseAgent = scanner.trackAgent();
    const serversWhileRunning = yield* scanner.scan();
    releaseAgent();
    const serversAfterRelease = yield* scanner.scan();

    expect(serversWhileRunning).toMatchObject([
      {
        port: LSOF_TEST_PORT,
        pid: 1234,
        agent: { threadId: "scanner-agent-thread" },
      },
    ]);
    expect(serversAfterRelease).toMatchObject([
      {
        port: LSOF_TEST_PORT,
        pid: 1234,
        agent: { threadId: "scanner-agent-thread" },
      },
    ]);
    expect(requests).toEqual([]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("stops only a job's own process group", () =>
  Effect.sync(() => {
    const serverPid = 100;
    const processTable = new Map<number, PortScanner.ProcessTableRow>([
      [10, { pid: 10, ppid: 1, pgid: 10 }], // job holding this server
      [20, { pid: 20, ppid: 10, pgid: 10 }], // server in the same job
      [serverPid, { pid: serverPid, ppid: 10, pgid: 10 }],
      [200, { pid: 200, ppid: serverPid, pgid: 200 }], // agent CLI
      [210, { pid: 210, ppid: 200, pgid: 200 }], // server in the agent's group
      [300, { pid: 300, ppid: 200, pgid: 300 }], // agent tool shell
      [400, { pid: 400, ppid: 300, pgid: 400 }], // background dev shell
      [401, { pid: 401, ppid: 400, pgid: 400 }],
      [500, { pid: 500, ppid: serverPid, pgid: 500 }], // terminal shell
      [600, { pid: 600, ppid: 500, pgid: 600 }], // terminal job
    ]);

    expect(PortScanner.stoppableProcessGroup(processTable, 401, serverPid)).toBe(400);
    expect(PortScanner.stoppableProcessGroup(processTable, 600, serverPid)).toBe(600);
    for (const pid of [20, 210, 500, 999]) {
      expect(PortScanner.stoppableProcessGroup(processTable, pid, serverPid)).toBeNull();
    }
  }),
);
effectIt.effect("rechecks the socket owner before stopping a Linux server without lsof", () => {
  let holderPid = "4242";
  let processTableReads = 0;
  const missing = FileSystem.makeNoop({});
  const procNetTcp = [
    "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode",
    "0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 5001",
  ].join("\n");
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (input.command === "lsof") return processProbeFailure(input);
            processTableReads += 1;
            return Effect.succeed({
              stdout: processTableReads === 1 ? "4242 1 4300\n5000 1 5300\n" : "",
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FileSystem.layerNoop({
          readFileString: (path) => {
            if (path === "/proc/net/tcp") return Effect.succeed(procNetTcp);
            if (/^\/proc\/(?:4242|5000)\/comm$/.test(path)) {
              return Effect.succeed("node\n");
            }
            if (/^\/proc\/(?:4242|5000)\/environ$/.test(path)) {
              return Effect.succeed(`${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`);
            }
            return missing.readFileString(path);
          },
          readDirectory: (path) => {
            if (path === "/proc") return Effect.succeed(["4242", "5000"]);
            if (/^\/proc\/(?:4242|5000)\/fd$/.test(path)) {
              return Effect.succeed(path === `/proc/${holderPid}/fd` ? ["3"] : []);
            }
            return missing.readDirectory(path);
          },
          readLink: (path) =>
            path === `/proc/${holderPid}/fd/3`
              ? Effect.succeed("socket:[5001]")
              : missing.readLink(path),
        }),
        Layer.succeed(HostProcessEnvironment, {}),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, () =>
              Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } })),
            ),
          ),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toMatchObject([{ pid: 4242, port: 8_765 }]);

    // The listener outlives its original holder; that PID now belongs to a different agent job.
    holderPid = "5000";
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    yield* Effect.addFinalizer(() => Effect.sync(() => signal.mockRestore()));
    const stop = yield* Effect.flip(scanner.stopServer({ pid: 4242, port: 8_765 }));
    expect(stop.reason).toBe("not-found");
    expect(signal).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("does not send SIGKILL when a stopped process group ID is reused", () => {
  let processTable = "4242 1 5300\n4243 4242 5300\n";
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.succeed({
              stdout:
                input.command === "lsof" ? `p4242\ncnode\nn*:${LSOF_TEST_PORT}\n` : processTable,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FileSystem.layerNoop({
          readFileString: (path) =>
            Effect.succeed(
              path === "/proc/4242/environ" ? `${PortScanner.AGENT_THREAD_ENV}=thread-agent\0` : "",
            ),
        }),
        Layer.succeed(HostProcessEnvironment, {}),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, () =>
              Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } })),
            ),
          ),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const signal = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") processTable = "5000 1 5300\n";
      return true;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => signal.mockRestore()));

    const stopping = yield* Effect.forkChild(
      scanner.stopServer({ pid: 4242, port: LSOF_TEST_PORT }),
      { startImmediately: true },
    );
    yield* TestClock.adjust(Duration.seconds(5));
    yield* Fiber.join(stopping);

    expect(signal).toHaveBeenCalledWith(-5300, "SIGTERM");
    expect(signal).not.toHaveBeenCalledWith(-5300, "SIGKILL");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layer, TestClock.layer())));
});

effectIt.effect("disables listener discovery but still probes configured URLs", () => {
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const requests: string[] = [];
  let listenerQueries = 0;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({
    pid: () => 1234,
    fetch: fetchFn,
    environment: { T3CODE_PORT_DISCOVERY: "0" },
    onRun: () => listenerQueries++,
  });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toEqual([]);
    expect(yield* scanner.scan([configuredUrl])).toMatchObject([
      { port: LSOF_TEST_PORT, url: configuredUrl },
    ]);
    expect(requests).toEqual([configuredUrl]);
    expect(listenerQueries).toBe(0);
  }).pipe(Effect.provide(layer));
});
