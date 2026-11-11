import {
  createMarkdownSnapshotCompiler,
  type MarkdownSnapshotCompiler,
} from "@stream-mdx/worker/direct";
import {
  defaultUrlTransform,
  type Block,
  type CodeHighlightTheme,
  type HtmlOptions,
  type LinkDestinationOptions,
  type MathParseOptions,
  type SyntaxExtensionDescriptor,
  type UrlTransform,
} from "@stream-mdx/core";
import type { EngineExtensions } from "@stream-mdx/worker/engine";
import type {
  AnimatedOptions,
  MathEngine,
  MermaidEngine,
  StreamingFeatureFlags,
} from "@stream-mdx/react";
import { defaultSchema } from "rehype-sanitize";
import { useMemo } from "react";
import { THREAD_LINK_PROTOCOL } from "@t3tools/shared/threadLinks";
import { resolveAppearanceForMode } from "../../appearanceRuntime";
import { useTheme } from "../../hooks/useTheme";
import { syntaxThemeRegistration } from "../../lib/syntaxHighlighting";
import { chatMarkdownMathEngine } from "./MarkdownMath";
import KmMarkdownWorker from "./markdownWorker?worker";
import { useThemedMermaidEngine } from "../chat/ThemedMermaidBlock";
import { createKmMarkdownExtensions, KM_MARKDOWN_EXTENSION_ID } from "./kmMarkdownExtensions";

const kmMarkdownEngineExtensions = createKmMarkdownExtensions();

export interface KmMarkdownRenderOptions {
  readonly lineBreaks: boolean;
  readonly parseRawHtml: boolean;
  readonly streamWordFade: boolean;
  readonly isStreaming: boolean;
  readonly pullRequestRepositoryUrl: string | null;
  readonly skillNames: readonly string[];
  readonly urlTransform?: UrlTransform;
}

export interface KmMarkdownRenderConfig {
  readonly features: StreamingFeatureFlags;
  readonly mathOptions: MathParseOptions;
  readonly linkDestinations: LinkDestinationOptions;
  readonly html: HtmlOptions;
  readonly themes: { readonly light: CodeHighlightTheme; readonly dark: CodeHighlightTheme };
  readonly highlightEngine: "oniguruma";
  readonly extensionId: string;
  readonly engineExtensions: EngineExtensions;
  readonly syntax?: SyntaxExtensionDescriptor;
  readonly urlTransform: UrlTransform;
  readonly animated: AnimatedOptions | false;
  readonly engines: { readonly math: MathEngine; readonly mermaid: MermaidEngine };
}

export function createKmMarkdownWorker(): Worker {
  return new KmMarkdownWorker();
}

export interface KmMarkdownAppendStream extends AsyncIterable<string> {
  readonly sent: string;
  readonly closed: boolean;
  push(chunk: string): void;
  close(): void;
}

/** An append-only, replayable source for a renderer that may restart or resubscribe. */
export function createKmMarkdownAppendStream(
  initialText: string,
  initiallyClosed: boolean,
): KmMarkdownAppendStream {
  const chunks: string[] = initialText.length > 0 ? [initialText] : [];
  const waiters = new Set<() => void>();
  let sent = initialText;
  let done = initiallyClosed;
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  return {
    get sent() {
      return sent;
    },
    get closed() {
      return done;
    },
    push(chunk) {
      if (done || chunk.length === 0) return;
      chunks.push(chunk);
      sent += chunk;
      wake();
    },
    close() {
      if (done) return;
      done = true;
      wake();
    },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<string>> {
          while (index >= chunks.length) {
            if (done) return { value: undefined, done: true };
            await new Promise<void>((resolve) => waiters.add(resolve));
          }
          const chunk = chunks[index] ?? "";
          index += 1;
          return { value: chunk, done: false };
        },
      };
    },
  };
}

const MAX_SNAPSHOT_CACHE_ENTRIES = 160;

class MarkdownSnapshotLru {
  private readonly entries = new Map<string, Block[]>();

  get(key: string): Block[] | undefined {
    const blocks = this.entries.get(key);
    if (blocks === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, blocks);
    return blocks;
  }

  set(key: string, blocks: Block[]): void {
    this.entries.delete(key);
    this.entries.set(key, blocks);
    if (this.entries.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const kmMarkdownSnapshotCache = new MarkdownSnapshotLru();

let snapshotCompiler: MarkdownSnapshotCompiler | undefined;
// The compiler already serializes work internally, but rejects bursts beyond its
// queue limit. Admit one snapshot at a time so mounted history waits rather than
// permanently falling back to literal Markdown under load.
let snapshotAdmission: Promise<void> = Promise.resolve();
const pendingSnapshots = new Map<string, Promise<Block[]>>();

function getSnapshotCompiler(): MarkdownSnapshotCompiler {
  if (snapshotCompiler === undefined) {
    const options = {
      extensions: createKmMarkdownExtensions(),
      extensionId: KM_MARKDOWN_EXTENSION_ID,
      maxQueueSize: 32,
    };
    snapshotCompiler = createMarkdownSnapshotCompiler(
      typeof window === "undefined" || typeof Worker === "undefined"
        ? options
        : { ...options, worker: createKmMarkdownWorker() },
    );
  }
  return snapshotCompiler;
}

export const kmMarkdownSnapshotCompiler: MarkdownSnapshotCompiler = {
  compile(options) {
    const compilation = snapshotAdmission.then(() => getSnapshotCompiler().compile(options));
    snapshotAdmission = compilation.then(
      () => undefined,
      () => undefined,
    );
    return compilation;
  },
};

function snapshotInit(config: KmMarkdownRenderConfig) {
  return {
    docPlugins: {
      tables: true,
      math: true,
      html: true,
      footnotes: true,
      callouts: "github-alerts" as const,
      softBreaks: config.features.softBreaks ?? "preserve",
      codeHighlighting: "incremental" as const,
      listIndentation: true,
    },
    themes: config.themes,
    highlightEngine: config.highlightEngine,
    extensionId: config.extensionId,
    ...(config.syntax === undefined ? {} : { syntax: config.syntax }),
    html: config.html,
    mathOptions: config.mathOptions,
    linkDestinations: config.linkDestinations,
  };
}

export function kmMarkdownSnapshotCacheKey(text: string, config: KmMarkdownRenderConfig): string {
  return JSON.stringify({
    text,
    extensionId: config.extensionId,
    features: config.features,
    themes: config.themes,
    highlightEngine: config.highlightEngine,
    syntax: config.syntax,
    html: config.html,
    mathOptions: config.mathOptions,
    linkDestinations: config.linkDestinations,
  });
}

export function compileKmMarkdownSnapshot(
  text: string,
  config: KmMarkdownRenderConfig,
): Promise<Block[]> {
  const key = kmMarkdownSnapshotCacheKey(text, config);
  const cached = kmMarkdownSnapshotCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = pendingSnapshots.get(key);
  if (pending !== undefined) return pending;

  const compilation = kmMarkdownSnapshotCompiler
    .compile({ text, init: snapshotInit(config) })
    .then(({ blocks }) => {
      kmMarkdownSnapshotCache.set(key, blocks);
      return blocks;
    })
    .finally(() => pendingSnapshots.delete(key));
  pendingSnapshots.set(key, compilation);
  return compilation;
}

function createSyntaxDescriptor(
  skillNames: readonly string[],
): SyntaxExtensionDescriptor | undefined {
  const inline: NonNullable<SyntaxExtensionDescriptor["inline"]>[number][] = [];
  const skills = [...new Set(skillNames.filter((name) => name.length > 0))].sort();
  if (skills.length > 0) {
    const names = skills.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    inline.push({
      name: "skill",
      pattern: {
        source: `(?<![\\p{L}\\p{N}_])\\$(${names.join("|")})(?![\\p{L}\\p{N}_-])`,
        flags: "u",
      },
      trigger: "$",
      before: "Math",
      attrs: { name: 1 },
    });
  }

  return inline.length === 0 ? undefined : { contractVersion: 1, inline };
}

function stableThemeName(appearance: "light" | "dark", variantId: string, source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  }
  const safeVariant = variantId.replace(/[^A-Za-z0-9_-]/gu, "-");
  return `t3-markdown-${appearance}-${safeVariant}-${(hash >>> 0).toString(36)}`;
}

function markdownTheme(appearance: "light" | "dark"): CodeHighlightTheme {
  const resolved = resolveAppearanceForMode(appearance);
  const variant = resolved?.variant;
  if (variant === null || variant === undefined || variant.syntax.tokens.length === 0) {
    return `github-${appearance}`;
  }
  const source = JSON.stringify([variant.appearance, variant.syntax, variant.diff]);
  return syntaxThemeRegistration(stableThemeName(appearance, variant.id, source), variant);
}

export function useKmMarkdownRenderConfig(
  options: KmMarkdownRenderOptions,
): KmMarkdownRenderConfig {
  const mermaidEngine = useThemedMermaidEngine();
  const { theme, appearanceMode, themeHalves, resolvedTheme } = useTheme();
  const { lineBreaks, parseRawHtml, streamWordFade, isStreaming, skillNames, urlTransform } =
    options;
  const skillNamesKey = skillNames.join("\u0000");
  return useMemo(() => {
    const themes = {
      light: markdownTheme("light"),
      dark: markdownTheme("dark"),
    };
    const features: StreamingFeatureFlags = {
      tables: true,
      math: true,
      html: true,
      footnotes: true,
      callouts: "github-alerts",
      softBreaks: lineBreaks ? "hard" : "preserve",
      codeHighlighting: "incremental",
      listIndentation: true,
    };
    // rehype-sanitize lists HAST property names; the stream-mdx policy takes HTML attribute names.
    const attributes = Object.fromEntries(
      Object.entries(defaultSchema.attributes ?? {}).map(([tag, definitions]) => [
        tag,
        (definitions as readonly (string | readonly [string, ...unknown[]])[])
          .map((definition) => (typeof definition === "string" ? definition : definition[0]))
          .filter((name) => tag !== "*" || name !== "title")
          .map((name) =>
            name === "className"
              ? "class"
              : /^(?:data|aria)[A-Z]/u.test(name)
                ? name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
                : name,
          ),
      ]),
    );
    const mergedAttributes = {
      ...attributes,
      code: [...(attributes.code ?? []), "data-code-meta", "data-inline-code"],
      blockquote: [...(attributes.blockquote ?? []), "data-alert"],
      div: [
        ...(attributes.div ?? []),
        "data-codex-artifact-template",
        "data-artifact-kind",
        "data-display-name",
        "data-gallery-kind",
        "data-skill-directory",
        "data-skill-name",
      ],
      a: [...(attributes.a ?? []), "data-pull-request-autolink"],
      img: [...(attributes.img ?? []), "data-local-src", "data-markdown-title", "data-standalone"],
    };
    const html: HtmlOptions = {
      mode: parseRawHtml ? "sanitize" : "literal",
      sanitization: {
        tagNames: [...(defaultSchema.tagNames ?? [])],
        attributes: mergedAttributes,
        protocols: {
          href: [
            ...(defaultSchema.protocols?.href ?? []),
            "file",
            "t3-citation",
            "t3-context",
            THREAD_LINK_PROTOCOL,
          ],
          src: [...(defaultSchema.protocols?.src ?? []), "file", "t3-context"],
        },
      },
      unmatchedAnchors: "literal-bare",
      standaloneSvg: "code",
    };
    const linkDestinations: LinkDestinationOptions = { windowsDrivePaths: "preserve" };
    const mathOptions: MathParseOptions = { singleDollar: "currency-safe" };
    const animated: AnimatedOptions | false =
      streamWordFade && isStreaming ? { scope: "last-block", className: "stream-word" } : false;
    const syntax = createSyntaxDescriptor(skillNames);
    return {
      features,
      mathOptions,
      linkDestinations,
      html,
      themes,
      highlightEngine: "oniguruma",
      extensionId: KM_MARKDOWN_EXTENSION_ID,
      engineExtensions: kmMarkdownEngineExtensions,
      ...(syntax === undefined ? {} : { syntax }),
      urlTransform: urlTransform ?? defaultUrlTransform,
      animated,
      engines: { math: chatMarkdownMathEngine, mermaid: mermaidEngine },
    };
  }, [
    isStreaming,
    lineBreaks,
    parseRawHtml,
    resolvedTheme,
    theme,
    appearanceMode,
    themeHalves,
    skillNamesKey,
    streamWordFade,
    mermaidEngine,
    urlTransform,
  ]);
}
