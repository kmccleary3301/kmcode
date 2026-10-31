import type { Block, InlineNode } from "@stream-mdx/core";
import { createMarkdownSnapshotCompiler } from "@stream-mdx/worker/direct";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  isAttachmentOnlyBootstrapPrompt,
  parseComposerContextHref,
} from "@t3tools/shared/composerContextReferences";
import {
  searchableMessageSegments,
  type ThreadFindInlineSkill,
} from "@t3tools/shared/paletteSearch";
import { expect, it } from "vite-plus/test";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

import { inlineNodesToPlainText } from "./components/markdown/MarkdownLinks.tsx";
import { createKmMarkdownExtensions } from "./components/markdown/kmMarkdownExtensions.ts";

const compiler = createMarkdownSnapshotCompiler({
  extensionId: "thread-find-parity-test",
  extensions: createKmMarkdownExtensions(),
});

const SKILL_TOKEN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

type FindMessage = Pick<
  OrchestrationV2ConversationMessage,
  "role" | "text" | "streaming" | "context"
>;

function isInlineNode(value: unknown): value is InlineNode {
  return (
    typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string"
  );
}

function isInlineNodes(value: unknown): value is readonly InlineNode[] {
  return Array.isArray(value) && value.every(isInlineNode);
}

function renderSkillTokens(text: string, skills: readonly ThreadFindInlineSkill[]): string {
  return text.replace(SKILL_TOKEN, (whole, prefix: string, name: string) => {
    const skill = skills.find((candidate) => candidate.name === name);
    return skill === undefined ? whole : `${prefix}${formatProviderSkillDisplayName(skill)}`;
  });
}

function citationDisplayLabel(href: string): string | null {
  const citation = parseAssistantCitationHref(href);
  if (citation === null) return null;
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  return preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
}

function searchableInlineSegments(
  nodes: readonly InlineNode[],
  skills: readonly ThreadFindInlineSkill[],
): string[] {
  const segments: string[] = [];
  let text = "";
  let pendingText = "";
  const flushPendingText = () => {
    text += renderSkillTokens(pendingText, skills);
    pendingText = "";
  };
  const flush = () => {
    flushPendingText();
    if (text.trim()) segments.push(text);
    text = "";
  };
  const visit = (node: InlineNode): void => {
    if (node.kind === "text") {
      pendingText += node.text;
      return;
    }
    flushPendingText();
    if (node.kind === "link") {
      if (typeof node.href !== "string") {
        text += inlineNodesToPlainText(node.children);
        return;
      }
      if (parseComposerContextHref(node.href)) {
        flush();
        return;
      }
      const citation = citationDisplayLabel(node.href);
      text += citation ?? inlineNodesToPlainText(node.children);
      return;
    }
    if (node.kind === "strong" || node.kind === "em" || node.kind === "strike") {
      for (const child of node.children) visit(child);
      return;
    }
    if ((node.kind === "html" || node.kind === "plugin") && node.children !== undefined) {
      for (const child of node.children) visit(child);
      return;
    }
    text += inlineNodesToPlainText([node]);
  };
  for (const node of nodes) visit(node);
  flush();
  return segments;
}

function searchableBlockSegments(
  blocks: readonly Block[],
  skills: readonly ThreadFindInlineSkill[],
): string[] {
  const segments: string[] = [];
  const appendTableCells = (group: unknown) => {
    if (
      typeof group !== "object" ||
      group === null ||
      !("cells" in group) ||
      !Array.isArray(group.cells)
    ) {
      return;
    }
    const cells: readonly unknown[] = group.cells;
    for (const cell of cells) {
      if (
        typeof cell === "object" &&
        cell !== null &&
        "inline" in cell &&
        isInlineNodes(cell.inline)
      ) {
        segments.push(...searchableInlineSegments(cell.inline, []));
      }
    }
  };

  for (const block of blocks) {
    const meta = block.payload.meta;
    if (block.type === "code") {
      const code = meta?.code;
      if (typeof code === "string" && code.trim()) segments.push(code);
      continue;
    }
    if (block.type === "list") {
      const items = meta?.items;
      if (Array.isArray(items)) {
        const listItems: readonly unknown[] = items;
        for (const item of listItems) {
          if (isInlineNodes(item)) segments.push(...searchableInlineSegments(item, skills));
        }
      }
      continue;
    }
    if (block.type === "table") {
      const table = meta?.table;
      if (typeof table === "object" && table !== null) {
        if ("header" in table) appendTableCells(table.header);
        if ("rows" in table && Array.isArray(table.rows)) {
          const rows: readonly unknown[] = table.rows;
          for (const row of rows) appendTableCells(row);
        }
      }
      continue;
    }
    if (block.payload.inline !== undefined) {
      segments.push(...searchableInlineSegments(block.payload.inline, skills));
    }
  }
  return segments;
}

const citationHref =
  "t3-citation://v1/env_1/thread_1/message_1?text=quoted%20text&start=0&end=11&prefix=&suffix=";
const fixtures: ReadonlyArray<{
  readonly message: FindMessage;
  readonly skills?: readonly ThreadFindInlineSkill[];
}> = [
  { message: { role: "assistant", text: "- **first item**\n- second item", streaming: false } },
  { message: { role: "assistant", text: "```ts\nconst needle = true;\n```", streaming: false } },
  {
    message: {
      role: "assistant",
      text: "Read [visible docs](https://hidden.example/needle)",
      streaming: false,
    },
  },
  { message: { role: "assistant", text: `[Assistant quote](${citationHref})`, streaming: false } },
  {
    message: {
      role: "user",
      text: "before[hidden label](t3-context://v1/terminal/terminal_1)after",
      streaming: false,
      context: { version: 1, records: [] },
    },
  },
  {
    message: { role: "assistant", text: "Use $deploy-prod now.", streaming: false },
    skills: [{ name: "deploy-prod", displayName: "Deploy Production" }],
  },
  {
    message: {
      role: "assistant",
      text: "| name | value |\n| --- | --- |\n| **alpha** | [docs](https://hidden.example) |",
      streaming: false,
    },
  },
];

it("keeps the shared extractor aligned with KM StreamMdx rendered text", async () => {
  expect(parseAssistantCitationHref(citationHref)).not.toBeNull();
  for (const fixture of fixtures) {
    const { blocks } = await compiler.compile({ text: fixture.message.text });
    const parsedText = searchableBlockSegments(blocks, fixture.skills ?? []);
    expect(searchableMessageSegments(fixture.message, fixture.skills)).toEqual(parsedText);
  }

  const { blocks } = await compiler.compile({ text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT });
  const renderedPlaceholderText = isAttachmentOnlyBootstrapPrompt(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)
    ? []
    : searchableBlockSegments(blocks, []);
  expect(
    searchableMessageSegments({
      role: "user",
      text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      streaming: false,
    }),
  ).toEqual(renderedPlaceholderText);
});
