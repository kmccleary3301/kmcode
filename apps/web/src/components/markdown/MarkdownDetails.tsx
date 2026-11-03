import { ChevronRightIcon } from "lucide-react";
import { Children, isValidElement, useState, type ReactNode } from "react";
import type { HtmlNodeViewProps } from "@stream-mdx/react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export function MarkdownDetailsPresentation({ properties, children }: HtmlNodeViewProps) {
  const open = properties.open === true || properties.open === "" || properties.open === "open" || properties.open === "true";
  return <MarkdownDetails open={open}>{children}</MarkdownDetails>;
}

function MarkdownDetails({
  children,
  open = false,
}: Pick<React.ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex((child) =>
    isValidElement<{ children?: ReactNode; "data-markdown-summary"?: unknown }>(child) &&
    (child.type === "summary" || child.props["data-markdown-summary"] !== undefined),
  );
  const summaryNode = childNodes[summaryIndex];
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <div className="my-2 border-y border-border/60">
      <Collapsible
        defaultOpen={open}
        onOpenChange={setIsOpen}
        data-markdown-details=""
        data-markdown-details-open={isOpen ? "true" : "false"}
      >
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
          data-markdown-details-summary=""
        >
          <ChevronRightIcon
            className="size-4 shrink-0 text-muted-foreground transition-transform"
            aria-hidden
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div
            className="pb-3 ps-6 text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]"
            data-markdown-details-content=""
          >
            {content}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
