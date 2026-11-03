# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Isolated OMP replay

Run the native session preview without restarting the installed desktop app:

```sh
node scripts/omp-replay.mjs --port 43173
```

Open the printed `http://omp-replay.localhost:43173/__omp-replay` URL. The controller
binds to loopback, creates disposable state, and drives the normal OMP adapter,
projection, and transcript components through an offline worker. It does not load
the desktop profile or send model requests. Ctrl+C stops its backend and removes
its temporary state.

The toolbar's **OMP tour** keeps the existing event replay. Choose **Goal session**
to open a fresh thread on the offline **Mock Codex** app-server; its `/goal`
objective runs through the production Codex adapter and streams several goal
turns with reasoning, command output, file diffs, plan updates, and agent
messages. Hover the goal tab above the composer for its card: **Pause** stops the
running goal turn (the same as Stop, which pauses a Codex goal), and **Resume** and
**Clear** appear once the thread is idle. Click **Goal session** again for a fresh
run. At 1× the scripted run takes about four minutes; use the
speed selector to compress it. The fake app-server never runs its displayed
commands or contacts a model.

The transcript frame has read-only orchestration and file-read permissions.
Use the outer playback controls; the frame cannot launch terminals, manage
providers, or update binaries. This URL is local-only, not a published tailnet link.

For a fresh checkout, build the server and its bundled client first:

```sh
T3CODE_SINGLE_ORIGIN_DEV=1 vp run --filter t3 build
node scripts/omp-replay/bundle-parser.mjs
```

The optional parser build reuses the existing `omp-transcript-html` package from
the surrounding checkout. Set `OMP_TRANSCRIPT_HTML_DIR` to its package directory
when it lives elsewhere, or `OMP_TRANSCRIPT_HTML_PARSER` to an existing runnable
parser module. The built-in tour does not require that parser.

The tour includes streamed text/thinking, task metrics and lifecycle changes,
stacked shell/Python/JavaScript input and output, phased plans, IRC notices,
waiting jobs, matching and empty searches, and edits with line counts. An edit, a
new-file write, a command, and a Python cell stream their arguments before they
run, so their panes grow the way a live model writes them. Play, pause, step,
speed, and reset control event delivery. Speed 1× plays the recorded gaps at half
pace, so each step is easy to follow. Pausing does not stop the production UI's
elapsed clock for an unfinished job.

The **Transcript** select switches the transcript style (Minimal, KM, Terminal)
and reloads the frame; **Styles & loaders** opens Settings → Appearance, which
previews each style on a fixed sample turn and runs every loader live.

### Transcript styles

`transcriptStyle` is a client (per-device) setting. All three styles render the
same data and controls. `MessagesTimeline` provides the style through
`TranscriptStyleCtx` and stamps it on the root as `data-transcript-style`. Most
of a style is CSS scoped to that attribute (`transcript-terminal.css`,
`transcript-minimal.css`); components read the context for glyphs, text, and
which disclosures exist.

- **KM**: Minimal's look (below), except that a running edit, write, command
  or code cell opens its pane by itself so the change or output streams in
  place, and folds back to its line half a second after it settles. Code cells
  that only read files and print them stay shut, as do reads, searches and
  other tools.
- **Terminal**: Oh My Pi's TUI. Row derivation runs with `layout: "flat"`, so
  there are no turn folds or work-group headers. A tool step is only its pane:
  no status line or rail. The pane's title sits in its top border (a
  `<fieldset>` legend): the step glyph, then the model's intent (`i`) or the
  verb and target. The frame's tint carries running, done, and failed (a failed
  step adds its error line under the pane). Todo, wait, and
  subagent panels keep their own headers. Monospace, OMP's light and dark
  palettes, braille spinner and thinking pulse, inline italic thinking, and
  output cut to OMP's preview length with an in-place `… N more lines` expander.
- **Minimal** (default): Cursor's desktop transcript. The prompt sits in a full-width
  outlined box; "Worked for …", groups and steps are body-size sans lines in
  two greys (verb lighter, object dimmer) behind one column of quiet icons,
  with diff counts in colour, no timestamps or progress bars, no cards, no rail
  under opened output, and no automatic expansion of a step's output. A
  working group stays open from its first step until the workflow moves past
  it. Delegation is a "Delegating to [avatar] name" line over a quiet outlined
  card with one line per agent (pixel loader, name, current action); the card
  stays up for 0.7s after the last agent finishes, then blurs out and closes,
  and the header line opens it again. Its motion follows a reference recording
  measured frame by frame: rows and the sent prompt ease in out of a blur and
  leave by blurring out, streamed words fade in, a changed word rolls
  (`RollingText`: the old word leaves up in 120ms, the new one rises in over
  450ms, the rest of the line glides by the width change), a changed number
  spins only its changed digits (the working timer, counts, diff counts), a
  finished agent's whole line rolls (the working line leaves up in 120ms, the
  finished one rises in darker over 300ms while the loader gives way to a
  filled check), a changed status glyph or agent action crossfades out of a
  blur, a live line carries a dark band that sweeps back and forth, and a
  running step shows the pixel loader, which blurs out as the step's icon
  resolves in its place. Reduced motion keeps the fades only.

Web searches show an opaque spinning globe (only near-side meridians are drawn)
while no sources are known, then round favicons of the result sites that pop
out of one another into an overlapping stack, one after another, with a small
overshoot. OMP reports sources only when the search finishes, so in the replay
the favicons arrive at completion.

The replay renders the shared web transcript, so what it shows is what the web
and desktop apps show. Each step is one borderless line: status glyph, verb in a
tense that matches its state ("Reading", "Read", "Failed"; "Queued" for providers
that report pending tools), and object. Adjacent reads and searches merge into "Explored N
files, M searches", adjacent edits into "Edited N files +a −b", and other generic
tools into one group; commands, eval, web search, and Task delegation stay
individual. A search with no matches is dimmed, not an error. A live group's
header names the group in the present tense ("Exploring 4 files, 1 search"), never
its newest step again; a lone step, live or settled, is just that step.

An opened step keeps its line and shows one pane under it, ported from OMP's TUI
box: the call's input on top, then an `Output` rule and the output. The input
grows while the model is still writing the arguments: a diff fills in row by row,
a new file fills in line by line, a command or cell types itself out. The output
appears once the arguments are complete and follows its tail while the tool runs.
There are no metadata rows; the step line already carries status. Code
in a pane is highlighted by stream-mdx (Shiki tokens, incremental while it
streams) and laid out like an editor: line numbers in their own column, long
lines soft-wrapping inside the code column. Diff rows mark changes with a coloured
number, stripe, and tint rather than `+`/`−` prefixes. `read` and `grep` listings
show their line numbers the same way, with search hits on a grey stripe. Copy
buttons appear on hover (always shown on touch). Web search, plans, and waits keep
their own native panes. Bounded scrollers — an open group with many steps, a pane,
a streaming thought — follow their content while it grows, and new content
settles in with a short ease. Scrolling up by hand stops following and shows a
"Scroll to latest" button; reaching the end resumes it.

**Settings → General → Tool detail** picks the mode. Compact (default) reduces
simple file reads to an icon and path and hides `@@` diff headers; edit previews
still open automatically where the style opens them (KM, Terminal), and failed
reads keep their diagnostics. Rich restores read cards and diff headers. Minimal
keeps steps collapsed until clicked in every style.
Existing saved mode choices are preserved.

Passive events never become rows of their own. While a turn works, its plan
docks under the prompt that started it: "N of M To-dos Completed" with a
chevron, then one row per task. Finished tasks are struck through; dropped ones
keep their text and take a red X and the failure tone, so they never read as
done, and blocked ones take the yellow warning tone. When the turn settles the
docked plan folds away and one muted line under the last answer recaps the
turn: "6 of 6 to-dos · 5 files changed +41 −7". It opens to the to-do list and
the changed files; a file opens in the turn's checkpoint diff, or in the file
preview when the turn left only edit steps. Each todo update also reads inline
where it happened: the first as
"Planned N to-dos", later ones as one step line per change ("Checked off …",
"Dropped …", "Blocked … · reason", "Added …"); starting or unblocking a task
says nothing. A live update rises in still open, then its ring swaps to its
mark (check, red X, or slashed circle for blocked), checked-off text is struck
through, and the red or yellow tone eases in rather than flipping. The to-do
chip above the composer fades and drops out when it goes.
A thought reads "Thinking" while it streams, in a short
scroller that follows its newest line under a faded top edge, and settles to
"Thought briefly" or "Thought for Ns". Running subagents show a spinner, their
title, their model, and a shimmering line with the current tool. Above the
composer, a "Working N" pill opens a hub of live subagents with Stop All. IRC
messages and job completions land inside the agent group they belong to. A
wait is its own step, drawn like OMP's TUI notice: under "Waiting for N jobs",
one tree row per job (agents included) with its command or title, progress
while running, and ticking elapsed time. In Minimal and KM the row leads with
that label in sans and trails the job's kind and id a grey further back, on
branches drawn in the `--border` colour from the step rail; Terminal keeps
OMP's mono `├─ ⟨kind⟩ id label` line. Tasks delegated through KM Code's
`delegate_task` tool, from any provider, use the same cards and hub rows; when
the child reports no tool of its own, the line shows its thread's newest
running step. A `t3_thread_wait` call draws as a one-row wait tree for the
thread it waits on, titled and timed from that delegated child. A finished
turn folds to "Worked for …" with its step count and edit totals; the answer,
handoffs, and runtime warnings or errors stay visible.

Every step sits on one icon column: the Working header, thoughts, tool rows,
group headers and their members all place a 14px glyph at the same x and start
their text at the same x, one step every 28px, with prose 35px from a step above
or below it. In Minimal and KM the column is flush with the prose edge: glyphs
start-align in their gutter and step rows carry no inset.
A step's outcome reads inline after a `·`, in the line's own size and
muted tone ("Ran pnpm test · Failed (exit 1)"); only favicons and the chevron sit
at the right edge. Steps show no duration.

Which steps open by themselves depends on the style: in Terminal, foreground
activity opens automatically, and its finished result remains open until
the next foreground activity starts, then folds into a tagged summary. KM opens
only running edits, writes, commands and code cells that do more than read
files, holding each open 500ms after it settles; Minimal opens nothing. Explicit
open and closed choices survive transcript recycling and thread switches.
Subagents and background jobs retain their native lifecycle independently;
IRC and progress notices do not move foreground focus. All transcript motion
runs over one 250ms length (`--motion-duration`, mirrored by `MOTION_MS`) on one
ease-out curve, and closing animates exactly as opening does: panels, the
composer todo list, the Working hub and its rows all collapse rather than
vanish, so nothing below them jumps. Live regions (thinking, OMP tool panes,
expanded tool groups) glide taller as content arrives, with new lines rising
through a soft bottom fade; at their cap they follow the newest line with an
eased roll, and an edge fades while content lies beyond it. Glides and rolls
retarget without losing speed when more content lands mid-motion, and every
glide starts moving on its first frame. One region animates at a time: a box
whose child is already gliding follows it instead of easing on top of it. A
gliding box (`useSmoothHeight`) rests pinned at the height it shows and moves
only in animation frames, never inside a ResizeObserver callback, so the list
never measures a row that then changes size before paint. While
the reader follows a live turn, a timeline row glides only through its own
structural changes: new rows open from nothing, a live activity settling into
its summary glides to the new height in the same box. Activity keys, React child
positions, and scroll wrappers stay stable across that transition; removed rows
collapse out. One owner holds the timeline's live end (`useEndFollow` in
`apps/web/src/lib/endFollow.ts`, after shadcn's Message Scroller and
use-stick-to-bottom): while attached it re-pins after every committed
measurement, before paint. Growth of up to half the viewport glides up on the
same spring the live regions use instead of landing in one frame; an offset
something else moved snaps back at once, and reduced motion always lands at
once. Only the reader's own scrolling up detaches it (their input also stops a
glide), and reaching the end re-attaches. LegendList's visible-content anchoring is off
while following, and `patches/@legendapp__list@3.3.5.patch` applies row
shrinks in the frame they are observed instead of a frame later. The list ends
in breathing room above the composer plus slack (a margin on the list footer):
when a row above shrinks while the reader follows the end, the slack takes the
freed height in the same commit, so the view neither drops nor climbs back when
the next step lands; it glides shut once the list has been still for 3s, or as
soon as the turn ends, since nothing more will arrive to fill it. Status
changes settle in place: status glyphs crossfade (`GlyphSwap`: the loader
fades out over the step's icon fading in), changed header text
resolves out of a slight blur, status colours fade between states, finished
todo items are struck by a line drawn left to right, and waiting-job clocks
tick round together in twelve steps. Shared motion lives in
`apps/web/src/motion.css` and `apps/web/src/lib/motion.ts`. Keyboard activation
(including Escape) is instant, and reduced motion keeps only opacity and colour
fades: the OS preference is owned by one zero-specificity rule in
`apps/web/src/index.css` that zeroes durations so the explicit fades still win,
and the appearance runtime adds its own override only for the "animations off"
settings. Only steps and changes seen while live animate, so history and
scrolled-back rows render in place; a step that joins an open group rolls in
even when it arrives already finished (a quick read). Markdown, code/diff
highlighting, and lazy full-result loading use the same production renderers as
ordinary sessions.

When diagnosing a transcript flash, distinguish off-screen virtualization from
replacing a visible subtree. Code rows stay mounted as stream-mdx updates their
tokens. Detail refreshes retain the last hydrated body for the same environment,
thread, and item until the next revision arrives. Shared-context views mount on
first use and survive toggles; hidden full context does not parse new text.

Work steps read like Cursor's: consecutive commands, reads, edits, and searches
pack into a tight list (row spacing lives in `transcript.css`, keyed on the
row's `data-work-log`), while subagent cards keep room around them. Every step
puts its glyph in one column (a 1rem gutter, 14px glyphs) with the label
starting at the same x. Steps are monochrome: a neutral per-kind glyph, the verb
in the primary text colour, the object muted. Only a failure's X and diff counts
(on steps, edit groups, and the "Worked for…" fold) carry colour. A web search
shows its answer at step size and its sources as small domain links with hover
cards, and repeats the query only when the header had to truncate it.

Anything in progress moves: a running step shows the braille loader the
subagents use, a web search a globe whose meridians turn, and a wait OMP's
ticking clock. A wait's jobs hang off the step's rail as a drawn tree (the
rail is the trunk), not box-drawing characters. Scrollers inside steps never
show a scrollbar (edge fades mark more content) and never trap the wheel: at
either edge it carries on to the timeline. Agent-written markdown (task prompts,
shared context, subagent output and results) renders through ChatMarkdown's
stream-mdx host; static snapshots keep their source visible until compilation is
ready.

**Open export** reads only the selected OMP JSONL or ATIF text export. It never
opens referenced assets or child-session files. Imported text is streamed with
reconstructed timing and one native lifecycle per recorded prompt. Missing live
IRC, task progress, waiting snapshots, and usage are not invented; import notes
describe unavailable data.

New thread routes wait for authoritative live shell metadata. A stale cached
snapshot, or a live snapshot arriving before its thread entity, cannot redirect
an imported thread to a blank draft.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
