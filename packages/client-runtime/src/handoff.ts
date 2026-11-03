import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
): HandoffEndpoints {
  // Items persisted before models were stamped only carry instance ids;
  // recover the models from the thread's runs (the handoff's own run is
  // the target, the newest earlier run per source instance is the origin).
  // Clients fall back to the provider display name when neither source has a model.
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}
export interface HandoffEndpoint {
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}

export interface HandoffEndpoints {
  readonly from: ReadonlyArray<HandoffEndpoint>;
  readonly to: HandoffEndpoint;
}

type PendingHandoffRun = Pick<OrchestrationV2Run, "startedAt" | "status" | "modelSelection">;
type PendingHandoffProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "continuation" | "requiresNewThreadForModelChange"
>;
type PendingHandoffProjection = { readonly runs: ReadonlyArray<PendingHandoffRun> };

/** Preview the next send's handoff without adding anything to durable history. */
export function resolvePendingHandoff(
  projection: PendingHandoffProjection | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<PendingHandoffProvider>,
): HandoffEndpoints | null {
  const from = projection?.runs.findLast(
    (run) => run.startedAt !== null && run.status !== "rolled_back",
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const sourceGroup = source?.continuation?.groupKey;
  const targetGroup = target?.continuation?.groupKey;
  const canResumeNativeThread =
    source !== undefined &&
    sourceGroup !== undefined &&
    target !== undefined &&
    source.driver === target.driver &&
    sourceGroup === targetGroup;
  const needsHandoff =
    from.instanceId === selection.instanceId
      ? from.model !== selection.model && target?.requiresNewThreadForModelChange === true
      : !canResumeNativeThread;
  return needsHandoff ? { from: [from], to: selection } : null;
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}
