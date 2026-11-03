// @vitest-environment jsdom

import type { PreviewViewportSetting } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";

interface DimensionCase {
  readonly width: number;
  readonly height: number;
  readonly axis: "width" | "height";
  readonly typed: string;
  readonly expected: string;
}

function Viewport({ width, height }: Pick<DimensionCase, "width" | "height">) {
  const [setting, setSetting] = useState<PreviewViewportSetting>({
    _tag: "freeform",
    width,
    height,
  });
  const [aspectRatio, setAspectRatio] = useState<number | null>(width / height);
  if (setting._tag === "fill") throw new Error("Expected fixed viewport");
  return (
    <>
      <BrowserDeviceToolbar
        setting={setting}
        width={800}
        aspectRatio={aspectRatio}
        onAspectRatioChange={setAspectRatio}
        onChange={async (next) => setSetting(next)}
      />
      <output aria-label="Saved viewport">
        {setting.width} × {setting.height}
      </output>
      <button type="button">Leave toolbar</button>
    </>
  );
}

let root: Root | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function commitTypedDimension(testCase: DimensionCase) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Viewport width={testCase.width} height={testCase.height} />));

  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="Viewport ${testCase.axis}"]`,
  );
  if (input === null) throw new Error(`Missing ${testCase.axis} viewport input`);
  act(() => input.focus());

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (valueSetter === undefined) throw new Error("Missing native input value setter");
  act(() => {
    valueSetter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let typedValue = "";
  for (const digit of testCase.typed) {
    typedValue += digit;
    act(() => {
      valueSetter.call(input, typedValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe(typedValue);
  }

  const leaveToolbar = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Leave toolbar",
  );
  if (leaveToolbar === undefined) throw new Error("Missing toolbar exit button");
  await act(async () => leaveToolbar.focus());

  const savedViewport = container.querySelector("output");
  expect(savedViewport?.textContent?.trim().replace(/\s+/g, " ")).toBe(testCase.expected);
}

it.each([
  { width: 1920, height: 1080, axis: "width", typed: "2560", expected: "2560 × 1440" },
  { width: 390, height: 844, axis: "height", typed: "2532", expected: "1170 × 2532" },
] satisfies readonly DimensionCase[])("keeps typed $axis digits until commit", async (testCase) => {
  await commitTypedDimension(testCase);
});

it("clamps a completed width below the locked minimum on blur", async () => {
  await commitTypedDimension({
    width: 1920,
    height: 1080,
    axis: "width",
    typed: "256",
    expected: "427 × 240",
  });
});

it("limits a completed locked size to the viewport area cap", async () => {
  await commitTypedDimension({
    width: 1920,
    height: 1920,
    axis: "width",
    typed: "3840",
    expected: "2880 × 2880",
  });
});
