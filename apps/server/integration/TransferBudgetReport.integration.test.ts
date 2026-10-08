import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import type {
  HttpTransferMeasurement,
  WebSocketTransferTotals,
} from "./NetworkTransferMeasurement.integration.ts";
import {
  formatTransferBudgetResult,
  transferBudgetViolations,
  type TransferBudgetRun,
} from "./TransferBudgetReport.integration.ts";

const httpMeasurement = (wireBytes: number): HttpTransferMeasurement => ({
  status: 200,
  contentEncoding: "gzip",
  encodedBody: new Uint8Array(wireBytes),
  encodedBodyBytes: wireBytes,
  decodedBody: new Uint8Array(112_000),
  decodedBodyBytes: 112_000,
  wireBytes,
});

const webSocketMeasurement = (
  overrides?: Partial<WebSocketTransferTotals>,
): WebSocketTransferTotals => ({
  wireBytes: 6_900,
  decodedBytes: 57_000,
  messages: 20,
  largestMessageBytes: 6_500,
  ...overrides,
});

const run = (overrides?: Partial<TransferBudgetRun>): TransferBudgetRun => ({
  provider: ProviderDriverKind.make("codex"),
  threadSnapshot: httpMeasurement(7_100),
  resumedThreadSnapshot: httpMeasurement(7_100),
  measuredTurnWebSocket: webSocketMeasurement(),
  fanoutClients: 2,
  ...overrides,
});

it("binds the machine report to an exact source head", () => {
  const sourceHead = "a".repeat(40);
  const result = JSON.parse(formatTransferBudgetResult([run()], sourceHead));
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.sourceHead, sourceHead);
  assert.throws(() => formatTransferBudgetResult([run()], "stale"), /full Git SHA/);
});

it("fails when a retained large result exceeds the cold bootstrap ceiling", () => {
  assert.deepEqual(transferBudgetViolations([run()]), []);
  assert.deepEqual(transferBudgetViolations([run({ threadSnapshot: httpMeasurement(7_501) })]), [
    "codex: thread snapshot wire bytes was 7501, maximum 7500",
  ]);
});

it("fails when a resumed client replays a full snapshot", () => {
  assert.deepEqual(
    transferBudgetViolations([run({ resumedThreadSnapshot: httpMeasurement(7_501) })]),
    ["codex: resumed thread snapshot wire bytes was 7501, maximum 7500"],
  );
});

it("fails when duplicated task events exceed the message ceiling", () => {
  assert.deepEqual(
    transferBudgetViolations([
      run({ measuredTurnWebSocket: webSocketMeasurement({ messages: 22 }) }),
    ]),
    ["codex: measured-turn WebSocket messages was 22, maximum 21"],
  );
});

it("fails when frame, decoded, or fanout ceilings regress", () => {
  assert.deepEqual(
    transferBudgetViolations([
      run({
        measuredTurnWebSocket: webSocketMeasurement({
          wireBytes: 8_001,
          decodedBytes: 68_001,
          largestMessageBytes: 18_001,
        }),
        fanoutClients: 3,
      }),
    ]),
    [
      "codex: measured-turn WebSocket wire bytes was 8001, maximum 8000",
      "codex: measured-turn WebSocket decoded bytes was 68001, maximum 68000",
      "codex: measured-turn largest WebSocket message bytes was 18001, maximum 18000",
      "codex: fanout clients was 3, maximum 2",
    ],
  );
});
