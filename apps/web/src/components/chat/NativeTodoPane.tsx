import { use, useId, useState } from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ActivityDisclosurePanel } from "./ActivityDisclosure";
import { useChangedSinceMount } from "~/lib/motion";
import { TranscriptStyleCtx } from "./transcriptStyle";
import type {
  NativeTodoPhase,
  NativeTodoPlan,
  NativeTodoTask,
  NativeTodoTaskStatus,
} from "./todoPlan";

const TASK_STATUS_LABEL: Record<NativeTodoTaskStatus, string> = {
  current: "Current",
  pending: "Pending",
  completed: "Completed",
  blocked: "Blocked",
  abandoned: "Abandoned",
};

const TASK_STATUS_MARK: Record<NativeTodoTaskStatus, string> = {
  current: "●",
  pending: "○",
  completed: "✓",
  blocked: "!",
  abandoned: "✕",
};

const TASK_STATUS_CLASS: Record<NativeTodoTaskStatus, string> = {
  current: "text-foreground",
  pending: "text-secondary-label",
  completed: "text-muted-foreground",
  blocked: "status-blocked-mark",
  abandoned: "status-failed-mark",
};

function countCompleted(tasks: ReadonlyArray<NativeTodoTask>): number {
  let count = 0;
  for (const task of tasks) {
    if (task.status === "completed") count += 1;
  }
  return count;
}

function taskRows(tasks: ReadonlyArray<NativeTodoTask>, keyPrefix: string) {
  return (
    <ul className="flex min-w-0 flex-col gap-1 py-1">
      {tasks.map((task, index) => (
        <NativeTodoRow key={`${keyPrefix}:${index}:${task.content}`} task={task} />
      ))}
    </ul>
  );
}

function NativeTodoRow({ task }: { readonly task: NativeTodoTask }) {
  // The mark re-enters and the line draws through only for changes seen live.
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const statusChanged = useChangedSinceMount(task.status);
  // Only finished work is struck; a dropped task reads as dropped, not done.
  const struck = task.status === "completed";
  return (
    <li
      className="flex min-w-0 items-start gap-2 px-1 text-xs leading-5"
      data-terminal-todo-row={isTerminal ? "true" : undefined}
      data-todo-status={task.status}
    >
      <span
        key={task.status}
        aria-hidden="true"
        className={cn(
          "mt-0.5 w-4 shrink-0 text-center font-medium",
          TASK_STATUS_CLASS[task.status],
          statusChanged && "motion-swap",
        )}
      >
        {isTerminal ? (
          task.status === "completed" ? (
            <span className="terminal-todo-done">☑</span>
          ) : task.status === "abandoned" ? (
            <span className="terminal-todo-dropped">☒</span>
          ) : (
            <span className="terminal-todo-open">☐</span>
          )
        ) : (
          TASK_STATUS_MARK[task.status]
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={cn(
              "motion-tint min-w-0 flex-1 break-words",
              task.status === "abandoned" || task.status === "blocked"
                ? TASK_STATUS_CLASS[task.status]
                : struck
                  ? "text-muted-foreground"
                  : "text-secondary-label",
            )}
          >
            <span className="motion-strike" data-struck={struck ? "" : undefined}>
              {task.content}
            </span>
          </span>
          <span className={cn("motion-tint shrink-0 text-2xs", TASK_STATUS_CLASS[task.status])}>
            {TASK_STATUS_LABEL[task.status]}
          </span>
        </div>
        {task.status === "blocked" && task.blocker ? (
          <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">{task.blocker}</p>
        ) : null}
      </div>
    </li>
  );
}

function phaseOccurrenceOrdinal(
  phases: ReadonlyArray<NativeTodoPhase>,
  phaseIndex: number,
): number {
  const targetName = phases[phaseIndex]?.name;
  let ordinal = 0;
  for (let i = 0; i < phaseIndex; i++) {
    if (phases[i]?.name === targetName) ordinal += 1;
  }
  return ordinal;
}

export function phaseDisclosureKey(
  plan: NativeTodoPlan,
  phaseName: string,
  occurrenceOrdinal = 0,
): string {
  return JSON.stringify(
    occurrenceOrdinal === 0
      ? ["native-todo", plan.key, phaseName]
      : ["native-todo", plan.key, phaseName, occurrenceOrdinal],
  );
}

export function NativeTodoPane({
  plan,
  disclosureCache,
}: {
  readonly plan: NativeTodoPlan;
  readonly disclosureCache?: Set<string>;
}) {
  const paneId = useId();
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const treeExpandedCacheKey = `native-todo-tree-expanded:${plan.key}`;
  const [treeOpen, setTreeOpen] = useState<boolean>(() => {
    return disclosureCache?.has(treeExpandedCacheKey) ?? false;
  });

  const [localOverrides, setLocalOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  let totalCount = 0;
  let completedCount = 0;
  const allTasks: NativeTodoTask[] = [];

  if (plan.kind === "flat") {
    totalCount = plan.tasks.length;
    completedCount = countCompleted(plan.tasks);
    allTasks.push(...plan.tasks);
  } else {
    for (const phase of plan.phases) {
      totalCount += phase.tasks.length;
      completedCount += countCompleted(phase.tasks);
      allTasks.push(...phase.tasks);
    }
  }

  // Derive walking window: last done (muted ✓), current (accent ring + semibold), next 2 pending, +N
  let currentIndex = allTasks.findIndex((task) => task.status === "current");
  if (currentIndex === -1) {
    currentIndex = allTasks.findIndex((task) => task.status === "pending");
  }
  if (currentIndex === -1) {
    currentIndex = allTasks.length > 0 ? allTasks.length - 1 : 0;
  }

  // Last done task
  let lastDone: NativeTodoTask | null = null;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const candidate = allTasks[i];
    if (candidate && candidate.status === "completed") {
      lastDone = candidate;
      break;
    }
  }

  const currentTask = allTasks[currentIndex] ?? null;

  // Next 2 pending tasks after current
  const pendingAfterCurrent: NativeTodoTask[] = [];
  let remainingPendingCount = 0;
  for (let i = currentIndex + 1; i < allTasks.length; i++) {
    const candidate = allTasks[i];
    if (candidate && (candidate.status === "pending" || candidate.status === "current")) {
      if (pendingAfterCurrent.length < 2) {
        pendingAfterCurrent.push(candidate);
      } else {
        remainingPendingCount += 1;
      }
    }
  }

  const toggleTree = () => {
    const nextValue = !treeOpen;
    if (disclosureCache) {
      if (nextValue) disclosureCache.add(treeExpandedCacheKey);
      else disclosureCache.delete(treeExpandedCacheKey);
    }
    setTreeOpen(nextValue);
  };

  const togglePhase = (expandedKey: string, collapsedKey: string, expanded: boolean) => {
    const nextValue = !expanded;
    if (disclosureCache !== undefined) {
      disclosureCache.delete(nextValue ? collapsedKey : expandedKey);
      disclosureCache.add(nextValue ? expandedKey : collapsedKey);
    }
    setLocalOverrides((current) => {
      const next = new Map(current);
      next.set(expandedKey, nextValue);
      return next;
    });
  };

  const explanation = plan.explanation;

  const planHeaderClassName = cn(
    "flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
    !isTerminal &&
      "hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
  );
  const planHeaderContent = (
    <>
      <span id={`${paneId}-heading`} className="shrink-0 font-semibold text-foreground">
        Plan {completedCount} / {totalCount}
      </span>

      {allTasks.length > 0 ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-2xs truncate">
          <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">
            ·
          </span>

          {lastDone ? (
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground truncate max-w-[10rem]">
              {isTerminal ? (
                <span className="terminal-todo-done" aria-hidden="true">
                  ☑
                </span>
              ) : (
                <CheckIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="truncate">{lastDone.content}</span>
            </span>
          ) : null}

          {currentTask && currentTask.status !== "completed" ? (
            <span className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground truncate max-w-[14rem]">
              {isTerminal ? (
                <span className="terminal-todo-current" aria-hidden="true">
                  ☐
                </span>
              ) : (
                <span
                  className="size-2 rounded-full bg-foreground ring-2 ring-foreground/40 shrink-0"
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{currentTask.content}</span>
            </span>
          ) : null}

          {pendingAfterCurrent.map((task, i) => (
            <span key={i} className="shrink-0 text-muted-foreground truncate max-w-[9rem]">
              {task.content}
            </span>
          ))}

          {remainingPendingCount > 0 ? (
            <span className="text-3xs font-medium text-muted-foreground shrink-0">
              +{remainingPendingCount}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-2xs text-muted-foreground truncate">No tasks</span>
      )}
    </>
  );

  const treeExpanded = isTerminal || treeOpen;

  return (
    <section
      aria-labelledby={`${paneId}-heading`}
      className="my-1 min-w-0 rounded-lg border border-border/60 bg-muted/20 overflow-hidden"
      data-native-todo-pane
      data-terminal-native-todo={isTerminal ? "true" : undefined}
    >
      {/* Compact plan strip per Rule 3 */}
      {isTerminal ? (
        <div className={planHeaderClassName}>{planHeaderContent}</div>
      ) : (
        <button
          type="button"
          onClick={toggleTree}
          aria-expanded={treeOpen}
          aria-controls={`${paneId}-tree`}
          className={planHeaderClassName}
        >
          {planHeaderContent}
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "motion-chevron size-3.5 shrink-0 text-muted-foreground ml-auto",
              treeOpen && "rotate-90",
            )}
          />
        </button>
      )}

      {/* Full phased tree opened */}
      <ActivityDisclosurePanel open={treeExpanded} id={`${paneId}-tree`}>
        <div className="border-t border-border/40 px-3 py-2 text-xs">
          {explanation?.trim() ? (
            <p className="mb-2 text-xs leading-5 text-secondary-label">{explanation}</p>
          ) : null}

          {plan.kind === "flat" ? (
            plan.tasks.length > 0 ? (
              taskRows(plan.tasks, plan.key)
            ) : (
              <p className="py-1 text-xs text-muted-foreground">No tasks reported.</p>
            )
          ) : plan.phases.length > 0 ? (
            <ul className="flex min-w-0 flex-col">
              {plan.phases.map((phase, index) => {
                const occurrenceOrdinal = phaseOccurrenceOrdinal(plan.phases, index);
                const key = phaseDisclosureKey(plan, phase.name, occurrenceOrdinal);
                const expandedKey = `native-todo-expanded:${key}`;
                const collapsedKey = `native-todo-collapsed:${key}`;
                const isCurrent = phase.tasks.some((task) => task.status === "current");
                const expanded =
                  isTerminal ||
                  (localOverrides.get(expandedKey) ??
                    (disclosureCache?.has(expandedKey) ||
                      (!disclosureCache?.has(collapsedKey) && isCurrent)));
                const bodyId = `${paneId}-phase-${index}`;
                const phaseSummary = (
                  <>
                    <span className="min-w-0 flex-1 break-words text-xs font-medium text-secondary-label">
                      {phase.name}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {countCompleted(phase.tasks)}/{phase.tasks.length} complete
                    </span>
                  </>
                );
                return (
                  <li
                    key={`${phase.name}:${index}`}
                    className="min-w-0 border-t border-border/30 first:border-t-0"
                  >
                    {isTerminal ? (
                      <div className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left">
                        {phaseSummary}
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-controls={bodyId}
                        aria-expanded={expanded}
                        className={cn(
                          "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                        )}
                        onClick={() => togglePhase(expandedKey, collapsedKey, expanded)}
                      >
                        <ChevronRightIcon
                          aria-hidden="true"
                          className={cn(
                            "motion-chevron size-3.5 shrink-0 text-muted-foreground",
                            expanded && "rotate-90",
                          )}
                        />
                        {phaseSummary}
                      </button>
                    )}
                    <ActivityDisclosurePanel open={expanded} id={bodyId}>
                      {taskRows(phase.tasks, `${plan.key}:${index}`)}
                    </ActivityDisclosurePanel>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-1 text-xs text-muted-foreground">No tasks reported.</p>
          )}
        </div>
      </ActivityDisclosurePanel>
    </section>
  );
}
