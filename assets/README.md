# KM Code brand icons

The three Icon Composer projects are the source of truth for the full application
icon family:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `Assets/icon.png` for the master application artwork. The
Icon Composer projects and the export pipeline in `scripts/export-brand-icons.ts`
package and format these layers for each target platform.

Run `pnpm icons:export` from the repository root to regenerate the tracked
iOS, Linux, Windows, and web assets (as well as macOS via the portable fallback).
Development web exports are copied to `apps/web/public` for the browser favicon and splash screen.
Run `pnpm icons:check` to verify generated assets and public copies match their
sources without changing files.

Icon export prefers Icon Composer 2 or newer on macOS. The script selects the
newest compatible exporter from Xcode or a standalone Icon Composer and pins
design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of
`Icon Composer.app/Contents/Executables/ictool` to override automatic
discovery.

When Icon Composer is unavailable, `icons:export` uses the pinned
`@resvg/resvg-js` renderer to render the raster and vector layers deterministically,
including the classic macOS safe area. This fallback keeps source edits
exportable without Xcode; it does not reproduce Icon Composer's native shadow.

## macOS exports

When using the portable fallback (`toolPath === null`), the script automatically
generates the macOS PNG with the classic safe area: the opaque icon body is
824×824, inset 100 pixels on every side, with transparent space outside the body.
When native Icon Composer (`ictool`) is used, native macOS exports require
Icon Composer's GUI-only pre-Tahoe preset and are not updated automatically by `ictool`;
in that mode, manual export from Icon Composer or the portable fallback is used.
Do not edit generated PNG or ICO files directly.

## Android adaptive and monochrome marks

`apps/mobile/assets/android-icon-background.svg` is the source of truth for
the full-bleed 432×432 neon gradient background (`apps/mobile/assets/android-icon-background.png`).

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for
the Android adaptive launcher foreground (`apps/mobile/assets/android-icon-foreground.png`).
It contains the transparent portrait cutout centered within Android's 264px diameter safe zone,
allowing the launcher to apply its mask over the neon background without nested-shape distortion.

`apps/mobile/assets/android-icon-mark.svg` is the source of truth for the
flat monochrome launcher silhouette (`apps/mobile/assets/android-icon-mark.png`, 432×432).

`apps/mobile/assets/android-notification-icon.svg` is the source of truth for the
status bar notification mark (`apps/mobile/assets/android-notification-icon.png`, 96×96).

Both marks use the clean KM monogram geometry, remain transparent outside their subjects,
and keep their artwork strictly within Android's adaptive safe zone.

## Generated outputs

The tracked generated assets across all platforms include:

- `assets/dev/{blueprint-ios-1024.png,blueprint-universal-1024.png,blueprint-macos-1024.png,blueprint-windows.ico,blueprint-web-favicon.ico,blueprint-web-favicon-16x16.png,blueprint-web-favicon-32x32.png,blueprint-web-apple-touch-180.png}`
- `assets/nightly/{nightly-ios-1024.png,nightly-universal-1024.png,nightly-macos-1024.png,nightly-windows.ico,nightly-web-favicon.ico,nightly-web-favicon-16x16.png,nightly-web-favicon-32x32.png,nightly-web-apple-touch-180.png}`
- `assets/prod/{black-ios-1024.png,black-universal-1024.png,black-macos-1024.png,t3-black-windows.ico,t3-black-web-favicon.ico,t3-black-web-favicon-16x16.png,t3-black-web-favicon-32x32.png,t3-black-web-apple-touch-180.png}`
- `apps/mobile/assets/{android-icon-background.png,android-icon-foreground.png,android-icon-mark.png,android-notification-icon.png}`
- `apps/web/public/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png}`

The existing filenames remain stable for package, URL, and native consumers.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas. The Android splash artwork is rendered by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the transparent foreground mark, sized to stay inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant artwork
- `apps/mobile/assets/android-splash-icon-*.png`: the layers composed into one 288dp image so the splash mask reproduces the launcher framing

`android-icon-mark.png` remains a flat silhouette for Android's monochrome themed icon.
