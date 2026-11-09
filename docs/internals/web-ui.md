# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#taste) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.

Transcript prompt-width rules must target the outer user-message wrapper, not every descendant
`.group`. Inline context chips also use `.group`; full-width children collapse file labels and
paint size text over neighboring Markdown. Verify chip bounds and prompt width in a real browser;
jsdom does not lay out inline flex content.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.
- Consumers are a few lines of slots, and the slots carry the styling:
  [`ComposerActivityStatus.tsx`](../../apps/web/src/components/chat/ComposerActivityStatus.tsx).

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Composer model selection

For existing threads, the composer follows the reported runtime model selection, falling back to
the canonical thread selection. A fresh human picker or trait change overrides it for the next send;
seeded and sticky preferences do not override live thread state. New-thread drafts retain their
seeded selection. Store version 10 migrates blank v9 explicit selections to passive preferences,
while preserving explicit intent in nonempty drafts.

Pending intent is scoped to environment and thread. Before clearing composer content, persist the
send's message ID, full requested selection, and intent revision. Acknowledge it only when a projected
run has that user-message ID and requested selection; a newer choice must survive an older receipt.
The runtime model need not equal the requested model: provider fallback must not leave the old
override pinned. Reloading, clearing content, or observing an unrelated run is not acknowledgement.

For a browser smoke check, migrate a blank v9 draft holding Opus while its live thread reports Sol:
the composer must show Sol without clearing storage or changing the agent's model.
