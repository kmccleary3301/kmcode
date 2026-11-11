import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentOrchestrationThreadActivityPageQuery,
  EnvironmentOrchestrationThreadHistoryQuery,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

const traceId = "trace-1";

describe("environment HTTP errors", () => {
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});

describe("orchestration HTTP query contracts", () => {
  const decodeActivityQuery = Schema.decodeUnknownSync(
    EnvironmentOrchestrationThreadActivityPageQuery,
  );
  const decodeHistoryQuery = Schema.decodeUnknownSync(EnvironmentOrchestrationThreadHistoryQuery);

  it("decodes bounded activity page query values and requires a page selector", () => {
    expect(
      decodeActivityQuery({
        anchorItemId: "item-1",
        limit: "75",
        summaryOnly: "true",
      }),
    ).toMatchObject({ anchorItemId: "item-1", limit: 75, summaryOnly: true });
    expect(
      decodeActivityQuery({
        sourceThreadId: "thread-1",
        groupStartItemId: "item-1",
        cursor: "adjacent-page",
      }),
    ).toMatchObject({
      sourceThreadId: "thread-1",
      groupStartItemId: "item-1",
      cursor: "adjacent-page",
    });

    for (const query of [
      {},
      { sourceThreadId: "thread-1" },
      { groupStartItemId: "item-1" },
      { anchorItemId: "item-1", limit: "0" },
      { anchorItemId: "item-1", limit: "76" },
      { anchorItemId: "item-1", limit: "1.5" },
      { anchorItemId: "item-1", cursor: "x".repeat(4_097) },
      { anchorItemId: "item-1", summaryOnly: "yes" },
    ]) {
      expect(() => decodeActivityQuery(query)).toThrow();
    }
  });

  it("accepts history cursors or direct targets, but never an unanchored request", () => {
    expect(decodeHistoryQuery({ throughEntryId: "item-1" })).toMatchObject({
      throughEntryId: "item-1",
    });
    expect(decodeHistoryQuery({ cursor: "older-page" })).toMatchObject({
      cursor: "older-page",
    });
    expect(() => decodeHistoryQuery({})).toThrow();
  });
});
