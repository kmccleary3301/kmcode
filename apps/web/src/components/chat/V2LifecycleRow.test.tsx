// @vitest-environment jsdom

import type { ReactNode } from "react";
import type * as AtomReact from "@effect/atom-react";
import type * as StateEntitiesModule from "../../state/entities";
import type * as ThreadsModule from "../../state/threads";
import type * as SessionModule from "../../state/session";
import type * as ThreadHoverCardModule from "../ThreadHoverCard";
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
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ thread: null as unknown }));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof AtomReact>();
  return {
    ...actual,
    useAtomValue: (_atom: unknown, select?: (thread: unknown) => unknown) =>
      select ? select(state.thread) : null,
  };
});
vi.mock("../../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof ThreadsModule>();
  return {
    ...actual,
    environmentThreadDetails: { threadAtom: () => null },
  };
});
vi.mock("../../state/entities", async (importOriginal) => {
  const actual = await importOriginal<typeof StateEntitiesModule>();
  return {
    ...actual,
    useProject: () => undefined,
    useProjects: () => [],
    useServerConfigs: () => new Map(),
    useThreadShell: () => undefined,
    useThreadVisibleTurnItems: () => [],
  };
});
vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    readEnvironmentScope: () => false,
    useEnvironmentScope: () => false,
    usePreparedConnection: () => ({ _tag: "None" }),
  };
});
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../ThreadHoverCard", async (importOriginal) => {
  const original = await importOriginal<typeof ThreadHoverCardModule>();
  return {
    ...original,
    ThreadHoverCardPopup: ({ children }: { children?: ReactNode }) => (
      <div data-testid="subagent-tooltip">{children}</div>
    ),
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: ({ children }: { children?: ReactNode }) => children,
}));

import { SubagentNotificationLink, V2LifecycleRow } from "./V2LifecycleRow";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:01:00.000Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  state.thread = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const notificationTask = (
  id: NodeId,
  threadId: ThreadId,
  childThreadId: ThreadId,
  title: string,
  result: string,
) => {
  const timestamp = DateTime.makeUnsafe("2026-10-13T12:00:10.000Z");
  return {
    id,
    threadId,
    runId: null,
    parentNodeId: NodeId.make("node:parent"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId,
    nativeTaskRef: null,
    prompt: title,
    title,
    model: null,
    status: "completed",
    result,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  } as const;
};

describe("V2LifecycleRow child timing", () => {
  it("freezes a completed child row and tooltip while an active sibling keeps ticking", async () => {
    const threadId = ThreadId.make("parent-thread");
    const completedId = NodeId.make("node:subagent:completed");
    const activeId = NodeId.make("node:subagent:active");
    const completedStart = DateTime.makeUnsafe("2026-10-13T12:00:00.000Z");
    const completedEnd = DateTime.makeUnsafe("2026-10-13T12:00:10.000Z");
    const activeStart = DateTime.makeUnsafe("2026-10-13T12:00:45.000Z");
    const updatedAt = DateTime.makeUnsafe("2026-10-13T12:01:00.000Z");
    const completedItem = {
      id: TurnItemId.make("turn-item:subagent:completed"),
      threadId,
      runId: null,
      nodeId: completedId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Scout",
      startedAt: completedStart,
      completedAt: completedEnd,
      updatedAt: completedEnd,
      type: "subagent",
      subagentId: completedId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect the package",
      result: "Completed result: 42",
    } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
    const activeItem = {
      ...completedItem,
      id: TurnItemId.make("turn-item:subagent:active"),
      nodeId: activeId,
      ordinal: 2,
      status: "running",
      title: "Scout",
      startedAt: activeStart,
      completedAt: null,
      updatedAt,
      subagentId: activeId,
      result: null,
      progress: "Active sibling progress",
    } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
    state.thread = {
      projection: {
        subagents: [
          {
            id: completedId,
            status: "completed",
            startedAt: completedStart,
            completedAt: completedEnd,
            updatedAt: completedEnd,
            result: "Completed result: 42",
            title: "Scout",
            prompt: "Inspect the package",
            model: null,
          },
          {
            id: activeId,
            status: "running",
            startedAt: activeStart,
            completedAt: null,
            updatedAt,
            progress: "Active sibling progress",
            title: "Scout",
            prompt: "Inspect the package",
            model: null,
          },
        ],
      },
    };

    await act(async () => {
      root.render(
        <>
          <V2LifecycleRow
            item={completedItem}
            environmentId={EnvironmentId.make("environment")}
            createdAt="2026-10-13T12:00:00.000Z"
            timestampFormat="locale"
            providerStatuses={[]}
            runs={[]}
            onOpenThread={() => {}}
          />
          <V2LifecycleRow
            item={activeItem}
            environmentId={EnvironmentId.make("environment")}
            createdAt="2026-10-13T12:00:00.000Z"
            timestampFormat="locale"
            providerStatuses={[]}
            runs={[]}
            onOpenThread={() => {}}
          />
        </>,
      );
    });
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".minimal-agents-header").forEach((header) => {
        if (header.getAttribute("aria-expanded") === "false") header.click();
      });
    });

    const rowElapsed = (detail: string) => {
      const row = Array.from(container.querySelectorAll('[data-v2-item-type="subagent"]')).find(
        (candidate) => candidate.textContent?.includes(detail),
      );
      return row?.querySelector(".tabular-nums")?.textContent ?? null;
    };
    const tooltipElapsed = (detail: string) => {
      const tooltip = Array.from(container.querySelectorAll('[data-testid="subagent-tooltip"]')).find(
        (candidate) => candidate.textContent?.includes(detail),
      );
      return tooltip?.querySelector(".tabular-nums")?.textContent ?? null;
    };
    expect(rowElapsed("Completed result: 42")).toBe("10s");
    expect(tooltipElapsed("Completed result: 42")).toBe("10s");
    expect(rowElapsed("Active sibling progress")).toBe("15s");
    expect(tooltipElapsed("Active sibling progress")).toBe("15s");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(rowElapsed("Completed result: 42")).toBe("10s");
    expect(tooltipElapsed("Completed result: 42")).toBe("10s");
    expect(rowElapsed("Active sibling progress")).toBe("1m 15s");
    expect(tooltipElapsed("Active sibling progress")).toBe("1m 15s");
  });
  it("does not show an earlier attempt's end after the live child starts again", async () => {
    const threadId = ThreadId.make("parent-thread");
    const subagentId = NodeId.make("node:subagent:reopened");
    const oldStart = DateTime.makeUnsafe("2026-10-13T12:00:00.000Z");
    const oldEnd = DateTime.makeUnsafe("2026-10-13T12:00:10.000Z");
    const currentStart = DateTime.makeUnsafe("2026-10-13T12:00:30.000Z");
    const item = {
      id: TurnItemId.make("turn-item:subagent:reopened"),
      threadId,
      runId: null,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Scout",
      startedAt: oldStart,
      completedAt: oldEnd,
      updatedAt: oldEnd,
      type: "subagent",
      subagentId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect the package",
      result: "Earlier attempt result",
    } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
    state.thread = {
      projection: {
        subagents: [
          {
            id: subagentId,
            status: "completed",
            startedAt: currentStart,
            completedAt: null,
            updatedAt: currentStart,
            result: "Current attempt result",
            title: "Scout",
            prompt: "Inspect the package",
            model: null,
          },
        ],
      },
    };

    await act(async () => {
      root.render(
        <V2LifecycleRow
          item={item}
          environmentId={EnvironmentId.make("environment")}
          createdAt="2026-10-13T12:00:00.000Z"
          timestampFormat="locale"
          providerStatuses={[]}
          runs={[]}
          onOpenThread={() => {}}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".minimal-agents-header")?.click();
    });

    const row = container.querySelector('[data-v2-item-type="subagent"]');
    const tooltip = container.querySelector('[data-testid="subagent-tooltip"]');
    const expectUnknownDuration = (element: Element | null) => {
      const text = element?.textContent ?? "";
      expect(text).toContain("Current attempt result");
      expect(text).not.toMatch(/\b\d+s\b|\b\d+m \d{2}s\b|\b\d+h \d{2}m\b/);
    };

    expectUnknownDuration(row);
    expectUnknownDuration(tooltip);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expectUnknownDuration(row);
    expectUnknownDuration(tooltip);
  });
  it("binds delegated notifications to their exact task ID and renders the shared card", async () => {
    const parentThreadId = ThreadId.make("parent-thread");
    const childThreadId = ThreadId.make("child-thread");
    const originalId = NodeId.make("node:original-task");
    const followupId = NodeId.make("node:followup-task");
    const onOpenThread = vi.fn();
    state.thread = {
      projection: {
        subagents: [
          notificationTask(
            originalId,
            parentThreadId,
            childThreadId,
            "Original task",
            "Original result",
          ),
          notificationTask(
            followupId,
            parentThreadId,
            childThreadId,
            "Follow-up task",
            "Follow-up result",
          ),
        ],
      },
    };

    await act(async () => {
      root.render(
        <SubagentNotificationLink
          parentRef={scopeThreadRef(EnvironmentId.make("environment"), parentThreadId)}
          taskIds={[followupId]}
          outcome="completed"
          createdAt="2026-10-13T12:00:10.000Z"
          timestampFormat="locale"
          providerStatuses={[]}
          onOpenThread={onOpenThread}
          fallback={<div data-testid="notification-fallback">Notification fallback</div>}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".minimal-agents-header")?.click();
    });

    const row = container.querySelector<HTMLButtonElement>('[data-v2-item-type="subagent"]');
    expect(row?.textContent).toContain("Follow-up task");
    expect(row?.textContent).toContain("Follow-up result");
    expect(row?.textContent).not.toContain("Original task");
    expect(row?.textContent).not.toContain("Original result");
    expect(row?.closest(".minimal-agents-card")).not.toBeNull();
    expect(row?.querySelector(".minimal-agent-provider")).not.toBeNull();
    expect(container.querySelector(".minimal-agents-header")?.textContent).toContain(
      "Delegated to",
    );
    expect(container.querySelector('[data-testid="subagent-tooltip"]')).not.toBeNull();

    await act(async () => row?.click());
    expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
  });

  it("renders subagent task and result Markdown in details and a plain one-line summary", async () => {
    vi.useRealTimers();
    const parentThreadId = ThreadId.make("parent-thread");
    const childThreadId = ThreadId.make("child-thread");
    const taskId = NodeId.make("node:markdown-task");
    const agent = {
      ...notificationTask(
        taskId,
        parentThreadId,
        childThreadId,
        "Markdown task",
        "- **box-ok**\n- Command completed successfully.",
      ),
      prompt: "Inspect the **bold** implementation.",
    };
    state.thread = { projection: { subagents: [agent] } };

    await act(async () => {
      root.render(
        <SubagentNotificationLink
          parentRef={scopeThreadRef(EnvironmentId.make("environment"), parentThreadId)}
          taskIds={[taskId]}
          outcome="completed"
          createdAt="2026-10-13T12:00:10.000Z"
          timestampFormat="locale"
          providerStatuses={[]}
          onOpenThread={() => {}}
          fallback={<div />}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".minimal-agents-header")?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-subagent-details-toggle]")?.click();
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      expect(container.querySelector(".minimal-agent-details strong")?.textContent).toBe("bold");
      expect(container.querySelectorAll("[data-subagent-result] li")).toHaveLength(2);
    });

    expect(container.querySelector(".minimal-agent-activity")?.textContent).toBe(
      "box-ok Command completed successfully.",
    );
  });

  it("uses the generic fallback rather than choosing one of multiple task IDs", async () => {
    const parentThreadId = ThreadId.make("parent-thread");
    const childThreadId = ThreadId.make("child-thread");
    const originalId = NodeId.make("node:original-task");
    const followupId = NodeId.make("node:followup-task");
    state.thread = {
      projection: {
        subagents: [
          notificationTask(
            originalId,
            parentThreadId,
            childThreadId,
            "Original task",
            "Original result",
          ),
          notificationTask(
            followupId,
            parentThreadId,
            childThreadId,
            "Follow-up task",
            "Follow-up result",
          ),
        ],
      },
    };

    await act(async () => {
      root.render(
        <SubagentNotificationLink
          parentRef={scopeThreadRef(EnvironmentId.make("environment"), parentThreadId)}
          childThreadId={childThreadId}
          taskIds={[originalId, followupId]}
          outcome="completed"
          createdAt="2026-10-13T12:00:10.000Z"
          timestampFormat="locale"
          providerStatuses={[]}
          onOpenThread={() => {}}
          fallback={<div data-testid="notification-fallback">Notification fallback</div>}
        />,
      );
    });

    expect(container.querySelector('[data-testid="notification-fallback"]')?.textContent).toBe(
      "Notification fallback",
    );
  });
});
