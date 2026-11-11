// @vitest-environment jsdom

import {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { TimelineActivityGroup } from "./timelineActivity";
import { RegistryContext } from "@effect/atom-react";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  act,
  createRef,
  useLayoutEffect,
  type ReactNode,
  type Ref,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { environmentThreadDetails } from "../../state/threads";
import type { TimelineEntry } from "../../session-logic";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

const activityTestState = vi.hoisted(() => ({
  expanded: false,
  expandedRuns: false,
  subagentTooltips: false,
}));
// The list mock mounts every row from `from` on, standing in for virtualization.
const legendListWindow = vi.hoisted(() => ({ from: 0 }));

// Expose tooltip contents in the renderer without requiring a browser portal.
vi.mock("../ui/tooltip", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ui/tooltip")>();
  return {
    ...original,
    Tooltip: (props: { children?: ReactNode }) =>
      activityTestState.subagentTooltips ? props.children : <original.Tooltip {...props} />,
    TooltipTrigger: (props: { children?: ReactNode; render?: ReactElement }) =>
      activityTestState.subagentTooltips ? (
        <>
          {props.render}
          {props.children}
        </>
      ) : (
        <original.TooltipTrigger {...props} />
      ),
    TooltipPopup: (props: { children?: ReactNode }) =>
      activityTestState.subagentTooltips ? props.children : <original.TooltipPopup {...props} />,
  };
});

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("./MessagesTimeline.logic", async (importOriginal) => {
  const logic = await importOriginal<typeof import("./MessagesTimeline.logic")>();
  return {
    ...logic,
    deriveMessagesTimelineRowsWithState(
      input: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[0],
      previous: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[1],
    ) {
      if (activityTestState.expandedRuns) {
        input = { ...input, expandedRunIds: new Set([RunId.make("run-1")]) };
      }
      const projection = logic.deriveMessagesTimelineRowsWithState(input, previous);
      if (!activityTestState.expanded) return projection;
      return logic.deriveMessagesTimelineRowsWithState({
        ...input,
        expandedWorkGroupIds: new Set(
          projection.rows.flatMap((row) =>
            row.kind === "work-toggle" || row.kind === "work-live" ? [row.groupId] : [],
          ),
        ),
      });
    },
  };
});

beforeEach(() => {
  legendListWindow.from = 0;
  activityTestState.subagentTooltips = false;
  activityTestState.expanded = false;
  activityTestState.expandedRuns = false;
});

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    getItemType?: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      anchorMaxSize?: number;
      anchorOffset?: number;
      onReady?: (info: { anchorIndex: number }) => void;
      onSizeChanged?: (size: number) => void;
    };
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: boolean;
        };
    className?: string;
    contentInsetEndAdjustment?: number;
    ref?: Ref<LegendListRef>;
  }) => {
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onSizeChanged?.(240);
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    return (
      <div
        data-testid={legendListTestId}
        data-class-name={props.className}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
        data-maintain-visible-content-position-restore={
          typeof props.maintainVisibleContentPosition === "object"
            ? Boolean(props.maintainVisibleContentPosition.shouldRestorePosition)
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.slice(legendListWindow.from).map((item) => (
          <div key={props.keyExtractor(item)} data-item-type={props.getItemType?.(item)}>
            {props.renderItem({ item })}
          </div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;
let resolvePreviewAnnotationImage: typeof import("./MessagesTimeline").resolvePreviewAnnotationImage;

const ElementStub = class ElementStub {};
function stubDomGlobals() {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("Element", ElementStub);
  vi.stubGlobal("getComputedStyle", undefined);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    Element: ElementStub,
    localStorage: globalThis.localStorage,
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
}

beforeEach(stubDomGlobals);
beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true });
  ({ MessagesTimeline, resolvePreviewAnnotationImage } = await import("./MessagesTimeline"));
}, 30_000);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

describe("timeline tooltip scroll dismissal", () => {
  it.each([
    "hover",
    "delayed hover",
    "focus",
    "hover then focus",
    "outside timeline",
    "wheel without scroll",
    "pr hover",
    "pr delayed hover",
    "pr focus",
    "pr hover then focus",
  ])("handles %s through the real tooltip interactions", async (scenario) => {
    const isPullRequest = scenario.startsWith("pr ");
    const interaction = isPullRequest ? scenario.slice(3) : scenario;
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const { Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea } =
      await vi.importActual<typeof import("../ui/tooltip")>("../ui/tooltip");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onMouseEnter = vi.fn();
    const query = await import("~/state/query");
    const querySpy = isPullRequest
      ? vi.spyOn(query, "useEnvironmentQuery").mockReturnValue({
          data: null,
          dataUpdatedAt: 0,
          error: "Pull request not found",
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: vi.fn(),
        })
      : null;
    const { PullRequestLinkPreview } = await import("../pullRequest/PullRequestLinkPreview");
    const tooltip = isPullRequest ? (
      <PullRequestLinkPreview
        link={<button onMouseEnter={onMouseEnter}>message link</button>}
        originalUrl="https://example.com"
        target={{
          environmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "pingdotgg/t3code",
            number: 1,
          },
        }}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger delay={50} onMouseEnter={onMouseEnter}>
          message link
        </TooltipTrigger>
        <TooltipPopup>https://example.com</TooltipPopup>
      </Tooltip>
    );
    try {
      await act(async () => {
        root.render(
          <>
            <TooltipScrollDismissArea>
              <div data-testid="scrollable">
                {interaction === "outside timeline" ? null : tooltip}
              </div>
            </TooltipScrollDismissArea>
            {interaction === "outside timeline" ? tooltip : null}
          </>,
        );
      });
      const trigger = container.querySelector<HTMLButtonElement>("button")!;
      const scrollable = container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
      await act(async () => {
        if (interaction !== "focus") {
          trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          trigger.dispatchEvent(new MouseEvent("mouseenter"));
          trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        }
        if (interaction === "focus" || interaction === "hover then focus") {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
          trigger.focus();
        }
        if (interaction !== "delayed hover") {
          await vi.advanceTimersByTimeAsync(isPullRequest ? 400 : 60);
        }
      });
      expect(onMouseEnter).toHaveBeenCalledTimes(interaction === "focus" ? 0 : 1);
      expect(
        document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null,
      ).toBe(interaction === "delayed hover" ? null : "https://example.com");

      await act(async () => {
        scrollable.dispatchEvent(
          interaction === "wheel without scroll"
            ? new WheelEvent("wheel", { bubbles: true, deltaY: 100 })
            : new Event("scroll"),
        );
        await vi.advanceTimersByTimeAsync(isPullRequest ? 1000 : 100);
      });
      expect(
        document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null,
      ).toBe(
        interaction === "hover" || interaction === "delayed hover" ? null : "https://example.com",
      );
      if (interaction === "focus" || interaction === "hover then focus") {
        expect(document.activeElement).toBe(trigger);
      }
    } finally {
      await act(async () => root.unmount());
      querySpy?.mockRestore();
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    providerStatuses: [],
    runs: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string, entryId = "entry-1", messageId = "message-1") {
  return {
    id: entryId,
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make(messageId),
      role: "user" as const,
      text,
      runId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string, entryId = "entry-1", messageId = "message-1") {
  const entry = buildUserTimelineEntry(text, entryId, messageId);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

function buildSnapShotTimelineEntry(previewUrl?: string) {
  const entry = buildUserTimelineEntry("First prompt.");
  return {
    ...entry,
    message: {
      ...entry.message,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          ...(previewUrl ? { previewUrl } : {}),
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-03-17T19:12:28.000Z",
            appName: "Terminal",
            windowTitle: "t3code — Tests",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    },
  };
}

// Snapshot Markdown compiles in an effect, so these tests need mounted DOM output.

type MountedTimeline = {
  container: HTMLDivElement;
  root: Root;
};

async function mountTimeline(element: ReactElement): Promise<MountedTimeline> {
  vi.unstubAllGlobals();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(element);
    });
    return { container, root };
  } catch (error) {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    throw error;
  }
}

async function waitForTimelineMarkdown(
  container: HTMLElement,
  ready: (container: HTMLElement) => boolean,
) {
  const deadline = Date.now() + 10_000;
  while (true) {
    if (container.querySelector("[data-markdown-error]")) {
      throw new Error("Timeline Markdown compilation failed");
    }
    if (!container.querySelector("[data-markdown-pending]") && ready(container)) return;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for compiled timeline Markdown");
    }
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function unmountTimeline({ container, root }: MountedTimeline) {
  try {
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
}

async function renderTimelineToMarkupAfterMarkdown(
  element: ReactElement,
  ready: (container: HTMLElement) => boolean,
) {
  const mounted = await mountTimeline(element);
  try {
    await waitForTimelineMarkdown(mounted.container, ready);
    return mounted.container.innerHTML;
  } finally {
    await unmountTimeline(mounted);
  }
}

function findWorkEntryDisclosure(container: HTMLElement, expanded: boolean) {
  const disclosure = Array.from(
    container.querySelectorAll<HTMLElement>('[role="button"], .tool-header-disclosure'),
  ).find(
    (node) =>
      node.getAttribute("aria-expanded") === String(expanded) &&
      (node.getAttribute("aria-label")?.trim().length ?? 0) > 0,
  );
  if (!disclosure) throw new Error(`No ${expanded ? "expanded" : "collapsed"} work disclosure`);
  return disclosure;
}

describe("MessagesTimeline", () => {
  it("buckets messages by role and logarithmic text length", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry("x".repeat(999), "entry-short", "message-short"),
          buildUserTimelineEntry("x".repeat(2000), "entry-long", "message-long"),
          buildAssistantTimelineEntry("x".repeat(2000), "entry-assistant", "message-assistant"),
        ]}
      />,
    );

    expect(markup).toContain('data-item-type="message:user:0"');
    expect(markup).toContain('data-item-type="message:user:1"');
    expect(markup).toContain('data-item-type="message:assistant:1"');
  });

  it("shows dynamic tool input without cached output when the row is expanded", async () => {
    activityTestState.expanded = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[
              {
                id: "tool-with-cached-output",
                kind: "work",
                createdAt: MESSAGE_CREATED_AT,
                entry: {
                  id: "tool-with-cached-output",
                  createdAt: MESSAGE_CREATED_AT,
                  label: "Example tool",
                  toolTitle: "Example tool",
                  tone: "tool",
                  itemType: "dynamic_tool",
                  toolLifecycleStatus: "completed",
                  toolData: {
                    input: { query: "KEEP_TOOL_INPUT" },
                    output: { text: "RAW_CACHED_TOOL_OUTPUT" },
                  },
                },
              },
            ]}
          />,
        );
      });
      const cardToggle = renderer!.root.find(
        (node) => node.type === "button" && node.props.className === "tool-header-disclosure",
      );
      if (cardToggle && cardToggle.props["aria-expanded"] === false) {
        await act(() => cardToggle.props.onClick());
      }
      const textOf = (node: ReactTestRenderer["root"]) =>
        node
          .findAll(() => true)
          .flatMap((child) => child.children)
          .filter((child) => typeof child === "string")
          .join(" ");
      const inputPane = renderer!.root.find(
        (node) => node.type === "section" && node.props["aria-label"] === "Input",
      );
      expect(textOf(inputPane)).toContain("KEEP_TOOL_INPUT");
      expect(textOf(renderer!.root)).not.toContain("RAW_CACHED_TOOL_OUTPUT");
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("leads an unanswered question row with the question text", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[
              {
                id: "question-entry",
                kind: "work",
                createdAt: MESSAGE_CREATED_AT,
                entry: {
                  id: "question-work",
                  createdAt: MESSAGE_CREATED_AT,
                  label: "User input requested",
                  tone: "tool",
                  questionAnswer: {
                    requestId: ApprovalRequestId.make("question-request"),
                    answers: {},
                    questionTextById: { scope: "Which repository?" },
                    attachmentsByQuestionId: {},
                  },
                },
              },
            ]}
          />,
        );
      });
      const questionToggle = renderer!.root.find(
        (node) =>
          node.props["aria-label"] === "Which repository?" && node.props["aria-expanded"] === false,
      );
      const markup = JSON.stringify(renderer!.toJSON());
      // Heading + accessible label.
      expect(markup.match(/Which repository\?/g)).toHaveLength(2);
      await act(() => questionToggle.props.onClick());
      // Expanded history adds a third occurrence alongside heading and label.
      expect(JSON.stringify(renderer!.toJSON()).match(/Which repository\?/g)).toHaveLength(3);
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it.each([
    { toolLifecycleStatus: "inProgress", isAtEnd: true },
    { toolLifecycleStatus: "inProgress", isAtEnd: false },
    { toolLifecycleStatus: "completed", isAtEnd: true },
    { toolLifecycleStatus: "completed", isAtEnd: false },
  ] as const)(
    "restores the composer after closing $toolLifecycleStatus tool output only at the end: $isAtEnd",
    async ({ toolLifecycleStatus, isAtEnd }) => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const flushFrame = () =>
        act(() => {
          const callbacks = [...frames.values()];
          frames.clear();
          callbacks.forEach((callback) => callback(0));
        });
      const props = buildProps();
      const runId = RunId.make("tool-output-run");
      let timelineIsAtEnd = isAtEnd;
      props.listRef.current = {
        getState: () => ({ isAtEnd: timelineIsAtEnd }),
        getScrollableNode: () => null,
      } as unknown as LegendListRef;
      let isResting = false;
      let composerState: ReturnType<typeof useComposerFocusState> | undefined;
      function ThreadProbe() {
        const composer = useComposerFocusState();
        useLayoutEffect(() => {
          composerState = composer;
          isResting = shouldUseRestingComposerLayout({
            isExistingThread: true,
            isMobileViewport: false,
            isScrollCollapsed: composer.isComposerScrollCollapsed,
            hasExpandedChrome: false,
            hasMultilinePrompt: false,
            timelineOverflows: true,
          });
        });
        return (
          <MessagesTimeline
            {...props}
            isWorking={toolLifecycleStatus === "inProgress"}
            runningRunId={toolLifecycleStatus === "inProgress" ? runId : null}
            onToolOutputCollapsedAtEnd={composer.restoreAfterTimelineReachedEnd}
            timelineEntries={[
              {
                id: "running-tool",
                kind: "work",
                createdAt: MESSAGE_CREATED_AT,
                entry: {
                  id: "running-tool",
                  ...(toolLifecycleStatus === "inProgress" ? { runId } : {}),
                  createdAt: MESSAGE_CREATED_AT,
                  label: "Run command",
                  tone: "tool",
                  toolLifecycleStatus,
                  detail: "Command output",
                },
              },
            ]}
          />
        );
      }
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(() => {
          renderer = create(<ThreadProbe />);
        });
        // The user scrolled up to read, so the composer is resting.
        await act(() => composerState!.setIsComposerScrollCollapsed(true));
        const getToggle = () => {
          const toggle = renderer!.root.findAll(
            (node) =>
              typeof node.type === "string" && typeof node.props["aria-expanded"] === "boolean",
          )[0];
          if (toggle === undefined) throw new Error("Missing work disclosure");
          return toggle;
        };
        let toggle = getToggle();
        if (toggle.props["aria-expanded"] === false) {
          await act(() => toggle.props.onClick());
          await flushFrame();
          await flushFrame();
        }
        expect(isResting).toBe(true);

        timelineIsAtEnd = false;
        toggle = getToggle();
        await act(() => toggle.props.onClick());
        await flushFrame();
        timelineIsAtEnd = isAtEnd;
        await flushFrame();
        expect(isResting).toBe(!isAtEnd);
      } finally {
        await act(() => renderer?.unmount());
      }
    },
  );

  it("preserves arbitrary XML-like tags and comparisons in rendered user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Without reading a file, do you have <global-agent-instructions scope="workspace">',
              'Before <nested data-value="a&b">inside</nested> after',
              "</global-agent-instructions> in your context?",
              "Comparison: 2 < 3 and 5 > 4.",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;global-agent-instructions scope=&quot;workspace&quot;&gt;");
    expect(markup).toContain(
      "Before &lt;nested data-value=&quot;a&amp;b&quot;&gt;inside&lt;/nested&gt; after",
    );
    expect(markup).toContain("&lt;/global-agent-instructions&gt; in your context?");
    expect(markup).toContain("Comparison: 2 &lt; 3 and 5 &gt; 4.");
  });

  it("preserves XML-like source inside user code spans and fences", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Inline `<tag attr="x">`',
              "",
              "```xml",
              '<root><child enabled="true" /></root>',
              "```",
            ].join("\n"),
          ),
        ]}
      />,
      (container) =>
        Array.from(container.querySelectorAll("code")).some(
          (code) => code.textContent === '<tag attr="x">',
        ),
    );

    const document = new DOMParser().parseFromString(markup, "text/html");
    expect(
      [...document.querySelectorAll("code")].some((code) => code.textContent === '<tag attr="x">'),
    ).toBe(true);
    expect(document.querySelector("pre code")?.textContent).toContain(
      '<root><child enabled="true" /></root>',
    );
  }, 20_000);

  it("does not render markdown title attributes in user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip")',
          ),
        ]}
      />,
      (container) =>
        container.querySelector('a[href="https://example.com"]') !== null &&
        container.querySelector('img[src="https://example.com/image.png"]') !== null,
    );

    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('src="https://example.com/image.png"');
    expect(markup).not.toContain('title="link tip"');
    expect(markup).not.toContain('title="image tip"');
  }, 20_000);

  it("continues to render sanitized raw HTML in assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry("<details><summary>More</summary>Details</details>"),
        ]}
      />,
      (container) => container.querySelector('[data-markdown-details=""]') !== null,
    );

    expect(markup).toContain('data-markdown-details=""');
    expect(markup).toContain("More");
    expect(markup).not.toContain("&lt;details&gt;");
  }, 20_000);

  it("sanitizes executable HTML while preserving supported assistant markup", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry(
            [
              '<details open onclick="globalThis.__t3Xss = 1">',
              "<summary>Safe details</summary>",
              "<script>globalThis.__t3Xss = 2</script>",
              '<img src="x" onerror="globalThis.__t3Xss = 3">',
              '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
              "</details>",
            ].join(""),
          ),
        ]}
      />,
      (container) => container.querySelector('[data-markdown-details=""]') !== null,
    );

    expect(markup).toContain('data-markdown-details=""');
    expect(markup).toContain("Safe details");
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toContain("onclick=");
    expect(markup).not.toContain("onerror=");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("globalThis.__t3Xss");
  }, 20_000);

  it("renders unsafe user HTML as inert source text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;script&gt;globalThis.__t3Xss = 1&lt;/script&gt;");
    expect(markup).toContain(
      "&lt;img src=&quot;x&quot; onerror=&quot;globalThis.__t3Xss = 2&quot;&gt;",
    );
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toMatch(/<img(?:\s|>)/i);
  });

  it("renders progressive history controls ahead of the bounded timeline", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Recent activity")]}
        historyControls={{
          hasMoreHistory: true,
          loading: false,
          error: "Earlier activity could not be loaded.",
          onLoadEarlier: () => {},
        }}
      />,
    );

    expect(markup).toContain('aria-label="Load earlier turns"');
    expect(markup).toContain("Load earlier turns");
    expect(markup).toContain("Earlier activity could not be loaded.");
    expect(markup.indexOf("Load earlier turns")).toBeLessThan(markup.indexOf("Recent activity"));
  });

  it("keeps an empty bounded timeline actionable while earlier history loads", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[]}
        historyControls={{
          hasMoreHistory: true,
          loading: true,
          error: null,
          onLoadEarlier: () => {},
        }}
      />,
    );

    expect(markup).toContain("Loading earlier turns…");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Send a message to start the conversation.");
  });

  it("uses the larger leading inset only when the top fade is enabled", () => {
    const timelineEntries = [buildUserTimelineEntry("Hello")];

    const compactMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
    );
    const fadedMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} topFadeEnabled />,
    );

    expect(compactMarkup).toContain('class="h-3 sm:h-4"');
    expect(compactMarkup).not.toContain("topbar-scroll-fade");
    expect(fadedMarkup).toContain('class="h-[var(--workspace-titlebar-scroll-fade-height)]"');
    expect(fadedMarkup).toContain("topbar-scroll-fade");
  });

  it("treats the follow re-arm band above the content bottom as the live edge", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapNavigationInteractive,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
    // Within the pixel band above the content bottom counts as the end...
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 1170,
        scrollLength: 800,
      }),
    ).toBe(true);
    // ...but half a viewport up (LegendList's isNearEnd territory) does not.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 900,
        scrollLength: 800,
      }),
    ).toBe(false);
    // LegendList can report at-end while the composer still covers the last row.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: true,
        contentLength: 2100,
        scroll: 1170,
        scrollLength: 800,
      }),
    ).toBe(false);
    // Geometry missing (older state shape): fall back to the nearEnd/strict flags.
    expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(false);
    expect(resolveTimelineIsAtEnd({ isAtEnd: false })).toBe(false);

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    // Comfortable width: the column is capped at 768px.
    expect(resolveTimelineMinimapHasPersistentGutter(832, 768)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863, 768)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864, 768)).toBe(true);
    // Wider Chat width settings consume the gutter the minimap relies on.
    expect(resolveTimelineMinimapHasPersistentGutter(1400, 1152)).toBe(true);
    expect(resolveTimelineMinimapHasPersistentGutter(1200, 1152)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(2560, 2560)).toBe(false);

    // No usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768, 768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(792, 768)).toBe(0);
    // Partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820, 768)).toBe(14);
    // Full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872, 768)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(1400, 768)).toBe(40);
    // Full Chat width: the column spans the viewport, so the strip is inert
    // however wide the window gets.
    expect(resolveTimelineMinimapHitStripWidth(2560, 2560)).toBe(0);
    // Wide Chat width on a window just wider than the column: partial strip.
    expect(resolveTimelineMinimapHitStripWidth(1204, 1152)).toBe(14);
    expect(resolveTimelineMinimapHitStripWidth(0, 0)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN, 768)).toBe(0);

    // Prev/next buttons reach 14px past the strip's left edge; a narrower
    // strip means they would sit on the content column.
    expect(resolveTimelineMinimapNavigationInteractive(40)).toBe(true);
    expect(resolveTimelineMinimapNavigationInteractive(14)).toBe(true);
    expect(resolveTimelineMinimapNavigationInteractive(8)).toBe(false);
    expect(resolveTimelineMinimapNavigationInteractive(0)).toBe(false);

    // The collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40);
    expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe("22rem");
  });

  it("anchors a sent attachment message using its measured height", () => {
    const onAnchorReady = vi.fn();
    const onAnchorSizeChanged = vi.fn();
    // Since #7897 only the first user row after the live edge may anchor, so
    // the preceding row is an assistant reply rather than an older prompt.
    const firstEntry = buildAssistantTimelineEntry("Earlier reply.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
        attachments: [
          {
            type: "image" as const,
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={secondEntry.message.id}
        onAnchorReady={onAnchorReady}
        onAnchorSizeChanged={onAnchorSizeChanged}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    );

    expect(markup).toContain('data-anchor-index="1"');
    expect(markup).toContain('data-anchor-offset="24"');
    expect(markup).toContain('data-anchor-on-ready="true"');
    expect(markup).not.toContain("data-anchor-max-size=");
    expect(markup).toContain('data-content-inset-end="144"');
    expect(markup).toContain("[overflow-anchor:none]");
    expect(markup).toContain('data-maintain-visible-content-position="object"');
    expect(markup).toContain('data-maintain-visible-content-position-data="true"');
    expect(markup).toContain('data-maintain-visible-content-position-size="true"');
    expect(markup).toContain('data-maintain-visible-content-position-restore="true"');
    expect(onAnchorReady).toHaveBeenCalledOnce();
    expect(onAnchorReady).toHaveBeenCalledWith(secondEntry.message.id, 1);
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(secondEntry.message.id, 240);
  });

  it("renders SnapShot window details after the preview resolves", () => {
    const onAnchorReady = vi.fn();
    const firstEntry = buildSnapShotTimelineEntry("data:image/png;base64,iVBORw0KGgo=");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        onAnchorReady={onAnchorReady}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry]}
      />,
    );

    expect(markup).toContain("Terminal");
    expect(markup).toContain("t3code — Tests");
    expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
    expect(onAnchorReady).toHaveBeenCalledOnce();
    expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0);
  });

  it("does not render SnapShot window details before the preview resolves", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[buildSnapShotTimelineEntry()]} />,
    );

    expect(markup).toContain("screenshot.png");
    expect(markup).not.toContain("Terminal");
    expect(markup).not.toContain("t3code — Tests");
    expect(markup).not.toContain('src="data:image/png;base64,aWNvbg=="');
    expect(markup).not.toContain("h-28 w-52 max-w-full");
  });

  it("does not reserve end space for a follow-up user message", () => {
    const onAnchorReady = vi.fn();
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={secondEntry.message.id}
        onAnchorReady={onAnchorReady}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    );

    expect(markup).not.toContain("data-anchor-index=");
    // Following the end: the end pin owns the offset, so the list keeps
    // nothing in place.
    expect(markup).toContain('data-maintain-visible-content-position="false"');
    expect(onAnchorReady).not.toHaveBeenCalled();
  });

  it("offers preview and download actions for PDF attachments", () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-report-pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            previewUrl: "https://environment.test/api/assets/report.pdf",
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain('aria-label="Preview report.pdf"');
    expect(markup).toContain('aria-label="Download report.pdf"');
    expect(markup).not.toContain('alt="report.pdf"');
  });

  it("renders a file download button without creating its URL in advance", () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-report-pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain('aria-label="Preview report.pdf"');
    expect(markup).toContain('aria-label="Download report.pdf"');
    expect(markup).not.toContain("<a ");
  });

  it("does not download an optimistic file before the server supplies its attachment ID", () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "composer-local-report",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            downloadable: false,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain("report.pdf");
    expect(markup).not.toContain('aria-label="Download report.pdf"');
  });

  it("renders unknown attachment types as inert rows instead of crashing", () => {
    const entry = {
      ...buildUserTimelineEntry("Play the recording."),
      message: {
        ...buildUserTimelineEntry("Play the recording.").message,
        attachments: [
          {
            // A newer server can introduce attachment types this build does
            // not know. They ride the open contract member.
            type: "recording",
            id: "attachment-voice-memo",
            name: "voice-memo.ogg",
            mimeType: "audio/ogg",
            sizeBytes: 42,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain("voice-memo.ogg");
    expect(markup).not.toContain('aria-label="Download voice-memo.ogg"');
    expect(markup).not.toContain('alt="voice-memo.ogg"');
    expect(markup).not.toContain("<a ");
  });

  it("keeps reserved end space when tool work starts while reading history", () => {
    const runId = RunId.make("run-with-active-tool");
    const firstEntry = buildUserTimelineEntry("Run the command.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        latestRun={{
          runId,
          status: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        anchorMessageId={firstEntry.message.id}
        liveFollowEnabled={false}
        timelineEntries={[
          firstEntry,
          {
            id: "entry-active-tool",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-active-tool",
              createdAt: MESSAGE_CREATED_AT,
              runId,
              label: "Run command",
              tone: "tool",
              itemType: "command_execution",
              command: "git status",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-anchor-index="0"');
    expect(markup).toContain('data-maintain-visible-content-position="object"');
  });
  it("keeps the root work duration frozen after native execution ends", async () => {
    const queuedRunId = RunId.make("run-queued-after-native-end");
    const startedAt = "2026-10-13T12:00:00.000Z";
    const workCompletedAt = "2026-10-13T12:00:15.000Z";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:20.000Z"));
    let renderer: ReactTestRenderer | undefined;
    const renderTimeline = () => (
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt={startedAt}
        activityStatus="finishing"
        activityRunWorkCompletedAt={workCompletedAt}
        latestRun={{
          runId: queuedRunId,
          status: "queued",
          startedAt: null,
          completedAt: null,
          workCompletedAt: null,
        }}
        runningRunId={null}
        timelineEntries={[]}
      />
    );
    const elapsedText = () => {
      const statusRow = renderer!.root.findByProps({ "data-t3-part": "timeline-status" });
      return statusRow
        .findAll(
          (node) =>
            node.type === "span" &&
            typeof node.props.className === "string" &&
            node.props.className.includes("tabular-nums"),
        )[0]
        ?.children.join("");
    };

    try {
      await act(async () => {
        renderer = create(renderTimeline());
      });
      expect(elapsedText()).toBe("15s");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(elapsedText()).toBe("15s");
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("treats history mounted by scrolling back as seen, not as arriving rows", async () => {
    const reply = (n: number) => {
      const base = buildAssistantTimelineEntry(`Reply ${n}.`);
      return {
        ...base,
        id: `entry-${n}`,
        message: { ...base.message, id: MessageId.make(`message-${n}`) },
      };
    };
    const history = [reply(1), reply(2), reply(3)];
    // An arriving frame opens from zero height, so it is the only reply frame gliding.
    const glidingReplies = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll(".messages-timeline-row-frame[data-glide]"),
        (frame) => frame.textContent?.match(/Reply \d/)?.[0],
      ).filter((reply) => reply !== undefined);
    const renderTimeline = (timelineEntries: typeof history) => (
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        timelineEntries={timelineEntries}
      />
    );

    // Live, with only the newest reply mounted.
    legendListWindow.from = 2;
    const mounted = await mountTimeline(renderTimeline(history));
    try {
      // Scrolling back mounts the older replies for the first time.
      legendListWindow.from = 0;
      await act(async () => mounted.root.render(renderTimeline(history)));
      expect(
        mounted.container.querySelectorAll(".messages-timeline-row-frame").length,
      ).toBeGreaterThan(2);
      expect(glidingReplies(mounted.container)).toEqual([]);

      await act(async () => mounted.root.render(renderTimeline([...history, reply(4)])));
      expect(glidingReplies(mounted.container)).toEqual(["Reply 4"]);
    } finally {
      await unmountTimeline(mounted);
    }
  });

  it("hands end-following back to the end pin once the send anchor is released", () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
      },
    };
    const timelineEntries = [firstEntry, secondEntry];

    // While the send anchor holds the end space open, ChatView owns streaming
    // scrolls: the end pin stands down and the list keeps content in place.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={firstEntry.message.id}
          timelineEntries={timelineEntries}
        />,
      ),
    ).toContain('data-maintain-visible-content-position="object"');

    // Dropping the anchor is what actually gives end-following back, so
    // returning to the live edge has to release it — re-enabling live follow
    // alone leaves nothing pinned to the stream.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          timelineEntries={timelineEntries}
        />,
      ),
    ).toContain('data-maintain-visible-content-position="false"');

    // Reading history still wins over both.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          liveFollowEnabled={false}
          timelineEntries={timelineEntries}
        />,
      ),
    ).toContain('data-maintain-visible-content-position="object"');
  });

  it("renders collapse controls for long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
    expect(markup).toContain("rounded-2xl bg-message p-3");
  });

  it("leaves server-authored agent messages unfolded", async () => {
    // Load after the vi.mock declarations above so the timeline uses the test fixtures.
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const entry = buildUserTimelineEntry("Server-authored update");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            ...entry,
            message: { ...entry.message, createdBy: "agent", creationSource: "server" },
          },
        ]}
      />,
    );

    expect(markup).toContain("Server-authored update");
    expect(markup).not.toContain('data-user-message-folded="agent"');
  });

  it("keeps steer intent visible on committed user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const entry = buildUserTimelineEntry("Adjust the current turn");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          { ...entry, message: { ...entry.message, inputIntent: "steer" as const } },
        ]}
      />,
    );

    expect(markup).toContain("data-base-ui-tooltip-trigger");
    expect(markup).toContain("lucide-redo-2");
    expect(markup).toContain('data-user-message-intent="steer"');
    expect(markup).toContain("items-center justify-end gap-1");
    expect(markup).toContain("gap-1 text-xs leading-none text-muted-foreground");
    expect(markup.indexOf("Steer")).toBeLessThan(markup.indexOf("Adjust the current turn"));
  });

  it("shows a collapsed disclosure for superseded attempt output", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const runId = RunId.make("run-steered");
    const supersededAttempt = {
      id: "attempt-1" as never,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
    };
    const activeAttempt = {
      id: "attempt-2" as never,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
    };
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        latestRun={{
          runId,
          status: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        timelineEntries={[
          {
            id: "superseded-response-entry",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            attempt: supersededAttempt,
            message: {
              id: MessageId.make("superseded-response"),
              role: "assistant",
              text: "Partial response from the old attempt",
              runId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
          {
            id: "active-response-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            attempt: activeAttempt,
            message: {
              id: MessageId.make("active-response"),
              role: "assistant",
              text: "Current response remains visible",
              runId,
              createdAt: "2026-03-17T19:12:29.000Z",
              updatedAt: "2026-03-17T19:12:29.000Z",
              streaming: true,
            },
          },
        ]}
      />,
      (container) => container.textContent?.includes("Current response remains visible") === true,
    );

    expect(markup).toContain('data-superseded-attempt-id="attempt-1"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Superseded attempt");
    expect(markup).toContain("Partial output retained");
    // Streaming text arrives word by word in its own spans; read it as text.
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Current response remains visible");
    expect(markup).not.toContain("Partial response from the old attempt");
  }, 20_000);

  it("exposes a per-response fork action for completed assistant items", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const projectedItem = {
      position: 0,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: "assistant-item-1",
      item: {
        id: "assistant-item-1",
        threadId: "thread-1",
        runId: "run-1",
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type: "assistant_message",
        messageId: "assistant-message-1",
        text: "Done",
        streaming: false,
      },
    } as never;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "assistant-message-1",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            projectedItem,
            message: {
              id: MessageId.make("assistant-message-1"),
              role: "assistant",
              text: "Done",
              runId: RunId.make("run-1"),
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Fork from this response"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
      (container) => container.textContent?.includes("Terminal 1 lines 1-5") === true,
    );

    const document = new DOMParser().parseFromString(markup, "text/html");
    expect(document.body.textContent).toContain("Terminal 1 lines 1-5");
    expect(document.body.textContent).toContain("yoo what's");
    expect(document.body.textContent).not.toContain("terminal_context");
    expect(document.body.textContent).toContain("Show full message");
  }, 20_000);

  it("renders chips for standalone element-pick context messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "  source: /repo/src/Button.tsx:12:5",
              "  html:",
              '  <button class="submit">Save</button>',
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("SubmitButton");
    expect(markup).not.toContain("&lt;element_context");
    expect(markup).not.toContain("<element_context");
  });

  it("keeps the copy button for collapsed long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
  });

  it("renders an accessible native terminal fallback action", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-terminal-fallback",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-terminal-fallback",
              createdAt: MESSAGE_CREATED_AT,
              label: "This operation requires the native OMP terminal.",
              tone: "info",
              sourceActivityKind: "runtime.warning",
              nativeTerminalFallback: {
                runtime: "omp",
                providerInstanceId: "omp-main",
                feature: "setTitle",
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("This operation requires the native OMP terminal.");
    expect(markup).toContain("Open OMP client in terminal");
    expect(markup).toContain('aria-label="Open OMP client in terminal for provider omp-main"');
  });

  it("does not render the transient V2 interruption request", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "interrupt-request",
            kind: "event",
            createdAt: MESSAGE_CREATED_AT,
            projectedItem: {
              position: 0,
              visibility: "local",
              sourceThreadId: "thread-1",
              sourceItemId: "interrupt-request",
              item: {
                id: "interrupt-request",
                threadId: "thread-1",
                runId: "run-1",
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                startedAt: null,
                completedAt: null,
                updatedAt: {},
                type: "run_interrupt_request",
                message: "Waiting for the provider to stop.",
              },
            } as never,
          },
        ]}
      />,
    );

    expect(markup).not.toContain('data-v2-item-type="run_interrupt_request"');
    expect(markup).not.toContain("Interrupt requested");
    expect(markup).not.toContain("Waiting for the provider to stop.");
    expect(markup).not.toContain("Structured details");
  });

  it("renders context handoffs as from → to model endpoints instead of the summary", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const providerStatuses = [
      {
        instanceId: "codex_personal",
        driver: "codex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: {},
        checkedAt: MESSAGE_CREATED_AT,
        models: [{ slug: "gpt-5.6-sol", name: "GPT 5.6 Sol", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: {},
        checkedAt: MESSAGE_CREATED_AT,
        models: [
          { slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ] as never;
    const buildHandoffEntry = (item: Record<string, unknown>) => ({
      id: "handoff-1",
      kind: "event" as const,
      createdAt: MESSAGE_CREATED_AT,
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: "thread-1",
        sourceItemId: "handoff-1",
        item: {
          id: "handoff-1",
          threadId: "thread-1",
          runId: "run-2",
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: "Provider handoff",
          startedAt: null,
          completedAt: null,
          updatedAt: {},
          type: "handoff",
          contextHandoffId: "handoff-1",
          fromProviderThreadIds: ["provider-thread-1"],
          toProviderThreadId: "provider-thread-2",
          strategy: "full_thread_summary",
          summary: "Full conversation context for provider handoff.",
          ...item,
        },
      } as never,
    });

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        providerStatuses={providerStatuses}
        timelineEntries={[
          buildHandoffEntry({
            fromProviderInstanceIds: ["codex_personal"],
            toProviderInstanceId: "claudeAgent",
            fromModelSelections: [{ instanceId: "codex_personal", model: "gpt-5.6-sol" }],
            toModel: "claude-fable-5",
          }),
        ]}
      />,
    );

    expect(markup).toContain("Context handoff");
    expect(markup).toContain("GPT 5.6 Sol");
    expect(markup).toContain("Claude Fable 5");
    expect(markup).not.toContain("Full conversation context");
    expect(markup).not.toContain("·");

    // Items persisted before models were stamped recover them from the
    // projection runs: the handoff's run is the target, the newest earlier
    // run per source instance is the origin.
    const legacyRuns = [
      {
        id: "run-1",
        ordinal: 1,
        providerInstanceId: "codex_personal",
        modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol" },
      },
      {
        id: "run-2",
        ordinal: 2,
        providerInstanceId: "claudeAgent",
        modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
      },
    ] as never;
    const legacyMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        providerStatuses={providerStatuses}
        runs={legacyRuns}
        timelineEntries={[
          buildHandoffEntry({
            fromProviderInstanceIds: ["codex_personal"],
            toProviderInstanceId: "claudeAgent",
          }),
        ]}
      />,
    );

    expect(legacyMarkup).toContain("GPT 5.6 Sol");
    expect(legacyMarkup).toContain("Claude Fable 5");
    expect(legacyMarkup).not.toContain("Full conversation context");

    // Without run data either (e.g. cross-thread items) it falls back to
    // provider names.
    const bareMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        providerStatuses={providerStatuses}
        timelineEntries={[
          buildHandoffEntry({
            fromProviderInstanceIds: ["codex_personal"],
            toProviderInstanceId: "claudeAgent",
          }),
        ]}
      />,
    );

    expect(bareMarkup).toContain("Codex Personal");
    expect(bareMarkup).not.toContain("Full conversation context");
  });

  it("renders created threads as lean rows with inline chat links", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "thread-created",
            kind: "event",
            createdAt: MESSAGE_CREATED_AT,
            projectedItem: {
              position: 0,
              visibility: "local",
              sourceThreadId: "thread-1",
              sourceItemId: "thread-created",
              item: {
                id: "thread-created",
                threadId: "thread-1",
                runId: "run-1",
                nodeId: "node-1",
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: "Claude research thread",
                startedAt: null,
                completedAt: null,
                updatedAt: {},
                type: "thread_created",
                targetThreadId: "thread-2",
                targetRunId: "run-2",
                targetProviderInstanceId: "claude-default",
                targetModel: "claude-sonnet-4-6",
              },
            } as never,
          },
        ]}
      />,
    );

    expect(markup).toContain('data-v2-item-type="thread_created"');
    expect(markup).toContain('aria-label="Open Claude research thread"');
    expect(markup).toContain("Claude research thread");
    expect(markup).toContain("Open chat");
    expect(markup).not.toContain("Work Log");
  });

  it("opens a retained V2 subagent group when its live lifecycle restarts", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    // The group header verb rolls: RollingText measures a Range and reads the
    // reduced-motion query, neither of which jsdom has.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 0, width: 0 }),
    });

    const makeLiveThread = (status: "completed" | "running") => ({
      environmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
      projection: {
        subagents: [
          {
            id: "child-agent-1",
            status,
            startedAt: null,
            completedAt: null,
            currentTool: status === "running" ? { name: "Read", intent: "Read the task" } : null,
          },
          {
            id: "child-agent-2",
            status,
            startedAt: null,
            completedAt: null,
            currentTool: null,
          },
        ],
      },
    });
    const liveThreadAtom = Atom.make(makeLiveThread("completed"));
    const threadAtomSpy = vi
      .spyOn(environmentThreadDetails, "threadAtom")
      .mockReturnValue(liveThreadAtom as never);
    const registry = AtomRegistry.make();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const makeSubagentEntry = (itemId: string, subagentId: string, ordinal: number) => ({
      id: itemId,
      kind: "event" as const,
      createdAt: MESSAGE_CREATED_AT,
      projectedItem: {
        position: ordinal,
        visibility: "local" as const,
        sourceThreadId: "thread-1",
        sourceItemId: itemId,
        item: {
          id: itemId,
          threadId: "thread-1",
          runId: "run-1",
          nodeId: subagentId,
          providerThreadId: null,
          providerTurnId: "turn-1",
          nativeItemRef: null,
          parentItemId: "task-call-1",
          ordinal,
          status: "completed",
          title: `Agent ${subagentId}`,
          startedAt: null,
          completedAt: null,
          updatedAt: {},
          type: "subagent",
          subagentId,
          origin: "provider_native",
          driver: "omp",
          providerInstanceId: "omp",
          childThreadId: null,
          prompt: "Inspect the task",
          result: "Completed.",
          currentTool: null,
        },
      } as never,
    });
    const timelineEntries = [
      makeSubagentEntry("subagent-item-1", "child-agent-1", 1),
      makeSubagentEntry("subagent-item-2", "child-agent-2", 2),
    ];

    try {
      await act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries as never} />
          </RegistryContext.Provider>,
        );
      });

      await act(async () => {
        registry.set(liveThreadAtom, makeLiveThread("running"));
      });
      const disclosure = container.querySelector<HTMLButtonElement>(
        "[data-subagent-task-tracker] > button",
      );
      expect(disclosure).not.toBeNull();
      expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector(".minimal-agent-activity")?.textContent).toBe("Read the task");

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>("[data-subagent-task-tracker] > button")
          ?.click();
      });
      expect(
        container
          .querySelector("[data-subagent-task-tracker] > button")
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
      await act(async () => {
        registry.set(liveThreadAtom, makeLiveThread("completed"));
      });
      await act(async () => {
        registry.set(liveThreadAtom, makeLiveThread("running"));
      });
      expect(
        container
          .querySelector("[data-subagent-task-tracker] > button")
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
      expect(container.querySelector(".minimal-agent-activity")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      threadAtomSpy.mockRestore();
      registry.dispose();
      container.remove();
      vi.unstubAllGlobals();
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("uses native activity until a matching live lifecycle overrides it", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 0, width: 0 }),
    });
    // The group holds open a beat after its last agent settles.
    vi.useFakeTimers();

    type LiveSubagent = {
      readonly id: string;
      readonly status: "completed" | "running";
      readonly startedAt: null;
      readonly completedAt: null;
      readonly currentTool: { readonly name: string; readonly intent: string } | null;
    };
    const makeLiveThread = (subagents: ReadonlyArray<LiveSubagent>) => ({
      environmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
      projection: { subagents },
    });
    const liveThreadAtom = Atom.make(makeLiveThread([]));
    const threadAtomSpy = vi
      .spyOn(environmentThreadDetails, "threadAtom")
      .mockReturnValue(liveThreadAtom as never);
    const registry = AtomRegistry.make();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const makeSubagentEntry = (
      itemId: string,
      subagentId: string,
      ordinal: number,
      status: "completed" | "running",
      currentTool: { readonly name: string; readonly intent: string } | null,
    ) => ({
      id: itemId,
      kind: "event" as const,
      createdAt: MESSAGE_CREATED_AT,
      projectedItem: {
        position: ordinal,
        visibility: "local" as const,
        sourceThreadId: "thread-1",
        sourceItemId: itemId,
        item: {
          id: itemId,
          threadId: "thread-1",
          runId: "run-1",
          nodeId: subagentId,
          providerThreadId: null,
          providerTurnId: "turn-1",
          nativeItemRef: null,
          parentItemId: "task-call-1",
          ordinal,
          status,
          title: `Agent ${subagentId}`,
          startedAt: null,
          completedAt: null,
          updatedAt: {},
          type: "subagent",
          subagentId,
          origin: "provider_native",
          driver: "omp",
          providerInstanceId: "omp",
          childThreadId: null,
          prompt: "Inspect the task",
          result: status === "completed" ? "Completed." : null,
          currentTool,
        },
      } as never,
    });
    const timelineEntries = [
      makeSubagentEntry("subagent-item-1", "child-agent-1", 1, "running", {
        name: "Snapshot Read",
        intent: "Read the snapshot task",
      }),
      makeSubagentEntry("subagent-item-2", "child-agent-2", 2, "completed", null),
    ];

    try {
      await act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <MessagesTimeline
              {...buildProps()}
              latestRun={{
                runId: RunId.make("run-1"),
                status: "running",
                startedAt: MESSAGE_CREATED_AT,
                completedAt: null,
              }}
              timelineEntries={timelineEntries as never}
            />
          </RegistryContext.Provider>,
        );
      });
      expect(
        container
          .querySelector("[data-subagent-task-tracker] > button")
          ?.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(container.querySelector(".minimal-agent-activity")?.textContent).toBe(
        "Read the snapshot task",
      );

      await act(async () => {
        registry.set(
          liveThreadAtom,
          makeLiveThread([
            {
              id: "child-agent-1",
              status: "completed",
              startedAt: null,
              completedAt: null,
              currentTool: null,
            },
          ]),
        );
      });
      await act(async () => vi.advanceTimersByTime(700));
      expect(
        container
          .querySelector("[data-subagent-task-tracker] > button")
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
      expect(container.querySelector(".minimal-agent-activity")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      threadAtomSpy.mockRestore();
      registry.dispose();
      container.remove();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("loads the latest activity page when expanding an unloaded summary group", async () => {
    const sourceThreadId = ThreadId.make("summary-source");
    const groupStartItemId = TurnItemId.make("summary-start");
    const lastItemId = TurnItemId.make("summary-last");
    const initialRequest = { sourceThreadId, groupStartItemId, anchorItemId: lastItemId };
    const group: TimelineActivityGroup = {
      key: JSON.stringify([sourceThreadId, groupStartItemId]),
      summary: {
        sourceThreadId,
        groupStartItemId,
        turnStartItemId: groupStartItemId,
        runId: null,
        firstItemId: TurnItemId.make("summary-first"),
        firstOrdinal: 1,
        lastItemId,
        lastOrdinal: 2,
        activityCount: 2,
        countsByType: [{ type: "command_execution", count: 2 }],
        statusCounts: [{ status: "completed", count: 2 }],
        runStatus: "completed",
        stepCount: 2,
        filesEditedCount: 0,
        diffStats: { added: 0, removed: 0 },
        hasFailure: false,
        labelPreview: null,
        intentPreview: null,
        startedAt: DateTime.makeUnsafe("2026-03-17T19:12:28.000Z"),
        endedAt: DateTime.makeUnsafe("2026-03-17T19:12:43.000Z"),
      },
      loadedCount: 0,
      loadedFirstOrdinal: null,
      loadedFirstItemId: null,
      loadedLastOrdinal: null,
      loadedLastItemId: null,
      initialRequest,
      previousRequest: null,
      nextRequest: null,
      loading: false,
      error: null,
    };
    const onLoadActivityPage = vi.fn();
    const mounted = await mountTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[]}
        activityGroups={[group]}
        onLoadActivityPage={onLoadActivityPage}
      />,
    );

    try {
      const fold = mounted.container.querySelector<HTMLButtonElement>(
        '[data-t3-part="timeline-checkpoint"] button',
      );
      if (!fold) throw new Error("Missing summary activity fold");
      await act(async () => fold.click());

      expect(onLoadActivityPage).toHaveBeenCalledTimes(1);
      expect(onLoadActivityPage).toHaveBeenCalledWith(initialRequest);
      expect(
        mounted.container
          .querySelector('[data-t3-part="timeline-checkpoint"] button')
          ?.getAttribute("aria-expanded"),
      ).toBe("true");
    } finally {
      await unmountTimeline(mounted);
    }
  });

  it("keeps the collapsed summary icon neutral when the group ends in a failure", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Run lint",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "failed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Used 2 tools");
    expect(markup).not.toContain("lucide-x");
    expect(markup).not.toContain("text-destructive");
    // The failure stays discoverable for screen readers.
    expect(markup).toContain("tool call failed");
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run search",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Used 2 tools and received 1 update");
    expect(markup).not.toContain('aria-label="Hidden work includes a failure"');
  });

  it("renders V2 provider retries in the normal work log", () => {
    activityTestState.expanded = true;
    const retryItem = {
      id: "provider-error",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 99,
      status: "running",
      title: "Provider retry",
      startedAt: {},
      completedAt: null,
      updatedAt: {},
      type: "error",
      failure: {
        class: "transport_error",
        message: "The response stream disconnected.",
        code: "responseStreamDisconnected",
        retryable: true,
      },
      retry: {
        attempt: 2,
        maxAttempts: 5,
        retryDelayMs: null,
      },
    } as const;
    const projectedItem = {
      position: 0,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: retryItem.id,
      item: retryItem,
    } as const;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        latestRun={{
          runId: RunId.make("run-1"),
          status: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        timelineEntries={
          [
            {
              id: "provider-error",
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: retryItem.id,
                createdAt: MESSAGE_CREATED_AT,
                runId: "run-1",
                label: "Retrying provider (2/5)",
                detail: retryItem.failure.message,
                tone: "info",
                itemType: "error",
                toolLifecycleStatus: "inProgress",
                structuredPayload: retryItem,
                projectedItem,
              },
            },
          ] as never
        }
      />,
    );

    expect(markup).toContain('data-v2-item-type="error"');
    expect(markup).toContain("Retrying provider (2/5)");
    // The failure message stays behind the row's expander.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-v2-event-disclosure="true"');
  });

  it("keeps inherited V2 work provenance on the rendered row", async () => {
    activityTestState.expanded = true;
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const item = {
      id: "command-inherited",
      threadId: "thread-source",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type: "command_execution",
      input: "pwd",
      output: "/workspace",
      exitCode: 0,
    } as const;
    const projectedItem = {
      position: 0,
      visibility: "inherited",
      sourceThreadId: "thread-source",
      sourceItemId: item.id,
      item,
    } as const;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={
          [
            {
              id: "context-info-entry",
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: "context-info",
                createdAt: MESSAGE_CREATED_AT,
                label: "Session started",
                tone: "info",
              },
            },
            {
              id: item.id,
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: item.id,
                createdAt: MESSAGE_CREATED_AT,
                runId: null,
                label: "Ran command",
                command: item.input,
                tone: "tool",
                itemType: item.type,
                toolLifecycleStatus: "completed",
                structuredPayload: item,
                projectedItem,
              },
            },
          ] as never
        }
      />,
    );

    expect(markup).toContain('data-v2-item-type="command_execution"');
    expect(markup).toContain('data-v2-item-visibility="inherited"');
  });

  it("renders T3 MCP dynamic tools with the product logo and pretty name", async () => {
    activityTestState.expanded = true;
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const item = {
      id: "tool-t3-thread-read",
      threadId: "thread-source",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    } as const;
    const projectedItem = {
      position: 0,
      visibility: "local",
      sourceThreadId: "thread-source",
      sourceItemId: item.id,
      item,
    } as const;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={
          [
            {
              id: "context-info-entry",
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: "context-info",
                createdAt: MESSAGE_CREATED_AT,
                label: "Session started",
                tone: "info",
              },
            },
            {
              id: item.id,
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: item.id,
                createdAt: MESSAGE_CREATED_AT,
                runId: null,
                label: item.toolName,
                tone: "tool",
                itemType: item.type,
                toolTitle: item.toolName,
                toolLifecycleStatus: "completed",
                toolData: { input: item.input, output: item.output },
                structuredPayload: item,
                projectedItem,
              },
            },
          ] as never
        }
      />,
    );

    // The KM monogram replaces the generic tool icon for T3 MCP calls.
    expect(markup).toContain('viewBox="-12.25 29.5 152.5 72"');
    expect(markup).toContain("Read a T3 thread");
    expect(markup).not.toContain("mcp__t3-code__t3_thread_read");
  });

  it("formats changed file paths from the workspace root", async () => {
    activityTestState.expanded = true;
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "context-info-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "context-info",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Session started",
              tone: "info",
            },
          },
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              itemType: "file_change",
              toolLifecycleStatus: "completed",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    const markup = await renderTimelineToMarkupAfterMarkdown(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              runId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
      (container) =>
        Array.from(container.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("contextWindow.test.ts"),
        ),
    );

    const document = new DOMParser().parseFromString(markup, "text/html");
    const contextChip = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("contextWindow.test.ts"),
    );
    expect(contextChip?.textContent).toContain("contextWindow.test.ts L47 to L58");
    expect(document.body.textContent).not.toContain("<review_comment");
  }, 20_000);

  it("renders file review comments as source code instead of diffs", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              runId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md L1 to L2");
    expect(markup).not.toContain("review_comment");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("collapses settled tool runs behind a generated summary toggle", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Called tool",
              detail: "vp lint",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Called tool",
              detail: "vp test run",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Used 2 tools");
    expect(markup).toContain('aria-expanded="false"');
    // Entries stay hidden until the toggle expands the group.
    expect(markup).not.toContain("vp lint");
  });

  it("renders a muted failure marker for failed tool lifecycle entries", () => {
    activityTestState.expanded = true;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-zap");
    expect(markup).toContain('aria-label="Tool call failed"');
    // Ordinary tool failures render muted, not red.
    expect(markup).not.toContain("text-destructive");
  });

  it("keeps the red treatment for severe orchestration failures", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-turn-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-turn-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Provider turn start failed",
              tone: "error",
              itemType: "error",
              toolLifecycleStatus: "failed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain("text-destructive");
  });

  it.each([
    ["without timing", null, "Thought"],
    ["under two seconds", 800, "Thought briefly"],
    ["with timing", 12_000, `Thought for ${formatDuration(12_000)}`],
  ] as const)(
    "heads a settled thought with its verb %s and keeps the thought for the body",
    async (_case, durationMs, verb) => {
      activityTestState.expanded = true;
      const markdown = "**Viewing image first** with care";
      const startedAt = DateTime.makeUnsafe(MESSAGE_CREATED_AT);
      const mounted = await mountTimeline(
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[
            {
              id: "reasoning-preview",
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: "reasoning-preview",
                createdAt: MESSAGE_CREATED_AT,
                label: markdown,
                detail: markdown,
                tone: "thinking",
                itemType: "reasoning",
                toolLifecycleStatus: "completed",
                ...(durationMs === null
                  ? {}
                  : {
                      projectedItem: {
                        visibility: "visible",
                        item: {
                          id: "reasoning-preview",
                          type: "reasoning",
                          status: "completed",
                          startedAt,
                          completedAt: DateTime.add(startedAt, { milliseconds: durationMs }),
                        },
                      } as never,
                    }),
              },
            },
            {
              id: "assistant-successor",
              kind: "message",
              createdAt: MESSAGE_CREATED_AT,
              message: {
                id: MessageId.make("asst-1"),
                role: "assistant",
                text: "Done.",
                streaming: false,
                createdAt: MESSAGE_CREATED_AT,
                updatedAt: MESSAGE_CREATED_AT,
                runId: RunId.make("run-1"),
              },
            },
          ]}
        />,
      );
      try {
        await waitForTimelineMarkdown(
          mounted.container,
          (container) => container.textContent?.includes("Done.") === true,
        );
        const closed = findWorkEntryDisclosure(mounted.container, false);
        expect(closed.getAttribute("aria-label")).toBe(verb);
        expect(mounted.container.querySelectorAll("strong")).toHaveLength(0);
        await act(async () => closed.click());
        await waitForTimelineMarkdown(mounted.container, (container) =>
          Array.from(container.querySelectorAll("strong")).some(
            (node) => node.textContent === "Viewing image first",
          ),
        );
        expect(mounted.container.querySelectorAll("strong")).toHaveLength(1);
      } finally {
        await unmountTimeline(mounted);
      }
    },
    20_000,
  );
  it("auto-expands completed latest activity without successor and renders details", async () => {
    activityTestState.expanded = false;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[
              {
                id: "tool-terminal-result",
                kind: "work",
                createdAt: MESSAGE_CREATED_AT,
                entry: {
                  id: "tool-terminal-result",
                  createdAt: MESSAGE_CREATED_AT,
                  label: "Example terminal tool",
                  toolTitle: "Example terminal tool",
                  tone: "tool",
                  itemType: "dynamic_tool",
                  toolLifecycleStatus: "completed",
                  toolData: {
                    input: { query: "KEEP_TOOL_INPUT" },
                    output: { text: "RAW_CACHED_TOOL_OUTPUT" },
                  },
                },
              },
            ]}
          />,
        );
      });
      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain("Example terminal tool");
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("keeps a live reasoning body visible as its tool group grows", async () => {
    const runId = RunId.make("live-row-run");
    const liveThought =
      "The first live thought line remains visible.\nA second streamed line grows the row.";
    const reasoning = (
      entryId: string,
      itemId: string,
      status: "idle" | "inProgress" | "completed",
      detail: string,
    ) => ({
      id: entryId,
      kind: "work" as const,
      createdAt: MESSAGE_CREATED_AT,
      entry: {
        id: itemId,
        createdAt: MESSAGE_CREATED_AT,
        runId,
        label: "Thinking",
        detail,
        tone: "thinking" as const,
        itemType: "reasoning" as const,
        toolLifecycleStatus: status,
      },
    });
    const command = (status: "inProgress" | "completed") => ({
      id: "command-entry",
      kind: "work" as const,
      createdAt: MESSAGE_CREATED_AT,
      entry: {
        id: "command-item",
        createdAt: MESSAGE_CREATED_AT,
        runId,
        label: status === "inProgress" ? "Running pnpm" : "Ran pnpm",
        command: "pnpm test",
        requestKind: "command" as const,
        tone: "tool" as const,
        toolLifecycleStatus: status,
      },
    });
    type LiveEntry = Extract<TimelineEntry, { kind: "work" }>;
    const props = buildProps();
    const renderTimeline = (timelineEntries: ReadonlyArray<LiveEntry>) => (
      <MessagesTimeline
        {...props}
        isWorking
        activeTurnInProgress
        runningRunId={runId}
        latestRun={{
          runId,
          status: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        timelineEntries={timelineEntries}
      />
    );
    const mounted = await mountTimeline(
      renderTimeline([reasoning("reasoning-entry", "reasoning-item", "idle", "First thought.")]),
    );
    const workRow = () =>
      mounted.container.querySelector<HTMLElement>('[data-timeline-row-kind="work-live"]');
    const liveButton = () =>
      mounted.container.querySelector<HTMLButtonElement>(
        'button[data-t3-part="timeline-tool-call"]',
      );
    try {
      const firstRow = workRow();
      const firstButton = liveButton();
      const rowFrame = firstRow?.closest<HTMLElement>(".messages-timeline-row-frame");
      if (!firstRow || !firstButton || !rowFrame) {
        throw new Error("Missing live reasoning row");
      }
      expect(firstRow.getAttribute("data-timeline-row-id")).toBe("work-live:reasoning-entry");

      await act(async () => {
        mounted.root.render(
          renderTimeline([
            reasoning("reasoning-entry", "reasoning-item", "inProgress", liveThought),
          ]),
        );
      });
      expect(workRow()).toBe(firstRow);
      expect(firstRow.getAttribute("data-timeline-row-id")).toBe("live-activity-row");
      expect(liveButton()).toBe(firstButton);
      expect(firstRow.textContent).toContain("The first live thought line remains visible.");
      expect(rowFrame.style.height).toBe("");

      await act(async () => {
        mounted.root.render(
          renderTimeline([
            reasoning("reasoning-entry", "reasoning-item", "inProgress", liveThought),
            command("completed"),
          ]),
        );
      });
      expect(workRow()).toBe(firstRow);
      expect(liveButton()).toBe(firstButton);

      await act(async () => {
        mounted.root.render(
          renderTimeline([
            reasoning("reasoning-entry", "reasoning-item", "inProgress", liveThought),
            command("completed"),
          ]),
        );
      });
      expect(workRow()).toBe(firstRow);
      expect(liveButton()).toBe(firstButton);
      expect(firstButton.textContent).toContain("Ran 1 command");
      const summaryIcon = firstButton.querySelector("div.relative.min-h-6 svg");
      expect(summaryIcon?.classList.contains("lucide-terminal")).toBe(true);
      expect(summaryIcon?.classList.contains("lucide-brain")).toBe(false);
      expect(rowFrame.style.height).toBe("");
    } finally {
      await unmountTimeline(mounted);
    }
  });
  it("keeps native wait rows mounted when one settles and the next starts", async () => {
    const runId = RunId.make("native-wait-run");
    const threadId = ThreadId.make("native-wait-thread");
    const projectedWait = (
      id: string,
      status: "pending" | "running" | "completed",
      ordinal: number,
    ): OrchestrationV2ProjectedTurnItem => {
      const item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> = {
        id: TurnItemId.make(id),
        type: "dynamic_tool",
        toolName: "wait",
        title: "wait",
        status,
        input: { op: "wait" },
        runId,
        threadId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        startedAt: DateTime.makeUnsafe(MESSAGE_CREATED_AT),
        completedAt: status === "completed" ? DateTime.makeUnsafe(MESSAGE_CREATED_AT) : null,
        updatedAt: DateTime.makeUnsafe(MESSAGE_CREATED_AT),
      };
      return {
        position: ordinal,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      };
    };
    const eventEntry = (
      id: string,
      status: "pending" | "running" | "completed",
      ordinal: number,
    ): TimelineEntry => ({
      id: `native-item:${id}`,
      kind: "event",
      createdAt: MESSAGE_CREATED_AT,
      projectedItem: projectedWait(id, status, ordinal),
    });
    const runningWorkEntry = (id: string): TimelineEntry => ({
      id: `native-item:${id}`,
      kind: "work",
      createdAt: MESSAGE_CREATED_AT,
      entry: {
        id: `native-item:${id}`,
        createdAt: MESSAGE_CREATED_AT,
        runId,
        label: "Waiting for background jobs",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "inProgress",
        projectedItem: projectedWait(id, "running", 1),
      },
    });
    const props = buildProps();
    const renderTimeline = (timelineEntries: ReadonlyArray<TimelineEntry>) => (
      <MessagesTimeline
        {...props}
        isWorking
        activeTurnInProgress
        runningRunId={runId}
        transcriptStyle="terminal"
        latestRun={{
          runId,
          status: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        timelineEntries={timelineEntries}
      />
    );
    const firstId = "native-item:toolu_wait_first";
    const nextId = "native-item:toolu_wait_next";
    // jsdom lacks the Web Animations API used by the wait clock glyph.
    const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getAnimations",
    );
    Object.defineProperty(SVGElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    const mounted = await mountTimeline(
      renderTimeline([
        runningWorkEntry("toolu_wait_first"),
        eventEntry("toolu_wait_next", "pending", 2),
      ]),
    );
    try {
      const firstWaitRow = mounted.container.querySelector<HTMLElement>(
        `[data-timeline-row-id="${firstId}"]`,
      );
      const nextWaitRow = mounted.container.querySelector<HTMLElement>(
        `[data-timeline-row-id="${nextId}"]`,
      );
      if (!firstWaitRow || !nextWaitRow) throw new Error("Missing initial native wait rows");

      await act(async () => {
        mounted.root.render(
          renderTimeline([
            eventEntry("toolu_wait_first", "completed", 1),
            eventEntry("toolu_wait_next", "running", 2),
          ]),
        );
      });
      expect(mounted.container.querySelector(`[data-timeline-row-id="${firstId}"]`)).toBe(
        firstWaitRow,
      );
      expect(mounted.container.querySelector(`[data-timeline-row-id="${nextId}"]`)).toBe(
        nextWaitRow,
      );
      expect(firstWaitRow.getAttribute("data-timeline-row-kind")).toBe("event");
    } finally {
      await unmountTimeline(mounted);
      if (getAnimationsDescriptor === undefined) {
        Reflect.deleteProperty(SVGElement.prototype, "getAnimations");
      } else {
        Object.defineProperty(SVGElement.prototype, "getAnimations", getAnimationsDescriptor);
      }
    }
  });
});

describe("Thought body continuity", () => {
  const thoughtContinuityCases = (["minimal", "km", "minimal-plus", "terminal"] as const).flatMap(
    (transcriptStyle) => [true, false].map((expanded) => ({ transcriptStyle, expanded })),
  );

  it.each(thoughtContinuityCases)(
    "keeps the Thought row and body stable through streaming and settling in $transcriptStyle style (expanded: $expanded)",
    async ({ transcriptStyle, expanded }) => {
      const runId = RunId.make("thought-body-continuity");
      const firstDetail = "The first reasoning body stays mounted.";
      const latestDetail = "The latest reasoning body stays mounted.";
      const work = (
        id: string,
        itemType: "dynamic_tool" | "file_search" | "reasoning",
        toolLifecycleStatus: "inProgress" | "completed",
        detail?: string,
      ): TimelineEntry => ({
        id,
        kind: "work",
        createdAt: MESSAGE_CREATED_AT,
        entry: {
          id,
          createdAt: MESSAGE_CREATED_AT,
          runId,
          label: itemType === "reasoning" ? "Thinking" : id,
          ...(detail !== undefined ? { detail } : {}),
          tone: itemType === "reasoning" ? "thinking" : "tool",
          itemType,
          toolLifecycleStatus,
        },
      });
      const renderTimeline = ({
        firstThoughtStatus,
        latestThoughtStatus,
        siblingStatus,
        isWorking,
      }: {
        firstThoughtStatus: "inProgress" | "completed";
        latestThoughtStatus: "inProgress" | "completed" | null;
        siblingStatus: "inProgress" | "completed" | null;
        isWorking: boolean;
      }) => (
        <MessagesTimeline
          {...buildProps()}
          isWorking={isWorking}
          activeTurnInProgress={isWorking}
          runningRunId={isWorking ? runId : null}
          latestRun={{
            runId,
            status: isWorking ? "running" : "completed",
            startedAt: MESSAGE_CREATED_AT,
            completedAt: isWorking ? null : MESSAGE_CREATED_AT,
          }}
          transcriptStyle={transcriptStyle}
          timelineEntries={[
            {
              id: "thought-prompt",
              kind: "message",
              createdAt: MESSAGE_CREATED_AT,
              message: {
                id: MessageId.make("thought-prompt"),
                role: "user",
                text: "Explain this.",
                runId: null,
                createdAt: MESSAGE_CREATED_AT,
                updatedAt: MESSAGE_CREATED_AT,
                streaming: false,
              },
            },
            work("thought-prefix", "file_search", "completed"),
            work("thought-entry", "reasoning", firstThoughtStatus, firstDetail),
            ...(latestThoughtStatus === null
              ? []
              : [work("thought-latest", "reasoning", latestThoughtStatus, latestDetail)]),
            ...(siblingStatus === null
              ? []
              : [work("thought-sibling", "dynamic_tool", siblingStatus)]),
          ]}
        />
      );
      const findThoughtBody = (container: HTMLElement, detail: string) =>
        Array.from(container.querySelectorAll<HTMLElement>('[data-t3-part="markdown"]')).find(
          (node) => node.textContent?.includes(detail),
        ) ?? null;
      const findThoughtDisclosure = (body: HTMLElement) =>
        body.closest<HTMLElement>('[role="button"][aria-controls]');

      activityTestState.expanded = true;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
      );
      const previousRangeRect = Object.getOwnPropertyDescriptor(
        Range.prototype,
        "getBoundingClientRect",
      );
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: 0, right: 0, width: 0 }),
      });
      const mounted = await mountTimeline(
        renderTimeline({
          firstThoughtStatus: "inProgress",
          latestThoughtStatus: null,
          siblingStatus: null,
          isWorking: true,
        }),
      );
      try {
        await waitForTimelineMarkdown(
          mounted.container,
          (container) => findThoughtBody(container, firstDetail) !== null,
        );
        let firstBody = findThoughtBody(mounted.container, firstDetail);
        if (!firstBody) throw new Error("Missing first reasoning body");
        let firstDisclosure = findThoughtDisclosure(firstBody);
        if (transcriptStyle !== "terminal") {
          if (!firstDisclosure) throw new Error("Missing first Thought disclosure");
          if (firstDisclosure.getAttribute("aria-expanded") === "true") {
            await act(async () => firstDisclosure?.click());
          }
          if (expanded) {
            await act(async () => firstDisclosure?.click());
            await waitForTimelineMarkdown(
              mounted.container,
              (container) => findThoughtBody(container, firstDetail) !== null,
            );
            firstBody = findThoughtBody(mounted.container, firstDetail);
          } else {
            firstBody = findThoughtBody(mounted.container, firstDetail);
          }
          if (firstDisclosure.getAttribute("aria-expanded") !== String(expanded)) {
            throw new Error("Could not set first Thought disclosure");
          }
        }
        if ((expanded || transcriptStyle === "terminal") && !firstBody) {
          throw new Error("Missing expanded first reasoning body");
        }
        const firstIdentity = firstDisclosure ?? firstBody;
        if (!firstIdentity) throw new Error("Missing first Thought identity");
        const firstRow = firstIdentity.closest<HTMLElement>("[data-timeline-row-id]");
        if (!firstRow) throw new Error("Missing first Thought timeline row");

        await act(async () => {
          mounted.root.render(
            renderTimeline({
              firstThoughtStatus: "completed",
              latestThoughtStatus: null,
              siblingStatus: null,
              isWorking: true,
            }),
          );
        });
        const completedFirstBody = findThoughtBody(mounted.container, firstDetail);
        if (expanded || transcriptStyle === "terminal") {
          expect(completedFirstBody).toBe(firstBody);
          expect(completedFirstBody?.querySelector("[data-markdown-pending]")).toBeNull();
        } else if (firstBody !== null) {
          expect(completedFirstBody).toBe(firstBody);
        } else {
          expect(completedFirstBody).toBeNull();
        }
        expect(firstIdentity).toBe(firstDisclosure ?? completedFirstBody);
        expect(firstIdentity.closest("[data-timeline-row-id]")).toBe(firstRow);

        await act(async () => {
          mounted.root.render(
            renderTimeline({
              firstThoughtStatus: "completed",
              latestThoughtStatus: "inProgress",
              siblingStatus: null,
              isWorking: true,
            }),
          );
        });
        await waitForTimelineMarkdown(
          mounted.container,
          (container) => findThoughtBody(container, latestDetail) !== null,
        );
        if (firstBody !== null) {
          expect(findThoughtBody(mounted.container, firstDetail)).toBe(firstBody);
        }
        let latestBody = findThoughtBody(mounted.container, latestDetail);
        if (!latestBody) throw new Error("Missing latest reasoning body");
        let latestDisclosure = findThoughtDisclosure(latestBody);
        if (transcriptStyle !== "terminal") {
          if (!latestDisclosure) throw new Error("Missing latest Thought disclosure");
          if (latestDisclosure.getAttribute("aria-expanded") === "true") {
            await act(async () => latestDisclosure?.click());
          }
          if (expanded) {
            await act(async () => latestDisclosure?.click());
            await waitForTimelineMarkdown(
              mounted.container,
              (container) => findThoughtBody(container, latestDetail) !== null,
            );
            latestBody = findThoughtBody(mounted.container, latestDetail);
          } else {
            latestBody = findThoughtBody(mounted.container, latestDetail);
          }
          if (latestDisclosure.getAttribute("aria-expanded") !== String(expanded)) {
            throw new Error("Could not set latest Thought disclosure");
          }
        }
        if ((expanded || transcriptStyle === "terminal") && !latestBody) {
          throw new Error("Missing expanded latest reasoning body");
        }
        const latestIdentity = latestDisclosure ?? latestBody;
        if (!latestIdentity) throw new Error("Missing latest Thought identity");
        const latestRow = latestIdentity.closest<HTMLElement>("[data-timeline-row-id]");
        if (!latestRow) throw new Error("Missing latest Thought timeline row");

        await act(async () => {
          mounted.root.render(
            renderTimeline({
              firstThoughtStatus: "completed",
              latestThoughtStatus: "inProgress",
              siblingStatus: "inProgress",
              isWorking: true,
            }),
          );
        });
        const supersededBody = findThoughtBody(mounted.container, latestDetail);
        if (latestBody !== null) {
          expect(supersededBody).toBe(latestBody);
          expect(supersededBody?.querySelector("[data-markdown-pending]")).toBeNull();
        } else {
          expect(supersededBody).toBeNull();
        }
        expect(latestDisclosure ?? supersededBody).toBe(latestIdentity);
        expect(latestIdentity.closest("[data-timeline-row-id]")).toBe(latestRow);
        if (latestDisclosure) {
          expect(latestDisclosure.getAttribute("aria-label")).toBe("Thought");
          expect(latestDisclosure.getAttribute("aria-expanded")).toBe(String(expanded));
        }

        await act(async () => {
          mounted.root.render(
            renderTimeline({
              firstThoughtStatus: "completed",
              latestThoughtStatus: "inProgress",
              siblingStatus: "completed",
              isWorking: false,
            }),
          );
        });
        const finishedBody = findThoughtBody(mounted.container, latestDetail);
        if (transcriptStyle !== "terminal") {
          expect(mounted.container.textContent).toContain("Worked");
        }
        if (latestBody !== null) {
          expect(finishedBody).toBe(latestBody);
          expect(finishedBody?.querySelector("[data-markdown-pending]")).toBeNull();
        } else {
          expect(finishedBody).toBeNull();
        }
      } finally {
        await unmountTimeline(mounted);
        vi.unstubAllGlobals();
        if (previousRangeRect) {
          Object.defineProperty(Range.prototype, "getBoundingClientRect", previousRangeRect);
        } else {
          Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
        }
      }
    },
    20_000,
  );
  it.each(["minimal", "km", "minimal-plus"] as const)(
    "keeps an all-reasoning trace mounted when a tool joins in %s style",
    async (transcriptStyle) => {
      const runId = RunId.make("thought-body-group-transition");
      const firstDetail = "First reasoning detail remains mounted.";
      const secondDetail = "Second reasoning detail remains mounted.";
      const work = (
        id: string,
        itemType: "dynamic_tool" | "reasoning",
        detail?: string,
      ): TimelineEntry => ({
        id,
        kind: "work",
        createdAt: MESSAGE_CREATED_AT,
        entry: {
          id,
          createdAt: MESSAGE_CREATED_AT,
          runId,
          label: itemType === "reasoning" ? "Thinking" : id,
          ...(detail !== undefined ? { detail } : {}),
          tone: itemType === "reasoning" ? "thinking" : "tool",
          itemType,
          toolLifecycleStatus: "inProgress",
        },
      });
      const renderTimeline = (includeTool: boolean) => (
        <MessagesTimeline
          {...buildProps()}
          isWorking={true}
          activeTurnInProgress={true}
          runningRunId={runId}
          latestRun={{
            runId,
            status: "running",
            startedAt: MESSAGE_CREATED_AT,
            completedAt: null,
          }}
          transcriptStyle={transcriptStyle}
          timelineEntries={[
            {
              id: "thought-group-prompt",
              kind: "message",
              createdAt: MESSAGE_CREATED_AT,
              message: {
                id: MessageId.make("thought-group-prompt"),
                role: "user",
                text: "Explain this.",
                runId: null,
                createdAt: MESSAGE_CREATED_AT,
                updatedAt: MESSAGE_CREATED_AT,
                streaming: false,
              },
            },
            work("thought-group-first", "reasoning", firstDetail),
            work("thought-group-second", "reasoning", secondDetail),
            ...(includeTool ? [work("thought-group-tool", "dynamic_tool")] : []),
          ]}
        />
      );
      const findThoughtBody = (container: HTMLElement, detail: string) =>
        Array.from(container.querySelectorAll<HTMLElement>('[data-t3-part="markdown"]')).find(
          (node) => node.textContent?.includes(detail),
        ) ?? null;

      activityTestState.expanded = true;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
      );
      const previousRangeRect = Object.getOwnPropertyDescriptor(
        Range.prototype,
        "getBoundingClientRect",
      );
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: 0, right: 0, width: 0 }),
      });
      const mounted = await mountTimeline(renderTimeline(false));
      try {
        await waitForTimelineMarkdown(
          mounted.container,
          (container) => findThoughtBody(container, firstDetail) !== null,
        );
        const bodyBeforeTool = findThoughtBody(mounted.container, firstDetail);
        if (!bodyBeforeTool) throw new Error("Missing first reasoning body");
        const rowBeforeTool = bodyBeforeTool.closest<HTMLElement>("[data-timeline-row-id]");
        if (!rowBeforeTool) throw new Error("Missing first Thought timeline row");

        await act(async () => {
          mounted.root.render(renderTimeline(true));
        });

        const bodyAfterTool = findThoughtBody(mounted.container, firstDetail);
        expect(bodyAfterTool).toBe(bodyBeforeTool);
        expect(bodyAfterTool?.querySelector("[data-markdown-pending]")).toBeNull();
        expect(bodyAfterTool?.closest("[data-timeline-row-id]")).toBe(rowBeforeTool);
      } finally {
        await unmountTimeline(mounted);
        vi.unstubAllGlobals();
        if (previousRangeRect) {
          Object.defineProperty(Range.prototype, "getBoundingClientRect", previousRangeRect);
        } else {
          Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
        }
      }
    },
    20_000,
  );
});
