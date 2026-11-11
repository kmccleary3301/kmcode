import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Startup recovery scans open provider turns; without this the scan walks all turn history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_open_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id, thread_id)
    WHERE status IN ('pending', 'running')
  `;
});
