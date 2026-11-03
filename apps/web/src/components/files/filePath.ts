import type { ProjectEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { isAbsolutePath } from "~/terminal-links";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

/** The home path starts with `~/`; a project directory named `~` does not. */
export function isHostHomePath(path: string): boolean {
  return path.startsWith("~/");
}

/**
 * Crumbs for workspace-relative paths start at the project. Absolute host and
 * home-relative paths start at their filesystem root.
 */
export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isAbsolutePath(relativePath) || isHostHomePath(relativePath);
  const isDirectory = /[\\/]+$/.test(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : relativePath.startsWith("/") ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      const breadcrumbPath = hostPath && path === "~" ? "~/" : path;
      return {
        label: part,
        path: breadcrumbPath,
        kind:
          index === parts.length - 1 && !isDirectory ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return collator.compare(left.label, right.label);
    });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath || directoryPath === "~/") return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  if (directoryPath.startsWith("~/") && separatorIndex === 1) return "~/";
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}
