import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  areFontAdvancesMonospace,
  AppearanceFontLoadCache,
  getAppearanceFontLoadDiagnostics,
  loadAppearanceFonts,
  setAppearanceFontLoadDiagnostics,
  subscribeAppearanceFontLoadDiagnostics,
  clampCodeFontSize,
  clampInterfaceFontSize,
  clampPromptFontSize,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  appearanceFontStack,
  cssFontFamilies,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
} from "./appearanceFonts";

describe("areFontAdvancesMonospace", () => {
  it("accepts a fixed advance and rejects any proportional glyph", () => {
    expect(areFontAdvancesMonospace([10, 10, 10, 10])).toBe(true);
    expect(areFontAdvancesMonospace([10, 10, 7, 10])).toBe(false);
    expect(areFontAdvancesMonospace([10, 10.02])).toBe(false);
  });

  it("fails open when canvas metrics are unavailable", () => {
    expect(areFontAdvancesMonospace([])).toBe(true);
    expect(areFontAdvancesMonospace([Number.NaN, Number.NaN])).toBe(true);
  });
});

describe("cssFontFamilies", () => {
  it("returns null for effectively empty input", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies(" , , ")).toBeNull();
  });

  it("quotes names with spaces and keeps single idents bare", () => {
    expect(cssFontFamilies("Fira Code")).toBe('"Fira Code"');
    expect(cssFontFamilies("monospace")).toBe("monospace");
    expect(cssFontFamilies('"Comic Mono"')).toBe('"Comic Mono"');
  });

  it("normalizes comma-separated lists and escapes CSS string metacharacters", () => {
    expect(cssFontFamilies(" Fira Code , Menlo ")).toBe('"Fira Code", Menlo');
    expect(cssFontFamilies('Bad"Name')).toBe('"Bad\\"Name"');
    expect(cssFontFamilies("Broken\\")).toBe('"Broken\\\\"');
    expect(cssFontFamilies("Line\nBreak")).toBe('"Line Break"');
  });

  it("quotes names that are not single CSS idents", () => {
    expect(cssFontFamilies("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(cssFontFamilies("M+ 1m")).toBe('"M+ 1m"');
  });
});

describe("resolveDefaultFamilyLabel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips generic keywords and returns null for a stack of only generics", () => {
    expect(resolveDefaultFamilyLabel("system-ui, sans-serif")).toBeNull();
    expect(resolveDefaultFamilyLabel("ui-monospace, monospace")).toBeNull();
  });

  it("names a bundled @font-face family before it has finished loading", () => {
    // Canvas metrics cannot see a face that is still loading, so the settings
    // page opened at startup labeled the Inter default as the system font.
    vi.stubGlobal("document", { fonts: [{ family: '"Inter"', status: "unloaded" }] });
    expect(resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK)).toBe("Inter");
  });

  it("does not name a bundled face that failed to load", () => {
    vi.stubGlobal("document", { fonts: [{ family: "Inter", status: "error" }] });
    expect(resolveDefaultFamilyLabel('"Inter", sans-serif')).toBeNull();
  });
});

describe("appearanceFontStack", () => {
  it("prepends the custom family to the default stack", () => {
    expect(appearanceFontStack("Fira Code", DEFAULT_CODE_FONT_STACK)).toBe(
      `"Fira Code", ${DEFAULT_CODE_FONT_STACK}`,
    );
  });

  it("falls back to the default stack when unset", () => {
    expect(appearanceFontStack("", DEFAULT_SANS_FONT_STACK)).toBe(DEFAULT_SANS_FONT_STACK);
  });
});

describe("resolveTerminalFontPreference", () => {
  it("inherits the code font in simple mode", () => {
    expect(
      resolveTerminalFontPreference({ advanced: false, code: "Fira Code", terminal: "" }),
    ).toBe("Fira Code");
    expect(
      resolveTerminalFontPreference({
        advanced: false,
        code: "Fira Code",
        terminal: "Berkeley Mono",
      }),
    ).toBe("Fira Code");
  });

  it("keeps code and terminal fonts independent in advanced mode", () => {
    expect(resolveTerminalFontPreference({ advanced: true, code: "Fira Code", terminal: "" })).toBe(
      "",
    );
    expect(
      resolveTerminalFontPreference({
        advanced: true,
        code: "Fira Code",
        terminal: "Berkeley Mono",
      }),
    ).toBe("Berkeley Mono");
  });
});

describe("resolveTerminalFontSizePreference", () => {
  it("inherits the code font size in simple mode", () => {
    expect(resolveTerminalFontSizePreference({ advanced: false, code: 15, terminal: 12 })).toBe(15);
  });

  it("keeps code and terminal font sizes independent in advanced mode", () => {
    expect(resolveTerminalFontSizePreference({ advanced: true, code: 15, terminal: 12 })).toBe(12);
  });
});

describe("font size clamping", () => {
  it("keeps sizes inside the ranges the UI can absorb", () => {
    expect(clampInterfaceFontSize(16)).toBe(16);
    expect(clampInterfaceFontSize(2)).toBe(12);
    expect(clampInterfaceFontSize(96)).toBe(20);
    expect(clampPromptFontSize(40)).toBe(20);
    expect(clampCodeFontSize(1)).toBe(10);
  });

  it("rounds fractional values and falls back for unusable input", () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampInterfaceFontSize(Number.NaN)).toBe(16);
    expect(clampPromptFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});

describe("loadAppearanceFonts", () => {
  it("reports failure and timeout without blocking fallback content", async () => {
    const failed = await loadAppearanceFonts([{ family: "Broken Face" }], {
      fontSet: { load: async () => Promise.reject(new Error("invalid font")) },
    });
    expect(failed.loaded).toEqual([]);
    expect(failed.diagnostics[0]?.code).toBe("font-load-failed");

    const timedOut = await loadAppearanceFonts([{ family: "Slow Face" }], {
      fontSet: { load: async () => new Promise<never>(() => undefined) },
      timeoutMs: 1,
    });
    expect(timedOut.loaded).toEqual([]);
    expect(timedOut.diagnostics[0]?.code).toBe("font-load-timeout");
  });

  it("deduplicates and clears bounded cache entries", async () => {
    let loads = 0;
    const fontSet = {
      load: async () => {
        loads += 1;
        return [];
      },
    };
    const cache = new AppearanceFontLoadCache();
    await cache.load([{ family: "Inter" }], { fontSet });
    await cache.load([{ family: "Inter" }], { fontSet });
    expect(loads).toBe(1);
    cache.clear();
    await cache.load([{ family: "Inter" }], { fontSet });
    expect(loads).toBe(2);
  });

  it("loads distinct style and weight faces from the same family", async () => {
    const descriptors: string[] = [];
    await loadAppearanceFonts(
      [
        { family: "Inter", style: "normal", weight: 400 },
        { family: "Inter", style: "italic", weight: 700 },
      ],
      {
        fontSet: {
          load: async (descriptor) => {
            descriptors.push(descriptor);
            return [];
          },
        },
      },
    );
    expect(descriptors).toEqual(['400 16px "Inter"', 'italic 700 16px "Inter"']);
  });

  it("evicts diagnosed probes so a repaired font can retry", async () => {
    let loads = 0;
    const cache = new AppearanceFontLoadCache();
    const fontSet = {
      load: async () => {
        loads += 1;
        if (loads === 1) throw new Error("broken");
        return [];
      },
    };
    expect((await cache.load([{ family: "Repairable" }], { fontSet })).diagnostics).toHaveLength(1);
    expect((await cache.load([{ family: "Repairable" }], { fontSet })).diagnostics).toHaveLength(0);
    expect(loads).toBe(2);
  });

  it("publishes diagnostics and clears them after a successful retry", async () => {
    const snapshots: number[] = [];
    const unsubscribe = subscribeAppearanceFontLoadDiagnostics(() => {
      snapshots.push(getAppearanceFontLoadDiagnostics().length);
    });
    const first = await loadAppearanceFonts([{ family: "Repairable" }], {
      fontSet: { load: async () => Promise.reject(new Error("broken")) },
    });
    setAppearanceFontLoadDiagnostics(first.diagnostics);
    expect(getAppearanceFontLoadDiagnostics()[0]?.recovery).toContain("retry");

    const repaired = await loadAppearanceFonts([{ family: "Repairable" }], {
      fontSet: { load: async () => [] },
    });
    setAppearanceFontLoadDiagnostics(repaired.diagnostics);
    unsubscribe();
    expect(snapshots).toEqual([1, 0]);
    expect(getAppearanceFontLoadDiagnostics()).toEqual([]);
  });
});
