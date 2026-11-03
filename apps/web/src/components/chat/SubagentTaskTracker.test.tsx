// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { TranscriptStyle } from "@t3tools/contracts/settings";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  thread: null as unknown,
  threadAtom: null as unknown,
  childItemsAtom: null as unknown,
}));

vi.mock("../../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/threads")>();
  return {
    ...actual,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      threadAtom: () => state.threadAtom,
      visibleTurnItemsAtom: () => state.childItemsAtom,
    },
  };
});

import { SubagentTaskTracker } from "./SubagentTaskTracker";
import { TranscriptStyleCtx } from "./transcriptStyle";

type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }> & {
  readonly nativeAgentId?: string;
  readonly agentType?: string;
  readonly currentTool?: {
    readonly name: string;
    readonly intent?: string;
    readonly argsPreview?: string;
    readonly elapsedMs?: number;
  } | null;
  readonly completionPercent?: number;
  readonly retry?: {
    readonly attempt: number;
    readonly delayMs?: number;
    readonly message?: string;
  } | null;
  readonly liveContent?: {
    readonly kind: "assistant" | "reasoning" | "tool";
    readonly text: string;
    readonly truncated: boolean;
  };
};

function item(id: string, options: Partial<SubagentItem> = {}): SubagentItem {
  const subagentId = NodeId.make(`node:subagent:${id}`);
  return {
    id: TurnItemId.make(`turn-item:subagent:${id}`),
    threadId: ThreadId.make("parent-thread"),
    runId: null,
    nodeId: subagentId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: "Scout",
    startedAt: DateTime.makeUnsafe("2026-10-13T12:00:30.000Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:30.000Z"),
    type: "subagent",
    subagentId,
    origin: "provider_native",
    driver: ProviderDriverKind.make("omp"),
    providerInstanceId: ProviderInstanceId.make("omp"),
    childThreadId: null,
    prompt: `Inspect task ${id}`,
    result: null,
    ...options,
  };
}

function liveAgentFor(member: SubagentItem, overrides: Record<string, unknown> = {}) {
  return {
    id: member.subagentId,
    status: member.status,
    startedAt: member.startedAt,
    completedAt: member.completedAt,
    updatedAt: member.updatedAt,
    title: member.title,
    prompt: member.prompt,
    model: null,
    result: member.result,
    progress: member.progress,
    nativeAgentId: member.nativeAgentId,
    agentType: member.agentType,
    currentTool: member.currentTool,
    completionPercent: member.completionPercent,
    retry: member.retry,
    ...overrides,
  };
}

let registry: AtomRegistry.AtomRegistry;
let threadAtom: Atom.Writable<unknown>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // KM and Minimal roll the header verb: RollingText measures a Range and
  // reads the reduced-motion query, neither of which jsdom has.
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, right: 0, width: 0 }),
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:01:00.000Z"));
  registry = AtomRegistry.make();
  threadAtom = Atom.make<unknown>(null);
  state.threadAtom = threadAtom;
  state.childItemsAtom = Atom.make<unknown>([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  state.thread = null;
  state.threadAtom = null;
  state.childItemsAtom = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

function renderTracker(
  members: ReadonlyArray<SubagentItem>,
  onOpenThread: (threadId: ThreadId) => void,
  options: {
    readonly style?: TranscriptStyle;
    readonly autoExpandedDetailsItemIds?: ReadonlyArray<string>;
  } = {},
) {
  return act(async () => {
    registry.set(threadAtom, state.thread);
    root.render(
      <RegistryContext.Provider value={registry}>
        <TranscriptStyleCtx value={options.style ?? "minimal"}>
          <SubagentTaskTracker
            environmentId={EnvironmentId.make("environment")}
            threadId={ThreadId.make("parent-thread")}
            members={members}
            providerStatuses={[]}
            autoExpandedDetailsItemIds={options.autoExpandedDetailsItemIds}
            expanded
            onExpandedChange={() => {}}
            onOpenThread={onOpenThread}
          />
        </TranscriptStyleCtx>
      </RegistryContext.Provider>,
    );
  });
}

describe("SubagentTaskTracker", () => {
  it("keeps same-name children distinct and resolves live metadata by stable ID", async () => {
    const childThreadId = ThreadId.make("child-thread");
    const first = item("same-name-a", {
      title: "Scout",
      childThreadId,
      prompt: "Inspect parser behavior",
      nativeAgentId: "native-a-snapshot",
      agentType: "snapshot-type",
      currentTool: { name: "old_tool" },
      completionPercent: 10,
      liveContent: { kind: "assistant", text: "Found a parser branch", truncated: false },
    });
    const second = item("same-name-b", {
      status: "pending",
      startedAt: null,
      title: "Scout",
      prompt: "Inspect UI behavior",
      nativeAgentId: "native-b",
      agentType: "reviewer",
    });
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(first, {
            status: "running",
            model: "reported-model",
            progress: "Reading the parser source",
            nativeAgentId: "native-a-live",
            agentType: "explorer",
            currentTool: { name: "read_file", argsPreview: "src/parser.ts", elapsedMs: 850 },
            completionPercent: 42,
            retry: { attempt: 2, delayMs: 1_200, message: "Retrying after rate limit" },
          }),
        ],
      },
    };

    const onOpenThread = vi.fn();
    await renderTracker([first, second], onOpenThread, { style: "terminal" });

    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-subagent-id]"));
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((row) => row.dataset.subagentId === first.subagentId);
    const secondRow = rows.find((row) => row.dataset.subagentId === second.subagentId);
    expect(firstRow?.textContent).toContain("explorer");
    expect(firstRow?.textContent).toContain("Inspect parser behavior");
    expect(secondRow?.textContent).toContain("reviewer");
    expect(secondRow?.textContent).toContain("Inspect UI behavior");
    expect(secondRow?.textContent).toContain("Queued");
    expect(firstRow?.textContent).not.toContain("snapshot-type");
    expect(secondRow?.textContent).not.toContain("native-a-live");
    const openThread = firstRow?.querySelector<HTMLButtonElement>("[data-subagent-open-thread]");
    expect(openThread).not.toBeNull();
    await act(async () => openThread?.click());
    expect(onOpenThread).toHaveBeenCalledWith(childThreadId);

    expect(secondRow?.textContent).toContain("native-b");
    expect(secondRow?.textContent).not.toContain("Completion");
    expect(secondRow?.textContent).not.toContain("Model");
    expect(secondRow?.textContent).not.toContain("Retry");

    expect(firstRow?.textContent).toContain("native-a-live");
    expect(firstRow?.textContent).not.toContain("native-a-snapshot");
    expect(firstRow?.textContent).toContain("read_file");
    expect(firstRow?.textContent).toContain("src/parser.ts");
    expect(firstRow?.textContent).toContain("42%");
    expect(firstRow?.textContent).toContain("Retrying after rate limit");
    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(`[data-subagent-id="${first.subagentId}"]`)?.textContent,
      ).toContain("Found a parser branch");
    });
    expect(firstRow?.textContent).toContain("Found a parser branch");
    expect(firstRow?.textContent).toContain("reported-model");
  });

  it("keeps the OMP task name when live and snapshot titles change", async () => {
    const nativeAgentId = "0-ResponseFinish";
    const child = item("stable-omp-title", {
      title: "Capturing responsive response themes",
      nativeAgentId,
      agentType: "task",
      driver: ProviderDriverKind.make("omp"),
    });
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            title: "task",
            nativeAgentId,
            agentType: "task",
          }),
        ],
      },
    };

    await renderTracker([child], vi.fn());

    expect(container.querySelector(".minimal-agents-header")?.textContent).toContain(
      "ResponseFinish",
    );
    expect(container.querySelector(".minimal-agents-header")?.textContent).not.toContain(
      "Capturing responsive response themes",
    );

    const changedSnapshot = { ...child, title: "A different task description" };
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(changedSnapshot, {
            title: undefined,
            startedAt: DateTime.makeUnsafe("2026-10-13T12:00:45.000Z"),
            nativeAgentId,
            agentType: "task",
          }),
        ],
      },
    };
    await renderTracker([changedSnapshot], vi.fn());

    expect(container.querySelector(".minimal-agents-header")?.textContent).toContain(
      "ResponseFinish",
    );
    expect(container.querySelector(".minimal-agents-header")?.textContent).not.toContain(
      "A different task description",
    );
  });

  it("reads a delegated child thread's running step when it reports no tool", async () => {
    const delegated = item("delegated", {
      title: "Schema reviewer",
      origin: "app_owned",
      childThreadId: ThreadId.make("child-thread"),
    });
    const childItem = (id: string, status: "completed" | "running", command: string) => ({
      sourceItemId: id,
      item: {
        ...item(id),
        id: TurnItemId.make(id),
        threadId: ThreadId.make("child-thread"),
        type: "command_execution",
        status,
        input: command,
      },
    });
    state.childItemsAtom = Atom.make<unknown>([
      childItem("earlier", "completed", "pnpm install"),
      childItem("current", "running", "pnpm test"),
    ]);
    state.thread = { projection: { subagents: [liveAgentFor(delegated)] } };

    await renderTracker([delegated], vi.fn());

    const row = container.querySelector<HTMLElement>("[data-subagent-id]");
    expect(row?.textContent).toContain("pnpm test");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-subagent-details-toggle]")
        ?.click();
    });
    expect(row?.querySelector(".minimal-agent-details")?.textContent).not.toContain("pnpm test");
    expect(row?.textContent).not.toContain("pnpm install");
    expect(row?.textContent).not.toContain("Thinking");
  });

  it("holds the last real activity when the current tool clears", async () => {
    const working = item("activity-hold", {
      currentTool: { name: "read_file", intent: "Reading the response source" },
    });
    await renderTracker([working], vi.fn());

    const row = container.querySelector<HTMLElement>("[data-subagent-id]");
    expect(row?.querySelector(".minimal-agent-activity")?.textContent).toBe(
      "Reading the response source",
    );

    const betweenTools = { ...working, currentTool: null };
    await renderTracker([betweenTools], vi.fn());
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    expect(row?.querySelector(".minimal-agent-activity")?.textContent).toBe(
      "Reading the response source",
    );
    expect(row?.textContent).not.toContain("Thinking");
  });

  it("rate-limits rapid activity changes to a 1.5 second dwell", async () => {
    const first = item("activity-dwell", {
      currentTool: { name: "read_file", intent: "Reading the source" },
    });
    await renderTracker([first], vi.fn());

    const row = container.querySelector<HTMLElement>("[data-subagent-id]");
    const second = {
      ...first,
      currentTool: { name: "search_file", intent: "Searching the source" },
    };
    await renderTracker([second], vi.fn());
    expect(row?.querySelector(".minimal-agent-activity")?.textContent).toBe(
      "Reading the source",
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const third = {
      ...second,
      currentTool: { name: "open_file", intent: "Opening the config" },
    };
    await renderTracker([third], vi.fn());
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(row?.querySelector(".minimal-agent-activity")?.textContent).toBe(
      "Reading the source",
    );

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const activity = row?.querySelector(".minimal-agent-activity");
    // The held step rolls on: the old words leave while the new ones rise in.
    expect(activity?.querySelector(".roll-out")?.textContent).toBe("Reading the source");
    expect(activity?.querySelector(".roll-in")?.textContent).toBe("Opening the config");
    expect(row?.textContent).not.toContain("Searching the source");

    // Settled, the line is plain text again, so a long one ellipsizes by letter.
    // jsdom has no AnimationEvent, so React listens for the WebKit-prefixed name.
    await act(async () => {
      activity
        ?.querySelector(".roll-in")
        ?.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
    });
    expect(activity?.querySelector(".roll-slot")).toBeNull();
    expect(activity?.textContent).toBe("Opening the config");
  });

  it("keeps the ASCII loader mounted across ordinary progress updates", async () => {
    const first = item("loader-stability", {
      currentTool: {
        name: "read_file",
        intent: "Reading the source",
        argsPreview: "chapter-a.md",
      },
      completionPercent: 10,
    });
    await renderTracker([first], vi.fn());

    const row = container.querySelector<HTMLElement>("[data-subagent-id]");
    const loader = row?.querySelector("[data-ascii-loader]");
    const groupLoader = container.querySelector(
      ".minimal-agents-glyph [data-ascii-loader]",
    );
    expect(loader).not.toBeNull();
    expect(groupLoader).not.toBeNull();

    const updated = {
      ...first,
      currentTool: {
        name: "read_file",
        intent: "Reading the source",
        argsPreview: "chapter-b.md",
      },
      completionPercent: 35,
      progress: "Read another section",
    };
    await renderTracker([updated], vi.fn());

    expect(row?.querySelector("[data-ascii-loader]")).toBe(loader);
    expect(
      container.querySelector(".minimal-agents-glyph [data-ascii-loader]"),
    ).toBe(groupLoader);
  });

  it("keeps metrics in one footer that appears only when opened", async () => {
    const reported = item("overview", { title: "Researcher" });
    const unreported = item("unreported-overview", { title: "Worker" });
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(reported, {
            model: "native-model",
            agentType: "explorer",
            currentTool: {
              name: "read_file",
              intent: "Reading the task source",
              elapsedMs: 0,
            },
            completionPercent: 0,
            metrics: {
              toolCount: 0,
              requests: 0,
              tokens: 0,
              contextTokens: 0,
              contextWindow: 128_000,
              cost: 0,
            },
          }),
        ],
      },
    };

    await renderTracker([reported, unreported], vi.fn());

    const reportedRow = container.querySelector<HTMLElement>(
      `[data-subagent-id="${reported.subagentId}"]`,
    );
    const unreportedRow = container.querySelector<HTMLElement>(
      `[data-subagent-id="${unreported.subagentId}"]`,
    );
    const detailsToggle = reportedRow?.querySelector<HTMLButtonElement>(
      "[data-subagent-details-toggle]",
    );
    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(reportedRow?.querySelector("[data-subagent-metadata]")).toBeNull();

    await act(async () => detailsToggle?.click());
    const footer = reportedRow?.querySelector("[data-subagent-metadata]");
    expect(footer?.textContent).toContain("native-model");
    expect(footer?.textContent).toContain("$0.00");

    await act(async () =>
      unreportedRow?.querySelector<HTMLButtonElement>("[data-subagent-details-toggle]")?.click(),
    );
    expect(unreportedRow?.querySelector("[data-subagent-metadata]")).toBeNull();
  });

  it("keeps native-child details independently expandable across updates without a thread link", async () => {
    const child = item("native-child", {
      status: "running",
      title: "Scout",
      prompt: "Inspect the implementation",
      nativeAgentId: "0-Scout",
      agentType: "explorer",
    });
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "running",
            updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:50.000Z"),
            progress: "Inspecting lifecycle state",
            currentTool: { name: "read_file", argsPreview: "src/state.ts" },
            completionPercent: 60,
          }),
        ],
      },
    };

    await renderTracker([child], vi.fn());

    const row = container.querySelector<HTMLElement>(`[data-subagent-id="${child.subagentId}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector("[data-subagent-open-thread]")).toBeNull();
    const details = row?.querySelector<HTMLButtonElement>("[data-subagent-details-toggle]");
    expect(details?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => details?.click());
    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(row?.textContent).toContain("Inspecting lifecycle state");

    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "completed",
            completedAt: DateTime.makeUnsafe("2026-10-13T12:00:55.000Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:55.000Z"),
            result: "Child completed independently",
            progress: undefined,
            currentTool: null,
            completionPercent: undefined,
          }),
        ],
      },
    };
    await renderTracker([child], vi.fn());

    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(row?.textContent).toContain("Completed");
    expect(row?.textContent).toContain("Child completed independently");
    // The outgoing live line rolls away aria-hidden; nothing a reader gets keeps the old tool.
    const perceivedText = (node: Node): string =>
      node instanceof Element && node.getAttribute("aria-hidden") === "true"
        ? ""
        : node.childNodes.length === 0
          ? (node.textContent ?? "")
          : Array.from(node.childNodes, perceivedText).join("");
    expect(row ? perceivedText(row) : "").not.toContain("read_file");
  });

  it("shows harness icons only for app-owned delegation rows", async () => {
    const native = item("native-harness", { title: "Native agent" });
    const delegated = item("delegated-harness", {
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      title: "Delegated agent",
    });
    state.thread = {
      projection: {
        subagents: [liveAgentFor(native), liveAgentFor(delegated)],
      },
    };

    await renderTracker([native, delegated], vi.fn());

    const nativeRow = container.querySelector<HTMLElement>(
      `[data-subagent-id="${native.subagentId}"]`,
    );
    const delegatedRow = container.querySelector<HTMLElement>(
      `[data-subagent-id="${delegated.subagentId}"]`,
    );
    expect(nativeRow?.querySelector(".minimal-agent-provider")).toBeNull();
    expect(delegatedRow?.querySelector(".minimal-agent-provider")).not.toBeNull();
    expect(container.querySelector(".minimal-agents-header")?.textContent).toContain(
      "Delegating to",
    );
    expect(container.querySelector(".minimal-agents-card")?.children).toHaveLength(2);
  });

  it("tracks pending, running, failed, and aborted states without retaining stale terminal data", async () => {
    const child = item("status-transition", {
      status: "pending",
      startedAt: null,
      title: "Scout",
      nativeAgentId: "0-Scout",
      agentType: "explorer",
    });
    state.thread = {
      projection: { subagents: [liveAgentFor(child, { progress: "Waiting for assignment" })] },
    };

    await renderTracker([child], vi.fn());

    const row = container.querySelector<HTMLElement>(`[data-subagent-id="${child.subagentId}"]`);
    expect(row?.textContent).toContain("Queued");
    const details = row?.querySelector<HTMLButtonElement>("[data-subagent-details-toggle]");
    await act(async () => details?.click());
    expect(row?.textContent).toContain("Waiting for assignment");

    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "running",
            startedAt: DateTime.makeUnsafe("2026-10-13T12:00:50.000Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:50.000Z"),
            progress: "Reading task source",
            completionPercent: 5,
          }),
        ],
      },
    };
    await renderTracker([child], vi.fn());
    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(row?.textContent).toContain("Running");
    expect(row?.textContent).toContain("5%");

    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-13T12:00:50.000Z"),
            completedAt: DateTime.makeUnsafe("2026-10-13T12:00:55.000Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:55.000Z"),
            result: "Native failure",
            progress: undefined,
            completionPercent: undefined,
          }),
        ],
      },
    };
    await renderTracker([child], vi.fn());
    expect(row?.textContent).toContain("Failed");
    expect(row?.textContent).toContain("Native failure");
    expect(row?.querySelector(".minimal-agent-activity-failed")?.textContent).toBe("Native failure");

    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "interrupted",
            startedAt: DateTime.makeUnsafe("2026-10-13T12:00:50.000Z"),
            completedAt: DateTime.makeUnsafe("2026-10-13T12:00:56.000Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:56.000Z"),
            result: null,
          }),
        ],
      },
    };
    await renderTracker([child], vi.fn());
    // The outgoing line of the roll animation stays (aria-hidden) until its
    // animationend, which jsdom never fires; judge only the line readers get.
    const visibleRow = row?.cloneNode(true) as HTMLElement | undefined;
    visibleRow?.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    expect(visibleRow?.textContent).toContain("Aborted");
    expect(visibleRow?.textContent).not.toContain("Native failure");
  });

  it("keeps the group open briefly after the last agent settles, then closes it", async () => {
    const child = item("minimal-settle", { status: "running", title: "Brand Researcher" });
    const renderMinimal = (status: "running" | "completed") =>
      act(async () => {
        state.thread = { projection: { subagents: [liveAgentFor(child, { status })] } };
        registry.set(threadAtom, state.thread);
        root.render(
          <RegistryContext.Provider value={registry}>
            <TranscriptStyleCtx value="minimal">
              <SubagentTaskTracker
                environmentId={EnvironmentId.make("environment")}
                threadId={ThreadId.make("parent-thread")}
                members={[child]}
                providerStatuses={[]}
                expanded={status === "running"}
                onExpandedChange={() => {}}
                onOpenThread={vi.fn()}
              />
            </TranscriptStyleCtx>
          </RegistryContext.Provider>,
        );
      });
    const header = () => container.querySelector("[data-subagent-task-tracker] > button");

    await renderMinimal("running");
    expect(header()?.getAttribute("aria-expanded")).toBe("true");

    await renderMinimal("completed");
    expect(header()?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => vi.advanceTimersByTime(700));
    expect(header()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("auto-opens live details in KM and keeps child-thread navigation", async () => {
    const child = item("km-live-details", {
      title: "Source reviewer",
      childThreadId: ThreadId.make("child-thread"),
    });
    const onOpenThread = vi.fn();
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "running",
            progress: "- Reading **source** [docs](https://example.test)",
          }),
        ],
      },
    };

    await renderTracker([child], onOpenThread, { style: "km" });

    const row = container.querySelector<HTMLElement>(`[data-subagent-id="${child.subagentId}"]`);
    const details = row?.querySelector<HTMLButtonElement>("[data-subagent-details-toggle]");
    expect(details?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => row?.querySelector<HTMLButtonElement>("[data-subagent-open-thread]")?.click());
    expect(onOpenThread).toHaveBeenCalledWith(child.childThreadId);

    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "completed",
            completedAt: DateTime.makeUnsafe("2026-10-13T12:01:00.000Z"),
            result: '{"files": 2, "ok": true, "message": "`done`"}',
            progress: undefined,
          }),
        ],
      },
    };
    await renderTracker([child], onOpenThread, {
      style: "km",
      autoExpandedDetailsItemIds: [String(child.id)],
    });

    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(row?.querySelector(".minimal-agent-activity")?.textContent).toBe(
      "files 2 · ok true · message done",
    );
    await renderTracker([child], onOpenThread, { style: "km" });
    expect(details?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not reuse a prior result, output, tool, or elapsed interval after a child restarts in Terminal", async () => {
    const previousStart = DateTime.makeUnsafe("2026-10-13T12:00:00.000Z");
    const previousEnd = DateTime.makeUnsafe("2026-10-13T12:00:10.000Z");
    const child = item("restarted", {
      status: "completed",
      startedAt: previousStart,
      completedAt: previousEnd,
      updatedAt: previousEnd,
      result: "Earlier result",
      progress: "Earlier progress",
      nativeAgentId: "native-old",
      currentTool: { name: "old_tool" },
      completionPercent: 100,
      liveContent: { kind: "assistant", text: "Earlier output", truncated: false },
    });
    state.thread = {
      projection: {
        subagents: [
          liveAgentFor(child, {
            status: "running",
            startedAt: DateTime.makeUnsafe("2026-10-13T12:00:40.000Z"),
            completedAt: null,
            updatedAt: DateTime.makeUnsafe("2026-10-13T12:01:00.000Z"),
            prompt: "Current retry task",
            result: null,
            progress: undefined,
            nativeAgentId: "native-current",
            currentTool: null,
            completionPercent: undefined,
            retry: null,
          }),
        ],
      },
    };

    await renderTracker([child], vi.fn(), { style: "terminal" });

    const row = container.querySelector<HTMLElement>(`[data-subagent-id="${child.subagentId}"]`);
    expect(row?.textContent).toContain("Running");
    expect(row?.textContent).toContain("20s");
    expect(row?.textContent).toContain("native-current");
    expect(row?.textContent).toContain("Current retry task");
    expect(row?.textContent).not.toContain("Earlier result");
    expect(row?.textContent).not.toContain("Earlier progress");
    expect(row?.textContent).not.toContain("old_tool");
    expect(row?.textContent).not.toContain("Earlier output");
  });
});
