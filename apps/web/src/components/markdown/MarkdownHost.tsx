import { MarkdownBlocksRenderer, StreamingMarkdown } from "@stream-mdx/react";
import type { Block, UrlTransform } from "@stream-mdx/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHAT_MARKDOWN_PRESENTATIONS } from "./presentations";
import {
  compileKmMarkdownSnapshot,
  createKmMarkdownAppendStream,
  createKmMarkdownWorker,
  kmMarkdownSnapshotCache,
  kmMarkdownSnapshotCacheKey,
  useKmMarkdownRenderConfig,
  type KmMarkdownRenderConfig,
  type KmMarkdownRenderOptions,
} from "./markdownRuntime";

export interface MarkdownHostProps extends KmMarkdownRenderOptions {
  readonly text: string;
  readonly urlTransform?: UrlTransform;
}

export function MarkdownHost({ text, urlTransform, ...options }: MarkdownHostProps) {
  const config = useKmMarkdownRenderConfig({
    ...options,
    ...(urlTransform === undefined ? {} : { urlTransform }),
  });
  const [streamingAtMount] = useState(options.isStreaming);

  if (streamingAtMount) {
    return <StreamingMarkdownHost text={text} config={config} isStreaming={options.isStreaming} />;
  }
  return <SnapshotMarkdownHost text={text} config={config} />;
}

function StreamingMarkdownHost({
  text,
  config,
  isStreaming,
}: {
  readonly text: string;
  readonly config: KmMarkdownRenderConfig;
  readonly isStreaming: boolean;
}) {
  const workerAvailable = typeof window !== "undefined" && typeof Worker !== "undefined";
  const [storedStream, setStoredStream] = useState(() =>
    createKmMarkdownAppendStream(text, !isStreaming),
  );
  let stream = storedStream;
  if (!text.startsWith(stream.sent) || (stream.closed && text !== stream.sent)) {
    stream = createKmMarkdownAppendStream(text, !isStreaming);
    setStoredStream(stream);
  }
  const wasStreaming = useRef(isStreaming);

  useLayoutEffect(() => {
    stream.push(text.slice(stream.sent.length));
    if (!isStreaming) {
      // StreamingMarkdown finalizes when the closed stream reaches EOF, after the tail drains.
      stream.close();
      if (wasStreaming.current) {
        void compileKmMarkdownSnapshot(text, config).catch((error: unknown) => {
          console.error("[chat-markdown] snapshot cache seed failed", error);
        });
      }
    }
    wasStreaming.current = isStreaming;
  }, [config, isStreaming, stream, text]);

  return (
    <StreamingMarkdown
      engine={workerAvailable ? "worker" : "main"}
      {...(workerAvailable
        ? { worker: createKmMarkdownWorker }
        : { engineExtensions: config.engineExtensions })}
      stream={stream}
      components={CHAT_MARKDOWN_PRESENTATIONS}
      features={config.features}
      mathOptions={config.mathOptions}
      linkDestinations={config.linkDestinations}
      html={config.html}
      themes={config.themes}
      highlightEngine={config.highlightEngine}
      extensionId={config.extensionId}
      {...(config.syntax === undefined ? {} : { syntax: config.syntax })}
      urlTransform={config.urlTransform}
      animated={config.animated}
      engines={config.engines}
      caret={false}
    />
  );
}

function SnapshotMarkdownHost({
  text,
  config,
}: {
  readonly text: string;
  readonly config: KmMarkdownRenderConfig;
}) {
  const cacheKey = kmMarkdownSnapshotCacheKey(text, config);
  const cached = kmMarkdownSnapshotCache.get(cacheKey);
  const [compiled, setCompiled] = useState<{ readonly key: string; readonly blocks: Block[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // Keep the previous snapshot visible while a changed text compiles; a failure for this key wins.
  const blocks = failedKey === cacheKey ? undefined : (cached ?? compiled?.blocks);

  useEffect(() => {
    if (cached !== undefined) return;
    let active = true;
    void compileKmMarkdownSnapshot(text, config).then(
      (snapshot) => {
        if (active) setCompiled({ key: cacheKey, blocks: snapshot });
      },
      (error: unknown) => {
        if (!active) return;
        setFailedKey(cacheKey);
        console.error("[chat-markdown] snapshot compilation failed", error);
      },
    );
    return () => {
      active = false;
    };
  }, [cacheKey, cached, config, text]);

  if (blocks === undefined) {
    return (
      <div
        className="whitespace-pre-wrap"
        data-markdown-pending={failedKey === cacheKey ? undefined : ""}
        data-markdown-error={failedKey === cacheKey ? "" : undefined}
      >
        {text}
      </div>
    );
  }

  return (
    <MarkdownBlocksRenderer
      blocks={blocks}
      components={CHAT_MARKDOWN_PRESENTATIONS}
      urlTransform={config.urlTransform}
      animated={config.animated}
      engines={{ mermaid: config.engines.mermaid }}
    />
  );
}
