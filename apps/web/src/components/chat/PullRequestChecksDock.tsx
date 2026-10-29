/**
 * The composer's checks dock: the thread's pull request, docked above the input, saying how its
 * checks are doing and offering the one thing worth doing about them. Collapsed it is one line —
 * the checks counting down, the failure by name, or the merge — with Fix under failing checks and
 * Merge once they pass. Expanded it lays every check on one time axis, so a bar's start shows
 * what it waited for and its length compares against every other.
 *
 * Fix asks this thread's agent, the one that opened the pull request, rather than handing off to a
 * new thread the way the details panel does: the dock lives in the conversation that can fix it.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  PullRequestCheckStatus,
  PullRequestRef,
  PullRequestState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { MOTION_MS, useChangedSinceMount } from "~/lib/motion";
import { cn } from "~/lib/utils";

import {
  allowedPullRequestMergeMethods,
  buildFixFindingsHandoff,
  readableFailure,
  resolveSelectedMergeMethod,
  resolveThreadPanelPullRequestAction,
} from "../pullRequest/pullRequestDetail.logic";
import { PullRequestMergeConfirmDialog } from "../pullRequest/PullRequestMergeConfirmDialog";
import {
  PullRequestCheckStatusIcon,
  pullRequestChecksState,
  pullRequestCheckStatusLabel,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { usePullRequestActionRunner } from "../pullRequest/usePullRequestActions";
import { useThreadPullRequestDetail } from "../pullRequest/useThreadPullRequestDetail";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { GlyphSwap } from "./GlyphSwap";
import {
  buildChecksWaterfall,
  checksDockHeadline,
  describeFailedChecks,
  failedChecksOf,
} from "./pullRequestChecksDock.logic";

/** How often a running check's bar grows; the bar glides between ticks, so it reads as live. */
const LIVE_TICK_MS = 1_000;

const BAR_TONE: Record<PullRequestCheckStatus, string> = {
  pending: "bg-sky-500/80",
  "action-required": "bg-amber-500/70",
  success: "bg-emerald-500/70",
  failure: "bg-destructive/80",
  cancelled: "bg-destructive/50",
  skipped: "bg-muted-foreground/30",
  neutral: "bg-muted-foreground/30",
};

export function PullRequestChecksDock({
  environmentId,
  threadRef,
  project,
  reference,
  number,
  fallbackState,
  onFix,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  project: EnvironmentProject | null;
  reference: Pick<PullRequestRef, "host" | "repository" | "number"> | null;
  number: number;
  fallbackState: PullRequestState | undefined;
  /** Sends the fix request to this thread's agent. */
  onFix: (prompt: string) => Promise<unknown>;
}) {
  const bodyId = useId();
  const openLink = useOpenLink(threadRef);
  const {
    reference: resolvedReference,
    detail,
    refresh,
  } = useThreadPullRequestDetail({
    environmentId,
    project,
    reference,
    number,
    fallbackState,
  });
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference: resolvedReference,
    onSuccess: refresh,
  });
  const [expanded, setExpanded] = useState(false);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  // The failures a fix was asked for. A new run replaces them, which is what ends "Fixing".
  const [fixRequestedFor, setFixRequestedFor] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const checks = detail?.checks ?? [];
  const failed = failedChecksOf(checks);
  const failedKey = failed
    .map((check) => `${check.name}\u0000${check.completedAt ?? ""}`)
    .join("\n");
  const fixing = failed.length > 0 && fixRequestedFor === failedKey;
  const rowAction = resolveThreadPanelPullRequestAction(detail);
  const live = expanded && checks.some((check) => check.status === "pending");

  const checksState = pullRequestChecksState(checks);
  const glyph =
    actionPending || fixing
      ? "busy"
      : detail?.state === "merged"
        ? "merged"
        : checksState === "failing"
          ? "failure"
          : checksState === "pending"
            ? "pending"
            : checksState === "passing"
              ? "success"
              : "idle";

  useEffect(() => {
    if (!live) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);
  const label =
    detail === null
      ? ""
      : actionPending
        ? "Merging"
        : detail.state === "merged"
          ? `Merged into ${detail.baseBranch}`
          : fixing
            ? `Fixing ${describeFailedChecks(failed)}`
            : checksDockHeadline(checks);
  const labelChanged = useChangedSinceMount(label);

  if (
    detail === null ||
    detail.state === "closed" ||
    (detail.state === "open" && checks.length === 0)
  ) {
    return null;
  }

  const mergeMethod = resolveSelectedMergeMethod(allowedPullRequestMergeMethods(detail), "merge");
  const waterfall = buildChecksWaterfall(checks, nowMs);
  const mergedState = resolvePullRequestState({ state: "merged", isDraft: false });
  const openState = resolvePullRequestState({ state: "open", isDraft: detail.isDraft });

  const startFix = async () => {
    setFixRequestedFor(failedKey);
    // The full panel's fix carries review threads too; the dock holds only the checks.
    const { prompt } = buildFixFindingsHandoff({
      number: detail.number,
      title: detail.title,
      url: detail.url,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
      reviewThreads: [],
      comments: [],
      checks,
      commentsTruncated: false,
    });
    try {
      await onFix(prompt);
    } catch (failure) {
      setFixRequestedFor(null);
      toastManager.add({
        type: "error",
        title: "Could not ask the agent to fix the checks",
        description: readableFailure(failure, "Try again once the thread is connected."),
      });
    }
  };

  const toggle = () => setExpanded((value) => !value);

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`Pull request #${detail.number} checks`}
        className="relative z-0"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon className="[&_svg]:size-3.5">
            <GlyphSwap
              state={glyph}
              render={(state) =>
                state === "busy" ? (
                  <Spinner className="size-3.5 text-muted-foreground" />
                ) : state === "merged" ? (
                  <mergedState.Icon className={cn("size-3.5", mergedState.toneClassName)} />
                ) : state === "failure" || state === "pending" || state === "success" ? (
                  <PullRequestCheckStatusIcon status={state} />
                ) : (
                  <openState.Icon className={cn("size-3.5", openState.toneClassName)} />
                )
              }
            />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggle}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-start focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="shrink-0 text-muted-foreground tabular-nums">#{detail.number}</span>
              <span
                key={label}
                className={cn(
                  "min-w-0 truncate text-foreground/85",
                  labelChanged && "motion-swap-text",
                )}
              >
                {label}
              </span>
            </button>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {expanded && waterfall !== null ? (
              <span className="text-muted-foreground tabular-nums">
                {formatDuration(waterfall.spanMs)}
              </span>
            ) : null}
            {rowAction === "fix" && !fixing ? (
              <Button
                size="xs"
                variant="outline"
                className="motion-enter h-5 rounded-full px-2 text-destructive"
                onClick={() => void startFix()}
              >
                Fix
              </Button>
            ) : rowAction === "merge" && !actionPending ? (
              <Button
                size="xs"
                variant="outline"
                className="motion-enter h-5 rounded-full px-2"
                onClick={() => setConfirmingMerge(true)}
              >
                Merge
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={expanded ? "Collapse checks" : "Expand checks"}
              aria-expanded={expanded}
              aria-controls={bodyId}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggle}
            >
              <ChevronDownIcon
                className={cn("motion-chevron size-3.5", !expanded && "rotate-180")}
              />
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <div
          id={bodyId}
          inert={!expanded}
          className={cn(
            "grid transition-[grid-template-rows] duration-(--motion-duration) ease-disclosure",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {/* The rows wait for the panel to open before fading in, so they never draw squeezed. */}
            <div
              className={cn(
                "transition-opacity duration-(--motion-duration) ease-disclosure",
                expanded ? "opacity-100 delay-80" : "opacity-0",
              )}
            >
              <ComposerBanner.Scroll className="max-h-48">
                <ComposerBanner.Children render={<ul />}>
                  {(
                    waterfall?.rows ??
                    checks.map((check) => ({ check, bar: null, durationMs: null }))
                  ).map(({ check, bar, durationMs }, index) => (
                    <ComposerBanner.Row render={<li />} key={`${index}:${check.name}`}>
                      <ComposerBanner.Icon className="[&_svg]:size-3">
                        <PullRequestCheckStatusIcon status={check.status} />
                      </ComposerBanner.Icon>
                      <ComposerBanner.Content className="gap-2">
                        <button
                          type="button"
                          disabled={check.url === null}
                          title={check.description ?? check.name}
                          onClick={() => {
                            if (check.url === null) return;
                            void openLink(check.url).catch((error: unknown) => {
                              console.error(error);
                              toastManager.add({
                                type: "error",
                                title: "Unable to open check details",
                              });
                            });
                          }}
                          className={cn(
                            "min-w-0 truncate text-start enabled:hover:underline",
                            waterfall === null ? "flex-1" : "w-36 max-w-[40%] shrink-0",
                          )}
                        >
                          {check.name}
                        </button>
                        {waterfall === null ? null : (
                          <span className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted-foreground/10">
                            {bar === null ? null : (
                              <span
                                className={cn(
                                  "absolute inset-y-0 rounded-full",
                                  BAR_TONE[check.status],
                                )}
                                style={{
                                  left: `${bar.offset * 100}%`,
                                  width: `max(${bar.width * 100}%, 0.25rem)`,
                                  transition: `left ${LIVE_TICK_MS}ms linear, width ${LIVE_TICK_MS}ms linear, background-color ${MOTION_MS}ms ease`,
                                }}
                              />
                            )}
                          </span>
                        )}
                      </ComposerBanner.Content>
                      <ComposerBanner.Actions className="min-w-12 text-muted-foreground tabular-nums">
                        {durationMs !== null
                          ? formatDuration(durationMs)
                          : check.status === "pending" && waterfall !== null
                            ? "Queued"
                            : pullRequestCheckStatusLabel(check)}
                      </ComposerBanner.Actions>
                    </ComposerBanner.Row>
                  ))}
                </ComposerBanner.Children>
              </ComposerBanner.Scroll>
            </div>
          </div>
        </div>
      </ComposerBanner.Root>
      {rowAction === "merge" ? (
        <PullRequestMergeConfirmDialog
          open={confirmingMerge}
          onOpenChange={setConfirmingMerge}
          number={detail.number}
          method={mergeMethod}
          pending={actionPending}
          onConfirm={() => void perform("merge", mergeMethod)}
        />
      ) : null}
    </ComposerBanner.Attachment>
  );
}
