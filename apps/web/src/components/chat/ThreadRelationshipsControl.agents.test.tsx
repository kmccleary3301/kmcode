import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type OrchestrationV2ContextTransfer,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: state.projection }),
  useThreadShells: () => state.shells,
  useProjects: () => state.projects,
  useServerConfigs: () => state.configs,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../../hooks/useSubagentLiveContent", () => ({
  useSubagentLiveContent: (
    _threadRef: unknown,
    input: { readonly persisted?: unknown },
  ) => ({ liveContent: input.persisted ?? null, rateLimited: false }),
  LiveViewPausedNote: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => (state.showTooltips ? children : null),
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

let renderer: ReactTestRenderer;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.shells = [];
  state.projects = [];
  state.configs.clear();
  state.showTooltips = false;
  state.command.mockClear();
  state.projection = null;
});

it.each(["codex", "claudeAgent"])(
  "stops only active app-owned %s subagents without opening their thread",
  async (driver) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const parent = {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    };
    const child = {
      id: "child",
      title: "Worker",
      status: "running",
      activityRunStatus: "running",
      activeRunId: RunId.make("child-run"),
      activityRunStartedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      activityRunWorkCompletedAt: null,
      lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    };
    const agent = {
      id: "agent",
      childThreadId: "child",
      origin: "app_owned",
      driver,
      providerInstanceId: "codex",
      title: "Worker",
      prompt: "Check the change",
      model: "gpt-5.4",
      status: "running",
      progress: null,
      result: null,
      startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    };
    state.shells = [{ environmentId: "test", source: child }];
    const projection = {
      thread: parent,
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
      subagents: [agent],
    };
    state.projection = projection;
    const panel = (
      <ThreadRelationshipsPanel
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make("parent")}
      />
    );
    await act(async () => {
      renderer = create(panel);
    });
    const stopButton = () => renderer.root.findByProps({ "aria-label": "Stop subagent Worker" });
    await act(async () => stopButton().props.onClick());
    expect(state.command).toHaveBeenCalledWith({
      environmentId: "test",
      input: { threadId: "child" },
    });
    expect(state.navigate).not.toHaveBeenCalled();

    for (const status of ["starting", "running", "waiting"] as const) {
      state.command.mockClear();
      state.shells = [
        {
          environmentId: "test",
          source: {
            ...child,
            activityRunStatus: status,
            activityRunStartedAt: DateTime.makeUnsafe("2026-09-16T12:05:00Z"),
          },
        },
      ];
      state.projection = {
        ...projection,
        subagents: [{ ...agent, origin: "provider_native", status: "completed" }],
      };
      await act(async () => renderer.update(cloneElement(panel)));
      expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(
        0,
      );
      state.projection = { ...projection, subagents: [{ ...agent, status: "completed" }] };
      await act(async () => renderer.update(cloneElement(panel)));
      await act(async () => stopButton().props.onClick());
      expect(state.command).toHaveBeenCalledTimes(1);
      expect(state.command).toHaveBeenLastCalledWith({
        environmentId: "test",
        input: { threadId: "child" },
      });
    }
    state.shells = [
      {
        environmentId: "test",
        source: {
          ...child,
          activeRunId: null,
          activityRunWorkCompletedAt: DateTime.makeUnsafe("2026-09-16T12:02:00Z"),
        },
      },
    ];
    for (const status of ["completed", "failed", "interrupted"]) {
      state.projection = { ...projection, subagents: [{ ...agent, status }] };
      await act(async () => renderer.update(cloneElement(panel)));
      expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(
        0,
      );
    }
    state.shells = [
      {
        environmentId: "test",
        source: { ...child, activityRunStartedAt: null },
      },
    ];
    state.projection = { ...projection, subagents: [{ ...agent, startedAt: null }] };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === "button" && node.props["aria-label"] === "Stop subagent Worker",
      ),
    ).toHaveLength(1);
    state.projection = {
      ...projection,
      subagents: [{ ...agent, origin: "provider_native", driver: "claudeAgent" }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(0);
  },
);

it("stops Claude-native workflows by task identity without interrupting the parent thread", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.command.mockClear();
  state.navigate.mockClear();
  const parent = {
    id: "parent",
    lineage: { relationshipToParent: null },
    activeProviderThreadId: null,
  };
  const workflowTask = {
    id: "workflow:claude",
    threadId: "parent",
    childThreadId: "synthetic-claude-workflow",
    origin: "provider_native",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    title: "Claude workflow",
    prompt: "Coordinate the task",
    model: null,
    status: "running",
    progress: null,
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    workflow: { phases: [], agents: [] },
  };
  const syntheticWorkflowThread = {
    id: "synthetic-claude-workflow",
    title: "Claude workflow",
    status: "running",
    activityRunStatus: null,
    activeRunId: null,
    activityRunStartedAt: null,
    activityRunWorkCompletedAt: null,
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  state.shells = [{ environmentId: "test", source: syntheticWorkflowThread }];
  const projection = {
    thread: parent,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [workflowTask],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });

  const stopButton = () =>
    renderer.root.findByProps({ "aria-label": "Stop workflow Claude workflow" });
  await act(async () => stopButton().props.onClick());
  expect(state.command).toHaveBeenCalledWith({
    environmentId: "test",
    input: { threadId: "parent", subagentId: "workflow:claude" },
  });
  expect(state.navigate).not.toHaveBeenCalled();

  state.command.mockClear();
  state.projection = {
    ...projection,
    subagents: [
      {
        ...workflowTask,
        id: "workflow:omp",
        childThreadId: "synthetic-omp-workflow",
        driver: "omp",
      },
    ],
  };
  state.shells = [
    {
      environmentId: "test",
      source: { ...syntheticWorkflowThread, id: "synthetic-omp-workflow" },
    },
  ];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(
    renderer.root.findAllByProps({ "aria-label": "Stop workflow Claude workflow" }),
  ).toHaveLength(0);
  expect(state.command).not.toHaveBeenCalled();
});

it("shows the matching child agent details and refreshes them when the agent settles", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const agent = {
    id: "agent-1",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: "child-1",
    title: "Checker",
    prompt: "Check the change",
    model: "gpt-5.4",
    status: "running",
    progress: "Running checks",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  };
  const projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      { ...agent, id: "unlinked", childThreadId: null, title: "Unlinked agent" },
      agent,
      { ...agent, id: "agent-2", childThreadId: "child-2", title: "Worker", model: "gpt-5.3" },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ")
      .replace(/\s+/g, " ");
  expect(text()).toContain("Checker");
  expect(text()).toContain("Lineage · 3 running");
  expect(text()).toContain("running");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("gpt-5.3");
  expect(text()).not.toContain("tok");
  expect(text()).not.toContain("Unlinked agent");
  expect(text()).not.toContain("Active agents");
  expect(renderer.root.findAllByProps({ type: "button", "aria-expanded": true })).toHaveLength(0);

  state.projection = {
    ...projection,
    subagents: [
      {
        ...agent,
        status: "completed",
        progress: undefined,
        result: "All checks passed",
        completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
      },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage"]);
  expect(text()).toContain("Previous agents (1)");
  expect(text()).not.toContain("Checker");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Checker");
  // A started agent's row shows only its compact time; the icon carries the status.
  expect(text()).toContain("Checker 2m");
  expect(text()).not.toContain("(1)");
  expect(text()).not.toContain("Done");
  expect(text()).not.toContain("running");
  expect(text()).not.toContain("Worker");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": true }).props.onClick(),
  );
  expect(text()).not.toContain("Checker");
  expect(text()).toContain("Previous agents (1)");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Checker");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `running-agent-${index}`,
      childThreadId: `running-child-${index}`,
    })),
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Lineage · 8 running");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `old-agent-${index}`,
      childThreadId: `old-child-${index}`,
      status: index === 7 ? "failed" : "completed",
      title: `Old agent ${index}`,
      result: index === 7 ? "Earlier build failed" : "Done",
      completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
    })),
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("1 failed");
  expect(text()).not.toContain("Old agent 7");
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Show "))!
      .props.onClick(),
  );
  expect(text()).toContain("Old agent 7");

  state.projection = {
    ...projection,
    subagents: [{ ...agent, childThreadId: null }],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Lineage · 1 running");
});

it("keeps a completed child activation settled until a newer shell activation begins", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.showTooltips = true;
  const environmentId = EnvironmentId.make("test");
  const startedAt = DateTime.makeUnsafe("2026-09-16T12:00:00Z");
  const completedAt = DateTime.makeUnsafe("2026-09-16T12:02:15Z");
  const child = {
    id: "child",
    title: "Checker",
    status: "running",
    activityRunStatus: "running",
    activeRunId: null,
    activityRunStartedAt: startedAt,
    activityRunWorkCompletedAt: completedAt,
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  const agent = {
    id: "agent",
    childThreadId: "child",
    origin: "app_owned",
    driver: "codex",
    providerInstanceId: "codex",
    title: "Checker",
    prompt: "Check the change",
    model: "gpt-5.4",
    status: "completed",
    progress: null,
    result: "Checks passed",
    startedAt,
    completedAt,
    updatedAt: completedAt,
  };
  state.shells = [{ environmentId, source: child }];
  state.projection = {
    thread: {
      id: "parent",
      lineage: { parentThreadId: null, relationshipToParent: null },
      activeProviderThreadId: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [agent],
  };
  const panel = (
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={ThreadId.make("parent")} />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = () => {
    const read = (node: ReactTestInstance | string): string => {
      if (typeof node === "string") return node;
      return node.children.map(read).join("");
    };
    return read(renderer.root);
  };
  const stopButtons = () =>
    renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Stop subagent Checker",
    );
  expect(stopButtons()).toHaveLength(0);
  const collapsedGroup = renderer.root.findAllByProps({ type: "button", "aria-expanded": false })[0];
  if (collapsedGroup) await act(async () => collapsedGroup.props.onClick());
  expect(stopButtons()).toHaveLength(0);
  expect(text()).toContain("completed");
  expect(text()).toContain("Checks passed");
  expect(text()).toContain("2m 15s");

  state.shells = [
    {
      environmentId,
      source: {
        ...child,
        activeRunId: "child-follow-up",
        activityRunStartedAt: DateTime.makeUnsafe("2026-09-16T12:03:00Z"),
        activityRunWorkCompletedAt: null,
      },
    },
  ];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(stopButtons().length).toBeGreaterThan(0);
  expect(text()).not.toContain("2m 15s");
  expect(text()).toContain("running");
  expect(text()).not.toContain("Checks passed");
});

it("shows readable models and only differing workspace details in agent tooltips", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.showTooltips = true;
  const parent = {
    id: "parent",
    projectId: "main",
    worktreePath: null,
    lineage: {},
    activeProviderThreadId: null,
  };
  const child = {
    id: "child",
    projectId: "main",
    worktreePath: null as string | null,
    branch: null as string | null,
    title: "Worker",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }] as ModelSelection["options"],
    },
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  state.projects = [
    { id: "main", environmentId: "test", title: "Main", workspaceRoot: "/main" },
    {
      id: "other",
      environmentId: "elsewhere",
      title: "Wrong environment",
      workspaceRoot: "/wrong",
    },
    { id: "other", environmentId: "test", title: "Other project", workspaceRoot: "/other" },
  ];
  state.shells = [{ environmentId: "test", source: child }];
  state.configs.set("test", {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        models: [
          { slug: "gpt-5.4", name: "My GPT model", shortName: "My GPT", aliases: ["model-alias"] },
        ],
      },
    ],
  });
  const projection = {
    thread: parent,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "agent",
        childThreadId: "child",
        origin: "app_owned",
        driver: "codex",
        providerInstanceId: "codex",
        title: "Worker",
        prompt: "Check",
        model: "gpt-5.4",
        status: "pending",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = (visibleOnly = false) => {
    const read = (node: ReactTestInstance | string): string => {
      if (typeof node === "string") return node;
      if (visibleOnly && node.props.className === "sr-only") return "";
      return node.children.map(read).join("");
    };
    return read(renderer.root);
  };
  expect(text()).toContain("My GPT · high");
  state.projection = {
    ...projection,
    subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("My GPT");
  expect(text()).not.toContain("My GPT · high");
  state.projection = projection;
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).not.toContain("Tokens");
  expect(text()).not.toContain("Open subagent");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("Workspace");

  for (const [model, expected] of [
    [null, "Not reported"],
    ["", "Not reported"],
    ["   ", "Not reported"],
    ["model-alias", "My GPT"],
    ["gpt-5.5", "GPT-5.5"],
    ["custom/model-v1", "custom/model-v1"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain(expected);
    if (!model?.trim() || model === "gpt-5.5" || model === "custom/model-v1") {
      expect(text()).not.toContain(" · high");
    } else {
      expect(text()).toContain(`${expected} · high`);
    }
    expect(text()).not.toContain("Unknown");
    if (!model?.trim()) expect(text()).not.toContain("My GPT");
  }

  for (const driver of [
    "codex",
    "claudeAgent",
    "cursor",
    "opencode",
    "grok",
    "antigravity",
    "pi",
    "acpRegistry",
  ]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model: null }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain("Not reported");
    expect(text()).not.toContain("My GPT");
  }

  state.projection = projection;
  for (const [options, expected] of [
    [[{ id: "effort", value: "max" }], " · max"],
    [[{ id: "reasoning", value: "low" }], " · low"],
    [[{ id: "variant", value: "high" }], " · high"],
    [[{ id: "reasoningEffort", value: "none" }], " · none"],
    [[{ id: "reasoningEffort", value: true }], ""],
    [[{ id: "serviceTier", value: "fast" }], ""],
    [[], ""],
    [undefined, ""],
  ] as const) {
    child.modelSelection.options = options;
    state.shells = [{ environmentId: "test", source: { ...child } }];
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain(`My GPT${expected}`);
    if (!expected) expect(text()).not.toContain("My GPT ·");
  }
  const speedConfig = state.configs.get("test");
  const serviceTier: ProviderOptionDescriptor = {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    currentValue: "priority",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
  };
  const fastMode: ProviderOptionDescriptor = {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
    currentValue: true,
  };
  for (const [driver, descriptor, value, iconLabel] of [
    ["codex", serviceTier, "default", ""],
    ["codex", serviceTier, "priority", "Fast mode on"],
    ["codex", serviceTier, "ultrafast", "Ultrafast mode on"],
    ["codex", serviceTier, "flex", ""],
    ["codex", serviceTier, "unknown", ""],
    [
      "codex",
      { ...serviceTier, options: serviceTier.options.filter(({ id }) => id !== "ultrafast") },
      "ultrafast",
      "",
    ],
    ["codex", serviceTier, true, ""],
    ["codex", serviceTier, undefined, ""],
    ["claudeAgent", fastMode, true, "Fast mode on"],
    ["claudeAgent", fastMode, false, ""],
    ["cursor", fastMode, true, "Fast mode on"],
    ["cursor", fastMode, false, ""],
    ["opencode", fastMode, true, "Fast mode on"],
    ["cursor", fastMode, "true", ""],
    ["cursor", serviceTier, "priority", ""],
  ] as const) {
    state.configs.set("test", {
      providers: [
        {
          instanceId: "codex",
          driver,
          models: [
            {
              slug: "gpt-5.4",
              name: "My GPT",
              capabilities: { optionDescriptors: [descriptor] },
            },
          ],
        },
      ],
    });
    child.modelSelection.options = [
      { id: "reasoningEffort", value: "high" },
      ...(value === undefined ? [] : [{ id: descriptor.id, value }]),
    ];
    state.shells = [{ environmentId: "test", source: { ...child } }];
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text(true)).toContain("My GPT · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    expect(text()).toContain(`My GPT · ${iconLabel}high`);
    if (!iconLabel) expect(text()).not.toContain("mode on");
    child.modelSelection.options = child.modelSelection.options.filter(
      ({ id }) => id !== "reasoningEffort",
    );
    state.shells = [{ environmentId: "test", source: { ...child } }];
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).not.toContain(" · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    if (iconLabel) expect(text()).toContain(iconLabel);
    else expect(text()).not.toContain("mode on");
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
    state.projection = projection;
    for (const modelSelection of [
      { ...child.modelSelection, instanceId: "other" },
      { ...child.modelSelection, model: "gpt-5.5" },
    ]) {
      state.shells = [{ environmentId: "test", source: { ...child, modelSelection } }];
      await act(async () => renderer.update(cloneElement(panel)));
      expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
    }
  }
  state.configs.set("test", {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Work account",
        models: [
          {
            slug: "gpt-5.4",
            name: "My GPT",
            capabilities: { optionDescriptors: [serviceTier] },
          },
        ],
      },
      {
        instanceId: "codex_personal",
        driver: "codex",
        displayName: "Personal account",
        models: [],
      },
    ],
  });
  child.modelSelection.options = [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ];
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text(true)).toContain("My GPT · Work account · high");
  expect(text()).toContain("My GPT · Work account · Fast mode onhigh");
  expect(text()).not.toContain("Personal account");
  state.configs.set("test", speedConfig);
  child.modelSelection.options = [{ id: "reasoningEffort", value: "high" }];
  state.shells = [
    {
      environmentId: "test",
      source: { ...child, modelSelection: { ...child.modelSelection, instanceId: "other" } },
    },
  ];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).not.toContain("My GPT ·");
  const config = state.configs.get("test");
  state.configs.clear();
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4 · high");
  state.configs.set("test", config);
  for (const model of ["custom/model-v1", "custom/model-v2"]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    state.shells = [
      {
        environmentId: "test",
        source: { ...child, modelSelection: { ...child.modelSelection, model: "custom/model-v1" } },
      },
    ];
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text().includes(`${model} · high`)).toBe(model === "custom/model-v1");
  }

  state.projection = {
    ...projection,
    subagents: [
      {
        ...projection.subagents[0],
        progress: "Checking the latest changes",
        result: "Old intermediate result",
      },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Checking the latest changes");
  expect(text()).not.toContain("Old intermediate result");
  const result = "Final checks passed. " + "More detail. ".repeat(50) + "Hidden tail";
  state.projection = {
    ...projection,
    subagents: [
      { ...projection.subagents[0], status: "failed", progress: "Stale progress", result },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Final checks passed.");
  expect(text()).not.toContain("Stale progress");
  expect(text()).not.toContain("Hidden tail");
  expect(text()).not.toContain(result);
  state.projection = projection;

  child.worktreePath = "/main/worktrees/checker";
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Worktree");
  expect(text()).toContain("checker");
  expect(text()).not.toContain("/main/worktrees");
  expect(text()).not.toContain("Project");

  child.branch = "fix/checker";
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Branch");
  expect(text()).toContain("fix/checker");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("/main/worktrees");

  child.projectId = "other";
  child.worktreePath = null;
  child.branch = null;
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Other project");
  expect(text()).toContain("Workspace");
  expect(text()).toContain("other");
  expect(text()).not.toContain("/other");
  expect(text()).not.toContain("Wrong environment");
  expect(text()).not.toContain("Worktree");

  state.shells = [];
  state.configs.clear();
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Workspace");

  for (const [driver, model, expected] of [
    ["codex", "gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
    ["codex", "custom/model-v2", "custom/model-v2"],
    ["claudeAgent", "gpt-5.4", "GPT-5.4"],
    ["claudeAgent", "claude-opus-4-6", "Claude Opus 4.6"],
    ["cursor", "composer-2", "Composer 2"],
    ["grok", "grok-4-fast", "Grok 4 Fast"],
    ["antigravity", "gemini-3.8-flash-high", "Gemini 3.8 Flash High"],
    ["opencode", "anthropic/claude-sonnet-4-6", "anthropic/Claude Sonnet 4.6"],
    ["codex", null, "Not reported"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain(expected);
  }
});

it("shows the parent's own visible status as parent and child activity change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("test");
  const parent = {
    id: "parent",
    title: "Parent conversation",
    status: "completed",
    activityRunStatus: "running",
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const child = {
    id: "child",
    title: "Current fork",
    status: "completed",
    lineage: { parentThreadId: "parent", relationshipToParent: "fork" },
  };
  state.projection = {
    thread: { ...child, activeProviderThreadId: null },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  const shells = (parentSource: typeof parent, childSource: typeof child) => [
    { environmentId, source: parentSource },
    { environmentId, source: childSource },
  ];
  state.shells = shells(parent, child);
  const panel = (
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={ThreadId.make("child")} />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const visibleText = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string" && node.props.className !== "sr-only")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ");
  expect(visibleText()).toContain("Parent conversation");
  expect(visibleText()).toContain("Running");
  state.shells = shells(
    { ...parent, activityRunStatus: "completed" },
    { ...child, status: "running" },
  );
  await act(async () => renderer.update(cloneElement(panel)));
  expect(visibleText()).toContain("Done");
  expect(visibleText()).not.toContain("Running");
});

it.each(["source", "target"])(
  "shows transfer lifecycle states when viewing the %s thread",
  async (currentThreadId) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("test");
    const threads = ["source", "target"].map((id) => ({
      id,
      title: `${id} conversation`,
      status: "running",
      activityRunStatus: "running",
      lineage: { parentThreadId: null, relationshipToParent: null },
    }));
    state.shells = threads.map((source) => ({ environmentId, source }));
    const labels: Record<OrchestrationV2ContextTransfer["status"], string> = {
      pending: "Queued",
      resolved_native: "Resolved (native)",
      resolved_portable: "Resolved (portable)",
      failed: "Failed",
      consumed: "Consumed",
      superseded: "Superseded",
    };
    const panel = (
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={ThreadId.make(currentThreadId)}
      />
    );
    for (const [status, label] of Object.entries(labels)) {
      state.projection = {
        thread: {
          ...threads.find((thread) => thread.id === currentThreadId),
          activeProviderThreadId: null,
        },
        runs: [],
        providerThreads: [],
        providerSessions: [],
        subagents: [],
        contextTransfers: [{ sourceThreadId: "source", targetThreadId: "target", status }],
      };
      await act(async () => {
        if (status === "pending") renderer = create(panel);
        else renderer.update(cloneElement(panel));
      });
      const visibleText = renderer.root
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join(" ");
      expect(visibleText).toContain(
        currentThreadId === "source" ? "target conversation" : "source conversation",
      );
      expect(visibleText).toContain(label);
      expect(visibleText).not.toContain("Unknown");
      expect(visibleText).not.toContain("Running");
    }
  },
);
