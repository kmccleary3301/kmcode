import { assert, it } from "@effect/vitest";

import { classifyFiles } from "./classify-ci-change.ts";

it("sends provider, decoder, projector, and fixture changes to replay and budget gates", () => {
  const result = classifyFiles([
    "apps/server/src/provider/PiRpc.ts",
    "apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts",
    "apps/server/src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts",
  ]);
  assert.equal(result.replayGate, true);
  assert.equal(result.budgetGate, true);
  assert.equal(result.docsOnly, false);
});
it("runs replay and budget gates when the focused CI workflow changes", () => {
  const result = classifyFiles([".github/workflows/ci.yml"]);
  assert.equal(result.replayGate, true);
  assert.equal(result.budgetGate, true);
  assert.equal(result.distributionGate, true);
});

it("routes release-only changes to distribution without publishing documentation changes", () => {
  const release = classifyFiles(["scripts/install.sh", ".github/workflows/release.yml"]);
  assert.equal(release.distributionGate, true);
  assert.equal(release.publish, true);

  const docs = classifyFiles(["docs/user/install.md", "docs/operations/release.md"]);
  assert.equal(docs.docsOnly, true);
  assert.equal(docs.distributionGate, true);
  assert.equal(docs.publish, false);
});

it("does not enable release publication for unrelated source changes", () => {
  const result = classifyFiles(["apps/web/src/components/ThreadList.tsx"]);
  assert.equal(result.distributionGate, false);
  assert.equal(result.publish, false);
});
