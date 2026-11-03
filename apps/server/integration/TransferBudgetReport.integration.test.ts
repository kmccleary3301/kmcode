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
  type WebSocketCatchUpMeasurement,
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
  wireBytes: 1_800,
  decodedBytes: 25_000,
  messages: 6,
  largestMessageBytes: 600,
  ...overrides,
});

const catchUpMeasurement = (mode: "replay" | "snapshot"): WebSocketCatchUpMeasurement => ({
  ...webSocketMeasurement(),
  mode,
});

const run = (overrides?: Partial<TransferBudgetRun>): TransferBudgetRun => ({
  provider: ProviderDriverKind.make("codex"),
  threadSnapshot: httpMeasurement(4_500),
  measuredTurnWebSocket: webSocketMeasurement(),
  shellSnapshot: httpMeasurement(1_000),
  measuredTurnShellWebSocket: webSocketMeasurement(),
  measuredTurnSecondClientWebSocket: webSocketMeasurement(),
  reconnectThread: catchUpMeasurement("replay"),
  reconnectShell: catchUpMeasurement("replay"),
  measuredTurnSqlStatements: 5,
  reconnectSqlStatements: 2,
  ...overrides,
});

it("formats the machine report with expected schema version and providers", () => {
  const result = JSON.parse(formatTransferBudgetResult([run()]));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scenario.id, "thread-transfer-v2");
  assert.isDefined(result.providers.codex);
  assert.equal(result.providers.codex.ceiling.totalWireBytes, 7_000);
});

it("passes when measurements are within budget", () => {
  assert.deepEqual(transferBudgetViolations([run()]), []);
});

it("fails when a retained large result exceeds the cold bootstrap ceiling", () => {
  assert.deepEqual(transferBudgetViolations([run({ threadSnapshot: httpMeasurement(5_001) })]), [
    "codex: thread snapshot wire bytes was 5001, maximum 5000",
  ]);
});

it("fails when turn messages exceed the message ceiling", () => {
  assert.deepEqual(
    transferBudgetViolations([
      run({ measuredTurnWebSocket: webSocketMeasurement({ messages: 9 }) }),
    ]),
    ["codex: measured-turn WebSocket messages was 9, maximum 8"],
  );
});

it("fails when turn wire bytes exceed the budget", () => {
  assert.deepEqual(
    transferBudgetViolations([
      run({ measuredTurnWebSocket: webSocketMeasurement({ wireBytes: 2_001 }) }),
    ]),
    ["codex: measured-turn WebSocket wire bytes was 2001, maximum 2000"],
  );
});
