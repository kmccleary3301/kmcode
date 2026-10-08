import * as Effect from "effect/Effect";

import { parseProductProfile, resolveProductIdentity } from "@t3tools/contracts";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; callers must fail closed to the product package
 * selected by the profile or the executable path.
 */
function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

/**
 * Resolve the package name from an isolated product install. Published fork
 * bundles restore the workspace package metadata after publishing, so the
 * entry path and explicit profile are the runtime authorities.
 */
function resolveCliPackageName(entryPath: string): string {
  const normalizedPath = entryPath.replaceAll("\\", "/");
  const configuredProfile = parseProductProfile(process.env.T3_PRODUCT_PROFILE);
  for (const profile of ["upstream", "pi-omp"] as const) {
    const identity = resolveProductIdentity(profile);
    if (normalizedPath.includes(`/node_modules/${identity.packageName}/`)) {
      return identity.packageName;
    }
  }
  return resolveProductIdentity(configuredProfile).packageName;
}

/**
 * The package spec to suggest. The literal spec the user typed (e.g.
 * `t3@nightly`) is resolved away before our process starts, so re-derive the
 * channel from the running version.
 */
export function suggestedPackageSpec(version: string, packageName = "t3"): string {
  const channel = /^[^-+]+-(nightly|preview)\./.exec(version)?.[1];
  return channel === undefined ? packageName : `${packageName}@${channel}`;
}

/**
 * Render a product-aware CLI suggestion that matches how this process was
 * launched: `npx t3 connect` suggests `npx t3 serve`, a global install
 * suggests the installed product binary, and a nightly build keeps `@nightly`.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const packageName = resolveCliPackageName(input.entryPath);
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    return `${packageName} ${input.subcommand}`;
  }
  return `${runner} ${suggestedPackageSpec(input.version, packageName)} ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcessArguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );
