import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export type NativeTodoTaskStatus = "current" | "pending" | "completed" | "blocked" | "abandoned";

export interface NativeTodoTask {
  readonly content: string;
  readonly status: NativeTodoTaskStatus;
  readonly blocker?: string;
}

export interface NativeTodoPhase {
  readonly name: string;
  readonly tasks: ReadonlyArray<NativeTodoTask>;
}

export interface NativeTodoPlan {
  /** Stable across updates to one canonical plan or native tool result. */
  readonly key: string;
  readonly kind: "flat" | "phased";
  readonly explanation?: string;
  readonly tasks: ReadonlyArray<NativeTodoTask>;
  readonly phases: ReadonlyArray<NativeTodoPhase>;
}

function nativeTaskStatus(status: unknown): NativeTodoTaskStatus | null {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "current";
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "abandoned":
      return "abandoned";
    default:
      return null;
  }
}

function readNativePhases(details: unknown): ReadonlyArray<NativeTodoPhase> | null {
  if (
    typeof details !== "object" ||
    details === null ||
    Array.isArray(details) ||
    !("phases" in details) ||
    !Array.isArray(details.phases)
  ) {
    return null;
  }

  const phaseValues: ReadonlyArray<unknown> = details.phases;
  const phases: NativeTodoPhase[] = [];
  for (const phaseValue of phaseValues) {
    if (
      typeof phaseValue !== "object" ||
      phaseValue === null ||
      Array.isArray(phaseValue) ||
      !("name" in phaseValue) ||
      typeof phaseValue.name !== "string" ||
      !("tasks" in phaseValue) ||
      !Array.isArray(phaseValue.tasks)
    ) {
      return null;
    }

    const taskValues: ReadonlyArray<unknown> = phaseValue.tasks;
    const tasks: NativeTodoTask[] = [];
    for (const taskValue of taskValues) {
      if (
        typeof taskValue !== "object" ||
        taskValue === null ||
        Array.isArray(taskValue) ||
        !("content" in taskValue) ||
        typeof taskValue.content !== "string" ||
        !("status" in taskValue)
      ) {
        return null;
      }

      const status = nativeTaskStatus(taskValue.status);
      if (status === null) return null;

      const blocker =
        "blocker" in taskValue && typeof taskValue.blocker === "string"
          ? taskValue.blocker
          : undefined;

      tasks.push({
        content: taskValue.content,
        status,
        ...(blocker === undefined ? {} : { blocker }),
      });
    }

    phases.push({
      name: phaseValue.name,
      tasks,
    });
  }

  return phases;
}

/** Read only reported plan snapshots; a tool request alone never changes displayed state. */
export function readNativeTodoPlan(item: OrchestrationV2TurnItem): NativeTodoPlan | null {
  if (item.type === "todo_list") {
    return {
      key: JSON.stringify(["todo-list", item.threadId, item.planId]),
      kind: "flat",
      ...(item.explanation === undefined ? {} : { explanation: item.explanation }),
      tasks: item.steps.map((step) => ({
        content: step.text,
        status: step.status === "running" ? "current" : step.status,
      })),
      phases: [],
    };
  }

  if (item.type !== "dynamic_tool" || item.toolName?.toLowerCase() !== "todo") return null;
  if (!("details" in item)) return null;
  const phases = readNativePhases(item.details);
  if (phases === null) return null;

  return {
    // Keyed by run, not call: each todo update replaces the strip, and the
    // reader's phase choices must survive that.
    key: JSON.stringify(["native-todo", item.threadId, item.runId ?? item.id]),
    kind: "phased",
    tasks: [],
    phases,
  };
}

export function nativeTodoPlanTasks(plan: NativeTodoPlan): ReadonlyArray<NativeTodoTask> {
  if (plan.kind !== "phased") return plan.tasks;
  const tasks: NativeTodoTask[] = [];
  for (const phase of plan.phases) {
    for (const task of phase.tasks) tasks.push(task);
  }
  return tasks;
}

/** One thing a todo update did to the list, as the timeline reports it. */
export type TodoPlanChange =
  | { readonly kind: "planned"; readonly count: number }
  | { readonly kind: "added" | "completed" | "dropped"; readonly content: string }
  | { readonly kind: "blocked"; readonly content: string; readonly blocker?: string };

/** Tasks keyed by content and occurrence, so repeated titles stay distinct. */
function keyedTasks(tasks: ReadonlyArray<NativeTodoTask>): Map<string, NativeTodoTask> {
  const keyed = new Map<string, NativeTodoTask>();
  const occurrences = new Map<string, number>();
  for (const task of tasks) {
    const occurrence = occurrences.get(task.content) ?? 0;
    occurrences.set(task.content, occurrence + 1);
    keyed.set(`${occurrence}:${task.content}`, task);
  }
  return keyed;
}

/**
 * What one update did to the list before it, in list order. A turn's first
 * plan reads as one "planned" line. Starting or unblocking a task is left
 * out: the steps after it show that work. A task that leaves the list
 * unfinished was dropped; one that leaves finished was only tidied away.
 */
export function todoPlanChanges(
  previous: NativeTodoPlan | null,
  next: NativeTodoPlan,
): ReadonlyArray<TodoPlanChange> {
  const nextTasks = keyedTasks(nativeTodoPlanTasks(next));
  if (previous === null) {
    return nextTasks.size === 0 ? [] : [{ kind: "planned", count: nextTasks.size }];
  }
  const previousTasks = keyedTasks(nativeTodoPlanTasks(previous));
  const changes: TodoPlanChange[] = [];
  for (const [key, task] of nextTasks) {
    const prior = previousTasks.get(key);
    if (prior === undefined) {
      changes.push({ kind: "added", content: task.content });
    } else if (prior.status !== task.status) {
      if (task.status === "completed") changes.push({ kind: "completed", content: task.content });
      else if (task.status === "abandoned")
        changes.push({ kind: "dropped", content: task.content });
      else if (task.status === "blocked") {
        changes.push({
          kind: "blocked",
          content: task.content,
          ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
        });
      }
    }
  }
  for (const [key, task] of previousTasks) {
    if (nextTasks.has(key) || task.status === "completed" || task.status === "abandoned") continue;
    changes.push({ kind: "dropped", content: task.content });
  }
  return changes;
}
