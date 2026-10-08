# Install KM Code

KM Code is a fork of T3 Code with desktop, web, and native mobile clients.
The rebrand is currently available in local builds. Earlier fork releases retain T3 Code branding.
KM Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

The compatible server requires Node.js `^22.16 || ^23.11 || >=24.10`; source builds use the repository's pinned toolchain.

You need an installed, authenticated provider before starting a thread. You can
launch KM Code and configure providers afterwards. See [Providers](#providers) below.

## Command line

The `t3.codes` installer installs upstream T3 Code. For KM Code releases, use the
[fork CLI installer](#cli-installer).

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

This puts `t3` in `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                      |
| Start the server without a browser               | `t3 serve`                                                |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md)) |
| Move to the newest release                       | `t3 update`                                               |
| Remove it again                                  | `t3 uninstall`                                            |

Run `t3 --help` for the full reference.

To try T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`). This npm command installs upstream T3 Code, not unpublished KM Code changes.

### CLI installer

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

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

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

The following package-manager commands install **upstream T3 Code**, not KM Code:

| Platform           | Install                            |
| ------------------ | ---------------------------------- |
| Windows            | `winget install T3Tools.T3Code`    |
| macOS              | `brew install --cask t3-code`      |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb` |
| Arch Linux         | `yay -S t3code-bin`                |
| Arch Linux nightly | `yay -S t3code-nightly-bin`        |

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

KM Code drives provider CLIs; it does not ship them. Open **Settings → Providers** in the web
or desktop app, select the environment, and enable the provider you want. Installation, login,
and configuration belong to that environment's machine, even when you connect from a phone or
another computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | Install [Pi coding agent](https://github.com/earendil-works/pi) (`pi`), then configure in the runtime.                                                    |
| OMP         | Install [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`), then configure in the runtime.                                                           |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |

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

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when T3 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
