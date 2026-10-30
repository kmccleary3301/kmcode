import type { ReactNode } from "react";
import { use, useEffect, useRef, useState } from "react";
import { CheckIcon, CircleDashedIcon, CircleXIcon, RotateCwIcon } from "lucide-react";

import { formatCompactElapsedSeconds } from "./AgentElapsed";
import type { NativeWaitJob, NativeWaitState } from "./NativeWaitingPane.logic";
import { useChangedSinceMount } from "~/lib/motion";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { TerminalSpinner } from "../ui/terminal-spinner";
import { TranscriptStyleCtx } from "./transcriptStyle";

export {
  isNativeWaitTool,
  readNativeWaitState,
  type NativeWaitJob,
  type NativeWaitJobStatus,
  type NativeWaitState,
} from "./NativeWaitingPane.logic";

/**
 * Ref callback: every clock hand starts at the document timeline's origin, so
 * a tree of waits ticks in step instead of each hand keeping its mount phase.
 */
function syncClockHand(hand: SVGPathElement | null): void {
  for (const animation of hand?.getAnimations() ?? []) animation.startTime = 0;
}

/**
 * OMP's waiting glyph: a clock whose hand ticks round, in phase with every
 * other waiting clock on the page.
 */
export function WaitClockGlyph({ className }: { readonly className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path ref={syncClockHand} className="motion-clock-hand" d="M8 8V4.25" />
    </svg>
  );
}

/** Same shimmer treatment as live timeline rows (`ActivityShimmerOverlay`). */
function ShimmerOverlay({ children }: { readonly children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

function NativeWaitElapsed({
  durationMs,
  live,
  snapshotAtMs,
}: {
  readonly durationMs: number | null;
  readonly live: boolean;
  readonly snapshotAtMs: number | null;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialElapsedMs =
    durationMs === null
      ? null
      : durationMs + (live && snapshotAtMs !== null ? Math.max(0, Date.now() - snapshotAtMs) : 0);
  const initialText =
    initialElapsedMs === null || initialElapsedMs < 1_000
      ? null
      : `· ${formatCompactElapsedSeconds(initialElapsedMs / 1_000)}`;

  useEffect(() => {
    if (!live || snapshotAtMs === null) return;
    const interval = window.setInterval(() => {
      if (textRef.current === null) return;
      const totalMs = (durationMs ?? 0) + Math.max(0, Date.now() - snapshotAtMs);
      if (totalMs >= 1_000) {
        textRef.current.textContent = `· ${formatCompactElapsedSeconds(totalMs / 1_000)}`;
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [durationMs, live, snapshotAtMs]);

  if (initialText === null && !live) return null;
  return (
    <span
      ref={textRef}
      className="shrink-0 tabular-nums text-muted-foreground"
      data-native-wait-elapsed
    >
      {initialText}
    </span>
  );
}

/**
 * OMP's TUI wait tree, one row per job — `◷ ⟨bash⟩ bg_29 ssh … · 3m58s` — with
 * the command truncating and the elapsed time ticking while the job runs.
 * Terminal style keeps that mono line under `├─` and `└─`; KM leads with the
 * label in the transcript's sans and trails the type and id a grey further
 * back, on branches drawn from the step rail.
 */
export function NativeWaitingPane({ state }: { readonly state: NativeWaitState }) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const runningCount = state.jobs.reduce(
    (count, job) => count + (job.status === "running" ? 1 : 0),
    0,
  );
  const header = state.waiting
    ? `Waiting on ${runningCount}${runningCount === state.jobs.length ? "" : ` of ${state.jobs.length}`} ${state.jobs.length === 1 ? "job" : "jobs"}`
    : `${state.jobs.length} background ${state.jobs.length === 1 ? "job" : "jobs"}`;
  // Jobs that join a wait already on screen rise in; the first snapshot stays still.
  const [mountedJobIds] = useState(() => new Set(state.jobs.map((job) => job.id)));

  return (
    <section
      aria-label="Native background jobs"
      className={cn(
        "min-w-0 max-w-full",
        isTerminal ? "font-mono text-xs leading-relaxed" : "text-[0.8125rem] leading-6",
      )}
      data-native-wait-state={state.waiting ? "waiting" : "snapshot"}
      data-terminal-waiting={isTerminal ? "true" : undefined}
    >
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {header}
      </p>

      <ul aria-label="Jobs" className="m-0 min-w-0 list-none p-0">
        {state.jobs.map((job, index) => (
          <NativeWaitJobRow
            key={job.id}
            job={job}
            waiting={state.waiting}
            entering={state.waiting && !mountedJobIds.has(job.id)}
            snapshotAtMs={state.snapshotAtMs}
            last={index === state.jobs.length - 1}
          />
        ))}
      </ul>
    </section>
  );
}

function NativeWaitJobRow({
  job,
  waiting,
  entering,
  snapshotAtMs,
  last,
}: {
  readonly job: NativeWaitJob;
  readonly waiting: boolean;
  readonly entering: boolean;
  readonly snapshotAtMs: number | null;
  readonly last: boolean;
}) {
  const isTerminal = use(TranscriptStyleCtx) === "terminal";
  const statusChanged = useChangedSinceMount(job.status);
  const running = job.status === "running";
  const shimmer = waiting && running && job.label !== null && !isTerminal;
  // `bg_29`, `ReviewW217`: the counter tells jobs apart, so it carries the weight.
  const [, idPrefix = job.id, idCounter = ""] = /^(.*?)(\d*)$/.exec(job.id) ?? [];
  // A T3 thread's id is long and says less than the child's title, so a
  // titled thread shows only that; an untitled one truncates its id instead.
  const threadJob = job.type === "thread";
  const showId = !threadJob || job.label === null;
  return (
    <li
      className={cn(
        "wait-tree-row flex min-w-0 items-center",
        isTerminal ? "gap-1.5" : "gap-2",
        entering && "motion-enter",
      )}
      data-native-wait-job-status={job.status}
      data-terminal-wait-row={isTerminal ? "true" : undefined}
      data-terminal-wait-last={isTerminal && last ? "true" : undefined}
    >
      <span
        key={job.status}
        className={cn(
          "flex w-3.5 shrink-0 items-center justify-center",
          statusChanged && "motion-swap",
        )}
        aria-hidden="true"
      >
        {isTerminal ? (
          running ? (
            <TerminalSpinner />
          ) : job.status === "completed" ? (
            <span className="terminal-wait-completed">✔</span>
          ) : job.status === "failed" ? (
            <span className="terminal-wait-failed">✘</span>
          ) : job.status === "cancelled" || job.status === "interrupted" ? (
            <span className="terminal-wait-muted">⏹</span>
          ) : (
            <span className="terminal-wait-muted">⏳</span>
          )
        ) : running ? (
          <WaitClockGlyph className="size-3.5 text-foreground" />
        ) : job.status === "completed" ? (
          <CheckIcon className="size-3.5 text-muted-foreground" />
        ) : job.status === "failed" ? (
          <CircleXIcon className="size-3.5 status-failed-mark" />
        ) : job.status === "cancelled" || job.status === "interrupted" ? (
          <RotateCwIcon className="size-3.5 text-muted-foreground" />
        ) : (
          <CircleDashedIcon className="size-3.5 text-muted-foreground" />
        )}
      </span>
      {isTerminal ? (
        <>
          {job.type !== null ? (
            <span className="shrink-0 text-muted-foreground">⟨{job.type}⟩</span>
          ) : null}
          {showId ? (
            <code
              dir="auto"
              className={cn(
                "font-mono text-muted-foreground",
                threadJob ? "min-w-0 truncate" : "shrink-0",
              )}
            >
              <span className="sr-only">Job ID </span>
              {idPrefix}
              <span className="font-semibold text-muted-foreground">{idCounter}</span>
            </code>
          ) : null}
        </>
      ) : null}
      {job.label !== null ? (
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className={cn(
            "motion-tint relative min-w-0 truncate",
            running ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {job.label}
          {shimmer ? <ShimmerOverlay>{job.label}</ShimmerOverlay> : null}
        </span>
      ) : null}
      {isTerminal ? null : (
        <span
          className={cn(
            "wait-tree-id flex items-baseline gap-1.5",
            threadJob ? "min-w-0" : "shrink-0",
          )}
        >
          {job.type !== null ? <span>{job.type}</span> : null}
          {showId ? (
            <code dir="auto" className="min-w-0 truncate font-mono">
              <span className="sr-only">Job ID </span>
              {job.id}
            </code>
          ) : null}
        </span>
      )}
      {job.completionPercent !== null && running ? (
        <span
          aria-label={`${job.completionPercent}% complete`}
          className="shrink-0 tabular-nums text-muted-foreground"
          data-native-wait-progress
        >
          · {job.completionPercent}%
        </span>
      ) : null}
      <NativeWaitElapsed
        durationMs={job.durationMs}
        live={waiting && running}
        snapshotAtMs={snapshotAtMs}
      />
    </li>
  );
}
