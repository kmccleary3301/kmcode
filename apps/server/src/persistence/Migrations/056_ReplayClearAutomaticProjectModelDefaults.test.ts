import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.6-sol"}';

layer("056_ReplayClearAutomaticProjectModelDefaults", (it) => {
  it.effect("clears seeded project defaults on databases that recorded id 44 for KM Code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      // The pre-sync KM Code schema: its native checkpoint column took id 44.
      yield* sql`
        ALTER TABLE projection_turns
        ADD COLUMN native_checkpoint_json TEXT NOT NULL DEFAULT 'null'
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (44, 'ProjectionTurnNativeCheckpoint')
      `;

      for (const projectId of ["project-seeded", "project-configured"]) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json, scripts_json,
            created_at, updated_at, deleted_at
          )
          VALUES (
            ${projectId}, ${projectId}, '/tmp', ${MODEL_SELECTION}, '[]',
            '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
          )
        `;
      }
      const projectEvent = (
        eventId: string,
        projectId: string,
        version: number,
        eventType: string,
      ) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          ${eventId}, 'project', ${projectId}, ${version}, ${eventType},
          '2026-05-01T00:00:00.000Z', ${eventId}, NULL, ${eventId}, 'client',
          ${JSON.stringify({ projectId, defaultModelSelection: JSON.parse(MODEL_SELECTION) })}, '{}'
        )
      `;
      yield* projectEvent("seeded-created", "project-seeded", 0, "project.created");
      yield* projectEvent("configured-created", "project-configured", 0, "project.created");
      yield* projectEvent("configured-updated", "project-configured", 1, "project.meta-updated");

      const executed = yield* runMigrations();
      assert.ok(
        !executed.some(([id]) => id === 44),
        "id 44 is already recorded, so upstream's repair can only arrive through the replay",
      );

      const projects = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT project_id AS "projectId", default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(projects, [
        { projectId: "project-configured", defaultModelSelection: MODEL_SELECTION },
        { projectId: "project-seeded", defaultModelSelection: null },
      ]);
    }),
  );
});
