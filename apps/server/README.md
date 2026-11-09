# Server

Node.js WebSocket server for the T3 Code app.

## OMP background work

Provider-native subagents settle from OMP task results, including per-batch statuses in completed workpool results. A parent tool end is only a fallback when its result does not list that child as active. Startup recovery reconciles children of ended runs from terminal parent tools and cancels work that is still reported active or otherwise cannot be confirmed.
