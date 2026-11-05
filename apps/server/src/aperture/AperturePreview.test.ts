import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  authorizeAperturePreviewRequest,
  inspectAperturePreviewDataResponse,
  resolveAperturePreviewDataStatus,
} from "./AperturePreview.ts";

const arrowMessage = (headerType: 1 | 3, rows = 0): Uint8Array => {
  const metadataLength = headerType === 1 ? 52 : 64;
  const bytes = new Uint8Array(4 + metadataLength);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, metadataLength, true);
  view.setUint32(4, 16, true);
  view.setUint16(8, 12, true);
  view.setUint16(10, 24, true);
  view.setUint16(12, 4, true);
  view.setUint16(14, 5, true);
  view.setUint16(16, 8, true);
  view.setUint16(18, 16, true);
  view.setInt32(20, 12, true);
  view.setUint8(24, 4);
  view.setUint8(25, headerType);
  view.setUint32(28, 24, true);
  view.setBigInt64(36, 0n, true);
  if (headerType === 1) {
    view.setUint16(48, 4, true);
    view.setUint16(50, 4, true);
    view.setInt32(52, 4, true);
  } else {
    view.setUint16(44, 6, true);
    view.setUint16(46, 16, true);
    view.setUint16(48, 8, true);
    view.setInt32(52, 8, true);
    view.setBigInt64(60, BigInt(rows), true);
  }
  return bytes;
};

const arrowHistoryResponse = (rows = 0): Uint8Array => {
  const schema = arrowMessage(1);
  const recordBatch = arrowMessage(3, rows);
  const bytes = new Uint8Array(schema.length + recordBatch.length + 8);
  bytes.set(schema);
  bytes.set(recordBatch, schema.length);
  const end = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8);
  end.setInt32(0, -1, true);
  end.setInt32(4, 0, true);
  return bytes;
};
const QueryResultSchema = Schema.Struct({ as_of: Schema.Number });

describe("Aperture preview bridge authorization", () => {
  it("pins history query requests to the preview timestamp", () => {
    const decision = authorizeAperturePreviewRequest({
      entity: "admin",
      project: "demo",
      asOf: "2020-01-01T00:00:00.000Z",
      method: "POST",
      path: "/api/v1/query",
      body: JSON.stringify({
        kind: "history",
        project: "admin/demo",
        runs: { ids: ["run-1"] },
        keys: ["train/loss"],
        as_of: 2_000_000_000,
      }),
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed || decision.body === null)
      throw new Error("expected an allowed query body");
    const query = Schema.decodeUnknownSync(QueryResultSchema)(JSON.parse(decision.body));
    expect(query.as_of).toBe(1_577_836_800);
  });

  it("rejects live endpoints and requests outside the preview project", () => {
    const live = authorizeAperturePreviewRequest({
      entity: "admin",
      project: "demo",
      asOf: "2020-01-01T00:00:00.000Z",
      method: "POST",
      path: "/api/v1/live",
      body: JSON.stringify({ subscriptions: [] }),
    });
    expect(live).toMatchObject({ allowed: false, code: "pinned_live_denied" });

    const otherProject = authorizeAperturePreviewRequest({
      entity: "admin",
      project: "demo",
      asOf: "2020-01-01T00:00:00.000Z",
      method: "POST",
      path: "/api/v1/query",
      body: JSON.stringify({ kind: "history", project: "admin/other", runs: { ids: ["run-1"] } }),
    });
    expect(otherProject).toMatchObject({ allowed: false, code: "policy_denied" });
  });
});
describe("Aperture preview data status", () => {
  it("classifies empty and nonempty JSON history and runs responses", () => {
    const contentType = "application/json; charset=utf-8";
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 200,
        contentType,
        bytes: encode({
          kind: "history",
          series: [{ run: "run-1", key: "train/loss", step: [], x: [], y: [] }],
        }),
      }),
    ).toBe("empty");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 200,
        contentType,
        bytes: encode({
          kind: "history",
          series: [{ run: "run-1", key: "train/loss", step: [1], x: [1], y: [0.5] }],
        }),
      }),
    ).toBe("present");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "runs",
        status: 200,
        contentType,
        bytes: encode({ kind: "runs", runs: [] }),
      }),
    ).toBe("empty");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "runs",
        status: 200,
        contentType,
        bytes: encode({ kind: "runs", runs: [{ id: "run-1" }] }),
      }),
    ).toBe("present");
  });

  it("classifies Arrow history by record-batch row count", () => {
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 200,
        contentType: "application/vnd.apache.arrow.stream",
        bytes: arrowHistoryResponse(),
      }),
    ).toBe("empty");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 200,
        contentType: "application/vnd.apache.arrow.stream",
        bytes: arrowHistoryResponse(2),
      }),
    ).toBe("present");
  });

  it("keeps absent, failed, malformed, and unsupported query responses unknown", () => {
    expect(resolveAperturePreviewDataStatus([])).toBe("unknown");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 502,
        contentType: "application/json",
        bytes: new TextEncoder().encode('{"kind":"history","series":[]}'),
      }),
    ).toBe("unknown");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 200,
        contentType: "application/octet-stream",
        bytes: arrowHistoryResponse(),
      }),
    ).toBe("unknown");
    expect(
      inspectAperturePreviewDataResponse({
        kind: "history",
        status: 200,
        contentType: "application/json",
        bytes: new TextEncoder().encode('{"kind":"history","series":null}'),
      }),
    ).toBe("unknown");
    expect(resolveAperturePreviewDataStatus(["empty", "unknown"])).toBe("unknown");
  });

  it("reports present if any supported query returns data", () => {
    expect(resolveAperturePreviewDataStatus(["empty", "empty"])).toBe("empty");
    expect(resolveAperturePreviewDataStatus(["empty", "present", "unknown"])).toBe("present");
  });
});
