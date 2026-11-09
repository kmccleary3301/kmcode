import type { ComponentProps } from "react";
import { use, useLayoutEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "~/lib/motion";
import { TranscriptStyleCtx } from "./transcriptStyle";

export interface RollSplit {
  readonly prefix: string;
  readonly from: string;
  readonly to: string;
  readonly suffix: string;
  readonly numeric: boolean;
}

const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";
const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** The changed run between two texts: whole digit runs when both sides are numbers, else whole words. */
export function splitRoll(previous: string, next: string): RollSplit {
  const shared = Math.min(previous.length, next.length);
  let start = 0;
  while (start < shared && previous[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < shared - start &&
    previous[previous.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  let numberStart = start;
  let numberEnd = end;
  while (numberStart > 0 && isDigit(next[numberStart - 1])) numberStart -= 1;
  while (numberEnd > 0 && isDigit(next[next.length - numberEnd])) numberEnd -= 1;
  const fromNumber = previous.slice(numberStart, previous.length - numberEnd);
  const toNumber = next.slice(numberStart, next.length - numberEnd);
  if (/^\d+$/.test(fromNumber) && /^\d+$/.test(toNumber)) {
    return {
      prefix: next.slice(0, numberStart),
      from: fromNumber,
      to: toNumber,
      suffix: next.slice(next.length - numberEnd),
      numeric: true,
    };
  }
  // A cut inside a word rolls the whole word; a cut at punctuation ("files" →
  // "files, 1 search") rolls only what changed.
  let wordStart = start;
  let wordEnd = end;
  if (isWordChar(next[start - 1]) && (isWordChar(next[start]) || isWordChar(previous[start]))) {
    while (wordStart > 0 && !isSpace(next[wordStart - 1])) wordStart -= 1;
  }
  if (
    isWordChar(next[next.length - end]) &&
    (isWordChar(next[next.length - end - 1]) || isWordChar(previous[previous.length - end - 1]))
  ) {
    while (wordEnd > 0 && !isSpace(next[next.length - wordEnd])) wordEnd -= 1;
  }
  return {
    prefix: next.slice(0, wordStart),
    from: previous.slice(wordStart, previous.length - wordEnd),
    to: next.slice(wordStart, next.length - wordEnd),
    suffix: next.slice(next.length - wordEnd),
    numeric: false,
  };
}

// The following text glides on the recording's curve (--ease-disclosure) for
// the length it measured; transforms only, added onto any glide in flight.
const GLIDE_MS = 470;
const GLIDE_EASING = "cubic-bezier(0.23, 1, 0.32, 1)";

function glide(element: Element, fromX: number) {
  element.animate([{ transform: `translateX(${fromX}px)` }, { transform: "translateX(0)" }], {
    duration: GLIDE_MS,
    easing: GLIDE_EASING,
    composite: "add",
  });
}

/**
 * Where the text itself sits: a block root is as wide as its line, not its
 * words, and a leaving word (positioned out of flow) overhangs the line, so
 * the text ends where its last in-flow part (suffix, slot, or digits) ends.
 */
function measureText(element: Element): { readonly left: number; readonly width: number } {
  const range = document.createRange();
  range.selectNodeContents(element);
  const box = range.getBoundingClientRect();
  const right = element.lastElementChild?.getBoundingClientRect().right ?? box.right;
  return { left: box.left, width: right - box.left };
}

/** Where the line is cut off: its own box's right edge, or its nearest clipping ancestor's. */
function clipRight(element: Element): number {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowX !== "visible") return node.getBoundingClientRect().right;
  }
  return Number.POSITIVE_INFINITY;
}

interface RollState {
  readonly text: string;
  readonly split: RollSplit | null;
  readonly version: number;
  /** Where the text sat and how wide it was before the change. */
  readonly fromLeft: number;
  readonly fromWidth: number;
}

/**
 * Text that rolls when it changes, in the KM and Minimal transcript styles.
 * Only the changed part moves: a changed word rolls (the old one leaves upward
 * out of a blur, the new one rises in through one), a changed number spins its
 * changed digits, and whatever follows glides over by the width difference.
 * Measured from the reference recording; the curves live in
 * transcript-minimal.css. Terminal, the first render, and a change to a line
 * too long for its row show plain text.
 */
export function RollingText({
  text,
  className,
  ...props
}: { readonly text: string } & Omit<ComponentProps<"span">, "children" | "ref">) {
  const enabled = use(TranscriptStyleCtx) !== "terminal";
  const rootRef = useRef<HTMLSpanElement>(null);
  const suffixRef = useRef<HTMLSpanElement>(null);
  const [roll, setRoll] = useState<RollState>({
    text,
    split: null,
    version: 0,
    fromLeft: 0,
    fromWidth: 0,
  });
  if (roll.text !== text) {
    // The old layout is only readable before the commit replaces it; reading
    // it here, once per change, saves measuring every row on mount.
    const before = enabled && rootRef.current ? measureText(rootRef.current) : undefined;
    setRoll({
      text,
      split: before === undefined ? null : splitRoll(roll.text, text),
      version: roll.version + 1,
      fromLeft: before?.left ?? 0,
      fromWidth: before?.width ?? 0,
    });
  }

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (roll.split === null || root === null) return;
    const after = measureText(root);
    // A rolled word is one block, which the ellipsis cannot cut: on a line too
    // long for its row it would draw past the ellipsis (and its blur with it).
    // Such a line shows the change as plain text before it paints.
    if (after.left + after.width > clipRight(root) + 0.5) {
      setRoll((current) =>
        current.version === roll.version ? { ...current, split: null } : current,
      );
      return;
    }
    if (prefersReducedMotion()) return;
    const widthDelta = roll.fromWidth - after.width;
    if (Math.abs(widthDelta) >= 0.5) {
      if (suffixRef.current) glide(suffixRef.current, widthDelta);
      for (let sibling = root.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        glide(sibling, widthDelta);
      }
    }
    // The line itself moved (its status glyph left as it settled): glide it home.
    const leftDelta = roll.fromLeft - after.left;
    if (Math.abs(leftDelta) >= 0.5 && root.parentElement) glide(root.parentElement, leftDelta);
  }, [roll]);

  const split = enabled ? roll.split : null;
  if (split === null) {
    return (
      <span ref={rootRef} className={className} {...props}>
        {text}
      </span>
    );
  }
  return (
    // Once the new words have risen in, the line settles back to plain text,
    // so a line too long for its row ellipsizes by letter, not by rolled block.
    <span
      ref={rootRef}
      className={className}
      onAnimationEnd={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
          !target.classList.contains("roll-in") &&
          !target.classList.contains("digit-roll-column")
        )
          return;
        setRoll((current) =>
          current.version === roll.version ? { ...current, split: null } : current,
        );
      }}
      {...props}
    >
      {split.prefix}
      {split.numeric ? (
        <DigitRoll key={roll.version} from={split.from} to={split.to} />
      ) : (
        <span key={roll.version} className="roll-slot">
          <span className="roll-in">{split.to}</span>
          {split.from.length > 0 ? (
            <span className="roll-out" aria-hidden="true">
              {split.from}
            </span>
          ) : null}
        </span>
      )}
      {split.suffix.length > 0 ? (
        <span ref={suffixRef} className="roll-suffix">
          {split.suffix}
        </span>
      ) : null}
    </span>
  );
}

/** Changed digits spin one place, up when the number grows; unchanged ones hold still. */
function DigitRoll({ from, to }: { readonly from: string; readonly to: string }) {
  const direction = Number(to) >= Number(from) ? "up" : "down";
  const offset = from.length - to.length;
  return (
    <>
      <span className="sr-only">{to}</span>
      <span aria-hidden="true">
        {Array.from(to, (digit, index) => {
          const previous = from[index + offset] ?? "\u00a0";
          if (previous === digit) return digit;
          return (
            // Positions count from the right, so a carry keeps its columns.
            <span key={to.length - index} className="digit-roll" data-direction={direction}>
              <span className="digit-roll-column">
                {direction === "up" ? (
                  <>
                    <span>{previous}</span>
                    <span>{digit}</span>
                  </>
                ) : (
                  <>
                    <span>{digit}</span>
                    <span>{previous}</span>
                  </>
                )}
              </span>
            </span>
          );
        })}
      </span>
    </>
  );
}
