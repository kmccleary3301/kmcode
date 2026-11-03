import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";

export type ActivityDetailInput =
  | OrchestrationV2TurnItem
  | OrchestrationV2ProjectedTurnItem
  | {
      readonly id?: string;
      readonly tone?: string;
      readonly kind?: string;
      readonly summary?: string;
      readonly payload?: unknown;
      readonly item?: unknown;
      readonly name?: string;
      readonly toolName?: string;
      readonly input?: unknown;
      readonly result?: unknown;
      readonly output?: unknown;
      readonly [key: string]: unknown;
    };

export type ActivityDetailListingRow =
  | { readonly kind: "context" | "match" | "range"; readonly gutter: string; readonly text: string }
  | { readonly kind: "gap"; readonly gutter: ""; readonly text: "" };

export interface ActivityDetailDiffRow {
  readonly kind: "added" | "removed" | "context" | "hunk" | "marker";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly hashLine?: boolean;
}

export type ActivityDetailBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly source: string; readonly alt: string }
  | { readonly kind: "structured"; readonly value: unknown }
  | {
      readonly kind: "status";
      readonly label: string;
      readonly status: string;
      readonly description?: string;
    }
  | { readonly kind: "target"; readonly text: string }
  | {
      readonly kind: "options";
      readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
    }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly language: string;
      readonly title?: string;
      readonly softWrap?: boolean;
    }
  | {
      readonly kind: "listing";
      readonly path: string | null;
      readonly tag: string | null;
      readonly language: string | null;
      readonly rows: ReadonlyArray<ActivityDetailListingRow>;
      readonly notes: ReadonlyArray<string>;
    }
  | {
      readonly kind: "diff";
      readonly path: string | null;
      readonly language: string | null;
      readonly mode: "unified" | "hashline" | "edit";
      readonly hashLine: boolean;
      readonly rows: ReadonlyArray<ActivityDetailDiffRow>;
      readonly raw: string;
    };

export interface ActivityDetailSection {
  readonly title: string;
  readonly description?: string;
  readonly blocks: ReadonlyArray<ActivityDetailBlock>;
}

export interface ParsedActivityDetail {
  readonly sections: ReadonlyArray<ActivityDetailSection>;
}

export interface ActivityToolPresentation {
  readonly toolName: string;
  readonly intent: string | undefined;
  readonly summary: string | undefined;
  readonly inputText: string | null;
}

type JsonRecord = Record<string, unknown>;

const EVAL_TOOL_NAMES: Record<string, true> = {
  eval: true,
  js: true,
  javascript: true,
  python: true,
  py: true,
  notebook: true,
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(record: JsonRecord | null, keys: ReadonlyArray<string>): string | null {
  if (record === null) return null;
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function parsedArgumentValue(rawInput: unknown): unknown {
  if (typeof rawInput !== "string") return rawInput;
  try {
    return JSON.parse(rawInput) as unknown;
  } catch {
    return rawInput;
  }
}

function withInputMetadata(
  args: JsonRecord,
  blocks: ReadonlyArray<ActivityDetailBlock>,
  consumed: ReadonlySet<string>,
): ReadonlyArray<ActivityDetailBlock> {
  const metadata = omitConsumedArgumentPaths(args, "", consumed);
  if (
    metadata === undefined ||
    (asRecord(metadata) !== null && Object.keys(asRecord(metadata) ?? {}).length === 0)
  )
    return blocks;
  return [...blocks, { kind: "structured", value: metadata }];
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

type ConsumedArgumentPaths = Set<string>;

function argumentPath(parent: string, segment: string | number): string {
  const encoded =
    typeof segment === "number"
      ? String(segment)
      : segment.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
  return parent ? `${parent}.${encoded}` : encoded;
}

function splitArgumentPath(path: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let escaped = false;
  for (const character of path) {
    if (escaped) {
      segment += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ".") {
      segments.push(segment);
      segment = "";
    } else {
      segment += character;
    }
  }
  if (escaped) segment += "\\";
  segments.push(segment);
  return segments;
}

function omitConsumedArgumentPaths(
  value: unknown,
  path: string,
  consumed: ReadonlySet<string>,
): unknown {
  if (consumed.has(path)) return undefined;
  const prefix = path ? `${path}.` : "";
  let hasConsumedDescendant = false;
  for (const candidate of consumed) {
    if (candidate.startsWith(prefix)) {
      hasConsumedDescendant = true;
      break;
    }
  }
  if (!hasConsumedDescendant) return value;
  if (Array.isArray(value)) {
    const remaining = value.map((entry, index) =>
      omitConsumedArgumentPaths(entry, argumentPath(path, index), consumed),
    );
    if (remaining.every((entry) => entry === undefined)) return undefined;
    return remaining.map((entry) => (entry === undefined ? null : entry));
  }
  const record = asRecord(value);
  if (record === null) return value;
  const remaining: JsonRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    const child = omitConsumedArgumentPaths(entry, argumentPath(path, key), consumed);
    if (child !== undefined) remaining[key] = child;
  }
  if (Object.keys(remaining).length > 0 || Object.keys(record).length === 0) return remaining;
  return undefined;
}

function argumentStringAtPath(args: JsonRecord, path: string): string | null {
  let value: unknown = args;
  for (const segment of splitArgumentPath(path)) {
    if (Array.isArray(value)) {
      const index = Number(segment);
      value = Number.isInteger(index) ? value[index] : undefined;
    } else {
      const record = asRecord(value);
      if (record === null) return null;
      value = record[segment];
    }
  }
  return typeof value === "string" ? value : null;
}

function argText(args: JsonRecord | null, ...keys: string[]): string | null {
  if (args === null) return null;
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return stringifyValue(value);
  }
  return null;
}

function argTextEntry(
  args: JsonRecord | null,
  ...keys: string[]
): { readonly key: string; readonly value: string } | null {
  if (args === null) return null;
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") return { key, value };
    if (typeof value === "number" || typeof value === "boolean")
      return { key, value: String(value) };
    return { key, value: stringifyValue(value) };
  }
  return null;
}

function argStringEntry(
  args: JsonRecord | null,
  ...keys: string[]
): { readonly key: string; readonly value: string } | null {
  if (args === null) return null;
  for (const key of keys) {
    if (typeof args[key] === "string") return { key, value: args[key] as string };
  }
  return null;
}

function markUntruncated(
  consumed: ConsumedArgumentPaths,
  path: string,
  value: string,
  maxLength: number,
): void {
  if (compactPreview(value, maxLength) === value) consumed.add(path);
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function plainPreviewText(value: string): string {
  return value
    .replace(/```[a-z0-9_+-]*\n?/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(
      /!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
      (_match, label: string, href: string) => label || href,
    )
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactPreview(value: string, maxLength = 140): string {
  const plain = plainPreviewText(value);
  return plain.length <= maxLength ? plain : `${plain.slice(0, maxLength - 1)}…`;
}

function languageFromPath(path: string | null): string | null {
  if (path === null) return null;
  const normalized = path.toLowerCase().split(/[\\/]/).at(-1) ?? path.toLowerCase();
  if (normalized === "dockerfile") return "dockerfile";
  const extension = normalized.slice(normalized.lastIndexOf(".") + 1);
  if (!extension || extension === normalized) return null;
  const languages: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mdx: "mdx",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    swift: "swift",
    ts: "typescript",
    tsx: "tsx",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[extension] ?? null;
}

function languageFromText(value: string): string | null {
  const first = firstNonEmptyLine(value);
  if (
    /^(?:import|export)\s.+from\s+["']/.test(first) ||
    /\b(?:const|let|function|interface)\s+\w+/.test(first)
  ) {
    return "typescript";
  }
  if (/^(?:#!.*\b(?:bash|sh)|(?:set -e|printf |echo |cd |npm |pnpm |bun |git ))/.test(first)) {
    return "bash";
  }
  if (/^(?:def |from \w+ import |import \w+|print\()/.test(first)) return "python";
  return null;
}

function evalLanguage(toolName: string, value: unknown): string {
  const name = toolName.toLowerCase();
  if (name === "js" || name === "javascript") return "javascript";
  if (name === "python" || name === "py") return "python";
  if (
    typeof value === "string" &&
    /^(?:const|let|var|function|import |export )/.test(value.trim())
  ) {
    return "javascript";
  }
  return "python";
}

interface EvalCell {
  readonly code: string;
  readonly language: string;
  readonly title?: string;
  readonly codePath?: string;
  readonly titlePath?: string;
}

function parseLegacyEvalInput(input: string, toolName: string): ReadonlyArray<EvalCell> {
  const cells: Array<{ language: string; title?: string; code: string[] }> = [];
  let current: { language: string; title?: string; code: string[] } | null = null;
  for (const line of input.replace(/\r\n?/g, "\n").split("\n")) {
    const begin = line.match(/^\*{2,}\s*Begin\s+(\S+)/i);
    if (begin) {
      current = { language: evalLanguage(toolName, begin[1]), code: [] };
      continue;
    }
    if (/^\*{2,}\s*End\b/i.test(line)) {
      if (current !== null) cells.push(current);
      current = null;
      continue;
    }
    if (current !== null) {
      const title = line.match(/^\*{2,}\s*Title\s*:\s*(.+?)\s*$/i);
      if (title) {
        current.title = title[1] ?? "";
        continue;
      }
      if (/^\*{2,}\s*(?:Timeout|Reset)\b/i.test(line)) continue;
      current.code.push(line);
    }
  }
  return cells
    .map((cell) => ({
      code: cell.code.join("\n"),
      language: cell.language,
      ...(cell.title === undefined ? {} : { title: cell.title }),
    }))
    .filter((cell) => cell.code.trim() || cell.title);
}

function parseEvalCells(args: JsonRecord | null, toolName: string): ReadonlyArray<EvalCell> {
  if (args === null) return [];
  const language = firstString(args, ["language", "lang"]);
  if (Array.isArray(args.cells)) {
    const cells: EvalCell[] = [];
    for (let index = 0; index < args.cells.length; index++) {
      const entry = args.cells[index];
      const record = asRecord(entry);
      if (record === null) {
        if (typeof entry === "string") {
          cells.push({
            code: entry,
            language: language ?? evalLanguage(toolName, entry),
            codePath: argumentPath("cells", index),
          });
        }
        continue;
      }
      const codeSource = ["code", "input", "source"].find((key) => typeof record[key] === "string");
      if (codeSource === undefined) continue;
      const code = record[codeSource] as string;
      const titleSource = ["title", "name", "description"].find(
        (key) => typeof record[key] === "string" && (record[key] as string).trim(),
      );
      const cellLanguage =
        firstString(record, ["language", "lang"]) ?? language ?? evalLanguage(toolName, code);
      cells.push({
        code,
        language: cellLanguage,
        ...(titleSource === undefined ? {} : { title: record[titleSource] as string }),
        codePath: argumentPath(argumentPath("cells", index), codeSource),
        ...(titleSource === undefined
          ? {}
          : { titlePath: argumentPath(argumentPath("cells", index), titleSource) }),
      });
    }
    if (cells.length > 0) return cells;
  }
  if (typeof args.code === "string") {
    const title = typeof args.title === "string" ? args.title : undefined;
    return [
      {
        code: args.code,
        language: language ?? evalLanguage(toolName, args.code),
        ...(title === undefined ? {} : { title }),
        codePath: "code",
        ...(title === undefined ? {} : { titlePath: "title" }),
      },
    ];
  }
  if (typeof args.input === "string") {
    const legacy = parseLegacyEvalInput(args.input, toolName);
    if (legacy.length > 0) return legacy;
    return [
      {
        code: args.input,
        language: language ?? evalLanguage(toolName, args.input),
        codePath: "input",
      },
    ];
  }
  return [];
}

function toolIntent(toolName: string, args: JsonRecord | null): string | undefined {
  if (args !== null) {
    for (const key of ["i", "_i", "description"]) {
      const value = asNonEmptyString(args[key]);
      if (value !== null) return plainPreviewText(value);
    }
  }
  if (EVAL_TOOL_NAMES[toolName.toLowerCase()] === true) {
    const title = parseEvalCells(args, toolName).find((cell) => cell.title?.trim())?.title;
    if (title) return plainPreviewText(title);
  }
  return undefined;
}

const READ_TOOL_NAMES: Record<string, true> = {
  read: true,
  view: true,
  cat: true,
  show: true,
  file_read: true,
};
const EDIT_FAMILY_TOOLS: Record<string, true> = {
  edit: true,
  apply_patch: true,
  patch: true,
  replace: true,
  file_change: true,
};

function isCommandTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "bash" ||
    name === "sh" ||
    name === "zsh" ||
    name === "execute" ||
    name === "command_execution" ||
    name.includes("shell") ||
    name.includes("exec")
  );
}

function pathSelector(args: JsonRecord | null): string {
  const path = argText(args, "path", "file_path", "file", "filename") ?? "";
  const selector = argText(args, "sel");
  return selector === null ? path : `${path}:${selector}`;
}

function patchTarget(input: string): string | null {
  const snapshot = input.match(/^\[([^\]\n]+)#[\da-f]{4}\]\r?$/im);
  if (snapshot) return snapshot[1] ?? null;
  const patch = input.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\r?$/m);
  return patch?.[1] ?? null;
}

function toolTarget(toolName: string, args: JsonRecord | null): string {
  const name = toolName.toLowerCase();
  if (READ_TOOL_NAMES[name] === true) {
    return pathSelector(args) || argText(args, "url") || "";
  }
  if (name === "glob") {
    const pattern = argText(args, "pattern", "glob") ?? "";
    const base = argText(args, "path", "cwd", "directory") ?? "";
    return [pattern, base].filter((value) => value.length > 0).join(" · ");
  }
  if (name === "grep") {
    const query = argText(args, "pattern", "query", "regex") ?? "";
    const target = argText(args, "path", "file_path", "file", "cwd", "directory") ?? "";
    return [query, target].filter((value) => value.length > 0).join(" · ");
  }
  if (name === "write") return pathSelector(args);
  if (EDIT_FAMILY_TOOLS[name] === true) {
    return pathSelector(args) || patchTarget(argText(args, "input", "_input", "patch") ?? "") || "";
  }
  return "";
}

function toolTargetSummary(toolName: string, args: JsonRecord | null): string | undefined {
  if (args === null) return undefined;
  const name = toolName.toLowerCase();
  if (EVAL_TOOL_NAMES[name] === true || isCommandTool(name)) return undefined;
  const target = toolTarget(name, args);
  return target || undefined;
}

export function parseActivityToolPresentation(
  toolNameHint: string | undefined,
  rawData: unknown,
): ActivityToolPresentation {
  const data = asRecord(rawData);
  const item = asRecord(data?.item) ?? data;
  const input =
    item?.input ??
    item?.arguments ??
    data?.input ??
    data?.arguments ??
    (item?.command !== undefined ? { command: item.command } : undefined);
  const parsedInput = parsedArgumentValue(input);
  const args = asRecord(parsedInput);
  const toolName =
    firstString(item, ["name", "tool", "toolName"]) ??
    firstString(data, ["toolName", "tool", "kind"]) ??
    toolNameHint ??
    "tool";
  return {
    toolName,
    intent: toolIntent(toolName, args),
    summary: toolTargetSummary(toolName, args),
    inputText: input === undefined ? null : stringifyValue(parsedInput),
  };
}

function imageBlock(record: JsonRecord): ActivityDetailBlock | null {
  const nestedSource = asRecord(record.source);
  const data = record.data ?? nestedSource?.data;
  const mimeType = record.mimeType ?? nestedSource?.media_type;
  let source: string | null = null;
  if (
    typeof data === "string" &&
    typeof mimeType === "string" &&
    /^image\/(?:png|jpeg|webp|gif|avif|bmp|tiff)$/i.test(mimeType)
  ) {
    source = `data:${mimeType};base64,${data}`;
  } else {
    const imageUrl = record.image_url ?? record.imageUrl ?? record.url ?? record.source;
    const candidate = typeof imageUrl === "string" ? imageUrl : asRecord(imageUrl)?.url;
    if (
      typeof candidate === "string" &&
      /^data:image\/(?:png|jpeg|webp|gif|avif|bmp|tiff);base64,/i.test(candidate)
    ) {
      source = candidate;
    }
  }
  return source === null
    ? null
    : {
        kind: "image",
        source,
        alt: firstString(record, ["alt", "name", "title"]) ?? "Tool result image",
      };
}

const LISTING_ROW = /^([ *+-]?)(\d+)(?:-(\d+))?[|:](.*)$/;
const LISTING_HEADER = /^\[([^\]\n]+?)#([\da-f]{4})\]$/i;
const LISTING_GROUP_HEADER = /^(#{1,6})\s+(\S.*?)\s*$/;

type ListingSection = Omit<Extract<ActivityDetailBlock, { kind: "listing" }>, "rows" | "notes"> & {
  rows: ActivityDetailListingRow[];
  notes: string[];
};

function parseListingSections(
  output: string,
): ReadonlyArray<Extract<ActivityDetailBlock, { kind: "listing" }>> {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  const sections: ListingSection[] = [];
  let current: ListingSection | null = null;
  const directories: string[] = [];
  let rowCount = 0;
  let otherCount = 0;
  let gapPending = false;
  let headerSeen = false;

  const ensureSection = (): ListingSection => {
    if (current === null) {
      current = { kind: "listing", path: null, tag: null, language: null, rows: [], notes: [] };
      sections.push(current);
    }
    return current;
  };
  const replaceSection = (path: string | null, tag: string | null): ListingSection => {
    current = { kind: "listing", path, tag, language: languageFromPath(path), rows: [], notes: [] };
    sections.push(current);
    return current;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = line.match(LISTING_ROW);
    if (row) {
      const target = ensureSection();
      const rows = target.rows;
      if (gapPending && rows.length > 0) rows.push({ kind: "gap", gutter: "", text: "" });
      gapPending = false;
      rows.push({
        kind: row[3] ? "range" : row[1] === "*" ? "match" : "context",
        gutter: row[3] ? `${row[2]}-${row[3]}` : (row[2] ?? ""),
        text: row[4] ?? "",
      });
      rowCount += 1;
      continue;
    }
    if (trimmed === "…" || trimmed === "...") {
      gapPending = true;
      continue;
    }
    const header = trimmed.match(LISTING_HEADER);
    if (header) {
      replaceSection(header[1] ?? null, header[2] ?? null);
      headerSeen = true;
      gapPending = false;
      continue;
    }
    const group = trimmed.match(LISTING_GROUP_HEADER);
    if (group) {
      const depth = group[1]?.length ?? 1;
      const label = group[2] ?? "";
      directories.length = Math.min(directories.length, depth - 1);
      if (label.endsWith("/")) {
        directories.push(label);
      } else {
        const tagged = label.match(/^(.*?)#([\da-f]{4})$/i);
        replaceSection(`${directories.join("")}${tagged?.[1] ?? label}`, tagged?.[2] ?? null);
        headerSeen ||= tagged !== null;
      }
      gapPending = false;
      continue;
    }
    const target = ensureSection();
    target.notes.push(trimmed);
    otherCount += 1;
  }
  if (rowCount === 0 || rowCount < otherCount || (rowCount < 3 && !headerSeen)) return [];
  return sections.filter((entry) => entry.rows.length > 0 || entry.notes.length > 0);
}

const HASHLINE_PATTERN = /^([ +-])(\d+)\|(.*)$/;
const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiffBlock(
  value: string,
  language: string | null,
  path: string | null,
  forcedMode?: "unified" | "hashline" | "edit",
): Extract<ActivityDetailBlock, { kind: "diff" }> | null {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hasHunk = lines.some((line) => HUNK_PATTERN.test(line));
  const hasHashline =
    !hasHunk &&
    !lines.some((line) => /^\s*\*\d+[|:]/.test(line)) &&
    lines.some((line) => HASHLINE_PATTERN.test(line));
  const mode = forcedMode ?? (hasHashline ? "hashline" : hasHunk ? "unified" : "edit");
  const rows: ActivityDetailDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let cursorActive = false;

  for (const text of lines) {
    if (mode === "hashline") {
      if (text.trim() === "") {
        if (rows.length > 0 && rows.at(-1)?.kind !== "marker") {
          rows.push({ kind: "marker", text: "", oldLine: null, newLine: null, hashLine: true });
        }
        continue;
      }
      const match = HASHLINE_PATTERN.exec(text);
      if (!match) {
        rows.push({ kind: "marker", text, oldLine: null, newLine: null });
        continue;
      }
      const lineNumber = Number(match[2]);
      rows.push(
        match[1] === "+"
          ? {
              kind: "added",
              text: match[3] ?? "",
              oldLine: null,
              newLine: lineNumber,
              hashLine: true,
            }
          : match[1] === "-"
            ? {
                kind: "removed",
                text: match[3] ?? "",
                oldLine: lineNumber,
                newLine: null,
                hashLine: true,
              }
            : {
                kind: "context",
                text: match[3] ?? "",
                oldLine: lineNumber,
                newLine: lineNumber,
                hashLine: true,
              },
      );
      continue;
    }
    const hunk = HUNK_PATTERN.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      cursorActive = true;
      rows.push({ kind: "hunk", text, oldLine: null, newLine: null });
      continue;
    }
    if (
      mode === "unified" &&
      (text.startsWith("diff ") ||
        text.startsWith("index ") ||
        text.startsWith("--- ") ||
        text.startsWith("+++ "))
    ) {
      rows.push({ kind: "hunk", text, oldLine: null, newLine: null });
      continue;
    }
    if (text.startsWith("\\ ")) {
      rows.push({ kind: "marker", text, oldLine: null, newLine: null });
      continue;
    }
    if (mode === "edit") {
      const marker = /^\s*(?:\[[^\]\n]+#[\da-f]{4}\]|(?:PUT|CUT|REM|MV)\b)/i.test(text);
      if (marker) {
        rows.push({ kind: "marker", text, oldLine: null, newLine: null });
        continue;
      }
      const kind = text.startsWith("+") ? "added" : text.startsWith("-") ? "removed" : "context";
      rows.push({
        kind,
        text: /^[+-]/.test(text) ? text.slice(1) : text,
        oldLine: null,
        newLine: null,
      });
      continue;
    }
    if (cursorActive && text.startsWith("-")) {
      rows.push({ kind: "removed", text: text.slice(1), oldLine: oldLine++, newLine: null });
    } else if (cursorActive && text.startsWith("+")) {
      rows.push({ kind: "added", text: text.slice(1), oldLine: null, newLine: newLine++ });
    } else if (cursorActive && (text.startsWith(" ") || text.length === 0)) {
      rows.push({
        kind: "context",
        text: text.startsWith(" ") ? text.slice(1) : text,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    } else {
      rows.push({ kind: "marker", text, oldLine: null, newLine: null });
    }
  }
  const hasRows = rows.some(
    (row) => row.kind === "added" || row.kind === "removed" || row.kind === "context",
  );
  const hasEditMarker = rows.some((row) => row.kind === "marker" && row.text.trim().length > 0);
  if (!hasRows && !hasEditMarker) return null;
  return { kind: "diff", path, language, mode, hashLine: mode === "hashline", rows, raw: value };
}

function richTextBlocks(
  value: string,
  language: string | null,
  path: string | null,
): ReadonlyArray<ActivityDetailBlock> {
  const rowLanguage = language ?? languageFromPath(path);
  const diff = parseDiffBlock(value, rowLanguage, path);
  if (diff !== null && diff.mode !== "edit") return [diff];
  const listings = parseListingSections(value);
  if (listings.length > 0)
    return listings.map((listing) => ({ ...listing, language: listing.language ?? rowLanguage }));
  if (/^\s*[[{]/.test(value)) {
    try {
      JSON.parse(value);
      return [{ kind: "code", code: value, language: "json" }];
    } catch {
      // Non-JSON output stays verbatim.
    }
  }
  return language === null
    ? [{ kind: "text", text: value }]
    : [{ kind: "code", code: value, language }];
}

function timeoutLabel(args: JsonRecord | null): string | null {
  if (args === null) return null;
  for (const key of ["timeoutMs", "timeoutSeconds", "timeout"]) {
    const raw = args[key];
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))
          ? Number(raw)
          : null;
    if (value === null || !Number.isFinite(value) || value < 0) continue;
    const milliseconds = key === "timeoutMs" ? value : value * 1000;
    if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    if (minutes < 60) return remainderSeconds ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainderMinutes = minutes % 60;
    if (hours < 24) return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainderHours = hours % 24;
    return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
  }
  return null;
}

function toolOptions(
  toolName: string,
  args: JsonRecord | null,
): ReadonlyArray<{ readonly key: string; readonly value: string }> {
  const name = toolName.toLowerCase();
  const keys = isCommandTool(name)
    ? ["cwd"]
    : READ_TOOL_NAMES[name] === true || name === "glob" || name === "grep"
      ? ["limit", "offset", "count"]
      : [];
  const options: Array<{ readonly key: string; readonly value: string }> = [];
  for (const key of keys) {
    const entry = argTextEntry(args, key);
    if (entry !== null && entry.value.trim()) {
      options.push({ key: entry.key, value: compactPreview(entry.value, 100) });
    }
  }
  if (isCommandTool(name)) {
    const timeout = timeoutLabel(args);
    if (timeout !== null) options.push({ key: "timeout", value: timeout });
  }
  return options;
}

function markIntentArgument(
  toolName: string,
  args: JsonRecord,
  consumed: ConsumedArgumentPaths,
): void {
  const explicit = ["i", "_i", "description"].find(
    (key) => typeof args[key] === "string" && (args[key] as string).trim(),
  );
  let path = explicit;
  if (path === undefined && EVAL_TOOL_NAMES[toolName.toLowerCase()] === true) {
    path = parseEvalCells(args, toolName).find((cell) => cell.title?.trim())?.titlePath;
  }
  if (path === undefined) return;
  const value = argumentStringAtPath(args, path);
  if (value !== null && plainPreviewText(value) === value) consumed.add(path);
}

function markToolOptions(
  toolName: string,
  args: JsonRecord,
  consumed: ConsumedArgumentPaths,
): void {
  const name = toolName.toLowerCase();
  const keys = isCommandTool(name)
    ? ["cwd"]
    : READ_TOOL_NAMES[name] === true || name === "glob" || name === "grep"
      ? ["limit", "offset", "count"]
      : [];
  for (const key of keys) {
    const entry = argTextEntry(args, key);
    if (entry !== null && entry.value.trim())
      markUntruncated(consumed, entry.key, entry.value, 100);
  }
  if (isCommandTool(name)) {
    const timeoutKey = ["timeoutMs", "timeoutSeconds", "timeout"].find((key) =>
      timeoutLabelAt(args, key),
    );
    if (timeoutKey !== undefined) consumed.add(timeoutKey);
  }
}

function timeoutLabelAt(args: JsonRecord, key: string): string | null {
  const raw = args[key];
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))
        ? Number(raw)
        : null;
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return timeoutLabel({ [key]: raw });
}

function markTargetArguments(
  toolName: string,
  args: JsonRecord,
  consumed: ConsumedArgumentPaths,
): void {
  const name = toolName.toLowerCase();
  const mark = (entry: { readonly key: string; readonly value: string } | null): void => {
    if (entry !== null && entry.value) consumed.add(entry.key);
  };
  if (READ_TOOL_NAMES[name] === true) {
    const path = pathSelector(args);
    if (path) {
      mark(argTextEntry(args, "path", "file_path", "file", "filename"));
      mark(argTextEntry(args, "sel"));
    } else {
      mark(argTextEntry(args, "url"));
    }
    return;
  }
  if (name === "glob") {
    mark(argTextEntry(args, "pattern", "glob"));
    mark(argTextEntry(args, "path", "cwd", "directory"));
    return;
  }
  if (name === "grep") {
    mark(argTextEntry(args, "pattern", "query", "regex"));
    mark(argTextEntry(args, "path", "file_path", "file", "cwd", "directory"));
    return;
  }
  if (name === "write" || EDIT_FAMILY_TOOLS[name] === true) {
    mark(argTextEntry(args, "path", "file_path", "file", "filename"));
  }
}

function taskLabels(args: JsonRecord | null): ReadonlyArray<string> {
  if (args === null) return [];
  const labels: string[] = [];
  if (Array.isArray(args.tasks)) {
    for (const task of args.tasks) {
      const label =
        typeof task === "string"
          ? task
          : asRecord(task) !== null
            ? (argText(asRecord(task), "description", "task", "assignment", "name") ?? "")
            : task === null || task === undefined
              ? ""
              : stringifyValue(task);
      if (label.trim()) labels.push(label);
    }
  }
  const direct = argText(args, "description", "task", "assignment");
  if (direct !== null && direct.trim()) labels.push(direct);
  return labels;
}

function todoLabels(args: JsonRecord | null): ReadonlyArray<string> {
  if (args === null) return [];
  const labels: string[] = [];
  for (const key of ["items", "list"]) {
    const values = args[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const label =
        typeof value === "string"
          ? value
          : asRecord(value) !== null
            ? (argText(asRecord(value), "task", "phase", "description", "title", "name", "text") ??
              "")
            : value === null || value === undefined
              ? ""
              : stringifyValue(value);
      if (label.trim()) labels.push(label);
    }
  }
  const target = argText(args, "task", "phase");
  if (target !== null && target.trim()) labels.unshift(target);
  return labels;
}

function primaryInput(
  toolName: string,
  args: JsonRecord | null,
): { readonly text: string; readonly path: string } | null {
  if (args === null) return null;
  const name = toolName.toLowerCase();
  if (name === "task" || name === "todo") return null;
  const keys =
    name === "ask" || name === "ask_user" || name === "question"
      ? ["question", "prompt", "message", "input", "content", "description"]
      : [
          "message",
          "question",
          "prompt",
          "content",
          "input",
          "_input",
          "body",
          "task",
          "assignment",
          "text",
        ];
  const hasIntent =
    (typeof args.i === "string" && args.i.trim()) ||
    (typeof args._i === "string" && args._i.trim());
  const direct = argTextEntry(args, ...(hasIntent ? keys : [...keys, "description"]));
  if (direct !== null && direct.value.trim()) return { text: direct.value, path: direct.key };
  return null;
}

function inputBlocks(
  toolName: string,
  input: unknown,
  path: string | null,
  consumed: ConsumedArgumentPaths,
  resultDiffs: ReadonlyArray<{ readonly diff: string; readonly path: string | null }>,
): ReadonlyArray<ActivityDetailBlock> {
  const name = toolName.toLowerCase();
  if (typeof input === "string") {
    if (EDIT_FAMILY_TOOLS[name] === true) {
      const diff = parseDiffBlock(
        input,
        languageFromPath(path) ?? languageFromText(input),
        path,
        "edit",
      );
      if (diff !== null) return [diff];
    }
    if (isCommandTool(name))
      return [{ kind: "code", code: input, language: "bash", softWrap: !/[\r\n]/.test(input) }];
    return [
      {
        kind: "code",
        code: input,
        language: languageFromPath(path) ?? languageFromText(input) ?? "text",
      },
    ];
  }
  const args = asRecord(input);
  if (args === null) return input === undefined ? [] : [{ kind: "structured", value: input }];
  markIntentArgument(name, args, consumed);

  if (EVAL_TOOL_NAMES[name] === true) {
    const cells = parseEvalCells(args, toolName);
    if (cells.length > 0) {
      return cells.map((cell) => {
        const shownTitle =
          cell.title !== undefined &&
          (cells.length > 1 || plainPreviewText(cell.title) !== toolIntent(toolName, args));
        if (cell.codePath !== undefined) consumed.add(cell.codePath);
        if (shownTitle && cell.titlePath !== undefined) consumed.add(cell.titlePath);
        if (
          !shownTitle &&
          cell.titlePath !== undefined &&
          cell.title === toolIntent(toolName, args)
        )
          consumed.add(cell.titlePath);
        return {
          kind: "code" as const,
          code: cell.code,
          language: cell.language,
          ...(shownTitle ? { title: cell.title } : {}),
        };
      });
    }
  }

  const blocks: ActivityDetailBlock[] = [];
  if (isCommandTool(name)) {
    const command = argStringEntry(args, "command", "cmd");
    if (command !== null) {
      blocks.push({
        kind: "code",
        code: command.value,
        language: "bash",
        softWrap: !/[\r\n]/.test(command.value),
      });
      consumed.add(command.key);
    }
    const options = toolOptions(name, args);
    if (options.length > 0) blocks.push({ kind: "options", entries: options });
    markToolOptions(name, args, consumed);
    return blocks;
  }

  if (READ_TOOL_NAMES[name] === true || name === "glob" || name === "grep") {
    const target = toolTarget(name, args);
    const targetText = compactPreview(target, 260);
    if (targetText && targetText !== toolIntent(toolName, args)) {
      blocks.push({ kind: "target", text: targetText });
      if (targetText === target) markTargetArguments(name, args, consumed);
    }
    const options = toolOptions(name, args);
    if (options.length > 0) blocks.push({ kind: "options", entries: options });
    markToolOptions(name, args, consumed);
    return blocks;
  }

  if (EDIT_FAMILY_TOOLS[name] === true) {
    const target = toolTarget(name, args);
    const targetText = compactPreview(target, 260);
    if (targetText && targetText !== toolIntent(toolName, args)) {
      blocks.push({ kind: "target", text: targetText });
      if (targetText === target) markTargetArguments(name, args, consumed);
    }
    const patch = argStringEntry(args, "input", "_input", "patch");
    if (patch !== null && patch.value) {
      const diff = parseDiffBlock(
        patch.value,
        languageFromPath(path) ?? languageFromText(patch.value),
        path,
        "edit",
      );
      if (diff !== null) {
        blocks.push(diff);
        consumed.add(patch.key);
      }
    } else {
      const oldText = argStringEntry(args, "old_string", "oldText", "old_text");
      const newText = argStringEntry(args, "new_string", "newText", "new_text");
      const hasUsableDiffs =
        resultDiffs.length > 0 && resultDiffs.every((entry) => isRenderableDiff(entry.diff));
      if (oldText !== null && newText !== null && !hasUsableDiffs) {
        const replacement = [
          ...replacementRows(oldText.value, "-"),
          ...replacementRows(newText.value, "+"),
        ].join("\n");
        if (replacement) {
          const diff = parseDiffBlock(replacement, languageFromPath(path), path, "edit");
          if (diff !== null) blocks.push(diff);
          if (oldText.value) consumed.add(oldText.key);
          if (newText.value) consumed.add(newText.key);
        }
      } else if (
        oldText !== null &&
        newText !== null &&
        replacementShownInDiff(oldText.value, newText.value, resultDiffs)
      ) {
        consumed.add(oldText.key);
        consumed.add(newText.key);
      }
    }
    return blocks;
  }

  if (name === "write") {
    const target = toolTarget(name, args);
    const targetText = compactPreview(target, 260);
    if (targetText && targetText !== toolIntent(toolName, args)) {
      blocks.push({ kind: "target", text: targetText });
      if (targetText === target) markTargetArguments(name, args, consumed);
    }
    const content = argStringEntry(args, "content");
    if (content !== null && content.value) {
      blocks.push({
        kind: "code",
        code: content.value,
        language: languageFromPath(path) ?? "text",
      });
      consumed.add(content.key);
    }
    return blocks;
  }

  if (name === "hub") {
    const operation = argStringEntry(args, "op")?.value;
    const body = argTextEntry(args, "body", "message");
    if (body !== null && operation !== "wait" && body.value.trim()) {
      blocks.push({ kind: "text", text: body.value });
      consumed.add(body.key);
    }
    return blocks;
  }
  if (name === "task") {
    const labels = taskLabels(args);
    if (labels.length > 0) blocks.push({ kind: "text", text: labels.join("\n\n") });
    markTaskArguments(args, consumed);
    return blocks;
  }
  if (name === "todo") {
    const labels = todoLabels(args);
    if (labels.length > 0) blocks.push({ kind: "text", text: labels.join("\n") });
    markTodoArguments(args, consumed);
    return blocks;
  }
  const primary = primaryInput(name, args);
  if (primary !== null) {
    blocks.push({ kind: "text", text: primary.text });
    consumed.add(primary.path);
  }
  return blocks;
}

function replacementRows(text: string, prefix: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => prefix + line);
}

function markTaskArguments(args: JsonRecord, consumed: ConsumedArgumentPaths): void {
  if (Array.isArray(args.tasks)) {
    for (let index = 0; index < args.tasks.length; index++) {
      const task = args.tasks[index];
      if (typeof task === "string") {
        if (task.trim()) consumed.add(argumentPath("tasks", index));
      } else {
        const record = asRecord(task);
        if (record !== null) {
          const source = argStringEntry(record, "description", "task", "assignment", "name");
          if (source?.value.trim())
            consumed.add(argumentPath(argumentPath("tasks", index), source.key));
        } else if (task !== null && task !== undefined && stringifyValue(task).trim()) {
          consumed.add(argumentPath("tasks", index));
        }
      }
    }
  }
  const source = argStringEntry(args, "description", "task", "assignment");
  if (source?.value.trim()) consumed.add(source.key);
}

function markTodoArguments(args: JsonRecord, consumed: ConsumedArgumentPaths): void {
  for (const key of ["items", "list"]) {
    const values = args[key];
    if (!Array.isArray(values)) continue;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (typeof value === "string") {
        if (value.trim()) consumed.add(argumentPath(key, index));
      } else {
        const record = asRecord(value);
        if (record !== null) {
          const source = argStringEntry(
            record,
            "task",
            "phase",
            "description",
            "title",
            "name",
            "text",
          );
          if (source?.value.trim())
            consumed.add(argumentPath(argumentPath(key, index), source.key));
        } else if (value !== null && value !== undefined && stringifyValue(value).trim()) {
          consumed.add(argumentPath(key, index));
        }
      }
    }
  }
  const source = argStringEntry(args, "task", "phase");
  if (source?.value.trim()) consumed.add(source.key);
}

const LISTING_ROW_PATTERN = /^\s*[+\-*]?\s*\d+[|:]/;
const FILE_MARKER_PATTERN = /^\[[^\]\n]+#[\da-f]{4}\]$/i;

function stripListingRows(output: string, dropFileMarker: boolean): string {
  const kept: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "…" || trimmed === "...") continue;
    if (LISTING_ROW_PATTERN.test(line)) continue;
    if (dropFileMarker && FILE_MARKER_PATTERN.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function isRenderableDiff(value: string): boolean {
  const parsed = parseDiffBlock(value, null, null);
  return parsed !== null && parsed.mode !== "edit";
}

function replacementShownInDiff(
  oldText: string,
  newText: string,
  diffs: ReadonlyArray<{ readonly diff: string; readonly path: string | null }>,
): boolean {
  if (!diffs.length || !diffs.every((entry) => isRenderableDiff(entry.diff))) return false;
  const changes = diffs
    .flatMap((entry) => parseDiffBlock(entry.diff, null, entry.path)?.rows ?? [])
    .filter((row) => row.kind === "added" || row.kind === "removed");
  if (changes.length === 0) return false;
  const unchangedText = (source: string, kind: "added" | "removed"): string | null => {
    const changedLines = changes.filter((row) => row.kind === kind);
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const kept: string[] = [];
    let index = 0;
    for (const line of lines) {
      if (index < changedLines.length && line === changedLines[index]?.text) index++;
      else kept.push(line);
    }
    return index === changedLines.length ? kept.join("\n") : null;
  };
  const oldUnchanged = unchangedText(oldText, "removed");
  return oldUnchanged !== null && oldUnchanged === unchangedText(newText, "added");
}

interface ResultBlockData {
  readonly blocks: ReadonlyArray<ActivityDetailBlock>;
  readonly metadata?: JsonRecord;
  readonly originalOutput?: string;
}

function detailOutput(details: JsonRecord | null): string | null {
  if (details === null) return null;
  for (const key of ["displayContent", "errorText", "displayErrorText", "summary"]) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function rawString(record: JsonRecord, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function resultStatusBlocks(
  toolName: string,
  result: JsonRecord,
): ReadonlyArray<Extract<ActivityDetailBlock, { kind: "status" }>> {
  const name = toolName.toLowerCase();
  const nestedDetails = asRecord(result.details);
  const details =
    nestedDetails !== null && Array.isArray(nestedDetails[name === "task" ? "results" : "receipts"])
      ? nestedDetails
      : result;
  const values = details[name === "task" ? "results" : "receipts"];
  if (!Array.isArray(values)) return [];
  if (name === "task") {
    return values.flatMap((value) => {
      const record = asRecord(value);
      if (record === null) return [];
      const status =
        record.aborted === true
          ? "aborted"
          : record.exitCode === 0
            ? "done"
            : typeof record.exitCode === "number"
              ? "failed"
              : // Deliberately avoid inventing failure when no exit code was reported.
                (rawString(record, ["status", "state", "outcome"]) ?? "unknown");
      const description = rawString(record, ["description", "task"]);
      return [
        {
          kind: "status" as const,
          label: rawString(record, ["id", "agent"]) ?? "agent",
          status,
          ...(description === null ? {} : { description }),
        },
      ];
    });
  }
  if (name !== "hub") return [];
  return values.flatMap((value) => {
    const record = asRecord(value);
    if (record === null) return [];
    return [
      {
        kind: "status" as const,
        label: rawString(record, ["to", "from"]) ?? "peer",
        status: rawString(record, ["outcome"]) ?? "updated",
      },
    ];
  });
}

function resultBlocks(
  result: unknown,
  path: string | null,
  deduplicateOutput: boolean,
  diffs: ReadonlyArray<{ readonly diff: string; readonly path: string | null }>,
  toolName: string,
  resultLanguage: string | null,
): ResultBlockData {
  const renderText = (text: string) => {
    const output = deduplicateOutput
      ? diffs.some((entry) => entry.diff === text)
        ? ""
        : stripListingRows(text, true)
      : text;
    return {
      blocks: output ? richTextBlocks(output, resultLanguage, path) : [],
      changed: output !== text,
    };
  };
  if (typeof result === "string") {
    const rendered = renderText(result);
    return {
      blocks: rendered.blocks,
      ...(rendered.changed ? { originalOutput: result } : {}),
    };
  }
  const resultRecord = asRecord(result);
  if (resultRecord === null) return { blocks: [{ kind: "structured", value: result }] };
  const statuses = resultStatusBlocks(toolName, resultRecord);
  const directKey = ["content", "output", "displayContent"].find(
    (key) => resultRecord[key] !== undefined && resultRecord[key] !== null,
  );
  const directContent = directKey === undefined ? undefined : resultRecord[directKey];
  const hasDirectContent =
    directContent !== undefined &&
    directContent !== null &&
    (typeof directContent === "string"
      ? directContent.length > 0
      : Array.isArray(directContent)
        ? directContent.length > 0
        : true);
  const outputKeys = ["stdout", "stderr"].filter((key) => {
    const value = resultRecord[key];
    return typeof value === "string" && value.length > 0;
  });
  const fallbackText =
    !hasDirectContent && outputKeys.length === 0
      ? detailOutput(asRecord(resultRecord.details))
      : null;
  const content = hasDirectContent
    ? directContent
    : outputKeys.length > 0
      ? outputKeys.map((key) => resultRecord[key]).join("\n")
      : (fallbackText ?? directContent);
  const consumedOutputKeys = new Set<string>();
  if (hasDirectContent && directKey !== undefined) consumedOutputKeys.add(directKey);
  else for (const key of outputKeys) consumedOutputKeys.add(key);
  const metadata = Object.fromEntries(
    Object.entries(resultRecord).filter(([key]) => !consumedOutputKeys.has(key)),
  );
  if (content === undefined && statuses.length === 0)
    return { blocks: [{ kind: "structured", value: result }] };
  if (typeof content !== "string" && !Array.isArray(content)) {
    return statuses.length > 0
      ? { blocks: statuses, metadata: resultRecord }
      : { blocks: [{ kind: "structured", value: result }] };
  }
  const blocks: ActivityDetailBlock[] = [...statuses];
  let changed = false;
  const renderContent = fallbackText === null || statuses.length === 0;
  if (renderContent && typeof content === "string") {
    const rendered = renderText(content);
    blocks.push(...rendered.blocks);
    changed = rendered.changed;
  } else if (renderContent) {
    for (const entryValue of content) {
      const entry = asRecord(entryValue);
      const nested = entry?.type === "content" ? asRecord(entry.content) : null;
      const text =
        entry?.type === "text" && typeof entry.text === "string"
          ? entry.text
          : nested?.type === "text" && typeof nested.text === "string"
            ? nested.text
            : null;
      if (text !== null) {
        const rendered = renderText(text);
        blocks.push(...rendered.blocks);
        changed ||= rendered.changed;
      } else if (entry?.type === "image" || entry?.type === "image_url") {
        blocks.push(imageBlock(entry) ?? { kind: "structured", value: entryValue });
      } else {
        blocks.push({ kind: "structured", value: entryValue });
      }
    }
  }
  return {
    blocks,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(changed
      ? { originalOutput: typeof content === "string" ? content : stringifyValue(content) }
      : {}),
  };
}

function detailDiffs(
  value: unknown,
): ReadonlyArray<{ readonly diff: string; readonly path: string | null }> {
  const record = asRecord(value);
  if (record === null) return [];
  const diffs: Array<{ readonly diff: string; readonly path: string | null }> = [];
  const path = asNonEmptyString(record.path);
  if ("diff" in record) {
    diffs.push({ diff: typeof record.diff === "string" ? record.diff : "", path });
  }
  if (Array.isArray(record.perFileResults)) {
    for (const entryValue of record.perFileResults) {
      const entry = asRecord(entryValue);
      if (entry !== null && "diff" in entry) {
        diffs.push({
          diff: typeof entry.diff === "string" ? entry.diff : "",
          path: asNonEmptyString(entry.path) ?? path,
        });
      }
    }
  }
  return diffs;
}

function section(
  title: string,
  blocks: ReadonlyArray<ActivityDetailBlock>,
  description?: string,
): ActivityDetailSection {
  return description ? { title, description, blocks } : { title, blocks };
}

export function formatActivityDetailValue(block: ActivityDetailBlock): string {
  switch (block.kind) {
    case "text":
      return block.text;
    case "code":
      return block.code;
    case "structured":
      return stringifyValue(block.value);
    case "status":
      return `${block.label}: ${block.status}${block.description === undefined ? "" : `\n${block.description}`}`;
    case "image":
      return `[Image: ${block.alt}]`;
    case "target":
      return block.text;
    case "options":
      return block.entries.map((entry) => `${entry.key}=${entry.value}`).join(", ");
    case "listing":
      return [
        block.path ? `[${block.path}${block.tag ? `#${block.tag}` : ""}]` : "",
        ...block.rows.map((row) => (row.kind === "gap" ? "…" : `${row.gutter}:${row.text}`)),
        ...block.notes,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    case "diff":
      return block.raw;
  }
}

export function parseActivityDetail(activity: ActivityDetailInput): ParsedActivityDetail {
  const unwrapped =
    activity !== null &&
    typeof activity === "object" &&
    "item" in activity &&
    (activity as Record<string, unknown>).visibility !== undefined
      ? (activity as Record<string, unknown>).item
      : activity;
  const directRecord = asRecord(unwrapped);
  let payload = asRecord(directRecord?.payload);
  let data = asRecord(payload?.data);
  let item = asRecord(data?.item) ?? data;

  if (payload === null && data === null && directRecord !== null) {
    if (directRecord.type === "command_execution") {
      item = {
        name: "bash",
        input: { command: directRecord.input },
        result: directRecord.output,
        isError:
          directRecord.outputIndicatesFailure ||
          (directRecord.exitCode !== undefined && directRecord.exitCode !== 0) ||
          directRecord.status === "failed",
      };
      data = item;
      payload = { data };
    } else if (directRecord.type === "file_change") {
      item = {
        name: "edit",
        input: {
          path: directRecord.fileName,
          oldText: directRecord.oldStr,
          newText: directRecord.newStr,
        },
        result:
          directRecord.status === "failed"
            ? { content: directRecord.diffStr, isError: true, path: directRecord.fileName }
            : { diff: directRecord.diffStr, path: directRecord.fileName },
        isError: directRecord.status === "failed",
      };
      data = item;
      payload = { data };
    } else if (directRecord.type === "dynamic_tool") {
      item = {
        name: directRecord.toolName ?? "tool",
        input: directRecord.input,
        result: directRecord.output,
        isError: directRecord.status === "failed",
      };
      data = item;
      payload = { data };
    } else if (directRecord.type === "subagent") {
      item = {
        name: "task",
        input: { task: directRecord.prompt },
        result: directRecord.result ?? directRecord.progress,
        isError: directRecord.status === "failed",
      };
      data = item;
      payload = { data };
    } else if (directRecord.type === "web_search") {
      item = {
        name: "web_search",
        input: { queries: directRecord.patterns },
        result: { results: directRecord.results },
        isError: directRecord.status === "failed",
      };
      data = item;
      payload = { data };
    } else if (directRecord.type === "file_search") {
      item = {
        name: "file_search",
        input: { pattern: directRecord.pattern },
        result: { results: directRecord.results },
        isError: directRecord.status === "failed",
      };
      data = item;
      payload = { data };
    } else if (
      "name" in directRecord ||
      "toolName" in directRecord ||
      "input" in directRecord ||
      "command" in directRecord
    ) {
      item = directRecord;
      data = directRecord;
      payload = { data: directRecord };
    }
  }

  if (payload === null)
    return {
      sections: [section("Activity", [{ kind: "structured", value: directRecord ?? activity }])],
    };
  if (data === null)
    return { sections: [section("Activity", [{ kind: "structured", value: payload }])] };
  if (item === null) item = data;
  const toolName =
    firstString(item, ["name", "tool", "toolName"]) ??
    firstString(data, ["toolName", "tool", "kind"]) ??
    firstString(payload, ["toolName", "itemType"]) ??
    (typeof directRecord?.summary === "string" ? directRecord.summary : undefined) ??
    "tool";
  const rawInput =
    item.input ??
    item.arguments ??
    data.input ??
    data.arguments ??
    (item.command !== undefined ? { command: item.command } : undefined);
  const input = parsedArgumentValue(rawInput);
  const inputRecord = asRecord(input);
  const path =
    firstString(inputRecord, ["path", "file_path", "file", "filename"]) ??
    firstString(item, ["path", "file"]);
  const result = item.result ?? data.result ?? data.rawOutput;
  const isErrorTone =
    (directRecord as Record<string, unknown> | null)?.tone === "error" ||
    item.isError === true ||
    data.isError === true ||
    asRecord(result)?.isError === true;
  const resultDiffs: Array<{ readonly diff: string; readonly path: string | null }> = [];
  const seenDiffs = new Set<string>();
  for (const detail of [data, item, result, asRecord(result)?.details]) {
    for (const entry of detailDiffs(detail)) {
      const diffKey = `${entry.path ?? ""}\u0000${entry.diff}`;
      if (seenDiffs.has(diffKey)) continue;
      seenDiffs.add(diffKey);
      resultDiffs.push(entry);
    }
  }

  const sections: ActivityDetailSection[] = [];
  if (input !== undefined) {
    const consumed: ConsumedArgumentPaths = new Set();
    const inputContent = inputBlocks(toolName, input, path, consumed, resultDiffs);
    const inputBlocksWithMetadata =
      inputRecord === null ? inputContent : withInputMetadata(inputRecord, inputContent, consumed);
    const intent = toolIntent(toolName, inputRecord);
    sections.push(section("Input", inputBlocksWithMetadata, intent ?? undefined));
  }

  const deduplicateOutput =
    !isErrorTone &&
    EDIT_FAMILY_TOOLS[toolName.toLowerCase()] === true &&
    resultDiffs.length > 0 &&
    resultDiffs.every((entry) => isRenderableDiff(entry.diff));
  const resultRecord = asRecord(result);
  const resultLanguage =
    READ_TOOL_NAMES[toolName.toLowerCase()] === true && path !== null && !isErrorTone
      ? languageFromPath(path)
      : null;
  const resultContent: ActivityDetailBlock[] = [];
  for (const entry of resultDiffs) {
    const diff = parseDiffBlock(
      entry.diff,
      languageFromPath(entry.path) ?? languageFromText(entry.diff),
      entry.path,
    );
    if (diff !== null && diff.mode !== "edit") resultContent.push(diff);
  }
  let resultInfo: ResultBlockData = { blocks: [] };
  if (result !== undefined) {
    resultInfo = resultBlocks(
      result,
      path,
      deduplicateOutput,
      resultDiffs,
      toolName,
      resultLanguage,
    );
    resultContent.push(...resultInfo.blocks);
  }
  if (resultContent.length > 0) sections.push(section("Result", resultContent));
  if (resultInfo.originalOutput !== undefined) {
    sections.push(section("Original output", [{ kind: "text", text: resultInfo.originalOutput }]));
  }
  if (resultInfo.metadata !== undefined) {
    sections.push(section("Result metadata", [{ kind: "structured", value: resultInfo.metadata }]));
  }

  const metadata = Object.fromEntries(
    Object.entries(item).filter(
      ([key, value]) =>
        !(["input", "arguments"].includes(key) && value === rawInput) &&
        !(["result", "rawOutput"].includes(key) && value === result) &&
        !(["name", "tool", "toolName"].includes(key) && value === toolName),
    ),
  );
  if (Object.keys(metadata).length > 0)
    sections.push(section("Tool metadata", [{ kind: "structured", value: metadata }]));
  const additionalData =
    item === data
      ? {}
      : Object.fromEntries(
          Object.entries(data).filter(
            ([key, value]) =>
              key !== "item" &&
              !(["input", "arguments"].includes(key) && value === rawInput) &&
              !(["result", "rawOutput"].includes(key) && value === result),
          ),
        );
  if (Object.keys(additionalData).length > 0)
    sections.push(section("Additional data", [{ kind: "structured", value: additionalData }]));
  return sections.length > 0
    ? { sections }
    : { sections: [section("Activity", [{ kind: "structured", value: payload }])] };
}
