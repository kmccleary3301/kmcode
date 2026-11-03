import type { OrchestrationV2SubagentTranscriptEntry } from "@t3tools/contracts";

import type { ActivityDetailInput } from "./activityDetails.ts";

export interface DerivedSubagentTranscriptEntry {
  /** The visible entry. A call/result pair keeps the call as its identity. */
  readonly entry: OrchestrationV2SubagentTranscriptEntry;
  /** The real call entry when this is a structured tool event. */
  readonly callEntry?: OrchestrationV2SubagentTranscriptEntry;
  /** The real result entry when this is a structured tool event. */
  readonly resultEntry?: OrchestrationV2SubagentTranscriptEntry;
  /** Native tool data in the activity-detail payload shape. */
  readonly toolData?: Readonly<Record<string, unknown>>;
  /** Synthetic activity used by the existing activity detail parser. */
  readonly activity?: ActivityDetailInput;
}
function hasCallId(entry: OrchestrationV2SubagentTranscriptEntry): boolean {
  return typeof entry.tool?.callId === "string" && entry.tool.callId.trim().length > 0;
}

function toolDataFor(
  callEntry: OrchestrationV2SubagentTranscriptEntry | undefined,
  resultEntry: OrchestrationV2SubagentTranscriptEntry | undefined,
): Readonly<Record<string, unknown>> {
  const item: Record<string, unknown> = {
    name: callEntry?.toolName ?? resultEntry?.toolName ?? "tool",
  };
  const callArguments = callEntry?.tool?.arguments;
  if (callArguments !== undefined) item.input = callArguments;
  const result = resultEntry?.tool?.result;
  if (result !== undefined) {
    item.result = result;
  } else if (resultEntry !== undefined && resultEntry.tool !== undefined) {
    // Preserve a result-only payload even when a provider omitted its native
    // result field. This is still a structured tool entry, not legacy text.
    item.result = resultEntry.text;
  }
  if (callEntry?.isError === true || resultEntry?.isError === true) item.isError = true;
  return item;
}

function derivedEntry(
  entry: OrchestrationV2SubagentTranscriptEntry,
  callEntry?: OrchestrationV2SubagentTranscriptEntry,
  resultEntry?: OrchestrationV2SubagentTranscriptEntry,
): DerivedSubagentTranscriptEntry {
  if (callEntry === undefined && resultEntry === undefined) return { entry };
  const toolData = toolDataFor(callEntry, resultEntry);
  return {
    entry,
    ...(callEntry === undefined ? {} : { callEntry }),
    ...(resultEntry === undefined ? {} : { resultEntry }),
    toolData,
    activity: {
      id: `activity-${entry.id}`,
      kind: "tool",
      name: String(toolData.name ?? "tool"),
      payload: toolData,
      item: toolData,
      input: toolData.input,
      result: toolData.result,
    },
  };
}

/**
 * Folds only adjacent call/result entries with the same real call ID. No
 * same-name inference or reordering is performed, so interleaved and
 * unmatched events remain visible in their source order.
 */
export function deriveSubagentTranscriptEntries(
  entries: ReadonlyArray<OrchestrationV2SubagentTranscriptEntry>,
): ReadonlyArray<DerivedSubagentTranscriptEntry> {
  const derived: DerivedSubagentTranscriptEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const next = entries[index + 1];
    const isAdjacentPair =
      entry.tool?.phase === "call" &&
      hasCallId(entry) &&
      next?.tool?.phase === "result" &&
      next.tool.callId === entry.tool.callId;
    if (isAdjacentPair) {
      derived.push(derivedEntry(entry, entry, next));
      index += 1;
      continue;
    }
    if (entry.tool?.phase === "call") {
      derived.push(derivedEntry(entry, entry));
    } else if (entry.tool?.phase === "result") {
      derived.push(derivedEntry(entry, undefined, entry));
    } else {
      derived.push(derivedEntry(entry));
    }
  }
  return derived;
}
