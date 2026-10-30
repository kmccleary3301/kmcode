# Pi

T3 Code can use your existing Pi coding agent installation while keeping Pi's models, auth,
extensions, skills, context files, and native session history.

## Set Up Pi

1. Install Pi on the machine running the T3 Code server. Pi 1.0 is recommended; 0.80.5 is the
   oldest version T3 Code supports.
2. Run Pi once in a terminal and finish the provider login or API-key setup you normally use.
3. Open T3 Code Settings, enable Pi, and refresh the provider.

If `pi` is not on the server's `PATH`, set Pi's binary path to the executable. Provider environment
variables and launch arguments are also available for installations that need a custom agent
directory, endpoint, or model configuration. `--provider` must be paired with `--model`. T3 Code
rejects launch arguments that change Pi's execution mode or select a session because T3 owns those
parts of the process lifecycle.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks Pi's current configured level as the default without overriding it. Threads
use Pi's native session files for resume, rollback, and forks within the same Pi instance. Forks
preserve the native conversation through the selected turn in the destination workspace.
Switching providers uses portable conversation context. Extension
dialogs appear in the T3 Code composer, and the composer context meter follows Pi's own usage
reporting while a response streams and after it settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user and project extensions. Blocking `select`, `confirm`, `input`, and `editor`
dialogs work in T3 Code. Notifications appear in the work log. Arbitrary terminal-only
decoration is not mirrored; supported structured OMP displays are described below.

## Permission Modes

T3 Code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without T3 Code approval prompts.

The **Auto** option is not shown for Pi because Pi does not expose an AI approval reviewer.
Threads that already stored Auto before Pi support was added behave and display as Supervised.

Changing the mode restarts the Pi provider session and resumes the same native conversation. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

T3 Code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, T3 Code also shows its task progress and results in that
UI. Pi runs those children without a session, so they cannot be opened or resumed as T3 Code
threads.

## OMP completion and timing

Oh My Pi can finish a tool call while its background subagents continue. T3 Code follows OMP's
native settlement state for the root turn and tracks each child's native completion separately.
Completed child timers stay fixed while other children work; resumed jobs start a new activation
without reopening unrelated completed children.

The same recorded state is used on desktop and after a web client reconnects. An assistant's final
text alone is not a completion signal. Older sessions whose terminal event was lost need an
evidence-backed repair rather than another model request.

## Native OMP displays

OMP task panes show reported names, roles, current tools, completion percentage, requests,
context usage, and API-equivalent cost. Missing values stay absent. Sparse waiting snapshots
retain previously reported task metadata; a new activation starts with fresh progress.

Shell commands and Python/JavaScript evaluations keep input above output at desktop and phone
widths. Native plans show phases and item states. Waiting panes follow actual task, shell,
and eval jobs, stop their shimmer when dependencies settle, and retain fixed terminal durations.
IRC notices keep their sender and recipient. Structured search results use separate Query,
Answer, Sources, and Metadata sections. Rich tool panes also offer a collapsed raw result for
details not represented by the dedicated view.

## Thread harness identity

An existing native OMP conversation remains an OMP thread after reconnect or runtime detach.
The model picker uses its attached runtime or recorded root provider thread as the harness
identity, rather than a stale preferred-model setting. A model named `openai-codex/...` inside
OMP is still running through OMP, not the separate Codex harness.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open Pi directly and confirm its authentication and model configuration.
- If discovery cannot complete, T3 Code keeps Pi available with the `Pi default` model. Start a
  thread to let the interactive Pi session handle any startup prompt.
- If a project extension is missing, approve the project in Pi, then start a fresh provider session.
- If a project skill is missing from the `$` menu, approve the project in Pi and refresh the provider.
- The context meter appears once Pi reports usage for the thread. Some model providers only
  report usage when a response completes, so the meter can wait for the first reply.
