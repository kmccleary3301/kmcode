import {
  codexFileCitationMarkdown,
  resolveCodexFileCitationLink,
} from "@t3tools/client-runtime/codex-file-citations";
import {
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
} from "@t3tools/client-runtime/codex-artifact-templates";
import type { Block, InlineNode } from "@stream-mdx/core";
import type { InlineExtension } from "@stream-mdx/core";
import type { EngineExtensions } from "@stream-mdx/worker/engine";
import type { DocumentPlugin } from "@stream-mdx/plugins";

export const KM_MARKDOWN_EXTENSION_ID = "km-markdown-stream-mdx-1.1-v2";

interface ParsedDirectiveAttributes {
  readonly attributes: Readonly<Record<string, string | null>>;
  readonly end: number;
}

function isDirectiveNameEnd(source: string, index: number): boolean {
  const codePoint = source.codePointAt(index);
  if (codePoint === undefined) return true;
  if (codePoint === 45 || codePoint === 95) return false;
  return /[\p{White_Space}\p{P}]/u.test(String.fromCodePoint(codePoint));
}

function hasOddBackslashEscape(source: string, position: number): boolean {
  let backslashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function parseAttributeBlock(source: string, start: number): ParsedDirectiveAttributes | null {
  if (source[start] !== "{") return null;
  const attributes: Record<string, string | null> = {};
  let index = start + 1;

  while (index < source.length) {
    while (/[\p{White_Space}]/u.test(source[index] ?? "")) index += 1;
    if (source[index] === "}") return { attributes, end: index + 1 };
    const nameStart = index;
    while (/[A-Za-z0-9_-]/u.test(source[index] ?? "")) index += 1;
    if (index === nameStart) return null;
    const name = source.slice(nameStart, index);
    while (/[\p{White_Space}]/u.test(source[index] ?? "")) index += 1;

    if (source[index] !== "=") {
      attributes[name] = null;
      continue;
    }

    index += 1;
    while (/[\p{White_Space}]/u.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote === "\"" || quote === "'") {
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const character = source[index];
        if (character === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else if (character === quote) {
          index += 1;
          closed = true;
          break;
        } else if (character === "\n" || character === "\r") {
          return null;
        } else {
          value += character;
          index += 1;
        }
      }
      if (!closed) return null;
      attributes[name] = value;
      continue;
    }

    const valueStart = index;
    while (index < source.length && !/[\p{White_Space}{}]/u.test(source[index] ?? "")) index += 1;
    if (index === valueStart) return null;
    attributes[name] = source.slice(valueStart, index);
  }
  return null;
}

function closeBracket(source: string, start: number): number | null {
  if (source[start] !== "[") return null;
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (character === "\n" || character === "\r") {
      return null;
    }
  }
  return null;
}

function parseTextCitation(source: string, start: number): ParsedDirectiveAttributes | null {
  const prefix = ":codex-file-citation";
  if (!source.startsWith(prefix, start)) return null;
  let index = start + prefix.length;
  if (!isDirectiveNameEnd(source, index)) return null;
  if (source[index] === "[") {
    const labelEnd = closeBracket(source, index);
    if (labelEnd === null) return null;
    index = labelEnd;
  }
  while (/[ \t]/u.test(source[index] ?? "")) index += 1;
  return parseAttributeBlock(source, index);
}

function parseArtifactTemplateDirective(
  source: string,
  start: number,
): ParsedDirectiveAttributes | null {
  const prefix = "::artifact-template";
  if (!source.startsWith(prefix, start)) return null;
  let index = start + prefix.length;
  if (!isDirectiveNameEnd(source, index)) return null;
  while (/[ \t]/u.test(source[index] ?? "")) index += 1;
  return parseAttributeBlock(source, index);
}

function citationNode(source: string, parsed: ParsedDirectiveAttributes): InlineNode | null {
  const citation = resolveCodexFileCitationLink(parsed.attributes);
  if (citation === null) return null;
  return {
    kind: "plugin",
    name: "file-citation",
    attrs: {
      path: citation.path,
      href: citation.href,
      label: citation.label,
      copy: codexFileCitationMarkdown(citation),
      ...(citation.lineRangeStart === undefined ? {} : { lineRangeStart: String(citation.lineRangeStart) }),
    },
    raw: source,
  };
}

function createFileCitationExtension(): InlineExtension {
  const nodeName = "CodexFileCitation";
  return {
    name: "codex-file-citation",
    lezer: {
      defineNodes: [nodeName],
      parseInline: [
        {
          name: nodeName,
          before: "Link",
          parse(context, _next, position) {
            const localPosition = position - context.offset;
            if (
              localPosition < 0 ||
              context.text[localPosition] !== ":" ||
              context.text[localPosition - 1] === ":" ||
              hasOddBackslashEscape(context.text, localPosition)
            ) {
              return -1;
            }
            const parsed = parseTextCitation(context.text, localPosition);
            if (parsed === null) return -1;
            if (citationNode(context.text.slice(localPosition, parsed.end), parsed) === null) return -1;
            return context.addElement(context.elt(nodeName, position, context.offset + parsed.end));
          },
        },
      ],
    },
    toInline(element, text) {
      const parsed = parseTextCitation(text, element.from);
      if (parsed === null) return null;
      return citationNode(text.slice(element.from, parsed.end), parsed);
    },
  };
}

interface ParsedPullRequestReference {
  readonly kind: "issue" | "commit";
  readonly value: string;
  readonly end: number;
}

function parsePullRequestReference(
  source: string,
  start: number,
): ParsedPullRequestReference | null {
  const previous = source[start - 1];
  if (source[start] === "#") {
    if (previous !== undefined && /[A-Za-z0-9_]/u.test(previous)) return null;
    const match = /^#([1-9]\d*)(?![A-Za-z0-9_])/u.exec(source.slice(start));
    return match?.[1] === undefined
      ? null
      : { kind: "issue", value: match[1], end: start + match[0].length };
  }
  if (
    !/[0-9a-f]/iu.test(source[start] ?? "") ||
    (previous !== undefined && !/[\s([{]/u.test(previous))
  ) {
    return null;
  }
  const commit = /^[0-9a-f]{40}(?![A-Za-z0-9_])/iu.exec(source.slice(start));
  return commit?.[0] === undefined
    ? null
    : { kind: "commit", value: commit[0], end: start + commit[0].length };
}

function createPullRequestReferenceExtension(): InlineExtension {
  const nodeName = "PullRequestReference";
  return {
    name: "pr-reference",
    lezer: {
      defineNodes: [nodeName],
      parseInline: [
        {
          name: nodeName,
          before: "Link",
          parse(context, _next, position) {
            const localPosition = position - context.offset;
            if (localPosition < 0) return -1;
            const parsed = parsePullRequestReference(context.text, localPosition);
            return parsed === null
              ? -1
              : context.addElement(context.elt(nodeName, position, context.offset + parsed.end));
          },
        },
      ],
    },
    toInline(element, text) {
      const parsed = parsePullRequestReference(text, element.from);
      if (parsed === null) return null;
      return {
        kind: "plugin",
        name: "pr-reference",
        attrs: { kind: parsed.kind, value: parsed.value },
        raw: text.slice(element.from, parsed.end),
      };
    },
  };
}

function templatePresentationAttrs(template: CodexArtifactTemplate): Readonly<Record<string, string>> {
  return {
    artifact_kind: template.artifactKind,
    display_name: template.displayName,
    ...(template.galleryKind === undefined ? {} : { gallery_kind: template.galleryKind }),
    skill_directory: template.skillDirectory,
    skill_name: template.skillName,
  };
}
function containsFileCitationNode(nodes: readonly InlineNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === "plugin" && node.name === "file-citation") return true;
    if ("children" in node && node.children !== undefined && containsFileCitationNode(node.children)) {
      return true;
    }
  }
  return false;
}


function templateFromBlock(block: Block): CodexArtifactTemplate | null {
  if (block.type !== "paragraph") return null;
  const source = block.payload.raw.trim();
  const indentation = source.match(/^ {0,3}/u)?.[0].length ?? 0;
  const parsed = parseArtifactTemplateDirective(source, indentation);
  if (parsed === null || source.slice(parsed.end).trim().length > 0) return null;
  return resolveCodexArtifactTemplate(parsed.attributes);
}

function createArtifactTemplatePlugin(): DocumentPlugin {
  return {
    name: "codex-artifact-template",
    process(context) {
      for (const block of context.blocks) {
        if (
          block.type === "paragraph" &&
          block.payload.inline !== undefined &&
          containsFileCitationNode(block.payload.inline) &&
          block.payload.meta !== undefined
        ) {
          delete block.payload.meta.mixedSegments;
          delete block.payload.meta.mixedHtmlTrees;
        }
        const template = templateFromBlock(block);
        if (template === null) continue;
        block.type = "mdx";
        block.payload.inline = [];
        const meta = { ...(block.payload.meta ?? {}) };
        delete meta.mixedSegments;
        delete meta.mixedHtmlTrees;
        delete meta.paragraph;
        delete meta.linkReferences;
        block.payload.meta = {
          ...meta,
          presentation: {
            name: "artifact-template",
            attrs: templatePresentationAttrs(template),
          },
        };
      }
    },
  };
}

export function createKmMarkdownExtensions(): EngineExtensions {
  return {
    inline: [createFileCitationExtension(), createPullRequestReferenceExtension()],
    documentPlugins: [createArtifactTemplatePlugin()],
  };
}
