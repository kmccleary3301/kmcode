#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(process.env.T3_RELATIVE_IMPORT_SCOPE ?? "apps/server/src");
const ignoredDirectories = new Set([
  ".git",
  ".repos",
  ".t3",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const files = [];

function collect(directory) {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collect(NodePath.join(directory, entry.name));
      continue;
    }
    const path = NodePath.join(directory, entry.name);
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (entry.isFile() && sourceExtensions.has(extension) && !entry.name.endsWith(".d.ts"))
      files.push(path);
  }
}

const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(|\bexport\s+[^;\n]*?\s+from\s*)["'](\.\.?\/[^"']+)["']/gu;
const failures = [];
collect(root);

for (const file of files) {
  const source = NodeFS.readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)(?:[?#].*)?$/u.test(specifier)) {
      failures.push(`${file}: ${specifier}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Relative TypeScript imports must name an explicit source extension:");
  for (const failure of failures) console.error(` ${failure}`);
  process.exit(1);
}

console.log(`Relative-import check passed (${files.length} TypeScript files).`);
