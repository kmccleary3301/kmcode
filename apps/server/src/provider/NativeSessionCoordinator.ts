/**
 * Pi and OMP native sessions as KM Code threads. Opening a session imports its
 * active-branch history (prompts, answers, thinking, and tool calls) once and
 * binds the thread to the session file; the Pi adapter then resumes that file
 * on the thread's first turn.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  OmpSettings,
  PiSettings,
  ProjectId,
  type AbsolutePath,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ServerCommand,
  ProviderModelRoleError,
  type ProviderModelRolesInput,
  type ProviderModelRolesResult,
  type ProviderInstanceId,
  type ProviderSetModelRoleInput,
  type ProviderNativeSessionArchiveInput,
  type ProviderNativeSessionArchiveResult,
  ProviderNativeSessionError,
  type ProviderNativeSessionForkInput,
  type ProviderNativeSessionForkResult,
  type ProviderNativeSessionListRequest,
  type ProviderNativeSessionListResult,
  type ProviderNativeSessionOpenInput,
  type ProviderNativeSessionOpenResult,
  type ProviderNativeSessionRenameInput,
  type ProviderNativeSessionRenameResult,
  type ProviderNativeSessionStopInput,
  type ProviderNativeSessionStopResult,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { makePiRpcConnection } from "../orchestration-v2/Adapters/PiRpc.ts";
import { piToolTurnItemFields } from "../orchestration-v2/Adapters/PiToolTurnItem.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../orchestration-v2/Adapters/piT3McpInjection.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { messageEvents } from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  readModelRoles,
  readRecentModels,
  writeModelRole,
  type ModelRolesSnapshot,
} from "./NativeModelRoles.ts";
import {
  listNativeSessionFiles,
  readNativeHistory,
  readNativeSessionFile,
  resolveNativeAgentDirectory,
  writeNativeSessionTitle,
  type NativeSessionFile,
  type NativeSessionLocation,
} from "./NativeSessionStore.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { OMP_DIALECT, PI_DIALECT, type PiDialect } from "./piDialect.ts";

const IMPORT_EVENT_PREFIX = "native-session-import:v1";
const decodePiSettings = Schema.decodeUnknownEffect(PiSettings);
const decodeOmpSettings = Schema.decodeUnknownEffect(OmpSettings);

export interface NativeSessionCoordinatorShape {
  readonly list: (
    input: ProviderNativeSessionListRequest,
  ) => Effect.Effect<ProviderNativeSessionListResult, ProviderNativeSessionError>;
  readonly open: (
    input: ProviderNativeSessionOpenInput,
  ) => Effect.Effect<ProviderNativeSessionOpenResult, ProviderNativeSessionError>;
  readonly rename: (
    input: ProviderNativeSessionRenameInput,
  ) => Effect.Effect<ProviderNativeSessionRenameResult, ProviderNativeSessionError>;
  readonly fork: (
    input: ProviderNativeSessionForkInput,
  ) => Effect.Effect<ProviderNativeSessionForkResult, ProviderNativeSessionError>;
  readonly stop: (
    input: ProviderNativeSessionStopInput,
  ) => Effect.Effect<ProviderNativeSessionStopResult, ProviderNativeSessionError>;
  readonly archive: (
    input: ProviderNativeSessionArchiveInput,
  ) => Effect.Effect<ProviderNativeSessionArchiveResult, ProviderNativeSessionError>;
  readonly modelRoles: (
    input: ProviderModelRolesInput,
  ) => Effect.Effect<ProviderModelRolesResult, ProviderModelRoleError>;
  readonly setModelRole: (
    input: ProviderSetModelRoleInput,
  ) => Effect.Effect<ProviderModelRolesResult, ProviderModelRoleError>;
}

interface NativeInstance {
  readonly dialect: PiDialect;
  readonly binary: string;
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly location: NativeSessionLocation;
}

const isNativeSessionError = Schema.is(ProviderNativeSessionError);
const isModelRoleError = Schema.is(ProviderModelRoleError);

function asNativeSessionError(message: string) {
  return (cause: unknown): ProviderNativeSessionError => {
    if (isNativeSessionError(cause)) return cause;
    const detail = cause instanceof Error ? cause.message.trim() : "";
    return new ProviderNativeSessionError({
      code: "native",
      message: detail.length > 0 ? `${message} ${detail}` : message,
    });
  };
}

/**
 * Stable per session, so reopening finds the same thread. A deleted thread
 * keeps its id in the event log; the session's mtime then names a successor.
 */
function nativeThreadIds(session: NativeSessionFile): readonly [ThreadId, ThreadId] {
  const base = `native:${session.summary.providerInstanceId}:${session.summary.sessionId}`;
  return [
    ThreadId.make(base),
    ThreadId.make(
      `${base}:${DateTime.toEpochMillis(DateTime.makeUnsafe(session.summary.updatedAt))}`,
    ),
  ];
}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // Opening, forking, and archiving read then write thread state; one at a
  // time keeps two clicks from importing the same session twice.
  const mutations = yield* Semaphore.make(1);

  const newCommandId = crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    threadManagement
      .dispatch(command)
      .pipe(Effect.mapError(asNativeSessionError(`Could not apply ${command.type}.`)));

  const resolveInstance = Effect.fn("NativeSessionCoordinator.resolveInstance")(function* (
    providerInstanceId: ProviderInstanceId,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(asNativeSessionError("Could not read server settings.")),
    );
    const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
    if (instance === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "not_found",
        message: `Provider instance '${providerInstanceId}' is not configured.`,
      });
    }
    const dialect =
      instance.driver === PI_DIALECT.driverKind
        ? PI_DIALECT
        : instance.driver === OMP_DIALECT.driverKind
          ? OMP_DIALECT
          : undefined;
    if (dialect === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: `Provider instance '${providerInstanceId}' has no Pi or OMP native sessions.`,
      });
    }
    const config = yield* (dialect === OMP_DIALECT ? decodeOmpSettings : decodePiSettings)(
      instance.config ?? {},
    ).pipe(Effect.mapError(asNativeSessionError(`${dialect.displayName} settings are invalid.`)));
    const launchArgs = resolvePiLaunchArgs(config.launchArgs);
    if (!launchArgs.ok) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: launchArgs.message,
      });
    }
    const environment = mergeProviderInstanceEnvironment(instance.environment);
    return {
      dialect,
      binary: config.binaryPath || dialect.binary,
      launchArgs: launchArgs.args,
      environment,
      location: {
        runtime: dialect.binary,
        cwd: serverConfig.cwd,
        environment,
        launchArguments: launchArgs.args,
      },
    } satisfies NativeInstance;
  });

  const findSession = Effect.fn("NativeSessionCoordinator.findSession")(function* (
    providerInstanceId: ProviderInstanceId,
    sessionId: string,
  ) {
    const instance = yield* resolveInstance(providerInstanceId);
    const sessions = yield* Effect.tryPromise(() =>
      listNativeSessionFiles(instance.location, providerInstanceId),
    ).pipe(Effect.mapError(asNativeSessionError("Could not read native sessions.")));
    const session = sessions.find((candidate) => candidate.summary.sessionId === sessionId);
    if (session === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "not_found",
        message: `Native session '${sessionId}' was not found.`,
      });
    }
    return { instance, session };
  });

  /**
   * The newest live root thread whose provider thread is bound to the session
   * file. KM Code-started sessions adopt their run's provider thread id and
   * learn the file afterwards, so the native ref is the only shared key.
   */
  const findThread = Effect.fn("NativeSessionCoordinator.findThread")(function* (
    session: NativeSessionFile,
  ) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_provider_threads
      WHERE provider_instance_id = ${session.summary.providerInstanceId}
        AND owner_node_id IS NULL
        AND thread_id IS NOT NULL
        AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${session.filePath}
      ORDER BY updated_at DESC
    `.pipe(Effect.mapError(asNativeSessionError("Could not read the session's thread.")));
    for (const row of rows) {
      const shell = yield* threadManagement
        .getThreadShell(ThreadId.make(row.thread_id))
        .pipe(Effect.mapError(asNativeSessionError("Could not read the session's thread.")));
      if (shell !== null) return shell;
    }
    return undefined;
  });

  const resolveProject = Effect.fn("NativeSessionCoordinator.resolveProject")(function* (
    workspaceRoot: string,
  ) {
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(asNativeSessionError("Could not read projects.")),
    );
    const target = normalizeProjectPathForComparison(workspaceRoot);
    const existing = snapshot.projects.find(
      (project) => normalizeProjectPathForComparison(project.workspaceRoot) === target,
    );
    if (existing !== undefined) return existing;
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: yield* newCommandId,
        projectId: ProjectId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        workspaceRoot: workspaceRoot as AbsolutePath,
        title: workspaceRoot.split(/[\\/]/u).findLast((part) => part.length > 0) ?? workspaceRoot,
      })
      .pipe(Effect.mapError(asNativeSessionError(`Could not add project ${workspaceRoot}.`)));
    return bootstrapped.project;
  });

  const createThread = Effect.fn("NativeSessionCoordinator.createThread")(function* (
    session: NativeSessionFile,
    instance: NativeInstance,
    threadId: ThreadId,
  ) {
    const { summary } = session;
    const project = yield* resolveProject(summary.cwd);
    const history = yield* Effect.tryPromise(() => readNativeHistory(session.filePath)).pipe(
      Effect.mapError(asNativeSessionError("Could not read the session history.")),
    );
    const models =
      (yield* providerRegistry.getProviders).find(
        (provider) => provider.instanceId === summary.providerInstanceId,
      )?.models ?? [];
    const model =
      models.find((candidate) => candidate.slug === summary.model)?.slug ??
      models.find((candidate) => candidate.isDefault)?.slug ??
      models[0]?.slug ??
      "default";
    const driver = instance.dialect.driverKind;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      providerInstanceId: summary.providerInstanceId,
      nativeThreadId: session.filePath,
    });
    const createdAt = DateTime.makeUnsafe(summary.createdAt);
    const updatedAt = DateTime.makeUnsafe(summary.updatedAt);
    const appThread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "server",
      id: threadId,
      projectId: project.id,
      title: summary.title,
      providerInstanceId: summary.providerInstanceId,
      modelSelection: { instanceId: summary.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      // historyOrigin stays unset rather than "v1_import": Pi resumes the
      // session file with its full history, so the imported items must not
      // also be replayed to it as a context handoff.
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: updatedAt,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: summary.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      // Pi's switch_session takes the session file path, not the session id.
      nativeThreadRef: { driver, nativeId: session.filePath, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "not_loaded",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };
    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId: summary.providerInstanceId,
            occurredAt: createdAt,
            payload: appThread,
          },
          ...history.flatMap((message, index): ReadonlyArray<OrchestrationV2DomainEvent> => {
            if (message.role === "user" || message.role === "assistant") {
              return messageEvents({ threadId, index, message });
            }
            const suffix = String(index).padStart(6, "0");
            const id = `${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`;
            const startedAt = DateTime.makeUnsafe(message.createdAt);
            const result = message.role === "tool" ? message.result : undefined;
            const completedAt =
              result === undefined ? startedAt : DateTime.makeUnsafe(result.completedAt);
            const common = {
              id: TurnItemId.make(id),
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index + 1,
              startedAt,
              completedAt,
              updatedAt: completedAt,
            };
            const turnItem: OrchestrationV2TurnItem =
              message.role === "tool"
                ? {
                    ...common,
                    // A call without a recorded result never finished.
                    status:
                      result === undefined
                        ? "interrupted"
                        : result.isError
                          ? "failed"
                          : "completed",
                    ...piToolTurnItemFields({
                      toolName: message.toolName,
                      args: message.args,
                      outputText: result?.outputText ?? "",
                      details: result?.details,
                      isError: result?.isError ?? false,
                    }),
                  }
                : {
                    ...common,
                    status: "completed",
                    title: null,
                    type: "reasoning",
                    text: message.text,
                    streaming: false,
                  };
            return [
              {
                id: EventId.make(id),
                type: "turn-item.updated",
                threadId,
                occurredAt: completedAt,
                payload: turnItem,
              },
            ];
          }),
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId: summary.providerInstanceId,
            occurredAt: updatedAt,
            payload: providerThread,
          },
        ],
      })
      .pipe(Effect.mapError(asNativeSessionError("Could not create the session's thread.")));
    return { projectId: project.id, threadId };
  });

  /** The session's thread, created on first open and unarchived on reopen. */
  const openThread = Effect.fn("NativeSessionCoordinator.openThread")(function* (
    session: NativeSessionFile,
    instance: NativeInstance,
  ) {
    const existing = yield* findThread(session);
    if (existing !== undefined) {
      if (existing.archivedAt !== null) {
        yield* dispatch({
          type: "thread.unarchive",
          commandId: yield* newCommandId,
          threadId: existing.id,
        });
      }
      return { projectId: existing.projectId, threadId: existing.id };
    }
    for (const threadId of nativeThreadIds(session)) {
      const recorded = yield* Effect.option(threadManagement.getThreadRecords(threadId, []));
      if (Option.isNone(recorded)) return yield* createThread(session, instance, threadId);
    }
    return yield* new ProviderNativeSessionError({
      code: "invalid",
      message: `The thread for native session '${session.summary.sessionId}' was deleted. Continue the session natively, then open it again.`,
    });
  });

  const list: NativeSessionCoordinatorShape["list"] = (input) =>
    Effect.gen(function* () {
      const instance = yield* resolveInstance(input.providerInstanceId);
      const sessions = yield* Effect.tryPromise(() =>
        listNativeSessionFiles(instance.location, input.providerInstanceId),
      ).pipe(Effect.mapError(asNativeSessionError("Could not read native sessions.")));
      return { sessions: sessions.map((session) => session.summary) };
    });

  const open: NativeSessionCoordinatorShape["open"] = (input) =>
    Effect.gen(function* () {
      const { instance, session } = yield* findSession(input.providerInstanceId, input.sessionId);
      return yield* openThread(session, instance);
    }).pipe(mutations.withPermits(1));

  const rename: NativeSessionCoordinatorShape["rename"] = (input) =>
    Effect.gen(function* () {
      const { instance, session } = yield* findSession(input.providerInstanceId, input.sessionId);
      const entryId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie))
        .replaceAll("-", "")
        .slice(0, 8);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.tryPromise(() =>
        writeNativeSessionTitle({
          filePath: session.filePath,
          runtime: instance.location.runtime,
          title: input.name,
          updatedAt,
          entryId,
        }),
      ).pipe(Effect.mapError(asNativeSessionError("Could not rename the native session.")));
      // A loaded session also takes the thread title as its native name on
      // its next turn, so the two stay in step.
      const shell = yield* findThread(session);
      if (shell !== undefined && shell.title !== input.name) {
        yield* dispatch({
          type: "thread.metadata.update",
          commandId: yield* newCommandId,
          threadId: shell.id,
          title: input.name,
        });
      }
      return { sessionId: input.sessionId, title: input.name };
    }).pipe(mutations.withPermits(1));

  const fork: NativeSessionCoordinatorShape["fork"] = (input) =>
    Effect.gen(function* () {
      const { instance, session } = yield* findSession(input.providerInstanceId, input.sessionId);
      // The CLI fork writes the copy in the runtime's own format under the
      // session's cwd. This process never prompts or loads user extensions.
      const launch = buildPiRpcLaunch({
        launchArgs: instance.launchArgs,
        environment: instance.environment,
        mcpSession: undefined,
        extensionPath: undefined,
        disableExtensions: true,
        disableTools: true,
      });
      const forkedFile = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makePiRpcConnection({
            command: instance.binary,
            args: [...launch.args, "--fork", session.filePath],
            cwd: session.summary.cwd,
            env: launch.env,
            dialect: instance.dialect,
          });
          yield* Stream.fromQueue(connection.events).pipe(
            Stream.runDrain,
            Effect.ignore,
            Effect.forkScoped,
          );
          const state = yield* connection.request({ type: "get_state" });
          const sessionFile =
            typeof state === "object" && state !== null && "sessionFile" in state
              ? state.sessionFile
              : undefined;
          return typeof sessionFile === "string" && sessionFile !== session.filePath
            ? sessionFile
            : undefined;
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(asNativeSessionError("Could not fork the native session.")),
      );
      const forked =
        forkedFile === undefined
          ? undefined
          : yield* Effect.tryPromise(() =>
              readNativeSessionFile(
                forkedFile,
                input.providerInstanceId,
                instance.location.runtime,
              ),
            ).pipe(Effect.mapError(asNativeSessionError("Could not read the forked session.")));
      if (forked === undefined) {
        return yield* new ProviderNativeSessionError({
          code: "native",
          message: `${instance.dialect.displayName} did not create a distinct forked session.`,
        });
      }
      const opened = yield* openThread(forked, instance);
      return { sessionId: forked.summary.sessionId, ...opened };
    }).pipe(mutations.withPermits(1));

  const stop: NativeSessionCoordinatorShape["stop"] = (input) =>
    Effect.gen(function* () {
      const { session } = yield* findSession(input.providerInstanceId, input.sessionId);
      const shell = yield* findThread(session);
      if (shell === undefined) return {};
      yield* threadManagement
        .interruptThread({
          projectId: shell.projectId,
          commandId: yield* newCommandId,
          threadId: shell.id,
          reason: "Stopped from native sessions",
        })
        .pipe(Effect.mapError(asNativeSessionError("Could not stop the session.")));
      return { threadId: shell.id };
    });

  const archive: NativeSessionCoordinatorShape["archive"] = (input) =>
    Effect.gen(function* () {
      const { instance, session } = yield* findSession(input.providerInstanceId, input.sessionId);
      const existing = yield* findThread(session);
      if (existing?.archivedAt != null) return { threadId: existing.id };
      if (existing !== undefined && existing.activeRunId !== null) {
        return yield* new ProviderNativeSessionError({
          code: "invalid",
          message: "This native session is working. Stop it before you archive it.",
        });
      }
      const threadId = existing?.id ?? (yield* openThread(session, instance)).threadId;
      yield* dispatch({ type: "thread.archive", commandId: yield* newCommandId, threadId });
      return { threadId };
    }).pipe(mutations.withPermits(1));

  /** OMP only: Pi has no model roles. Instance errors keep their meaning as role errors. */
  const resolveModelRoleAgentDir = (providerInstanceId: ProviderInstanceId) =>
    resolveInstance(providerInstanceId).pipe(
      Effect.mapError(
        (error) =>
          new ProviderModelRoleError({
            code:
              error.code === "not_found" ? "unknown" : error.code === "native" ? "io" : error.code,
            message: error.message,
          }),
      ),
      Effect.flatMap((instance) =>
        instance.dialect === OMP_DIALECT
          ? Effect.succeed(resolveNativeAgentDirectory(instance.location))
          : Effect.fail(
              new ProviderModelRoleError({
                code: "unsupported",
                message: `${instance.dialect.displayName} does not support model roles.`,
              }),
            ),
      ),
    );

  const asModelRoleError = (cause: unknown): ProviderModelRoleError =>
    isModelRoleError(cause)
      ? cause
      : new ProviderModelRoleError({
          code: "io",
          message: cause instanceof Error ? cause.message : "Model role config failed.",
        });

  /** Role bindings plus OMP's own usage history, which biases the picker's MRU order. */
  const roleResult = (
    providerInstanceId: ProviderInstanceId,
    run: (agentDir: string) => Promise<ModelRolesSnapshot>,
  ) =>
    Effect.gen(function* () {
      const agentDir = yield* resolveModelRoleAgentDir(providerInstanceId);
      const snapshot = yield* Effect.tryPromise({
        try: () => run(agentDir),
        catch: asModelRoleError,
      });
      const recentModels = yield* Effect.promise(() => readRecentModels(agentDir));
      return {
        providerInstanceId,
        configPath: snapshot.configPath,
        roles: snapshot.roles,
        recentModels,
      } satisfies ProviderModelRolesResult;
    });

  const modelRoles: NativeSessionCoordinatorShape["modelRoles"] = (input) =>
    roleResult(input.providerInstanceId, readModelRoles);

  const setModelRole: NativeSessionCoordinatorShape["setModelRole"] = (input) =>
    roleResult(input.providerInstanceId, (agentDir) =>
      writeModelRole(agentDir, input.role, input.model, input.thinkingLevel),
    );

  return {
    list,
    open,
    rename,
    fork,
    stop,
    archive,
    modelRoles,
    setModelRole,
  } satisfies NativeSessionCoordinatorShape;
});

/**
 * Callers gate the mutating operations on server startup; they write thread
 * events and must not run before the projections are ready.
 */
export class NativeSessionCoordinator extends Context.Service<
  NativeSessionCoordinator,
  NativeSessionCoordinatorShape
>()("t3/provider/NativeSessionCoordinator") {}

export const layer = Layer.effect(NativeSessionCoordinator, make);
