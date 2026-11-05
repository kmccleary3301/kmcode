import { describe, expect, it } from "vite-plus/test";

import type { ApertureEmbedTokenPayload } from "@t3tools/shared/apertureEmbed";
import { authorizeApertureEmbedRequest, clampPinnedApertureQuery } from "./ApertureEmbedPolicy.ts";

type PolicyRequest = Parameters<typeof authorizeApertureEmbedRequest>[0]["request"];

const token = {
  refId: "embed-ref",
  threadId: "thread-1",
  entity: "acme",
  project: "widgets",
  asOf: "2025-01-02T03:04:05Z",
} satisfies ApertureEmbedTokenPayload;

const policyRows = [
  {
    name: "GET viewer",
    request: { method: "GET", mode: "live", path: "/api/v1/viewer", body: null },
    allowed: true,
  },
  {
    name: "GET token entity",
    request: { method: "GET", mode: "live", path: "/api/v1/entities/acme", body: null },
    allowed: true,
  },
  {
    name: "GET token project",
    request: {
      method: "GET",
      mode: "live",
      path: "/api/v1/entities/acme/projects/widgets",
      body: null,
    },
    allowed: true,
  },
  {
    name: "POST scoped query",
    request: {
      method: "POST",
      mode: "live",
      path: "/api/v1/query",
      body: JSON.stringify({ project: "acme/widgets", kind: "history" }),
    },
    allowed: true,
  },
  {
    name: "POST pinned native query",
    request: {
      method: "POST",
      mode: "pinned",
      path: "/api/v1/query",
      body: JSON.stringify({ project: "acme/widgets", kind: "history" }),
    },
    allowed: true,
  },
  {
    name: "POST viewer",
    request: { method: "POST", mode: "live", path: "/api/v1/viewer", body: null },
    allowed: false,
  },
  {
    name: "GET query",
    request: { method: "GET", mode: "live", path: "/api/v1/query", body: null },
    allowed: false,
  },
  {
    name: "GET another entity",
    request: { method: "GET", mode: "live", path: "/api/v1/entities/other", body: null },
    allowed: false,
  },
  {
    name: "GET another project",
    request: {
      method: "GET",
      mode: "live",
      path: "/api/v1/entities/acme/projects/other",
      body: null,
    },
    allowed: false,
  },
  {
    name: "GET pinned runs",
    request: {
      method: "GET",
      mode: "pinned",
      path: "/api/v1/entities/acme/projects/widgets/runs",
      body: null,
    },
    allowed: false,
  },
  {
    name: "GET pinned run history",
    request: {
      method: "GET",
      mode: "pinned",
      path: "/api/v1/entities/acme/projects/widgets/runs/run-1/history",
      body: null,
    },
    allowed: false,
  },
  {
    name: "POST unsupported path",
    request: { method: "POST", mode: "live", path: "/api/v1/admin", body: null },
    allowed: false,
  },
  {
    name: "POST query outside token project",
    request: {
      method: "POST",
      mode: "live",
      path: "/api/v1/query",
      body: JSON.stringify({ project: "acme/other", kind: "history" }),
    },
    allowed: false,
  },
] satisfies ReadonlyArray<{ name: string; request: PolicyRequest; allowed: boolean }>;

describe("Aperture embed request policy", () => {
  for (const row of policyRows) {
    it(`${row.allowed ? "allows" : "denies"} ${row.name}`, () => {
      expect(authorizeApertureEmbedRequest({ request: row.request, token }).allowed).toBe(
        row.allowed,
      );
    });
  }

  it("rejects pinned live subscriptions with the pinned-live error", () => {
    const decision = authorizeApertureEmbedRequest({
      token,
      request: {
        method: "POST",
        mode: "pinned",
        path: "/api/v1/live",
        body: JSON.stringify({
          subscriptions: [{ topic: "project.runs", project: "acme/widgets" }],
        }),
      },
    });

    expect(decision).toMatchObject({ allowed: false, code: "pinned_live_denied" });
  });

  it("clamps native pinned as_of while preserving x and range", () => {
    const cases = [
      { clientAsOf: 2_000_000_000, expectedAsOf: 1_735_787_045 },
      { clientAsOf: 1_700_000_000, expectedAsOf: 1_700_000_000 },
    ];

    for (const { clientAsOf, expectedAsOf } of cases) {
      const body = JSON.stringify({
        kind: "history",
        project: "acme/widgets",
        as_of: clientAsOf,
        x: "latency",
        range: [10, 30],
      });
      const result = clampPinnedApertureQuery(body, token.asOf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.body)).toEqual({
          kind: "history",
          project: "acme/widgets",
          as_of: expectedAsOf,
          x: "latency",
          range: [10, 30],
        });
      }
    }
  });
  it("clamps every query kind with native as_of support", () => {
    for (const kind of ["history", "system", "band", "scan", "console", "stream"]) {
      const result = clampPinnedApertureQuery(
        JSON.stringify({ kind, project: "acme/widgets", as_of: 2_000_000_000 }),
        token.asOf,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.body)).toMatchObject({
          kind,
          as_of: 1_735_787_045,
        });
      }
    }
  });

  it("ANDs the pinned timestamp into the existing run filter in milliseconds", () => {
    const result = clampPinnedApertureQuery(
      JSON.stringify({
        kind: "runs",
        project: "acme/widgets",
        filter: { state: "running" },
      }),
      token.asOf,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.body)).toEqual({
        kind: "runs",
        project: "acme/widgets",
        filter: {
          $and: [{ state: "running" }, { created_at: { $lte: 1_735_787_045_000 } }],
        },
      });
    }
  });
});
