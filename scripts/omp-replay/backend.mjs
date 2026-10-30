import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const OMP_MODEL_SELECTION = {
  instanceId: "omp",
  model: "openai-codex/gpt-6-luna",
};

/**
 * Launch isolated headless server backend for native replay preview.
 *
 * @param {object} options
 * @param {string} options.fakeWorkerPath - Absolute path to fake OMP worker
 * @param {string} options.fakeCodexPath - Absolute path to fake Codex app-server
 * @param {string} options.controllerOrigin - Controller loopback origin (e.g. http://127.0.0.1:4000)
 * @param {string} options.workerToken - Secret token for worker HTTP endpoints
 * @returns {Promise<{
 *   origin: string,
 *   cookie: string,
 *   createThread: (title?: string, modelSelection?: { instanceId: string, model: string }) => Promise<{ threadId: string, threadUrl: string }>,
 *   startTurn: (prompt: string, modelSelection?: { instanceId: string, model: string }) => Promise<{ turnId?: string, runId?: string, threadId: string }>,
 *   stopTurn: () => Promise<void>,
 *   waitForIdle: (timeoutMs?: number) => Promise<boolean>,
 *   stop: () => Promise<void>,
 *   threadUrl: string
 * }>}
 */
export async function launchReplayBackend({
  scratchDir,
  port,
  fakeWorkerPath,
  fakeCodexPath,
  controllerOrigin,
  workerToken,
}) {
  const rootDir = resolve(fileURLToPath(import.meta.url), "../../..");
  const serverBin = resolve(rootDir, "apps/server/dist/bin.mjs");
  const runtimeRequire = createRequire(resolve(rootDir, "apps/desktop/package.json"));
  const WebSocket = runtimeRequire("ws");
  // 1. Prepare directory tree inside scratchDir
  const homeDir = join(scratchDir, "home");
  const tmpDir = join(scratchDir, "tmp");
  const binDir = join(scratchDir, "bin");
  const userDataDir = join(scratchDir, "userdata");
  const fixtureDir = join(scratchDir, "fixture");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });

  // 2. Generate fake launchers in scratchDir/bin. The shims avoid shell
  // argument rewriting and ensure both providers stay inside the replay.
  const isWin = process.platform === "win32";
  const nodeBin = process.execPath;
  const ompShimPath = join(binDir, isWin ? "omp.cmd" : "omp");
  const codexShimPath = join(binDir, isWin ? "codex.cmd" : "codex");
  if (isWin) {
    writeFileSync(
      ompShimPath,
      `@echo off\r\n"${nodeBin}" "${fakeWorkerPath}" %*\r\n`,
      "utf8",
    );
    writeFileSync(
      codexShimPath,
      `@echo off\r\n"${nodeBin}" "${fakeCodexPath}" %*\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(
      ompShimPath,
      `#!/bin/sh\nexec "${nodeBin}" "${fakeWorkerPath}" "$@"\n`,
      "utf8",
    );
    writeFileSync(
      codexShimPath,
      `#!/bin/sh\nexec "${nodeBin}" "${fakeCodexPath}" "$@"\n`,
      "utf8",
    );
    chmodSync(ompShimPath, 0o755);
    chmodSync(codexShimPath, 0o755);
  }

  // 3. Write scratch settings.json disabling real providers and configuring
  // both offline replay providers.
  const settingsPath = join(userDataDir, "settings.json");
  const settings = {
    providers: {
      codex: {
        enabled: true,
        binaryPath: codexShimPath,
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      },
      claudeAgent: { enabled: false },
      cursor: { enabled: false },
      grok: { enabled: false },
      pi: { enabled: false },
      opencode: { enabled: false },
      antigravity: { enabled: false },
      omp: {
        enabled: true,
        binaryPath: ompShimPath,
        launchArgs: "",
        customModels: [],
      },
    },
    providerInstances: {
      codex: {
        driver: "codex",
        displayName: "Mock Codex",
        enabled: true,
        config: {
          setupMode: "existing",
          enabled: true,
          binaryPath: codexShimPath,
          homePath: "",
          shadowHomePath: "",
          launchArgs: "",
          customModels: [],
        },
      },
      omp: {
        driver: "omp",
        displayName: "Mock OMP",
        enabled: true,
        config: {
          binaryPath: ompShimPath,
          launchArgs: "",
        },
      },
    },
    defaultRuntimeMode: "full-access",
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  // 4. Scrub environment
  const scrubbedEnv = {
    NODE_ENV: "production",
    PATH: `${binDir}:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    HOME: homeDir,
    TMPDIR: tmpDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    T3CODE_HOME: scratchDir,
    OMP_REPLAY_CONTROLLER_ORIGIN: controllerOrigin,
    OMP_REPLAY_WORKER_TOKEN: workerToken || "",
    CONTROLLER_ORIGIN: controllerOrigin,
  };
  // 5. Spawn headless server
  const serverArgs = [
    serverBin,
    "serve",
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    scratchDir,
    "--no-browser",
  ];
  let child;
  try {
    child = spawn(process.execPath, serverArgs, {
      cwd: scratchDir,
      env: scrubbedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`Failed to spawn backend process: ${err.message}`);
  }

  // 6. Capture startup pairing credentials privately
  let pairingToken = null;
  let stdoutAccum = "";
  let stderrAccum = "";
  let startupError = null;

  const startupPromise = new Promise((resolveStartup, rejectStartup) => {
    const checkReady = () => {
      const tokenMatch = stdoutAccum.match(/Token:\s*([A-Za-z0-9_-]+)/);
      if (tokenMatch) {
        pairingToken = tokenMatch[1];
        resolveStartup();
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutAccum += chunk.toString("utf8");
      checkReady();
    });

    child.stderr.on("data", (chunk) => {
      stderrAccum += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      startupError = err;
      rejectStartup(new Error(`Backend failed to start: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (!pairingToken) {
        const diag = stderrAccum.trim() || stdoutAccum.trim() || `Exit code ${code}, signal ${signal}`;
        rejectStartup(new Error(`Backend exited before startup completed: ${diag}`));
      }
    });

    // Timeout safety
    const startupTimer = setTimeout(() => {
      if (!pairingToken) {
        try {
          child.kill("SIGKILL");
        } catch {}
        rejectStartup(new Error(`Backend startup timed out after 30s. Diagnostics: ${stderrAccum.slice(-500)}`));
      }
    }, 30_000);

    child.on("exit", () => clearTimeout(startupTimer));
  });

  await startupPromise;

  const origin = `http://127.0.0.1:${port}`;

  // 7. Exchange startup pairing token for internal admin session cookie
  let sessionCookie = "";
  try {
    const sessionRes = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: pairingToken }),
    });

    if (!sessionRes.ok) {
      const errText = await sessionRes.text().catch(() => "");
      throw new Error(`Auth session exchange failed with HTTP ${sessionRes.status}: ${errText}`);
    }

    // Capture Set-Cookie from response
    const setCookieHeaders = sessionRes.headers.getSetCookie?.() || [sessionRes.headers.get("set-cookie")].filter(Boolean);
    if (setCookieHeaders.length > 0) {
      sessionCookie = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
    }
    if (!sessionCookie) {
      throw new Error("No session cookie returned in response headers");
    }
  } catch (err) {
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error(`Failed to establish internal admin session cookie: ${err.message}`);
  }

  // 7b. Mint scoped browser-limited credential via native API and exchange for distinct browser cookie
  // Allows thread/turn controls in the isolated replay, plus filesystem reads.
  // Excludes provider management, environment/settings writes, terminal access,
  // access management, and filesystem writes.
  const BROWSER_SCOPES = ["orchestration:read", "orchestration:operate", "filesystem:read"];
  let browserCookie = "";
  try {
    const pairingRes = await fetch(`${origin}/api/auth/pairing-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        label: "OMP Replay Browser",
        scopes: BROWSER_SCOPES,
      }),
    });

    if (!pairingRes.ok) {
      const errText = await pairingRes.text().catch(() => "");
      throw new Error(`Scoped pairing token issuance failed with HTTP ${pairingRes.status}: ${errText}`);
    }

    const pairingData = await pairingRes.json().catch(() => null);
    const scopedCredential = pairingData?.credential;
    if (!scopedCredential) {
      throw new Error("No scoped credential returned by pairing token endpoint");
    }

    // Exchange scoped credential at /api/auth/browser-session for browser cookie (omitting Cookie header)
    const browserSessionRes = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: scopedCredential }),
    });

    if (!browserSessionRes.ok) {
      const errText = await browserSessionRes.text().catch(() => "");
      throw new Error(`Browser session exchange failed with HTTP ${browserSessionRes.status}: ${errText}`);
    }

    const browserSetCookies = browserSessionRes.headers.getSetCookie?.() || [browserSessionRes.headers.get("set-cookie")].filter(Boolean);
    if (browserSetCookies.length > 0) {
      browserCookie = browserSetCookies.map((c) => c.split(";")[0]).join("; ");
    }

    if (!browserCookie) {
      throw new Error("No browser session cookie returned in response headers");
    }

    // Validate exchange preserves scopes: read scopes present, dangerous scopes absent
    const sessionState = await browserSessionRes.json().catch(() => null);
    const grantedScopes = new Set(sessionState?.permissions || sessionState?.scopes || []);
    if (!grantedScopes.has("orchestration:read")) {
      throw new Error(`Limited browser session missing expected orchestration:read scope: ${JSON.stringify(sessionState)}`);
    }
    const forbiddenScopes = [
      "providers:manage",
      "environment:maintain",
      "settings:write",
      "terminal:operate",
      "access:write",
      "filesystem:write",
    ];
    for (const forbidden of forbiddenScopes) {
      if (grantedScopes.has(forbidden)) {
        throw new Error(`Limited browser session unexpectedly granted forbidden scope '${forbidden}': ${JSON.stringify(sessionState)}`);
      }
    }
  } catch (err) {
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error(`Failed to create limited browser session: ${err.message}`);
  }

  // 8. Wait for environmentId to be written
  const envIdPath = join(userDataDir, "environment-id");
  let environmentId = "local";
  for (let i = 0; i < 50; i++) {
    if (existsSync(envIdPath)) {
      try {
        environmentId = readFileSync(envIdPath, "utf8").trim();
        if (environmentId) break;
      } catch {
        // Retry
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 9. Connect WebSocket RPC client
  const wsUrl = `ws://127.0.0.1:${port}/ws?orchestrationProtocol=2`;
  let ws;
  let rpcId = 0;
  const pendingRpcs = new Map();

  const rejectAllPendingRpcs = (reason) => {
    for (const [id, entry] of pendingRpcs.entries()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(`RPC ${id} rejected: ${reason}`));
    }
    pendingRpcs.clear();
  };

  const connectWs = () =>
    new Promise((resolveWs, rejectWs) => {
      ws = new WebSocket(wsUrl, {
        headers: {
          Cookie: sessionCookie,
        },
      });

      let opened = false;
      ws.on("open", () => {
        opened = true;
        resolveWs();
      });
      ws.on("error", (err) => {
        if (!opened) {
          rejectWs(err);
        } else {
          rejectAllPendingRpcs(`WebSocket error: ${err.message}`);
        }
      });
      ws.on("close", (code, reason) => {
        rejectAllPendingRpcs(`WebSocket closed (${code}): ${reason || "no reason"}`);
      });
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString("utf8"));
          const reqId = msg.requestId !== undefined
            ? String(msg.requestId)
            : (msg.id !== undefined ? String(msg.id) : null);

          if (msg._tag === "Exit" && reqId && pendingRpcs.has(reqId)) {
            const { resolve: res, reject: rej, timeout } = pendingRpcs.get(reqId);
            clearTimeout(timeout);
            pendingRpcs.delete(reqId);
            if (msg.exit?._tag === "Success") {
              res(msg.exit.value);
            } else {
              rej(new Error(JSON.stringify(msg.exit?.cause || msg.exit || msg)));
            }
          } else if (msg._tag === "Defect" && reqId && pendingRpcs.has(reqId)) {
            const { reject: rej, timeout } = pendingRpcs.get(reqId);
            clearTimeout(timeout);
            pendingRpcs.delete(reqId);
            rej(new Error(JSON.stringify(msg.error || msg)));
          } else if (msg._tag === "ClientProtocolError") {
            rejectAllPendingRpcs(`Protocol error: ${JSON.stringify(msg.error || msg)}`);
          }
        } catch {
          // ignore non-rpc frame
        }
      });
    });

  try {
    await connectWs();
  } catch (err) {
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(`Failed to connect WebSocket to backend: ${err.message}`);
  }

  const rpcCall = (tag, payload, timeoutMs = 20_000) => {
    return new Promise((resolveCall, rejectCall) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return rejectCall(new Error(`Cannot dispatch RPC ${tag}: WebSocket is not open`));
      }
      const id = String(++rpcId);
      const timeout = setTimeout(() => {
        if (pendingRpcs.has(id)) {
          pendingRpcs.delete(id);
          rejectCall(new Error(`RPC ${tag} (id ${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      pendingRpcs.set(id, { resolve: resolveCall, reject: rejectCall, timeout });
      const frame = JSON.stringify({
        _tag: "Request",
        id,
        tag,
        payload,
        headers: [],
      });
      ws.send(frame);
    });
  };

  // 10. Create fixture project and initial thread with cleanup guard
  const projectId = `replay-proj-${Date.now()}`;
  let currentThreadId = null;
  let currentThreadUrl = "";
  let currentRunId = null;
  let currentModelSelection = OMP_MODEL_SELECTION;

  const createThread = async (title = "OMP Replay Session", modelSelection = OMP_MODEL_SELECTION) => {
    const threadId = `th_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await rpcCall("orchestration.dispatchCommand", {
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: `cmd-th-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    currentThreadId = threadId;
    currentThreadUrl = `/${environmentId}/${threadId}`;
    currentRunId = null;
    currentModelSelection = modelSelection;
    return { threadId, threadUrl: currentThreadUrl };
  };

  try {
    await rpcCall("projects.mutate", {
      type: "project.create",
      commandId: `cmd-proj-${Date.now()}`,
      projectId,
      title: "OMP Replay Project",
      workspaceRoot: fixtureDir,
      createWorkspaceRootIfMissing: true,
    });
    await createThread();
  } catch (err) {
    rejectAllPendingRpcs("Backend initialization aborted");
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(`Backend bootstrap initialization failed: ${err.message}`);
  }
  const waitForIdle = async (timeoutMs = 60_000) => {
    if (!currentThreadId) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const projection = await rpcCall("orchestration.getThreadProjection", {
          threadId: currentThreadId,
        });
        const runs = projection?.runs || [];
        if (runs.length === 0) return true;

        // Detect failed runs explicitly: never swallow state failures pretending idle
        const failedRun = runs.find((r) => r.status === "failed");
        if (failedRun) {
          throw new Error(`Run ${failedRun.id} failed: ${JSON.stringify(failedRun.failureReason || "run failed")}`);
        }

        const allSettled = runs.every((r) => TERMINAL_RUN_STATUSES.has(r.status));
        if (allSettled) return true;
      } catch (err) {
        if (err.message && err.message.includes("failed")) {
          throw err;
        }
        // If projection not ready, wait
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  const startTurn = async (prompt, modelSelection = currentModelSelection) => {
    if (!currentThreadId) {
      await createThread("OMP Replay Session", modelSelection);
    }
    // Wait for any previous turn to settle
    await waitForIdle(15_000);

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const commandId = `cmd-turn-${Date.now()}`;

    await rpcCall("orchestration.dispatchCommand", {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId,
      threadId: currentThreadId,
      messageId,
      text: prompt,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    });

    // Check thread projection to extract newly prepared or active runId
    try {
      const projection = await rpcCall("orchestration.getThreadProjection", {
        threadId: currentThreadId,
      });
      const runs = projection?.runs || [];
      const latestRun = runs[runs.length - 1];
      if (latestRun) {
        currentRunId = latestRun.id;
      }
    } catch {
      // Non-fatal
    }

    return {
      turnId: messageId,
      runId: currentRunId,
      threadId: currentThreadId,
    };
  };

  const stopTurn = async () => {
    if (!currentThreadId) return;
    try {
      const projection = await rpcCall("orchestration.getThreadProjection", {
        threadId: currentThreadId,
      });
      const activeRun = (projection?.runs || []).find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
      if (activeRun) {
        await rpcCall("orchestration.dispatchCommand", {
          type: "run.interrupt",
          commandId: `cmd-interrupt-${Date.now()}`,
          threadId: currentThreadId,
          runId: activeRun.id,
          holdQueue: true,
        });
      }
    } catch {
      // Best effort
    }
  };

  const stop = async () => {
    rejectAllPendingRpcs("Backend stopped");
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch {
      // ignore
    }
    if (child && !child.killed) {
      return new Promise((resolveStop) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolveStop();
        }, 3_000);

        child.on("exit", () => {
          clearTimeout(killTimer);
          resolveStop();
        });

        child.kill("SIGTERM");
      });
    }
  };

  return {
    origin,
    cookie: browserCookie,
    createThread,
    startTurn,
    stopTurn,
    waitForIdle,
    stop,
    get threadUrl() {
      return currentThreadUrl;
    },
  };
}
