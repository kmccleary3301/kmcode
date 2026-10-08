// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/mobile/modules/t3-markdown-text/package.json",
  "apps/mobile/modules/t3-review-diff/package.json",
  "apps/mobile/modules/t3-ssh/package.json",
  "apps/mobile/modules/t3-terminal/package.json",
  "apps/marketing/package.json",
  "infra/relay/package.json",
  "oxlint-plugin-t3code/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = NodePath.resolve(repoRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  const mobileDependencies = NodePath.resolve(repoRoot, "apps/mobile/deps");
  if (NodeFS.existsSync(mobileDependencies)) {
    NodeFS.cpSync(mobileDependencies, NodePath.resolve(targetRoot, "apps/mobile/deps"), {
      recursive: true,
    });
  }

  const patchesDirectory = NodePath.resolve(repoRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "latest-mac.yml");
  const x64Path = NodePath.resolve(assetDirectory, "latest-mac-x64.yml");

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: KM-Code-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: KM-Code-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: KM-Code-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: KM-Code-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: KM-Code-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: KM-Code-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsManifestFixtures(
  targetRoot: string,
  channel: string,
): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, `${channel}-win-arm64.yml`);
  const x64Path = NodePath.resolve(assetDirectory, `${channel}-win-x64.yml`);

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: KM-Code-9.9.9-smoke.0-arm64.exe
    sha512: arm64exe
    size: 126621344
  - url: KM-Code-9.9.9-smoke.0-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 152344
path: KM-Code-9.9.9-smoke.0-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: KM-Code-9.9.9-smoke.0-x64.exe
    sha512: x64exe
    size: 132000112
  - url: KM-Code-9.9.9-smoke.0-x64.exe.blockmap
    sha512: x64blockmap
    size: 160112
path: KM-Code-9.9.9-smoke.0-x64.exe
sha512: x64exe
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsBuilderDebugFixtures(targetRoot: string): {
  arm64Path: string;
  x64Path: string;
} {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "builder-debug-win-arm64.yml");
  const x64Path = NodePath.resolve(assetDirectory, "builder-debug-win-x64.yml");
  const debugFixture = `arm64:
  firstOrDefaultFilePatterns:
    - '**/*'
nsis:
  script: |-
    !include "example.nsh"
`;

  NodeFS.writeFileSync(arm64Path, debugFixture);
  NodeFS.writeFileSync(x64Path, debugFixture);

  return { arm64Path, x64Path };
}
function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertExists(path: string, message: string): void {
  if (!NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

function assertPackageVersion(path: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    readonly version?: unknown;
  };

  if (packageJson.version !== version) {
    throw new Error(`Expected ${path} to have version ${version}.`);
  }
}

function assertMissing(path: string, message: string): void {
  if (NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));

try {
  NodeChildProcess.execFileSync(
    process.execPath,
    ["--test", NodePath.resolve(repoRoot, ".github/scripts/relay-state-output.test.cjs")],
    { stdio: "inherit" },
  );

  copyWorkspaceManifestFixture(tempRoot);

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  NodeFS.rmSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), { force: true });

  NodeChildProcess.execFileSync("vp", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
  assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ]) {
    assertPackageVersion(NodePath.resolve(tempRoot, relativePath), "9.9.9-smoke.0");
  }

  const nightlyReleaseMetadata = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    nightlyReleaseMetadata,
    "version=9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly version.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "tag=v9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly tag.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "name=KM Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected nightly metadata to include the short commit SHA in the release name.",
  );

  const forkNightlyReleaseMetadata = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--profile",
      "pi-omp",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    forkNightlyReleaseMetadata,
    "tag=fork-v9.9.10-nightly.20260413.321",
    "Expected Pi + OMP nightly metadata to use the fork release tag.",
  );
  assertContains(
    forkNightlyReleaseMetadata,
    "name=KM Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected Pi + OMP nightly metadata to use the isolated product name.",
  );

  const releaseWorkflow = NodeFS.readFileSync(
    NodePath.resolve(repoRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  assertContains(releaseWorkflow, 'release_tag_prefix="fork-v"', "Fork release tag drifted.");
  assertContains(
    releaseWorkflow,
    "always() &&",
    "Release preflight must run when the schedule-only change check is skipped.",
  );
  assertContains(
    releaseWorkflow,
    "fork-release",
    "Fork releases must not require the production relay environment.",
  );
  assertContains(releaseWorkflow, 'cli_package_name="t3-pi-omp"', "Fork npm package drifted.");
  assertContains(releaseWorkflow, "--provenance", "npm provenance is not enabled.");
  assertContains(
    releaseWorkflow,
    "T3_PI_OMP_PUBLISH_NPM",
    "Fork npm publication must remain an explicit opt-in.",
  );
  assertContains(
    releaseWorkflow,
    "--pack-destination cli-release",
    "Fork GitHub release tarball packaging drifted.",
  );
  assertContains(
    releaseWorkflow,
    "actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
    "Release attestation drifted.",
  );
  assertContains(
    releaseWorkflow,
    "release-assets/SHA256SUMS",
    "Release checksum publication drifted.",
  );
  assertContains(
    releaseWorkflow,
    "T3_PI_OMP_RELEASE_REPOSITORY",
    "Fork release repository configuration drifted.",
  );
  assertContains(
    releaseWorkflow,
    "T3CODE_DESKTOP_UPDATE_REPOSITORY",
    "Desktop updater repository configuration drifted.",
  );
  assertContains(releaseWorkflow, "RELEASE-MANIFEST.json", "Release manifest publication drifted.");
  assertContains(releaseWorkflow, "Linux arm64", "Linux arm64 release matrix row drifted.");
  assertContains(
    releaseWorkflow,
    "T3_PI_OMP_RUNTIME_BUNDLES_JSON",
    "Optional runtime bundle configuration drifted.",
  );
  assertContains(
    releaseWorkflow,
    "needs.prepare_runtime_bundles.outputs.has_assets",
    "Optional runtime bundle publication gate drifted.",
  );

  const upstreamConfig = JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.resolve(repoRoot, "scripts/resolve-release-config.ts"),
        "--profile",
        "upstream",
        "--current-repository",
        "pingdotgg/t3code",
        "--updater-repository",
        "pingdotgg/t3code",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    ),
  ) as { packageName: string; binaryName: string; tagPrefix: string; updaterRepository: string };
  assertContains(
    JSON.stringify(upstreamConfig),
    '"packageName":"t3"',
    "Upstream package identity drifted.",
  );
  assertContains(
    JSON.stringify(upstreamConfig),
    '"tagPrefix":"v"',
    "Upstream release tag drifted.",
  );

  const forkConfig = JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.resolve(repoRoot, "scripts/resolve-release-config.ts"),
        "--profile",
        "pi-omp",
        "--current-repository",
        "owner/t3-private",
        "--fork-release-repository",
        "owner/t3-private",
        "--updater-repository",
        "owner/t3-private",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    ),
  ) as { packageName: string; binaryName: string; tagPrefix: string; updaterRepository: string };
  assertContains(
    JSON.stringify(forkConfig),
    '"packageName":"t3-pi-omp"',
    "Fork package identity drifted.",
  );
  assertContains(JSON.stringify(forkConfig), '"tagPrefix":"fork-v"', "Fork release tag drifted.");

  const manifestAssets = NodePath.resolve(tempRoot, "manifest-assets");
  NodeFS.mkdirSync(manifestAssets, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(manifestAssets, "t3-pi-omp-9.9.9-smoke.0.tgz"), "cli");
  NodeFS.writeFileSync(
    NodePath.join(manifestAssets, "KM-Code-Pi-OMP-9.9.9-smoke.0-arm64.dmg"),
    "desktop",
  );
  NodeFS.writeFileSync(NodePath.join(manifestAssets, "install.sh"), "#!/usr/bin/env bash\\n");
  NodeFS.writeFileSync(
    NodePath.join(manifestAssets, "pi-runtime-darwin-arm64.tar.gz"),
    "pi runtime",
  );
  NodeFS.writeFileSync(
    NodePath.join(manifestAssets, "omp-runtime-darwin-arm64.tar.gz"),
    "omp runtime",
  );
  const manifestPath = NodePath.join(manifestAssets, "RELEASE-MANIFEST.json");
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/generate-release-manifest.ts"),
      "--root",
      tempRoot,
      "--assets",
      manifestAssets,
      "--output",
      manifestPath,
      "--profile",
      "pi-omp",
      "--channel",
      "nightly",
      "--tag",
      "fork-v9.9.9-smoke.0",
      "--commit",
      "abcdef1234567890",
      "--repository",
      "owner/t3-private",
      "--updater-repository",
      "owner/t3-private",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
    profile: string;
    packageName: string;
    bin: string;
    clientVersion: string;
    serverVersion: string;
    channel: string;
    tag: string;
    repository: string;
    artifacts: ReadonlyArray<{
      kind: string;
      sha256: string;
      runtime?: string;
      platform?: string;
      arch?: string;
    }>;
  };
  if (
    manifest.profile !== "pi-omp" ||
    manifest.packageName !== "t3-pi-omp" ||
    manifest.bin !== "t3-pi-omp"
  ) {
    throw new Error("Fork release manifest package identity is incoherent.");
  }
  if (manifest.clientVersion !== manifest.serverVersion || manifest.channel !== "nightly") {
    throw new Error("Release manifest client/server or channel metadata is incoherent.");
  }
  if (manifest.tag !== "fork-v9.9.9-smoke.0" || manifest.repository !== "owner/t3-private") {
    throw new Error("Fork release manifest repository/tag metadata drifted.");
  }
  if (
    !manifest.artifacts.some(
      (artifact) => artifact.kind === "cli" && /^[0-9a-f]{64}$/u.test(artifact.sha256),
    )
  ) {
    throw new Error("Release manifest is missing hashed CLI artifact metadata.");
  }
  const desktopArtifact = manifest.artifacts.find((artifact) => artifact.kind === "desktop");
  if (desktopArtifact?.platform !== "darwin" || desktopArtifact.arch !== "arm64") {
    throw new Error("Release manifest is missing desktop platform metadata.");
  }
  for (const [runtime, artifact] of [
    ["pi", manifest.artifacts.find((candidate) => candidate.runtime === "pi")],
    ["omp", manifest.artifacts.find((candidate) => candidate.runtime === "omp")],
  ] as const) {
    if (
      artifact?.kind !== "runtime" ||
      artifact.platform !== "darwin" ||
      artifact.arch !== "arm64" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) {
      throw new Error(`Release manifest is missing hashed ${runtime} runtime metadata.`);
    }
  }

  const publishCli = NodeFS.readFileSync(
    NodePath.resolve(repoRoot, "apps/server/scripts/cli.ts"),
    "utf8",
  );
  assertContains(
    publishCli,
    "packageName: resource.packageName",
    "Profile-aware npm publish selection drifted.",
  );

  const installer = NodeFS.readFileSync(NodePath.resolve(repoRoot, "scripts/install.sh"), "utf8");
  assertContains(installer, "--profile", "Installer profile selection drifted.");
  assertContains(installer, "--install-runtimes", "Installer runtime installation flag drifted.");
  assertContains(
    installer,
    "--ignore-scripts",
    "Installer must not run package lifecycle scripts.",
  );
  assertContains(
    installer,
    "RELEASE-MANIFEST.json",
    "Installer release manifest verification drifted.",
  );
  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"),
      "--platform",
      "mac",
      arm64Path,
      x64Path,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = NodeFS.readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "KM-Code-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "KM-Code-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  const { arm64Path: winArm64Path, x64Path: winX64Path } = writeWindowsManifestFixtures(
    tempRoot,
    "latest",
  );
  const mergedWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/latest.yml");
  const { arm64Path: nightlyWinArm64Path, x64Path: nightlyWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "nightly");
  const mergedNightlyWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/nightly.yml");
  const { arm64Path: previewWinArm64Path, x64Path: previewWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "preview");
  const mergedPreviewWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/preview.yml");
  const { arm64Path: winDebugArm64Path, x64Path: winDebugX64Path } =
    writeWindowsBuilderDebugFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    "bash",
    [
      "-lc",
      `
        release_assets_dir=${JSON.stringify(NodePath.resolve(tempRoot, "release-assets"))}
        shopt -s nullglob
        found_windows_manifest=false
        for x64_manifest in "$release_assets_dir"/*-win-x64.yml; do
          if [[ "$(basename "$x64_manifest")" == builder-debug-* ]]; then
            continue
          fi

          arm64_manifest="\${x64_manifest/-x64.yml/-arm64.yml}"
          output_manifest="\${x64_manifest/-win-x64.yml/.yml}"
          if [[ ! -f "$arm64_manifest" ]]; then
            echo "Missing matching arm64 Windows manifest for $x64_manifest" >&2
            exit 1
          fi

          found_windows_manifest=true
          ${JSON.stringify(process.execPath)} ${JSON.stringify(NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"))} --platform win \
            "$arm64_manifest" \
            "$x64_manifest" \
            "$output_manifest"
          rm -f "$arm64_manifest" "$x64_manifest"
        done

        if [[ "$found_windows_manifest" != true ]]; then
          echo "No Windows updater manifests found to merge." >&2
          exit 1
        fi
      `,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedWindowsManifest = NodeFS.readFileSync(mergedWindowsManifestPath, "utf8");
  assertContains(
    mergedWindowsManifest,
    "KM-Code-9.9.9-smoke.0-arm64.exe",
    "Merged Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "KM-Code-9.9.9-smoke.0-x64.exe",
    "Merged Windows manifest is missing the x64 asset.",
  );
  const mergedNightlyWindowsManifest = NodeFS.readFileSync(
    mergedNightlyWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "KM-Code-9.9.9-smoke.0-arm64.exe",
    "Merged nightly Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "KM-Code-9.9.9-smoke.0-x64.exe",
    "Merged nightly Windows manifest is missing the x64 asset.",
  );
  const mergedPreviewWindowsManifest = NodeFS.readFileSync(
    mergedPreviewWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "KM-Code-9.9.9-smoke.0-arm64.exe",
    "Merged preview Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "KM-Code-9.9.9-smoke.0-x64.exe",
    "Merged preview Windows manifest is missing the x64 asset.",
  );
  assertMissing(
    winArm64Path,
    "Windows release smoke unexpectedly kept the arm64 updater manifest.",
  );
  assertMissing(winX64Path, "Windows release smoke unexpectedly kept the x64 updater manifest.");
  assertMissing(
    nightlyWinArm64Path,
    "Windows release smoke unexpectedly kept the nightly arm64 updater manifest.",
  );
  assertMissing(
    nightlyWinX64Path,
    "Windows release smoke unexpectedly kept the nightly x64 updater manifest.",
  );
  assertMissing(
    previewWinArm64Path,
    "Windows release smoke unexpectedly kept the preview arm64 updater manifest.",
  );
  assertMissing(
    previewWinX64Path,
    "Windows release smoke unexpectedly kept the preview x64 updater manifest.",
  );
  assertExists(
    winDebugArm64Path,
    "Windows release smoke unexpectedly removed the arm64 builder debug fixture.",
  );
  assertExists(
    winDebugX64Path,
    "Windows release smoke unexpectedly removed the x64 builder debug fixture.",
  );

  Effect.runSync(Console.log("Release smoke checks passed."));
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
