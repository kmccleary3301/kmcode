import type { ProviderInstanceId } from "@t3tools/contracts";

import { providerModelKey } from "../../modelOrdering";

/** Cap for the persisted most-recently-used list. */
export const MAX_RECENT_MODELS = 32;
/** How many recently used models lead a harness list. */
export const INSTANCE_RECENT_LIMIT = 5;
/** How many models the cross-harness Recent view shows. */
export const GLOBAL_RECENT_LIMIT = 20;

export interface RecentModelEntry {
  readonly provider: ProviderInstanceId;
  readonly model: string;
  /** Epoch milliseconds. */
  readonly usedAt: number;
}

/** `providerModelKey` → MRU rank, 0 = most recent. */
export type RecentRank = Readonly<Record<string, number>>;

interface RankedModel {
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
}

/**
 * Move `(provider, model)` to the front of the MRU list. Mirrors OMP's
 * `model_usage` table: one row per model, ordered by last use, no decay.
 */
export function recordRecentModel(
  entries: ReadonlyArray<RecentModelEntry>,
  provider: ProviderInstanceId,
  model: string,
  usedAt: number,
): RecentModelEntry[] {
  return [
    { provider, model, usedAt },
    ...entries.filter((entry) => entry.provider !== provider || entry.model !== model),
  ].slice(0, MAX_RECENT_MODELS);
}

/**
 * Merge KM Code's own picks with harness-native usage history (models chosen
 * in the OMP TUI) into one rank; a model's newest use from either source wins.
 */
export function buildRecentRank(
  ...sources: ReadonlyArray<ReadonlyArray<RecentModelEntry>>
): RecentRank {
  const newest: Record<string, number> = {};
  for (const entry of sources.flat()) {
    const key = providerModelKey(entry.provider, entry.model);
    const seen = newest[key];
    if (seen === undefined || entry.usedAt > seen) newest[key] = entry.usedAt;
  }
  return Object.fromEntries(
    Object.entries(newest)
      .toSorted((a, b) => b[1] - a[1])
      .map(([key], rank) => [key, rank] as const),
  );
}

/** Ascending rank order; unranked (`undefined`) sorts last. */
export function compareRecentRank(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/** The `limit` most recently used of `items`, newest first. */
export function mostRecentModels<T extends RankedModel>(
  items: ReadonlyArray<T>,
  rank: RecentRank,
  limit: number,
): T[] {
  const rankOf = (item: T) => rank[providerModelKey(item.instanceId, item.slug)];
  return items
    .filter((item) => rankOf(item) !== undefined)
    .toSorted((a, b) => compareRecentRank(rankOf(a), rankOf(b)))
    .slice(0, limit);
}

/** `items` with its `limit` most recently used models moved to the front; the rest keep their order. */
export function leadWithRecentModels<T extends RankedModel>(
  items: ReadonlyArray<T>,
  rank: RecentRank,
  limit: number,
): T[] {
  const lead = mostRecentModels(items, rank, limit);
  const placed: Record<string, true> = Object.fromEntries(
    lead.map((item) => [providerModelKey(item.instanceId, item.slug), true] as const),
  );
  return [
    ...lead,
    ...items.filter((item) => placed[providerModelKey(item.instanceId, item.slug)] !== true),
  ];
}
