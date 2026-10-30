import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  OrchestrationV2ContextHandoffJson,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  contextHandoffDeliveryIds,
  packContextHandoffDelivery,
} from "./ContextHandoffDeliveryIds.ts";

const now = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
const threadId = ThreadId.make("native:omp:thread");
const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) =>
    TurnItemId.make(`${prefix}:turn-item:${threadId}:${String(index).padStart(6, "0")}`),
  );
const handoff = (
  delivery: OrchestrationV2ContextHandoff["delivery"],
): OrchestrationV2ContextHandoff => ({
  id: ContextHandoffId.make("handoff:one"),
  threadId,
  targetRunId: RunId.make("run:target"),
  fromProviderThreadIds: [],
  toProviderThreadId: ProviderThreadId.make("provider-thread:target"),
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "summary",
  ...(delivery === undefined ? {} : { delivery }),
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
});
const handoffJson = Schema.fromJsonString(OrchestrationV2ContextHandoffJson);

describe("context handoff delivery IDs", () => {
  it("packs large deliveries and reads back every ID after persistence", () => {
    const itemIds = ids("delivered", 40);
    const omittedItemIds = ids("omitted", 3_000);
    const original = handoff({
      nativeThreadId: "native",
      status: "injected",
      itemIds,
      omittedItemIds,
    });

    const packed = packContextHandoffDelivery(original);
    const persisted = Schema.encodeSync(handoffJson)(packed);
    const restored = Schema.decodeUnknownSync(handoffJson)(persisted);

    assert.deepStrictEqual(restored.delivery?.itemIds, []);
    assert.strictEqual(restored.delivery?.omittedItemIds, undefined);
    assert.isBelow(persisted.length, Schema.encodeSync(handoffJson)(original).length / 4);
    assert.deepStrictEqual(contextHandoffDeliveryIds(restored.delivery), {
      itemIds,
      omittedItemIds,
    });
  });

  it("keeps small deliveries inline", () => {
    const original = handoff({
      nativeThreadId: "native",
      status: "inline",
      itemIds: [TurnItemId.make("item:one")],
    });

    assert.strictEqual(packContextHandoffDelivery(original), original);
    assert.deepStrictEqual(contextHandoffDeliveryIds(original.delivery), {
      itemIds: [TurnItemId.make("item:one")],
      omittedItemIds: [],
    });
  });

  it("keeps packed IDs when an update re-emits a packed row with new inline IDs", () => {
    const packed = packContextHandoffDelivery(
      handoff({
        nativeThreadId: "native",
        status: "injected",
        itemIds: ids("delivered", 40),
        omittedItemIds: ids("omitted", 3_000),
      }),
    );
    assert.isDefined(packed.delivery?.coverageIdsCompressed);
    const extra = TurnItemId.make("item:extra");
    const updated = handoff({ ...packed.delivery!, itemIds: [extra] });

    const repacked = contextHandoffDeliveryIds(packContextHandoffDelivery(updated).delivery);

    assert.deepStrictEqual(repacked.itemIds, [...ids("delivered", 40), extra]);
    assert.deepStrictEqual(repacked.omittedItemIds, ids("omitted", 3_000));
  });
});
