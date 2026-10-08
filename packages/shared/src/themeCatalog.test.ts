import { assert, describe, it } from "@effect/vitest";

import { APP_THEME_CATALOG, WORKBENCH_THEMES } from "./themeCatalog.ts";
import { BUILT_IN_THEMES, RESERVED_THEME_IDS, WORKBENCH_THEME_IDS } from "./themePalettes.ts";

describe("app theme catalog", () => {
  it("adds the curated workbench themes without expanding the mobile core catalog", () => {
    assert.deepEqual(
      WORKBENCH_THEMES.map((theme) => theme.id),
      [...WORKBENCH_THEME_IDS],
    );
    assert.deepEqual(APP_THEME_CATALOG.slice(0, BUILT_IN_THEMES.length), BUILT_IN_THEMES);
    assert.equal(APP_THEME_CATALOG.length, BUILT_IN_THEMES.length + WORKBENCH_THEME_IDS.length);
  });

  it("has unique reserved ids for every bundled app theme", () => {
    const ids = APP_THEME_CATALOG.map((theme) => theme.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.isTrue(RESERVED_THEME_IDS.has(id));
  });
});
