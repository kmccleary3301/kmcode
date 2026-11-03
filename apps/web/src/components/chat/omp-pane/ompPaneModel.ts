import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/**
 * What one OMP tool pane draws, ported from OMP's TUI renderers
 * (`coding-agent/src/tools/*`, `edit/renderer.ts`): a single box whose input
 * grows while the model streams the call, then the tool's output below it.
 */
export type OmpDiffLine = {
  readonly kind: "hunk" | "add" | "remove" | "context" | "gap";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
};

export type OmpPaneInput =
  | { readonly kind: "command"; readonly command: string }
  | {
      readonly kind: "cells";
      readonly cells: ReadonlyArray<{
        readonly title: string;
        readonly language: string;
        readonly code: string;
      }>;
    }
  | {
      readonly kind: "diff";
      readonly lines: ReadonlyArray<OmpDiffLine>;
      readonly added: number;
      readonly removed: number;
      /** Grammar for the changed code, from the file the diff touches. */
      readonly language: string;
      /** One line-number column when the source carries numbers (hunk headers or `+239|code` rows). */
      readonly gutters: 0 | 1;
    }
  | { readonly kind: "file"; readonly content: string; readonly language: string }
  | { readonly kind: "prose"; readonly text: string }
  /** Agent-written markdown (task prompts, shared context), rendered by stream-mdx. */
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "fields"; readonly rows: ReadonlyArray<readonly [string, string]> };

/** One file's rows in an OMP `read`/`grep` listing (`*128:code` marks a match). */
export interface OmpListingSection {
  readonly path: string | null;
  readonly tag: string | null;
  readonly language: string;
  readonly rows: ReadonlyArray<{
    readonly kind: "context" | "match" | "range" | "gap";
    readonly gutter: string;
    readonly text: string;
  }>;
  readonly notes: ReadonlyArray<string>;
}

export interface OmpPaneModel {
  readonly input: OmpPaneInput | null;
  /** Printable output, ANSI stripped; null until the tool has produced any. */
  readonly output: string | null;
  /** The output parsed as an OMP line listing, when it is one. */
  readonly outputListing: ReadonlyArray<OmpListingSection> | null;
  /** Grammar for output that is one file's plain text (a read without line
   *  numbers); null for listings, errors and everything else. */
  readonly outputLanguage: string | null;
  /** True when the output is the tool's error text. */
  readonly outputIsError: boolean;
  /** The output carries images, which the rich result presenter draws. */
  readonly outputHasImages: boolean;
}

const EVAL_TOOLS = new Set(["eval", "python", "py", "js", "javascript", "notebook", "repl"]);
const EDIT_TOOLS = new Set(["edit", "apply_patch", "patch", "ast_edit"]);
const LISTING_TOOLS = new Set([
  "read",
  "view",
  "cat",
  "grep",
  "search",
  "find",
  "glob",
  "ast_grep",
]);
const FILE_READ_TOOLS = new Set(["read", "view", "cat"]);

const LANGUAGE_BY_ALIAS: Record<string, string> = {
  py: "python",
  python: "python",
  ipy: "python",
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  rb: "ruby",
  ruby: "ruby",
  jl: "julia",
  julia: "julia",
  sh: "bash",
  bash: "bash",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  xml: "xml",
  svg: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  lua: "lua",
  php: "php",
  zig: "zig",
  dart: "dart",
  scala: "scala",
  kts: "kotlin",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  hcl: "hcl",
  nix: "nix",
  ini: "ini",
  dockerfile: "docker",
};

const LANGUAGE_BY_FILE_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
};

/** The highlight language for a path; a read selector (`:50-80`) or hashline tag (`#AB12`) is not the extension. */
export function languageForPath(path: string): string {
  const name = /([^/\\]+?)(?:#[\da-f]{4})?(?::[^/\\]*)?$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const extension = /\.([a-z0-9]+)$/.exec(name)?.[1];
  return (
    (extension === undefined ? undefined : LANGUAGE_BY_EXTENSION[extension]) ??
    LANGUAGE_BY_FILE_NAME[name] ??
    "text"
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// eslint-disable-next-line no-control-regex -- ESC and BEL are the bytes ANSI sequences start and end with.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** Tool output as printable text: content blocks joined, ANSI escapes removed. */
export function toolOutputText(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "string")
    return output.length > 0 ? output.replace(ANSI_PATTERN, "") : null;
  const blocks = Array.isArray(output) ? output : record(output)?.content;
  if (Array.isArray(blocks)) {
    const parts = blocks.flatMap((block) => {
      const entry = record(block);
      if (entry === null) return [];
      if (entry.type === "text" && typeof entry.text === "string") return [entry.text];
      if (entry.type === "image") return ["[image]"];
      return [];
    });
    if (parts.length > 0) return parts.join("\n").replace(ANSI_PATTERN, "");
  }
  const summary = record(output);
  if (summary?.truncated === true && typeof summary.summary === "string") return summary.summary;
  try {
    return JSON.stringify(output, null, 2) ?? null;
  } catch {
    return String(output);
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** OMP line-addressed diff rows: " 192|code", "+239|code", "-291|code". */
const HASHLINE_ROW = /^([ +-])(\d+)\|(.*)$/;
const DIFF_PATHS = [
  /^\+\+\+ (?:b\/)?(.+)$/,
  /^\*\*\* (?:Update|Add|Delete) File: (.+)$/,
  /^\[([^\]#\n]+)(?:#[\da-f]{4})?\]?$/i,
];

/**
 * Diff rows from a unified patch, an apply_patch envelope, OMP hashline ops,
 * or OMP's numbered result rows — whichever the model is streaming. Headers
 * become hunk rows; body rows keep their sign and, when the source says so,
 * their line numbers. Tolerates a payload cut off mid-line.
 */
export function parseStreamedDiff(source: string): {
  readonly lines: OmpDiffLine[];
  readonly path: string | null;
} {
  const lines: OmpDiffLine[] = [];
  let path: string | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let numbered = false;
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    if (path === null) {
      for (const pattern of DIFF_PATHS) {
        const match = pattern.exec(raw)?.[1]?.trim();
        if (match) {
          path = match;
          break;
        }
      }
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("diff --git")) continue;
    if (raw.startsWith("index ")) continue;
    if (raw === "*** Begin Patch" || raw === "*** End Patch" || raw === "*** End of File") continue;
    const row = HASHLINE_ROW.exec(raw);
    if (row !== null) {
      numbered = true;
      const number = Number(row[2]);
      const text = row[3] ?? "";
      lines.push(
        row[1] === "+"
          ? { kind: "add", text, oldLine: null, newLine: number }
          : row[1] === "-"
            ? { kind: "remove", text, oldLine: number, newLine: null }
            : { kind: "context", text, oldLine: number, newLine: number },
      );
      continue;
    }
    // OMP separates numbered row groups with a blank line.
    if (numbered && raw.trim() === "") {
      if (lines.at(-1)?.kind !== "gap")
        lines.push({ kind: "gap", text: "", oldLine: null, newLine: null });
      continue;
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (
      hunk !== null ||
      raw.startsWith("@@") ||
      raw.startsWith("*** ") ||
      /^\[[^\]\n]*\]?$/.test(raw) ||
      /^(?:PUT|CUT|REM|MV)\b/.test(raw)
    ) {
      oldLine = hunk === null ? null : Number(hunk[1]);
      newLine = hunk === null ? null : Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
    } else if (raw.startsWith("+")) {
      lines.push({
        kind: "add",
        text: raw.slice(1),
        oldLine: null,
        newLine: newLine === null ? null : newLine++,
      });
    } else if (raw.startsWith("-")) {
      lines.push({
        kind: "remove",
        text: raw.slice(1),
        oldLine: oldLine === null ? null : oldLine++,
        newLine: null,
      });
    } else if (raw.length > 0 || lines.length > 0) {
      lines.push({
        kind: "context",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldLine: oldLine === null ? null : oldLine++,
        newLine: newLine === null ? null : newLine++,
      });
    }
  }
  while (
    lines.at(-1)?.kind === "gap" ||
    (lines.at(-1)?.kind === "context" && lines.at(-1)?.text === "")
  ) {
    lines.pop();
  }
  return { lines, path };
}

function diffInput(
  parsed: { readonly lines: ReadonlyArray<OmpDiffLine>; readonly path: string | null },
  pathHint: string | null,
): OmpPaneInput {
  let added = 0;
  let removed = 0;
  let numbered = false;
  for (const line of parsed.lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
    if (line.oldLine !== null || line.newLine !== null) numbered = true;
  }
  return {
    kind: "diff",
    lines: parsed.lines,
    added,
    removed,
    language: languageForPath(parsed.path ?? pathHint ?? ""),
    gutters: numbered ? 1 : 0,
  };
}

/** " 127:code", "*128:code", "12:code", "19-23:code" (elided range). */
const LISTING_ROW = /^([ *+-]?)(\d+)(?:-(\d+))?:(.*)$/;
/** Numbered `cat -n` rows, including the tab GNU and BSD cat emit. */
const CAT_ROW = /^\s*(\d+)\t(.*)$/;
/** "[path/to/file.ts#7D5C]" snapshot header. */
const LISTING_HEADER = /^\[([^\]\n]+?)#([\da-f]{4})\]$/i;
/** "## file.ts#128F" / "# packages/src/" grep grouping headers. */
const LISTING_GROUP = /^#{1,6}\s+(\S.*?)\s*$/;

type MutableListingSection = {
  path: string | null;
  tag: string | null;
  rows: Array<OmpListingSection["rows"][number]>;
  notes: string[];
};

/**
 * OMP's line-addressed listings (`read`, `grep`), ported from the transcript
 * viewer. Rows carry their own line number, so they are split from the code
 * and highlighted as real source. Empty when the output is not a listing.
 */
export function parseListing(output: string, pathHint: string | null): OmpListingSection[] {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  const sections: MutableListingSection[] = [];
  let current: MutableListingSection | null = null;
  let directory = "";
  let rowCount = 0;
  let otherCount = 0;
  let gapPending = false;
  let headerSeen = false;
  const section = (): MutableListingSection => {
    if (current === null) {
      current = { path: null, tag: null, rows: [], notes: [] };
      sections.push(current);
    }
    return current;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = LISTING_ROW.exec(line);
    const catRow = row === null ? CAT_ROW.exec(line) : null;
    if (row !== null || catRow !== null) {
      const target = section();
      if (gapPending && target.rows.length > 0)
        target.rows.push({ kind: "gap", gutter: "", text: "" });
      gapPending = false;
      target.rows.push(
        row !== null
          ? {
              kind: row[1] === "*" ? "match" : row[3] ? "range" : "context",
              gutter: row[3] ? `${row[2]}-${row[3]}` : (row[2] ?? ""),
              text: row[4] ?? "",
            }
          : { kind: "context", gutter: catRow?.[1] ?? "", text: catRow?.[2] ?? "" },
      );
      rowCount += 1;
      continue;
    }
    if (trimmed === "…" || trimmed === "...") {
      gapPending = true;
      continue;
    }
    const header = LISTING_HEADER.exec(trimmed);
    if (header !== null) {
      current = { path: header[1] ?? null, tag: header[2] ?? null, rows: [], notes: [] };
      sections.push(current);
      headerSeen = true;
      gapPending = false;
      continue;
    }
    const group = LISTING_GROUP.exec(trimmed);
    if (group !== null) {
      const label = group[1] ?? "";
      if (label.endsWith("/")) {
        directory = label;
      } else {
        const tagged = /^(.*?)#([\da-f]{4})$/i.exec(label);
        current = {
          path: `${directory}${tagged ? tagged[1] : label}`,
          tag: tagged?.[2] ?? null,
          rows: [],
          notes: [],
        };
        sections.push(current);
        headerSeen = tagged !== null;
      }
      gapPending = false;
      continue;
    }
    section().notes.push(trimmed);
    otherCount += 1;
  }

  if (rowCount === 0 || rowCount < otherCount) return [];
  if (rowCount < 3 && !headerSeen && !lines.some((line) => CAT_ROW.test(line))) return [];
  return sections
    .filter((entry) => entry.rows.length > 0 || entry.notes.length > 0)
    .map((entry) => ({ ...entry, language: languageForPath(entry.path ?? pathHint ?? "") }));
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.replace(/\r/g, "").replace(/\n$/, "").split("\n");
}

/** Eval cells from either OMP arg shape: `cells[]`, a `*** Cell` script, or bare `code`. */
function evalCells(toolName: string, input: unknown) {
  const args = record(input);
  const fallbackLanguage = toolName === "js" || toolName === "javascript" ? "javascript" : "python";
  const cells = args?.cells;
  if (Array.isArray(cells)) {
    return cells.flatMap((cell) => {
      const entry = record(cell);
      if (entry === null) return [];
      const language = text(entry.language)?.toLowerCase();
      return [
        {
          title: text(entry.title) ?? "",
          language:
            (language === undefined ? undefined : LANGUAGE_BY_ALIAS[language]) ?? fallbackLanguage,
          code: text(entry.code) ?? "",
        },
      ];
    });
  }
  const script = text(args?.input) ?? (typeof input === "string" ? input : null);
  if (script !== null && /^\s*\*{2,}\s*Cell\b/im.test(script)) {
    const parsed: Array<{ title: string; language: string; code: string[] }> = [];
    for (const line of script.replace(/\r/g, "").split("\n")) {
      const header = /^\*{2,}\s*Cell\b\s*(.*)$/i.exec(line);
      if (header !== null) {
        const tokens = (header[1] ?? "").split(/\s+/).filter((token) => token.length > 0);
        let language = fallbackLanguage;
        const titleParts: string[] = [];
        for (const token of tokens) {
          const [key = "", value] = token.split(":", 2);
          const alias = LANGUAGE_BY_ALIAS[key.toLowerCase()];
          if (alias !== undefined) {
            language = alias;
            if (value) titleParts.push(value.replace(/^["']|["']$/g, ""));
          } else if (!/^(?:t|timeout|rst|reset)\b/i.test(key) && !/^\d+(?:ms|s|m)?$/.test(token)) {
            titleParts.push(value ? value.replace(/^["']|["']$/g, "") : token);
          }
        }
        parsed.push({ title: titleParts.join(" "), language, code: [] });
      } else if (/^\*{2,}\s*End\b/i.test(line)) {
        continue;
      } else {
        parsed.at(-1)?.code.push(line);
      }
    }
    return parsed.map((cell) => ({
      title: cell.title,
      language: cell.language,
      code: cell.code.join("\n").trimEnd(),
    }));
  }
  const code = text(args?.code) ?? script;
  if (code === null) return [];
  const language = text(args?.language)?.toLowerCase();
  return [
    {
      title: text(args?.title) ?? "",
      language:
        (language === undefined ? undefined : LANGUAGE_BY_ALIAS[language]) ?? fallbackLanguage,
      code,
    },
  ];
}

function fieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function dynamicInput(
  toolName: string,
  rawInput: unknown,
  pathInTitle: boolean,
): OmpPaneInput | null {
  // Some providers hand over the arguments JSON-encoded. A string that does
  // not parse yet (still streaming, or plain text) stays a string.
  let input = rawInput;
  if (typeof rawInput === "string" && rawInput.trimStart().startsWith("{")) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = rawInput;
    }
  }
  if (EVAL_TOOLS.has(toolName)) {
    const cells = evalCells(toolName, input);
    // No cells means truncated or odd args; the generic shapes below cover those.
    if (cells.length > 0) return { kind: "cells", cells };
  }
  const args = record(input);
  if (EDIT_TOOLS.has(toolName)) {
    const payload =
      text(args?.input) ??
      text(args?._input) ??
      text(args?.patch) ??
      text(args?.diff) ??
      (typeof input === "string" ? input : null);
    if (payload !== null) {
      return diffInput(parseStreamedDiff(payload), text(args?.path) ?? text(args?.file_path));
    }
  }
  if (toolName === "write") {
    const content = text(args?.content);
    const path = text(args?.path) ?? text(args?.file_path) ?? "";
    if (content !== null) return { kind: "file", content, language: languageForPath(path) };
  }
  if (toolName === "bash" || toolName === "shell" || toolName === "exec") {
    const command = text(args?.command) ?? text(args?.cmd);
    if (command !== null) return { kind: "command", command };
  }
  if (toolName === "task") {
    const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
    const parts = tasks.flatMap((task) => {
      const entry = record(task);
      const assignment = text(entry?.assignment) ?? text(entry?.task) ?? text(entry?.description);
      return assignment === null ? [] : [assignment.trim()];
    });
    const context = text(args?.context)?.trim();
    const prose = [...(context ? [context] : []), ...parts].join("\n\n");
    if (prose.length > 0) return { kind: "markdown", text: prose };
  }
  if (typeof input === "string") return input.length > 0 ? { kind: "prose", text: input } : null;
  if (args === null) return null;
  if (args.truncated === true && typeof args.summary === "string") {
    return { kind: "prose", text: args.summary };
  }
  // `i` is OMP's intent line, already the step's headline. A read whose title
  // names its file would only repeat that path here.
  const titledPath = pathInTitle && FILE_READ_TOOLS.has(toolName);
  const rows = Object.entries(args)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value !== null &&
        key !== "i" &&
        !key.startsWith("_") &&
        !(titledPath && (key === "path" || key === "file_path")),
    )
    .map(([key, value]) => [key, fieldValue(value)] as const);
  return rows.length > 0 ? { kind: "fields", rows } : null;
}

export interface OmpPaneModelOptions {
  /** The step's title already shows the file path, so a read's input omits it. */
  readonly pathInTitle?: boolean;
}

export function ompPaneModel(
  item: OrchestrationV2TurnItem,
  options: OmpPaneModelOptions = {},
): OmpPaneModel {
  const failed = item.status === "failed";
  const settled = {
    input: null,
    output: null,
    outputListing: null,
    outputLanguage: null,
    outputIsError: false,
    outputHasImages: false,
  };
  switch (item.type) {
    case "command_execution":
      return {
        ...settled,
        input: item.input.length > 0 ? { kind: "command", command: item.input } : null,
        output: toolOutputText(item.output),
        outputIsError: failed,
      };
    case "file_change": {
      // A failed change stores the provider's error where the diff would be.
      if (failed && item.diffStr?.trim()) {
        return { ...settled, output: item.diffStr, outputIsError: true };
      }
      if (item.diffStr !== undefined && item.diffStr.length > 0) {
        return { ...settled, input: diffInput(parseStreamedDiff(item.diffStr), item.fileName) };
      }
      if (item.oldStr !== undefined) {
        // Replace mode: the old text, then the new text as it streams.
        const lines: OmpDiffLine[] = [
          ...splitLines(item.oldStr).map((line) => ({
            kind: "remove" as const,
            text: line,
            oldLine: null,
            newLine: null,
          })),
          ...splitLines(item.newStr ?? "").map((line) => ({
            kind: "add" as const,
            text: line,
            oldLine: null,
            newLine: null,
          })),
        ];
        return { ...settled, input: diffInput({ lines, path: null }, item.fileName) };
      }
      if (item.newStr !== undefined) {
        return {
          ...settled,
          input: { kind: "file", content: item.newStr, language: languageForPath(item.fileName) },
        };
      }
      return settled;
    }
    case "dynamic_tool": {
      const toolName = (item.toolName ?? "").toLowerCase();
      // A finished edit reports the applied unified diff; until then the
      // streamed payload (hashline ops or patch hunks) stands in for it.
      const details = record(item.details);
      const settledDiff = EDIT_TOOLS.has(toolName) ? text(details?.diff) : null;
      const showsSettledDiff = settledDiff !== null && settledDiff.length > 0;
      const args = record(item.input);
      const pathHint = text(args?.path) ?? text(args?.file_path);
      const blocks = Array.isArray(item.output) ? item.output : record(item.output)?.content;
      // Like OMP's edit renderer, an applied diff is the whole result: the text
      // output only echoes the edited lines (or "Updated <path>") again.
      const output = showsSettledDiff && !failed ? null : toolOutputText(item.output);
      const listing =
        output !== null && !failed && LISTING_TOOLS.has(toolName)
          ? parseListing(output, pathHint)
          : [];
      // OMP reads carry line numbers and parse as a listing; a plain read still
      // shows its file's code. A trailing `:50-80` selector is not the extension.
      const readLanguage =
        output !== null && !failed && listing.length === 0 && FILE_READ_TOOLS.has(toolName)
          ? languageForPath(pathHint ?? "")
          : "text";
      return {
        input:
          showsSettledDiff
            ? // OMP's hashline edits name the file in `details.path`, not in the args.
              diffInput(parseStreamedDiff(settledDiff), pathHint ?? text(details?.path))
            : dynamicInput(toolName, item.input, options.pathInTitle ?? false),
        output,
        outputListing: listing.length > 0 ? listing : null,
        outputLanguage: readLanguage === "text" ? null : readLanguage,
        outputIsError: failed,
        outputHasImages:
          item.viewedImagePath !== undefined ||
          (Array.isArray(blocks) && blocks.some((block) => record(block)?.type === "image")),
      };
    }
    case "subagent":
      return {
        ...settled,
        input: item.prompt.length > 0 ? { kind: "markdown", text: item.prompt } : null,
        output: item.result ?? item.progress ?? null,
        outputIsError: failed,
      };
    default:
      return { ...settled, outputIsError: failed };
  }
}
