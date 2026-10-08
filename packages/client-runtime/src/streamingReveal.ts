const REVEAL_INTERVAL_MS = 1000 / 30;
const MIN_CATCH_UP_GRAPHEMES = 3;
const MAX_REVEAL_BACKLOG = 8;
let graphemeSegmenter: Intl.Segmenter | undefined;

function segmenter(): Intl.Segmenter | undefined {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return undefined;
  return (graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));
}

export function revealGraphemeCatchUp(backlog: number): number {
  return Math.max(MIN_CATCH_UP_GRAPHEMES, Math.ceil(Math.max(0, backlog) / MAX_REVEAL_BACKLOG));
}

export function revealGraphemePrefix(text: string, graphemeCount: number): string {
  if (graphemeCount <= 0 || text.length === 0) return "";
  const splitter = segmenter();
  // Without Unicode segmentation, snap the complete string rather than split a cluster.
  if (!splitter) return text;
  let count = 0;
  for (const part of splitter.segment(text)) {
    if (++count >= graphemeCount) return text.slice(0, part.index + part.segment.length);
  }
  return text;
}

export interface StreamingRevealSnapshot {
  readonly text: string;
  readonly complete: boolean;
}

export interface StreamingRevealController {
  readonly snapshot: StreamingRevealSnapshot;
  updateTarget(target: string): StreamingRevealSnapshot;
  tick(): StreamingRevealSnapshot;
  complete(target?: string): StreamingRevealSnapshot;
  cancel(): void;
  reset(): void;
}

/** Reconcile authoritative snapshots; only re-segment the last cluster and appended suffix. */
export function createStreamingRevealController(): StreamingRevealController {
  let target = "";
  const boundaries: number[] = [];
  let visibleCount = 0;
  let cancelled = false;
  let snapshot: StreamingRevealSnapshot = { text: "", complete: true };

  const read = (): StreamingRevealSnapshot => {
    const end = boundaries[visibleCount - 1] ?? 0;
    const complete = visibleCount >= boundaries.length;
    if (end !== snapshot.text.length) snapshot = { text: target.slice(0, end), complete };
    else if (complete !== snapshot.complete) snapshot = { text: snapshot.text, complete };
    return snapshot;
  };

  const reconcile = (nextTarget: string): void => {
    cancelled = false;
    if (nextTarget === target) return;
    let commonVisibleEnd = boundaries[visibleCount - 1] ?? 0;
    let offset = 0;
    if (nextTarget.startsWith(target)) {
      offset = boundaries[boundaries.length - 2] ?? 0;
      if (boundaries.length > 0) boundaries.pop();
    } else {
      let common = 0;
      while (common < commonVisibleEnd && target[common] === nextTarget[common]) common++;
      commonVisibleEnd = common;
      boundaries.length = 0;
    }
    const splitter = segmenter();
    if (splitter) {
      for (const part of splitter.segment(nextTarget.slice(offset))) {
        boundaries.push(offset + part.index + part.segment.length);
      }
    } else {
      boundaries.length = 0;
      if (nextTarget.length > 0) boundaries.push(nextTarget.length);
    }
    target = nextTarget;
    visibleCount = Math.min(visibleCount, boundaries.length);
    while (visibleCount > 0 && (boundaries[visibleCount - 1] ?? 0) > commonVisibleEnd)
      visibleCount--;
    read();
  };

  return {
    get snapshot() {
      return read();
    },
    updateTarget(nextTarget) {
      reconcile(nextTarget);
      return read();
    },
    tick() {
      if (!cancelled)
        visibleCount = Math.min(
          boundaries.length,
          visibleCount + revealGraphemeCatchUp(boundaries.length - visibleCount),
        );
      return read();
    },
    complete(nextTarget = target) {
      reconcile(nextTarget);
      visibleCount = boundaries.length;
      return read();
    },
    cancel() {
      cancelled = true;
    },
    reset() {
      target = "";
      boundaries.length = 0;
      visibleCount = 0;
      cancelled = false;
      snapshot = { text: "", complete: true };
    },
  };
}

export { REVEAL_INTERVAL_MS };
