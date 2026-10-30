import * as DateTime from "effect/DateTime";
import { useId } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CopyIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { formatShortTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ActivityDisclosurePanel } from "./ActivityDisclosure";
import { useSmoothHeight } from "~/lib/motion";

type NativeNoticeItem = Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;
type NativeNoticeLevel = NonNullable<NativeNoticeItem["nativeLevel"]>;
type NativeJobCompletion = NonNullable<NativeNoticeItem["jobCompletion"]>;

const NATIVE_NOTICE_PREVIEW_LENGTH = 600;

const NATIVE_LEVEL_PRESENTATION = {
  info: { label: "Info", className: "text-muted-foreground" },
  warning: { label: "Warning", className: "text-muted-foreground" },
  error: { label: "Error", className: "text-muted-foreground" },
} satisfies Record<NativeNoticeLevel, { readonly label: string; readonly className: string }>;

const NOTICE_CONTROL_CLASS_NAME =
  "inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded px-1.5 text-2xs font-medium text-muted-foreground outline-none hover:bg-accent/40 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

function boundedPreview(message: string): string {
  let end = NATIVE_NOTICE_PREVIEW_LENGTH;
  const last = message.charCodeAt(end - 1);
  const next = message.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return `${message.slice(0, end).trimEnd()}…`;
}

function jobCompletionCopyText(job: NativeJobCompletion): string {
  const lines = [
    "Background job completed",
    `Type: ${job.type?.trim() || "job"}`,
    `ID: ${job.jobId}`,
  ];
  if (job.agentId !== undefined) lines.push(`Agent ID: ${job.agentId}`);
  if (job.label !== undefined) lines.push(`Label: ${job.label}`);
  if (job.status !== undefined) lines.push(`Status: ${job.status}`);
  if (job.durationMs !== undefined) lines.push(`Duration: ${job.durationMs}ms`);
  return lines.join("\n");
}

export function NativeNotice({
  item,
  timestampFormat,
  expanded,
  onExpandedChange,
}: {
  readonly item: NativeNoticeItem;
  readonly timestampFormat: TimestampFormat;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const bodyId = `native-notice-${useId()}`;
  // Expanding a long notice swaps preview for full text; the height glides between them.
  const { outerRef: longBodyRef, contentRef: longBodyContentRef } = useSmoothHeight<
    HTMLDivElement,
    HTMLParagraphElement
  >(false);
  const irc = item.irc;
  const isIrc = irc !== undefined;
  const jobCompletion = isIrc ? undefined : item.jobCompletion;
  const isBackgroundCompletion = jobCompletion !== undefined;
  const jobType = jobCompletion?.type?.trim() || "job";
  const normalizedJobStatus = jobCompletion?.status?.trim().toLowerCase();
  const isSuccessfulJobStatus = normalizedJobStatus === "completed";
  const primaryJobStatus =
    jobCompletion?.status !== undefined &&
    normalizedJobStatus !== undefined &&
    normalizedJobStatus.length > 0 &&
    !isSuccessfulJobStatus
      ? jobCompletion.status
      : undefined;
  const hasJobDetails =
    jobCompletion !== undefined &&
    (jobCompletion.agentId !== undefined ||
      jobCompletion.label !== undefined ||
      isSuccessfulJobStatus);
  const hasLongBody = !isBackgroundCompletion && item.message.length > NATIVE_NOTICE_PREVIEW_LENGTH;
  const itemTitle = item.title?.trim() || null;
  const nativeSource = item.nativeSource?.trim() || null;
  const diagnosticTitle = itemTitle ?? nativeSource;
  const severity =
    item.nativeLevel === undefined ? null : NATIVE_LEVEL_PRESENTATION[item.nativeLevel];
  const timestamp = DateTime.formatIso(item.updatedAt);
  const visibleTimestamp = formatShortTimestamp(timestamp, timestampFormat);
  const accessibilityLabel = isIrc
    ? `IRC message from ${irc.from} to ${irc.to}`
    : isBackgroundCompletion
      ? "Background job completed"
      : `${severity ? `${severity.label} ` : ""}native diagnostic${diagnosticTitle ? ` from ${diagnosticTitle}` : ""}`;
  const copyLabel = isBackgroundCompletion
    ? "background job details"
    : `full ${isIrc ? "IRC message" : "native diagnostic"}`;
  const copyText = jobCompletion
    ? jobCompletionCopyText(jobCompletion)
    : irc
      ? `From: ${irc.from}\nTo: ${irc.to}\n\n${item.message}`
      : item.message;
  const copyTarget = isBackgroundCompletion ? "background job details" : "native message";
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: copyTarget, timeout: 1500 });

  return (
    <article
      role={isIrc ? "note" : isBackgroundCompletion ? "article" : "group"}
      data-native-job-completion={isBackgroundCompletion ? "" : undefined}
      aria-label={accessibilityLabel}
      className={
        item.nativeLevel === "error"
          ? "min-w-0 max-w-full rounded-md border border-border/40 bg-muted/20 px-3 py-1.5"
          : "min-w-0 max-w-full px-3 py-1.5"
      }
    >
      <header className="flex min-w-0 items-center gap-2 text-xs">
        {/* Consistent left gutter glyph per Rule 8 */}
        <span className="w-3.5 shrink-0 flex items-center justify-center" aria-hidden="true">
          {item.nativeLevel === "warning" ? (
            <TriangleAlertIcon className="size-3 text-muted-foreground" />
          ) : item.nativeLevel === "error" ? (
            <CircleAlertIcon className="size-3 text-muted-foreground" />
          ) : isBackgroundCompletion ? (
            <CheckIcon className="size-3 text-muted-foreground" />
          ) : (
            <CircleAlertIcon className="size-3 text-muted-foreground" />
          )}
        </span>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
          {jobCompletion ? (
            <>
              <span className="shrink-0 font-medium text-foreground">Background job completed</span>
              {/* Sans label per Rule 7; no mono chip */}
              <span data-native-job-type className="shrink-0 text-2xs text-muted-foreground">
                {jobType}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1">
                <span className="sr-only">Job ID</span>
                <code
                  dir="auto"
                  data-native-job-id
                  className="min-w-0 font-mono text-2xs text-foreground [overflow-wrap:anywhere]"
                >
                  {jobCompletion.jobId}
                </code>
              </span>
              {primaryJobStatus !== undefined ? (
                <span data-native-job-status className="shrink-0 text-2xs text-muted-foreground">
                  {primaryJobStatus}
                </span>
              ) : null}
            </>
          ) : irc ? (
            <>
              <span className="shrink-0 text-2xs font-medium uppercase tracking-wide">IRC</span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1">
                <span className="shrink-0">From</span>
                <span className="min-w-0 wrap-break-word font-medium text-foreground">
                  {irc.from}
                </span>
                <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
                <span className="shrink-0">To</span>
                <span className="min-w-0 wrap-break-word font-medium text-foreground">
                  {irc.to}
                </span>
              </span>
            </>
          ) : (
            <>
              <span className="shrink-0 font-medium text-muted-foreground">Diagnostic</span>
              {diagnosticTitle ? (
                <span className="min-w-0 wrap-break-word font-medium text-foreground">
                  {diagnosticTitle}
                </span>
              ) : null}
              {itemTitle && nativeSource && itemTitle !== nativeSource ? (
                <span className="min-w-0 wrap-break-word text-2xs">Source: {nativeSource}</span>
              ) : null}
              {severity ? (
                <span className={`text-2xs font-medium ${severity.className}`}>
                  {severity.label}
                </span>
              ) : null}
            </>
          )}
        </div>

        {/* Duration only when >= 1s; the wall clock lives in its tooltip, never inline. */}
        {jobCompletion?.durationMs !== undefined && jobCompletion.durationMs >= 1000 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  data-native-job-duration
                  className="shrink-0 text-2xs tabular-nums text-muted-foreground ml-auto"
                />
              }
            >
              ({formatDuration(jobCompletion.durationMs)})
            </TooltipTrigger>
            {visibleTimestamp ? <TooltipPopup>{visibleTimestamp}</TooltipPopup> : null}
          </Tooltip>
        ) : null}

        {visibleTimestamp ? (
          <time dateTime={timestamp} className="sr-only">
            {visibleTimestamp}
          </time>
        ) : null}

        <div className="flex shrink-0 items-center gap-0.5 ml-auto">
          {hasLongBody || hasJobDetails ? (
            <button
              type="button"
              data-native-job-details-toggle={isBackgroundCompletion ? "" : undefined}
              aria-label={
                isBackgroundCompletion
                  ? `${expanded ? "Hide" : "Show"} background job details`
                  : `${expanded ? "Collapse" : "Expand"} ${isIrc ? "IRC message" : "native diagnostic"}`
              }
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => onExpandedChange(!expanded)}
              className={NOTICE_CONTROL_CLASS_NAME}
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={`motion-chevron size-3 ${expanded ? "" : "-rotate-90"}`}
              />
              <span>
                {isBackgroundCompletion
                  ? expanded
                    ? "Hide details"
                    : "Details"
                  : expanded
                    ? "Collapse"
                    : "Expand"}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Copy ${copyLabel}`}
            onClick={() => copyToClipboard(copyText, undefined)}
            className={NOTICE_CONTROL_CLASS_NAME}
          >
            {isCopied ? (
              <CheckIcon aria-hidden="true" className="size-3 text-muted-foreground" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-3" />
            )}
            <span>{isCopied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </header>

      {jobCompletion ? (
        hasJobDetails ? (
          <ActivityDisclosurePanel open={expanded} id={bodyId}>
            <div className="mt-1 border-t border-border/30 pt-1 text-2xs text-muted-foreground">
              <div className="grid min-w-0 gap-1 [overflow-wrap:anywhere]">
                {jobCompletion.agentId !== undefined ? (
                  <div data-native-job-agent-id className="min-w-0">
                    <span className="font-medium">Agent ID: </span>
                    <code className="font-mono text-foreground">{jobCompletion.agentId}</code>
                  </div>
                ) : null}
                {jobCompletion.label !== undefined ? (
                  <div data-native-job-label className="min-w-0">
                    <span className="font-medium">Label: </span>
                    <span className="text-foreground">{jobCompletion.label}</span>
                  </div>
                ) : null}
                {isSuccessfulJobStatus ? (
                  <div data-native-job-terminal-status className="min-w-0">
                    <span className="font-medium">Result status: </span>
                    <span className="text-foreground">{jobCompletion.status}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </ActivityDisclosurePanel>
        ) : null
      ) : hasLongBody ? (
        <div id={bodyId} ref={longBodyRef} className="mt-1 overflow-hidden text-xs">
          <p ref={longBodyContentRef} className="whitespace-pre-wrap text-muted-foreground">
            {expanded ? item.message : boundedPreview(item.message)}
          </p>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{item.message}</p>
      )}
    </article>
  );
}
