// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type * as ReactRouter from "@tanstack/react-router";

import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { AnchoredToastProvider } from "./ui/toast";
import { MessageCopyButton } from "./chat/MessageCopyButton";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>();
  return { ...actual, useParams: () => null };
});

const clipboardWrite = vi.fn<(value: string) => Promise<void>>();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  clipboardWrite.mockReset();
  clipboardWrite
    .mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"))
    .mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

async function mount(element: ReactNode) {
  if (!root) throw new Error("Copy button test root is not mounted");
  await act(async () => {
    root?.render(<AnchoredToastProvider timeout={0}>{element}</AnchoredToastProvider>);
  });
}

function button(name: string): HTMLButtonElement {
  const element = document.body.querySelector(`button[aria-label="${name}"]`);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing ${name} button`);
  return element;
}

it.each([
  [
    "file path",
    <DiffFilePathCopyButton filePath="apps/web/src/index.ts" />,
    "Copy file path",
    "apps/web/src/index.ts",
  ],
  ["message", <MessageCopyButton text="message body" />, "Copy message", "message body"],
])(
  "explains a denied %s clipboard write and permits retry",
  async (_label, element, name, text) => {
    await mount(element);
    await act(async () => button(name).click());
    expect(document.body.textContent).toContain("Failed to copy text to the clipboard.");

    const dismiss = button("Dismiss notification");
    await act(async () => dismiss.click());
    await act(async () => button(name).click());

    expect(document.body.textContent).toContain("Copied!");
    expect(clipboardWrite).toHaveBeenNthCalledWith(1, text);
    expect(clipboardWrite).toHaveBeenNthCalledWith(2, text);
  },
);
