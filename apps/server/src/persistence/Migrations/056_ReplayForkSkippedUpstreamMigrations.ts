import * as Effect from "effect/Effect";

import AuthSessionClientConnection from "./041_AuthSessionClientConnection.ts";
import ClearAutomaticProjectModelDefaults from "./044_ClearAutomaticProjectModelDefaults.ts";
import ProjectionProjectsAutoPull from "./045_ProjectionProjectsAutoPull.ts";
import RepairAutomaticSettlementTimestamps from "./046_RepairAutomaticSettlementTimestamps.ts";

/**
 * KM Code builds recorded their own migrations in slots upstream later
 * claimed: native checkpoints in 41 and then 44, and pre-sync work in 45 and
 * 46. The migrator skips every id at or below the latest recorded one, so
 * those databases never ran upstream's 41, 44, 45, or 46. Each replay is
 * idempotent where the original already ran: 41 and 45 guard their columns,
 * 44 clears only defaults no project update ever configured, and 46 matches
 * only settlements whose timestamp still equals the sweep time.
 */
export default Effect.gen(function* () {
  yield* AuthSessionClientConnection;
  yield* ClearAutomaticProjectModelDefaults;
  yield* ProjectionProjectsAutoPull;
  yield* RepairAutomaticSettlementTimestamps;
});
