import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  declinePendingApprovals,
  derivePendingThreadRequests,
  fullAccessOverrideExplanation,
  sendApprovalFeedback,
  type ApprovalResponse,
  type ApprovalResponder,
  type ThreadPendingApproval,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");

const approval: ThreadPendingApproval = {
  requestId,
  requestKind: "command",
  createdAt: "2026-10-19T00:00:00Z",
  responseCapability: "live",
};
const secondApproval: ThreadPendingApproval = {
  ...approval,
  requestId: RuntimeRequestId.make("second-approval"),
};

describe("declining approvals before sending", () => {
  it("declines every approval before the send continues", async () => {
    let resolve!: (value: ApprovalResponse) => void;
    const firstResponse = new Promise<ApprovalResponse>((done) => {
      resolve = done;
    });
    const respond = vi.fn<ApprovalResponder>(async (id) =>
      id === requestId ? firstResponse : AsyncResult.success(undefined),
    );
    const send = vi.fn();
    const submission = (async () => {
      if (await declinePendingApprovals([approval, secondApproval], respond)) send();
    })();
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
    expect(send).not.toHaveBeenCalled();
    resolve(AsyncResult.success(undefined));
    await submission;
    expect(respond).toHaveBeenCalledWith(secondApproval.requestId, "decline");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([AsyncResult.failure(Cause.fail("decline failed")), undefined])(
    "does not send when a decline is unsuccessful: %s",
    async (response) => {
      const send = vi.fn();
      if (await declinePendingApprovals([approval], async () => response)) send();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("skips approvals the provider can no longer answer", async () => {
    const respond = vi.fn(async () => AsyncResult.success(undefined));
    expect(
      await declinePendingApprovals(
        [{ ...approval, responseCapability: "not_resumable" }],
        respond,
      ),
    ).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });
});

const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("approval feedback", () => {
  const approvalTurnItem: OrchestrationV2ThreadProjection["turnItems"][number] = {
    ...projection.turnItems[0]!,
    providerThreadId: null,
    id: TurnItemId.make("approval-item"),
    type: "approval_request",
    requestId,
    requestKind: "command",
    prompt: "Run pwd?",
    reason: "This command matched an ask rule.",
    fullAccessOverride: "ask_rule",
  };
  const feedbackRequest = {
    ...projection.runtimeRequests[0]!,
    kind: "command",
    responseCapability: {
      type: "live",
      providerSessionId: ProviderSessionId.make("claude-session"),
      supportsFeedback: true,
    },
  } satisfies OrchestrationV2RuntimeRequest;
  const unrelatedRequest = {
    ...feedbackRequest,
    id: secondApproval.requestId,
    responseCapability: {
      type: "live",
      providerSessionId: ProviderSessionId.make("other-session"),
    },
  } satisfies OrchestrationV2RuntimeRequest;

  it("routes trimmed feedback only to the displayed request", async () => {
    const pending = derivePendingThreadRequests({
      runtimeRequests: [feedbackRequest, unrelatedRequest],
      turnItems: [approvalTurnItem],
    });
    expect(pending.approvals[0]).toMatchObject({
      requestId,
      reason: "This command matched an ask rule.",
      fullAccessOverride: "ask_rule",
      supportsFeedback: true,
    });
    expect(pending.approvals[1]?.supportsFeedback).toBeUndefined();

    const respond = vi.fn<ApprovalResponder>(async () => AsyncResult.success(undefined));
    expect(await sendApprovalFeedback(pending.approvals[0]!, "  Safer please.  ", respond)).toBe(
      true,
    );
    expect(respond.mock.calls).toEqual([[requestId, "decline", "Safer please."]]);
  });

  it("keeps feedback unsent when unsupported, stale, empty, or rejected", async () => {
    const respond = vi.fn<ApprovalResponder>(async () => AsyncResult.failure(Cause.fail("failed")));
    expect(await sendApprovalFeedback(approval, "Safer please.", respond)).toBe(false);
    expect(
      await sendApprovalFeedback(
        { ...approval, supportsFeedback: true, responseCapability: "not_resumable" },
        "Safer please.",
        respond,
      ),
    ).toBe(false);
    expect(await sendApprovalFeedback({ ...approval, supportsFeedback: true }, "  ", respond)).toBe(
      false,
    );
    expect(respond).not.toHaveBeenCalled();
    expect(
      await sendApprovalFeedback({ ...approval, supportsFeedback: true }, "Safer please.", respond),
    ).toBe(false);
  });

  it("explains both reasons a full-access request can still need approval", () => {
    expect(fullAccessOverrideExplanation("ask_rule")).toContain("ask rule");
    expect(fullAccessOverrideExplanation("provider_check")).toContain("safety checks");
  });
});

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });

  it("removes answered requests from the composer while retaining their answers in projection data", () => {
    const answered = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
        resolvedAt: v2Now,
        answers: { next: "  continue  " },
      })),
    };
    expect(derivePendingThreadRequests(answered).userInputs).toEqual([]);
    expect(answered.runtimeRequests[0]?.answers).toEqual({ next: "  continue  " });
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});
