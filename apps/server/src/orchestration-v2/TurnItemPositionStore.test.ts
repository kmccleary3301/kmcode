import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("orders runs by the order they start, not by run ordinal", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:start-order");
    const allocate = (item: string, run: string, runOrdinal: number) =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(item),
        runId: RunId.make(run),
        runOrdinal,
      });

    // Run 5 starts ahead of the still-queued run 3.
    assert.equal(yield* allocate("item:run5-first", "run:5", 5), 5_000_001);
    const run3First = yield* allocate("item:run3-first", "run:3", 3);
    assert.isAbove(run3First, 5_999_999);
    assert.equal(yield* allocate("item:run3-next", "run:3", 3), run3First + 1);
    // A late item for run 5 stays with run 5's items.
    assert.equal(yield* allocate("item:run5-late", "run:5", 5), 5_000_002);
    // A run that starts in order keeps its own ordinal's block.
    assert.equal(yield* allocate("item:run9-first", "run:9", 9), 9_000_001);
  }).pipe(Effect.provide(layerTest)),
);
