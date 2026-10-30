import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { NativeTodoTask } from "./todoPlan";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
} from "lucide-react";
import { use, useId, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { AsciiLoader } from "../ui/ascii-loader";
import { ActivityDisclosurePanel, useActivityDisclosure } from "./ActivityDisclosure";
import { TranscriptStyleCtx } from "./transcriptStyle";
import { nativeTodoPlanTasks, readNativeTodoPlan } from "./todoPlan";
import { useChangedSinceMount } from "~/lib/motion";

/**
 * The turn's to-dos, docked under its prompt like Cursor's: a header counting
 * completed items, then one row per task. Open while the run works; folded
 * once it settles, unless the reader opened it.
 */
export function CursorTodoPanel(props: {
  readonly plan: OrchestrationV2ProjectedTurnItem;
  readonly live: boolean;
  readonly disclosureCache: Set<string>;
}) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const disclosure = useActivityDisclosure({
    cache: props.disclosureCache,
    // Each todo update is a new plan item; keying by the run (as NativeTodoPane
    // does) keeps the reader's open/closed choice across updates.
    disclosureKey: `turn-todos:${props.plan.item.runId ?? props.plan.item.id}`,
    defaultOpen: props.live,
  });
  const rowsId = useId();
  const todoPlan = useMemo(() => readNativeTodoPlan(props.plan.item), [props.plan.item]);
  const tasks = useMemo(() => (todoPlan === null ? [] : nativeTodoPlanTasks(todoPlan)), [todoPlan]);
  // Items the plan gains after this panel mounted rise in; history stays still.
  const [mountedTaskCount] = useState(tasks.length);
  if (tasks.length === 0) return null;
  let completed = 0;
  for (const task of tasks) if (task.status === "completed") completed += 1;
  return (
    <div
      className="cursor-todo-panel"
      data-turn-todos
      data-terminal-todos={isTerminal ? "true" : undefined}
    >
      {isTerminal ? (
        <div className="cursor-todo-header">
          <span>
            {completed} of {tasks.length} To-dos Completed
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="cursor-todo-header"
          aria-expanded={disclosure.open}
          aria-controls={rowsId}
          onClick={disclosure.toggle}
        >
          <ChevronDownIcon data-chevron className="size-3.5" aria-hidden />
          <span>
            {completed} of {tasks.length} To-dos Completed
          </span>
        </button>
      )}
      <ActivityDisclosurePanel
        open={isTerminal || disclosure.open}
        instant={isTerminal || disclosure.instant}
        id={rowsId}
      >
        <CursorTodoRows
          tasks={tasks}
          live={props.live}
          mountedTaskCount={mountedTaskCount}
          terminalStyle={isTerminal}
        />
      </ActivityDisclosurePanel>
    </div>
  );
}

export function CursorTodoRows({
  ariaLabel,
  live,
  mountedTaskCount,
  tasks,
  terminalStyle,
}: {
  readonly ariaLabel?: string;
  readonly live: boolean;
  readonly mountedTaskCount: number;
  readonly tasks: readonly NativeTodoTask[];
  readonly terminalStyle?: boolean;
}) {
  const transcriptStyle = use(TranscriptStyleCtx);
  const isTerminal = terminalStyle ?? transcriptStyle === "terminal";
  const taskOccurrences = new Map<string, number>();
  return (
    <ul className="cursor-todo-rows" aria-label={ariaLabel}>
      {tasks.map((task, index) => {
        const occurrence = taskOccurrences.get(task.content) ?? 0;
        taskOccurrences.set(task.content, occurrence + 1);
        return (
          <CursorTodoRow
            key={`${task.content.length}:${task.content}:${occurrence}`}
            task={task}
            live={live}
            entering={live && index >= mountedTaskCount}
            isTerminal={isTerminal}
          />
        );
      })}
    </ul>
  );
}

function CursorTodoRow({
  task,
  live,
  entering,
  isTerminal,
}: {
  readonly task: NativeTodoTask;
  readonly live: boolean;
  readonly entering: boolean;
  readonly isTerminal: boolean;
}) {
  const mark =
    task.status === "completed"
      ? "done"
      : task.status === "current" && live
        ? "working"
        : task.status === "abandoned"
          ? "dropped"
          : task.status === "blocked"
            ? "stopped"
            : "open";
  const markChanged = useChangedSinceMount(mark);
  // Only finished work is struck; a dropped task reads as dropped, not done.
  const struck = task.status === "completed";
  return (
    <li
      className={cn("cursor-todo-row motion-tint", entering && "motion-enter")}
      data-status={task.status}
      data-terminal-todo-row={isTerminal ? "true" : undefined}
    >
      <span key={mark} className={cn("cursor-todo-mark", markChanged && "motion-swap")} aria-hidden>
        {isTerminal ? (
          mark === "done" ? (
            <span className="terminal-todo-done">☑</span>
          ) : mark === "dropped" ? (
            <span className="terminal-todo-dropped">☒</span>
          ) : (
            <span className="terminal-todo-open">☐</span>
          )
        ) : mark === "done" ? (
          <CircleCheckIcon className="size-3.5" />
        ) : mark === "working" ? (
          <AsciiLoader />
        ) : mark === "dropped" ? (
          <CircleXIcon className="size-3.5" />
        ) : mark === "stopped" ? (
          <CircleSlashIcon className="size-3.5" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0">
        <span className="sr-only">{task.status}: </span>
        <span className="motion-strike" data-struck={struck ? "" : undefined}>
          {task.content}
        </span>
      </span>
    </li>
  );
}
