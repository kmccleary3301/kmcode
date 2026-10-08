// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ProviderInstanceId, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

interface Options {
  readonly baseDirectory: string;
  readonly cli: string;
  readonly dryRun: boolean;
  readonly projectsRoot: string;
  readonly providerInstanceId: string;
  readonly reportPath?: string;
  readonly serverUrl?: string;
}

const IssuedSession = Schema.Struct({ token: Schema.String, sessionId: Schema.String });
const ServerRuntime = Schema.Struct({ origin: Schema.String });
const decodeIssuedSession = Schema.decodeUnknownSync(Schema.fromJsonString(IssuedSession));
const decodeServerRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(ServerRuntime));
const makeWsRpcClient = RpcClient.make(WsRpcGroup);

function expandHome(input: string): string {
  if (input === "~") return NodeOS.homedir();
  return input.startsWith("~/") ? NodePath.join(NodeOS.homedir(), input.slice(2)) : input;
}

function readValue(argv: ReadonlyArray<string>, index: number, name: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  let baseDirectory = NodePath.join(NodeOS.homedir(), ".t3", "t3code-pi-omp");
  let cli = NodePath.join(NodeOS.homedir(), ".local", "bin", "t3-pi-omp");
  let dryRun = false;
  let projectsRoot = NodePath.join(NodeOS.homedir(), "projects");
  let providerInstanceId = "omp";
  let reportPath: string | undefined;
  let serverUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--base-dir":
        baseDirectory = expandHome(readValue(argv, index, argument));
        index += 1;
        break;
      case "--cli":
        cli = expandHome(readValue(argv, index, argument));
        index += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--projects-root":
        projectsRoot = expandHome(readValue(argv, index, argument));
        index += 1;
        break;
      case "--provider-instance":
        providerInstanceId = readValue(argv, index, argument);
        index += 1;
        break;
      case "--report":
        reportPath = expandHome(readValue(argv, index, argument));
        index += 1;
        break;
      case "--server-url":
        serverUrl = readValue(argv, index, argument).replace(/\/$/u, "");
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    baseDirectory: NodePath.resolve(baseDirectory),
    cli: NodePath.resolve(cli),
    dryRun,
    projectsRoot: NodePath.resolve(projectsRoot),
    providerInstanceId,
    ...(reportPath === undefined ? {} : { reportPath: NodePath.resolve(reportPath) }),
    ...(serverUrl === undefined ? {} : { serverUrl }),
  };
}

function resolveServerUrl(options: Options): string {
  if (options.serverUrl !== undefined) return options.serverUrl;
  const runtimePath = NodePath.join(options.baseDirectory, "userdata", "server-runtime.json");
  return decodeServerRuntime(NodeFS.readFileSync(runtimePath, "utf8")).origin.replace(/\/$/u, "");
}

function wsProtocolLayer(url: string, token: string) {
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    // Socket.makeWebSocket only ever passes its `protocols` option here.
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(socketUrl, protocols as string | string[] | undefined, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
}

async function isEligibleWorkspace(cwd: string, projectsRoot: string): Promise<boolean> {
  let realCwd: string;
  try {
    const stat = await NodeFS.promises.stat(cwd);
    if (!stat.isDirectory()) return false;
    realCwd = await NodeFS.promises.realpath(cwd);
  } catch {
    return false;
  }
  const relative = NodePath.relative(projectsRoot, realCwd);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const projectsRoot = await NodeFS.promises.realpath(options.projectsRoot);
  const serverUrl = resolveServerUrl(options);
  const issued = decodeIssuedSession(
    NodeChildProcess.execFileSync(
      options.cli,
      ["auth", "session", "issue", "--base-dir", options.baseDirectory, "--json"],
      { encoding: "utf8" },
    ),
  );

  try {
    const result = await Effect.runPromise(
      makeWsRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const providerInstanceId = ProviderInstanceId.make(options.providerInstanceId);
            yield* client[WS_METHODS.serverRefreshProviders]({ instanceId: providerInstanceId });
            const listed = yield* client[WS_METHODS.serverListNativeSessions]({
              providerInstanceId,
            });
            const unique = Array.from(
              new Map(listed.sessions.map((session) => [session.sessionId, session])).values(),
            );
            const eligibility = yield* Effect.promise(() =>
              Promise.all(
                unique.map(async (session) => ({
                  session,
                  eligible: await isEligibleWorkspace(session.cwd, projectsRoot),
                })),
              ),
            );
            const eligible = eligibility
              .filter((item) => item.eligible)
              .map((item) => item.session);
            const indexed: Array<{ projectId: string; sessionId: string; threadId: string }> = [];
            const failed: Array<{ sessionId: string; cwd: string; error: string }> = [];

            if (!options.dryRun) {
              for (const [index, session] of eligible.entries()) {
                const opened = yield* client[WS_METHODS.serverOpenNativeSession]({
                  providerInstanceId,
                  sessionId: session.sessionId,
                }).pipe(
                  Effect.map((value) => ({ ok: true as const, value })),
                  Effect.catch((error) =>
                    Effect.succeed({ ok: false as const, error: String(error) }),
                  ),
                );
                if (opened.ok) {
                  indexed.push({
                    projectId: opened.value.projectId,
                    sessionId: session.sessionId,
                    threadId: opened.value.threadId,
                  });
                } else {
                  failed.push({
                    sessionId: session.sessionId,
                    cwd: session.cwd,
                    error: opened.error,
                  });
                }
                process.stdout.write(
                  `\rIndexed ${index + 1}/${eligible.length}; failures ${failed.length}`,
                );
              }
              process.stdout.write("\n");
            }

            return {
              schemaVersion: 1,
              dryRun: options.dryRun,
              providerInstanceId: options.providerInstanceId,
              projectsRoot,
              discoveredSessionCount: unique.length,
              eligibleSessionCount: eligible.length,
              eligibleWorkspaceCount: new Set(eligible.map((session) => session.cwd)).size,
              indexedSessionCount: indexed.length,
              failedSessionCount: failed.length,
              indexed,
              failed,
            };
          }),
        ),
        Effect.provide(wsProtocolLayer(serverUrl.replace(/^http:/u, "ws:") + "/ws", issued.token)),
        Effect.scoped,
      ),
    );

    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.reportPath !== undefined) {
      await NodeFS.promises.mkdir(NodePath.dirname(options.reportPath), { recursive: true });
      await NodeFS.promises.writeFile(options.reportPath, output);
    }
    process.stdout.write(output);
    if (result.failedSessionCount > 0) process.exitCode = 1;
  } finally {
    NodeChildProcess.execFileSync(
      options.cli,
      ["auth", "session", "revoke", "--base-dir", options.baseDirectory, issued.sessionId],
      { stdio: "ignore" },
    );
  }
}

await main();
