import * as Schema from "effect/Schema";

import ayuDarkThemeFile from "../../../assets/themes-buffet/ayu-dark.theme.json" with { type: "json" };
import ayuLightThemeFile from "../../../assets/themes-buffet/ayu-light.theme.json" with { type: "json" };
import ayuMirageThemeFile from "../../../assets/themes-buffet/ayu-mirage.theme.json" with { type: "json" };
import catppuccinMochaThemeFile from "../../../assets/themes-buffet/catppuccin-mocha.theme.json" with { type: "json" };
import draculaOfficialThemeFile from "../../../assets/themes-buffet/dracula-official.theme.json" with { type: "json" };
import gruvboxMaterialDarkThemeFile from "../../../assets/themes-buffet/gruvbox-material-dark.theme.json" with { type: "json" };
import monolineVoidThemeFile from "../../../assets/themes-buffet/monoline-void.theme.json" with { type: "json" };
import neonTokyoCyberThemeFile from "../../../assets/themes-buffet/neon-tokyo-cyber.theme.json" with { type: "json" };
import nordThemeFile from "../../../assets/themes-buffet/nord.theme.json" with { type: "json" };
import oneDarkProThemeFile from "../../../assets/themes-buffet/one-dark-pro.theme.json" with { type: "json" };
import rosPineMoonThemeFile from "../../../assets/themes-buffet/ros-pine-moon.theme.json" with { type: "json" };
import rosPineThemeFile from "../../../assets/themes-buffet/ros-pine.theme.json" with { type: "json" };
import synthwave84ThemeFile from "../../../assets/themes-buffet/synthwave-84.theme.json" with { type: "json" };
import tokyoNightThemeFile from "../../../assets/themes-buffet/tokyo-night.theme.json" with { type: "json" };
import { AppearanceColorsSchema } from "./appearance/schema.ts";
import { BUILT_IN_THEMES, WORKBENCH_THEME_IDS, type ThemeDefinition } from "./themePalettes.ts";

const WorkbenchThemeFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.Literals(WORKBENCH_THEME_IDS),
  name: Schema.String,
  appearance: Schema.Literals(["light", "dark"]),
  colors: AppearanceColorsSchema,
});

const decodeWorkbenchThemeFile = Schema.decodeUnknownSync(WorkbenchThemeFileSchema);

const WORKBENCH_THEME_FILES: ReadonlyArray<unknown> = [
  ayuLightThemeFile,
  ayuDarkThemeFile,
  ayuMirageThemeFile,
  tokyoNightThemeFile,
  catppuccinMochaThemeFile,
  oneDarkProThemeFile,
  draculaOfficialThemeFile,
  nordThemeFile,
  rosPineThemeFile,
  rosPineMoonThemeFile,
  gruvboxMaterialDarkThemeFile,
  synthwave84ThemeFile,
  monolineVoidThemeFile,
  neonTokyoCyberThemeFile,
];

function toThemeDefinition(input: unknown): ThemeDefinition {
  const file = decodeWorkbenchThemeFile(input);
  return {
    id: file.id,
    label: file.name,
    appearance: file.appearance,
    colors: file.colors,
  };
}

export const WORKBENCH_THEMES: ReadonlyArray<ThemeDefinition> =
  WORKBENCH_THEME_FILES.map(toThemeDefinition);

/** The complete built-in catalog available to the web and desktop apps. */
export const APP_THEME_CATALOG: ReadonlyArray<ThemeDefinition> = [
  ...BUILT_IN_THEMES,
  ...WORKBENCH_THEMES,
];
