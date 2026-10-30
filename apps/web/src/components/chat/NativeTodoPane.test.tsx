// @vitest-environment jsdom

import { PlanId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { NativeTodoPane } from "./NativeTodoPane";
import { readNativeTodoPlan, type NativeTodoPlan } from "./todoPlan";

const timestamp = DateTime.makeUnsafe("2026-10-14T00:00:00.000Z");

const itemBase = {
  threadId: ThreadId.make("todo-thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: timestamp,
  completedAt: null,
  updatedAt: timestamp,
} satisfies Pick<
  OrchestrationV2TurnItem,
  | "threadId"
  | "runId"
  | "nodeId"
  | "providerThreadId"
  | "providerTurnId"
  | "nativeItemRef"
  | "parentItemId"
  | "ordinal"
  | "status"
  | "title"
  | "startedAt"
  | "completedAt"
  | "updatedAt"
>;

const todoToolItem = {
  ...itemBase,
  id: TurnItemId.make("todo-tool"),
  type: "dynamic_tool",
  toolName: "todo",
  input: {},
} satisfies Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

function dynamicTodoItem(input: unknown, details?: unknown) {
  const toolCall = { ...todoToolItem, input };
  return details === undefined ? toolCall : { ...toolCall, details };
}

function phaseToggle(
  container: HTMLElement,
  phaseName: string,
  occurrenceIndex = 0,
): HTMLButtonElement {
  // Phases live in the plan tree, which a reader opens first; closed panels unmount.
  const tree = container.querySelector<HTMLButtonElement>('button[aria-controls$="-tree"]');
  if (tree?.getAttribute("aria-expanded") === "false") act(() => dispatchClick(tree));
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("li > button")).filter(
    (candidate) => candidate.textContent?.includes(phaseName),
  );
  const button = buttons[occurrenceIndex];
  if (button === undefined) {
    throw new Error(`Missing phase ${phaseName} at occurrence ${occurrenceIndex}`);
  }
  return button;
}

function phaseBody(button: HTMLButtonElement): { readonly hidden: boolean } {
  const body = button.ownerDocument.getElementById(button.getAttribute("aria-controls") ?? "");
  // A closed phase unmounts or, mid-collapse, stays mounted with aria-hidden.
  return { hidden: body === null || body.getAttribute("aria-hidden") === "true" };
}

function dispatchClick(button: HTMLButtonElement): void {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}
interface MountedPane {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

function mountPane(plan: NativeTodoPlan, disclosureCache: Set<string>): MountedPane {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<NativeTodoPane plan={plan} disclosureCache={disclosureCache} />));
  const mounted = { container, root };
  mountedPanes.push(mounted);
  return mounted;
}

const mountedPanes: MountedPane[] = [];

afterEach(() => {
  for (const mounted of mountedPanes.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((query: string = "") => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
    configurable: true,
    writable: true,
  });
});

describe("readNativeTodoPlan", () => {
  it("maps canonical flat todo steps without making up a phase", () => {
    const item = {
      ...itemBase,
      id: TurnItemId.make("flat-plan"),
      type: "todo_list",
      planId: PlanId.make("plan"),
      explanation: "Work through these steps",
      steps: [
        { id: "inspect", text: "Inspect the implementation", status: "completed" },
        { id: "change", text: "Update the reader", status: "running" },
        { id: "review", text: "Review the result", status: "pending" },
      ],
    } satisfies OrchestrationV2TurnItem;

    expect(readNativeTodoPlan(item)).toMatchObject({
      kind: "flat",
      explanation: "Work through these steps",
      phases: [],
      tasks: [
        { content: "Inspect the implementation", status: "completed" },
        { content: "Update the reader", status: "current" },
        { content: "Review the result", status: "pending" },
      ],
    });
  });

  it("reads reported phased result details, including current, blocked, and completed tasks", () => {
    const plan = readNativeTodoPlan(
      dynamicTodoItem(
        { op: "start", task: "A request is not the plan state" },
        {
          op: "start",
          storage: "session",
          phases: [
            {
              name: "Implementation",
              tasks: [
                { content: "Inspect the source", status: "completed" },
                { content: "Implement the pane", status: "in_progress" },
                {
                  content: "Resolve the fixture",
                  status: "blocked",
                  blocker: "Fixture is unavailable",
                },
              ],
            },
            { name: "Review", tasks: [{ content: "Check behavior", status: "pending" }] },
          ],
        },
      ),
    );

    expect(plan).toMatchObject({
      kind: "phased",
      phases: [
        {
          name: "Implementation",
          tasks: [
            { content: "Inspect the source", status: "completed" },
            { content: "Implement the pane", status: "current" },
            {
              content: "Resolve the fixture",
              status: "blocked",
              blocker: "Fixture is unavailable",
            },
          ],
        },
        { name: "Review", tasks: [{ content: "Check behavior", status: "pending" }] },
      ],
    });
  });

  it("does not infer a plan from a request or accept malformed and unknown tool results", () => {
    expect(
      readNativeTodoPlan(dynamicTodoItem({ op: "init", items: ["Uncommitted task"] })),
    ).toBeNull();
    expect(
      readNativeTodoPlan(
        dynamicTodoItem(
          {},
          { phases: [{ name: "Review", tasks: [{ content: "Check", status: "done" }] }] },
        ),
      ),
    ).toBeNull();
    expect(
      readNativeTodoPlan({ ...dynamicTodoItem({}, { phases: [] }), toolName: "other_tool" }),
    ).toBeNull();
  });
});

describe("NativeTodoPane disclosure", () => {
  it("opens the current phase by default and preserves explicit choices through updates and remounts", () => {
    const initialPlan: NativeTodoPlan = {
      key: "thread-plan",
      kind: "phased",
      tasks: [],
      phases: [
        { name: "Implementation", tasks: [{ content: "Implement the reader", status: "current" }] },
        { name: "Review", tasks: [{ content: "Review the reader", status: "pending" }] },
      ],
    };
    const updatedPlan: NativeTodoPlan = {
      ...initialPlan,
      phases: [
        {
          name: "Implementation",
          tasks: [{ content: "Implement the reader", status: "completed" }],
        },
        { name: "Review", tasks: [{ content: "Review the reader", status: "current" }] },
      ],
    };
    const disclosureCache = new Set<string>();
    const mounted = mountPane(initialPlan, disclosureCache);

    const implementation = phaseToggle(mounted.container, "Implementation");
    const review = phaseToggle(mounted.container, "Review");
    expect(phaseBody(implementation).hidden).toBe(false);
    expect(phaseBody(review).hidden).toBe(true);

    act(() => dispatchClick(implementation));
    expect(phaseBody(phaseToggle(mounted.container, "Implementation")).hidden).toBe(true);
    act(() =>
      mounted.root.render(<NativeTodoPane plan={updatedPlan} disclosureCache={disclosureCache} />),
    );
    expect(phaseBody(phaseToggle(mounted.container, "Implementation")).hidden).toBe(true);
    const updatedReview = phaseToggle(mounted.container, "Review");
    expect(phaseBody(updatedReview).hidden).toBe(false);

    act(() => dispatchClick(updatedReview));
    expect(phaseBody(phaseToggle(mounted.container, "Review")).hidden).toBe(true);
    act(() => mounted.root.render(null));
    act(() =>
      mounted.root.render(<NativeTodoPane plan={updatedPlan} disclosureCache={disclosureCache} />),
    );
    expect(phaseBody(phaseToggle(mounted.container, "Review")).hidden).toBe(true);
  });

  it("independently toggles phases with duplicate names and preserves respective states across remount", () => {
    const plan: NativeTodoPlan = {
      key: "duplicate-phase-plan",
      kind: "phased",
      tasks: [],
      phases: [
        { name: "Review", tasks: [{ content: "Review first part", status: "current" }] },
        { name: "Review", tasks: [{ content: "Review second part", status: "pending" }] },
      ],
    };
    const disclosureCache = new Set<string>();
    const mounted = mountPane(plan, disclosureCache);

    const firstReview = phaseToggle(mounted.container, "Review", 0);
    const secondReview = phaseToggle(mounted.container, "Review", 1);

    expect(phaseBody(firstReview).hidden).toBe(false);
    expect(phaseBody(secondReview).hidden).toBe(true);

    act(() => dispatchClick(firstReview));
    expect(phaseBody(phaseToggle(mounted.container, "Review", 0)).hidden).toBe(true);
    expect(phaseBody(phaseToggle(mounted.container, "Review", 1)).hidden).toBe(true);

    act(() => dispatchClick(phaseToggle(mounted.container, "Review", 1)));
    expect(phaseBody(phaseToggle(mounted.container, "Review", 1)).hidden).toBe(false);

    act(() => mounted.root.render(null));
    act(() =>
      mounted.root.render(<NativeTodoPane plan={plan} disclosureCache={disclosureCache} />),
    );
    expect(phaseBody(phaseToggle(mounted.container, "Review", 0)).hidden).toBe(true);
    expect(phaseBody(phaseToggle(mounted.container, "Review", 1)).hidden).toBe(false);

    act(() => dispatchClick(phaseToggle(mounted.container, "Review", 0)));
    expect(phaseBody(phaseToggle(mounted.container, "Review", 1)).hidden).toBe(false);

    act(() => mounted.root.render(null));
    act(() =>
      mounted.root.render(<NativeTodoPane plan={plan} disclosureCache={disclosureCache} />),
    );
    expect(phaseBody(phaseToggle(mounted.container, "Review", 0)).hidden).toBe(false);
    expect(phaseBody(phaseToggle(mounted.container, "Review", 1)).hidden).toBe(false);
  });

  it("preserves named phase preferences across nonduplicate reordering", () => {
    const initialPlan: NativeTodoPlan = {
      key: "reorder-plan",
      kind: "phased",
      tasks: [],
      phases: [
        { name: "Alpha", tasks: [{ content: "Alpha task", status: "current" }] },
        { name: "Beta", tasks: [{ content: "Beta task", status: "pending" }] },
      ],
    };
    const reorderedPlan: NativeTodoPlan = {
      key: "reorder-plan",
      kind: "phased",
      tasks: [],
      phases: [
        { name: "Beta", tasks: [{ content: "Beta task", status: "pending" }] },
        { name: "Alpha", tasks: [{ content: "Alpha task", status: "current" }] },
      ],
    };
    const disclosureCache = new Set<string>();
    const mounted = mountPane(initialPlan, disclosureCache);

    expect(phaseBody(phaseToggle(mounted.container, "Alpha")).hidden).toBe(false);
    expect(phaseBody(phaseToggle(mounted.container, "Beta")).hidden).toBe(true);

    act(() => dispatchClick(phaseToggle(mounted.container, "Alpha")));
    act(() => dispatchClick(phaseToggle(mounted.container, "Beta")));
    expect(phaseBody(phaseToggle(mounted.container, "Alpha")).hidden).toBe(true);
    expect(phaseBody(phaseToggle(mounted.container, "Beta")).hidden).toBe(false);

    act(() =>
      mounted.root.render(
        <NativeTodoPane plan={reorderedPlan} disclosureCache={disclosureCache} />,
      ),
    );
    expect(phaseBody(phaseToggle(mounted.container, "Beta")).hidden).toBe(false);
    expect(phaseBody(phaseToggle(mounted.container, "Alpha")).hidden).toBe(true);
  });
});
