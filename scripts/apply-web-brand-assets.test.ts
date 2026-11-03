import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";

const WEB_ICON_FILENAMES = [
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
];

it.layer(NodeServices.layer)("apply-web-brand-assets", (it) => {
  it.effect("copies icons into an absolute target directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const targetDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "apply-web-brand-assets-",
      });

      yield* applyWebBrandAssets("production", targetDirectory);

      assert.deepStrictEqual(
        (yield* fs.readDirectory(targetDirectory)).toSorted(),
        WEB_ICON_FILENAMES,
      );
    }),
  );
});
