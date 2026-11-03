import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  ThreadId,
  type ServerProvider,
  ProviderDriverKind,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection, title: input.title },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(result.at(-1)?.result).toMatchObject({
      projectId,
      modelSelection,
      link: expect.stringMatching(/^\[Audit\]\(t3-thread:\/\/v1\/environment\//),
    });
    expect(launchedSender).toBe(sourceThreadId);
  }),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: {
                id: input.threadId,
                projectId: input.projectId,
                modelSelection,
                title: input.title,
              },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const result = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
              commitError: "Git has no name or email on this machine.",
            };
          }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);

    // A path still registers that folder, and never makes a named project.
    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    // Fields this mode cannot apply are rejected, not dropped.
    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
);

it.effect("discards a tracked clone when an MCP project delete succeeds", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:clone");
    const sourceThreadId = ThreadId.make("delete-source-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const deletedProject: ProjectRecord = {
      id: projectId,
      title: "Clone",
      workspaceRoot: "/projects/clone",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const deletions: Array<Project.ProjectDeleteInput> = [];
    const discarded: Array<ProjectId> = [];
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        delete: (input) =>
          Effect.sync(() => {
            deletions.push(input);
            return deletedProject;
          }),
      }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
        discard: (id) =>
          Effect.sync(() => {
            discarded.push(id);
          }),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-delete-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_project_delete", { projectId, force: true })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    expect(result.at(-1)?.result).toEqual(deletedProject);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({ projectId, force: true });
    expect(discarded).toEqual([projectId]);
  }),
);
const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly requestNamespace?: string;
  readonly webOrigin?: string;
  readonly providers?: ReadonlyArray<ServerProvider>;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
  const launchedShells = new Map<string, OrchestrationV2ThreadShell>();
  const acceptedLaunches = new Map<string, ThreadLaunch.ThreadLaunchResult>();
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      providers: { codex: { enabled: true } },
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: input.requestNamespace ?? "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
        ...(input.webOrigin === undefined ? {} : { webOrigin: input.webOrigin }),
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(input.providers ?? []),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(launchedShells.get(threadId) ?? null),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (launch) => {
        const accepted = acceptedLaunches.get(launch.commandId);
        if (accepted !== undefined) return Effect.succeed(accepted);
        const threadId = launch.threadId;
        if (threadId === undefined) return Effect.die("launch did not receive a thread id");
        input.launched.push(launch);
        const result = {
          threadId,
          projection: {
            thread: {
              id: threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
              title: launch.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult;
        launchedShells.set(threadId, {
          id: threadId,
          projectId: launch.projectId,
          modelSelection: launch.modelSelection,
          title: launch.title,
          deletedAt: null,
        } as OrchestrationV2ThreadShell);
        acceptedLaunches.set(launch.commandId, result);
        return Effect.succeed(result);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: input.overrideModel === undefined ? modelSelection : null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};
it.effect("uses a caller-scoped clientRequestId to replay a thread launch", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
      webOrigin: "https://box.example.ts.net",
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const request = {
      title: "Audit",
      projectId,
      message: "Review the change",
      clientRequestId: "retry-this-launch",
    };
    const first = yield* handle(request);
    const replay = yield* handle(request);
    expect(first.at(-1)?.result).toMatchObject({
      link: `[Audit](https://box.example.ts.net/environment/${encodeURIComponent(
        launched[0]?.threadId ?? "",
      )})`,
    });
    expect(launched).toHaveLength(1);
    expect(replay.at(-1)?.result).toEqual(first.at(-1)?.result);
    const otherCallerLaunches: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const otherCaller = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched: otherCallerLaunches,
      requestNamespace: "client:other-session",
    });
    const otherToolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(otherCaller.dependencies),
        ),
      ),
    );
    yield* otherToolkit
      .handle("t3_thread_launch", request)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(otherCaller.dependencies));
    expect(otherCallerLaunches[0]?.commandId).not.toBe(launched[0]?.commandId);
  }),
);

it.effect("a client launches with the project default model and mode", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      defaultRuntimeMode: "approval-required",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("approval-required");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("external launch defaults stay within the client's runtime ceiling", () =>
  Effect.gen(function* () {
    const launch = (input: {
      readonly ceiling: RuntimeMode;
      readonly defaultMode: RuntimeMode;
      readonly requestedRuntimeMode?: RuntimeMode;
      readonly overrideModel?: ModelSelection;
    }) =>
      Effect.gen(function* () {
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, dependencies } = clientLaunchHarness({
          runtimeModeCeiling: input.ceiling,
          defaultRuntimeMode: input.defaultMode,
          launched,
          ...(input.overrideModel === undefined ? {} : { overrideModel: input.overrideModel }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", {
            title: "Settings",
            projectId,
            ...(input.requestedRuntimeMode === undefined
              ? {}
              : { runtimeMode: input.requestedRuntimeMode }),
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { launched, result: result.at(-1)?.result };
      });

    const capped = yield* launch({
      ceiling: "auto-accept-edits",
      defaultMode: "full-access",
    });
    expect(capped.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launch({
      ceiling: "full-access",
      defaultMode: "approval-required",
      requestedRuntimeMode: "auto",
    });
    expect(requested.launched[0]?.runtimeMode).toBe("auto");

    const overrideModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-settings",
    };
    const fromSettings = yield* launch({
      ceiling: "full-access",
      defaultMode: "approval-required",
      overrideModel,
    });
    expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);
  }),
);

it.effect(
  "steps an inherited launch mode down to a provider mode and refuses unsupported modes",
  () =>
    Effect.gen(function* () {
      const runLaunch = (
        runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        Effect.gen(function* () {
          const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
          const provider = {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00Z",
            models: [],
            slashCommands: [],
            skills: [],
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          } satisfies ServerProvider;
          const { projectId, dependencies } = clientLaunchHarness({
            runtimeModeCeiling: "auto",
            launched,
            providers: [provider],
          });
          const toolkit = yield* ProjectToolkit.pipe(
            Effect.provide(
              McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
                Layer.provide(dependencies),
              ),
            ),
          );
          const result = yield* toolkit
            .handle("t3_thread_launch", {
              title: "Fix",
              projectId,
              ...(runtimeMode === undefined ? {} : { runtimeMode }),
            })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
          return { launched, result: result.at(-1)?.result };
        });

      const inherited = yield* runLaunch();
      expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

      const unsupported = yield* runLaunch("auto");
      expect(unsupported.result).toMatchObject({ code: "invalid_request" });
      expect(unsupported.launched).toHaveLength(0);

      const offered = yield* runLaunch("approval-required");
      expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
    }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    // A removed worktree stays listed as prunable until `git worktree prune`;
    // whatever directory is later made at its path is not one of the project's.
    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
