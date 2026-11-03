import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Record each position's run so a run keeps the position block its first item got.
// Blocks follow the order runs start in, which differs from run order when a later
// message starts while earlier ones are still queued.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_turn_item_positions ADD COLUMN run_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_turn_item_positions
    SET run_id = (
      SELECT item.run_id
      FROM orchestration_v2_projection_turn_items item
      WHERE item.turn_item_id = orchestration_v2_turn_item_positions.turn_item_id
        AND item.thread_id = orchestration_v2_turn_item_positions.thread_id
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_turn_item_positions_run_idx
    ON orchestration_v2_turn_item_positions(thread_id, run_id, ordinal)
    WHERE run_id IS NOT NULL
  `;
});
