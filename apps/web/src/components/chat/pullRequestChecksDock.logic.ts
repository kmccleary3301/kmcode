import type { PullRequestCheck } from "@t3tools/contracts";

import {
  pullRequestChecksState,
  summarizePullRequestChecks,
} from "../pullRequest/pullRequestPresentation";

export interface ChecksWaterfallRow {
  readonly check: PullRequestCheck;
  /** The bar as fractions of the shared axis; null for a check that has not said when it started. */
  readonly bar: { readonly offset: number; readonly width: number } | null;
  /** How long it ran, or has run so far; null until it starts, or when it never said it finished. */
  readonly durationMs: number | null;
}

export interface ChecksWaterfall {
  readonly spanMs: number;
  readonly rows: ReadonlyArray<ChecksWaterfallRow>;
}

function timeOf(value: string | undefined): number | null {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Every check on one time axis, so a bar's start shows what it waited for and a bar's length is
 * comparable to every other. The axis runs from the first start to now while anything is still
 * pending, and to the last finish once nothing is; a running check's bar ends at now.
 *
 * Null when no check says when it started — a server from before check timings, or a host that
 * reports none — so the dock lists the checks plainly instead of drawing an axis of nothing.
 */
export function buildChecksWaterfall(
  checks: ReadonlyArray<PullRequestCheck>,
  nowMs: number,
): ChecksWaterfall | null {
  const spans = checks.map((check) => {
    const start = timeOf(check.startedAt);
    const end =
      start === null
        ? null
        : (timeOf(check.completedAt) ??
          (check.status === "pending" ? Math.max(nowMs, start) : null));
    return { check, start, end };
  });
  const starts = spans.flatMap((span) => (span.start === null ? [] : [span.start]));
  if (starts.length === 0) return null;
  const origin = Math.min(...starts);
  const last = Math.max(
    ...spans.map((span) => span.end ?? span.start ?? origin),
    checks.some((check) => check.status === "pending") ? nowMs : origin,
  );
  // A floor, so a run that finished within the second still draws bars rather than dividing by 0.
  const spanMs = Math.max(last - origin, 1_000);
  return {
    spanMs,
    rows: spans.map(({ check, start, end }) => ({
      check,
      bar:
        start === null
          ? null
          : { offset: (start - origin) / spanMs, width: ((end ?? start) - start) / spanMs },
      durationMs: start === null || end === null ? null : end - start,
    })),
  };
}

export function failedChecksOf(
  checks: ReadonlyArray<PullRequestCheck>,
): ReadonlyArray<PullRequestCheck> {
  return checks.filter((check) => check.status === "failure" || check.status === "cancelled");
}

/** One failure by name, since the name is what the reader acts on; several by count. */
export function describeFailedChecks(failed: ReadonlyArray<PullRequestCheck>): string {
  const [only, ...others] = failed;
  return only !== undefined && others.length === 0 ? only.name : `${failed.length} checks`;
}

/**
 * The dock's one line about the checks: a failure named, a run in progress counting down, and
 * everything else as the checks popover summarizes it.
 */
export function checksDockHeadline(checks: ReadonlyArray<PullRequestCheck>): string {
  if (pullRequestChecksState(checks) === "failing") {
    return `${describeFailedChecks(failedChecksOf(checks))} failed`;
  }
  if (checks.some((check) => check.status === "pending")) {
    const settled = checks.filter(
      (check) => check.status !== "pending" && check.status !== "action-required",
    ).length;
    return `Checks ${settled}/${checks.length}`;
  }
  return summarizePullRequestChecks(checks);
}
