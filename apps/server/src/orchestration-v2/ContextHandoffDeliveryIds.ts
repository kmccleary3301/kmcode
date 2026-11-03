import { deflateSync, inflateSync } from "node:zlib";

import { TurnItemId, type OrchestrationV2ContextHandoff } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type ContextHandoffDelivery = NonNullable<OrchestrationV2ContextHandoff["delivery"]>;

// Settled handoffs repeat every covered turn-item ID, so long threads stored about
// 70 MB of IDs that every turn start read synchronously. Deflate stores them in
// about a sixteenth of the space. The format matches the offline compaction tool.
const PACKED_IDS_PREFIX = "deflate-v1:";

const decodePackedIds = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      itemIds: Schema.Array(TurnItemId),
      omittedItemIds: Schema.Array(TurnItemId),
    }),
  ),
);

export interface ContextHandoffDeliveryIds {
  readonly itemIds: ReadonlyArray<TurnItemId>;
  readonly omittedItemIds: ReadonlyArray<TurnItemId>;
}

const EMPTY_IDS: ContextHandoffDeliveryIds = { itemIds: [], omittedItemIds: [] };

function unpackIds(packed: string): ContextHandoffDeliveryIds {
  if (!packed.startsWith(PACKED_IDS_PREFIX)) {
    throw new Error("Unsupported packed context handoff delivery ID format.");
  }
  const json = inflateSync(Buffer.from(packed.slice(PACKED_IDS_PREFIX.length), "base64"));
  return decodePackedIds(json.toString("utf8"));
}

/** Every item ID a delivery covers, whether it is stored inline or packed. */
export function contextHandoffDeliveryIds(
  delivery: ContextHandoffDelivery | undefined,
): ContextHandoffDeliveryIds {
  if (delivery === undefined) return EMPTY_IDS;
  const inline = { itemIds: delivery.itemIds, omittedItemIds: delivery.omittedItemIds ?? [] };
  if (delivery.coverageIdsCompressed === undefined) return inline;
  const packed = unpackIds(delivery.coverageIdsCompressed);
  if (inline.itemIds.length === 0 && inline.omittedItemIds.length === 0) return packed;
  return {
    itemIds: [...new Set([...packed.itemIds, ...inline.itemIds])],
    omittedItemIds: [...new Set([...packed.omittedItemIds, ...inline.omittedItemIds])],
  };
}

/**
 * Stores a delivery's item IDs packed when that is smaller. Read them back with
 * `contextHandoffDeliveryIds`; the inline arrays of a packed delivery are empty.
 */
export function packContextHandoffDelivery(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const delivery = handoff.delivery;
  if (delivery === undefined) return handoff;
  const inlineCount = delivery.itemIds.length + (delivery.omittedItemIds?.length ?? 0);
  if (inlineCount === 0) return handoff;
  // An event built from a packed projection row can carry both forms; merge them.
  const ids = contextHandoffDeliveryIds(delivery);
  const json = JSON.stringify({ itemIds: ids.itemIds, omittedItemIds: ids.omittedItemIds });
  const packed = `${PACKED_IDS_PREFIX}${deflateSync(Buffer.from(json)).toString("base64")}`;
  if (delivery.coverageIdsCompressed === undefined && packed.length >= json.length) return handoff;
  const { omittedItemIds: _omittedItemIds, ...rest } = delivery;
  return { ...handoff, delivery: { ...rest, itemIds: [], coverageIdsCompressed: packed } };
}
