import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_ProjectionTurnNativeCheckpoint", (it) => {
  it.effect("finishes after the column was added before the migration was recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        ALTER TABLE projection_turns
        ADD COLUMN native_checkpoint_json TEXT NOT NULL DEFAULT 'null'
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.strictEqual(
        columns.filter((column) => column.name === "native_checkpoint_json").length,
        1,
      );
    }),
  );
});
