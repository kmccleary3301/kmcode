# KM Code

KM Code is Kyle McCleary's fork of [T3 Code](https://github.com/pingdotgg/t3code), an agent
control surface for coding agents on desktop, web, and mobile.
The fork keeps T3 Code's engine, provider integrations, package identities, and connection
protocols compatible while changing the product identity and artwork to KM Code.

It supports native Pi and OMP sessions alongside Claude Code, Codex, Cursor, Grok Build,
and OpenCode. Install and configure the provider runtimes on the host machine.

This fork preserves T3 Code attribution and upstream license terms; see [`LICENSE`](./LICENSE).

## Installation

> [!WARNING]
> Install and authenticate at least one provider before use:
>
> - Pi: install [Pi](https://github.com/earendil-works/pi) and configure its models and accounts
> - OMP: install [Oh My Pi](https://github.com/can1357/oh-my-pi) and configure its models and accounts
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Build KM Code

The KM Code rebrand is available in local builds. After installing dependencies, build a
macOS Apple Silicon desktop archive with:

```bash
T3_PRODUCT_PROFILE=pi-omp pnpm run dist:desktop:artifact --platform mac --target zip --arch arm64
```

See [installation](./docs/user/install.md) for provider setup and earlier fork releases.
Existing package identifiers, connection protocols, and user-data paths are retained.

### Run the compatible upstream server

The public `t3` npm package installs upstream T3 Code, not the KM Code fork:

```bash
npx t3@latest
```

This launches the upstream server and web app. It does not include unpublished KM Code changes.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

These package-manager commands install upstream T3 Code, not KM Code. Fork releases are
published separately at [kmccleary3301/kmcode](https://github.com/kmccleary3301/kmcode/releases);
earlier fork artifacts still carry T3 Code branding.

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run KM Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

KM Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

For fork issues, use [kmccleary3301/kmcode](https://github.com/kmccleary3301/kmcode/issues).
Upstream feature proposals belong in [T3 Code Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
The [T3 Code Discord](https://discord.gg/jn4EGJjrvv) is an upstream community, not KM Code support.
