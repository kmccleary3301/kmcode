# Install KM Code

KM Code is a fork of T3 Code with desktop, web, and native mobile clients.
The rebrand is currently available in local builds. Earlier fork releases retain T3 Code branding.

## Requirements

The compatible server requires Node.js `^22.16 || ^23.11 || >=24.10`; source builds use the repository's pinned toolchain.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run the Upstream Server Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

This npm command installs upstream T3 Code, not unpublished KM Code changes.

## CLI Installer

The release workflow publishes a profile-specific POSIX installer with every release. It downloads
only HTTPS release assets and verifies `RELEASE-MANIFEST.json` and `SHA256SUMS` before changing the
owned prefix. The installer itself is shell; `curl | sh` executes that downloaded script before its
own checksum can be checked, so use the pinned download-first procedure below when installer
provenance matters.

For an upstream T3 Code installation from its current `latest` release:

```sh
curl -fsSL https://github.com/pingdotgg/t3code/releases/latest/download/install.sh |
  sh -s -- --profile upstream
```

For earlier Pi + OMP fork releases, use the owner-controlled
[`kmccleary3301/kmcode`](https://github.com/kmccleary3301/kmcode) release channel:

```sh
curl -fsSL https://github.com/kmccleary3301/kmcode/releases/latest/download/install.sh |
  sh -s -- --profile pi-omp --repository kmccleary3301/kmcode
```

Do not point the private installer at the official T3 release repository. For a pinned,
auditable install of the published `fork-v0.0.47` release, download the verification files from
that exact release, verify the installer, then run it locally:

```sh
base=https://github.com/kmccleary3301/kmcode/releases/download/fork-v0.0.47
curl -fsSLO "$base/install.sh"
curl -fsSLO "$base/RELEASE-MANIFEST.json"
curl -fsSLO "$base/SHA256SUMS"
expected=$(awk '$2 == "./install.sh" { print $1 }' SHA256SUMS)
actual=$(shasum -a 256 install.sh | awk '{ print $1 }') # use sha256sum on Linux
test "$actual" = "$expected"
sh install.sh --profile pi-omp --repository kmccleary3301/kmcode --version 0.0.47
```

The recorded `fork-v0.0.47` installer SHA-256 is
`816a3f0bf94f169a87831a6d73a917364ac5bc2800a8054f5e7a139982e8cb5c`; its release-manifest
SHA-256 is `75e201020468f4116f514151623d9469b9622240b526ea2a2696c1736046d207`, and the
checksummed CLI tarball is `95868f3be186831ee3be781a100fd11ead50d204db30e223ef3800b38a875be8`.

Use `--channel nightly` for the newest matching nightly, `--version X.Y.Z` for an exact
release, `--prefix "$HOME/.local/share/t3code/pi-omp"` for an isolated prefix, and `--dry-run`
to inspect the resolved action without network or filesystem mutation. `--desktop` downloads
the verified platform desktop artifact into the owned prefix; it does not install or replace
an existing desktop application. `--uninstall` and `--rollback` operate only on an installation
whose ownership marker matches the selected profile.

`--install-runtimes` is opt-in. It installs only Pi/OMP archives explicitly listed in the
release manifest, into the profile-owned prefix, and prints `PI_BINARY_PATH` and
`OMP_BINARY_PATH` for explicit provider configuration. Releases without those optional assets
fail closed when the flag is used. The flag never replaces `pi`, `omp`, or their configuration.

The installer requires Node.js and npm when the release manifest uses its npm package fallback.
It does not install Node.js or the native provider runtimes.

## Desktop App

Build KM Code from this fork, or use its
[GitHub Releases](https://github.com/kmccleary3301/kmcode/releases).
Earlier releases predate the KM Code rebrand.

For a local macOS Apple Silicon archive after installing dependencies:

```bash
T3_PRODUCT_PROFILE=pi-omp pnpm run dist:desktop:artifact --platform mac --target zip --arch arm64
```

The bundle version defaults to the workspace version. `--build-version`
(env: `T3CODE_DESKTOP_VERSION`) tags it instead. Tag a local build above the newest
published fork release so the updater does not offer an older, pre-rebrand build.
The bundle and the updater then use that tag, while Settings → About keeps reporting
the web build version.

Local macOS builds are ad-hoc signed so their application bundles have valid signatures.
They are not Developer ID signed or notarized. Trusted distribution still requires
fork-owned signing credentials and `--signed`.
An update may require macOS Keychain approval before saved credentials can be read.

The private Pi + OMP
[`fork-v0.0.47`](https://github.com/kmccleary3301/kmcode/releases/tag/fork-v0.0.47)
release includes macOS arm64/x64, Linux arm64/x64, and Windows x64 desktop artifacts. Its
`SHA256SUMS` and GitHub build provenance are verified. The current target-host
install/update/rollback/uninstall lifecycle passed all five jobs in
[`32721583970`](https://github.com/kmccleary3301/kmcode/actions/runs/32721583970).
Signing and notarization credentials are not
configured, so the installers are unsigned and the
[`macOS arm64 DMG`](https://github.com/kmccleary3301/kmcode/releases/download/fork-v0.0.47/T3-Code-Pi-OMP-0.0.47-arm64.dmg)
is not notarized. Treat `fork-v0.0.47` as an unsigned personal build; `fork-v0.0.39` had a
desktop asset-selection defect.

The following package-manager commands install **upstream T3 Code**, not KM Code.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

### Windows Subsystem for Linux

When the desktop app runs a WSL backend, it installs the matching server runtime into
`~/.t3/wsl-runtime` inside the selected distro. The first launch after installing or updating T3
Code may take a little longer while that release's runtime is extracted. Later launches reuse the
Linux-local copy so startup does not depend on reading application files through `/mnt/c`. After a
successful launch, T3 Code keeps the current runtime and one previous runtime for rollback and
removes older caches automatically. If a cached runtime stops working, T3 Code launches from the
application files under `/mnt/c` instead and reinstalls the runtime on the next launch.

## Providers

KM Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                     | Default binary | Authentication           |
| ---------- | ------------------------------------------------------- | -------------- | ------------------------ |
| Pi         | [Pi coding agent](https://github.com/earendil-works/pi) | `pi`           | Configure in the runtime |
| OMP        | [Oh My Pi](https://github.com/can1357/oh-my-pi)         | `omp`          | Configure in the runtime |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)    | `codex`        | `codex login`            |
| Claude     | [Claude Code](https://claude.com/product/claude-code)   | `claude`       | `claude auth login`      |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                    | `cursor-agent` | `agent login`            |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                      | `grok`         | `grok login`             |
| OpenCode   | [OpenCode](https://opencode.ai)                         | `opencode`     | `opencode auth login`    |

Pi and OMP are separate provider kinds with separate settings and processes. Configuring Pi never
launches OMP, and configuring OMP never launches Pi. Their native runtimes own model, account,
tool, task, and checkpoint behavior; KM Code negotiates the advertised RPC capabilities and
projects the resulting events.

### Pi and OMP support

T3 admits stable releases in compatibility bands, then validates the native RPC contract before
marking the provider ready:

- Pi `>=0.84.2 <0.85.0`; `0.84.4` is the latest validated release.
- OMP `>=17.3.7 <19.0.0`; `18.0.10` is the latest validated stock release.

The version band is only a coarse safety boundary. Pi must complete stock RPC v1 model and state
discovery. OMP must emit its `ready` frame, negotiate RPC v2, and complete model and state
discovery. `get_capabilities` is an optional refinement: builds that implement it retain their
advertised checkpoint and advanced task features, while stock OMP `18.x` uses the conservative
features guaranteed by RPC v2. Prereleases and releases outside these bands fail closed.

For an isolated OMP profile, use OMP's native authentication broker rather than copying its
SQLite state:

```sh
omp auth-broker serve --bind=127.0.0.1:39871
export OMP_AUTH_BROKER_URL=http://127.0.0.1:39871
export OMP_AUTH_BROKER_TOKEN="$(cat ~/.omp/auth-broker.token)"
```

Start the OMP process and the T3 server from an environment containing those variables. The
broker token stays in the protected token file; never copy or symlink `agent.db`, its `-wal` or
`-shm` file, or native session history into T3 state. If a broker URL is configured but the broker
is unavailable, OMP fails with an actionable error instead of silently falling back to local
credentials.

The five-target `fork-v0.0.47` release lifecycle proves installation, update, rollback, uninstall,
native-state preservation, and POSIX installer no-mutation behavior after an interrupted partial
download. It does not execute Pi/OMP discovery or authenticated root turns on every target; the
audited native provider lane is local macOS arm64. Do not infer native-provider support for an
untested runtime, OS, or architecture.

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
