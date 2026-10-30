// @vitest-environment jsdom

import { cloneElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  subagents: [] as ReadonlyArray<unknown>,
  turnItems: [] as ReadonlyArray<unknown>,
  emptyOverlay: { subagentContentByTurnItemId: new Map<never, never>(), mode: null },
  interruptCommand: {},
  stopWorkflowCommand: { permissionAtom: () => null },
  interrupt: vi.fn().mockResolvedValue({ _tag: "Success" }),
  stopWorkflow: vi.fn().mockResolvedValue({ _tag: "Success" }),
  openChange: null as ((open: boolean) => void) | null,
  loaderMounts: 0,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (_atom: unknown, select?: (thread: unknown) => unknown) =>
    select
      ? select({ projection: { subagents: state.subagents } })
      : state.emptyOverlay,
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => null },
  threadEnvironment: { interruptTurn: state.interruptCommand },
}));
vi.mock("../../state/entities", () => ({ useThreadVisibleTurnItems: () => state.turnItems }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { v2: { stopWorkflow: state.stopWorkflowCommand } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.interruptCommand ? state.interrupt : state.stopWorkflow,
}));
vi.mock("~/lib/motion", () => ({
  useChangedSinceMount: () => false,
  usePresence: (shown: boolean) => ({ mounted: true, shown }),
  usePresentList: (items: ReadonlyArray<unknown>, keyOf: (item: unknown) => string) =>
    items.map((item) => ({ item, key: keyOf(item), exiting: false })),
  useSmoothHeight: () => ({ outerRef: null, contentRef: null }),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    readonly children: ReactNode;
    readonly onOpenChange: (open: boolean) => void;
  }) => {
    state.openChange = onOpenChange;
    return children;
  },
  PopoverTrigger: ({
    render,
    children,
  }: {
    readonly render: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
    readonly children: ReactNode;
  }) =>
    cloneElement(render, { onClick: () => state.openChange?.(true) }, children),
  PopoverPopup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/ui/ascii-loader", async () => {
  // vi.mock factories are hoisted above the static imports, so React loads here.
  const { useEffect } = await import("react");
  return {
    AsciiLoader: () => {
      useEffect(() => {
        state.loaderMounts += 1;
      }, []);
      return <span data-ascii-loader />;
    },
  };
});

import { ComposerWorkingHub } from "./ComposerTasksBadge";

let renderer: ReactTestRenderer | undefined;

function activityText(): string {
  const text = (node: ReactTestInstance | string): string =>
    typeof node === "string" ? node : node.children.map(text).join("");
  return text(renderer!.root.findByProps({ "data-composer-hub-activity": "true" }));
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.subagents = [];
  state.turnItems = [];
  state.interrupt.mockClear();
  state.stopWorkflow.mockClear();
  state.openChange = null;
  state.loaderMounts = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("stops unique child threads and supported native workflows from the hub", async () => {
  state.subagents = [
    {
      id: "task:child-a:first",
      threadId: "parent",
      childThreadId: "child-a",
      origin: "app_owned",
      driver: "codex",
      title: "First child task",
      status: "running",
    },
    {
      id: "task:child-a:followup",
      threadId: "parent",
      childThreadId: "child-a",
      origin: "app_owned",
      driver: "codex",
      title: "Follow-up child task",
      status: "running",
    },
    {
      id: "task:child-b",
      threadId: "parent",
      childThreadId: "child-b",
      origin: "app_owned",
      driver: "codex",
      title: "Other child task",
      status: "running",
    },
    {
      id: "workflow:claude",
      threadId: "parent",
      childThreadId: "synthetic-claude-workflow",
      origin: "provider_native",
      driver: "claudeAgent",
      title: "Claude workflow",
      status: "running",
      workflow: { phases: [], agents: [] },
    },
    {
      id: "workflow:omp",
      threadId: "parent",
      childThreadId: "synthetic-omp-workflow",
      driver: "omp",
      title: "OMP workflow",
      status: "running",
      workflow: { phases: [], agents: [] },
    },
  ];

  await act(async () => {
    renderer = create(
      <ComposerWorkingHub
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });

  expect(
    renderer!.root.findByProps({ "data-composer-working-label": "true" }).children.join(""),
  ).toBe("Waiting on 5 agents");
  const stopAll = renderer!.root.findByProps({ "data-composer-hub-stop-all": "true" });
  await act(async () => stopAll.props.onClick());

  expect(state.interrupt).toHaveBeenCalledTimes(2);
  expect(state.interrupt).toHaveBeenNthCalledWith(1, {
    environmentId: "test",
    input: { threadId: "child-a" },
  });
  expect(state.interrupt).toHaveBeenNthCalledWith(2, {
    environmentId: "test",
    input: { threadId: "child-b" },
  });
  expect(state.stopWorkflow).toHaveBeenCalledTimes(1);
  expect(state.stopWorkflow).toHaveBeenCalledWith({
    environmentId: "test",
    input: { threadId: "parent", subagentId: "workflow:claude" },
  });
});

it("shows one waiting bump with elapsed time and stops the agent from its panel", async () => {
  const startedAt = DateTime.makeUnsafe(new Date(Date.now() - 12_000).toISOString());
  state.subagents = [
    {
      id: "task:child-a",
      threadId: "parent",
      childThreadId: "child-a",
      origin: "app_owned",
      driver: "codex",
      title: "Codex / GPT 6.1 Sol",
      status: "running",
      startedAt,
      completedAt: null,
    },
  ];

  await act(async () => {
    renderer = create(
      <ComposerWorkingHub
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });

  const label = renderer!.root.findByProps({ "data-composer-working-label": "true" });
  expect(label.children.join("")).toBe("Waiting on Codex / GPT 6.1 Sol");
  expect(
    renderer!.root.findAll(
      (node) => node.type === "button" && node.props["data-composer-status-bump"] === "working",
    ),
  ).toHaveLength(1);
  expect(renderer!.root.findAllByProps({ "data-composer-hub-elapsed": "true" })).toHaveLength(1);
  const trigger = renderer!.root.findByProps({ "data-composer-status-bump": "working" });
  expect(trigger.props["aria-expanded"]).toBe(false);
  await act(async () => trigger.props.onClick());
  expect(
    renderer!.root.findByProps({ "data-composer-status-bump": "working" }).props["aria-expanded"],
  ).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Stop Codex / GPT 6.1 Sol" })).toBeDefined();

  const stop = renderer!.root.findByProps({ "data-composer-hub-stop-all": "true" });
  expect(stop.children).toContain("Stop");
  await act(async () => stop.props.onClick());
  expect(state.interrupt).toHaveBeenCalledWith({
    environmentId: "test",
    input: { threadId: "child-a" },
  });
});

it("holds hub activity through tool gaps and dwell while keeping its loader mounted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
  const first = {
    id: "task:ResponseFinish",
    threadId: "parent",
    childThreadId: null,
    origin: "provider_native",
    driver: "omp",
    title: "ResponseFinish",
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-10-27T11:40:00.000Z"),
    completedAt: null,
    currentTool: { name: "read_file", intent: "Reading the response source" },
  };
  state.subagents = [first];

  await act(async () => {
    renderer = create(
      <ComposerWorkingHub
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });
  // The bump's loader plus the row's loader.
  expect(state.loaderMounts).toBe(2);
  expect(activityText()).toBe("Reading the response source");

  const betweenTools = { ...first, currentTool: null };
  state.subagents = [betweenTools];
  await act(async () => {
    renderer!.update(
      <ComposerWorkingHub
        environmentId={EnvironmentId.make("test-between-tools")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });
  expect(activityText()).toBe("Reading the response source");

  const second = {
    ...betweenTools,
    currentTool: { name: "grep", intent: "Searching the response source" },
  };
  state.subagents = [second];
  await act(async () => {
    renderer!.update(
      <ComposerWorkingHub
        environmentId={EnvironmentId.make("test-second-step")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  const third = {
    ...second,
    currentTool: { name: "open_file", intent: "Opening the configuration" },
  };
  state.subagents = [third];
  await act(async () => {
    renderer!.update(
      <ComposerWorkingHub
        environmentId={EnvironmentId.make("test-third-step")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(999);
  });
  expect(activityText()).toBe("Reading the response source");

  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(activityText()).toBe("Opening the configuration");
  // Step changes swap the text only; neither loader restarts its animation.
  expect(state.loaderMounts).toBe(2);
});

it("previews what an agent is writing between tools instead of Thinking", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
  const agent = {
    id: "task:ResponseFinish",
    threadId: "parent",
    childThreadId: null,
    origin: "provider_native",
    driver: "omp",
    title: "ResponseFinish",
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-10-27T11:40:00.000Z"),
    completedAt: null,
    currentTool: null,
  };
  const writing = (text: string) => [
    {
      item: {
        type: "subagent",
        subagentId: agent.id,
        liveContent: { kind: "assistant", text, truncated: false },
      },
    },
  ];
  state.subagents = [agent];
  state.turnItems = writing("Read the parser.\n\nThe response type comes from **two** places");
  const render = async (environmentId: string) => {
    await act(async () => {
      const hub = (
        <ComposerWorkingHub
          environmentId={EnvironmentId.make(environmentId)}
          threadId={ThreadId.make("parent")}
        />
      );
      if (renderer) renderer.update(hub);
      else renderer = create(hub);
    });
  };

  await render("test");
  expect(activityText()).toBe("The response type comes from two places");

  state.turnItems = writing(
    "Read the parser.\n\nThe response type comes from two places, so both need the field",
  );
  await render("test-more-words");
  // The line holds its words for the dwell, then rolls on to the newer ones.
  expect(activityText()).toBe("The response type comes from two places");
  await act(async () => {
    vi.advanceTimersByTime(1_500);
  });
  expect(activityText()).toBe("The response type comes from two places, so both need the field");
});
