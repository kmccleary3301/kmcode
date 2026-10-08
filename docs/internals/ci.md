# CI quality gates

> For maintainers. KM Code is Kyle McCleary's fork of T3 Code; compatibility identifiers below
> intentionally remain stable. Using the product? See [docs/user](../user/).

[`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pull
requests and on pushes to `main`. It is repository evidence, not a claim that
every release environment or native provider has been exercised.

## What pull-request CI executes

The four jobs are deliberately split by the tools and operating systems they
need:

- **Check** runs on Ubuntu 24.04. `setup-vp` reads the root `package.json`,
  installs with Vite Plus, and the job runs:
  - `vp test run scripts/install.test.ts` — installer argument, isolated-prefix,
    injection, and optional runtime-launcher tests using local fakes;
  - `vp test run packages/contracts/src/productIdentity.test.ts` — upstream and
    `pi-omp` identity separation and fail-closed profile parsing;
  - `vp check`, `vpr typecheck`, and Rust formatting;
  - `vp run build:desktop`, followed by assertions that the preload bundle
    exists and exports the expected bridge, passkey, protocol, and WebSocket
    symbols.
- **Test** runs on Ubuntu 24.04. `vp run test` runs the workspace test scripts, followed by the
  resource-monitor Rust tests. The Pi and OMP adapter tests (`PiAdapterV2`, `OmpAdapterV2`) drive
  scripted RPC peers in the current Node process; they do not download or invoke stock binaries.
- **Pi OMP Focused Gate** runs on Ubuntu 24.04. It installs stock npm Pi and OMP at exact versions
  and integrity hashes, records their provenance, and runs
  `apps/server/integration/nativeRuntimeLifecycle.integration.test.ts`: a real KM Code server over
  authenticated HTTP and WebSocket drives each runtime against a local OpenAI-compatible model
  through root turn, native tool call, interrupt, resume, native-session listing/open/rename/
  archive, and recovery after a killed runtime process. It then runs the Pi/OMP adapter,
  native-session, provider, and text-generation tests, the transfer-budget gates, and a
  deterministic performance baseline. Its artifact contains sanitized test outcomes, provenance,
  and aggregate transfer/performance data only.
- **Mobile Native Static Analysis** runs on macOS 26 because the mobile native
  toolchain and `apps/mobile/Brewfile` are macOS-only. It installs those tools
  and runs `vp run lint:mobile`. This is not a mobile simulator/device test and
  does not add a Windows or Linux native lane.
- **Release Smoke** runs on Ubuntu 24.04 with `vp run release:smoke`. The
  existing `scripts/release-smoke.ts` uses a temporary manifest fixture,
  exercises release-version/tag and updater-manifest logic, and checks
  release-workflow, publish, and installer invariants. It does not publish,
  sign, notarize, build an Electron artifact, or use release credentials.

The Check job runs `vp run check:ts-relative-imports` against `apps/server/src` and
`vp run check:workflow-action-pins`. The former requires explicit relative source extensions; the
latter requires immutable action SHAs with revision comments and verifies the workflow-run
publisher checks out only the trusted default branch.

These jobs use GitHub-hosted runner labels so they execute in the owner-controlled fork without
requiring the upstream Blacksmith runner integration. The production relay workflow skips fork
pushes unless `T3_ENABLE_RELAY_DEPLOY=true`; fork releases consume their separately configured relay
metadata instead of deploying upstream infrastructure.

## Private state canary

[`private-state-canary.yml`](../../.github/workflows/private-state-canary.yml) is a scheduled,
owner-controlled lane, not a pull-request gate. It requires a Linux self-hosted runner labeled
`private-state` and the repository variable `T3_PRIVATE_STATE_DB`, whose value is an absolute path
to a stopped local `state.sqlite`. The lane fails closed when either is absent.

The job snapshots the source with SQLite `VACUUM INTO`, migrates and reprojects disposable copies,
compares aggregate state, and deletes every copied database in a shell `trap`. It publishes no
artifact and logs no private rows, prompts, paths, or native output. The `migration` injection
must fail while preserving the source digest and leaving only a mode-0600 aggregate report in the
mode-0700 temporary directory.

## Compatibility matrix

The release workflow selects a profile explicitly from its tag, input, or repository configuration.
An installed CLI can additionally recover the `pi-omp` profile from its dedicated package or binary
name when `T3_PRODUCT_PROFILE` is absent. Neither path infers behavior from a provider version.

| Concern           | KM Code (`upstream`)      | KM Code (`pi-omp`)             |
| ----------------- | ------------------------- | ------------------------------ |
| Display name      | `KM Code` + stage         | `KM Code` + stage              |
| Stable tag        | `vX.Y.Z`                  | `fork-vX.Y.Z`                  |
| Nightly tag       | `vX.Y.Z-nightly.DATE.RUN` | `fork-vX.Y.Z-nightly.DATE.RUN` |
| npm package / CLI | `t3` / `t3`               | `t3-pi-omp` / `t3-pi-omp`      |
| Desktop bundle ID | `com.t3tools.t3code`      | `com.t3tools.t3code.piomp`     |
| Production scheme | `t3code`                  | `t3code-pi-omp`                |
| State directory   | `t3code`                  | `t3code-pi-omp`                |

### Native runtime lanes

Native releases pass two gates: a minimum version, then the actual RPC contract. A version match
alone never marks a provider ready.

| Runtime lane | Validated identity                                                                                                  | Protocol proof                                                 | Support status       |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------- |
| Pi stock     | `0.84.4`; npm SRI `sha512-jmOlrqUmvhh/siNWFRXjYLJzhKFIHNsAQaysRwzQPQFnPAaV/vhqHsLH/MBsIISA1Rjj7WTUFR3nJrpXoLx39w==` | Pi RPC; strict LF JSONL; `get_entries` and `agent_settled`     | Supported `>=0.80.5` |
| OMP stock    | `18.8.4`; npm SRI `sha512-MIiecZZbQT45Lnn1fJwq2gCG2+LBJwQ0cyQodqIPxnzcIRgawapLEaYZn/zXBo+0tn2oCZO6QiJrgKHe1OrsHg==` | `ready` frame, protocol v2 negotiation, `rpc_chunk` reassembly | Supported `>=18.8.3` |

The focused gate runs the lifecycle matrix against these exact packages on every relevant pull
request; the release lifecycle repeats it on macOS, Linux, and Windows and then drives the installed
release artifact through a root turn on each runtime. These gates are credential-free and do not
replace authenticated root-turn evidence.

### Node and package manager

The repository root declares Node.js `^24.13.1` and `pnpm@11.10.0`.
Pull-request CI uses `setup-vp` with that root declaration and Vite Plus for
installation and tasks.

### Pi and OMP runtime protocol baseline

Both runtimes run through one adapter and RPC transport, parameterized by a dialect
(`apps/server/src/provider/piDialect.ts`).

- **Both runtimes:** RPC is strict LF-delimited JSON with responses correlated by request ID.
  Process exit fails pending work. Sessions resume by switching to their native session file, so a
  restarted runtime continues the same history.
- **Pi:** `0.80.5` is the first published release with both `get_entries` (rollback boundaries) and
  `agent_settled` (turn terminalization); older releases fail before launch.
- **OMP:** the runtime must emit a `ready` frame; the adapter then negotiates protocol v2 and
  reassembles `rpc_chunk` frames with `OmpChunkAssembler`. `18.8.3` is the first release verified
  against that negotiation and chunked model discovery.

### Replay fixtures

`apps/server/scripts/nativeTraceFixtures.ts` holds small synthetic Pi and OMP traces, including a
chunked OMP stream. `performance-baseline.ts` replays them through `OmpChunkAssembler` and the
JSONL decoder to record deterministic decode/replay timings with generous ceilings. They are
generated fixtures, not native captures, and must never be relabeled as such.

### Release artifact targets

The tag/scheduled release workflow currently builds these targets:

| Platform | Artifact target                   | Architecture and native limit                                                                    |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| macOS    | DMG and updater ZIP               | arm64 and x64                                                                                    |
| Linux    | AppImage                          | x64 and arm64, glibc (`x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`); no musl release |
| Windows  | NSIS installer and updater assets | x64 only, MSVC (`x86_64-pc-windows-msvc`); the Windows arm64 matrix entry is disabled            |

The artifact builder has code paths for additional architectures, but those paths are not release
evidence until a release matrix enables them. macOS signing/passkey and Windows Trusted Signing
depend on release-only credentials. Missing credentials produce unsigned artifacts where the release
workflow allows that; pull-request CI does not test signing.

The published `fork-v0.0.47` release contains every target in the matrix above plus the
profile-specific CLI/web tarball. Release workflow run
[`32718276003`](https://github.com/kmccleary3301/kmcode/actions/runs/32718276003) built Linux
arm64/x64, macOS arm64/x64, and Windows x64 on matching GitHub-hosted runners. GitHub provenance
attestations cover the release assets. Platform-signing credentials were not configured, so the
desktop artifacts are unsigned and the macOS artifacts are unnotarized.

The current `fork-v0.0.47` lifecycle run
[`32721583970`](https://github.com/kmccleary3301/kmcode/actions/runs/32721583970) passed all five
target-host jobs. POSIX jobs exercised CLI install/upgrade/rollback/uninstall and native-config
preservation on macOS arm64/x64 and Linux arm64/x64, plus desktop artifact install/upgrade/identity/
rollback/uninstall and tampered-checksum, partial-download, missing-asset, and missing-release
no-mutation checks. The Windows job exercised CLI and NSIS desktop install/upgrade/rollback/uninstall
with disposable Pi/OMP state roots. The prior `fork-v0.0.46` lifecycle run remains separately
recorded as historical release evidence.

Optional Pi/OMP runtime bundles are supplied through the owner-controlled
`T3_PI_OMP_RUNTIME_BUNDLES_JSON` repository variable. The value is a JSON object with a `bundles`
array containing one HTTPS URL and SHA-256 digest per provider/platform/architecture. The release job
downloads and verifies those archives before publishing them. No runtime bundle is published when
the variable is unset; `--install-runtimes` then fails closed rather than downloading an unpinned
runtime. Bundles are supported only for macOS/Linux arm64/x64 and are never installed by default.

## Evidence boundaries

**Proven by repository CI:** the declared Vite Plus install/task graph;
format/lint/type checks; the desktop build and preload assertions; isolated
installer tests; product identity contract tests; Node-based Pi/OMP protocol,
malformed-frame, chunk, and process-lifecycle fixtures; mobile native static
analysis on macOS; and release-script/manifest/workflow smoke checks.

**Still release- or environment-gated:** launching stock Pi or OMP binaries;
compatibility with a particular native runtime version or capability payload;
real provider credentials and model/UI behavior; clean-machine installs from
npm or Node archives; installer behavior on musl; execution of desktop artifacts from
arbitrary releases outside the exercised `fork-v0.0.47` lifecycle matrix (with `fork-v0.0.46`
retained as historical evidence); notarization, signing, and update delivery beyond the exercised lifecycle; and
cross-platform desktop integration outside that matrix. A green pull request therefore must not be
described as proof of any of those properties.

See [Release Checklist](../operations/release.md) for the release/signing
setup checklist.
