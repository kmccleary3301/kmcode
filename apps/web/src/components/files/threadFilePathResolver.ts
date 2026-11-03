import { splitFilePathPosition } from "@t3tools/client-runtime/markdown-links";
import * as Predicate from "effect/Predicate";

import { extractTerminalLinks, isAbsolutePath } from "~/terminal-links";

interface ThreadTurnItem {
  readonly position: number;
  readonly item: unknown;
}

export interface ThreadFilePathCandidates {
  readonly mentionedPaths: ReadonlyArray<string>;
  readonly workingDirectoryPaths: ReadonlyArray<string>;
}

const MAX_MENTIONED_PATHS = 3;
const MAX_WORKING_DIRECTORY_PATHS = 4;
const WORKING_DIRECTORY_COMMAND =
  /(?:^|[\s;&|])(?:cd\s+(?:--\s+)?|[A-Za-z_][A-Za-z0-9_]*=)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu;

function isUnknownArray(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}


function normalizePath(value: string, preferredSeparator?: "/" | "\\"): string {
  const isUncPath = value.startsWith("\\\\");
  const drivePrefix = value.match(/^([A-Za-z]:)[\\/]/)?.[1];
  const isRooted = value.startsWith("/") || value.startsWith("\\");
  const separator = preferredSeparator ?? (value.includes("\\") ? "\\" : "/");
  const prefix = isUncPath
    ? `${separator}${separator}`
    : drivePrefix !== undefined
      ? `${drivePrefix}${separator}`
      : isRooted
        ? separator
        : "";
  const prefixLength = isUncPath ? 2 : drivePrefix !== undefined ? 3 : isRooted ? 1 : 0;
  const segments = value
    .slice(prefixLength)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0 && segment !== ".");

  return `${prefix}${segments.join(separator)}` || prefix || ".";
}


function addUniquePath(
  path: string,
  paths: string[],
  seenPaths: Set<string>,
): void {
  const key = normalizePath(path).replaceAll("\\", "/");
  if (seenPaths.has(key)) return;
  seenPaths.add(key);
  paths.push(path);
}

function collectMentionedPaths(
  value: unknown,
  relativePathSuffix: string,
  paths: string[],
  seenPaths: Set<string>,
): void {
  const pending: unknown[] = [value];
  while (pending.length > 0 && paths.length < MAX_MENTIONED_PATHS) {
    const current = pending.pop();
    if (typeof current === "string") {
      const links = extractTerminalLinks(current);
      for (let index = links.length - 1; index >= 0 && paths.length < MAX_MENTIONED_PATHS; index -= 1) {
        const link = links[index];
        if (link?.kind !== "path") continue;
        const path = normalizePath(splitFilePathPosition(link.text).path);
        if (
          isAbsolutePath(path) &&
          normalizePath(path).replaceAll("\\", "/").endsWith(`/${relativePathSuffix}`)
        ) {
          addUniquePath(path, paths, seenPaths);
        }
      }
    } else if (isUnknownArray(current)) {
      for (const nested of current) pending.push(nested);
    } else if (Predicate.isObject(current)) {
      for (const nested of Object.values(current)) pending.push(nested);
    }
  }
}

function addWorkingDirectory(
  value: string,
  directories: string[],
  seenDirectories: Set<string>,
): void {
  const path = normalizePath(value.replace(/[.,;:!?]+$/u, ""));
  if (isAbsolutePath(path)) addUniquePath(path, directories, seenDirectories);
}

function collectCommandWorkingDirectories(
  command: string,
  directories: string[],
  seenDirectories: Set<string>,
): void {
  WORKING_DIRECTORY_COMMAND.lastIndex = 0;
  for (const match of command.matchAll(WORKING_DIRECTORY_COMMAND)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path !== undefined) addWorkingDirectory(path, directories, seenDirectories);
    if (directories.length >= MAX_WORKING_DIRECTORY_PATHS) return;
  }
}

function collectToolWorkingDirectories(
  value: unknown,
  directories: string[],
  seenDirectories: Set<string>,
): void {
  if (
    !Predicate.isObject(value) ||
    (value.type !== "command_execution" && value.type !== "dynamic_tool")
  ) {
    return;
  }

  const itemType = value.type;
  const pending: Array<{ readonly key: string; readonly value: unknown }> = [
    { key: "", value },
  ];
  while (pending.length > 0 && directories.length < MAX_WORKING_DIRECTORY_PATHS) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (typeof current.value === "string") {
      if (current.key === "cwd") {
        addWorkingDirectory(current.value, directories, seenDirectories);
      }
      if (
        current.key === "command" ||
        current.key === "cmd" ||
        current.key === "script" ||
        (itemType === "command_execution" && current.key === "input")
      ) {
        collectCommandWorkingDirectories(current.value, directories, seenDirectories);
      }
    } else if (isUnknownArray(current.value)) {
      for (const nested of current.value) pending.push({ key: current.key, value: nested });
    } else if (Predicate.isObject(current.value)) {
      for (const [key, nested] of Object.entries(current.value)) {
        pending.push({ key, value: nested });
      }
    }
  }
}

function joinWorkingDirectory(directory: string, relativePath: string): string {
  const separator: "/" | "\\" = /^[A-Za-z]:[\\/]|^\\\\/u.test(directory) ? "\\" : "/";
  const normalizedDirectory = normalizePath(directory, separator).replace(/[\\/]+$/u, "");
  return normalizePath(
    `${normalizedDirectory || separator}${separator}${relativePath}`,
    separator,
  );
}

export function findThreadFilePathCandidates(
  turnItems: ReadonlyArray<ThreadTurnItem>,
  relativePath: string,
): ThreadFilePathCandidates {
  const normalizedRelativePath = normalizePath(relativePath).replaceAll("\\", "/");
  if (normalizedRelativePath.length === 0 || normalizedRelativePath.startsWith("/")) {
    return { mentionedPaths: [], workingDirectoryPaths: [] };
  }

  const mentionedPaths: string[] = [];
  const seenMentionedPaths = new Set<string>();
  const workingDirectories: string[] = [];
  const seenWorkingDirectories = new Set<string>();

  for (const turnItem of turnItems.toSorted((left, right) => right.position - left.position)) {
    if (mentionedPaths.length < MAX_MENTIONED_PATHS) {
      collectMentionedPaths(
        turnItem.item,
        normalizedRelativePath,
        mentionedPaths,
        seenMentionedPaths,
      );
    }
    if (workingDirectories.length < MAX_WORKING_DIRECTORY_PATHS) {
      collectToolWorkingDirectories(turnItem.item, workingDirectories, seenWorkingDirectories);
    }
    if (
      mentionedPaths.length >= MAX_MENTIONED_PATHS &&
      workingDirectories.length >= MAX_WORKING_DIRECTORY_PATHS
    ) {
      break;
    }
  }

  return {
    mentionedPaths,
    workingDirectoryPaths: workingDirectories.map((directory) =>
      joinWorkingDirectory(directory, normalizedRelativePath),
    ),
  };
}
