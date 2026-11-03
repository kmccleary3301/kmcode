import { memo } from "react";
import { cn } from "../lib/utils";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import {
  ChatMarkdownRendererContext,
  useChatMarkdownState,
  type ChatMarkdownProps,
} from "./markdown/markdownContext";
import { MarkdownHost } from "./markdown/MarkdownHost";

function ChatMarkdown({
  text,
  className,
  lineBreaks = false,
  parseRawHtml = true,
  streamWordFade = false,
  ...props
}: ChatMarkdownProps) {
  const {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    setLocalMediaPreview,
  } = useChatMarkdownState({ text, ...props });
  const skillNames = componentState.skills.map((skill) => skill.name);

  return (
    <div
      ref={markdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      data-t3-part="markdown"
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        <MarkdownHost
          text={text}
          isStreaming={componentState.isStreaming}
          lineBreaks={lineBreaks}
          parseRawHtml={parseRawHtml}
          streamWordFade={streamWordFade}
          pullRequestRepositoryUrl={props.pullRequestRepositoryUrl ?? null}
          skillNames={skillNames}
          urlTransform={markdownUrlTransform}
        />
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog
          preview={localMediaPreview}
          onClose={() => setLocalMediaPreview(null)}
        />
      ) : null}
    </div>
  );
}

export default memo(ChatMarkdown);
