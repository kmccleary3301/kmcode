// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { Atom, AtomRegistry } from "effect/reactivity";
import { environmentThreadDetails } from "~/state/threads";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import * as query from "~/state/query";
import { parseActivityDetail } from "@t3tools/client-runtime/activity-details";
import { act, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DateTime from "effect/DateTime";

import {
  ToolWorkEntryCard,
  type ToolWorkEntryCardEntry,
  type ToolWorkEntryDetailSource,
} from "./ToolWorkEntryCard";
import { TranscriptStyleCtx } from "./transcriptStyle";

const timestamp = DateTime.makeUnsafe("2026-09-05T00:00:00.000Z");
interface MountedCard {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

function mountCard(
  entry: ToolWorkEntryCardEntry,
  disclosureCache?: Set<string> | undefined,
  detailSource?: ToolWorkEntryDetailSource,
  autoExpanded?: boolean | undefined,
): MountedCard {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ToolWorkEntryCard
        entry={entry}
        icon={<span />}
        disclosureCache={disclosureCache}
        detailSource={detailSource}
        autoExpanded={autoExpanded}
      />,
    ),
  );
  return { container, root };
}

function buttonContaining(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function disclosureButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    "button[aria-label][aria-expanded][aria-controls]",
  );
}

function dispatchClick(element: HTMLElement | null | undefined, detail = 1): void {
  if (!element) throw new Error("Expected element to be present for click");
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
}

function activateButtonWithKeyboard(button: HTMLButtonElement, key: "Enter" | " "): void {
  button.focus();
  button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  dispatchClick(button, 0);
  button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
}

const mountedCards: MountedCard[] = [];

afterEach(() => {
  for (const mounted of mountedCards.splice(0)) {
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
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

function commandItem(
  output: string,
  id: string = "command-preview",
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    id: TurnItemId.make(id),
    type: "command_execution",
    threadId: ThreadId.make("thread-preview"),
    runId: RunId.make("run-preview"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Run tests",
    input: "pnpm test",
    output,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

type DynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

function fileReadEntry(
  id: string,
  input: unknown,
  output: unknown,
  status: "completed" | "failed" = "completed",
): ToolWorkEntryCardEntry {
  const item = {
    id: TurnItemId.make(id),
    type: "dynamic_tool",
    toolName: "read",
    title: "read",
    threadId: ThreadId.make("thread-read"),
    runId: RunId.make("run-read"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status,
    input,
    output,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  } satisfies DynamicToolItem;
  return {
    id,
    createdAt: "2026-09-05T00:00:00.000Z",
    label: "read",
    toolTitle: "read",
    tone: "tool",
    itemType: "dynamic_tool",
    toolLifecycleStatus: status,
    structuredPayload: item,
  };
}

describe("ToolWorkEntryCard", () => {
  it("shows a projected subagent title for a T3 thread wait target", () => {
    const environmentId = EnvironmentId.make("environment-thread-title");
    const parentThreadId = ThreadId.make("thread-parent");
    const rawChildThreadId = "thread:delegated-task:command%3Amcp%3Ad83b44ba";
    const childThreadId = ThreadId.make(rawChildThreadId);
    const item = {
      id: TurnItemId.make("thread-wait-title"),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_wait",
      title: null,
      threadId: parentThreadId,
      runId: RunId.make("run-thread-wait-title"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      input: { threadId: rawChildThreadId },
      output: null,
      startedAt: timestamp,
      completedAt: null,
      updatedAt: timestamp,
    } satisfies DynamicToolItem;
    const projectedItem = {
      position: 0,
      visibility: "local",
      sourceThreadId: parentThreadId,
      sourceItemId: item.id,
      item,
    } satisfies OrchestrationV2ProjectedTurnItem;
    const parentThreadAtom = Atom.make({
      environmentId,
      projection: {
        subagents: [{ childThreadId, title: "Codex / GPT 6.1 Sol" }],
      },
    } as never);
    const threadAtomSpy = vi
      .spyOn(environmentThreadDetails, "threadAtom")
      .mockReturnValue(parentThreadAtom as never);
    const registry = AtomRegistry.make();

    try {
      const markup = renderToStaticMarkup(
        <RegistryContext.Provider value={registry}>
          <ToolWorkEntryCard
            entry={{
              id: "thread-wait-title",
              createdAt: "2026-09-05T00:00:00.000Z",
              label: item.toolName,
              toolTitle: item.toolName,
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "inProgress",
              structuredPayload: item,
              projectedItem,
            }}
            icon={<span />}
            detailSource={{ kind: "projected", projectedItem, environmentId }}
            autoExpanded={false}
          />
        </RegistryContext.Provider>,
      );

      expect(markup).toContain("Waiting for");
      expect(markup).toContain("Codex / GPT 6.1 Sol");
      expect(markup).not.toContain(rawChildThreadId);
      const settledItem = { ...item, status: "completed" as const, completedAt: timestamp };
      const settledProjectedItem = { ...projectedItem, item: settledItem };
      const settledMarkup = renderToStaticMarkup(
        <RegistryContext.Provider value={registry}>
          <ToolWorkEntryCard
            entry={{
              id: "thread-wait-title",
              createdAt: "2026-09-05T00:00:00.000Z",
              label: item.toolName,
              toolTitle: item.toolName,
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
              structuredPayload: settledItem,
              projectedItem: settledProjectedItem,
            }}
            icon={<span />}
            detailSource={{
              kind: "projected",
              projectedItem: settledProjectedItem,
              environmentId,
            }}
            autoExpanded={false}
          />
        </RegistryContext.Provider>,
      );

      expect(settledMarkup).toContain("Waited for");
      expect(settledMarkup).toContain("Codex / GPT 6.1 Sol");
      expect(settledMarkup).not.toContain(rawChildThreadId);
    } finally {
      threadAtomSpy.mockRestore();
      registry.dispose();
    }
  });
  it("renders a compact tool overview when collapsed and reveals result when opened", () => {
    const output = `2 tests passed\n${"No errors\n".repeat(80)}result-tail-marker`;
    const entry = {
      id: "command-preview",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: commandItem(output, "command-preview"),
    } satisfies ToolWorkEntryCardEntry;

    const collapsedMarkup = renderToStaticMarkup(
      <ToolWorkEntryCard entry={entry} icon={<span />} autoExpanded={false} />,
    );
    expect(collapsedMarkup).toContain("pnpm test");
    expect(collapsedMarkup).toContain("Completed");
    expect(collapsedMarkup).not.toContain("result-tail-marker");

    const openMarkup = renderToStaticMarkup(
      <ToolWorkEntryCard entry={entry} icon={<span />} autoExpanded={true} />,
    );
    expect(openMarkup).toContain("2 tests passed");
  });

  it("renders direct file reads as only their path in compact mode", () => {
    const entry = fileReadEntry(
      "compact-read",
      { path: "src/example.ts", sel: "L3-L6", i: "Inspecting source" },
      "full-file-body-marker",
    );
    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    expect(mounted.container.textContent).toContain("Read");
    expect(mounted.container.textContent).toContain("src/example.ts:L3-L6");
    expect(mounted.container.textContent).not.toContain("Inspecting source");
    expect(mounted.container.textContent).not.toContain("full-file-body-marker");
    expect(disclosureButton(mounted.container)).toBeNull();
    expect(mounted.container.querySelector("button")).toBeNull();
    expect(mounted.container.querySelector('section[aria-label="Output"]')).toBeNull();
  });

  it("restores read details when switching from compact to rich", () => {
    const entry = fileReadEntry(
      "switchable-read",
      { path: "src/example.ts", sel: "L3-L6", i: "Inspecting source" },
      "rich-read-body-marker",
    );
    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    expect(mounted.container.textContent).not.toContain("rich-read-body-marker");

    act(() => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, toolDetail: "rich" });
      mounted.root.render(<ToolWorkEntryCard entry={entry} icon={<span />} autoExpanded />);
    });

    expect(mounted.container.textContent).toContain("rich-read-body-marker");
    expect(disclosureButton(mounted.container)).not.toBeNull();
  });

  it("drops a read's path row when the terminal title already names the file", () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, toolDetail: "rich" });
    const render = (input: Record<string, string>) =>
      renderToStaticMarkup(
        <TranscriptStyleCtx value="terminal">
          <ToolWorkEntryCard
            entry={fileReadEntry("terminal-read", input, "read-body")}
            icon={<span />}
            autoExpanded
          />
        </TranscriptStyleCtx>,
      );

    const titled = render({ path: "src/example.ts", sel: "L3-L6" });
    expect(titled).not.toContain("<dt>path</dt>");
    expect(titled).toContain("<dt>sel</dt>");

    // An intent takes the title's place, so the path stays in the input.
    const intended = render({ path: "src/example.ts", sel: "L3-L6", i: "Inspecting source" });
    expect(intended).toContain("<dt>path</dt>");
  });

  it("trails a command's intent on its line in Minimal and heads the step in KM", () => {
    const entry = {
      id: "command-intent",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "command -v omp",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: { ...commandItem("/usr/local/bin/omp"), intent: "Locating omp" },
    } satisfies ToolWorkEntryCardEntry;
    const render = (style: "minimal" | "km") =>
      renderToStaticMarkup(
        <TranscriptStyleCtx value={style}>
          <ToolWorkEntryCard entry={entry} icon={<span />} autoExpanded={false} />
        </TranscriptStyleCtx>,
      );

    const minimal = render("minimal");
    expect(minimal).toMatch(/class="tool-intent-tag"[^>]*>Locating omp</);
    expect(minimal).not.toContain('class="tool-intent ');
    const km = render("km");
    expect(km).toMatch(/class="tool-intent [^"]*">Locating omp</);
    expect(km).not.toContain("tool-intent-tag");
  });

  it("keeps failed read errors visible", () => {
    const entry = fileReadEntry(
      "failed-read",
      { path: "src/missing.ts" },
      "permission denied while reading file",
      "failed",
    );
    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    expect(mounted.container.textContent).toContain("permission denied while reading file");
    expect(mounted.container.textContent).toContain("Failed");
    expect(disclosureButton(mounted.container)).not.toBeNull();
  });

  it.each([
    {
      label: "URL",
      input: { url: "https://example.com/readme" },
      output: "url-read-body-marker",
    },
    {
      label: "internal document URI",
      input: { path: "skill://write-swift" },
      output: "skill-document-body-marker",
    },
    {
      label: "multiple paths",
      input: { paths: ["src/first.ts", "src/second.ts"] },
      output: "multi-path-read-body-marker",
    },
  ])("keeps $label read details visible", ({ input, output }) => {
    const entry = fileReadEntry(`complex-read-${output}`, input, output);
    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    expect(disclosureButton(mounted.container)).not.toBeNull();
    expect(mounted.container.textContent).toContain(output);
  });

  it("keeps output details collapsed until requested and lets Copy leave the panel closed", async () => {
    const output = `2 tests passed\n${"No errors\n".repeat(80)}result-tail-marker`;
    const entry = {
      id: "command-preview-copy",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: commandItem(output),
    } satisfies ToolWorkEntryCardEntry;
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    const copyButton = buttonContaining(mounted.container, "Copy");
    expect(copyButton).not.toBeNull();
    await act(async () => dispatchClick(copyButton));
    expect(buttonContaining(mounted.container, "Output")).toBeNull();
    expect(mounted.container.textContent).toContain("2 tests passed");
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ] as const)("opens and closes details with native %s activation", async (_label, key) => {
    const entry = {
      id: `command-key-${key}`,
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: commandItem("2 tests passed", `command-key-${key}`),
    } satisfies ToolWorkEntryCardEntry;
    const mounted = mountCard(entry);
    mountedCards.push(mounted);
    const disclosure = disclosureButton(mounted.container);
    expect(disclosure).not.toBeNull();
    expect(disclosure!.getAttribute("aria-label")?.trim()).toBeTruthy();
    const bodyId = disclosure!.getAttribute("aria-controls");
    expect(bodyId).not.toBeNull();
    expect(disclosure!.getAttribute("aria-expanded")).toBe("false");

    await act(async () => activateButtonWithKeyboard(disclosure!, key));
    expect(disclosure!.getAttribute("aria-expanded")).toBe("true");

    await act(async () => activateButtonWithKeyboard(disclosure!, key));
    expect(disclosure!.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows failure state in the collapsed tool summary", () => {
    const failedItem = {
      ...commandItem("command not found", "failed-command"),
      status: "failed" as const,
      exitCode: 127,
    };
    const entry = {
      id: "failed-command",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "missing-command",
      itemType: "command_execution",
      toolLifecycleStatus: "failed",
      structuredPayload: failedItem,
    } satisfies ToolWorkEntryCardEntry;
    const mounted = mountCard(entry);
    mountedCards.push(mounted);

    expect(mounted.container.textContent).toContain("Failed");
    expect(mounted.container.textContent?.match(/exit 127/gi)).toHaveLength(1);
    expect(mounted.container.textContent).toContain("command not found");
  });

  it("keeps native pending tools queued while their arguments are incomplete", () => {
    const pendingItem = {
      ...commandItem(""),
      type: "dynamic_tool" as const,
      toolName: "exec_command",
      input: '{"command":"pnpm test"',
      status: "pending" as const,
      startedAt: null,
      completedAt: null,
    } satisfies OrchestrationV2TurnItem;
    const entry = {
      id: "pending-partial-command",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "exec_command",
      toolTitle: "exec_command",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "inProgress",
      structuredPayload: pendingItem,
    } satisfies ToolWorkEntryCardEntry;
    const mounted = mountCard(entry);
    mountedCards.push(mounted);

    expect(mounted.container.textContent).toContain("Queued");
    expect(mounted.container.textContent).not.toContain("Running");
  });
  it.each([
    {
      toolName: "javascript",
      input: { code: "const answer = 42;", language: "javascript" },
      code: "const answer = 42;",
    },
    {
      toolName: "python",
      input: JSON.stringify({ code: "print(42)", language: "python" }),
      code: "print(42)",
    },
  ])(
    "shows native $toolName input as code and copies only the program",
    async ({ toolName, input, code }) => {
      const item = {
        ...commandItem("execution output"),
        type: "dynamic_tool" as const,
        toolName,
        input,
      } satisfies OrchestrationV2TurnItem;
      const entry = {
        id: `repl-${toolName}`,
        createdAt: "2026-09-05T00:00:00.000Z",
        label: toolName,
        toolTitle: toolName,
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        structuredPayload: item,
      } satisfies ToolWorkEntryCardEntry;
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const mounted = mountCard(entry, undefined, undefined, true);
      mountedCards.push(mounted);

      const inputSection = mounted.container.querySelector<HTMLElement>(
        'section[aria-label="Input"]',
      );
      expect(inputSection).not.toBeNull();
      expect(inputSection?.querySelector("code")?.textContent).toBe(code);
      expect(inputSection?.textContent).not.toContain('"code"');
      expect(mounted.container.textContent).toContain("execution output");

      const copyInput = inputSection?.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy input"]',
      );
      expect(copyInput).not.toBeNull();
      await act(async () => dispatchClick(copyInput));
      expect(writeText).toHaveBeenCalledWith(code);
    },
  );
  it.each([
    { status: "completed" as const, showsOutput: false },
    { status: "failed" as const, showsOutput: true },
  ])("shows an applied edit's output only when it $status", ({ status, showsOutput }) => {
    const item = {
      ...commandItem("[src/a.ts#EAC8]\n2:const echoed = 2;"),
      type: "dynamic_tool" as const,
      toolName: "edit",
      status,
      input: { path: "src/a.ts" },
      details: { diff: "@@ -2,1 +2,1 @@\n-const before = 1;\n+const echoed = 2;" },
    } satisfies OrchestrationV2TurnItem;
    const entry = {
      id: `edit-${status}`,
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "edit",
      toolTitle: "edit",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: status,
      structuredPayload: item,
    } satisfies ToolWorkEntryCardEntry;
    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    expect(mounted.container.textContent).toContain("const before = 1;");
    expect(mounted.container.querySelector('section[aria-label="Output"]') !== null).toBe(
      showsOutput,
    );
    expect(mounted.container.textContent?.includes("[src/a.ts#EAC8]")).toBe(showsOutput);
  });

  it("does not turn parsed input into a result or enable output copying before output arrives", async () => {
    const item = {
      ...commandItem(""),
      status: "running",
      startedAt: null,
      completedAt: null,
    } satisfies OrchestrationV2TurnItem;
    const entry = {
      id: "running-input-only",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "inProgress",
      structuredPayload: item,
    } satisfies ToolWorkEntryCardEntry;
    const mounted = mountCard(
      entry,
      undefined,
      {
        kind: "parsed",
        detail: parseActivityDetail(item),
      },
      true,
    );
    mountedCards.push(mounted);

    const inputSection = mounted.container.querySelector<HTMLElement>(
      'section[aria-label="Input"]',
    );
    expect(inputSection).not.toBeNull();
    expect(inputSection?.textContent).toContain("pnpm test");

    expect(mounted.container.querySelector('section[aria-label="Output"]')).toBeNull();
    expect(mounted.container.querySelector('button[aria-label="Copy output"]')).toBeNull();
  });

  it("preserves card disclosure choice across remounts without leaking between tools or threads", async () => {
    const firstEntry = {
      id: "cached-command-one",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: {
        ...commandItem("2 tests passed"),
        id: TurnItemId.make("cached-command-one"),
      },
    } satisfies ToolWorkEntryCardEntry;
    const secondEntry = {
      ...firstEntry,
      id: "cached-command-two",
      structuredPayload: {
        ...commandItem("other output"),
        id: TurnItemId.make("cached-command-two"),
      },
    } satisfies ToolWorkEntryCardEntry;
    const cache = new Set<string>();
    const mounted = mountCard(firstEntry, cache, undefined, true);
    const otherThread = mountCard(firstEntry, new Set(), undefined, true);
    mountedCards.push(mounted, otherThread);
    const isExpanded = (card: MountedCard) =>
      disclosureButton(card.container)?.getAttribute("aria-expanded");
    const toggleCard = async (card: MountedCard) => {
      const button = disclosureButton(card.container);
      if (button === null) throw new Error("Missing disclosure control");
      await act(async () => dispatchClick(button));
    };
    const remount = async () => {
      await act(async () => mounted.root.render(null));
      await act(async () =>
        mounted.root.render(
          <ToolWorkEntryCard
            entry={firstEntry}
            icon={<span />}
            disclosureCache={cache}
            autoExpanded
          />,
        ),
      );
    };

    expect(isExpanded(mounted)).toBe("true");
    expect(isExpanded(otherThread)).toBe("true");

    await toggleCard(mounted);
    expect(isExpanded(mounted)).toBe("false");
    expect(isExpanded(otherThread)).toBe("true");

    await remount();
    expect(isExpanded(mounted)).toBe("false");

    await toggleCard(otherThread);
    expect(isExpanded(otherThread)).toBe("false");
    expect(isExpanded(mounted)).toBe("false");

    const otherTool = mountCard(secondEntry, cache, undefined, true);
    mountedCards.push(otherTool);
    expect(isExpanded(otherTool)).toBe("true");

    await toggleCard(mounted);
    expect(isExpanded(mounted)).toBe("true");
    await remount();
    expect(isExpanded(mounted)).toBe("true");
  });

  it("renders native search pane without raw-result UI", async () => {
    const rawOutput = "Search engine raw output: 12 results found in 0.04s";
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("native-search-item"),
      type: "dynamic_tool",
      toolName: "web_search",
      title: "web_search",
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      input: { query: "vitest documentation" },
      details: {
        response: {
          answer: "Vitest provides native ESM and Jest-compatible APIs.",
          sources: [
            {
              title: "Getting Started",
              url: "https://vitest.dev/guide/",
            },
          ],
        },
      },
      output: rawOutput,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const entry = {
      id: "native-search-entry",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "web_search",
      toolTitle: "web_search",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      structuredPayload: item,
    } satisfies ToolWorkEntryCardEntry;

    let queryIsTruncated = false;
    const resizeCallbacks: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        private readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe(target: Element): void {
          Object.defineProperties(target, {
            scrollWidth: { configurable: true, get: () => (queryIsTruncated ? 400 : 100) },
            clientWidth: { configurable: true, value: 100 },
          });
          resizeCallbacks.push(() => this.callback([], this));
        }

        unobserve(_target: Element): void {}
        disconnect(): void {}
      },
    );
    // A layout pass: every observed box reports, as after a resize.
    const reportResize = () => {
      for (const report of resizeCallbacks) report();
    };

    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    expect(mounted.container.querySelector('[data-t3-part="native-search-tool"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain("Vitest provides native ESM");
    expect(mounted.container.textContent).not.toContain("Search engine raw output");
    expect(mounted.container.querySelector('section[aria-label="Output"]')).toBeNull();
    expect(mounted.container.querySelector('button[aria-label="Copy output"]')).toBeNull();
    expect(mounted.container.querySelector("[data-tool-verb]")?.textContent).toBe(
      "Searched the web",
    );
    expect(mounted.container.querySelector("[data-tool-object]")?.textContent).toBe(
      "vitest documentation",
    );
    expect(mounted.container.textContent?.match(/vitest documentation/g)).toHaveLength(1);
    expect(mounted.container.querySelector('[data-section="query"]')).toBeNull();
    expect(mounted.container.querySelector(".native-search-answer-markdown")).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("QUERY");
    expect(mounted.container.textContent).not.toContain("ANSWER");
    expect(mounted.container.textContent).not.toContain("SOURCES");
    const sourceLink = mounted.container.querySelector<HTMLAnchorElement>(
      "[data-native-search-source] a",
    );
    expect(sourceLink?.textContent).toContain("vitest.dev");
    expect(sourceLink?.getAttribute("target")).toBe("_blank");
    expect(sourceLink?.getAttribute("rel")).toBe("noreferrer");
    await act(async () => reportResize());
    expect(mounted.container.querySelector('[data-section="query"]')).toBeNull();
    queryIsTruncated = true;
    await act(async () => reportResize());
    expect(mounted.container.querySelector('[data-section="query"]')?.textContent).toBe(
      "vitest documentation",
    );
    expect(mounted.container.textContent?.match(/vitest documentation/g)).toHaveLength(2);
  });

  it("opens latest tool card by default with autoExpanded true", () => {
    const runningItem = {
      ...commandItem("running tests..."),
      status: "running" as const,
      startedAt: timestamp,
      completedAt: null,
    };
    const entry = {
      id: "latest-running-tool",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "inProgress",
      structuredPayload: runningItem,
    } satisfies ToolWorkEntryCardEntry;

    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    const bodyId = trigger?.getAttribute("aria-controls");
    const panel = mounted.container.querySelector<HTMLElement>(`[id="${bodyId}"]`);
    expect(panel?.getAttribute("aria-hidden")).not.toBe("true");
    expect(panel?.hasAttribute("inert")).toBe(false);
  });

  it("only replays a live step entrance for a first mount or timeline arrival", () => {
    const runningItem = {
      ...commandItem("running tests..."),
      status: "running" as const,
      startedAt: timestamp,
      completedAt: null,
    };
    const entry = {
      id: "live-step-remount",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "inProgress",
      structuredPayload: runningItem,
    } satisfies ToolWorkEntryCardEntry;
    const mounted = mountCard(entry);
    mountedCards.push(mounted);

    expect(mounted.container.querySelector(".step-row-enter")).not.toBeNull();
    act(() => mounted.root.render(null));
    act(() => mounted.root.render(<ToolWorkEntryCard entry={entry} icon={<span />} />));
    expect(mounted.container.querySelector(".step-row-enter")).toBeNull();

    act(() => mounted.root.render(null));
    act(() =>
      mounted.root.render(<ToolWorkEntryCard entry={entry} icon={<span />} enterDelayMs={0} />),
    );
    expect(mounted.container.querySelector(".step-row-enter")).not.toBeNull();
  });

  it("remains open when terminal latest tool completes without successor", () => {
    const completedItem = {
      ...commandItem("all tests passed"),
      status: "completed" as const,
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const entry = {
      id: "terminal-latest-tool",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: completedItem,
    } satisfies ToolWorkEntryCardEntry;

    const mounted = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mounted);

    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    const bodyId = trigger?.getAttribute("aria-controls");
    const panel = mounted.container.querySelector<HTMLElement>(`[id="${bodyId}"]`);
    expect(panel?.getAttribute("aria-hidden")).not.toBe("true");
    expect(panel?.hasAttribute("inert")).toBe(false);
    expect(mounted.container.textContent).toContain("all tests passed");
  });

  it("folds on false default when successor activity advances workflow", async () => {
    const completedItem = {
      ...commandItem("all tests passed", "predecessor-tool"),
      status: "completed" as const,
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const entry = {
      id: "predecessor-tool",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: completedItem,
    } satisfies ToolWorkEntryCardEntry;

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedCards.push({ container, root });

    await act(async () => {
      root.render(<ToolWorkEntryCard entry={entry} icon={<span />} autoExpanded={true} />);
    });

    let trigger = container.querySelector<HTMLButtonElement>("button.tool-header-disclosure");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      root.render(<ToolWorkEntryCard entry={entry} icon={<span />} autoExpanded={false} />);
    });

    trigger = container.querySelector<HTMLButtonElement>("button.tool-header-disclosure");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    const bodyId = trigger?.getAttribute("aria-controls");
    const panel = container.querySelector<HTMLElement>(`[id="${bodyId}"]`);
    if (panel) {
      expect(panel.getAttribute("aria-hidden") === "true" || panel.hasAttribute("inert")).toBe(
        true,
      );
    } else {
      expect(panel).toBeNull();
    }
    expect(container.textContent).not.toContain("all tests passed");
  });

  it("persists explicit user closed and user open overrides across rerender and remount", async () => {
    const entry = {
      id: "override-tool",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: commandItem("done", "override-tool"),
    } satisfies ToolWorkEntryCardEntry;

    const cache = new Set<string>();

    const mounted1 = mountCard(entry, cache, undefined, true);
    mountedCards.push(mounted1);

    const trigger1 = mounted1.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(trigger1?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => dispatchClick(trigger1));
    expect(trigger1?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => mounted1.root.unmount());
    mounted1.container.remove();

    const mounted2 = mountCard(entry, cache, undefined, true);
    mountedCards.push(mounted2);

    const trigger2 = mounted2.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(trigger2?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => dispatchClick(trigger2));
    expect(trigger2?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => mounted2.root.unmount());
    mounted2.container.remove();

    const mounted3 = mountCard(entry, cache, undefined, false);
    mountedCards.push(mounted3);

    const trigger3 = mounted3.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(trigger3?.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not bypass native panes when wrapped in disclosure", async () => {
    const todoPlanItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("todo-plan-item"),
      type: "dynamic_tool",
      title: "Update todo",
      toolName: "todo",
      threadId: ThreadId.make("thread-todo"),
      runId: RunId.make("run-todo"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      input: { todos: [{ id: "1", title: "Implement disclosure", status: "completed" }] },
      details: {
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "Implement disclosure", status: "completed" }],
          },
        ],
      },
      output: "ok",
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const entry = {
      id: "todo-plan-item",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "todo",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      structuredPayload: todoPlanItem,
    } satisfies ToolWorkEntryCardEntry;

    const mountedOpen = mountCard(entry, undefined, undefined, true);
    mountedCards.push(mountedOpen);

    const nativeTodoOpen = mountedOpen.container.querySelector('[data-t3-part="native-todo-tool"]');
    expect(nativeTodoOpen).not.toBeNull();
    const triggerOpen = mountedOpen.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(triggerOpen?.getAttribute("aria-expanded")).toBe("true");

    expect(mountedOpen.container.querySelector('section[aria-label="Output"]')).toBeNull();
    expect(mountedOpen.container.querySelector('button[aria-label="Copy output"]')).toBeNull();

    const mountedClosed = mountCard(entry, undefined, undefined, false);
    mountedCards.push(mountedClosed);

    const triggerClosed = mountedClosed.container.querySelector<HTMLButtonElement>(
      "button.tool-header-disclosure",
    );
    expect(triggerClosed?.getAttribute("aria-expanded")).toBe("false");
    const bodyId = triggerClosed?.getAttribute("aria-controls");
    const panel = mountedClosed.container.querySelector<HTMLElement>(`[id="${bodyId}"]`);
    if (panel) {
      expect(panel.getAttribute("aria-hidden") === "true" || panel.hasAttribute("inert")).toBe(
        true,
      );
    } else {
      expect(panel).toBeNull();
    }
    expect(mountedClosed.container.querySelector('[data-t3-part="native-todo-tool"]')).toBeNull();

    await act(async () => dispatchClick(triggerClosed));
    expect(triggerClosed?.getAttribute("aria-expanded")).toBe("true");
    const openedPanel = mountedClosed.container.querySelector<HTMLElement>(`[id="${bodyId}"]`);
    expect(openedPanel).not.toBeNull();
    expect(openedPanel?.getAttribute("aria-hidden")).not.toBe("true");
    expect(openedPanel?.hasAttribute("inert")).toBe(false);
    expect(
      mountedClosed.container.querySelector('[data-t3-part="native-todo-tool"]'),
    ).not.toBeNull();
  });

  it("hydrates omitted output when autoExpanded is true without manual click, but not when autoExpanded is false", () => {
    const hydratedOutput = "Hydrated full command output";
    const omittedItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("omitted-cmd-item"),
      type: "command_execution",
      threadId: ThreadId.make("thread-omitted-cmd"),
      runId: RunId.make("run-omitted-cmd"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Run omitted command",
      input: "pnpm build",
      output: "",
      outputOmitted: true,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const hydratedItem: OrchestrationV2TurnItem = {
      ...omittedItem,
      outputOmitted: false,
      output: hydratedOutput,
    };
    const detailSource: ToolWorkEntryDetailSource = {
      kind: "projected",
      environmentId: EnvironmentId.make("env-omitted-cmd"),
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: ThreadId.make("thread-omitted-cmd"),
        sourceItemId: TurnItemId.make("omitted-cmd-item"),
        item: omittedItem,
      },
    };
    const entry = {
      id: "omitted-cmd-entry",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm build",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: omittedItem,
    } satisfies ToolWorkEntryCardEntry;

    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => {
      if (atom === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: vi.fn(),
        };
      }
      return {
        data: { item: hydratedItem },
        dataUpdatedAt: Date.now(),
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: vi.fn(),
      };
    });

    const mountedClosed = mountCard(entry, undefined, detailSource, false);
    mountedCards.push(mountedClosed);
    expect(mountedClosed.container.textContent).not.toContain(hydratedOutput);

    const mountedOpen = mountCard(entry, undefined, detailSource, true);
    mountedCards.push(mountedOpen);
    expect(mountedOpen.container.textContent).toContain(hydratedOutput);

    querySpy.mockRestore();
  });

  it("does not fetch omitted details when outer card is closed even if inner output was cached open", () => {
    const hydratedOutput = "Hydrated full command output";
    const omittedItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("omitted-cmd-item-cached"),
      type: "command_execution",
      threadId: ThreadId.make("thread-omitted-cmd"),
      runId: RunId.make("run-omitted-cmd"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Run omitted command",
      input: "pnpm build",
      output: "",
      outputOmitted: true,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const hydratedItem: OrchestrationV2TurnItem = {
      ...omittedItem,
      outputOmitted: false,
      output: hydratedOutput,
    };
    const detailSource: ToolWorkEntryDetailSource = {
      kind: "projected",
      environmentId: EnvironmentId.make("env-omitted-cmd"),
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: ThreadId.make("thread-omitted-cmd"),
        sourceItemId: TurnItemId.make("omitted-cmd-item-cached"),
        item: omittedItem,
      },
    };
    const entry = {
      id: "omitted-cmd-entry-cached",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm build",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: omittedItem,
    } satisfies ToolWorkEntryCardEntry;

    let queriedAtom: unknown = null;
    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => {
      queriedAtom = atom;
      if (atom === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: vi.fn(),
        };
      }
      return {
        data: { item: hydratedItem },
        dataUpdatedAt: Date.now(),
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: vi.fn(),
      };
    });

    const cache = new Set<string>(["tool-output:omitted-cmd-item-cached"]);
    const mountedClosed = mountCard(entry, cache, detailSource, false);
    mountedCards.push(mountedClosed);

    expect(queriedAtom).toBeNull();
    expect(mountedClosed.container.textContent).not.toContain(hydratedOutput);

    querySpy.mockRestore();
  });

  it("headlines a settled tool as past-tense verb and object with an accessible outcome", () => {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("summary-test-item"),
      type: "dynamic_tool",
      title: "Run JavaScript",
      toolName: "javascript",
      threadId: ThreadId.make("thread-summary"),
      runId: RunId.make("run-summary"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      input: { code: "console.log(42)", language: "javascript" },
      output: "42",
      startedAt: DateTime.makeUnsafe("2026-09-05T00:00:00.000Z"),
      completedAt: DateTime.makeUnsafe("2026-09-05T00:00:15.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-09-05T00:00:15.000Z"),
    };
    const entry = {
      id: "summary-test-entry",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "javascript",
      toolTitle: "javascript",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      changedFiles: ["apps/web/src/sample.ts"],
      structuredPayload: item,
    } satisfies ToolWorkEntryCardEntry;

    const mounted = mountCard(entry, undefined, undefined, false);
    mountedCards.push(mounted);

    const trigger = mounted.container.querySelector("button.tool-header-disclosure");
    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector("[data-tool-verb]")?.textContent).toBe("Ran javascript");
    expect(trigger?.querySelector("[data-tool-object]")?.textContent).toBe("console.log(42)");
    expect(trigger?.querySelector(".tool-state")?.textContent).toBe("Completed");
  });

  it("surfaces accessible error when copying summarized input fails, then succeeds on retry", async () => {
    const summarizedInputItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("summarized-input-tool-item"),
      type: "dynamic_tool",
      toolName: "bash",
      title: "Run command",
      threadId: ThreadId.make("thread-input-fail"),
      runId: RunId.make("run-input-fail"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      input: {
        truncated: true,
        summary: "Summarized input snippet",
      },
      output: "command output",
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const hydratedItem: OrchestrationV2TurnItem = {
      ...summarizedInputItem,
      input: "echo 'hydrated full input'",
    };
    const detailSource: ToolWorkEntryDetailSource = {
      kind: "projected",
      environmentId: EnvironmentId.make("env-input-fail"),
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: ThreadId.make("thread-input-fail"),
        sourceItemId: TurnItemId.make("summarized-input-tool-item"),
        item: summarizedInputItem,
      },
    };
    const entry = {
      id: "summarized-input-tool-entry",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      toolTitle: "bash",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      structuredPayload: summarizedInputItem,
    } satisfies ToolWorkEntryCardEntry;

    const refreshSpy = vi.fn();
    let retried = false;
    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => {
      const [, notifyQueryChange] = useReducer((version: number) => version + 1, 0);
      if (atom === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: vi.fn(),
        };
      }
      if (!retried) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: "Failed to load full tool input",
          failure: new Error("Failed to load full tool input"),
          isPending: false,
          isSuccess: false,
          refresh: () => {
            refreshSpy();
            if (refreshSpy.mock.calls.length >= 2) {
              retried = true;
            }
            notifyQueryChange();
          },
        };
      }
      return {
        data: { item: hydratedItem },
        dataUpdatedAt: Date.now(),
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: refreshSpy,
      };
    });

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const mounted = mountCard(entry, undefined, detailSource, true);
    mountedCards.push(mounted);

    const inputSection = mounted.container.querySelector<HTMLElement>(
      'section[aria-label="Input"]',
    );
    expect(inputSection).not.toBeNull();

    const copyInput = inputSection?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy input"]',
    );
    expect(copyInput).not.toBeNull();
    await act(async () => dispatchClick(copyInput));

    const alert = inputSection?.querySelector('.omp-pane-actions [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Could not load tool input.");
    expect(writeText).not.toHaveBeenCalled();
    expect(copyInput?.textContent).not.toContain("Copied");

    await act(async () => dispatchClick(copyInput));

    expect(inputSection?.querySelector('.omp-pane-actions [role="alert"]')).toBeNull();
    expect(writeText).toHaveBeenCalledWith("echo 'hydrated full input'");
    expect(copyInput?.textContent).toContain("Copied");
    expect(refreshSpy).toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it("surfaces accessible error when copying omitted output fails, then succeeds on retry", async () => {
    const omittedOutput = "Hydrated omitted full command output";
    const omittedItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("omitted-output-item-fail"),
      type: "command_execution",
      threadId: ThreadId.make("thread-output-fail"),
      runId: RunId.make("run-output-fail"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Run command",
      input: "pnpm test",
      output: "",
      outputOmitted: true,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const hydratedItem: OrchestrationV2TurnItem = {
      ...omittedItem,
      outputOmitted: false,
      output: omittedOutput,
    };
    const detailSource: ToolWorkEntryDetailSource = {
      kind: "projected",
      environmentId: EnvironmentId.make("env-output-fail"),
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: ThreadId.make("thread-output-fail"),
        sourceItemId: TurnItemId.make("omitted-output-item-fail"),
        item: omittedItem,
      },
    };
    const entry = {
      id: "omitted-output-entry-fail",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: omittedItem,
    } satisfies ToolWorkEntryCardEntry;

    const refreshSpy = vi.fn();
    let retried = false;
    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => {
      const [, notifyQueryChange] = useReducer((version: number) => version + 1, 0);
      if (atom === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: vi.fn(),
        };
      }
      if (!retried) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: "Failed to load full tool output",
          failure: new Error("Failed to load full tool output"),
          isPending: false,
          isSuccess: false,
          refresh: () => {
            refreshSpy();
            if (refreshSpy.mock.calls.length >= 2) {
              retried = true;
            }
            notifyQueryChange();
          },
        };
      }
      return {
        data: { item: hydratedItem },
        dataUpdatedAt: Date.now(),
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: refreshSpy,
      };
    });

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const mounted = mountCard(entry, undefined, detailSource, true);
    mountedCards.push(mounted);

    const outputSection = mounted.container.querySelector<HTMLElement>(
      'section[aria-label="Output"]',
    );
    expect(outputSection).not.toBeNull();

    const copyOutput = outputSection?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy output"]',
    );
    expect(copyOutput).not.toBeNull();
    await act(async () => dispatchClick(copyOutput));

    const alert = outputSection?.querySelector('.omp-pane-actions [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Could not load tool output.");
    expect(writeText).not.toHaveBeenCalled();
    expect(copyOutput?.textContent).not.toContain("Copied");

    await act(async () => dispatchClick(copyOutput));

    expect(outputSection?.querySelector('.omp-pane-actions [role="alert"]')).toBeNull();
    expect(writeText).toHaveBeenCalledWith(omittedOutput);
    expect(copyOutput?.textContent).toContain("Copied");
    expect(refreshSpy).toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it("clears error on identity change and ensures old copy failure does not leak to next card", async () => {
    const omittedItem1: OrchestrationV2TurnItem = {
      id: TurnItemId.make("omitted-card-1"),
      type: "command_execution",
      threadId: ThreadId.make("thread-card-1"),
      runId: RunId.make("run-card-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Run command 1",
      input: "pnpm test",
      output: "",
      outputOmitted: true,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const detailSource1: ToolWorkEntryDetailSource = {
      kind: "projected",
      environmentId: EnvironmentId.make("env-card-1"),
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: ThreadId.make("thread-card-1"),
        sourceItemId: TurnItemId.make("omitted-card-1"),
        item: omittedItem1,
      },
    };
    const entry1 = {
      id: "entry-card-1",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm test",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: omittedItem1,
    } satisfies ToolWorkEntryCardEntry;

    // The real query reports pending after refresh() and then settles; the
    // test steps through those phases by re-rendering.
    let detailPhase: "failed" | "pending" = "failed";
    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => {
      if (atom === null || detailPhase === "pending") {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: atom !== null,
          isSuccess: false,
          refresh: vi.fn(),
        };
      }
      return {
        data: null,
        dataUpdatedAt: 0,
        error: "Failed to load details",
        failure: new Error("Failed to load details"),
        isPending: false,
        isSuccess: false,
        refresh: vi.fn(),
      };
    });
    const renderCard1 = () =>
      act(async () =>
        mounted1.root.render(
          <ToolWorkEntryCard
            entry={entry1}
            icon={<span />}
            detailSource={detailSource1}
            autoExpanded
          />,
        ),
      );

    const mounted1 = mountCard(entry1, undefined, detailSource1, true);
    mountedCards.push(mounted1);

    const outputSection1 = mounted1.container.querySelector<HTMLElement>(
      'section[aria-label="Output"]',
    );
    const copyOutput1 = outputSection1?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy output"]',
    );
    await act(async () => dispatchClick(copyOutput1));
    detailPhase = "pending";
    await renderCard1();
    detailPhase = "failed";
    await renderCard1();

    expect(
      outputSection1?.querySelector('.omp-pane-actions [role="alert"]')?.textContent,
    ).toContain("Could not load tool output.");

    const normalItem2: OrchestrationV2TurnItem = {
      id: TurnItemId.make("normal-card-2"),
      type: "command_execution",
      threadId: ThreadId.make("thread-card-2"),
      runId: RunId.make("run-card-2"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Run command 2",
      input: "pnpm build",
      output: "build output clean",
      outputOmitted: false,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const entry2 = {
      id: "entry-card-2",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "bash",
      tone: "tool",
      command: "pnpm build",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      structuredPayload: normalItem2,
    } satisfies ToolWorkEntryCardEntry;

    const mounted2 = mountCard(entry2, undefined, undefined, true);
    mountedCards.push(mounted2);

    expect(mounted2.container.querySelector('[role="alert"]')).toBeNull();
    querySpy.mockRestore();
  });

  it("distinguishes input and output errors when both copy requests fail", async () => {
    const dualOmittedItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("dual-omitted-item"),
      type: "dynamic_tool",
      toolName: "javascript",
      title: "Execute JS",
      threadId: ThreadId.make("thread-dual-fail"),
      runId: RunId.make("run-dual-fail"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      input: {
        truncated: true,
        summary: "Truncated code summary",
      },
      output: "",
      outputOmitted: true,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const detailSource: ToolWorkEntryDetailSource = {
      kind: "projected",
      environmentId: EnvironmentId.make("env-dual-fail"),
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: ThreadId.make("thread-dual-fail"),
        sourceItemId: TurnItemId.make("dual-omitted-item"),
        item: dualOmittedItem,
      },
    };
    const entry = {
      id: "dual-omitted-entry",
      createdAt: "2026-09-05T00:00:00.000Z",
      label: "javascript",
      toolTitle: "javascript",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      structuredPayload: dualOmittedItem,
    } satisfies ToolWorkEntryCardEntry;

    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => {
      if (atom === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: vi.fn(),
        };
      }
      return {
        data: null,
        dataUpdatedAt: 0,
        error: "Failed to load details",
        failure: new Error("Failed to load details"),
        isPending: false,
        isSuccess: false,
        refresh: vi.fn(),
      };
    });

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const mounted = mountCard(entry, undefined, detailSource, true);
    mountedCards.push(mounted);

    const inputSection = mounted.container.querySelector<HTMLElement>(
      'section[aria-label="Input"]',
    );
    const outputSection = mounted.container.querySelector<HTMLElement>(
      'section[aria-label="Output"]',
    );
    const copyInput = inputSection?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy input"]',
    );
    const copyOutput = outputSection?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy output"]',
    );
    expect(copyInput).not.toBeNull();
    expect(copyOutput).not.toBeNull();

    await act(async () => dispatchClick(copyInput));
    await act(async () => dispatchClick(copyOutput));

    const inputAlert = inputSection?.querySelector('.omp-pane-actions [role="alert"]');
    const outputAlert = outputSection?.querySelector('.omp-pane-actions [role="alert"]');
    expect(inputAlert?.textContent).toContain("Could not load tool input.");
    expect(outputAlert?.textContent).toContain("Could not load tool output.");

    expect(writeText).not.toHaveBeenCalled();
    expect(copyInput?.textContent).not.toContain("Copied");
    expect(copyOutput?.textContent).not.toContain("Copied");

    querySpy.mockRestore();
  });
  it("keeps hydrated output visible through a revision refresh without leaking it into another source", async () => {
    const original = commandItem("Compiler finished: 41 modules", "revision-command");
    let wireItem = { ...original, output: "", outputOmitted: true };
    let hydrated: OrchestrationV2TurnItem | null = original;
    let environmentId = EnvironmentId.make("revision-environment");
    const querySpy = vi.spyOn(query, "useEnvironmentQuery").mockImplementation((atom) => ({
      data: atom !== null && hydrated !== null ? { item: hydrated } : null,
      dataUpdatedAt: 0,
      error: null,
      failure: null,
      isPending: atom !== null && hydrated === null,
      isSuccess: atom !== null && hydrated !== null,
      refresh: vi.fn(),
    }));
    const mounted = { container: document.createElement("div") };
    document.body.append(mounted.container);
    const root = createRoot(mounted.container);
    mountedCards.push({ container: mounted.container, root });
    const render = () =>
      act(async () => {
        root.render(
          <ToolWorkEntryCard
            entry={{
              id: "revision-entry",
              createdAt: "2026-09-05T00:00:00.000Z",
              label: "bash",
              tone: "tool",
              command: "pnpm test",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              structuredPayload: wireItem,
            }}
            icon={<span />}
            autoExpanded
            detailSource={{
              kind: "projected",
              environmentId,
              projectedItem: {
                position: 0,
                visibility: "local",
                sourceThreadId: wireItem.threadId,
                sourceItemId: wireItem.id,
                item: wireItem,
              },
            }}
          />,
        );
      });
    try {
      await render();
      expect(mounted.container.textContent).toContain(original.output);

      wireItem = { ...wireItem, updatedAt: DateTime.makeUnsafe("2026-09-05T00:00:01.000Z") };
      hydrated = null;
      await render();
      expect(mounted.container.textContent).toContain(original.output);

      hydrated = { ...wireItem, output: "Compiler finished: 42 modules", outputOmitted: false };
      await render();
      expect(mounted.container.textContent).toContain("Compiler finished: 42 modules");
      expect(mounted.container.textContent).not.toContain(original.output);

      environmentId = EnvironmentId.make("different-environment");
      hydrated = null;
      await render();
      expect(mounted.container.textContent).not.toContain("Compiler finished: 42 modules");
    } finally {
      querySpy.mockRestore();
    }
  });
});
