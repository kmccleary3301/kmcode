import { useMemo, useState } from "react";
import { ListTodoIcon, TargetIcon, TriangleAlertIcon } from "lucide-react";
import type { EnvironmentId, OrchestrationV2ProviderGoal, ThreadId } from "@t3tools/contracts";
import type {
  PendingBackgroundWorkItem,
  PendingBackgroundWorkPresentation,
} from "@t3tools/client-runtime/state/thread-execution";
import { cn } from "~/lib/utils";
import type { NativeTodoPlan, NativeTodoTask } from "./todoPlan";
import { nativeTodoPlanTasks } from "./todoPlan";
import { usePresence } from "~/lib/motion";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AgentElapsed } from "./AgentElapsed";
import { CursorTodoRows } from "./CursorTodoPanel";
import { ComposerWorkingHub } from "./ComposerTasksBadge";

const NO_TASKS: ReadonlyArray<NativeTodoTask> = [];

export interface ComposerGoalStatus {
  readonly status: OrchestrationV2ProviderGoal["status"];
  readonly title: string;
  readonly objective: string;
  readonly usage: string | null;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canClear: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onClear: () => void;
  readonly onStart: () => void;
}

export interface ComposerBackgroundWorkStatus {
  readonly work: PendingBackgroundWorkPresentation;
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
}

export interface ComposerForceStopStatus {
  readonly stopping: boolean;
  readonly onForceStop: () => void;
}

export function ComposerStatusBumps({
  backgroundWork,
  environmentId,
  forceStopBump,
  goal,
  threadId,
  todoPlan,
}: {
  readonly backgroundWork: ComposerBackgroundWorkStatus | null;
  readonly environmentId?: EnvironmentId | undefined;
  readonly forceStopBump: ComposerForceStopStatus | null;
  readonly goal: ComposerGoalStatus | null;
  readonly threadId?: ThreadId | null;
  readonly todoPlan: NativeTodoPlan | null;
}) {
  return (
    <div className="cursor-composer-status-bumps" data-composer-status-bumps>
      {/* Keyed by thread: another thread's list or roster never eases out over this one. */}
      <ComposerTodoPresence key={`todos:${threadId ?? ""}`} plan={todoPlan} />
      <ComposerWorkingHub
        key={`working:${threadId ?? ""}`}
        environmentId={environmentId}
        threadId={threadId}
      />
      {forceStopBump === null ? null : <ComposerForceStopBump status={forceStopBump} />}
      {backgroundWork === null ? null : <ComposerBackgroundWorkBump status={backgroundWork} />}
      {goal === null ? null : <ComposerGoalBump goal={goal} />}
    </div>
  );
}

function ComposerForceStopBump({ status }: { readonly status: ComposerForceStopStatus }) {
  return (
    <button
      type="button"
      aria-label="Force stop unresponsive background run"
      title="Stop was requested, but this background run did not stop."
      data-composer-status-bump="force-stop"
      className={cn(
        "border-warning/30 bg-warning-surface text-warning-foreground hover:bg-warning/12",
        status.stopping && "cursor-wait",
      )}
      disabled={status.stopping}
      onClick={status.onForceStop}
    >
      <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />
      <span className="min-w-0 truncate">Stop unresponsive</span>
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        ·
      </span>
      <span className="shrink-0 font-medium">
        {status.stopping ? "Force stopping..." : "Force stop"}
      </span>
    </button>
  );
}

/** The bump eases out showing the list it last had when the plan clears. */
function ComposerTodoPresence({ plan }: { readonly plan: NativeTodoPlan | null }) {
  const tasks = useMemo(() => (plan === null ? NO_TASKS : nativeTodoPlanTasks(plan)), [plan]);
  const open = tasks.length > 0;
  const presence = usePresence(open);
  const [shownTasks, setShownTasks] = useState(tasks);
  if (open && shownTasks !== tasks) setShownTasks(tasks);
  if (!presence.mounted) return null;
  return <ComposerTodoBump tasks={shownTasks} shown={presence.shown} />;
}

function ComposerTodoBump({
  tasks,
  shown,
}: {
  readonly tasks: ReadonlyArray<NativeTodoTask>;
  readonly shown: boolean;
}) {
  const [mountedTaskCount] = useState(tasks.length);
  let completed = 0;
  for (const task of tasks) if (task.status === "completed") completed += 1;
  const currentTask =
    tasks.find((task) => task.status === "current") ??
    tasks.find((task) => task.status === "pending") ??
    null;
  const accessibleCurrent =
    currentTask === null ? "No current item" : `Current item: ${currentTask.content}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={180}
        render={
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`To-dos: ${completed} of ${tasks.length}. ${accessibleCurrent}. Show list`}
            data-composer-status-bump="todos"
            data-composer-status-bump-visible={shown ? "true" : "false"}
          />
        }
      >
        <ListTodoIcon aria-hidden className="size-3.5" />
        <span className="shrink-0">
          {completed} of {tasks.length} To-dos
        </span>
        {currentTask === null ? null : (
          <span className="min-w-0 truncate text-muted-foreground" data-composer-todo-current>
            {currentTask.content}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Active to-dos"
        data-composer-status-popup="todos"
        align="start"
        side="top"
        width="md"
        padding="none"
      >
        <div className="cursor-composer-status-panel" data-composer-todo-details>
          <h3 className="cursor-composer-status-heading">To-dos</h3>
          <CursorTodoRows
            ariaLabel={`${completed} of ${tasks.length} to-dos complete`}
            tasks={tasks}
            live
            mountedTaskCount={mountedTaskCount}
            terminalStyle={false}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ComposerGoalBump({ goal }: { readonly goal: ComposerGoalStatus }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={180}
        render={
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`Goal status: ${goal.title}. ${goal.objective}. Show controls`}
            data-composer-status-bump="goal"
          />
        }
      >
        <TargetIcon aria-hidden className="size-3.5" />
        <span>{goal.title}</span>
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Goal details and controls"
        data-composer-status-popup="goal"
        align="start"
        side="top"
        width="md"
        padding="none"
      >
        <div className="cursor-composer-status-panel" data-composer-goal-details>
          <h3 className="cursor-composer-status-heading">{goal.title}</h3>
          {/* Goal prompts run to thousands of characters: the objective scrolls on its
              own so the controls below stay in view. */}
          <p className="cursor-composer-status-copy max-h-48 overflow-y-auto whitespace-pre-wrap">
            {goal.objective}
          </p>
          {goal.usage === null ? null : (
            <p className="cursor-composer-status-usage">{goal.usage}</p>
          )}
          <div className="cursor-composer-status-actions">
            {goal.canPause ? (
              <Button size="xs" variant="ghost" onClick={goal.onPause}>
                Pause
              </Button>
            ) : null}
            {goal.canResume ? (
              <Button size="xs" variant="ghost" onClick={goal.onResume}>
                Resume
              </Button>
            ) : null}
            {goal.canClear ? (
              <Button size="xs" variant="ghost" onClick={goal.onClear}>
                Clear
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={goal.onStart}>
              New goal
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

const BACKGROUND_WORK_KIND_LABELS: Record<PendingBackgroundWorkItem["kind"], string> = {
  subagent: "Subagent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Background job",
};

/** A running clock from the work's start; nothing when the provider gave no start. */
function BackgroundWorkElapsed({
  startedAt,
  compact = false,
}: {
  readonly startedAt: string | undefined;
  readonly compact?: boolean;
}) {
  if (startedAt === undefined) return null;
  return (
    <AgentElapsed agent={{ status: "running", startedAt, completedAt: null }} compact={compact} />
  );
}

/**
 * Work that outlives the turn. Monitoring: it will wake the agent (a monitor,
 * an OMP background job). Running: only commands remain, such as a dev
 * server, and the agent is done, so the dot stays still.
 */
function ComposerBackgroundWorkBump({ status }: { readonly status: ComposerBackgroundWorkStatus }) {
  const { work } = status;
  const heading = work.waiting ? "Monitoring" : "Running";
  const [only] = work.items;
  const summary =
    work.items.length === 1 && only !== undefined ? only.label : `${work.items.length} tasks`;
  // The bump's clock is the longest-running item's, as the working hub's is.
  const oldestStartedAt = work.items.reduce<string | undefined>(
    (oldest, item) =>
      item.startedAt !== undefined &&
      (oldest === undefined || Date.parse(item.startedAt) < Date.parse(oldest))
        ? item.startedAt
        : oldest,
    undefined,
  );
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={180}
        render={
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${heading}: ${summary}. Show background work`}
            data-composer-status-bump="background-work"
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-foreground",
            work.waiting && "animate-status-pulse",
          )}
        />
        <span className="shrink-0">{heading}</span>
        <span className="min-w-0 truncate text-muted-foreground">{summary}</span>
        {oldestStartedAt === undefined ? null : (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            <BackgroundWorkElapsed startedAt={oldestStartedAt} compact />
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Background work"
        data-composer-status-popup="background-work"
        align="start"
        side="top"
        width="md"
        padding="none"
      >
        <div className="cursor-composer-status-panel" data-composer-background-work-details>
          <h3 className="cursor-composer-status-heading">{heading}</h3>
          <ul aria-label="Background tasks" className="flex flex-col gap-2.5">
            {work.items.map((item) => {
              const kindLabel = BACKGROUND_WORK_KIND_LABELS[item.kind];
              return (
                <li key={item.taskId} className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="cursor-composer-status-copy line-clamp-2 min-w-0 flex-1">
                      {item.label}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      <BackgroundWorkElapsed startedAt={item.startedAt} />
                    </span>
                  </div>
                  {kindLabel === item.label ? null : (
                    <span className="text-muted-foreground text-xs">{kindLabel}</span>
                  )}
                  {item.command === undefined ? null : (
                    <code
                      className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-[0.6875rem] text-muted-foreground leading-4"
                      title={item.command}
                    >
                      {item.command}
                    </code>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="cursor-composer-status-actions">
            <Button
              size="xs"
              variant="ghost"
              disabled={!status.canStop || status.stopping}
              onClick={status.onStop}
            >
              {status.stopping ? "Stopping..." : "Stop"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
