import * as DateTime from "effect/DateTime";
import { ProviderDriverKind, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveHandoffEndpoints,
  resolvePendingHandoff,
  type HandoffTimelineRun,
} from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});
const projection: NonNullable<Parameters<typeof resolvePendingHandoff>[0]> = {
  runs: [
    {
      status: "completed",
      startedAt: DateTime.makeUnsafe("2026-10-11T00:00:00Z"),
      modelSelection: { instanceId: from, model: "source" },
    },
  ],
};

describe("pending context handoff", () => {
  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });

  it("previews a same-provider model change only when it needs a fresh native thread", () => {
    const providers: NonNullable<Parameters<typeof resolvePendingHandoff>[2]> = [
      {
        instanceId: from,
        driver: ProviderDriverKind.make("codex"),
        requiresNewThreadForModelChange: true,
      },
    ];
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "other" }, providers)?.to.model,
    ).toBe("other");
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "source" }, providers),
    ).toBeNull();
  });

  it("resumes accounts in a shared continuation group without showing a handoff", () => {
    const sharedTarget = ProviderInstanceId.make("codex_work");
    const providers: NonNullable<Parameters<typeof resolvePendingHandoff>[2]> = [
      {
        instanceId: from,
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "shared" },
      },
      {
        instanceId: sharedTarget,
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "shared" },
      },
    ];
    expect(
      resolvePendingHandoff(projection, { instanceId: sharedTarget, model: "target" }, providers),
    ).toBeNull();
  });
});
