import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  extractDomain,
  formatSearchAge,
  getSearchProviderLabel,
  readNativeSearchData,
} from "./NativeSearchPane.logic";

const timestamp = DateTime.makeUnsafe("2026-10-14T00:00:00.000Z");

function makeTurnItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>>,
): Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> {
  return {
    id: TurnItemId.make("item-test-1"),
    threadId: ThreadId.make("thread-test-1"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    type: "dynamic_tool",
    toolName: "web_search",
    input: {},
    ...fields,
  };
}

describe("NativeSearchPane.logic", () => {
  it("extracts clean domains and formats age relative strings", () => {
    expect(extractDomain("https://www.fifa.com/tickets?lang=en")).toBe("fifa.com");
    expect(extractDomain("http://sub.domain.co.uk/path")).toBe("sub.domain.co.uk");
    expect(extractDomain("not-a-url")).toBe("");

    expect(formatSearchAge(30)).toBe("30s ago");
    expect(formatSearchAge(300)).toBe("5m ago");
    expect(formatSearchAge(7200)).toBe("2h ago");
    expect(formatSearchAge(86400)).toBe("1d ago");
    expect(formatSearchAge(undefined)).toBeNull();
    expect(formatSearchAge(-5)).toBeNull();
  });

  it("maps known provider labels and drops 'none' or empty", () => {
    expect(getSearchProviderLabel("anthropic")).toBe("Anthropic");
    expect(getSearchProviderLabel("codex")).toBe("OpenAI Codex");
    expect(getSearchProviderLabel("brave")).toBe("Brave");
    expect(getSearchProviderLabel("none")).toBeNull();
    expect(getSearchProviderLabel("")).toBeNull();
    expect(getSearchProviderLabel(undefined)).toBeNull();
  });

  it("neutralizes unsafe URLs and preserves safe URLs", () => {
    const item = makeTurnItem({
      type: "dynamic_tool",
      toolName: "web_search",
      input: { query: "security test" },
      details: {
        response: {
          provider: "anthropic",
          sources: [
            {
              title: "Safe Source",
              url: "https://example.com/safe",
            },
            {
              title: "Unsafe Script",
              url: "javascript:alert(document.cookie)",
            },
            {
              title: "Data URL",
              url: "data:text/html,<script>alert(1)</script>",
            },
            {
              title: "Relative URL",
              url: "/local/path",
            },
          ],
        },
      },
    });

    const parsed = readNativeSearchData(item);
    expect(parsed).not.toBeNull();
    expect(parsed!.sources).toHaveLength(4);

    expect(parsed!.sources[0]!.safeHref).toBe("https://example.com/safe");
    expect(parsed!.sources[1]!.safeHref).toBeNull();
    expect(parsed!.sources[2]!.safeHref).toBeNull();
    expect(parsed!.sources[3]!.safeHref).toBeNull();
  });

  it("preserves zero values for usage tokens and search calls, omitting undefined", () => {
    const item = makeTurnItem({
      type: "dynamic_tool",
      toolName: "web_search",
      input: { query: "token test" },
      details: {
        response: {
          provider: "codex",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            searchRequests: 0,
            // totalTokens omitted
          },
        },
      },
    });

    const parsed = readNativeSearchData(item);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata?.usage?.inputTokens).toBe(0);
    expect(parsed!.metadata?.usage?.outputTokens).toBe(0);
    expect(parsed!.metadata?.usage?.searchRequests).toBe(0);
    expect(parsed!.metadata?.usage?.totalTokens).toBeUndefined();
  });

  it("omits metadata completely when no provider, model, auth, or usage exist", () => {
    const item = makeTurnItem({
      type: "dynamic_tool",
      toolName: "web_search",
      input: { query: "minimal test" },
      details: {
        response: {
          sources: [{ title: "Doc", url: "https://example.com" }],
        },
      },
    });

    const parsed = readNativeSearchData(item);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata).toBeUndefined();
  });

  it("returns null for non-search dynamic tools or empty unparseable details", () => {
    const bashItem = makeTurnItem({
      type: "dynamic_tool",
      toolName: "bash",
      input: { command: "ls" },
      details: { exitCode: 0 },
    });
    expect(readNativeSearchData(bashItem)).toBeNull();

    const emptySearch = makeTurnItem({
      type: "dynamic_tool",
      toolName: "web_search",
      input: {},
      details: {},
    });
    expect(readNativeSearchData(emptySearch)).toBeNull();
  });

  it("returns null when dynamic_tool has input.query and real output text but unknown or empty details", () => {
    const itemWithEmptyDetails = makeTurnItem({
      type: "dynamic_tool",
      toolName: "web_search",
      input: { query: "fifa world cup official" },
      output: "Generic plain text search results or LLM response text",
      details: {},
    });
    expect(readNativeSearchData(itemWithEmptyDetails)).toBeNull();

    const itemWithUnrelatedDetails = makeTurnItem({
      type: "dynamic_tool",
      toolName: "web_search",
      input: { query: "fifa world cup official" },
      output: "Generic plain text search results",
      details: { unrelatedSummary: "some opaque data", debugCount: 42 },
    });
    expect(readNativeSearchData(itemWithUnrelatedDetails)).toBeNull();
  });
});
