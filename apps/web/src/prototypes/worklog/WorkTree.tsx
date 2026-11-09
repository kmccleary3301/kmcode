// PROTOTYPE: throwaway work-log tree demo. Not production code.
//
// The proposed transcript work log: one turn-level parent that reads
// "Worked for 5m 37s over 43 actions", segments as its branches, and the
// steps (taller, two-line rows) as leaves. Expansion is derived from the
// playback position plus the reader's own toggles.
import {
  Bot,
  Braces,
  CircleCheck,
  Brain,
  ChevronRight,
  Clock,
  FilePlus2,
  FileText,
  Globe,
  ListChecks,
  MessageSquareText,
  Pencil,
  Search,
  Target,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import ChatMarkdown from "../../components/ChatMarkdown";
import { AsciiLoader } from "../../components/ui/ascii-loader";
import { ShimmerLayers } from "../../components/ui/shimmer";
import { SpinningGlobe } from "../../components/ui/spinning-globe";
import { createSpringChase, MOTION_MS, type SpringChase, useSmoothHeight } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { motionLands } from "./motion";
import type { Trace } from "./trace";
import {
  deriveWorkTree,
  itemRunning,
  type ActionLeaf,
  type GroupNode,
  type Leaf,
  type PhaseItem,
  type PhaseNode,
  type SubagentNode,
  type ThoughtLeaf,
  type TranscriptLook,
  type TreeChild,
  type WorkTreeModel,
} from "./tree";

export type Overrides = ReadonlyMap<string, boolean>;

/** `tree` steps each level in behind a guide line; `flat` keeps one column. */
export type TreeLayout = "tree" | "flat";

interface TreeContext {
  readonly look: TranscriptLook;
  readonly layout: TreeLayout;
  readonly overrides: Overrides;
  readonly onToggle: (id: string, open: boolean) => void;
  /** Leaves whose excerpt (code, output, thought) opens on its own. */
  readonly keptOpen: ReadonlySet<string>;
  /** False until the tree's first paint: history renders still. */
  readonly arrivals: boolean;
}

/** Steps shown in an open group or phase before "N earlier steps". */
const VISIBLE_LEAVES: Record<TranscriptLook, number> = { minimal: 3, "minimal-plus": 5 };
/** Minimal+ keeps this many newest steps open with their excerpts. */
const KEPT_OPEN_STEPS = 2;

function isOpen(ctx: TreeContext, id: string, auto: boolean): boolean {
  return ctx.overrides.get(id) ?? auto;
}

function liveLeaves(children: ReadonlyArray<TreeChild>): Leaf[] {
  return children.flatMap((child) =>
    child.kind === "phase" && child.live
      ? child.items.flatMap((item): Leaf[] =>
          item.kind === "group" ? [...item.leaves] : item.kind === "note" ? [] : [item],
        )
      : [],
  );
}

function hasExcerpt(leaf: Leaf): boolean {
  if (leaf.kind === "thought") return leaf.text.length > 0;
  return leaf.code !== null || (leaf.output !== null && leaf.output.trim().length > 0);
}

function deriveKeptOpen(model: WorkTreeModel, look: TranscriptLook): ReadonlySet<string> {
  if (!model.live) return new Set();
  const leaves = liveLeaves(model.children).toSorted((a, b) => a.startedAt - b.startedAt);
  if (look === "minimal") {
    // Minimal opens only what is being written right now: code or a thought.
    const newest = leaves.at(-1);
    if (newest === undefined) return new Set();
    const writing =
      newest.kind === "thought"
        ? newest.live && newest.text.length > 0
        : newest.code !== null && newest.phase !== "done";
    return writing ? new Set([newest.id]) : new Set();
  }
  return new Set(
    leaves
      .filter(hasExcerpt)
      .slice(-KEPT_OPEN_STEPS)
      .map((leaf) => leaf.id),
  );
}

export function WorkTreeTranscript(props: {
  readonly trace: Trace;
  readonly t: number;
  readonly look: TranscriptLook;
  readonly layout: TreeLayout;
  readonly overrides: Overrides;
  readonly onToggle: (id: string, open: boolean) => void;
}) {
  const model = useMemo(() => deriveWorkTree(props.trace, props.t), [props.trace, props.t]);
  const keptOpen = useMemo(() => deriveKeptOpen(model, props.look), [model, props.look]);
  // What is on screen at first paint is history; only later arrivals glide in.
  const [arrivals, setArrivals] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArrivals(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const ctx: TreeContext = {
    look: props.look,
    layout: props.layout,
    overrides: props.overrides,
    onToggle: props.onToggle,
    keptOpen,
    arrivals,
  };
  const hasWork = model.children.length > 0;
  return (
    <div className="wl-tree mx-auto flex w-full max-w-[44rem] min-w-0 flex-col gap-5 px-7 pt-6 pb-40">
      <div className="-mx-3.5 rounded-[10px] border border-border bg-card px-3.5 py-2.5 text-sm text-foreground">
        <p className="line-clamp-4 whitespace-pre-wrap">{props.trace.prompt.text}</p>
      </div>
      <Collapsible open={model.started && hasWork} appear={arrivals}>
        <TurnNode model={model} ctx={ctx} />
      </Collapsible>
      {model.finalAnswer ? (
        <ChatMarkdown
          text={model.finalAnswer.text}
          cwd={undefined}
          isStreaming={model.finalAnswer.streaming}
          streamWordFade
        />
      ) : null}
    </div>
  );
}

/**
 * Opens, closes and arrives by gliding its own height on KM's transcript
 * spring. The spring chases the content's live height, so content that keeps
 * growing mid-glide (a nested arrival, streamed text) is followed rather than
 * cut off, and a toggle mid-flight turns around with its velocity instead of
 * restarting. At rest an open box is plain auto height and its content fades
 * in and out with it. A key press, the transport and reduced motion land.
 */
function Collapsible(props: {
  readonly open: boolean;
  /** Glide open from nothing on mount (a live arrival). */
  readonly appear?: boolean;
  readonly children: ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const chaseRef = useRef<SpringChase | null>(null);
  const openRef = useRef(props.open);
  const [arriving] = useState(() => props.open && props.appear === true && !motionLands());

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const content = contentRef.current;
    if (outer === null || content === null) return;
    const settle = () => {
      if (openRef.current) {
        outer.style.height = "";
        delete outer.dataset.gliding;
      }
    };
    const chase = createSpringChase((height) => {
      outer.style.height = `${height}px`;
    }, settle);
    chaseRef.current = chase;
    if (!openRef.current) outer.style.height = "0px";
    else if (arriving) {
      outer.dataset.gliding = "";
      outer.style.height = "0px";
      chase.to(0, content.offsetHeight);
      // The fade starts from the closed state once the box is on screen.
      requestAnimationFrame(() => delete outer.dataset.arriving);
    }
    // Mid-glide, the target is wherever the content has grown to.
    const observer = new ResizeObserver(() => {
      if (chase.running && openRef.current) chase.to(chase.value, content.offsetHeight);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      chase.stop();
      chaseRef.current = null;
    };
  }, [arriving]);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const content = contentRef.current;
    const chase = chaseRef.current;
    if (outer === null || content === null || chase === null || openRef.current === props.open) {
      return;
    }
    openRef.current = props.open;
    // At rest an open box is as tall as its content and a closed one is 0.
    const from = chase.running ? chase.value : props.open ? 0 : content.offsetHeight;
    const target = props.open ? content.offsetHeight : 0;
    if (motionLands()) {
      chase.stop();
      outer.style.height = props.open ? "" : "0px";
      delete outer.dataset.gliding;
      return;
    }
    outer.dataset.gliding = "";
    if (!chase.running) outer.style.height = `${from}px`;
    chase.to(from, target);
  }, [props.open]);

  return (
    <div
      ref={outerRef}
      className="wl-collapsible min-w-0"
      data-open={props.open ? "" : undefined}
      data-arriving={arriving ? "" : undefined}
      aria-hidden={!props.open}
      inert={!props.open}
    >
      <div ref={contentRef} className="wl-collapsible-content min-w-0">
        {props.children}
      </div>
    </div>
  );
}

/**
 * Streamed text (a thought, a note) grows and shrinks on the transcript
 * spring instead of stepping a line at a time, through KM's glide edge fade.
 * History and landed changes take the new height at once.
 */
function GrowingBox(props: { readonly animate: boolean; readonly children: ReactNode }) {
  const { outerRef, contentRef } = useSmoothHeight<HTMLDivElement, HTMLDivElement>(
    !props.animate || motionLands(),
  );
  return (
    <div ref={outerRef} className="wl-grow min-w-0">
      <div ref={contentRef}>{props.children}</div>
    </div>
  );
}

/**
 * Where a level's children sit. The tree steps them in behind a guide line;
 * flat leaves them in their parent's column.
 */
function Branch(props: {
  readonly ctx: TreeContext;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={props.ctx.layout === "flat" ? "min-w-0" : props.className}>
      {props.children}
    </div>
  );
}

function Chevron(props: { readonly open: boolean; readonly className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        "wl-chevron size-3.5 shrink-0 text-muted-foreground/70",
        props.open && "rotate-90",
        props.className,
      )}
    />
  );
}

function LiveLabel(props: { readonly live: boolean; readonly children: ReactNode }) {
  return (
    <span
      ref={props.live ? observeVisibleAnimation : undefined}
      className={cn("min-w-0 truncate", props.live && "minimal-text-shimmer")}
    >
      <ShimmerLayers active={props.live}>{props.children}</ShimmerLayers>
    </span>
  );
}

function TurnNode(props: { readonly model: WorkTreeModel; readonly ctx: TreeContext }) {
  const { model, ctx } = props;
  const id = "turn";
  const open = isOpen(ctx, id, model.live);
  return (
    <section data-wl-row={id} className="wl-turn min-w-0" data-live={model.live ? "" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ctx.onToggle(id, !open)}
        className="group/turn -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50"
      >
        <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center">
          {model.live ? (
            <AsciiLoader className="size-4 text-info" />
          ) : (
            <Chevron open={open} className="size-4 text-foreground/60" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2 text-[0.9375rem] leading-6 font-medium text-foreground">
            <LiveLabel live={model.live}>{model.title}</LiveLabel>
          </span>
          {model.meta.length > 0 || model.goal !== null ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-5 text-muted-foreground">
              {model.goal !== null ? (
                <MetaChip icon={Target} title={model.goal} className="max-w-[22rem]">
                  Goal · {model.goal}
                </MetaChip>
              ) : null}
              {model.meta.map((part) => (
                <MetaChip key={part}>
                  <DiffAwareText text={part} />
                </MetaChip>
              ))}
            </span>
          ) : null}
        </span>
        {model.live ? null : (
          <Chevron open={open} className="mt-1.5 opacity-0 group-hover/turn:opacity-100" />
        )}
      </button>
      <Collapsible open={open}>
        {/* Flat keeps one step in, under the title, and none below it. */}
        <div
          className={
            ctx.layout === "flat"
              ? "mt-1 ps-[26px]"
              : "relative ms-[7px] mt-1 border-s border-border/80 ps-4"
          }
        >
          <ChildList nodes={model.children} ctx={ctx} />
        </div>
      </Collapsible>
    </section>
  );
}

function MetaChip(props: {
  readonly icon?: LucideIcon;
  readonly title?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <span
      title={props.title}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-px tabular-nums",
        props.className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
      <span className="truncate">{props.children}</span>
    </span>
  );
}

/** Colours a trailing `+n −m` the way the timeline colours diff counts. */
function DiffAwareText(props: { readonly text: string }) {
  const match = /^(.*?)((?:\s\+\d+)?(?:\s−\d+)?)$/.exec(props.text);
  const head = match?.[1] ?? props.text;
  const tail = match?.[2] ?? "";
  if (tail.trim().length === 0) return <>{props.text}</>;
  return (
    <>
      {head}
      {tail.split(" ").map((part, index) =>
        part.length === 0 ? null : (
          <span
            // Parts are positional and never reorder.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className={cn(
              "ms-1",
              part.startsWith("+") ? "text-diff-addition" : "text-diff-deletion",
            )}
          >
            {part}
          </span>
        ),
      )}
    </>
  );
}

/** How long a removed row stays mounted while it glides shut. */
const EXIT_MS = MOTION_MS + 100;

interface Present<T> {
  readonly item: T;
  readonly exiting: boolean;
}

/**
 * Keeps rows that left the list mounted for EXIT_MS, at their old place, so
 * they can glide shut instead of vanishing and yanking the rows around them.
 * Compares ids, not array identity: the tree is re-derived every frame.
 */
function usePresent<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  animate: boolean,
): ReadonlyArray<Present<T>> {
  const signature = items.map((item) => item.id).join("\n");
  const [previous, setPrevious] = useState({ signature, items });
  const [exiting, setExiting] = useState<ReadonlyMap<string, { item: T; index: number }>>(
    () => new Map(),
  );
  if (previous.signature !== signature) {
    setPrevious({ signature, items });
    const live = new Set(items.map((item) => item.id));
    const next = new Map([...exiting].filter(([id]) => !live.has(id)));
    if (animate) {
      previous.items.forEach((item, index) => {
        if (!live.has(item.id)) next.set(item.id, { item, index });
      });
    }
    setExiting(next);
  }
  useEffect(() => {
    if (exiting.size === 0) return;
    const timer = window.setTimeout(() => setExiting(new Map()), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);
  const present: Present<T>[] = items.map((item) => ({ item, exiting: false }));
  for (const { item, index } of exiting.values()) {
    present.splice(Math.min(index, present.length), 0, { item, exiting: true });
  }
  return present;
}

function ChildList(props: { readonly nodes: ReadonlyArray<TreeChild>; readonly ctx: TreeContext }) {
  const { ctx } = props;
  const present = usePresent(props.nodes, ctx.arrivals);
  const only = props.nodes.length === 1 ? props.nodes[0] : undefined;
  // A single unplanned phase adds a level without saying anything.
  if (only?.kind === "phase" && !only.planned) {
    return <ItemList ownerId={only.id} items={only.items} ctx={ctx} />;
  }
  // Spacing sits inside each row's glide, so a row closing takes its gap along.
  const spacing = ctx.layout === "flat" ? "pt-1.5" : "pt-0.5";
  return (
    <div className="flex min-w-0 flex-col pb-0.5">
      {present.map(({ item: child, exiting }) => (
        <Collapsible key={child.id} open={!exiting} appear={ctx.arrivals}>
          <div className={spacing}>
            {child.kind === "note" ? (
              <NoteRow id={child.id} text={child.text} live={child.live} animate={ctx.arrivals} />
            ) : (
              <PhaseRow phase={child} ctx={ctx} />
            )}
          </div>
        </Collapsible>
      ))}
    </div>
  );
}

function NoteRow(props: {
  readonly id: string;
  readonly text: string;
  readonly live: boolean;
  readonly animate: boolean;
}) {
  return (
    <div data-wl-row={props.id} className="flex min-w-0 gap-2.5 py-1.5">
      <MessageSquareText aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground/70" />
      <div className="min-w-0 flex-1 text-sm leading-6 text-foreground/85">
        <GrowingBox animate={props.animate}>
          <ChatMarkdown text={props.text} cwd={undefined} isStreaming={props.live} streamWordFade />
        </GrowingBox>
      </div>
    </div>
  );
}

function CountBadge(props: { readonly count: number }) {
  if (props.count < 2) return null;
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 text-[0.6875rem] leading-4 text-muted-foreground tabular-nums">
      {props.count}
    </span>
  );
}

function Duration(props: { readonly ms: number }) {
  return (
    <span className="w-12 shrink-0 text-right text-xs leading-5 text-muted-foreground/80 tabular-nums">
      {formatDuration(props.ms)}
    </span>
  );
}

function PhaseRow(props: { readonly phase: PhaseNode; readonly ctx: TreeContext }) {
  const { phase, ctx } = props;
  const open = isOpen(ctx, phase.id, phase.live);
  return (
    <div data-wl-row={phase.id} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ctx.onToggle(phase.id, !open)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent/40"
      >
        <span className="flex h-5 shrink-0 items-center">
          <Chevron open={open} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5 font-medium text-foreground/85">
            {phase.checked ? (
              <CircleCheck aria-label="Done" className="size-3.5 shrink-0 text-success" />
            ) : null}
            <LiveLabel live={phase.live}>{phase.title}</LiveLabel>
          </span>
          {phase.summary || phase.diff ? (
            <span className="flex min-w-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
              <span className="truncate">{phase.summary}</span>
              {phase.diff ? (
                <span className="shrink-0 tabular-nums">
                  <DiffAwareText text={` ${phase.diff}`} />
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="flex h-5 shrink-0 items-center gap-2">
          <CountBadge count={phase.actionCount} />
          <Duration ms={phase.elapsedMs} />
        </span>
      </button>
      <Collapsible open={open}>
        <Branch ctx={ctx} className="ms-[6px] border-s border-border/70 ps-3.5">
          <ItemList ownerId={phase.id} items={phase.items} ctx={ctx} />
        </Branch>
      </Collapsible>
    </div>
  );
}

/**
 * The newest items of a phase or group; older ones fold behind an
 * "N earlier steps" toggle. Older items that are still running (a subagent at
 * work) stay in view. Every row glides on its own, so a step folding away,
 * arriving or leaving moves only its own height and its neighbours slide.
 */
function ItemList(props: {
  readonly ownerId: string;
  readonly items: ReadonlyArray<PhaseItem>;
  readonly ctx: TreeContext;
}) {
  const { ctx } = props;
  const allKey = `${props.ownerId}:all`;
  const showAll = ctx.overrides.get(allKey) ?? false;
  const present = usePresent(props.items, ctx.arrivals);
  const cut = Math.max(0, props.items.length - VISIBLE_LEAVES[ctx.look]);
  const folded = new Set<string>();
  props.items.forEach((item, index) => {
    if (index < cut && !itemRunning(item)) folded.add(item.id);
  });
  const earlier = folded.size;
  const renderItem = (item: PhaseItem) => {
    switch (item.kind) {
      case "group":
        return <GroupRow group={item} ctx={ctx} />;
      case "note":
        return <NoteRow id={item.id} text={item.text} live={item.live} animate={ctx.arrivals} />;
      case "thought":
        return <ThoughtRow leaf={item} ctx={ctx} />;
      case "action":
        return <ActionRow leaf={item} ctx={ctx} />;
    }
  };
  return (
    <div className="flex min-w-0 flex-col py-0.5">
      <Collapsible open={earlier > 0} appear={ctx.arrivals}>
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => ctx.onToggle(allKey, !showAll)}
          className="flex h-7 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="text-muted-foreground/60">⋯</span>
          {showAll ? "Hide " : ""}
          {Math.max(1, earlier)} earlier {earlier === 1 ? "step" : "steps"}
        </button>
      </Collapsible>
      {present.map(({ item, exiting }) => (
        <Collapsible
          key={item.id}
          open={!exiting && (showAll || !folded.has(item.id))}
          appear={ctx.arrivals}
        >
          {renderItem(item)}
        </Collapsible>
      ))}
    </div>
  );
}

function GroupRow(props: { readonly group: GroupNode; readonly ctx: TreeContext }) {
  const { group, ctx } = props;
  const open = isOpen(ctx, group.id, group.live);
  return (
    <div data-wl-row={group.id} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ctx.onToggle(group.id, !open)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.8125rem] leading-6 transition-colors hover:bg-accent/40"
      >
        <Chevron open={open} />
        <span className="flex min-w-0 flex-1 items-center gap-2 text-foreground/75">
          <LiveLabel live={group.live}>{group.label}</LiveLabel>
          {group.diff ? (
            <span className="shrink-0 text-xs tabular-nums">
              <DiffAwareText text={` ${group.diff}`} />
            </span>
          ) : null}
        </span>
        <CountBadge count={group.actionCount} />
        <Duration ms={group.elapsedMs} />
      </button>
      <Collapsible open={open}>
        <Branch ctx={ctx} className="ms-[6px] border-s border-dashed border-border/70 ps-3.5">
          <ItemList ownerId={group.id} items={group.leaves} ctx={ctx} />
        </Branch>
      </Collapsible>
    </div>
  );
}

const ICONS: Record<string, LucideIcon> = {
  read: FileText,
  grep: Search,
  find: Search,
  glob: Search,
  ls: Search,
  web_search: Globe,
  bash: Terminal,
  eval: Braces,
  write: FilePlus2,
  edit: Pencil,
  ast_edit: Pencil,
  task: Bot,
  wait: Clock,
  hub: Clock,
  todo: ListChecks,
  goal: Target,
};

function ActionIcon(props: { readonly leaf: ActionLeaf }) {
  const { leaf } = props;
  if (leaf.phase !== "done") {
    if (leaf.event.name === "web_search") return <SpinningGlobe className="size-3.5" />;
    return <AsciiLoader className="size-3.5 text-info" />;
  }
  const deleted = leaf.change?.op === "deleted";
  const isPage = leaf.event.name === "read" && /^https?:/.test(leaf.object);
  const Icon = deleted ? Trash2 : isPage ? Globe : (ICONS[leaf.event.name] ?? Wrench);
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5", leaf.failed ? "text-destructive" : "text-muted-foreground")}
    />
  );
}

function splitPath(path: string): { folder: string; base: string } {
  const index = path.lastIndexOf("/");
  if (index < 0 || path.startsWith("http")) return { folder: "", base: path };
  return { folder: path.slice(0, index + 1), base: path.slice(index + 1) };
}

function ActionRow(props: { readonly leaf: ActionLeaf; readonly ctx: TreeContext }) {
  const { leaf, ctx } = props;
  const live = leaf.phase !== "done";
  const expandable = hasExcerpt(leaf) || leaf.subagents.length > 0;
  const open = isOpen(ctx, leaf.id, ctx.keptOpen.has(leaf.id));
  const path = leaf.objectIsPath ? splitPath(leaf.object) : null;
  return (
    <div data-wl-row={leaf.id} className="min-w-0" data-phase={leaf.phase}>
      <div
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => ctx.onToggle(leaf.id, !open) : undefined}
        onKeyDown={
          expandable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  ctx.onToggle(leaf.id, !open);
                }
              }
            : undefined
        }
        className={cn(
          "-mx-1.5 flex min-h-10 min-w-0 items-start gap-2.5 rounded-md px-1.5 py-1.5",
          expandable && "cursor-pointer transition-colors hover:bg-accent/40",
        )}
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <ActionIcon leaf={leaf} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
            <LiveLabel live={live}>
              <span className="text-foreground/80">{leaf.verb}</span>{" "}
              {path ? (
                <>
                  <span className="text-muted-foreground">{path.folder}</span>
                  <span className="font-medium text-foreground/90">{path.base}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{leaf.object}</span>
              )}
            </LiveLabel>
            {leaf.change && leaf.change.added + leaf.change.removed > 0 ? (
              <span className="shrink-0 text-xs tabular-nums">
                <DiffAwareText
                  text={` ${[leaf.change.added > 0 ? `+${leaf.change.added}` : "", leaf.change.removed > 0 ? `−${leaf.change.removed}` : ""].filter(Boolean).join(" ")}`}
                />
              </span>
            ) : null}
            {leaf.failed ? <span className="shrink-0 text-xs text-destructive">failed</span> : null}
          </span>
          <GrowingBox animate={ctx.arrivals}>
            {leaf.intent ? (
              <span className="block truncate text-xs leading-5 text-muted-foreground/90">
                {leaf.intent}
              </span>
            ) : null}
            {leaf.todo?.current ? (
              <span className="block truncate text-xs leading-5 text-muted-foreground/90">
                Next: {leaf.todo.current}
              </span>
            ) : null}
          </GrowingBox>
        </span>
        <span className="mt-px w-12 shrink-0 text-right text-xs leading-5 text-muted-foreground/70 tabular-nums">
          {formatDuration(leaf.elapsedMs)}
        </span>
      </div>
      {expandable ? (
        <Collapsible open={open} appear={ctx.arrivals}>
          <div className="ms-[26px] pb-1.5">
            <GrowingBox animate={ctx.arrivals}>
              {leaf.code ? (
                <CodeExcerpt
                  text={leaf.code.text}
                  diff={leaf.code.language === "diff"}
                  live={live}
                />
              ) : leaf.output ? (
                <OutputExcerpt text={leaf.output} />
              ) : null}
            </GrowingBox>
          </div>
        </Collapsible>
      ) : null}
      {leaf.subagents.length > 0 ? (
        <Branch ctx={ctx} className="ms-[7px] border-s border-border/70 ps-3.5">
          {leaf.subagents.map((agent) => (
            <Collapsible key={agent.id} open appear={ctx.arrivals}>
              <SubagentRow agent={agent} ctx={ctx} />
            </Collapsible>
          ))}
        </Branch>
      ) : null}
    </div>
  );
}

const EXCERPT_LINES = 10;

function CodeExcerpt(props: {
  readonly text: string;
  readonly diff: boolean;
  readonly live: boolean;
}) {
  const lines = props.text.replace(/\n$/, "").split("\n");
  // While the code is still being written, follow its newest lines.
  const shown = props.live ? lines.slice(-EXCERPT_LINES) : lines.slice(0, EXCERPT_LINES * 2);
  const firstNumber = props.live ? Math.max(0, lines.length - EXCERPT_LINES) : 0;
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-muted/30">
      <pre className="max-h-[16.5rem] overflow-auto px-0 py-1.5 font-mono text-[0.75rem] leading-[1.35rem]">
        {shown.map((line, index) => {
          const tone = props.diff
            ? line.startsWith("+")
              ? "bg-diff-addition/10 text-diff-addition"
              : line.startsWith("-")
                ? "bg-diff-deletion/10 text-diff-deletion"
                : "text-foreground/75"
            : "text-foreground/85";
          return (
            <div
              // Lines are positional within a snapshot of the file.
              // eslint-disable-next-line react/no-array-index-key
              key={firstNumber + index}
              className={cn("flex min-w-0 gap-3 px-3", tone)}
            >
              {props.diff ? null : (
                <span className="w-6 shrink-0 text-right text-muted-foreground/50 select-none">
                  {firstNumber + index + 1}
                </span>
              )}
              <span className="whitespace-pre">
                {line}
                {props.live && index === shown.length - 1 ? <span className="wl-caret" /> : null}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function OutputExcerpt(props: { readonly text: string }) {
  const lines = props.text.trimEnd().split("\n");
  const shown = lines.slice(-6);
  return (
    <pre className="max-h-40 overflow-auto rounded-md bg-muted/30 px-3 py-1.5 font-mono text-[0.6875rem] leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
      {lines.length > shown.length ? (
        <span className="text-muted-foreground/60">
          … {lines.length - shown.length} lines above{"\n"}
        </span>
      ) : null}
      {shown.join("\n")}
    </pre>
  );
}

function ThoughtRow(props: { readonly leaf: ThoughtLeaf; readonly ctx: TreeContext }) {
  const { leaf, ctx } = props;
  const open = isOpen(ctx, leaf.id, ctx.keptOpen.has(leaf.id));
  const expandable = leaf.text.length > 0;
  const label = leaf.live ? "Thinking" : `Thought for ${formatDuration(leaf.elapsedMs)}`;
  return (
    <div data-wl-row={leaf.id} className="min-w-0">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => ctx.onToggle(leaf.id, !open)}
        className={cn(
          "-mx-1.5 flex min-h-10 w-[calc(100%+0.75rem)] min-w-0 items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left",
          expandable && "transition-colors hover:bg-accent/40",
        )}
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <Brain aria-hidden className="size-3.5 text-muted-foreground/80" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm leading-5 text-foreground/70">
            <LiveLabel live={leaf.live}>{label}</LiveLabel>
          </span>
          {leaf.title ? (
            <span className="truncate text-xs leading-5 text-muted-foreground italic">
              {leaf.title}
            </span>
          ) : null}
        </span>
      </button>
      {expandable ? (
        <Collapsible open={open} appear={ctx.arrivals}>
          <div className="pb-1.5">
            <GrowingBox animate={ctx.arrivals}>
              <p
                className={cn(
                  "ms-[26px] line-clamp-6 text-xs leading-5 whitespace-pre-wrap text-muted-foreground italic",
                  ctx.layout === "tree" && "border-s-2 border-border/60 ps-3",
                )}
              >
                {leaf.text}
              </p>
            </GrowingBox>
          </div>
        </Collapsible>
      ) : null}
    </div>
  );
}

function SubagentRow(props: { readonly agent: SubagentNode; readonly ctx: TreeContext }) {
  const { agent, ctx } = props;
  const id = `agent-${agent.id}`;
  // Minimal+ follows a running subagent's own tree; Minimal shows its newest step.
  const open = isOpen(ctx, id, ctx.look === "minimal-plus" && agent.live);
  const summary = `${agent.actionCount} ${agent.actionCount === 1 ? "action" : "actions"}`;
  return (
    <div data-wl-row={id} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ctx.onToggle(id, !open)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.8125rem] leading-6 transition-colors hover:bg-accent/40"
      >
        <Chevron open={open} />
        <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground/80">
          <LiveLabel live={agent.live}>
            <span className="font-medium">{agent.name}</span>
            <span className="text-muted-foreground">
              {" "}
              · {agent.live ? "working" : "done"} · {summary}
            </span>
          </LiveLabel>
        </span>
        <span className="w-12 shrink-0 text-right text-xs text-muted-foreground/80 tabular-nums">
          {formatDuration(agent.elapsedMs)}
        </span>
      </button>
      {agent.latest ? (
        <Collapsible open={!open && agent.live} appear={ctx.arrivals}>
          <div
            className={cn(
              "flex min-w-0 items-center gap-2 pb-1 text-xs leading-5 text-muted-foreground",
              ctx.layout === "tree" ? "ms-[22px]" : "ms-[42px]",
            )}
          >
            {ctx.layout === "tree" ? <span className="text-muted-foreground/50">└</span> : null}
            <LiveLabel live>
              {agent.latest.verb} {agent.latest.object}
            </LiveLabel>
          </div>
        </Collapsible>
      ) : null}
      <Collapsible open={open}>
        <Branch ctx={ctx} className="ms-[6px] border-s border-dashed border-border/70 ps-3.5">
          <ChildList
            nodes={agent.children}
            ctx={{ ...ctx, keptOpen: agent.live ? ctx.keptOpen : new Set() }}
          />
        </Branch>
      </Collapsible>
    </div>
  );
}
