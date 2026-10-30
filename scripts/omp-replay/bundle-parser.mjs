#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(scriptsDir, "../../.generated/omp-replay-parser");
const outputFile = join(outputDir, "index.mjs");

function findWorkspaceRoot() {
  let dir = scriptsDir;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, "pnpm-lock.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(scriptsDir, "../..");
}

function findOmpTranscriptHtmlDir() {
  const configured = process.env.OMP_TRANSCRIPT_HTML_DIR;
  if (configured && existsSync(configured)) return resolve(configured);

  let dir = scriptsDir;
  while (true) {
    const candidate = join(dir, "packages/omp-transcript-html");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate packages/omp-transcript-html in ancestor directories.");
}

function findParserEntry(ompDir) {
  const configured = process.env.OMP_TRANSCRIPT_HTML_SOURCE;
  if (configured && existsSync(configured)) return resolve(configured);

  const tsEntry = join(ompDir, "src/formats/index.ts");
  if (existsSync(tsEntry)) return tsEntry;

  const jsEntry = join(ompDir, "dist/formats/index.js");
  if (existsSync(jsEntry)) return jsEntry;

  throw new Error(
    "Could not find formats entry point in packages/omp-transcript-html (checked src/formats/index.ts and dist/formats/index.js).",
  );
}

function createBoundedResolver(worktreeRoot, ompDir) {
  const searchDirs = [
    join(worktreeRoot, "apps/mobile/node_modules"),
    join(worktreeRoot, "apps/web/node_modules"),
    join(worktreeRoot, "apps/server/node_modules"),
    join(worktreeRoot, "node_modules"),
    join(ompDir, "node_modules"),
  ].filter(existsSync);

  const resolvedCache = new Map();

  function resolvePackageSubpath(specifier) {
    if (resolvedCache.has(specifier)) return resolvedCache.get(specifier);

    let pkgName = "";
    let subpath = "";
    if (specifier.startsWith("@")) {
      const parts = specifier.split("/");
      pkgName = parts.slice(0, 2).join("/");
      subpath = parts.slice(2).join("/");
    } else {
      const parts = specifier.split("/");
      pkgName = parts[0];
      subpath = parts.slice(1).join("/");
    }

    for (const dir of searchDirs) {
      const pkgDir = join(dir, pkgName);
      const pkgJsonPath = join(pkgDir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;

      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        if (!subpath) {
          let entry =
            pkg.module ||
            (pkg.exports && (pkg.exports["."]?.import || pkg.exports["."]?.default || pkg.exports["."])) ||
            pkg.main ||
            "index.js";
          if (typeof entry === "object") entry = entry.import || entry.default || "index.js";
          const resolvedPath = resolve(pkgDir, entry);
          resolvedCache.set(specifier, resolvedPath);
          return resolvedPath;
        }

        const subKey = "./" + subpath;
        if (pkg.exports && pkg.exports[subKey]) {
          let target = pkg.exports[subKey];
          if (typeof target === "object") target = target.import || target.default || target.require;
          const resolvedPath = resolve(pkgDir, target);
          resolvedCache.set(specifier, resolvedPath);
          return resolvedPath;
        }

        const candidates = [
          join(pkgDir, subpath),
          join(pkgDir, subpath + ".js"),
          join(pkgDir, subpath + ".mjs"),
          join(pkgDir, subpath + "/index.js"),
          join(pkgDir, subpath + "/index.mjs"),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            resolvedCache.set(specifier, candidate);
            return candidate;
          }
        }
      } catch {}
    }

    resolvedCache.set(specifier, null);
    return null;
  }

  return {
    name: "bounded-worktree-resolver",
    resolveId(id) {
      if (id.startsWith("\0") || id.startsWith(".") || id.startsWith("/") || id.startsWith("node:")) {
        return null;
      }
      return resolvePackageSubpath(id);
    },
  };
}

export async function bundleParser() {
  const worktreeRoot = findWorkspaceRoot();
  const ompDir = findOmpTranscriptHtmlDir();
  const entry = findParserEntry(ompDir);
  const boundedResolver = createBoundedResolver(worktreeRoot, ompDir);

  const { build } = await import("vite-plus");

  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      ssr: entry,
      outDir: outputDir,
      emptyOutDir: true,
      target: "node24",
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: "index.mjs",
          format: "es",
        },
        external: [/^node:/],
      },
    },
    plugins: [boundedResolver],
  });

  if (!existsSync(outputFile)) {
    throw new Error(`Bundling completed but output artifact ${outputFile} was not found.`);
  }

  const stat = statSync(outputFile);
  console.log(`[omp-replay] Built parser runtime artifact: ${outputFile} (${stat.size} bytes)`);
  return { outputFile, size: stat.size };
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  bundleParser().catch((err) => {
    console.error("[omp-replay] Failed to bundle transcript parser:", err);
    process.exit(1);
  });
}
