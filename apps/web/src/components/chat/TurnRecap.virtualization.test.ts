import { describe, expect, it } from "vite-plus/test";

import { visibleTurnRecapFileRange } from "./TurnRecap";

describe("turn recap file virtualization", () => {
  it("includes overscan around the visible rows", () => {
    expect(
      visibleTurnRecapFileRange({
        fileCount: 1_000,
        listTop: 100,
        viewportTop: 660,
        viewportHeight: 280,
        rowHeight: 28,
      }),
    ).toEqual({ start: 12, end: 38 });
  });

  it("clamps the range to the list bounds", () => {
    expect(
      visibleTurnRecapFileRange({
        fileCount: 40,
        listTop: -1_000,
        viewportTop: 0,
        viewportHeight: 200,
        rowHeight: 28,
      }),
    ).toEqual({ start: 27, end: 40 });
  });
});
