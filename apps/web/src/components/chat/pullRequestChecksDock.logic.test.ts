import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildChecksWaterfall, checksDockHeadline } from "./pullRequestChecksDock.logic";

const BASE_MS = Date.parse("2026-11-03T10:00:00.000Z");
const at = (seconds: number) => new Date(BASE_MS + seconds * 1_000).toISOString();

function check(
  name: string,
  status: PullRequestCheckStatus,
  startedAt?: number,
  completedAt?: number,
): PullRequestCheck {
  return {
    name,
    status,
    description: null,
    url: null,
    ...(startedAt === undefined ? {} : { startedAt: at(startedAt) }),
    ...(completedAt === undefined ? {} : { completedAt: at(completedAt) }),
  };
}

describe("buildChecksWaterfall", () => {
  it("lays finished checks on one axis from the first start to the last finish", () => {
    const waterfall = buildChecksWaterfall(
      [
        check("build", "success", 0, 40),
        check("lint", "success", 10, 30),
        check("e2e", "failure", 40, 60),
      ],
      BASE_MS + 600_000,
    );

    expect(waterfall?.spanMs).toBe(60_000);
    expect(waterfall?.rows.map((row) => [row.check.name, row.bar, row.durationMs])).toEqual([
      ["build", { offset: 0, width: 40 / 60 }, 40_000],
      ["lint", { offset: 10 / 60, width: 20 / 60 }, 20_000],
      ["e2e", { offset: 40 / 60, width: 20 / 60 }, 20_000],
    ]);
  });

  it("runs the axis to now while checks are pending, ending a running bar there", () => {
    const waterfall = buildChecksWaterfall(
      [check("build", "success", 0, 20), check("e2e", "pending", 10), check("deploy", "pending")],
      BASE_MS + 50_000,
    );

    expect(waterfall?.spanMs).toBe(50_000);
    expect(waterfall?.rows.map((row) => [row.check.name, row.bar, row.durationMs])).toEqual([
      ["build", { offset: 0, width: 20 / 50 }, 20_000],
      ["e2e", { offset: 10 / 50, width: 40 / 50 }, 40_000],
      // Queued: nothing to draw yet, and no time to show.
      ["deploy", null, null],
    ]);
  });

  it("keeps a running bar from going negative when the local clock trails the host", () => {
    const waterfall = buildChecksWaterfall([check("e2e", "pending", 30)], BASE_MS);

    expect(waterfall?.rows[0]?.bar?.width).toBe(0);
    expect(waterfall?.rows[0]?.durationMs).toBe(0);
  });

  it("draws no axis when no check says when it started", () => {
    expect(
      buildChecksWaterfall([check("build", "success"), check("e2e", "pending")], BASE_MS),
    ).toBeNull();
  });
});

describe("checksDockHeadline", () => {
  it("names a single failure even while other checks still run", () => {
    expect(checksDockHeadline([check("e2e", "failure"), check("build", "pending")])).toBe(
      "e2e failed",
    );
    expect(checksDockHeadline([check("e2e", "failure"), check("lint", "cancelled")])).toBe(
      "2 checks failed",
    );
  });

  it("counts settled checks while any are pending", () => {
    expect(
      checksDockHeadline([
        check("build", "success"),
        check("lint", "skipped"),
        check("e2e", "pending"),
      ]),
    ).toBe("Checks 2/3");
  });

  it("says all passed once every check succeeded", () => {
    expect(checksDockHeadline([check("build", "success"), check("e2e", "success")])).toBe(
      "All checks passed",
    );
  });
});
