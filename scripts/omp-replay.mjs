#!/usr/bin/env node

/**
 * scripts/omp-replay.mjs
 *
 * Launcher for native OMP replay preview.
 * Boots isolated loopback controller, headless scratch backend, and offline mock worker.
 *
 * Usage:
 *   node scripts/omp-replay.mjs [--port <port>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startReplayServer, stopReplayServer } from "./omp-replay/server.mjs";

export { startReplayServer, stopReplayServer };

export async function main(argv = process.argv.slice(2)) {
  const rootDir = path.resolve(fileURLToPath(import.meta.url), "../..");
  const serverDist = path.join(rootDir, "apps/server/dist/bin.mjs");
  const webDist = path.join(rootDir, "apps/server/dist/client/index.html");

  // Check build artifacts
  if (!fs.existsSync(serverDist)) {
    console.error(`[omp-replay] Error: Server build artifact not found: ${serverDist}`);
    console.error(`[omp-replay] Actionable prerequisite: build server and client using:`);
    console.error(`  pnpm exec vp run --filter t3 build`);
    process.exit(1);
  }

  if (!fs.existsSync(webDist)) {
    console.error(`[omp-replay] Error: Web client build artifact not found: ${webDist}`);
    console.error(`[omp-replay] Actionable prerequisite: build the bundled server and client using:`);
    console.error(`  pnpm exec vp run --filter t3 build`);
    process.exit(1);
  }

  // Parse CLI flags
  let port = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      port = Number(argv[i + 1]) || 0;
      i++;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length)) || 0;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/omp-replay.mjs [options]`);
      console.log(``);
      console.log(`Options:`);
      console.log(`  -p, --port <port>   Port for the replay controller server (default: ephemeral)`);
      console.log(`  -h, --help          Show this help message`);
      return;
    }
  }

  // Launch replay server
  let serverInstance;
  try {
    serverInstance = await startReplayServer({ port });
  } catch (err) {
    console.error(`[omp-replay] Startup failure: ${err.message}`);
    process.exit(1);
  }

  // Print safe preview URL (no tokens, no secrets)
  console.log(`[omp-replay] Isolated OMP native replay preview ready.`);
  console.log(`[omp-replay] URL: ${serverInstance.previewUrl}`);

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[omp-replay] Received ${signal}. Stopping replay channels and cleaning scratch temp data...`);
    try {
      await serverInstance.stop();
    } catch (err) {
      console.error(`[omp-replay] Error during shutdown: ${err.message}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(`[omp-replay] Fatal: ${err.message}`);
    process.exit(1);
  });
}
