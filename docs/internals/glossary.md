# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

## Appearance

| Term                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance profile   | The immutable, fully resolved input consumed by a renderer. It includes the active light or dark appearance, semantic tokens, typography, geometry, motion, renderer-specific palettes, assets, package identity, enabled snippet order, and safety state. Renderers do not read storage or parse package files.                                                                                                                                                              |
| Theme definition     | The normalized data model for a theme. Existing version 1 color files, built-ins, imported themes, environment themes, and future package manifests all decode into this model.                                                                                                                                                                                                                                                                                               |
| Theme package        | An installable directory or archive with one manifest, optional CSS entrypoints, and bounded local assets. A package can provide manifest values, CSS, or both. It contains no JavaScript.                                                                                                                                                                                                                                                                                    |
| CSS snippet          | One independently named stylesheet with an enabled state and deterministic order. Snippets apply after the active theme package and remain local to a client unless the user explicitly exports and imports them.                                                                                                                                                                                                                                                             |
| Supported token      | A documented semantic CSS custom property or native appearance field with compatibility guarantees. Tokens describe intent, such as a raised surface, terminal cursor, compact row gap, or code font, rather than implementation-specific component names.                                                                                                                                                                                                                    |
| Stable selector      | A documented `data-t3-*` hook on a T3-owned DOM element. Stable selectors exist only when a token cannot express a useful customization. Ordinary classes, DOM hierarchy, generated IDs, and third-party internals are not stable selectors.                                                                                                                                                                                                                                  |
| Appearance adapter   | A concrete implementation that consumes an appearance profile at a renderer seam. Adapters include web CSS, browser storage, desktop storage, terminal, diff/syntax, preview annotation, Electron native theme, and React Native.                                                                                                                                                                                                                                             |
| Trust class          | The origin and capability class of appearance data: `builtin`, `local-package`, `local-snippet`, `environment-palette`, or `community-reviewed`. The last class is reserved for a future distribution system and is not implied by local installation.                                                                                                                                                                                                                        |
| Appearance safe mode | A startup and runtime state that ignores all non-builtin package CSS, snippets, custom assets, and boot-cache appearance data while retaining enough unstyled settings access to inspect, disable, export, quarantine, or delete the failing customization. It bypasses injection before the renderer starts.                                                                                                                                                                 |
| Environment theme    | A bounded, data-only palette an environment publishes for clients, one file per theme under `themes/` in that environment's state directory. [`environmentTheme.ts`](../../apps/server/src/environmentTheme.ts) watches the directory and streams the set over `subscribeServerConfig`; clients render each as a library card. A connected environment cannot make a client execute raw CSS. See [appearance.md](../user/appearance.md) and [appearance.md](./appearance.md). |
| Default theme        | The environment's theme, held in its `settings.json` as `defaultTheme` with `defaultThemeSetAt` as the set-generation and set with `t3 theme set <id>`. Web and desktop clients apply each set once, live when connected or on the next connect otherwise. A theme picked in Settings sticks until the next set; mobile keeps its own appearance settings. See [appearance.md](../user/appearance.md) and [appearance.md](./appearance.md).                                   |
