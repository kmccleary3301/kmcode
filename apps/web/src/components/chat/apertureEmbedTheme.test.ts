import { describe, expect, it } from "vite-plus/test";

import { apertureEmbedTheme, apertureVizThemeForKmTheme } from "./apertureEmbedTheme";

const variables = {
  "--background": "oklch(0.930580 0.013736 92.988)",
  "--card": "oklch(0.960760 0.009531 93.569)",
  "--foreground": "#3c3930",
  "--accent": "oklch(0.617148 0.137546 39.043)",
  "--font-sans": "Inter",
  "--font-mono": "Berkeley Mono",
};

describe("apertureVizThemeForKmTheme", () => {
  it("picks the paired twin for the active appearance", () => {
    expect(apertureVizThemeForKmTheme("parchment", "light")).toBe("parchment");
    expect(apertureVizThemeForKmTheme("parchment", "dark")).toBe("parchment-dark");
    expect(apertureVizThemeForKmTheme("km-code", "dark")).toBe("km-code-dark");
  });

  it("maps single themes, including the ones whose Aperture id differs", () => {
    expect(apertureVizThemeForKmTheme("dracula-official", "dark")).toBe("dracula");
    expect(apertureVizThemeForKmTheme("ros-pine", "dark")).toBe("rose-pine");
    expect(apertureVizThemeForKmTheme("nord", "dark")).toBe("nord");
  });

  it("has no twin for themes Aperture does not ship", () => {
    expect(apertureVizThemeForKmTheme("synthwave-84", "dark")).toBeNull();
    expect(apertureVizThemeForKmTheme(null, "light")).toBeNull();
  });
});

describe("apertureEmbedTheme", () => {
  it("names the twin and keeps the transcript background and fonts", () => {
    const theme = apertureEmbedTheme({
      appearance: "dark",
      variables,
      themeId: "parchment",
      override: undefined,
    });
    expect(theme.vizTheme).toBe("parchment-dark");
    expect(theme.tokens).toEqual({
      "--plot-page": variables["--background"],
      "--plot-font-ui": "Inter",
      "--plot-font-mono": "Berkeley Mono",
    });
  });

  it("sends the active palette, in sRGB, when no twin exists", () => {
    const theme = apertureEmbedTheme({
      appearance: "light",
      variables,
      themeId: "custom-forest",
      override: undefined,
    });
    expect(theme.vizTheme).toBe("");
    expect(theme.colors?.text).toBe("#3c3930");
    expect(theme.colors?.page).toBe("#ebe8de");
    expect(theme.colors?.accent).toBe("#c96442");
  });

  it("lets the agent's theme replace the host's, background and fonts included", () => {
    expect(
      apertureEmbedTheme({
        appearance: "dark",
        variables,
        themeId: "parchment",
        override: "nature",
      }),
    ).toEqual({ appearance: "dark", vizTheme: "nature", tokens: {} });
  });
});
