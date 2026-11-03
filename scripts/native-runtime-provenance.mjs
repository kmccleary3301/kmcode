import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const optional = (name) => process.env[name]?.trim() || undefined;
const platform = { Windows: "win32", macOS: "darwin", Linux: "linux" }[required("RUNNER_OS")];
const architecture = { X64: "x64", ARM64: "arm64" }[required("RUNNER_ARCH")];
if (!platform || !architecture)
  throw new Error("Unsupported GitHub runner platform or architecture");

const sha256 = (path) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

const runtimeIdentity = (binary) => {
  const path = NodeFS.realpathSync(binary);
  const versionOutput = NodeChildProcess.execFileSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    ...(platform === "win32" && /\.(?:cmd|bat)$/iu.test(path) ? { shell: true } : {}),
  }).trim();
  if (!versionOutput) throw new Error(`${NodePath.basename(path)} returned an empty version`);
  return { name: NodePath.basename(path), sha256: sha256(path), versionOutput };
};

/** Both runtimes are stock npm packages pinned by version and registry integrity. */
const packageProvenance = (runtime) => {
  const prefix = `T3_NATIVE_${runtime.toUpperCase()}`;
  const packageRoot = NodeFS.realpathSync(required(`${prefix}_PACKAGE_ROOT`));
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
  );
  const version = required(`${prefix}_VERSION`);
  if (manifest.version !== version) {
    throw new Error(
      `${runtime} package version mismatch: expected ${version}, got ${manifest.version}`,
    );
  }
  const integrity = required(`${prefix}_INTEGRITY`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new Error(`${runtime} package integrity is not a sha512 SRI value`);
  }
  return {
    package: manifest.name,
    version: manifest.version,
    integrity,
    binary: runtimeIdentity(required(`${prefix}_BINARY`)),
  };
};

const outputPath = required("T3_NATIVE_PROVENANCE_REPORT");
const sourceHead = required("T3_EVIDENCE_SOURCE_HEAD");
if (!/^[0-9a-f]{40}$/u.test(sourceHead)) {
  throw new Error("Evidence source head is not a full Git SHA");
}

const lifecycleRepository = optional("T3_LIFECYCLE_REPOSITORY");
const lifecycleReleaseTag = optional("T3_LIFECYCLE_RELEASE_TAG");
const lifecyclePreviousTag = optional("T3_LIFECYCLE_PREVIOUS_TAG");
if (
  [lifecycleRepository, lifecycleReleaseTag, lifecyclePreviousTag].filter(Boolean).length !== 0 &&
  (!lifecycleRepository || !lifecycleReleaseTag || !lifecyclePreviousTag)
) {
  throw new Error("Lifecycle release provenance must be complete when provided");
}

const report = {
  schemaVersion: 2,
  sourceHead,
  platform,
  architecture,
  release:
    lifecycleRepository && lifecycleReleaseTag && lifecyclePreviousTag
      ? {
          repository: lifecycleRepository,
          currentTag: lifecycleReleaseTag,
          previousTag: lifecyclePreviousTag,
        }
      : null,
  pi: packageProvenance("pi"),
  omp: packageProvenance("omp"),
};
NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
NodeFS.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
