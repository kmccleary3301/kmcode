const REVEAL_INTERVAL_MS = 1000 / 30;
const MIN_CATCH_UP_GRAPHEMES = 3;
const MAX_REVEAL_BACKLOG = 8;
const COMBINING_MARK = /\p{M}/u;

/**
 * Approximate extended-grapheme ends from `offset` on, as absolute string
 * offsets. Hermes has no Intl.Segmenter, so web and mobile share this: marks,
 * variation selectors, skin-tone modifiers, and tag characters extend a
 * cluster; ZWJ joins the next code point; regional indicators pair into flags;
 * CRLF stays whole.
 */
function clusterEnds(text: string, offset: number): number[] {
  const ends: number[] = [];
  let joinNext = false;
  let regionalRun = 0;
  let previous = -1;
  for (let index = offset; index < text.length;) {
    const codePoint = text.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const regional = codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
    const extend =
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
      (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
      (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
      COMBINING_MARK.test(String.fromCodePoint(codePoint));
    const continues =
      ends.length > 0 &&
      (extend ||
        joinNext ||
        (regional && regionalRun % 2 === 1) ||
        (previous === 0x0d && codePoint === 0x0a));
    index += width;
    if (continues) ends[ends.length - 1] = index;
    else ends.push(index);
    joinNext = codePoint === 0x200d;
    regionalRun = regional ? regionalRun + 1 : 0;
    previous = codePoint;
  }
  return ends;
}

export function revealGraphemeCatchUp(backlog: number): number {
  return Math.max(MIN_CATCH_UP_GRAPHEMES, Math.ceil(Math.max(0, backlog) / MAX_REVEAL_BACKLOG));
}

export function revealGraphemePrefix(text: string, graphemeCount: number): string {
  if (graphemeCount <= 0 || text.length === 0) return "";
  const ends = clusterEnds(text, 0);
  return text.slice(0, ends[Math.min(graphemeCount, ends.length) - 1] ?? 0);
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
    for (const end of clusterEnds(nextTarget, offset)) boundaries.push(end);
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
