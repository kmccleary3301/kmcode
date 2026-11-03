import { isUncPath, isWindowsDrivePath, normalizeProjectPathForComparison } from "./path.ts";

function imageEmbed(path: string): string {
  const destination = isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
  const escaped = destination.replace(/[%?#&\\\r\n]/g, encodeURIComponent).replace(/[<>]/g, "\\$&");
  return `![](<${escaped}>)`;
}

function withoutCode(text: string): string {
  const lines = text.split(/(?<=\n)/);
  let fence: { readonly marker: string; readonly length: number } | undefined;
  const visible: Array<string> = [];
  for (const line of lines) {
    const content = line.replace(/[\r\n]+$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence !== undefined) {
      if (
        marker !== undefined &&
        marker[0] === fence.marker &&
        marker.length >= fence.length &&
        /^[`~]+[ \t]*$/.test(content.slice(content.indexOf(marker)))
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = { marker: marker[0]!, length: marker.length };
      continue;
    }
    visible.push(line);
  }
  return visible.join("").replace(/(`+)(?!`)\S[\s\S]*?\S\1(?!`)/g, "");
}

function unescaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 0;
}

function labelKey(label: string): string {
  return label
    .trim()
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@\\[\]^_`{|}~])/g, "$1")
    .toLowerCase();
}

function visibleMarkdown(text: string): string {
  return withoutCode(text)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|pre|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
}

function markdownImageSources(markdown: string): ReadonlyArray<string> {
  const references = new Map<string, string>();
  const definition = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>\r\n]*)>|([^\s\r\n]+))/gm;
  for (const match of markdown.matchAll(definition)) {
    references.set(labelKey(match[1]!), match[2] ?? match[3]!);
  }

  const sources: Array<string> = [];
  const image =
    /!\[([^\]]*)\](?:\(\s*(?:<([^>\r\n]*)>|([^\s)]*(?:\\.[^\s)]*)*))[^)]*\)|\[([^\]]*)\])/g;
  for (const match of markdown.matchAll(image)) {
    const index = match.index ?? 0;
    if (!unescaped(markdown, index)) continue;
    const inlineSource = match[2] ?? match[3];
    if (inlineSource !== undefined) {
      sources.push(inlineSource.replace(/\\([<>])/g, "$1"));
      continue;
    }
    const label = match[4] || match[1]!;
    const source = references.get(labelKey(label));
    if (source !== undefined) sources.push(source.replace(/^<|>$/g, ""));
  }
  return sources;
}

function normalizedMarkdownPath(source: string): string {
  let path = source;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep malformed percent escapes literal; they may be part of a local filename.
  }
  const filePath = /^file:\/\/([^/]+)\/(.*)$/i.exec(path);
  if (filePath !== null) {
    path = `\\\\${filePath[1]}\\${filePath[2]!.replaceAll("/", "\\")}`;
  } else if (/^file:\/\/\//i.test(path)) {
    path = path.slice("file://".length);
  }
  return normalizeProjectPathForComparison(path);
}

function unclosedBlockEnd(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  let fence: { readonly marker: string; readonly length: number } | undefined;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) fence = { marker: marker[0]!, length: marker.length };
    } else if (
      marker !== undefined &&
      marker[0] === fence.marker &&
      marker.length >= fence.length &&
      /^[`~]+[ \t]*$/.test(line.slice(line.indexOf(marker)))
    ) {
      fence = undefined;
    }
  }
  if (fence !== undefined) return fence.marker.repeat(fence.length);

  const commentStart = text.lastIndexOf("<!--");
  if (commentStart > text.lastIndexOf("-->")) return "-->";
  for (const tag of ["script", "pre", "style", "textarea"] as const) {
    const open = new RegExp(`<${tag}(?=[\\s>])`, "ig");
    const close = new RegExp(`</${tag}\\s*>`, "ig");
    let start = -1;
    for (const match of text.matchAll(open)) start = match.index ?? start;
    let end = -1;
    for (const match of text.matchAll(close)) end = match.index ?? end;
    if (start > end) return `</${tag}>`;
  }
  return undefined;
}

/** Appends an embed for each saved image the reply does not already show. */
export function appendGeneratedImageEmbeds(text: string, savedPaths: Iterable<string>): string {
  const markdown = visibleMarkdown(text);
  const shown = new Set(markdownImageSources(markdown).map(normalizedMarkdownPath));
  const missing = new Map<string, string>();
  for (const path of savedPaths) {
    const key = normalizeProjectPathForComparison(path);
    if (!shown.has(key) && !missing.has(key) && !markdown.includes(imageEmbed(path))) {
      missing.set(key, path);
    }
  }
  if (missing.size === 0) return text;

  const end = unclosedBlockEnd(text);
  let result = end === undefined ? text : `${text}${/[\r\n]$/.test(text) ? "" : "\n"}${end}`;
  for (const path of missing.values()) {
    result += `${result.length > 0 ? "\n\n" : ""}${imageEmbed(path)}`;
  }
  return result;
}
