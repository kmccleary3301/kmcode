import { OrchestrationV2ContextHandoffJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { packContextHandoffDelivery } from "../../orchestration-v2/ContextHandoffDeliveryIds.ts";

const handoffJson = Schema.fromJsonString(OrchestrationV2ContextHandoffJson);
const decodeHandoff = Schema.decodeUnknownOption(handoffJson);
const encodeHandoff = Schema.encodeSync(handoffJson);

const PAGE_SIZE = 16;

// Pack the delivery IDs that projection rows already hold; new rows are packed on write.
// A row that does not decode is left as it is: packing only saves space.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let afterRowId = 0;
  while (true) {
    const rows = yield* sql<{ readonly row_id: number; readonly payload_json: string }>`
      SELECT rowid AS row_id, payload_json
      FROM orchestration_v2_projection_context_handoffs
      WHERE rowid > ${afterRowId}
      ORDER BY rowid ASC
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      const decoded = decodeHandoff(row.payload_json);
      if (decoded._tag === "None") continue;
      const packed = packContextHandoffDelivery(decoded.value);
      if (packed === decoded.value) continue;
      yield* sql`
        UPDATE orchestration_v2_projection_context_handoffs
        SET payload_json = ${encodeHandoff(packed)}
        WHERE rowid = ${row.row_id}
      `;
    }
    if (rows.length < PAGE_SIZE) break;
    afterRowId = rows[rows.length - 1]!.row_id;
  }
});
