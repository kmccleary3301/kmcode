import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { parseAssistantCitationHref } from "./assistantCitations.ts";
import {
  parseComposerContextHref,
  isAttachmentOnlyBootstrapPrompt,
} from "./composerContextReferences.ts";
import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";

// Mirrors block boundaries used by KM's rendered Markdown DOM; inline wrappers
// such as strong text and Shiki tokens must not split a searchable phrase.
export const THREAD_FIND_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

export interface ThreadFindInlineSkill {
  readonly name: string;
  readonly displayName?: string | undefined;
}

function displaySkillName(skill: ThreadFindInlineSkill): string {
  const displayName = skill.displayName?.trim();
  if (displayName) return displayName;
  return skill.name
    .split(/[\s:_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const SKILL_TOKEN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

function renderSkillTokens(text: string, skills: readonly ThreadFindInlineSkill[]): string {
  return text.replace(SKILL_TOKEN, (whole, prefix: string, name: string) => {
    const skill = skills.find((candidate) => candidate.name === name);
    return skill === undefined ? whole : `${prefix}${displaySkillName(skill)}`;
  });
}

function matchingDelimiter(
  text: string,
  start: number,
  open: string,
  close: string,
): number | null {
  let depth = 1;
  for (let index = start + open.length; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text.startsWith(open, index)) {
      depth += 1;
      index += open.length - 1;
    } else if (text.startsWith(close, index)) {
      depth -= 1;
      if (depth === 0) return index;
      index += close.length - 1;
    }
  }
  return null;
}

interface MarkdownLink {
  readonly end: number;
  readonly label: string;
  readonly href: string;
  readonly image: boolean;
}

function markdownLinkAt(text: string, start: number): MarkdownLink | null {
  const image = text[start] === "!";
  const labelStart = start + (image ? 1 : 0);
  if (text[labelStart] !== "[") return null;
  const labelEnd = matchingDelimiter(text, labelStart, "[", "]");
  if (labelEnd === null || text[labelEnd + 1] !== "(") return null;
  const hrefEnd = matchingDelimiter(text, labelEnd + 1, "(", ")");
  if (hrefEnd === null) return null;
  const destination = text.slice(labelEnd + 2, hrefEnd).trim();
  const href = destination.startsWith("<")
    ? (destination.match(/^<([^>]*)>/)?.[1] ?? destination)
    : (destination.match(/^[^\s]+/)?.[0] ?? "");
  return {
    end: hrefEnd + 1,
    label: text.slice(labelStart + 1, labelEnd),
    href,
    image,
  };
}

function citationLabel(href: string): string | null {
  const citation = parseAssistantCitationHref(href);
  if (citation === null) return null;
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  return preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
}

function entityText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
      case "&#39;":
        return "'";
      case "&nbsp;":
        return "\u00a0";
      default: {
        const codePoint = entity.startsWith("&#x")
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number.parseInt(entity.slice(2, -1), 10);
        return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      }
    }
  });
}

function inlineMarkdownSegments(
  source: string,
  skills: readonly ThreadFindInlineSkill[],
  useSkills: boolean,
  lineBreaks: boolean,
): string[] {
  const segments: string[] = [];
  let text = "";
  let plainText = "";
  let closingDelimiters: Map<number, string> | undefined;
  let contextBoundary = false;
  const flushPlainText = () => {
    text += useSkills ? renderSkillTokens(plainText, skills) : plainText;
    plainText = "";
  };
  const flush = () => {
    flushPlainText();
    if (text.trim()) segments.push(text);
    text = "";
  };
  const append = (value: string) => {
    plainText += value;
    contextBoundary = false;
  };
  const appendWithoutSkills = (value: string) => {
    flushPlainText();
    text += value;
    contextBoundary = false;
  };
  for (let index = 0; index < source.length;) {
    const closingDelimiter = closingDelimiters?.get(index);
    if (closingDelimiter !== undefined) {
      index += closingDelimiter.length;
      continue;
    }
    const character = source[index]!;
    if (character === "\\" && index + 1 < source.length) {
      append(source[index + 1]!);
      index += 2;
      continue;
    }
    if (character === "\n") {
      if (lineBreaks) {
        flush();
        if (contextBoundary) text = " ";
      } else {
        append(" ");
      }
      contextBoundary = false;
      index += 1;
      continue;
    }
    if (character === "`") {
      let markerEnd = index + 1;
      while (source[markerEnd] === "`") markerEnd += 1;
      const marker = source.slice(index, markerEnd);
      const closing = source.indexOf(marker, markerEnd);
      if (closing >= 0) {
        appendWithoutSkills(source.slice(markerEnd, closing).replace(/\r?\n/g, " "));
        index = closing + marker.length;
        continue;
      }
    }
    if (character === "!" || character === "[") {
      const link = markdownLinkAt(source, index);
      if (link) {
        if (parseComposerContextHref(link.href)) {
          flush();
          contextBoundary = true;
        } else {
          const citation = citationLabel(link.href);
          appendWithoutSkills(
            citation ??
              (link.image
                ? link.label
                : inlineMarkdownSegments(link.label, [], false, false).join("")),
          );
        }
        index = link.end;
        continue;
      }
    }
    if (character === "<") {
      const close = source.indexOf(">", index + 1);
      if (close >= 0) {
        const rawTag = source.slice(index, close + 1);
        const autolink = /^<https?:\/\/([^>]+)>$/i.exec(rawTag);
        if (autolink) {
          append(autolink[1]!);
          index = close + 1;
          continue;
        }
        const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>$/.exec(rawTag);
        if (tag && tag[1]?.toLowerCase() !== "review_comment") {
          if (THREAD_FIND_BLOCK_TAGS.has(tag[1]?.toLowerCase() ?? "")) flush();
          index = close + 1;
          continue;
        }
      }
    }
    if (character === "&") {
      const entity = /^&(?:amp|lt|gt|quot|apos|nbsp|#39|#x[0-9a-f]+|#\d+);/i.exec(
        source.slice(index),
      )?.[0];
      if (entity) {
        append(entityText(entity));
        index += entity.length;
        continue;
      }
    }
    const delimiter = ["**", "__", "~~", "*", "_"].find((candidate) => {
      if (!source.startsWith(candidate, index)) return false;
      if (candidate === "_" && index > 0 && /[\p{L}\p{N}]/u.test(source[index - 1]!)) {
        return false;
      }
      return source.indexOf(candidate, index + candidate.length) >= 0;
    });
    if (delimiter) {
      const closing = source.indexOf(delimiter, index + delimiter.length);
      if (closing >= 0) {
        (closingDelimiters ??= new Map()).set(closing, delimiter);
        index += delimiter.length;
        continue;
      }
    }
    append(character);
    index += 1;
  }
  flush();
  return segments;
}

function tableCells(line: string): string[] {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (source[index] === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += source[index];
    }
  }
  cells.push(cell);
  return cells;
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  if (cells.length <= 1) return false;
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell.trim())) return false;
  }
  return true;
}

/** Extracts searchable text with no parser dependencies, matching KM's Markdown block semantics. */
function markdownThreadFindText(
  markdown: string,
  skills: readonly ThreadFindInlineSkill[] = [],
  lineBreaks = false,
): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const segments: string[] = [];
  let paragraph = "";
  let codeFence: { marker: string; length: number } | null = null;
  let codeLines: string[] = [];
  let indentedCode: string[] | null = null;
  let inTable = false;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      segments.push(...inlineMarkdownSegments(paragraph, skills, true, lineBreaks));
      paragraph = "";
    }
  };
  const flushIndentedCode = () => {
    if (indentedCode !== null) {
      const code = indentedCode.join("\n");
      if (code.trim()) segments.push(code);
      indentedCode = null;
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (codeFence) {
      const closing = new RegExp(`^ {0,3}${codeFence.marker[0]}{${codeFence.length},}\\s*$`);
      if (closing.test(line)) {
        const code = codeLines.join("\n");
        if (code.trim()) segments.push(code);
        codeFence = null;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (fence) {
      flushParagraph();
      flushIndentedCode();
      codeFence = { marker: fence[1]!, length: fence[1]!.length };
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      flushIndentedCode();
      inTable = false;
      continue;
    }

    const nextLine = lines[lineIndex + 1] ?? "";
    if (isTableSeparator(line)) {
      flushParagraph();
      flushIndentedCode();
      inTable = true;
      continue;
    }
    if (line.includes("|") && (inTable || isTableSeparator(nextLine))) {
      flushParagraph();
      flushIndentedCode();
      for (const cell of tableCells(line)) {
        segments.push(...inlineMarkdownSegments(cell.trim(), skills, false, false));
      }
      inTable = true;
      continue;
    }
    inTable = false;

    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushIndentedCode();
      segments.push(...inlineMarkdownSegments(heading[1]!, skills, true, false));
      continue;
    }
    const listItem = /^ {0,3}(?:[-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      flushIndentedCode();
      const item = (listItem[1] ?? "").replace(/^\[[ xX]\]\s+/, "");
      segments.push(...inlineMarkdownSegments(item, skills, true, false));
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      flushIndentedCode();
      const quote = line.replace(/^ {0,3}>\s?/, "");
      if (paragraph.length > 0) paragraph += lineBreaks ? `\n${quote}` : ` ${quote}`;
      else paragraph = quote;
      continue;
    }
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      flushParagraph();
      flushIndentedCode();
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      flushParagraph();
      if (indentedCode === null) indentedCode = [];
      indentedCode.push(line.replace(/^(?: {4}|\t)/, ""));
      continue;
    }
    flushIndentedCode();
    if (paragraph.length > 0) paragraph += lineBreaks ? `\n${line}` : `\n${line}`;
    else paragraph = line;
  }
  flushParagraph();
  flushIndentedCode();
  if (codeFence !== null && codeLines.length > 0) {
    const code = codeLines.join("\n");
    if (code.trim()) segments.push(code);
  }
  return segments;
}

function proposedPlanTitle(markdown: string): string | null {
  const heading = markdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0
    ? inlineMarkdownSegments(heading, [], false, false).join("")
    : null;
}

function stripDisplayedPlanMarkdown(markdown: string): string {
  const lines = markdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  if (
    sourceLines[0]
      ?.match(/^\s{0,3}#{1,6}\s+(.+)$/)?.[1]
      ?.trim()
      .toLowerCase() === "summary"
  ) {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  }
  return sourceLines.join("\n");
}

/** Plans render `$skill` tokens literally, so their body is indexed as written. */
export function searchablePlanSegments(markdown: string): readonly string[] {
  return [
    proposedPlanTitle(markdown) ?? "Proposed plan",
    ...markdownThreadFindText(stripDisplayedPlanMarkdown(markdown)),
  ];
}

export function searchableMessageSegments(
  message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "context">,
  skills: readonly ThreadFindInlineSkill[] = [],
): readonly string[] | null {
  if (message.role === "user") {
    if (isAttachmentOnlyBootstrapPrompt(message.text)) return [];
    const text = message.context ? message.text : upgradeLegacyContextMessage(message.text).text;
    return markdownThreadFindText(text, skills, true);
  }
  if (message.role !== "assistant") return null;
  const text = message.text || (message.streaming ? "" : "(empty response)");
  return markdownThreadFindText(text, skills);
}

export interface ThreadFindTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

function foldThreadFindCase(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;

  let folded = "";
  for (const character of text) {
    const loweredCharacter = character.toLowerCase().replace(/ς/g, "σ");
    folded += loweredCharacter.length === character.length ? loweredCharacter : character;
  }
  return folded;
}

function scanThreadFindOccurrences(text: string, query: string, offsets?: number[]): number {
  if (text.length === 0 || query.length === 0) return 0;
  const foldedText = foldThreadFindCase(text);
  const foldedQuery = foldThreadFindCase(query);
  let count = 0;
  let cursor = 0;
  while (cursor <= foldedText.length - foldedQuery.length) {
    const offset = foldedText.indexOf(foldedQuery, cursor);
    if (offset === -1) break;
    offsets?.push(offset);
    count += 1;
    cursor = offset + foldedQuery.length;
  }
  return count;
}

export function countThreadFindOccurrences(text: string, query: string): number {
  return scanThreadFindOccurrences(text, query);
}

export function findThreadFindOccurrences(text: string, query: string): number[] {
  const offsets: number[] = [];
  scanThreadFindOccurrences(text, query, offsets);
  return offsets;
}

export function splitThreadFindText(text: string, query: string): ThreadFindTextPart[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [{ text, highlighted: false, start: 0 }];
  const parts: ThreadFindTextPart[] = [];
  let cursor = 0;
  for (const offset of findThreadFindOccurrences(text, normalizedQuery)) {
    if (offset > cursor)
      parts.push({ text: text.slice(cursor, offset), highlighted: false, start: cursor });
    parts.push({
      text: text.slice(offset, offset + normalizedQuery.length),
      highlighted: true,
      start: offset,
    });
    cursor = offset + normalizedQuery.length;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  return parts;
}
