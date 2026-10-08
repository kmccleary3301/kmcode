# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a T3 Code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. app.t3.codes and additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, T3 Code falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from T3 Code into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3 Code
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

## Appearance customization

Appearance settings are local to each client. Connecting to another environment does not install, enable, or grant trust to that environment's CSS.

### Theme packages and variants

Open **Settings → Appearance** to choose the system, light, or dark appearance mode and the active theme. A package can provide separate light and dark variants. Previewing a package does not install or activate it; clear the preview to return to the exact saved appearance. Full-app and light/dark previews retain enabled snippets, while theme-alone preview temporarily isolates the package from snippets.

The package list shows its source, version, app/platform compatibility, active variant, asset count, and latest diagnostics. Imported packages remain disabled until explicitly activated. Re-importing the same package reloads its files without changing its enabled state.

On web and desktop, the theme library also includes community themes adapted from open-source editor themes: Ayu Light, Ayu Dark, Ayu Mirage, Tokyo Night, Catppuccin Mocha, One Dark Pro, Dracula Official, Nord, Rosé Pine, Rosé Pine Moon, Gruvbox Material Dark, and SynthWave '84, plus the original Monoline Void and Neon Tokyo Cyber. Their sources and licenses are listed in `assets/themes-buffet/ATTRIBUTIONS.md`.

Themes without their own syntax colors highlight code with a bundled light or dark palette; themes with custom token colors keep them.

### Fonts

The default Typography settings show three font families:

- **Interface font** controls app navigation, settings, buttons, and other UI text.
- **Text font** controls assistant replies and other rendered Markdown, including headings. Unset, it follows the interface font. Inline and fenced code keep the monospace font.
- **Monospace font** controls code blocks, inline code, diffs, file previews, and terminal output. Advanced settings can override the prompt composer and terminal separately.

KM Code bundles Inter on web and desktop and uses it as the default interface and Markdown font.

A package can set interface, composer, code, terminal, markdown, label, and heading typography. Explicit client font preferences take precedence over package defaults; clearing a family restores the package's choice. KM Code reports each failed family/style/weight descriptor separately and falls back through the declared family list. Use **Retry failed fonts** after correcting an installed or package font.

Web and desktop packages may contain declared WOFF2 assets. Mobile uses installed or bundled font families and does not load package WOFF2 files.

### CSS snippets

Advanced snippets are ordered, client-local CSS files with full control over T3-owned renderer content. They can hide controls, change focus or contrast, and override ordinary appearance preferences. Importing a snippet bundle does not enable its snippets; review and enable each snippet explicitly.

Use the snippet controls to edit, reload, reorder, enable, disable, export, or delete a snippet. On desktop, **Open appearance folder** reveals the watched local appearance directory. Browser imports are copied into IndexedDB and have no live source path.

Supported custom CSS must use the documented variables and selectors in [the appearance selector contract](../internals/appearance-selectors.md). Internal classes and DOM depth are not compatibility promises. Package CSS cannot load remote resources, JavaScript, HTML, SVG, undeclared assets, or paths outside the package.

### Import and export

Theme packages use the strict version 2 appearance manifest. Existing version 1 T3 theme files are migrated during import. Invalid, incompatible, oversized, or capability-mismatched packages are rejected with diagnostics rather than partially applied.

Export packages and snippet bundles before moving appearance settings between clients. There is no cloud appearance sync. Environment-published themes are bounded palette data only; an environment cannot cause local CSS to execute.

### Recovery

Safe mode skips custom packages, snippets, assets, watchers, and the synchronous boot snapshot before custom appearance can be injected.

- Desktop: launch with `--safe-appearance` or `T3CODE_APPEARANCE_SAFE_MODE=1`.
- Browser: open the app with `?t3-appearance=safe`.
- Mobile: open `t3code://appearance/safe`.

Reset entry points open the same built-in recovery surface and require confirmation before quarantining appearance state:

- Desktop: `--reset-appearance`.
- Browser: `?t3-appearance=reset`.
- Mobile: `t3code://appearance/reset`.

Recovery can export current or quarantined state, disable a package or snippet, restore the last good state, or reset to the built-in appearance. A startup compile/apply failure quarantines the suspect state and restores last-good or built-in safe state without repeatedly loading the failed package.

### Platform coverage

Web and desktop apply portable colors, typography, metrics, motion, terminal, syntax, diff, artwork, and supported package CSS. Desktop also maps mode, window background, and supported titlebar colors.

Mobile applies the portable manifest's colors, typography, metrics, terminal, review, preview, navigation, sheet, menu, composer/editor, file-preview, and control roles. Mobile never executes package CSS or snippets and ignores web-only package assets and motion effects.

T3 cannot theme operating-system permission prompts, file pickers, share sheets, native menu bars, compositor decorations, provider-hosted pages, provider CLI output beyond the configured terminal palette, or the remote page inside browser preview. T3-owned wrappers and preview annotation chrome remain themed.
