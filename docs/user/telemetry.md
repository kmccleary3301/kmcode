# Product usage data

KM Code sends no product usage events by default. Upstream T3 Code builds report to T3's PostHog
project; KM Code removed that built-in project key, so nothing is sent unless a deployment
supplies its own key with `T3CODE_POSTHOG_KEY` (and optionally `T3CODE_POSTHOG_HOST`, default
`https://us.i.posthog.com`).

With a key configured, the server sends events associated with a hashed account or installation
identifier. Events include the provider, model, reasoning effort, permission mode, turn result,
duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection even when a key is configured, set `T3CODE_TELEMETRY_ENABLED=false` in the
server's environment before starting it.

The desktop app reads these variables from your shell profile (for example `~/.zshrc`) on macOS
and Linux, so export them there and restart the app. On Windows, set them as user environment
variables.
