import { describe, expect, it } from "vite-plus/test";

import { isTestChangedFile } from "./changedFileKind";

describe("isTestChangedFile", () => {
  it.each([
    "src/app.test.ts",
    "src/App.spec.tsx",
    "src/__tests__/app.ts",
    "src/mocks/client.ts",
    "src/client.fixtures.json",
    "src/snapshot.snap",
    "src\\__mocks__\\client.ts",
  ])("recognizes test and support files: %s", (path) => {
    expect(isTestChangedFile(path)).toBe(true);
  });

  it.each(["src/app.ts", "src/test-plan.md", "src/mockup.ts"])(
    "keeps production files visible: %s",
    (path) => {
      expect(isTestChangedFile(path)).toBe(false);
    },
  );
});
