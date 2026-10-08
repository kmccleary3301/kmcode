/**
 * KM Code databases recorded id 44 for ProjectionTurnNativeCheckpoint before
 * upstream claimed that id for ClearAutomaticProjectModelDefaults. The migrator
 * skips every id at or below the latest recorded one, so those databases never
 * ran the upstream repair. Replaying it is a no-op where it already ran:
 * project creation now records a null default model selection.
 */
export { default } from "./044_ClearAutomaticProjectModelDefaults.ts";
