import {
  codexArtifactTemplatePresentationLabel,
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from "@t3tools/client-runtime/codex-artifact-templates";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MailIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { Children, cloneElement, createContext, isValidElement, use, type CSSProperties, type HTMLAttributes } from "react";
import type {
  HeadlessNodeViewProps,
  InlineNodeViewProps,
  NodeViewMetadata,
  NodeViewProps,
  PresentationProps,
} from "@stream-mdx/react";
import { ChatMarkdownRendererContext } from "./markdownContext";
import { MarkdownLinkContext } from "./MarkdownMedia";
import { Button } from "../ui/button";
import { SkillInlineText } from "../chat/SkillInlineText";
import { cn } from "../../lib/utils";

export const MarkdownSkillScopeContext = createContext(false);

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  "google-docs": FileTextIcon,
  "google-slides": PresentationIcon,
  "google-sheets": FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>;

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);

  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </span>
          <span className="block text-xs text-muted-foreground">{presentationLabel}</span>
        </span>
      </div>
      {props.onUse ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

export function MarkdownHeadingPresentation({ children, metadata }: NodeViewProps) {
  const { headingLevelOffset } = use(ChatMarkdownRendererContext);
  const child = Children.only(children);
  if (!isValidElement(child)) return child;
  const ariaLevel =
    metadata.headingLevel !== undefined && headingLevelOffset > 0
      ? Math.min(metadata.headingLevel + headingLevelOffset, 6)
      : undefined;
  return cloneElement(child, {
    "data-t3-part": "heading",
    "aria-level": ariaLevel,
  } as HTMLAttributes<HTMLElement>);
}

export function MarkdownParagraphPresentation({ children }: NodeViewProps) {
  return <MarkdownSkillScopeContext.Provider value>{children}</MarkdownSkillScopeContext.Provider>;
}

function orderedListGutterStyle(metadata: NodeViewMetadata): CSSProperties | undefined {
  const itemCount = metadata.itemCount ?? 0;
  if (!metadata.ordered || itemCount < 1) return undefined;
  const firstNumber = metadata.start ?? 1;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` } as CSSProperties;
}

export function orderedListPresentationProps(metadata: NodeViewMetadata): PresentationProps {
  const style = orderedListGutterStyle(metadata);
  return style === undefined ? {} : { style };
}

export function MarkdownListItemPresentation({ children, metadata }: NodeViewProps) {
  const child = Children.only(children);
  const item = isValidElement(child)
    ? cloneElement(child, {
        "data-task-marker-offset": metadata.taskMarkerOffset,
      } as HTMLAttributes<HTMLLIElement>)
    : child;
  return <MarkdownSkillScopeContext.Provider value>{item}</MarkdownSkillScopeContext.Provider>;
}

const GITHUB_ALERT_PRESENTATIONS = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
} satisfies Record<
  NonNullable<NodeViewMetadata["calloutKind"]>,
  { label: string; Icon: LucideIcon; borderClassName: string; titleClassName: string }
>;

export function MarkdownBlockquotePresentation({ children, metadata }: NodeViewProps) {
  const kind = metadata.calloutKind;
  const alert = kind === undefined ? undefined : GITHUB_ALERT_PRESENTATIONS[kind];
  if (!alert) return children;
  return (
    <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
      {children}
    </div>
  );
}

export function MarkdownTaskCheckboxPresentation({ checked, markerOffset }: HeadlessNodeViewProps<"task-checkbox">) {
  const { onTaskListChange } = use(ChatMarkdownRendererContext);
  const validMarkerOffset = Number.isSafeInteger(markerOffset) ? markerOffset : undefined;
  const canChange = onTaskListChange !== undefined && validMarkerOffset !== undefined;
  return (
    <input
      type="checkbox"
      name="markdown-task"
      aria-label="Toggle task"
      checked={checked}
      disabled={!canChange}
      readOnly={!canChange}
      onChange={
        canChange && onTaskListChange
          ? (event) =>
              onTaskListChange({
                markerOffset: validMarkerOffset,
                checked: event.currentTarget.checked,
              })
          : undefined
      }
    />
  );
}

export function MarkdownSkillPresentation({ node }: InlineNodeViewProps) {
  const inSkillScope = use(MarkdownSkillScopeContext);
  const inLink = use(MarkdownLinkContext);
  const { skills } = use(ChatMarkdownRendererContext);
  if (node.kind !== "plugin" || node.name !== "skill") return null;
  const name = node.attrs.name;
  if (!inSkillScope || inLink || !name || !skills.some((skill) => skill.name === name)) {
    return node.raw;
  }
  return <SkillInlineText text={`$${name}`} skills={skills} />;
}

export function MarkdownArtifactTemplatePresentation({ attrs, actions }: HeadlessNodeViewProps<"block-extension:artifact-template">) {
  const { onUseArtifactTemplate } = use(ChatMarkdownRendererContext);
  const template = resolveCodexArtifactTemplate(attrs);
  if (!template) return actions.readSource();
  return <CodexArtifactTemplateCard template={template} onUse={onUseArtifactTemplate} />;
}
