import { THEME_COLOR_ROLES, getThemeColorVariable, type ThemeColorRole } from "../../themePalette";

export type ThemePaintKind = "background" | "border" | "foreground";

export type ThemePaintSnapshot = Readonly<Record<ThemePaintKind, string>>;
export type ThemeInspectorReport = Readonly<{
  /** The app token that this inspector can edit; null means the source is not known. */
  readonly supportedToken: string | null;
  /** A stable app surface/part hook, when the inspected DOM exposes one. */
  readonly stableSurfaceSelector: string | null;
  /** The stylesheet containing the matching source candidate, when readable. */
  readonly matchedStylesheet: string | null;
  /** A matching declaration candidate; browser internals do not expose a portable winner API. */
  readonly cascadeWinnerCandidate: string | null;
  /** Adapter ownership marker, when a renderer publishes one. */
  readonly adapterOwnership: string | null;
}>;

export type ThemeElementInspection = Readonly<{
  element: Element;
  role: ThemeColorRole;
  report: ThemeInspectorReport;
}>;

const THEME_PAINT_KIND_ORDER: ReadonlyArray<ThemePaintKind> = [
  "background",
  "border",
  "foreground",
];

const THEME_INSPECTOR_MATCH_ATTRIBUTE = "data-theme-inspector-match";

const THEME_TOKEN_PROBE_ATTRIBUTE = "data-theme-token-probe";
const THEME_TOKEN_PROBE_COLOR = "#01fea7";
const THEME_TOKEN_ALTERNATE_PROBE_COLOR = "#fe01a7";
const THEME_SPOTLIGHT_ID = "theme-inspector-spotlight";
const THEME_SPOTLIGHT_MASK_ID = "theme-inspector-spotlight-mask";
const THEME_SPOTLIGHT_GLOW_ID = "theme-inspector-spotlight-glow";
const THEME_HOVER_ID = "theme-inspector-hover";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const THEME_UTILITY_ROLES: Readonly<Partial<Record<string, ThemeColorRole>>> = {
  background: "canvas",
  foreground: "text",
  card: "surface",
  "card-foreground": "text",
  popover: "surfaceOverlay",
  "popover-foreground": "text",
  "surface-raised": "surfaceRaised",
  primary: "messageAction",
  "primary-foreground": "messageActionForeground",
  secondary: "secondary",
  "secondary-foreground": "secondaryForeground",
  muted: "muted",
  "muted-foreground": "mutedForeground",
  placeholder: "placeholder",
  "secondary-label": "secondaryLabel",
  "icon-muted": "iconMuted",
  accent: "accentSurface",
  "accent-foreground": "accentSurfaceForeground",
  destructive: "error",
  "destructive-foreground": "errorForeground",
  error: "error",
  "error-foreground": "errorForeground",
  "error-surface": "errorSurface",
  warning: "warning",
  "warning-foreground": "warningForeground",
  "warning-surface": "warningSurface",
  update: "update",
  "update-foreground": "updateForeground",
  "update-surface": "updateSurface",
  message: "messageSurface",
  "message-foreground": "messageForeground",
  "message-action": "messageAction",
  "message-action-foreground": "messageActionForeground",
  "message-action-hover": "messageActionHover",
  sidebar: "sidebar",
  "sidebar-foreground": "sidebarForeground",
  "sidebar-muted-foreground": "sidebarMutedForeground",
  "sidebar-control-surface": "sidebarControlSurface",
  "sidebar-row-hover": "sidebarRowHover",
  "sidebar-row-active": "sidebarRowActive",
  "sidebar-row-selected": "sidebarRowSelected",
  "sidebar-border": "sidebarBorder",
  border: "border",
  input: "input",
  ring: "focus",
};

const THEME_UTILITY_PREFIXES: Readonly<Record<ThemePaintKind, ReadonlyArray<string>>> = {
  background: ["bg-"],
  border: ["border-", "outline-", "ring-"],
  foreground: ["text-", "caret-", "fill-", "stroke-"],
};

function clearThemeInspectorAttribute(attribute: string): void {
  document
    .querySelectorAll(`[${attribute}]`)
    .forEach((element) => element.removeAttribute(attribute));
}

export function clearThemeInspectorHighlights(): void {
  clearThemeInspectorAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE);
  document.getElementById(THEME_SPOTLIGHT_ID)?.remove();
}

export function clearThemeInspectorHover(): void {
  document.getElementById(THEME_HOVER_ID)?.remove();
}
const STABLE_SURFACE_ATTRIBUTES = [
  "data-t3-surface",
  "data-theme-surface",
  "data-theme-part",
  "data-part",
  "data-slot",
] as const;

function selectorAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function closestStableSurfaceSelector(element: Element): string | null {
  let candidate: Element | null = element;
  while (candidate && candidate !== document.documentElement) {
    for (const attribute of STABLE_SURFACE_ATTRIBUTES) {
      const value = candidate.getAttribute(attribute)?.trim();
      if (value) return `[${attribute}="${selectorAttributeValue(value)}"]`;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function adapterOwnershipFor(element: Element): string | null {
  const owner =
    element.closest("[data-renderer-owner]")?.getAttribute("data-renderer-owner") ??
    element.closest("[data-appearance-owner]")?.getAttribute("data-appearance-owner");
  return owner?.trim() || null;
}

function sourceStylesheetFor(
  element: Element,
  variable: string,
): Pick<ThemeInspectorReport, "matchedStylesheet" | "cascadeWinnerCandidate"> {
  const matches: Array<{ source: string; candidate: string }> = [];
  const styleAttribute = element.getAttribute("style") ?? "";
  if (styleAttribute.includes(variable)) {
    matches.push({ source: "inline style attribute", candidate: styleAttribute });
  }
  const visitRules = (rules: CSSRuleList, source: string): void => {
    for (const rule of Array.from(rules)) {
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) {
        visitRules(rule.cssRules, source);
      }
      if (
        !("selectorText" in rule) ||
        typeof rule.selectorText !== "string" ||
        !("style" in rule) ||
        !(rule.style instanceof CSSStyleDeclaration) ||
        !element.matches(rule.selectorText) ||
        !rule.style.cssText.includes(variable)
      ) {
        continue;
      }
      matches.push({
        source,
        candidate: `${rule.selectorText} { ${rule.style.cssText} }`,
      });
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const source =
        sheet.href ??
        (sheet.ownerNode instanceof HTMLStyleElement ? "inline <style>" : "inline stylesheet");
      visitRules(sheet.cssRules, source);
    } catch {
      // Cross-origin stylesheets intentionally remain an honest unknown.
    }
  }
  const winner = matches.at(-1);
  return {
    matchedStylesheet: winner?.source ?? null,
    cascadeWinnerCandidate: winner?.candidate ?? null,
  };
}

function themeInspectorReport(element: Element, role: ThemeColorRole): ThemeInspectorReport {
  const variable = getThemeColorVariable(role);
  return {
    supportedToken: variable,
    stableSurfaceSelector: closestStableSurfaceSelector(element),
    ...sourceStylesheetFor(element, variable),
    adapterOwnership: adapterOwnershipFor(element),
  };
}

function svgElement<Name extends keyof SVGElementTagNameMap>(
  name: Name,
): SVGElementTagNameMap[Name] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function spotlightRect(element: Element): {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
} | null {
  const bounds = element.getBoundingClientRect();
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.right < 0 ||
    bounds.bottom < 0 ||
    bounds.left > window.innerWidth ||
    bounds.top > window.innerHeight
  ) {
    return null;
  }

  const padding = 5;
  // Keep the true bounds when an element is partially offscreen. Clamping its
  // rectangle to the viewport would draw a fake glow edge along the crop.
  const x = bounds.left - padding;
  const y = bounds.top - padding;
  const elementRadius =
    Number.parseFloat(window.getComputedStyle(element).borderTopLeftRadius) || 0;
  return {
    x,
    y,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
    radius: Math.min(18, Math.max(7, elementRadius + padding)),
  };
}

export function showThemeInspectorHover(inspection: ThemeElementInspection, label: string): void {
  const rectangle = spotlightRect(inspection.element);
  if (!rectangle) {
    clearThemeInspectorHover();
    return;
  }

  let hover = document.getElementById(THEME_HOVER_ID);
  if (!hover) {
    hover = document.createElement("div");
    hover.id = THEME_HOVER_ID;
    hover.setAttribute("aria-hidden", "true");
    const tokenLabel = document.createElement("span");
    tokenLabel.dataset.themeInspectorHoverLabel = "";
    hover.append(tokenLabel);
    document.body.append(hover);
  }

  hover.style.left = `${rectangle.x}px`;
  hover.style.top = `${rectangle.y}px`;
  hover.style.width = `${rectangle.width}px`;
  hover.style.height = `${rectangle.height}px`;
  hover.style.borderRadius = `${rectangle.radius}px`;
  hover.dataset.placement = rectangle.y < 32 ? "below" : "above";
  const tokenLabel = hover.querySelector<HTMLElement>("[data-theme-inspector-hover-label]");
  if (tokenLabel) tokenLabel.textContent = label;
}

function renderThemeInspectorSpotlight(elements: ReadonlyArray<Element>): void {
  const rectangles = new Map<string, NonNullable<ReturnType<typeof spotlightRect>>>();
  for (const element of elements) {
    const rectangle = spotlightRect(element);
    if (!rectangle) continue;
    const key = [rectangle.x, rectangle.y, rectangle.width, rectangle.height]
      .map((value) => Math.round(value))
      .join(":");
    rectangles.set(key, rectangle);
  }

  if (rectangles.size === 0) {
    document.getElementById(THEME_SPOTLIGHT_ID)?.remove();
    return;
  }

  let spotlight = document.getElementById(THEME_SPOTLIGHT_ID) as SVGSVGElement | null;
  if (!spotlight) {
    spotlight = svgElement("svg");
    spotlight.id = THEME_SPOTLIGHT_ID;
    spotlight.setAttribute("aria-hidden", "true");
    spotlight.setAttribute("focusable", "false");
    document.body.append(spotlight);
  }
  spotlight.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);

  const definitions = svgElement("defs");
  const mask = svgElement("mask");
  mask.id = THEME_SPOTLIGHT_MASK_ID;
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  const maskSurface = svgElement("rect");
  maskSurface.setAttribute("width", String(window.innerWidth));
  maskSurface.setAttribute("height", String(window.innerHeight));
  maskSurface.setAttribute("fill", "white");
  mask.append(maskSurface);

  const glowFilter = svgElement("filter");
  glowFilter.id = THEME_SPOTLIGHT_GLOW_ID;
  glowFilter.setAttribute("x", "-50%");
  glowFilter.setAttribute("y", "-50%");
  glowFilter.setAttribute("width", "200%");
  glowFilter.setAttribute("height", "200%");
  const blur = svgElement("feGaussianBlur");
  blur.setAttribute("stdDeviation", "5");
  blur.setAttribute("result", "blur");
  const merge = svgElement("feMerge");
  const blurredGlow = svgElement("feMergeNode");
  blurredGlow.setAttribute("in", "blur");
  const crispGlow = svgElement("feMergeNode");
  crispGlow.setAttribute("in", "SourceGraphic");
  merge.append(blurredGlow, crispGlow);
  glowFilter.append(blur, merge);
  definitions.append(mask, glowFilter);

  const glowGroup = svgElement("g");
  for (const rectangle of rectangles.values()) {
    const hole = svgElement("rect");
    hole.setAttribute("x", String(rectangle.x));
    hole.setAttribute("y", String(rectangle.y));
    hole.setAttribute("width", String(rectangle.width));
    hole.setAttribute("height", String(rectangle.height));
    hole.setAttribute("rx", String(rectangle.radius));
    hole.setAttribute("fill", "black");
    mask.append(hole);

    const glow = hole.cloneNode(false) as SVGRectElement;
    glow.removeAttribute("fill");
    glow.setAttribute("class", "theme-inspector-spotlight-glow");
    glow.setAttribute("filter", `url(#${THEME_SPOTLIGHT_GLOW_ID})`);
    glowGroup.append(glow);
  }

  const dimmer = svgElement("rect");
  dimmer.setAttribute("class", "theme-inspector-spotlight-dimmer");
  dimmer.setAttribute("width", String(window.innerWidth));
  dimmer.setAttribute("height", String(window.innerHeight));
  dimmer.setAttribute("mask", `url(#${THEME_SPOTLIGHT_MASK_ID})`);
  spotlight.replaceChildren(definitions, dimmer, glowGroup);
}

export function refreshThemeInspectorSpotlight(): void {
  renderThemeInspectorSpotlight([
    ...document.querySelectorAll(`[${THEME_INSPECTOR_MATCH_ATTRIBUTE}]`),
  ]);
}

function elementHasVisibleText(element: Element): boolean {
  if (element.matches("input, textarea, select, option")) return true;
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
}

function getThemePaintSnapshot(
  element: Element,
  { forHitTest = false }: { forHitTest?: boolean } = {},
): ThemePaintSnapshot | null {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return null;
  }

  const borderPaints: Array<string> = [];
  for (const [color, borderStyle, width] of [
    [style.borderTopColor, style.borderTopStyle, style.borderTopWidth],
    [style.borderRightColor, style.borderRightStyle, style.borderRightWidth],
    [style.borderBottomColor, style.borderBottomStyle, style.borderBottomWidth],
    [style.borderLeftColor, style.borderLeftStyle, style.borderLeftWidth],
  ] as const) {
    if (borderStyle !== "none" && Number.parseFloat(width) > 0) borderPaints.push(color);
  }
  if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
    borderPaints.push(style.outlineColor);
  }
  if (style.borderImageSource !== "none") borderPaints.push(style.borderImageSource);
  if (style.boxShadow !== "none") borderPaints.push(style.boxShadow);

  const foregroundPaints: Array<string> = [];
  if (forHitTest || elementHasVisibleText(element)) foregroundPaints.push(style.color);
  if (element instanceof SVGElement) foregroundPaints.push(style.fill, style.stroke);
  if (element.matches("input, textarea")) foregroundPaints.push(style.caretColor);
  if (style.textDecorationLine !== "none") foregroundPaints.push(style.textDecorationColor);
  if (style.textShadow !== "none") foregroundPaints.push(style.textShadow);

  return {
    background: [style.backgroundColor, style.backgroundImage].join("\n"),
    border: borderPaints.join("\n"),
    foreground: foregroundPaints.join("\n"),
  };
}

export function changedThemePaintKinds(
  before: ThemePaintSnapshot,
  after: ThemePaintSnapshot,
): ReadonlyArray<ThemePaintKind> {
  return THEME_PAINT_KIND_ORDER.filter((kind) => before[kind] !== after[kind]);
}

function withThemeTokenProbeSession<Result>(run: () => Result): Result {
  const root = document.documentElement;
  const wasAlreadyProbing = root.hasAttribute(THEME_TOKEN_PROBE_ATTRIBUTE);
  if (!wasAlreadyProbing) root.setAttribute(THEME_TOKEN_PROBE_ATTRIBUTE, "");
  try {
    return run();
  } finally {
    // Flush every restored token while transitions are still suppressed. The
    // browser never gets a paint opportunity between the probe and restore.
    void window.getComputedStyle(root).color;
    if (!wasAlreadyProbing) root.removeAttribute(THEME_TOKEN_PROBE_ATTRIBUTE);
  }
}

function applyThemeTokenProbe(role: ThemeColorRole): () => void {
  const root = document.documentElement;
  const variable = getThemeColorVariable(role);
  const originalValue = root.style.getPropertyValue(variable);
  const originalPriority = root.style.getPropertyPriority(variable);
  const resolvedValue = originalValue.trim().toLowerCase();
  const probeColor =
    resolvedValue === THEME_TOKEN_PROBE_COLOR
      ? THEME_TOKEN_ALTERNATE_PROBE_COLOR
      : THEME_TOKEN_PROBE_COLOR;
  root.style.setProperty(variable, probeColor, "important");

  return () => {
    if (originalValue) {
      root.style.setProperty(variable, originalValue, originalPriority);
    } else {
      root.style.removeProperty(variable);
    }
  };
}

function applyThemeTokenProbes(roles: ReadonlyArray<ThemeColorRole>): () => void {
  const restores = roles.map(applyThemeTokenProbe);
  return () => {
    for (const restore of restores.toReversed()) restore();
  };
}

function themeInspectorCandidates(): ReadonlyArray<Element> {
  return [document.body, ...document.body.querySelectorAll("*")].filter(
    (element) =>
      !element.closest("[data-theme-editor-panel]") &&
      !element.closest(`#${THEME_SPOTLIGHT_ID}, #${THEME_HOVER_ID}`),
  );
}

export function themeRoleFromUtilityClass(
  className: string,
  kind: ThemePaintKind,
): ThemeColorRole | null {
  // Stateful variants such as hover: and disabled: may not be contributing to
  // the current paint. The computed-style probe below handles those exactly.
  if (className.includes(":")) return null;
  for (const prefix of THEME_UTILITY_PREFIXES[kind]) {
    if (!className.startsWith(prefix)) continue;
    const colorName = className.slice(prefix.length).split("/", 1)[0] ?? "";
    return THEME_UTILITY_ROLES[colorName] ?? null;
  }
  return null;
}

function themeRoleFromUtilities(element: Element): ThemeColorRole | null {
  for (const kind of THEME_PAINT_KIND_ORDER) {
    for (const className of element.classList) {
      const role = themeRoleFromUtilityClass(className, kind);
      if (role) return role;
    }
  }
  return null;
}

function themeInspectionCandidates(initialElement: Element): ReadonlyArray<Element> {
  const candidates: Array<Element> = [];
  let element: Element | null = initialElement;
  while (element && element !== document.documentElement) {
    if (!element.closest("[data-theme-editor-panel]")) candidates.push(element);
    element = element.parentElement;
  }
  return candidates;
}

export function inspectThemeRoleFromUtilitiesAtElement(
  initialElement: Element,
): ThemeElementInspection | null {
  if (initialElement.closest("[data-theme-editor-panel]")) return null;
  for (const candidate of themeInspectionCandidates(initialElement)) {
    const role = themeRoleFromUtilities(candidate);
    if (role) return { element: candidate, role, report: themeInspectorReport(candidate, role) };
  }
  return null;
}

/**
 * Finds actual dependency on a theme token instead of comparing final colors.
 * A token is synchronously replaced with a sentinel, computed paint is read,
 * and the original value is restored before the browser can render a frame.
 */
export function highlightThemeRoleUsage(roles: ReadonlyArray<ThemeColorRole>): number {
  const startedAt = performance.now();
  clearThemeInspectorAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE);
  const candidates = themeInspectorCandidates();
  const probeStartedAt = performance.now();
  const matches = withThemeTokenProbeSession(() => {
    const baseline = new Map<Element, ThemePaintSnapshot>();
    for (const element of candidates) {
      const snapshot = getThemePaintSnapshot(element);
      if (snapshot) baseline.set(element, snapshot);
    }

    const restore = applyThemeTokenProbes(roles);
    const changed = new Set<Element>();
    try {
      for (const [element, before] of baseline) {
        const after = getThemePaintSnapshot(element);
        if (after && changedThemePaintKinds(before, after).length > 0) changed.add(element);
      }
    } finally {
      restore();
    }
    return changed;
  });
  const probeDuration = performance.now() - probeStartedAt;

  const highlightedElements = new Set<Element>();
  for (const element of matches) {
    highlightedElements.add(
      element instanceof SVGElement ? (element.closest("svg") ?? element) : element,
    );
  }
  for (const element of highlightedElements) {
    element.setAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE, "");
  }
  renderThemeInspectorSpotlight([...highlightedElements]);
  if (import.meta.env.DEV) {
    const spotlight = document.getElementById(THEME_SPOTLIGHT_ID);
    if (spotlight) {
      spotlight.dataset.themeInspectorCandidates = String(candidates.length);
      spotlight.dataset.themeInspectorProbeMs = probeDuration.toFixed(2);
      spotlight.dataset.themeInspectorTotalMs = (performance.now() - startedAt).toFixed(2);
    }
  }
  return highlightedElements.size;
}

/** Resolves the nearest painted token at a touched element. */
export function inspectThemeRoleAtElement(initialElement: Element): ThemeElementInspection | null {
  if (initialElement.closest("[data-theme-editor-panel]")) return null;

  const candidates = themeInspectionCandidates(initialElement);

  // Most app paint comes from Tailwind's semantic color utilities. Those class
  // names express the token dependency directly and avoid dozens of forced
  // style recalculations on every pointer-down. Custom CSS still falls through
  // to the exact computed-style probe.
  const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(initialElement);
  if (utilityInspection) return utilityInspection;

  const rolesByElement = withThemeTokenProbeSession(() => {
    const baseline = new Map<Element, ThemePaintSnapshot>();
    const roles = new Map<Element, Partial<Record<ThemePaintKind, ThemeColorRole>>>();
    for (const candidate of candidates) {
      const snapshot = getThemePaintSnapshot(candidate, { forHitTest: true });
      if (snapshot) baseline.set(candidate, snapshot);
    }

    for (const role of THEME_COLOR_ROLES) {
      const restore = applyThemeTokenProbe(role);
      try {
        for (const [candidate, before] of baseline) {
          const after = getThemePaintSnapshot(candidate, { forHitTest: true });
          if (!after) continue;
          const candidateRoles = roles.get(candidate) ?? {};
          for (const kind of changedThemePaintKinds(before, after)) {
            candidateRoles[kind] ??= role;
          }
          roles.set(candidate, candidateRoles);
        }
      } finally {
        restore();
      }
    }
    return roles;
  });

  for (const candidate of candidates) {
    const roles = rolesByElement.get(candidate);
    if (!roles) continue;
    for (const kind of THEME_PAINT_KIND_ORDER) {
      const role = roles[kind];
      if (role) return { element: candidate, role, report: themeInspectorReport(candidate, role) };
    }
  }
  return null;
}
