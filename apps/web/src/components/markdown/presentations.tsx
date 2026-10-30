import type { HtmlNodeViewProps, InlineNodeViewProps, NodePresentations } from "@stream-mdx/react";
import { use } from "react";
import {
  inlineNodesToPlainText,
  MarkdownAnchor,
  MarkdownFileCitationPresentation,
  MarkdownPrReferencePresentation,
} from "./MarkdownLinks";
import {
  MarkdownCodeBlockPresentation,
  MarkdownInlineCodePresentation,
} from "./MarkdownCode";
import { MarkdownDetailsPresentation } from "./MarkdownDetails";
import { MarkdownMathPresentation } from "./MarkdownMath";
import { MarkdownImage } from "./MarkdownMedia";
import {
  MarkdownArtifactTemplatePresentation,
  MarkdownBlockquotePresentation,
  MarkdownHeadingPresentation,
  MarkdownListItemPresentation,
  MarkdownParagraphPresentation,
  MarkdownSkillPresentation,
  MarkdownTaskCheckboxPresentation,
  orderedListPresentationProps,
} from "./MarkdownSemantics";
import { MarkdownTablePresentation } from "./MarkdownTable";
import { ChatMarkdownRendererContext } from "./markdownContext";

function stringProperty(properties: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = properties[name];
  return typeof value === "string" ? value : undefined;
}

function dimensionProperty(properties: Readonly<Record<string, unknown>>, name: string): string | number | undefined {
  const value = properties[name];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function MarkdownInlineLinkPresentation({ node, children }: InlineNodeViewProps) {
  const markdownState = use(ChatMarkdownRendererContext);
  if (node.kind !== "link" || node.href === undefined) return children ?? null;
  return (
    <MarkdownAnchor
      href={node.href}
      title={node.title}
      markdownState={markdownState}
      sourceRange={node.sourceRange}
      plainText={inlineNodesToPlainText(node.children)}
    >
      {children}
    </MarkdownAnchor>
  );
}

function MarkdownHtmlAnchorPresentation({ properties, children, metadata }: HtmlNodeViewProps) {
  const markdownState = use(ChatMarkdownRendererContext);
  const href = stringProperty(properties, "href");
  if (href === undefined) {
    return (
      <a
        title={stringProperty(properties, "title")}
        className={stringProperty(properties, "className")}
        id={stringProperty(properties, "id")}
        aria-label={stringProperty(properties, "aria-label")}
      >
        {children}
      </a>
    );
  }
  return (
    <MarkdownAnchor
      href={href}
      title={stringProperty(properties, "title")}
      className={stringProperty(properties, "className")}
      id={stringProperty(properties, "id")}
      aria-label={stringProperty(properties, "aria-label")}
      markdownState={markdownState}
      sourceRange={metadata.sourceRange}
    >
      {children}
    </MarkdownAnchor>
  );
}

function MarkdownInlineImagePresentation({ node, context }: InlineNodeViewProps) {
  const markdownState = use(ChatMarkdownRendererContext);
  if (node.kind !== "image") return null;
  const imageProps = {
    ...(node.alt === undefined ? {} : { alt: node.alt }),
    ...(node.title === undefined ? {} : { title: node.title }),
  };
  return (
    <MarkdownImage
      src={node.src}
      {...imageProps}
      isStandalone={context?.isStandalone === true}
      markdownState={markdownState}
    />
  );
}

function MarkdownHtmlImagePresentation({ properties, context }: HtmlNodeViewProps) {
  const markdownState = use(ChatMarkdownRendererContext);
  const src = stringProperty(properties, "src");
  const title = stringProperty(properties, "title");
  const alt = stringProperty(properties, "alt");
  const width = dimensionProperty(properties, "width");
  const height = dimensionProperty(properties, "height");
  const className = stringProperty(properties, "className");
  const id = stringProperty(properties, "id");
  const align = stringProperty(properties, "align");
  const imageProps = {
    ...(src === undefined ? {} : { src }),
    ...(title === undefined ? {} : { title }),
    ...(alt === undefined ? {} : { alt }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(className === undefined ? {} : { className }),
    ...(id === undefined ? {} : { id }),
    ...(align === undefined ? {} : { align }),
  };
  return (
    <MarkdownImage
      {...imageProps}
      isStandalone={context?.isStandalone === true}
      markdownState={markdownState}
    />
  );
}

export const CHAT_MARKDOWN_PRESENTATIONS: NodePresentations = {
  heading: { wrapper: MarkdownHeadingPresentation },
  paragraph: { wrapper: MarkdownParagraphPresentation },
  list: { props: orderedListPresentationProps },
  "list-item": { wrapper: MarkdownListItemPresentation },
  "list-item-ordered": { wrapper: MarkdownListItemPresentation },
  "list-item-unordered": { wrapper: MarkdownListItemPresentation },
  "task-checkbox": { view: MarkdownTaskCheckboxPresentation },
  blockquote: { wrapper: MarkdownBlockquotePresentation },
  callout: { wrapper: MarkdownBlockquotePresentation },
  code: { wrapper: MarkdownCodeBlockPresentation },
  table: { wrapper: MarkdownTablePresentation },
  "html:table": { wrapper: MarkdownTablePresentation },
  "inline:link": { view: MarkdownInlineLinkPresentation },
  "html:a": { view: MarkdownHtmlAnchorPresentation },
  "inline:code": { view: MarkdownInlineCodePresentation },
  "inline:image": { view: MarkdownInlineImagePresentation },
  "html:img": { view: MarkdownHtmlImagePresentation },
  "html:details": { view: MarkdownDetailsPresentation },
  "html:summary": { props: { "data-markdown-summary": "" } },
  "inline:math": { view: MarkdownMathPresentation },
  "extension:skill": { view: MarkdownSkillPresentation },
  "extension:pr-reference": { view: MarkdownPrReferencePresentation },
  "extension:file-citation": { view: MarkdownFileCitationPresentation },
  "block-extension:artifact-template": { view: MarkdownArtifactTemplatePresentation },
};
