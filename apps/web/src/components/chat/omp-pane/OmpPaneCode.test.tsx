// @vitest-environment jsdom

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  persistClientSettingsPatch,
} from "../../../hooks/useSettings";
import { OmpCodeRows, OmpPaneCode } from "./OmpPaneCode";
import type { OmpCodeBlock } from "./OmpPaneCode";

vi.mock("../../markdown/markdownWorker?worker", async () => {
  const [{ createInlineEngineWorker }, { createKmMarkdownExtensions, KM_MARKDOWN_EXTENSION_ID }] =
    await Promise.all([
      import("@stream-mdx/worker/engine"),
      import("../../markdown/kmMarkdownExtensions"),
    ]);
  const inlineWorker = () =>
    createInlineEngineWorker({
      extensions: createKmMarkdownExtensions(),
      extensionId: KM_MARKDOWN_EXTENSION_ID,
    });
  return {
    default: class KmMarkdownWorkerMock {
      private readonly worker = inlineWorker();

      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void {
        if (listener) this.worker.addEventListener(type, listener, options);
      }

      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ): void {
        if (listener) this.worker.removeEventListener(type, listener, options);
      }

      postMessage(message: unknown): void {
        this.worker.postMessage(message);
      }

      terminate(): void {
        this.worker.terminate();
      }
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", class {});
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.getSelection()?.removeAllRanges();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetClientSettingsPersistenceForTests();
});

it("keeps selected code when a settled pane receives more code and its model refreshes", async () => {
  const block: OmpCodeBlock = {
    language: "typescript",
    gutters: 1,
    rows: [{ text: "const answer = 42;", gutter: ["1"] }],
  };
  await act(async () => root.render(<OmpPaneCode blocks={[block]} complete />));
  await vi.waitFor(async () => {
    await act(async () => {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector('.omp-code-text span[style*="--shiki-light"]')).not.toBeNull();
  });
  const code = container.querySelector(".omp-code-text");
  if (!code) throw new Error("Streamed code is missing its text");
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  while (text && !text.textContent?.includes("answer")) text = walker.nextNode();
  if (!text) throw new Error("Streamed code is missing the selected word");
  const range = document.createRange();
  const start = text.textContent?.indexOf("answer") ?? -1;
  range.setStart(text, start);
  range.setEnd(text, start + "answer".length);
  document.getSelection()?.addRange(range);
  expect(document.getSelection()?.toString()).toBe("answer");

  const finished = {
    ...block,
    rows: [...block.rows, { text: "const settled = true;", gutter: ["2"] }],
  };
  await act(async () => root.render(<OmpPaneCode blocks={[finished]} complete />));
  await vi.waitFor(async () => {
    await act(async () => {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(100);
    });
    const spans = [...container.querySelectorAll('.omp-code-text span[style*="--shiki-light"]')];
    expect(spans.some((span) => span.textContent?.includes("settled"))).toBe(true);
  });
  expect(container.textContent).toContain("const settled = true;");
  expect(document.getSelection()?.toString()).toBe("answer");

  await act(async () => root.render(<OmpPaneCode blocks={[{ ...finished }]} complete />));
  expect(document.getSelection()?.toString()).toBe("answer");
});

it("hides diff metadata without hiding source containing @@ or losing line numbers", async () => {
  const header = "@@ -7,1 +7,2 @@";
  const block: OmpCodeBlock = {
    language: "typescript",
    gutters: 2,
    rows: [
      { kind: "hunk", text: header, gutter: ["", ""] },
      { kind: "remove", text: "const oldValue = 1;", gutter: ["7", ""] },
      { kind: "add", text: 'const marker = "@@ source text @@";', gutter: ["", "7"] },
      { kind: "add", text: "const newValue = 2;", gutter: ["", "8"] },
    ],
  };
  await persistClientSettingsPatch({ toolDetail: "compact" }, async () => {});
  await act(async () => root.render(<OmpCodeRows block={block} tokenLines={[]} />));
  expect(container.textContent).not.toContain(header);
  expect(container.textContent).toContain("7const oldValue = 1;");
  expect(container.textContent).toContain('7const marker = "@@ source text @@";');
  expect(container.textContent).toContain("8const newValue = 2;");

  await act(async () => {
    await persistClientSettingsPatch({ toolDetail: "rich" }, async () => {});
  });
  expect(container.textContent).toContain(header);
  expect(container.textContent).toContain('7const marker = "@@ source text @@";');

  await act(async () => {
    await persistClientSettingsPatch({ toolDetail: "compact" }, async () => {});
  });
  expect(container.textContent).not.toContain(header);
  expect(container.textContent).toContain("8const newValue = 2;");
});
