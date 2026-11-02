import { describe, expect, it } from "vite-plus/test";
import { MessageId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<
    readonly ["user" | "assistant", string, Partial<Omit<ChatMessage, "role" | "text">>?]
  >,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text, overrides], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
    ...overrides,
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
    expect(items[0]?.assistantText).toBe(" Done\t now ");
  });

  it.each(["", "Ultrathink:\n"])(
    "omits attachment-only bootstrap text from the minimap preview (%j)",
    (prefix) => {
      const items = deriveTimelineMinimapItems(
        rows([["user", prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT]]),
      );
      expect(items[0]?.userText).toBe("");
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    expect(resolveTimelineMinimapPreview(next)).toEqual({
      ...first,
      assistantText: "First second",
    });
    expect(resolveTimelineMinimapPreview(first)?.assistantText).toBe("First");
  });

  it("indexes only the user's own prompts, not agent relays or automations", () => {
    const source = rows([
      ["user", "Legacy prompt"],
      [
        "user",
        "TUI 3 → S2: gate passed",
        {
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: ThreadId.make("thread-tui-3"),
        },
      ],
      ["user", "Delegated task", { createdBy: "agent", creationSource: "server" }],
      ["user", "System notice", { createdBy: "system", creationSource: "server" }],
      [
        "user",
        "Nightly check",
        {
          createdBy: "user",
          scheduledTaskId: ScheduledTaskId.make("task-1"),
        },
      ],
      ["user", "My follow-up", { createdBy: "user", creationSource: "web" }],
    ]);
    expect(deriveTimelineMinimapItems(source).map((item) => item.userText)).toEqual([
      "Legacy prompt",
      "My follow-up",
    ]);
  });
});
