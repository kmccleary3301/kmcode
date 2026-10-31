// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useCommitOnBlur } from "./useCommitOnBlur";

let root: Root | null = null;
let container: HTMLDivElement;

function DraftInput({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  return <input aria-label="Draft" {...useCommitOnBlur(value, onCommit)} />;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

function input(): HTMLInputElement {
  const element = container.querySelector("input");
  if (!element) throw new Error("Draft input was not rendered");
  return element;
}

async function render(value: string, onCommit: (next: string) => void) {
  if (!root) throw new Error("Draft input test root is not mounted");
  await act(async () => root?.render(<DraftInput value={value} onCommit={onCommit} />));
}

describe("settings draft commits", () => {
  it("preserves an external update when an untouched field loses focus", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await render(saved, commit);
    await act(async () => input().focus());

    saved = "/projects";
    await render(saved, commit);
    await act(async () => input().blur());

    expect(saved).toBe("/projects");
  });

  it("preserves a saved edit when refocused before its server snapshot arrives", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await render(saved, commit);
    const draft = input();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("Native input value setter is unavailable");
    await act(async () => {
      draft.focus();
      Reflect.apply(valueSetter, draft, ["/projects"]);
      draft.dispatchEvent(new Event("input", { bubbles: true }));
      draft.blur();
    });
    expect(saved).toBe("/projects");

    await act(async () => input().focus());
    await render(saved, commit);
    await act(async () => input().blur());

    expect(saved).toBe("/projects");
  });
});
