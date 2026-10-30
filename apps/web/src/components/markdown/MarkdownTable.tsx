import { Check, Copy, Maximize2, Minimize2 } from "lucide";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { NodeViewProps } from "@stream-mdx/react";
import { serializeTableElementToCsv, serializeTableElementToMarkdown } from "../../markdown-clipboard";
import { getClientSettings } from "../../hooks/useSettings";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownContext";

export function MarkdownTablePresentation({ children }: NodeViewProps) {
  return <MarkdownTable>{children}</MarkdownTable>;
}

function tableHasClippedCells(container: HTMLDivElement, table: HTMLTableElement): boolean {
  const viewport = table.closest<HTMLElement>("[data-slot='scroll-area-viewport']");
  const scrollLeft = viewport?.scrollLeft;
  const scrollTop = viewport?.scrollTop;
  const previousExpanded = container.dataset.expanded;
  container.dataset.expanded = "false";
  const clipped = [...table.rows].some((row) =>
    [...row.cells].some((cell) => cell.scrollWidth > cell.clientWidth),
  );
  if (previousExpanded === undefined) delete container.dataset.expanded;
  else container.dataset.expanded = previousExpanded;
  if (viewport && scrollLeft !== undefined && scrollTop !== undefined) {
    viewport.scrollLeft = scrollLeft;
    viewport.scrollTop = scrollTop;
  }
  return clipped;
}

function MarkdownTable({ children }: { readonly children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(() => getClientSettings().wordWrap);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasClippedCells, setHasClippedCells] = useState(false);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";
  const measureClippedCells = useCallback(() => {
    const container = containerRef.current;
    const table = container?.querySelector("table") ?? null;
    if (!container || !table) return;
    setHasClippedCells(tableHasClippedCells(container, table));
  }, []);

  useLayoutEffect(measureClippedCells);
  useEffect(() => {
    const container = containerRef.current;
    const table = container?.querySelector("table") ?? null;
    if (!container || !table || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureClippedCells);
    observer.observe(container);
    observer.observe(table);
    return () => observer.disconnect();
  }, [measureClippedCells]);

  function toggleExpanded() {
    const table = containerRef.current?.querySelector("table") ?? null;
    if (!table) return;

    if (!expanded) {
      const rows = [...table.rows];
      const columnWidths = rows.reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  const handleCopy = useCallback((format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure({ operation: "copy-table", format }, cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        {children}
      </ScrollArea>
      <div className="mt-0.5 flex items-center justify-between select-none">
        {hasClippedCells ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={expanded ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={expanded}
                  onClick={toggleExpanded}
                  aria-label={expandLabel}
                />
              }
            >
              <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
            </TooltipTrigger>
            <TooltipPopup side="top">{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : (
          <span />
        )}
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}