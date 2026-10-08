// @effect-diagnostics nodeBuiltinImport:off -- This contract test reads checked-in selector fixtures from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vite-plus/test";

import { PairingPendingSurface } from "./components/auth/PairingRouteSurface";
import {
  T3_FORCED_COLORS_SURFACES,
  T3_PARTS,
  T3_ROOT_HOOK,
  T3_SELECTOR_CONTRACT_VERSION,
  T3_STATE_COVERAGE,
  T3_SURFACES,
  T3_VISIBLE_STATE_SEMANTICS,
} from "./t3StableSelectors";

const sourceDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.join(sourceDirectory, "../../..");
const selectorDocument = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "docs/internals/appearance-selectors.md"),
  "utf8",
);
const coreStylesheet = NodeFS.readFileSync(NodePath.join(sourceDirectory, "index.css"), "utf8");

function rendererFiles(directory = sourceDirectory): ReadonlyArray<readonly [string, string]> {
  const files: Array<readonly [string, string]> = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...rendererFiles(path));
    } else if (
      entry.isFile() &&
      /\.(?:css|ts|tsx)$/u.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      files.push([NodePath.relative(sourceDirectory, path), NodeFS.readFileSync(path, "utf8")]);
    }
  }
  return files;
}

const authoredFiles = rendererFiles();
const renderedSurfaceValues = new Set(
  authoredFiles.flatMap(([, file]) =>
    [...file.matchAll(/data-t3-surface=["']([^"']+)["']/g)].map(([, value]) => value),
  ),
);
const renderedPartValues = new Set(
  authoredFiles.flatMap(([, file]) =>
    [...file.matchAll(/data-t3-part=["']([^"']+)["']/g)].map(([, value]) => value),
  ),
);
const renderedHookValues = new Set([...renderedSurfaceValues, ...renderedPartValues]);

type StaticAuditRule = {
  readonly name: string;
  readonly pattern: RegExp;
};

type StaticAuditAllowance = {
  readonly file: string;
  readonly rule: string;
  readonly match: string;
  readonly reason: string;
};

const staticAuditRules: readonly StaticAuditRule[] = [
  {
    name: "inline appearance property",
    pattern:
      /style=\{\{[^}]*\b(?:color|backgroundColor|borderColor|fontFamily)\s*:\s*["'`](?:#|rgb|hsl|[A-Za-z])/u,
  },
  { name: "Clerk appearance branch", pattern: /\bappearance=\{\{/u },
  { name: "renderer unsafe CSS escape", pattern: /\bunsafeCSS(?:Extra)?\s*:/u },
  {
    name: "raw authored CSS color",
    pattern:
      /^\s*(?:color|background(?:-color)?|border(?:-color)?|outline-color|accent-color)\s*:\s*(?:#|rgb\(|rgba\(|hsl\(|hsla\(|white\b|black\b)/u,
  },
  {
    name: "arbitrary Tailwind raw appearance",
    pattern:
      /(?:^|[\s"'`])(?:(?:[a-z][\w-]*\[[^\]]+\](?:\/[\w-]+)?|[a-z][\w-]*|\[[^\]]+\]):)*(?:(?:text|bg|from|via|to|border|outline|decoration|accent|caret|ring|shadow)-\[(?:#[\da-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^\]]*\)|(?:transparent|current|inherit|white|black|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b)[^\]]*\]|font-\[(?!(?:var\(|theme\(|--))[^\]]+\]|\[(?:(?:color|background(?:-color)?|border(?:-color)?|outline-color|accent-color|font(?:-family)?)\s*:\s*(?:#[\da-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^\]]*\)|(?:transparent|current|inherit|white|black|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b)[^\]]*)\]:)/iu,
  },
];

const staticAuditAllowances: readonly StaticAuditAllowance[] = [
  {
    file: "components/chat/ContextWindowMeter.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: usageColor",
    reason: "runtime usage meter color is an appearance adapter input",
  },
  {
    file: "components/chat/PierreEntryIcon.tsx",
    rule: "inline appearance property",
    match: 'style={{ color: colors?.[props.theme === "light" ? 0 : 1] }}',
    reason: "Pierre preview icon consumes renderer-provided theme colors",
  },
  {
    file: "components/chat/ProviderInstanceIcon.tsx",
    rule: "inline appearance property",
    match: "boxShadow: `0 0 0 2px ${indicatorBackground}`",
    reason: "provider identity accent is a renderer adapter boundary",
  },
  {
    file: "components/chat/ProviderInstanceIcon.tsx",
    rule: "inline appearance property",
    match: "borderColor: indicatorBackground",
    reason: "provider identity accent is a renderer adapter boundary",
  },
  {
    file: "components/settings/AddProviderInstanceDialog.tsx",
    rule: "inline appearance property",
    match: "style={{ backgroundColor: swatch }}",
    reason: "settings preview displays a user-selected color",
  },
  {
    file: "components/settings/FontFamilyPicker.tsx",
    rule: "inline appearance property",
    match: "style={{ fontFamily: family }}",
    reason: "settings preview displays the selected font",
  },
  {
    file: "components/settings/ProviderAccentColorPicker.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: `hsl(${hsv.h} 100% 50%)`",
    reason: "color-picker preview must show its hue",
  },
  {
    file: "components/settings/ProviderAccentColorPicker.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: currentColor",
    reason: "color-picker preview displays the selected color",
  },
  {
    file: "components/settings/ProviderAccentColorPicker.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: normalized",
    reason: "color-picker preview displays the normalized color",
  },
  {
    file: "components/settings/ThemeColorPicker.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: currentColor",
    reason: "theme editor preview displays the selected token",
  },
  {
    file: "components/settings/ThemeColorPicker.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: `hsl(${hsv.h} 100% 50%)`",
    reason: "theme editor color wheel is a preview-only computed style",
  },
  {
    file: "components/settings/ThemeColorPicker.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: value",
    reason: "theme editor swatch is a preview-only computed style",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: colors.canvas",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: colors.sidebar",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: colors.surface",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: colors.accentSurface",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: colors.messageSurface",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: colors.messageAction",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemeWireframe.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: line",
    reason: "theme editor wireframe preview consumes palette values",
  },
  {
    file: "components/settings/ThemePreviewCircles.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: modeBase",
    reason: "theme library preview computes a compact palette image",
  },
  {
    file: "components/usage/UsagePage.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: PROVIDER_PRESENTATION[provider].color",
    reason: "provider usage chart consumes provider adapter colors",
  },
  {
    file: "components/usage/UsageLimitsPooled.tsx",
    rule: "inline appearance property",
    match: "backgroundColor: `oklch(0.85 0.08 ${hue})`",
    reason: "account chips derive a stable per-address hue; no theme token can encode it",
  },
  {
    file: "components/clerk/T3ConnectSidebarSignIn.tsx",
    rule: "Clerk appearance branch",
    match: "appearance={{",
    reason: "Clerk requires its own appearance adapter",
  },
  {
    file: "components/diffs/StyledDiffCodeView.tsx",
    rule: "renderer unsafe CSS escape",
    match: "unsafeCSS: unsafeCSSExtra",
    reason: "Pierre diff renderer bridge combines audited base and caller CSS",
  },
  {
    file: "components/DiffPanel.tsx",
    rule: "renderer unsafe CSS escape",
    match: "unsafeCSSExtra:",
    reason: "lazy diffs hide Pierre's own line counts in favour of the panel's file stats",
  },
  {
    file: "components/files/FileBrowserPanel.tsx",
    rule: "renderer unsafe CSS escape",
    match: "unsafeCSS: PIERRE_TREE_UNSAFE_CSS",
    reason: "Pierre tree renderer bridge owns file-tree internals",
  },
  {
    file: "components/diffs/DiffFileTree.tsx",
    rule: "renderer unsafe CSS escape",
    match: "unsafeCSS: PIERRE_TREE_UNSAFE_CSS",
    reason: "Pierre tree renderer bridge owns file-tree internals",
  },
  {
    file: "components/files/FilePreviewPanel.tsx",
    rule: "renderer unsafe CSS escape",
    match: "unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS",
    reason: "Pierre file-link reveal bridge owns third-party markup",
  },
  {
    file: "components/files/ReadOnlySourcePreview.tsx",
    rule: "renderer unsafe CSS escape",
    match: "unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS",
    reason: "Pierre file-link reveal bridge owns third-party markup",
  },
  {
    file: "components/chat/TraitsSpeed.tsx",
    rule: "arbitrary Tailwind raw appearance",
    match: "text-[#d97757]",
    reason:
      "Claude fast mode uses the provider brand color; no semantic provider-color token exists",
  },
  ...[
    "text-[#d97757]",
    "text-[#26251E]",
    "dark:text-[#EDECEC]",
    "text-[#0F0F0F]",
    "dark:text-[#F5F5F5]",
    "text-[#211E1E]",
    "dark:text-[#F1ECEC]",
    "text-[#5b87bf]",
  ].map((match) => ({
    file: "components/chat/ProviderInstanceIcon.tsx",
    rule: "arbitrary Tailwind raw appearance",
    match,
    reason:
      "provider brand marks keep their vendor colors; no semantic provider-color token exists",
  })),
];

function ruleMatches(line: string, pattern: RegExp): ReadonlyArray<string> {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...line.matchAll(new RegExp(pattern.source, flags))].map(([match]) => match);
}

function auditAuthoredFiles(
  files: ReadonlyArray<readonly [string, string]> = authoredFiles,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const [file, content] of files) {
    const isCss = file.endsWith(".css");
    for (const line of content.split("\n")) {
      for (const rule of staticAuditRules) {
        if (isCss && rule.name !== "raw authored CSS color") continue;
        for (const match of ruleMatches(line, rule.pattern)) {
          const allowance = staticAuditAllowances.find(
            (candidate) =>
              candidate.file === file &&
              candidate.rule === rule.name &&
              line.includes(candidate.match) &&
              (rule.name !== "arbitrary Tailwind raw appearance" ||
                match.replace(/^[\s"'`]+/u, "") === candidate.match),
          );
          if (!allowance) violations.push(`${file}: ${rule.name}: ${line.trim()}`);
        }
      }
    }
  }
  return violations;
}

const requiredRenderedHooks = [
  "app-shell",
  "portal",
  "overlay",
  "drag-region",
  "route-chat",
  "route-settings",
  "route-pairing",
  "route-connect",
  "route-auth",
  "route-error",
  "canvas",
  "title-area",
  "toolbar",
  "sidebar",
  "sidebar-header",
  "thread-list",
  "split-pane",
  "tabs",
  "tab",
  "resize-handle",
  "timeline",
  "timeline-message",
  "timeline-tool-call",
  "timeline-approval",
  "timeline-checkpoint",
  "timeline-status",
  "timeline-markdown",
  "composer",
  "composer-body",
  "prompt-editor",
  "autocomplete",
  "attachments",
  "composer-banner",
  "mode-control",
  "settings",
  "settings-nav",
  "settings-panel",
  "command-palette",
  "menu",
  "popover",
  "dialog",
  "tooltip",
  "toast",
  "switch",
  "slider",
  "auth",
  "pairing",
  "profile",
  "update",
  "offline",
  "reconnect",
  "fatal-error",
  "recovery",
  "terminal",
  "terminal-tabs",
  "terminal-resize",
  "terminal-status",
  "terminal-context",
  "files",
  "file-tree",
  "file-preview",
  "code-block",
  "review",
  "diff",
  "diff-header",
  "diff-gutter",
  "diff-hunk",
  "preview",
  "preview-tabs",
  "preview-toolbar",
  "preview-viewport",
  "preview-loading",
  "preview-progress",
  "preview-recording",
  "preview-annotation",
  "preview-error",
  "provider-badge",
  "model-selector",
  "permission-control",
  "native-session",
  "environment",
  "markdown",
  "code",
  "heading",
] as const;

describe("T3 stable selector contract", () => {
  it("keeps the documented vocabulary versioned and source-backed", () => {
    expect(selectorDocument).toContain("selector contract version 1");
    expect(selectorDocument).toContain(`[data-t3-${T3_ROOT_HOOK}]`);
    expect(selectorDocument).toContain("Additive hooks are minor-compatible");
    expect(selectorDocument).toContain("must not carry user text");
    expect(selectorDocument).toContain("existing semantic state");
    expect(selectorDocument).toContain(String(T3_SELECTOR_CONTRACT_VERSION));
    for (const value of [...T3_SURFACES, ...T3_PARTS]) {
      expect(selectorDocument).toContain(`\`${value}\``);
    }
    for (const value of renderedSurfaceValues) expect(T3_SURFACES).toContain(value);
    for (const value of renderedPartValues) expect(T3_PARTS).toContain(value);
  });

  it("requires stable hooks on the owned renderer paths", () => {
    expect(authoredFiles.some(([, file]) => /data-t3-app(?:\s|>)/u.test(file))).toBe(true);
    for (const value of requiredRenderedHooks) expect(renderedHookValues).toContain(value);
  });

  it("enumerates state semantics and exercises each one in rendered markup", () => {
    const stateFixtures: Record<
      (typeof T3_VISIBLE_STATE_SEMANTICS)[number],
      ReturnType<typeof createElement>
    > = {
      empty: createElement("div", { "data-empty": "true" }),
      loading: createElement("div", { "aria-busy": "true" }),
      skeleton: createElement("div", { "data-state": "skeleton" }),
      error: createElement("div", { role: "alert", "aria-invalid": "true" }),
      warning: createElement("div", { "data-variant": "warning" }),
      success: createElement("div", { "data-variant": "success" }),
      disabled: createElement("button", { disabled: true }),
      hover: createElement("button", { className: "state-hover" }),
      active: createElement("button", { "aria-pressed": "true" }),
      selected: createElement("button", { "aria-selected": "true" }),
      "focus-visible": createElement("button", { className: "state-focus-visible" }),
      drag: createElement("div", { "data-dragging": "true" }),
      "high-contrast": createElement("div", { className: "state-high-contrast" }),
    };
    expect(T3_STATE_COVERAGE).toHaveLength(T3_VISIBLE_STATE_SEMANTICS.length);
    for (const state of T3_VISIBLE_STATE_SEMANTICS) {
      const coverage = T3_STATE_COVERAGE.find((entry) => entry.state === state);
      expect(coverage, `missing state coverage for ${state}`).toBeDefined();
      if (!coverage) continue;
      expect(coverage.surfaces.length).toBeGreaterThan(0);
      expect(coverage.evidence).not.toBe("");
      expect(coverage.nonApplicable).not.toBe("");
      const markup = renderToStaticMarkup(
        createElement("div", { "data-t3-surface": coverage.surfaces[0] }, stateFixtures[state]),
      );
      expect(markup).toContain(`data-t3-surface="${coverage.surfaces[0]}"`);
      if (coverage.semantic === "media" || coverage.semantic === "pseudo-class") {
        expect(coverage.selector).toMatch(/^[:@]/u);
      } else {
        expect(markup).toMatch(/(?:aria-|data-|disabled)/u);
      }
    }
  });

  it("keeps stable attributes static and state semantics delegated to ARIA/data-state", () => {
    for (const [file, fileSource] of authoredFiles) {
      expect(fileSource, file).not.toMatch(/data-t3-(?:surface|part)=\{(?!undefined)[^}]+\}/u);
    }
    expect(authoredFiles.some(([, file]) => file.includes("data-state="))).toBe(true);
    expect(authoredFiles.some(([, file]) => file.includes("aria-expanded="))).toBe(true);
    expect(authoredFiles.some(([, file]) => file.includes("aria-selected="))).toBe(true);
    expect(selectorDocument).toContain("Do not add a parallel `data-t3-state`");
    expect(coreStylesheet).toContain("@media (forced-colors: active)");
    expect(coreStylesheet).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps every documented owned surface covered by forced-colors rules", () => {
    for (const surface of T3_FORCED_COLORS_SURFACES) {
      expect(coreStylesheet).toContain(`[data-t3-surface="${surface}"]`);
    }
    expect(coreStylesheet).toContain("forced-color-adjust: none");
    expect(coreStylesheet).toContain("CanvasText");
    expect(coreStylesheet).toContain("HighlightText");
  });

  it("audits authored CSS and renderer source with file-scoped allowances", () => {
    expect(
      staticAuditAllowances.every(
        (entry) => entry.file && entry.rule && entry.match && entry.reason,
      ),
    ).toBe(true);
    expect(staticAuditAllowances).toContainEqual({
      file: "components/chat/TraitsSpeed.tsx",
      rule: "arbitrary Tailwind raw appearance",
      match: "text-[#d97757]",
      reason:
        "Claude fast mode uses the provider brand color; no semantic provider-color token exists",
    });
    expect(auditAuthoredFiles(), "unreviewed appearance escape (path, rule, match)").toEqual([]);
  });
  it("rejects analogous raw Tailwind colors, fonts, and appearance variants", () => {
    const rejected = auditAuthoredFiles([
      ["components/chat/Other.tsx", '<span className="text-[#d97758]">'],
      ["components/chat/Other.tsx", '<span className="bg-[#d97758]">'],
      ["components/chat/Other.tsx", '<span className="hover:text-[#d97758]">'],
      ["components/chat/Other.tsx", `<span className="font-['Comic_Sans']">`],
      ["components/chat/Other.tsx", '<span className="[color:#d97758]:text-foreground">'],
    ]);
    expect(rejected).toHaveLength(5);
    expect(
      rejected.every((violation) => violation.includes("arbitrary Tailwind raw appearance")),
    ).toBe(true);

    expect(
      auditAuthoredFiles([
        ["components/chat/TraitsSpeed.tsx", '<span className="text-[#d97757]">'],
      ]),
    ).toEqual([]);
    expect(
      auditAuthoredFiles([
        ["components/chat/TraitsSpeed.tsx", '<span className="hover:text-[#d97757]">'],
      ]),
    ).toHaveLength(1);
    expect(
      auditAuthoredFiles([["components/chat/Other.tsx", '<span className="text-[#d97757]">']]),
    ).toHaveLength(1);
    expect(
      auditAuthoredFiles([
        ["components/chat/TraitsSpeed.tsx", '<span className="text-[#d97757] text-[#d97758]">'],
      ]),
    ).toEqual([
      'components/chat/TraitsSpeed.tsx: arbitrary Tailwind raw appearance: <span className="text-[#d97757] text-[#d97758]">',
    ]);
    expect(
      auditAuthoredFiles([
        [
          "components/chat/Other.tsx",
          '<span className="text-[var(--provider-color)] font-[var(--font-sans)] supports-[backdrop-filter:blur(1px)]:bg-background">',
        ],
      ]),
    ).toEqual([]);
  });

  it("renders route roots and Base UI surfaces without source matching", () => {
    const routeMarkup = renderToStaticMarkup(
      createElement(
        "div",
        { "data-t3-app": true, "data-t3-surface": "route-auth" },
        createElement(PairingPendingSurface),
      ),
    );
    expect(routeMarkup).toContain("data-t3-app");
    expect(routeMarkup).toContain('data-t3-surface="route-auth"');
    expect(routeMarkup).toContain('data-t3-surface="route-pairing"');
    expect(routeMarkup).toContain("bg-background");

    const portalMarkup = renderToStaticMarkup(
      createElement(
        "div",
        { "data-t3-surface": "portal" },
        createElement("div", { "data-t3-surface": "overlay" }),
        createElement("div", { "data-t3-part": "dialog" }),
      ),
    );
    expect(portalMarkup).toContain('data-t3-surface="overlay"');
    expect(portalMarkup).toContain('data-t3-surface="portal"');
    expect(portalMarkup).toContain('data-t3-part="dialog"');
  });
});
