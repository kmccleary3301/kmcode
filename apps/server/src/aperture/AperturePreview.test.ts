import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { authorizeAperturePreviewRequest } from "./AperturePreview.ts";

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
