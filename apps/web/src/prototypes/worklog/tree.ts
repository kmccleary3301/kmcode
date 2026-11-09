// PROTOTYPE: throwaway work-log tree demo. Not production code.
//
// Derives the proposed work tree from a trace at time `t`. It only looks at
// events that have started by `t`, the way a live client would, so the tree
// at any instant matches what the user would have seen then.
import {
  deriveToolVerbObject,
  formatDiffStats,
  toolVerb,
} from "@t3tools/client-runtime/work-log/presentation";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import {
  streamedPrefix,
  toolPhase,
  type AnyTraceEvent,
  type Trace,
  type TraceSubagentToolEvent,
  type TraceTextEvent,
  type TraceToolEvent,
  isToolEvent,
} from "./trace";

export type TranscriptLook = "minimal" | "minimal-plus";

export type Category = "explore" | "run" | "change" | "delegate" | "plan" | "other";

export type ActionPhase = "streaming" | "running" | "done";

export interface FileChange {
  readonly path: string;
  readonly op: "created" | "edited" | "deleted";
  readonly added: number;
  readonly removed: number;
}

export interface ActionLeaf {
  readonly kind: "action";
  readonly id: string;
  readonly event: TraceSubagentToolEvent;
  readonly phase: ActionPhase;
  readonly failed: boolean;
  readonly category: Category;
  readonly verb: string;
  readonly object: string;
  readonly objectIsPath: boolean;
  readonly intent: string | null;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly change: FileChange | null;
  /** Streaming file content or patch while the call is written, the result after. */
  readonly code: { readonly text: string; readonly language: "diff" | "text" } | null;
  readonly output: string | null;
  readonly subagents: ReadonlyArray<SubagentNode>;
  readonly todo: TodoProgress | null;
}

export interface ThoughtLeaf {
  readonly kind: "thought";
  readonly id: string;
  readonly startedAt: number;
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly title: string | null;
  readonly text: string;
}

export type Leaf = ActionLeaf | ThoughtLeaf;

/** A run of two or more same-kind steps inside a phase ("Explored 5 files"). */
export interface GroupNode {
  readonly kind: "group";
  readonly id: string;
  readonly category: Category;
  readonly leaves: ReadonlyArray<Leaf>;
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly label: string;
  readonly diff: string;
  readonly actionCount: number;
}

export interface NoteNode {
  readonly kind: "note";
  readonly id: string;
  readonly text: string;
  readonly live: boolean;
}

export type PhaseItem = GroupNode | Leaf | NoteNode;

/**
 * One stretch of the turn: the work done under one plan item when the agent
 * keeps a todo list, otherwise the work between two pieces of narration.
 */
export interface PhaseNode {
  readonly kind: "phase";
  readonly id: string;
  /** The plan item being worked on, or a summary of the work when there is none. */
  readonly title: string;
  /** What the phase did, when the title is a plan item. */
  readonly summary: string;
  readonly planned: boolean;
  /** The plan marked this phase's item complete. */
  readonly checked: boolean;
  readonly items: ReadonlyArray<PhaseItem>;
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly diff: string;
  readonly actionCount: number;
}

export type TreeChild = PhaseNode | NoteNode;

export interface SubagentNode {
  readonly id: string;
  readonly name: string;
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly children: ReadonlyArray<TreeChild>;
  readonly actionCount: number;
  readonly latest: ActionLeaf | null;
}

export interface TodoProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string | null;
}

export interface WorkTreeModel {
  readonly started: boolean;
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly children: ReadonlyArray<TreeChild>;
  readonly actionCount: number;
  readonly subagentActionCount: number;
  readonly subagentCount: number;
  readonly changes: ReadonlyArray<FileChange>;
  readonly todo: TodoProgress | null;
  readonly goal: string | null;
  readonly title: string;
  readonly meta: ReadonlyArray<string>;
  readonly finalAnswer: { readonly text: string; readonly streaming: boolean } | null;
}

const CATEGORY_BY_TOOL: Record<string, Category> = {
  read: "explore",
  grep: "explore",
  find: "explore",
  glob: "explore",
  web_search: "explore",
  ls: "explore",
  bash: "run",
  eval: "run",
  write: "change",
  edit: "change",
  ast_edit: "change",
  task: "delegate",
  wait: "delegate",
  hub: "delegate",
  todo: "plan",
  goal: "plan",
};

function categoryOf(name: string): Category {
  return CATEGORY_BY_TOOL[name] ?? "other";
}

function stringField(record: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function patchPath(input: string | null): string | null {
  if (input === null) return null;
  const match = /\[([^\]\n#]+)#[0-9A-Fa-f]{4}\]/.exec(input);
  return match?.[1] ?? null;
}

function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

function fileChangeOf(event: TraceSubagentToolEvent, phase: ActionPhase): FileChange | null {
  if (event.isError) return null;
  if (event.name === "write") {
    const path = stringField(event.args, "path");
    const content = stringField(event.args, "content") ?? "";
    if (path === null || path.startsWith("xd://")) return null;
    return { path, op: "created", added: lineCount(content), removed: 0 };
  }
  if (event.name === "edit" || event.name === "ast_edit") {
    const path = stringField(event.details, "path") ?? patchPath(stringField(event.args, "input"));
    if (path === null) return null;
    if (phase !== "done") return { path, op: "edited", added: 0, removed: 0 };
    const op = stringField(event.details, "op");
    if (op === "delete") return { path, op: "deleted", added: 0, removed: 0 };
    const counts = countDiff(stringField(event.details, "diff") ?? "");
    return { path, op: op === "create" ? "created" : "edited", ...counts };
  }
  return null;
}

function readTodo(details: Readonly<Record<string, unknown>> | null): TodoProgress | null {
  const phases = details?.["phases"];
  if (!Array.isArray(phases)) return null;
  let done = 0;
  let total = 0;
  let current: string | null = null;
  for (const phase of phases) {
    if (typeof phase !== "object" || phase === null || !("tasks" in phase)) continue;
    const tasks = phase.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if (typeof task !== "object" || task === null) continue;
      total += 1;
      const status = "status" in task ? task.status : null;
      const content = "content" in task && typeof task.content === "string" ? task.content : null;
      if (status === "completed") done += 1;
      else if (status === "in_progress" && current === null) current = content;
    }
  }
  return total === 0 ? null : { done, total, current };
}

function describeAction(
  event: TraceSubagentToolEvent,
  running: boolean,
): { verb: string; object: string; objectIsPath: boolean } {
  if (event.name === "goal") {
    const op = stringField(event.args, "op");
    const verb =
      op === "create"
        ? running
          ? "Setting goal"
          : "Set goal"
        : op === "complete"
          ? running
            ? "Completing goal"
            : "Completed goal"
          : running
            ? "Checking goal"
            : "Checked goal";
    return { verb, object: stringField(event.args, "objective") ?? "", objectIsPath: false };
  }
  if (event.name === "todo") {
    const progress = readTodo(event.details);
    return {
      verb: running ? "Updating plan" : "Updated plan",
      object: progress === null ? "" : `${progress.done}/${progress.total} done`,
      objectIsPath: false,
    };
  }
  if (event.name === "edit") {
    const path = stringField(event.details, "path") ?? patchPath(stringField(event.args, "input"));
    const op = stringField(event.details, "op");
    const verb =
      op === "delete" ? (running ? "Deleting" : "Deleted") : toolVerb(event.name, running);
    return { verb, object: path ?? "", objectIsPath: path !== null };
  }
  const described = deriveToolVerbObject({ toolName: event.name, args: event.args, running });
  return { verb: described.verb, object: described.object, objectIsPath: described.objectIsPath };
}

function actionCode(
  event: TraceSubagentToolEvent,
  phase: ActionPhase,
  t: number,
): ActionLeaf["code"] {
  if (event.name === "write") {
    const content = stringField(event.args, "content");
    if (content === null) return null;
    return { text: streamedPrefix(content, t, event.start, event.argsEnd), language: "text" };
  }
  if (event.name === "edit" || event.name === "ast_edit") {
    const diff = stringField(event.details, "diff");
    if (phase === "done" && diff !== null) return { text: diff, language: "diff" };
    const input = stringField(event.args, "input");
    if (input === null) return null;
    const body = input
      .split("\n")
      .filter((line) => !line.startsWith("***"))
      .join("\n");
    return { text: streamedPrefix(body, t, event.start, event.argsEnd), language: "diff" };
  }
  return null;
}

function buildAction(event: TraceSubagentToolEvent | TraceToolEvent, t: number): ActionLeaf {
  const rawPhase = toolPhase(event, t);
  const phase: ActionPhase = rawPhase === "absent" ? "streaming" : rawPhase;
  const running = phase !== "done";
  const described = describeAction(event, running);
  const spawned = "subagents" in event ? (event.subagents ?? []) : [];
  const subagents =
    phase === "done"
      ? spawned.flatMap((subagent) =>
          subagent.start <= t ? [buildSubagent(subagent.id, subagent.events, subagent.end, t)] : [],
        )
      : [];
  return {
    kind: "action",
    id: event.id,
    event,
    phase,
    failed: phase === "done" && event.isError,
    category: categoryOf(event.name),
    ...described,
    intent: event.intent,
    startedAt: event.start,
    elapsedMs: Math.max(0, Math.min(t, event.end) - event.start),
    change: fileChangeOf(event, phase),
    code: actionCode(event, phase, t),
    output: phase === "done" ? event.output : null,
    subagents,
    todo: event.name === "todo" && phase === "done" ? readTodo(event.details) : null,
  };
}

function buildThought(event: TraceTextEvent, t: number): ThoughtLeaf {
  const live = t < event.end;
  const text = streamedPrefix(event.text, t, event.start, event.end);
  const titleMatch = /^\*\*(.+?)\*\*/.exec(text.trim());
  const title = titleMatch?.[1] ?? null;
  const body = (titleMatch ? text.trim().slice(titleMatch[0].length) : text)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
  return {
    kind: "thought",
    id: event.id,
    startedAt: event.start,
    live,
    elapsedMs: Math.max(0, Math.min(t, event.end) - event.start),
    title,
    text: body,
  };
}

function segmentLabel(category: Category, leaves: ReadonlyArray<Leaf>, live: boolean): string {
  const actions = leaves.filter((leaf): leaf is ActionLeaf => leaf.kind === "action");
  const count = (predicate: (leaf: ActionLeaf) => boolean) => actions.filter(predicate).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  switch (category) {
    case "explore": {
      const parts: string[] = [];
      const pages = count((leaf) => leaf.event.name === "read" && /^https?:/.test(leaf.object));
      const files = count((leaf) => leaf.event.name === "read") - pages;
      const searches = count((leaf) => ["grep", "find", "glob", "ls"].includes(leaf.event.name));
      const web = count((leaf) => leaf.event.name === "web_search");
      if (files > 0) parts.push(plural(files, "file", "files"));
      if (pages > 0) parts.push(plural(pages, "page", "pages"));
      if (searches > 0) parts.push(plural(searches, "search", "searches"));
      if (web > 0) parts.push(plural(web, "web search", "web searches"));
      return `${live ? "Exploring" : "Explored"} ${parts.join(", ")}`;
    }
    case "run": {
      const parts: string[] = [];
      const commands = count((leaf) => leaf.event.name === "bash");
      const evals = count((leaf) => leaf.event.name === "eval");
      if (commands > 0) parts.push(plural(commands, "command", "commands"));
      if (evals > 0) parts.push(plural(evals, "eval cell", "eval cells"));
      return `${live ? "Running" : "Ran"} ${parts.join(", ")}`;
    }
    case "change": {
      const files = new Set(actions.flatMap((leaf) => (leaf.change ? [leaf.change.path] : [])));
      return `${live ? "Changing" : "Changed"} ${plural(files.size, "file", "files")}`;
    }
    case "delegate": {
      const parts: string[] = [];
      const tasks = actions.filter((leaf) => leaf.event.name === "task");
      const names = tasks.flatMap((leaf) => leaf.subagents.map((agent) => agent.name));
      if (names.length > 0) {
        parts.push(`${live ? "delegating to" : "delegated to"} ${names.join(", ")}`);
      } else if (tasks.length > 0) {
        parts.push(`${live ? "delegating" : "delegated"} ${plural(tasks.length, "task", "tasks")}`);
      }
      if (count((leaf) => leaf.event.name === "wait") > 0) {
        parts.push(live ? "waiting for agents" : "waited for agents");
      }
      const hubs = actions.filter((leaf) => leaf.event.name === "hub");
      if (hubs.length > 0) {
        const stopping = hubs.some((leaf) => stringField(leaf.event.args, "op") === "cancel");
        parts.push(stopping ? (live ? "stopping agents" : "stopped agents") : "messaged agents");
      }
      const text = parts.join(", ");
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case "plan": {
      const goal = actions.find((leaf) => leaf.event.name === "goal");
      if (goal !== undefined && actions.length === 1) return goal.verb;
      const todo = actions.findLast((leaf) => leaf.todo !== null)?.todo;
      return todo
        ? `Plan ${todo.done}/${todo.total} done`
        : live
          ? "Updating plan"
          : "Updated plan";
    }
    case "other":
      return `${live ? "Using" : "Used"} ${actions.map((leaf) => leaf.event.name).join(", ")}`;
  }
}

function summarizeChanges(changes: ReadonlyArray<FileChange>): ReadonlyArray<FileChange> {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const previous = byPath.get(change.path);
    if (previous === undefined) {
      byPath.set(change.path, change);
      continue;
    }
    // A file created and later deleted in the same turn leaves no change.
    if (previous.op === "created" && change.op === "deleted") {
      byPath.delete(change.path);
      continue;
    }
    byPath.set(change.path, {
      path: change.path,
      op: change.op === "deleted" ? "deleted" : previous.op === "created" ? "created" : change.op,
      added: previous.added + change.added,
      removed: previous.removed + change.removed,
    });
  }
  return [...byPath.values()];
}

function changeDiff(leaves: ReadonlyArray<Leaf>): string {
  let added = 0;
  let removed = 0;
  for (const leaf of leaves) {
    if (leaf.kind !== "action" || leaf.change === null) continue;
    added += leaf.change.added;
    removed += leaf.change.removed;
  }
  return formatDiffStats({ added, removed });
}

interface BuildResult {
  readonly children: ReadonlyArray<TreeChild>;
  readonly actions: ReadonlyArray<ActionLeaf>;
  readonly trailingText: TraceTextEvent | null;
}

interface PhaseDraft {
  readonly kind: "draft";
  readonly id: string;
  /** The plan update this phase works under. */
  readonly opener: ActionLeaf | null;
  readonly entries: Array<Leaf | NoteNode>;
  closer: ActionLeaf | null;
}

const GROUPABLE: ReadonlySet<Category> = new Set(["explore", "run", "change"]);

function isAction(leaf: PhaseItem): leaf is ActionLeaf {
  return leaf.kind === "action";
}

export function itemRunning(item: PhaseItem): boolean {
  switch (item.kind) {
    case "action":
      return item.phase !== "done" || item.subagents.some((agent) => agent.live);
    case "thought":
    case "note":
      return item.live;
    case "group":
      return item.leaves.some(itemRunning);
  }
}

function itemSpan(item: Leaf, t: number): { start: number; end: number } {
  return item.kind === "action"
    ? { start: item.startedAt, end: Math.min(t, item.event.end) }
    : { start: item.startedAt, end: item.startedAt + item.elapsedMs };
}

function spanOf(leaves: ReadonlyArray<Leaf>, t: number): number {
  if (leaves.length === 0) return 0;
  const spans = leaves.map((leaf) => itemSpan(leaf, t));
  return Math.max(
    0,
    Math.max(...spans.map((span) => span.end)) - Math.min(...spans.map((span) => span.start)),
  );
}

/**
 * Inside a phase, two or more same-kind steps in a row (reads, commands,
 * edits) fold into a group. Thoughts stay with the run they interrupt; the
 * ones that lead into a different kind of step move out with it.
 */
function groupEntries(
  entries: ReadonlyArray<Leaf | NoteNode>,
  phaseLive: boolean,
  t: number,
): PhaseItem[] {
  const items: PhaseItem[] = [];
  let run: { category: Category; leaves: Leaf[] } | null = null;
  const flushRun = () => {
    if (run === null) return;
    const runActions = run.leaves.filter(isAction);
    const first = run.leaves[0];
    if (runActions.length >= 2 && first !== undefined) {
      items.push({
        kind: "group",
        id: `group-${first.id}`,
        category: run.category,
        leaves: run.leaves,
        live: false,
        elapsedMs: spanOf(run.leaves, t),
        label: "",
        diff: run.category === "change" ? changeDiff(run.leaves) : "",
        actionCount: runActions.length,
      });
    } else {
      items.push(...run.leaves);
    }
    run = null;
  };
  for (const entry of entries) {
    if (entry.kind === "note") {
      flushRun();
      items.push(entry);
      continue;
    }
    if (entry.kind === "thought") {
      if (run === null) items.push(entry);
      else run.leaves.push(entry);
      continue;
    }
    if (run !== null && run.category === entry.category) {
      run.leaves.push(entry);
      continue;
    }
    const carried: Leaf[] = [];
    while (run !== null && run.leaves.at(-1)?.kind === "thought") {
      const leaf = run.leaves.pop();
      if (leaf !== undefined) carried.unshift(leaf);
    }
    flushRun();
    if (GROUPABLE.has(entry.category)) {
      run = { category: entry.category, leaves: [...carried, entry] };
    } else {
      items.push(...carried, entry);
    }
  }
  flushRun();
  // The newest group is where work happens between steps of a live phase.
  const lastIndex = items.length - 1;
  return items.map((item, index) => {
    if (item.kind !== "group") return item;
    const live = itemRunning(item) || (phaseLive && index === lastIndex);
    return { ...item, live, label: segmentLabel(item.category, item.leaves, live) };
  });
}

function joinSummaries(parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
    .join(" · ");
}

/** "Explored 3 pages, 6 web searches · ran 1 command" across a phase's steps. */
function phaseSummary(actions: ReadonlyArray<ActionLeaf>, live: boolean): string {
  const order: ReadonlyArray<Category> = ["explore", "run", "change", "delegate", "plan", "other"];
  return joinSummaries(
    order.flatMap((category) => {
      const matching = actions.filter((action) => action.category === category);
      return matching.length === 0 ? [] : [segmentLabel(category, matching, live)];
    }),
  );
}

function finalizePhase(draft: PhaseDraft, live: boolean, newest: boolean, t: number): PhaseNode {
  const leaves = draft.entries.filter((entry): entry is Leaf => entry.kind !== "note");
  const phaseActions = leaves.filter(isAction);
  const running = draft.entries.some(itemRunning);
  const phaseLive = live && (running || newest);
  const items = groupEntries(draft.entries, phaseLive, t);
  const planItem = draft.opener?.todo?.current ?? null;
  const closingTodo = draft.closer?.todo ?? null;
  // Todo updates are bookkeeping, so they stay out of the summary; goals do
  // not. Under a plan item the summary is a tally, so it reads in past tense.
  const summary = phaseSummary(
    phaseActions.filter((action) => action.event.name !== "todo"),
    planItem === null && phaseLive,
  );
  const fallback =
    summary ||
    (phaseActions.length > 0
      ? segmentLabel("plan", phaseActions, phaseLive)
      : phaseLive
        ? "Thinking"
        : "Thought");
  return {
    kind: "phase",
    id: draft.id,
    title: planItem ?? fallback,
    summary: planItem === null ? "" : summary,
    planned: planItem !== null,
    checked: planItem !== null && closingTodo !== null && closingTodo.current !== planItem,
    items,
    live: phaseLive,
    elapsedMs: spanOf(leaves, t),
    diff: changeDiff(leaves),
    actionCount: phaseActions.length,
  };
}

/**
 * Splits visible events into phases. With a todo list, each plan update that
 * moves to another item starts a phase titled by that item; without one,
 * narration between steps ends a phase and stands on its own.
 */
function buildChildren(
  events: ReadonlyArray<AnyTraceEvent>,
  t: number,
  live: boolean,
): BuildResult {
  const visible = events.filter((event) => event.start <= t).toSorted((a, b) => a.start - b.start);
  const lastToolStart = visible.reduce(
    (latest, event) => (event.kind === "tool" ? Math.max(latest, event.start) : latest),
    -Infinity,
  );
  const drafts: Array<PhaseDraft | NoteNode> = [];
  const actions: ActionLeaf[] = [];
  let phase: PhaseDraft | null = null;
  let planned = false;
  let lastPlan: ActionLeaf | null = null;
  let trailingText: TraceTextEvent | null = null;

  const openPhase = (id: string): PhaseDraft => {
    if (phase !== null) return phase;
    const opened: PhaseDraft = {
      kind: "draft",
      id: `phase-${id}`,
      opener: lastPlan,
      entries: [],
      closer: null,
    };
    phase = opened;
    return opened;
  };
  const closePhase = () => {
    if (phase !== null && phase.entries.length > 0) drafts.push(phase);
    phase = null;
  };

  for (const event of visible) {
    if (event.kind === "text") {
      // Text after the last action is the answer, not narration.
      if (event.start >= lastToolStart) {
        trailingText = event;
        continue;
      }
      const note: NoteNode = {
        kind: "note",
        id: event.id,
        text: streamedPrefix(event.text, t, event.start, event.end),
        live: t < event.end,
      };
      if (planned) {
        openPhase(event.id).entries.push(note);
      } else {
        closePhase();
        drafts.push(note);
      }
      continue;
    }
    if (event.kind === "thinking") {
      const thought = buildThought(event, t);
      // Encrypted reasoning has no text to show once it is over.
      if (!thought.live && thought.text.length === 0 && thought.title === null) continue;
      openPhase(event.id).entries.push(thought);
      continue;
    }
    if (!isToolEvent(event)) continue;
    const action = buildAction(event, t);
    actions.push(action);
    if (event.name === "todo") {
      if (!planned) {
        // The first plan opens the first planned phase.
        planned = true;
        closePhase();
        lastPlan = action;
        openPhase(action.id).entries.push(action);
        continue;
      }
      const current = openPhase(action.id);
      current.entries.push(action);
      // Moving to another plan item closes this phase; a plan edit that keeps
      // the same item in progress does not.
      const item = current.opener?.todo?.current ?? null;
      if (action.phase === "done" && action.todo !== null && action.todo.current !== item) {
        current.closer = action;
        lastPlan = action;
        closePhase();
      }
      continue;
    }
    openPhase(action.id).entries.push(action);
  }
  closePhase();

  const lastDraftIndex = drafts.findLastIndex((draft) => draft.kind === "draft");
  return {
    children: drafts.map((draft, index) =>
      draft.kind === "note" ? draft : finalizePhase(draft, live, index === lastDraftIndex, t),
    ),
    actions,
    trailingText,
  };
}

function buildSubagent(
  id: string,
  events: ReadonlyArray<AnyTraceEvent>,
  end: number,
  t: number,
): SubagentNode {
  const live = t < end;
  const start = events[0]?.start ?? end;
  const built = buildChildren(events, t, live);
  return {
    id,
    name: id,
    live,
    elapsedMs: Math.max(0, Math.min(t, end) - start),
    children: built.children,
    actionCount: built.actions.length,
    latest: built.actions.at(-1) ?? null,
  };
}

export function deriveWorkTree(trace: Trace, t: number): WorkTreeModel {
  const lastWorkEnd = trace.events.reduce(
    (latest, event) => (event.kind === "tool" ? Math.max(latest, event.end) : latest),
    trace.t0,
  );
  const lastToolStart = trace.events.reduce(
    (latest, event) => (event.kind === "tool" ? Math.max(latest, event.start) : latest),
    trace.t0,
  );
  // The answer is the text that follows the last action; the turn settles
  // once it starts or all work has ended.
  const answerStart =
    trace.events.find((event) => event.kind === "text" && event.start >= lastToolStart)?.start ??
    Infinity;
  const live = t < Math.min(lastWorkEnd, answerStart);
  const built = buildChildren(trace.events, t, live);
  const answer = built.trailingText;
  const workEnd = Math.min(t, answer?.start ?? lastWorkEnd);
  const elapsedMs = Math.max(0, workEnd - trace.t0);
  const children = built.children;
  const changes = summarizeChanges(
    built.actions.flatMap((action) => (action.change === null ? [] : [action.change])),
  );
  const subagents = built.actions.flatMap((action) => action.subagents);
  const subagentActionCount = subagents.reduce((sum, agent) => sum + agent.actionCount, 0);
  const todo = built.actions.findLast((action) => action.todo !== null)?.todo ?? null;
  // `goal get` carries no objective; the goal is the last one that was set.
  const goal =
    built.actions
      .filter((action) => action.event.name === "goal")
      .map((action) => stringField(action.event.args, "objective"))
      .findLast((objective) => objective !== null) ?? null;
  const actionCount = built.actions.length;
  const duration = formatDuration(elapsedMs);
  const title = live
    ? `Working for ${duration} · ${actionCount} ${actionCount === 1 ? "action" : "actions"} so far`
    : `Worked for ${duration} over ${actionCount} ${actionCount === 1 ? "action" : "actions"}`;
  return {
    started: t >= trace.t0,
    live,
    elapsedMs,
    children,
    actionCount,
    subagentActionCount,
    subagentCount: subagents.length,
    changes,
    todo,
    goal,
    title,
    meta: changeMeta(changes, subagents.length, subagentActionCount, todo),
    finalAnswer:
      answer === null
        ? null
        : {
            text: streamedPrefix(answer.text, t, answer.start, answer.end),
            streaming: t < answer.end,
          },
  };
}

function changeMeta(
  changes: ReadonlyArray<FileChange>,
  subagentCount: number,
  subagentActions: number,
  todo: TodoProgress | null,
): ReadonlyArray<string> {
  const parts: string[] = [];
  const created = changes.filter((change) => change.op === "created").length;
  const edited = changes.filter((change) => change.op === "edited").length;
  const deleted = changes.filter((change) => change.op === "deleted").length;
  const diff = formatDiffStats({
    added: changes.reduce((sum, change) => sum + change.added, 0),
    removed: changes.reduce((sum, change) => sum + change.removed, 0),
  });
  const ops = [
    { count: created, verb: "created" },
    { count: edited, verb: "edited" },
    { count: deleted, verb: "deleted" },
  ].filter((op) => op.count > 0);
  const total = created + edited + deleted;
  if (total > 0) {
    // One kind of change names it; a mix reads "changed".
    const verb = ops.length === 1 ? (ops[0]?.verb ?? "changed") : "changed";
    parts.push(`${total} ${total === 1 ? "file" : "files"} ${verb}${diff ? ` ${diff}` : ""}`);
  }
  if (subagentCount > 0) {
    parts.push(
      `${subagentCount} ${subagentCount === 1 ? "subagent" : "subagents"} · ${subagentActions} actions`,
    );
  }
  if (todo !== null) parts.push(`plan ${todo.done}/${todo.total}`);
  return parts;
}
