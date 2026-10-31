import { RuntimeRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";

describe("TimelinePendingApprovalRow", () => {
  it("shows request context and inline approval controls", () => {
    const reason = "This command matched an ask rule.";
    const markup = renderToStaticMarkup(
      <TimelinePendingApprovalRow
        approval={{
          requestId: RuntimeRequestId.make("timeline-approval"),
          requestKind: "command",
          createdAt: "2026-10-31T00:00:00.000Z",
          detail: "pwd",
          reason,
          fullAccessOverride: "ask_rule",
          responseCapability: "live",
        }}
        canOperateThread={false}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(reason);
    expect(markup).toContain("Why am I being asked this?");
    expect(markup).toContain("Waiting for approval");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Decline");
  });
});
