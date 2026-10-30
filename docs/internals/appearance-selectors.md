# T3 web appearance selector contract

This document is the compatibility contract for the T3-owned web renderer hooks used by appearance authors. It complements [`appearance.md`](./appearance.md), which defines the normalized appearance profile and adapter boundaries.

## Scope and ownership

The contract applies only to DOM rendered by T3 in `apps/web`. The remote document inside a browser preview, hosted provider pages, browser-native controls, operating-system menus/dialogs, and native mobile views are platform or provider owned and are not selectors in this contract. T3-owned wrappers around those surfaces remain in scope.

The root hook is always `[data-t3-app]`. Hooks are additive metadata: they must not carry user text, workspace paths, provider payloads, credentials, generated IDs, or other environment secrets. Existing ARIA attributes and `data-state` attributes remain the authoritative semantic state; a stable hook must not duplicate them.

## Naming and versioning

- Hook names use lowercase kebab-case nouns and describe an owned semantic role (`composer`, `send-button`, `preview-toolbar`).
- `data-t3-app` identifies the renderer root and has no value.
- `data-t3-surface` identifies a major owned region; `data-t3-part` identifies a semantic child or control. A part may appear in more than one surface when the role is equivalent.
- Values are a closed, documented vocabulary. Never interpolate labels, paths, IDs, URLs, provider names, model names, or user content.
- This is selector contract version 1. Additive hooks are minor-compatible. Renaming or removing a hook requires a deprecation note, migration guidance, a compatibility fixture, and a major contract version. Internal classes, DOM depth, generated IDs, and `nth-child` are never compatibility promises.
- Prefer normalized appearance variables for color, typography, spacing, shape, geometry, and motion. A selector is promoted only when a semantic element cannot be customized usefully through variables.

## State and privacy

Use existing semantic state where available: `aria-*`, `data-state`, `data-disabled`, `data-highlighted`, `data-selected`, `data-checked`, `data-pressed`, and equivalent native semantics. Do not add a parallel `data-t3-state`. A state contract test must exercise the existing state selector together with the stable hook.

Stable values are static and nonsecret. A hook may identify a route or state class (`route-settings`, `route-error`, `preview-loading`) but never an instance or its data. Portals and overlays keep the same static values when mounted outside the app root.

## Supported vocabulary

### Roots, routes, and chrome

`app`, `app-shell`, `portal`, `overlay`, `drag-region`, `route-chat`, `route-settings`, `route-pairing`, `route-connect`, `route-auth`, `route-error`, `route-appearance-recovery`, `canvas`, `title-area`, `toolbar`, `sidebar`, `sidebar-header`, `thread-list`, `thread-row`, `split-pane`, `tabs`, `tab`, `resize-handle`.

### Timeline and composer

`timeline`, `timeline-message`, `timeline-tool-call`, `timeline-approval`, `timeline-checkpoint`, `timeline-status`, `timeline-markdown`, `markdown`, `code`, `heading`, `label`, `composer`, `composer-body`, `prompt-editor`, `autocomplete`, `attachments`, `composer-banner`, `mode-control`, `send-button`, `stop-button`.

### Settings and interaction chrome

`settings`, `settings-nav`, `settings-panel`, `command-palette`, `menu`, `popover`, `dialog`, `tooltip`, `toast`, `switch`, `field`, `slider`.

`data-t3-surface="toast"` identifies the stationary stacking viewport. Its animated notification cards expose `data-t3-part="toast"`. Apply border, radius, and shadow to `[data-t3-surface="toast"] [data-t3-part="toast"]`, not the viewport: viewport decorations stay in place during a card's exit animation. Anchored toast cards expose the same part hook without the stacking surface.

### Auth, recovery, terminal, files, and review

`auth`, `pairing`, `profile`, `update`, `offline`, `reconnect`, `fatal-error`, `recovery`, `terminal`, `terminal-tabs`, `terminal-resize`, `terminal-status`, `terminal-context`, `files`, `file-tree`, `file-preview`, `code-block`, `review`, `diff`, `diff-header`, `diff-gutter`, `diff-hunk`, `diff-comment`, `source-control`.

### Preview, providers, and environment

`preview`, `preview-tabs`, `preview-toolbar`, `preview-viewport`, `preview-loading`, `preview-progress`, `preview-recording`, `preview-annotation`, `preview-error`, `provider-badge`, `model-selector`, `permission-control`, `tool-output`, `native-session`, `environment`.

### Visible state variants

`T3_STATE_COVERAGE` in `apps/web/src/t3StableSelectors.ts` is the current-artifact registry. Each named state lists the applicable owned surfaces, the existing semantic selector (`aria-*`, `data-*`, native pseudo-class, or media query), and a concrete renderer evidence path. States are never encoded in `data-t3-surface` or `data-t3-part`; every non-applicable surface is explicitly explained in the registry.

The registry covers empty, loading, skeleton, error, warning, success, disabled, hover, active, selected, focus-visible, drag, and high-contrast. Route/surface hooks survive state changes, while `@media (forced-colors: active)` and native semantics cover platform-driven variants.

## Required component coverage

Every T3-owned row in the surface matrix is covered by a root/surface hook and relevant semantic parts:

| G4 row | Required hooks and evidence                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G4.1   | This naming, versioning, privacy, state, deprecation, and test policy.                                                                                                                                 |
| G4.2   | `app`, route roots, `portal`, `overlay`, `drag-region`, and major surface hooks.                                                                                                                       |
| G4.3   | `canvas`, `title-area`, `toolbar`, `sidebar`, `thread-list`, `thread-row`, `split-pane`, `tabs`, `resize-handle`.                                                                                      |
| G4.4   | `timeline` and timeline message/tool-call/approval/checkpoint/status/markdown/streaming parts.                                                                                                         |
| G4.5   | `composer`, `composer-body`, `prompt-editor`, `autocomplete`, `attachments`, banners, mode/voice controls, send/stop parts.                                                                            |
| G4.6   | Settings and interaction primitives: settings, command palette, menu, popover, dialog, tooltip, toast, switch, field, slider.                                                                          |
| G4.7   | Auth/pairing/profile/update/offline/reconnect/fatal-error/recovery roots.                                                                                                                              |
| G4.8   | Terminal surface, tabs, resize, status, context, and surrounding chrome.                                                                                                                               |
| G4.9   | Files/tree/preview/code/review/diff header/gutter/hunk/comment/source-control roots. Third-party renderer internals remain behind T3-owned wrappers.                                                   |
| G4.10  | Preview tabs/toolbar/viewport/loading/progress/recording/annotation/error chrome. The remote page itself is excluded.                                                                                  |
| G4.11  | Provider badge, model selector, permission control, tool output, native session, and environment identity parts.                                                                                       |
| G4.12  | Existing ARIA/data-state and media state selectors cover visible empty/loading/skeleton/error/warning/success/disabled/hover/active/selected/focus-visible/drag/high-contrast variants.                |
| G4.13  | Narrow static checks reject unreviewed raw UI colors/font families, appearance variants, and renderer escape hatches. Explicit allowlists name authored base CSS, renderer bridges, and test fixtures. |
| G4.14  | Contract tests enumerate this vocabulary and inspect renderer source for root/surface/part hooks, including portal and route variants.                                                                 |
| G4.15  | The table above is the coverage audit; platform-owned exclusions are named in Scope and ownership.                                                                                                     |

Current-artifact exceptions: the web composer does not render a voice-control widget, so no voice hook is emitted. Timeline streaming is represented by the existing message `isStreaming` render path rather than a duplicate state attribute; authors should target the timeline markdown part and existing semantic state.

## Deprecation and testing rules

A hook is not supported until its literal value appears in this document, in the source vocabulary, and in a contract test. Tests must fail when a required literal hook is removed, when a documented hook is undocumented in source, when a hook value contains a dynamic expression, or when a forbidden raw styling escape is introduced outside an allowlist. Static checks inspect authored files one file at a time and report the exact path and match. Rendered contract tests mount route/surface fixtures, navigate between route variants, and mount Base UI portals in `document.body`; source reads do not count as route or portal evidence.

When a hook is deprecated, keep its compatibility fixture through the announced removal release and document the replacement. Do not retain undocumented aliases or compatibility shims after the removal window.

## Customization examples

Use supported variables for ordinary appearance changes and stable hooks only for semantic targeting that variables cannot express:

```css
[data-t3-surface="sidebar"] {
  --sidebar-width: 18rem;
}

[data-t3-surface="composer"] [data-t3-part="send-button"] {
  outline: 1px solid var(--ring);
  outline-offset: 2px;
}

[data-t3-surface="timeline"] [data-t3-part="timeline-tool-call"] {
  border-inline-start: 2px solid var(--warning);
}
```

The selectors remain valid across route changes and portal mounting. Existing ARIA and `data-state` selectors should be combined with these hooks when styling a visible state.

The current static audit allowlist is intentionally small: the Clerk `UserButton` appearance adapter, the Pierre diff `unsafeCSS` bridge, and the file-link reveal stylesheet are the renderer escape hatches. Preview-only computed styles in `PierreEntryIcon`, `ThemeWireframe`, `ThemeColorPicker`, `AddProviderInstanceDialog`, and `FontFamilyPicker` are audited separately; shipped renderer surfaces must use semantic variables instead.
