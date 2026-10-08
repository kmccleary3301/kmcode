import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.6-sol"}';

/** Ledgers older KM Code builds left, as found on real installs. */
const FORK_HISTORIES = [
  {
    label: "an early release",
    upstreamThrough: 40,
    forkRecords: [[41, "ProjectionTurnNativeCheckpoint"]],
  },
  {
    label: "the pre-sync release",
    upstreamThrough: 43,
    forkRecords: [
      [41, "ProjectionTurnNativeCheckpoint"],
      [44, "ProjectionTurnNativeCheckpoint"],
    ],
  },
  {
    label: "a pre-sync development build",
    upstreamThrough: 43,
    forkRecords: [
      [41, "ProjectionTurnNativeCheckpoint"],
      [44, "ProjectionTurnNativeCheckpoint"],
      [45, "RepairAuthSessionClientConnection"],
      [46, "ProjectionThreadMessageCreatedSequence"],
    ],
  },
  {
    label: "a sync preview build",
    upstreamThrough: 54,
    forkRecords: [
      [55, "ProjectionTurnNativeCheckpoint"],
      [56, "ReplayForkSkippedUpstreamMigrations"],
    ],
  },
] as const;

for (const history of FORK_HISTORIES) {
  it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
    `fork migration ledger from ${history.label}`,
    (it) => {
      it.effect("converges on upstream's ledger and schema plus the fork's own", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Projects predate every history's divergence from upstream.
          yield* runMigrations({ toMigrationInclusive: 40 });

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
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json
            )
            VALUES (
              ${eventId}, 'project', ${projectId}, ${version}, ${eventType},
              '2026-05-01T00:00:00.000Z', ${eventId}, NULL, ${eventId}, 'client',
              ${JSON.stringify({ projectId, defaultModelSelection: JSON.parse(MODEL_SELECTION) })},
              '{}'
            )
          `;
          yield* projectEvent("seeded-created", "project-seeded", 0, "project.created");
          yield* projectEvent("configured-created", "project-configured", 0, "project.created");
          yield* projectEvent(
            "configured-updated",
            "project-configured",
            1,
            "project.meta-updated",
          );

          yield* runMigrations({ toMigrationInclusive: history.upstreamThrough });
          // Where the fork recorded native checkpoints at 41, upstream's 41 never ran.
          if (history.upstreamThrough >= 41 && history.forkRecords.some(([id]) => id === 41)) {
            yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_surface`;
            yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_app_version`;
            yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 41`;
          }
          yield* sql`
            ALTER TABLE projection_turns
            ADD COLUMN native_checkpoint_json TEXT NOT NULL DEFAULT 'null'
          `;
          for (const [id, name] of history.forkRecords) {
            yield* sql`
              INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
            `;
          }

          yield* runMigrations();

          const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
          `;
          assert.deepStrictEqual(
            ledger.map((row) => [row.migration_id, row.name]),
            migrationManifest.map(([id, name]) => [id, name]),
          );
          const forkLedger = yield* sql<{ readonly name: string }>`
            SELECT name FROM kmcode_migrations
          `;
          assert.deepStrictEqual(
            forkLedger.map((row) => row.name),
            ["ProjectionTurnNativeCheckpoint"],
          );

          const columns = (table: string) =>
            sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
              Effect.map((rows) => rows.map((row) => row.name)),
            );
          assert.includeMembers(yield* columns("auth_sessions"), [
            "client_surface",
            "client_app_version",
          ]);
          assert.include(yield* columns("projection_projects"), "auto_pull");
          assert.include(yield* columns("projection_turns"), "native_checkpoint_json");

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

          assert.deepStrictEqual(yield* runMigrations(), []);
        }),
      );
    },
  );
}

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "fork migration ledger on a fresh database",
  (it) => {
    it.effect("adds the fork's schema without touching upstream's ledger", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed.map(([id, name]) => [id, name]),
          migrationManifest.map(([id, name]) => [id, name]),
        );
        const columns = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info('projection_turns')
        `;
        assert.include(
          columns.map((column) => column.name),
          "native_checkpoint_json",
        );
      }),
    );
  },
);
