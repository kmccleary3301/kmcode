import type { MouseEvent } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { ActivityDisclosurePanel, useActivityDisclosure } from "./ActivityDisclosure";
import { CursorTodoRows } from "./CursorTodoPanel";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import type { TurnRecap as TurnRecapModel } from "./MessagesTimeline.logic";
import { PierreEntryIcon } from "./PierreEntryIcon";

/**
 * A settled turn's to-dos and edited files, folded to one line under its
 * answer: `6 of 6 to-dos · 5 files changed +41 −7 ›`. Opening it lists both;
 * a file opens in the turn's diff when a checkpoint has one.
 */
export function TurnRecap(props: {
  readonly recap: TurnRecapModel;
  /** The turn settled while on screen, so the line rises in. */
  readonly entering: boolean;
  readonly disclosureCache: Set<string>;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenFile: (path: string) => void;
  readonly onFileContextMenu: (path: string, event: MouseEvent) => void;
}) {
  const { recap } = props;
  const disclosure = useActivityDisclosure({
    cache: props.disclosureCache,
    disclosureKey: `turn-recap:${recap.runId}`,
    defaultOpen: false,
  });
  const bodyId = useId();
  const [mountedTaskCount] = useState(recap.todos.length);
  let completed = 0;
  for (const task of recap.todos) if (task.status === "completed") completed += 1;
  let additions = 0;
  let deletions = 0;
  for (const file of recap.files) {
    additions += file.additions;
    deletions += file.deletions;
  }

  return (
    <div className={cn("turn-recap", props.entering && "motion-enter")} data-turn-recap>
      <button
        type="button"
        className="turn-recap-header"
        aria-expanded={disclosure.open}
        aria-controls={bodyId}
        data-scroll-anchor-ignore
        onClick={disclosure.toggle}
      >
        {recap.todos.length > 0 ? (
          <span>
            {completed} of {recap.todos.length} to-dos
          </span>
        ) : null}
        {recap.todos.length > 0 && recap.files.length > 0 ? <span aria-hidden>·</span> : null}
        {recap.files.length > 0 ? (
          <span>
            {recap.files.length} {recap.files.length === 1 ? "file" : "files"} changed
          </span>
        ) : null}
        {hasNonZeroStat({ additions, deletions }) ? (
          <DiffStatLabel additions={additions} deletions={deletions} layout="inline" />
        ) : null}
        <ChevronRightIcon aria-hidden className="turn-recap-chevron size-3.5" />
      </button>
      <ActivityDisclosurePanel open={disclosure.open} instant={disclosure.instant} id={bodyId}>
        <div className="turn-recap-body">
          {recap.todos.length > 0 ? (
            <CursorTodoRows
              ariaLabel="To-dos"
              tasks={recap.todos}
              live={false}
              mountedTaskCount={mountedTaskCount}
            />
          ) : null}
          {recap.files.length > 0 ? (
            <TurnRecapFiles
              files={recap.files}
              open={disclosure.open}
              resolvedTheme={props.resolvedTheme}
              onOpenFile={props.onOpenFile}
              onFileContextMenu={props.onFileContextMenu}
            />
          ) : null}
        </div>
      </ActivityDisclosurePanel>
    </div>
  );
}
const TURN_RECAP_VIRTUALIZE_AFTER = 250;
const TURN_RECAP_ROW_OVERSCAN = 8;
const TURN_RECAP_ROW_HEIGHT = 28;

export function visibleTurnRecapFileRange(input: {
  readonly fileCount: number;
  readonly listTop: number;
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly rowHeight: number;
}) {
  const start = Math.max(
    0,
    Math.min(
      input.fileCount,
      Math.floor((input.viewportTop - input.listTop) / input.rowHeight) - TURN_RECAP_ROW_OVERSCAN,
    ),
  );
  const end = Math.max(
    start,
    Math.min(
      input.fileCount,
      Math.ceil((input.viewportTop + input.viewportHeight - input.listTop) / input.rowHeight) +
        TURN_RECAP_ROW_OVERSCAN,
    ),
  );
  return { start, end };
}

function TurnRecapFiles(props: {
  readonly files: TurnRecapModel["files"];
  readonly open: boolean;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenFile: (path: string) => void;
  readonly onFileContextMenu: (path: string, event: MouseEvent) => void;
}) {
  const containerRef = useRef<HTMLUListElement>(null);
  const rowSizeRef = useRef<HTMLLIElement>(null);
  const [range, setRange] = useState({
    start: 0,
    end: 40,
    rowHeight: TURN_RECAP_ROW_HEIGHT,
  });
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const virtualized = props.files.length > TURN_RECAP_VIRTUALIZE_AFTER;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const rowSize = rowSizeRef.current;
    if (!virtualized || !props.open || !container || !rowSize) return;

    const ancestors: HTMLElement[] = [container, rowSize];
    let scrollElement: HTMLElement | null = null;
    for (let parent = container.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent);
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        scrollElement = parent;
        break;
      }
    }
    const measure = () => {
      const rowHeight = rowSize.getBoundingClientRect().height;
      if (rowHeight <= 0) return;
      const listTop = container.getBoundingClientRect().top;
      const viewportTop = scrollElement
        ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop
        : 0;
      const viewportHeight = scrollElement?.clientHeight ?? document.documentElement.clientHeight;
      const next = visibleTurnRecapFileRange({
        fileCount: props.files.length,
        listTop,
        viewportTop,
        viewportHeight,
        rowHeight,
      });
      setRange((current) =>
        current.start === next.start && current.end === next.end && current.rowHeight === rowHeight
          ? current
          : { ...next, rowHeight },
      );
    };
    measure();
    const scrollTarget = scrollElement ?? globalThis.window;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    globalThis.window.addEventListener("resize", onScroll);
    const stopObserving = observeResize(ancestors, measure);
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      globalThis.window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
      stopObserving();
    };
  }, [props.files.length, props.open, virtualized]);

  const focusedIndex =
    focusedPath === null ? -1 : props.files.findIndex((file) => file.path === focusedPath);
  const start = virtualized ? range.start : 0;
  const end = virtualized ? Math.min(props.files.length, range.end) : props.files.length;
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end) indices.push(focusedIndex);

  return (
    <ul
      ref={containerRef}
      className="turn-recap-files"
      aria-label="Changed files"
      onFocusCapture={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        setFocusedPath(
          event.target.closest<HTMLElement>("[data-turn-recap-file]")?.dataset.turnRecapFile ??
            null,
        );
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setFocusedPath(null);
      }}
      style={
        virtualized
          ? { position: "relative", height: props.files.length * range.rowHeight + 6 }
          : undefined
      }
    >
      {virtualized ? (
        <li
          ref={rowSizeRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute h-7"
        />
      ) : null}
      {indices.map((index) => {
        const file = props.files[index]!;
        const slash = file.path.lastIndexOf("/");
        return (
          <li
            key={file.path}
            data-turn-recap-file={file.path}
            className={virtualized ? "absolute inset-x-0" : undefined}
            style={virtualized ? { top: index * range.rowHeight } : undefined}
          >
            <button
              type="button"
              className="turn-recap-file"
              onClick={() => props.onOpenFile(file.path)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onFileContextMenu(file.path, event);
              }}
            >
              <PierreEntryIcon
                pathValue={file.path}
                kind="file"
                theme={props.resolvedTheme}
                className="size-3.5 shrink-0"
              />
              <span className="turn-recap-file-name">{file.path.slice(slash + 1)}</span>
              {slash > 0 ? (
                <span className="turn-recap-file-dir">{file.path.slice(0, slash)}</span>
              ) : null}
              {hasNonZeroStat(file) ? (
                <DiffStatLabel
                  additions={file.additions}
                  deletions={file.deletions}
                  layout="inline"
                  className="ms-auto shrink-0"
                />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
