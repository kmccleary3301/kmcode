// @vitest-environment jsdom

import { EnvironmentId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import type { TimelineActivityGroup } from "./timelineActivity";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

function Probe(props: Parameters<typeof useAssistantCitationTarget>[0]) {
  useAssistantCitationTarget(props);
  return null;
}

const citationRequest: AssistantCitationRequest = {
  key: "citation-target",
  citation: {
    version: 1,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message-target"),
    text: "hello",
    start: 0,
    end: 5,
    prefix: "",
    suffix: "",
  },
};

let root: Root;
let host: HTMLDivElement;
let viewport: HTMLDivElement;
let props: ComponentProps<typeof Probe>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  viewport = document.createElement("div");
  document.body.append(host, viewport);
  root = createRoot(host);
  props = {
    request: citationRequest,
    entries: [],
    rows: [],
    listRef: { current: null },
    viewport,
    historyLoading: false,
    loadEarlier: { loading: false, onLoadEarlier: vi.fn() },
    onExpandTurn: vi.fn(),
    onManualNavigation: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  viewport.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(next: ComponentProps<typeof Probe> = props) {
  await act(async () => root.render(<Probe {...next} />));
}

describe("assistant citation target hydration", () => {
  it("loads a missing target directly once instead of paging through older history", async () => {
    const onLoadEarlier = vi.fn();
    props = { ...props, loadEarlier: { loading: false, onLoadEarlier } };

    await render();
    expect(onLoadEarlier).toHaveBeenCalledExactlyOnceWith("message-target");

    await render({ ...props, historyLoading: true });
    await render({ ...props, historyLoading: false });
    expect(onLoadEarlier).toHaveBeenCalledExactlyOnceWith("message-target");
  });

  it("hydrates and expands a known summary-backed activity source in its source thread", async () => {
    const sourceThreadId = ThreadId.make("subagent-thread");
    const sourceItemId = TurnItemId.make("activity-item");
    const runId = RunId.make("activity-run");
    const group = {
      key: "subagent-thread:group-start",
      summary: {
        sourceThreadId,
        groupStartItemId: TurnItemId.make("group-start"),
        firstItemId: TurnItemId.make("first-item"),
        firstOrdinal: 1,
        lastItemId: TurnItemId.make("last-item"),
        lastOrdinal: 9,
        runId,
      },
    } as TimelineActivityGroup;
    const entry = {
      id: "message-target",
      kind: "message",
      message: {
        id: MessageId.make("message-target"),
        role: "assistant",
        runId,
      },
      projectedItem: {
        sourceThreadId,
        sourceItemId,
        item: { ordinal: 5 },
        orderKey: { sourceThreadId, ordinal: 5, itemId: sourceItemId },
      },
    } as unknown as TimelineEntry;
    const onLoadActivityPage = vi.fn();
    const onExpandActivityGroup = vi.fn();
    props = {
      ...props,
      entries: [entry],
      activityGroups: [group],
      onLoadActivityPage,
      onExpandActivityGroup,
    };

    await render();

    expect(props.loadEarlier?.onLoadEarlier).not.toHaveBeenCalled();
    expect(onLoadActivityPage).toHaveBeenCalledExactlyOnceWith({
      anchorItemId: sourceItemId,
      sourceThreadId,
    });
    expect(onExpandActivityGroup).toHaveBeenCalledExactlyOnceWith(group);
  });
});
