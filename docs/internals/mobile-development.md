# Mobile development lifecycle

The [connection runtime's HMR boundary](../../apps/mobile/src/lib/hot-swappable-atom-runtime.ts)
keeps a stable atom runtime and replaces its Effect layer through a writable atom.
It accepts the update only after installing the new layer. Otherwise importers
retain the old behavior even though Metro reports a successful refresh.

Do not reset the shared atom registry to refresh a connection-runtime edit. Reset
removes listeners from mounted consumers that Metro has no reason to rerender.
When the registry or managed-runtime module itself changes, normal Metro propagation
disposes its old resources. This boundary does not make arbitrary module-level atom
families safe to hot-swap. Production uses an ordinary atom runtime.

[Environment supervisor scopes](../../packages/client-runtime/src/connection/registry.ts)
are children of the registry scope. The per-environment map supports targeted
shutdown, but a supervisor created after its cleanup runs would escape it. A closed
parent scope also closes late arrivals, preventing interrupted startup or runtime
replacement from leaving a WebSocket alive outside the new registry.

Uniwind compiles CSS on Metro updates so newly used classes are discovered. It
skips global style invalidation only when the generated stylesheet and theme list
are unchanged. Skipping compilation would lose new classes; invalidating every
consumer for unchanged output makes an ordinary component edit refresh the whole
app. The fingerprint is recorded only after initialization succeeds.

The [expo-notifications patch](../../patches/expo-notifications@57.0.15.patch) protects
`NotificationCenterManager`'s delegates and pending responses with a lock. React runtimes can
register and remove delegates concurrently during reloads or scene startup. Delivery snapshots
delegates under the lock and invokes them after releasing it. Pending-response replay removes
only the responses in its snapshot, preserving responses received during callbacks. Changes to
this native patch require reinstalling dependencies and rebuilding the iOS app.
The native modules under `apps/mobile/modules/` are `file:` dependencies, and pnpm
copies those into its virtual store instead of linking them. Metro bundles the copy,
so an edit to a module's TypeScript is invisible to a running dev client until
`vp i` re-syncs it, while Gradle and CocoaPods compile the worktree directory
directly. A JavaScript change that "has no effect" on device is usually this.

## Native SSH and distribution

The mobile SSH gateway uses the shared remote launch scripts and connection runtime.
Android provides the Expo bridge through JSch; iOS uses libssh2. Both require explicit
SHA-256 host-key confirmation. Credentials remain in secure storage, and gateway scope
cleanup disconnects acquired sessions after launch failures or cancellation.

Native module changes require rebuilding the app; Metro cannot add a native module to an
installed binary. Android transport and app behavior have been exercised on an emulator.
The Swift transport has been compiled and exercised against a real SSH server on macOS;
that is not an iOS application build or device verification.

KM Code keeps existing bundle/package identifiers and state paths for local upgrades.
It does not select an upstream Apple signing team or EAS project. Configure fork-owned
distribution credentials before publishing. OTA updates remain disabled until a
fork-owned update channel exists.
