import { useEffect, useMemo, useState } from "react";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentLiveContent,
} from "@t3tools/contracts";
import { plainDetail } from "./V2LifecycleRow";

const ACTIVITY_MIN_DWELL_MS = 1_500;
/** Past this, a streaming sentence shows its newest words instead. */
const PREVIEW_MAX_LENGTH = 120;

type DisplayedActivity = {
  readonly key: string | null;
  readonly text: string;
  readonly hasRealStep: boolean;
  readonly shownAt: number;
};

type SubagentActivityInput = {
  readonly status: OrchestrationV2Subagent["status"];
  readonly currentTool: OrchestrationV2Subagent["currentTool"] | null | undefined;
  readonly childLiveStep: string | null | undefined;
  readonly liveContent: OrchestrationV2SubagentLiveContent | null | undefined;
  readonly progress: string | null | undefined;
  /** The agent's assignment, shown until it reports a step. */
  readonly task: string | null | undefined;
};

/** One markdown line as plain text, without its heading, quote, or list marker. */
function plainLine(line: string): string {
  return plainDetail(line).replace(/^(?:#+|>|\d+[.)])\s+/, "");
}

/** The first prose line of an agent's assignment; headings and one-word labels are skipped. */
export function taskPreview(task: string | null | undefined): string | null {
  for (const line of task?.split(/\r?\n/) ?? []) {
    if (/^\s*#/.test(line)) continue;
    const plain = plainLine(line);
    if (/\s/.test(plain)) return plain;
  }
  return null;
}

/**
 * The sentence an agent is writing or reasoning through, as one plain line.
 * A sentence that has only just begun shows the one before it, so the line
 * grows by words rather than resetting to a stub.
 */
export function liveContentPreview(
  liveContent: OrchestrationV2SubagentLiveContent | null | undefined,
): string | null {
  if (!liveContent || liveContent.kind === "tool") return null;
  const lines = liveContent.text.split(/\r?\n/);
  let line = "";
  for (let index = lines.length - 1; index >= 0 && line === ""; index -= 1) {
    line = plainLine(lines[index] ?? "");
  }
  if (line === "") return null;
  const sentences = line.split(/(?<=[.!?])\s+/);
  const last = sentences.at(-1) ?? line;
  const sentence = last.length < 16 && sentences.length > 1 ? (sentences.at(-2) ?? last) : last;
  if (sentence.length <= PREVIEW_MAX_LENGTH) return sentence;
  const tail = sentence.slice(-PREVIEW_MAX_LENGTH);
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

export type HeldSubagentActivity = {
  readonly key: string;
  readonly text: string;
  readonly latestText: string;
};

export function useHeldSubagentActivity({
  status,
  currentTool,
  childLiveStep,
  liveContent,
  progress,
  task,
}: SubagentActivityInput): HeldSubagentActivity {
  const step = useMemo(() => {
    const intent = currentTool?.intent?.trim();
    if (intent) return { key: intent, text: intent };

    if (currentTool?.name) {
      const argsPreview = currentTool.argsPreview?.trim();
      return {
        key: currentTool.name,
        text: argsPreview ? `${currentTool.name} ${argsPreview}` : currentTool.name,
      };
    }

    const childStep = childLiveStep?.trim();
    if (childStep) return { key: childStep, text: childStep };

    // Between tools, the words the agent is writing.
    const preview = liveContentPreview(liveContent);
    if (preview) return { key: preview, text: preview };

    const progressStep = progress?.trim();
    return progressStep ? { key: progressStep, text: progressStep } : null;
  }, [currentTool, childLiveStep, liveContent, progress]);
  const active = isOrchestrationV2WorkActive(status);
  const fallback = taskPreview(task) ?? (status === "pending" ? "Starting up" : "Thinking");
  const [displayed, setDisplayed] = useState<DisplayedActivity>(() => ({
    key: step?.key ?? null,
    text: step?.text ?? fallback,
    hasRealStep: step !== null,
    shownAt: Date.now(),
  }));

  useEffect(() => {
    if (!active || step === null || (displayed.hasRealStep && step.key === displayed.key)) return;

    // Until a real step has been held, the first one shows straight from `step` below.
    const remainingDwellMs = displayed.hasRealStep
      ? ACTIVITY_MIN_DWELL_MS - (Date.now() - displayed.shownAt)
      : 0;
    const timer = setTimeout(
      () => {
        setDisplayed({ key: step.key, text: step.text, hasRealStep: true, shownAt: Date.now() });
      },
      Math.max(0, remainingDwellMs),
    );
    return () => clearTimeout(timer);
  }, [active, displayed, step]);

  return {
    key: displayed.hasRealStep ? (displayed.key ?? displayed.text) : (step?.key ?? fallback),
    text: displayed.hasRealStep ? displayed.text : (step?.text ?? fallback),
    latestText: step?.text ?? fallback,
  };
}
