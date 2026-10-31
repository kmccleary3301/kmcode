import { useLayoutEffect, useState } from "react";

export function measureComposerMultilinePrompt(body: HTMLElement): boolean | null {
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!editor || editor.clientWidth === 0) return null;

  const bodyStyle = getComputedStyle(body);
  const expandedWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  const range = document.createRange();
  range.selectNodeContents(editor);
  const bounds = range.getBoundingClientRect();

  // Measure content, not the editor's minimum height. While resting, the
  // prompt is unwrapped: compare its width with the expanded row so that
  // moving the actions inline cannot make collapse and expansion oscillate.
  return bounds.height > lineHeight + 1 || bounds.width > expandedWidth + 1;
}

export function useComposerMultilinePrompt(body: HTMLElement | null): boolean {
  const [isMultiline, setIsMultiline] = useState(false);

  useLayoutEffect(() => {
    if (!body) return;
    // Layout reads are batched per frame so mutation bursts do not force repeated reflows.
    let frame: number | null = null;
    const measure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = measureComposerMultilinePrompt(body);
        if (next !== null) setIsMultiline(next);
      });
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(body);
    const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    if (editor) resizeObserver.observe(editor);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, characterData: true, subtree: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [body]);

  return isMultiline;
}
