import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerModelKey } from "../../modelOrdering";
import {
  buildRecentRank,
  leadWithRecentModels,
  MAX_RECENT_MODELS,
  mostRecentModels,
  recordRecentModel,
} from "./modelPickerRecents";

const OMP = ProviderInstanceId.make("omp");
const CODEX = ProviderInstanceId.make("codex");

const model = (slug: string, instanceId = OMP) => ({ instanceId, slug });
const rank = (...slugs: string[]) =>
  buildRecentRank(slugs.map((slug, i) => ({ provider: OMP, model: slug, usedAt: 1000 - i })));

describe("recordRecentModel", () => {
  it("moves a re-picked model to the front and caps the list", () => {
    let entries = recordRecentModel([], OMP, "a", 1);
    entries = recordRecentModel(entries, CODEX, "a", 2);
    entries = recordRecentModel(entries, OMP, "a", 3);
    expect(entries.map((e) => `${e.provider}:${e.model}`)).toEqual(["omp:a", "codex:a"]);

    for (let i = 0; i < MAX_RECENT_MODELS + 5; i++) {
      entries = recordRecentModel(entries, OMP, `m${i}`, i);
    }
    expect(entries).toHaveLength(MAX_RECENT_MODELS);
    expect(entries[0]?.model).toBe(`m${MAX_RECENT_MODELS + 4}`);
  });
});

describe("buildRecentRank", () => {
  it("ranks merged sources by each model's newest use", () => {
    const merged = buildRecentRank(
      [{ provider: OMP, model: "a", usedAt: 10 }],
      [
        { provider: OMP, model: "a", usedAt: 5 },
        { provider: OMP, model: "b", usedAt: 20 },
      ],
    );
    expect(merged).toEqual({
      [providerModelKey(OMP, "b")]: 0,
      [providerModelKey(OMP, "a")]: 1,
    });
  });
});

describe("recent ordering", () => {
  const catalog = [model("a"), model("b"), model("c"), model("d"), model("a", CODEX)];

  it("leads with the most recent models and keeps the rest in catalog order", () => {
    const ordered = leadWithRecentModels(catalog, rank("c", "a"), 5);
    expect(ordered.map((m) => `${m.instanceId}:${m.slug}`)).toEqual([
      "omp:c",
      "omp:a",
      "omp:b",
      "omp:d",
      "codex:a",
    ]);
  });

  it("leaves overflow beyond the limit in catalog position", () => {
    const ordered = leadWithRecentModels(catalog, rank("d", "c", "b"), 2);
    expect(ordered.map((m) => m.slug)).toEqual(["d", "c", "a", "b", "a"]);
  });

  it("lists only used models for the Recent view", () => {
    expect(mostRecentModels(catalog, rank("b", "d"), 10).map((m) => m.slug)).toEqual(["b", "d"]);
  });
});
