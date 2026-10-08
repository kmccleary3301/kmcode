import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.6-sol"}';

/** Migration records KM Code builds left above upstream's 40, as found on real installs. */
const FORK_HISTORIES = [
  { label: "an early release", records: [[41, "ProjectionTurnNativeCheckpoint"]] },
  {
    label: "the pre-sync release",
    records: [
      [41, "ProjectionTurnNativeCheckpoint"],
      [42, "ProjectionThreadLinkedPullRequest"],
      [43, "ProjectionThreadsUnsettledAt"],
      [44, "ProjectionTurnNativeCheckpoint"],
    ],
  },
  {
    label: "a pre-sync development build",
    records: [
      [41, "ProjectionTurnNativeCheckpoint"],
      [42, "ProjectionThreadLinkedPullRequest"],
      [43, "ProjectionThreadsUnsettledAt"],
      [44, "ProjectionTurnNativeCheckpoint"],
      [45, "RepairAuthSessionClientConnection"],
      [46, "ProjectionThreadMessageCreatedSequence"],
    ],
  },
] as const;

for (const history of FORK_HISTORIES) {
  layer(`056_ReplayForkSkippedUpstreamMigrations from ${history.label}`, (it) => {
    it.effect("applies the upstream migrations its recorded slots skipped", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const latest = history.records.at(-1)![0];
        // Upstream 42 and 43 match the fork's; only 41 and 44+ diverge.
        yield* runMigrations({ toMigrationInclusive: latest >= 43 ? 43 : 40 });
        if (latest >= 43) {
          yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_surface`;
          yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_app_version`;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 40`;
        }
        yield* sql`
          ALTER TABLE projection_turns
          ADD COLUMN native_checkpoint_json TEXT NOT NULL DEFAULT 'null'
        `;
        for (const [id, name] of history.records) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
          `;
        }

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
        assert.ok(executed.every(([id]) => id > latest));
        assert.ok(executed.some(([id]) => id === 56));

        const columns = (table: string) =>
          sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
            Effect.map((rows) => rows.map((row) => row.name)),
          );
        const authColumns = yield* columns("auth_sessions");
        assert.includeMembers(authColumns, ["client_surface", "client_app_version"]);
        assert.include(yield* columns("projection_projects"), "auto_pull");

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

        // A second start must find nothing left to do.
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
    );
  });
}
