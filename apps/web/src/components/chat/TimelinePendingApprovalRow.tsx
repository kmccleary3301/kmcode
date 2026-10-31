import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { ShieldIcon } from "lucide-react";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { WorkLogRow } from "./WorkLog";

interface TimelinePendingApprovalRowProps {
  approval: PendingApproval;
  canOperateThread: boolean;
  isResponding: boolean;
  onRespondToApproval:
    | ((requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<unknown>)
    | undefined;
}

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
  canOperateThread,
  isResponding,
  onRespondToApproval,
}: TimelinePendingApprovalRowProps) {
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : approval.requestKind === "permission"
            ? "App permission approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const canRespond = approval.responseCapability === "live";

  return (
    <WorkLogRow
      role="group"
      aria-label={fallbackLabel}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={<ShieldIcon aria-hidden className="block size-4 shrink-0 text-icon-muted" />}
      label={
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
            <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
            {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
            {approval.fullAccessOverride ? (
              <Popover>
                <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                  {FULL_ACCESS_OVERRIDE_QUESTION}
                </PopoverTrigger>
                <PopoverPopup
                  aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                  tooltipStyle
                  side="top"
                  className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
                >
                  {fullAccessOverrideExplanation(approval.fullAccessOverride)}
                </PopoverPopup>
              </Popover>
            ) : null}
          </span>
          <Detail
            aria-label={detailAriaLabel}
            className={
              approval.requestKind === "mcp-elicitation"
                ? "block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-sans text-xs text-foreground wrap-break-word"
                : "block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs text-foreground wrap-anywhere"
            }
            data-approval-detail="complete"
            tabIndex={0}
          >
            {approval.responseCapability === "not_resumable"
              ? "Provider process is gone. Interrupt or restart the run to respond."
              : approval.detail || fallbackLabel}
          </Detail>
          {approval.reason ? (
            <span className="w-full min-w-0 text-2xs text-muted-foreground wrap-break-word">
              {approval.reason}
            </span>
          ) : null}
        </span>
      }
    >
      {canRespond ? (
        <div className="ms-7.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 text-xs">
          <span className="inline-flex items-center gap-1 text-warning">
            <ShieldIcon aria-hidden className="size-3 shrink-0" />
            Waiting for approval
          </span>
          {onRespondToApproval ? (
            <>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <ComposerPendingApprovalActions
                presentation="inline"
                requestId={approval.requestId}
                disabled={!canOperateThread}
                isResponding={isResponding}
                canRespond={canRespond}
                options={approval.options}
                onRespondToApproval={onRespondToApproval}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </WorkLogRow>
  );
});
