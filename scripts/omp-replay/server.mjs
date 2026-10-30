import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { importArchive, ArchiveImportError } from "./archive.mjs";
import { builtInScenario } from "./scenario.mjs";
import { launchReplayBackend } from "./backend.mjs";

const MAX_IMPORT_BYTES = 34 * 1024 * 1024; // 32 MiB archive + overhead
const MAX_CONTROL_BYTES = 1024 * 1024; // 1 MiB
// Each speed step plays at half the recorded pace, so 1× is slow enough to
// watch streamed arguments and output land.
const PLAYBACK_TIME_SCALE = 2;
const GOAL_OBJECTIVE = "Ship the three transcript styles with previews";
const CODEX_MODEL_SELECTION = { instanceId: "codex", model: "gpt-6-luna" };


function isLoopbackAddress(addr) {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
  if (addr.startsWith("::ffff:127.")) return true;
  if (addr.startsWith("127.")) return true;
  return false;
}

function isValidHost(hostHeader, controllerPort) {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().trim();
  const allowed = [
    `omp-replay.localhost:${controllerPort}`,
    `omp-replay.localhost`,
    `localhost:${controllerPort}`,
    `localhost`,
    `127.0.0.1:${controllerPort}`,
    `127.0.0.1`,
    `[::1]:${controllerPort}`,
    `[::1]`,
  ];
  return allowed.includes(host);
}

function isValidOrigin(originHeader, controllerPort) {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isAllowedHost =
      hostname === "omp-replay.localhost" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      isLoopbackAddress(hostname);
    if (!isAllowedHost) return false;
    if (parsed.port && Number(parsed.port) !== Number(controllerPort)) return false;
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, limitBytes = MAX_CONTROL_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error("Request payload exceeds maximum allowed size"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`Invalid JSON payload: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function proxyHttpRequest(req, res, backendPort, backendCookie) {
  const upstreamHeaders = { ...req.headers };

  delete upstreamHeaders["cookie"];
  if (backendCookie) {
    upstreamHeaders["cookie"] = backendCookie;
  }

  upstreamHeaders["host"] = `127.0.0.1:${backendPort}`;
  if (upstreamHeaders["origin"]) {
    upstreamHeaders["origin"] = `http://127.0.0.1:${backendPort}`;
  }
  if (upstreamHeaders["referer"]) {
    try {
      const refUrl = new URL(upstreamHeaders["referer"]);
      refUrl.protocol = "http:";
      refUrl.host = `127.0.0.1:${backendPort}`;
      upstreamHeaders["referer"] = refUrl.href;
    } catch {
      delete upstreamHeaders["referer"];
    }
  }

  delete upstreamHeaders["authorization"];
  delete upstreamHeaders["x-api-key"];

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: upstreamHeaders,
    },
    (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 500;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (key.toLowerCase() === "set-cookie") continue;
        res.setHeader(key, value);
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: `Backend proxy error: ${err.message}` }));
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
}

function proxyWsUpgrade(req, clientSocket, head, backendPort, backendCookie) {
  const upstreamHeaders = { ...req.headers };

  delete upstreamHeaders["cookie"];
  if (backendCookie) {
    upstreamHeaders["cookie"] = backendCookie;
  }

  upstreamHeaders["host"] = `127.0.0.1:${backendPort}`;
  if (upstreamHeaders["origin"]) {
    upstreamHeaders["origin"] = `http://127.0.0.1:${backendPort}`;
  }
  if (upstreamHeaders["referer"]) {
    try {
      const refUrl = new URL(upstreamHeaders["referer"]);
      refUrl.protocol = "http:";
      refUrl.host = `127.0.0.1:${backendPort}`;
      upstreamHeaders["referer"] = refUrl.href;
    } catch {
      delete upstreamHeaders["referer"];
    }
  }

  delete upstreamHeaders["authorization"];
  delete upstreamHeaders["x-api-key"];

  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: backendPort,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders,
  });

  proxyReq.on("upgrade", (proxyRes, upstreamSocket, upstreamHead) => {
    let responseHeader = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      const key = proxyRes.rawHeaders[i];
      const val = proxyRes.rawHeaders[i + 1];
      if (key.toLowerCase() === "set-cookie") continue;
      responseHeader += `${key}: ${val}\r\n`;
    }
    responseHeader += "\r\n";

    clientSocket.write(responseHeader);

    if (upstreamHead && upstreamHead.length > 0) {
      clientSocket.write(upstreamHead);
    }
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    clientSocket.on("error", () => {
      try { upstreamSocket.destroy(); } catch {}
    });
    upstreamSocket.on("error", () => {
      try { clientSocket.destroy(); } catch {}
    });
  });

  proxyReq.on("response", (proxyRes) => {
    let responseHeader = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      const key = proxyRes.rawHeaders[i];
      const val = proxyRes.rawHeaders[i + 1];
      if (key.toLowerCase() === "set-cookie") continue;
      responseHeader += `${key}: ${val}\r\n`;
    }
    responseHeader += "\r\n";
    clientSocket.write(responseHeader);
    proxyRes.pipe(clientSocket);
  });

  proxyReq.on("error", () => {
    try { clientSocket.destroy(); } catch {}
  });

  proxyReq.end();
}

/**
 * Start the complete OMP replay server:
 * 1. Loopback controller HTTP server with fresh random worker token
 * 2. Isolated headless backend with fresh scratch directory and ephemeral port
 * 3. Reverse proxy to own backend for web app UI and WS upgrade
 * 4. Deterministic monotonic replay scheduling for built-in or imported sessions
 */
export async function startReplayServer(options = {}) {
  const workerToken = crypto.randomBytes(24).toString("hex");

  // Read index.html for control surface
  const indexPath = path.resolve(fileURLToPath(import.meta.url), "../index.html");
  const indexHtml = fs.readFileSync(indexPath, "utf8");

  // Playback & scenario state
  let currentScenario = builtInScenario;
  let generation = 1;
  let turnIndex = 0;
  let frameIndexInTurn = 0;
  let turnStarted = false;
  let abortedByApp = false;

  const state = {
    mode: "omp",
    status: "idle", // 'idle' | 'playing' | 'paused' | 'completed'
    cursor: 0,
    total: builtInScenario.schedule.length,
    speed: 1,
    positionMs: 0,
    scenario: builtInScenario.title || builtInScenario.scenario,
    threadUrl: "",
    error: null,
    warnings: [...(builtInScenario.warnings || [])],
  };

  function getState() {
    return {
      mode: state.mode,
      status: state.status,
      cursor: state.cursor,
      total: state.total,
      speed: state.speed,
      positionMs: state.positionMs,
      scenario: state.scenario,
      threadUrl: state.threadUrl,
      error: state.error || null,
      warnings: Array.isArray(state.warnings) ? [...state.warnings] : [],
    };
  }

  // Active timers & delays for playback loop
  let targetFrameTimeMs = null;
  let currentTimerDuration = null;
  let remainingDelayMs = null;
  let activeTimer = null;
  let timerResolve = null;

  // Worker communication tracking
  const activeWorkerStreams = new Map(); // sessionId -> { res, req, generation }
  const promptResolvers = []; // Array of { generation, resolve, reject, timeoutId }
  let workerPromptPending = false;
  function waitWithCancel(ms, gen) {
    return new Promise((resolve) => {
      let timer = null;
      const onResolve = (completed) => {
        activeTimer = null;
        timerResolve = null;
        resolve(completed);
      };
      activeTimer = setTimeout(() => {
        onResolve(true);
      }, ms);
      timerResolve = () => {
        clearTimeout(activeTimer);
        onResolve(false);
      };
    });
  }

  function waitForWorkerPrompt(gen, timeoutMs = 30_000) {
    if (workerPromptPending && gen === generation) {
      workerPromptPending = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = promptResolvers.findIndex((r) => r.resolve === resolve);
        if (idx >= 0) promptResolvers.splice(idx, 1);
        reject(new Error("Timed out waiting for worker prompt notification"));
      }, timeoutMs);

      promptResolvers.push({
        generation: gen,
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });
    });
  }
  async function ensureWorkerStream(gen, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (gen !== generation) return false;
      for (const stream of activeWorkerStreams.values()) {
        if (stream.generation === gen) return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  function emitFrame(frame) {
    const line = JSON.stringify({ frame }) + "\n";
    for (const [sessionId, stream] of activeWorkerStreams.entries()) {
      if (stream.generation === generation) {
        try {
          stream.res.write(line);
        } catch {
          // Worker stream error
        }
      }
    }
  }

  function handleWorkerAbort(sessionId) {
    if (state.status === "playing") {
      state.status = "paused";
      if (timerResolve) timerResolve();
      targetFrameTimeMs = null;
      currentTimerDuration = null;
      remainingDelayMs = null;
    }
    abortedByApp = true;
    state.error = "Execution was stopped in the app. Reset needed to restart replay.";
  }

  // Mutex for serializing control actions
  let controlQueue = Promise.resolve();
  function serializedControl(actionFn) {
    const next = controlQueue.then(actionFn);
    controlQueue = next.catch(() => {});
    return next;
  }

  let backend = null;
  let backendPort = null;
  let backendCookie = "";
  let scratchDir = null;
  let backendReady = false;

  async function handleReset({ mode = "omp", title } = {}) {
    generation++;

    if (timerResolve) timerResolve();
    activeTimer = null;
    timerResolve = null;
    targetFrameTimeMs = null;
    currentTimerDuration = null;
    remainingDelayMs = null;

    for (const p of promptResolvers) {
      clearTimeout(p.timeoutId);
      p.reject(new Error("Reset initiated"));
    }
    promptResolvers.length = 0;
    workerPromptPending = false;
    for (const stream of activeWorkerStreams.values()) {
      try { stream.res.end(); } catch {}
    }
    activeWorkerStreams.clear();

    if (backend) {
      await backend.stopTurn();
      if (!(await backend.waitForIdle(15_000))) {
        throw new Error("Timed out waiting for the replay thread to stop.");
      }
      const newThread = await backend.createThread(
        title || currentScenario.title || currentScenario.scenario || "OMP Replay Session",
        mode === "goal" ? CODEX_MODEL_SELECTION : undefined
      );
      state.threadUrl = newThread.threadUrl;
    }

    turnIndex = 0;
    frameIndexInTurn = 0;
    turnStarted = false;
    state.mode = mode;
    state.status = "idle";
    state.cursor = 0;
    state.total = mode === "goal" ? 0 : currentScenario.schedule.length;
    state.positionMs = 0;
    state.scenario = mode === "goal"
      ? "Mock Codex native goal session"
      : currentScenario.title || currentScenario.scenario;
    state.warnings = mode === "goal" ? [] : [...(currentScenario.warnings || [])];
    state.error = null;
    abortedByApp = false;
  }

  async function handleGoalSession() {
    await handleReset({ mode: "goal", title: "Mock Codex goal session" });
    await backend.startTurn(`/goal ${GOAL_OBJECTIVE}`, CODEX_MODEL_SELECTION);
  }

  async function handleTourSession() {
    currentScenario = builtInScenario;
    await handleReset({ mode: "omp", title: currentScenario.title || currentScenario.scenario });
  }

  async function handleImport({ fileName, text }) {
    if (typeof fileName !== "string" || !fileName.trim()) {
      throw new Error("fileName is required");
    }
    if (typeof text !== "string") {
      throw new Error("text is required");
    }
    if (Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Choose an exported transcript smaller than 32 MiB.");
    }

    const imported = await importArchive(fileName, text);

    generation++;
    if (timerResolve) timerResolve();
    activeTimer = null;
    timerResolve = null;
    targetFrameTimeMs = null;
    currentTimerDuration = null;
    remainingDelayMs = null;

    for (const prompt of promptResolvers) {
      clearTimeout(prompt.timeoutId);
      prompt.reject(new Error("Import initiated"));
    }
    promptResolvers.length = 0;
    workerPromptPending = false;
    for (const stream of activeWorkerStreams.values()) {
      try { stream.res.end(); } catch {}
    }
    activeWorkerStreams.clear();

    if (backend) {
      await backend.stopTurn();
      if (!(await backend.waitForIdle(15_000))) {
        throw new Error("Timed out waiting for the replay thread to stop.");
      }
      const newThread = await backend.createThread(imported.title || fileName);
      state.threadUrl = newThread.threadUrl;
    }

    currentScenario = imported;
    turnIndex = 0;
    frameIndexInTurn = 0;
    turnStarted = false;
    state.mode = "omp";
    state.scenario = imported.title || fileName;
    state.total = imported.schedule.length;
    state.warnings = imported.warnings || [];
    state.status = "idle";
    state.cursor = 0;
    state.positionMs = 0;
    state.error = null;
    abortedByApp = false;
  }

  async function handleStep() {
    if (state.mode !== "omp") throw new Error("Event playback is only available in the OMP tour.");
    if (abortedByApp) {
      throw new Error("Playback was stopped by the application. Reset is required to continue.");
    }
    if (state.status === "playing") {
      throw new Error("Cannot step while playback is active. Pause first.");
    }
    if (state.status === "completed") {
      throw new Error("Replay feed finished. Reset to replay.");
    }

    const loopGen = generation;

    if (turnIndex >= currentScenario.turns.length) {
      state.status = "completed";
      return;
    }

    const currentTurn = currentScenario.turns[turnIndex];

    if (!turnStarted) {
      workerPromptPending = false;
      if (turnIndex > 0 && backend) {
        await backend.waitForIdle();
        if (loopGen !== generation) return;
      }
      if (backend) {
        await backend.startTurn(currentTurn.prompt);
        if (loopGen !== generation) return;
      }
      await waitForWorkerPrompt(loopGen);
      if (loopGen !== generation) return;
      await ensureWorkerStream(loopGen);
      if (loopGen !== generation) return;
      turnStarted = true;
    }

    if (frameIndexInTurn >= currentTurn.schedule.length) {
      if (turnIndex < currentScenario.turns.length - 1) {
        turnIndex++;
        frameIndexInTurn = 0;
        turnStarted = false;
        return await handleStep();
      } else {
        state.status = "completed";
        return;
      }
    }

    const frameObj = currentTurn.schedule[frameIndexInTurn];
    emitFrame(frameObj.frame);
    frameIndexInTurn++;
    state.cursor++;
    state.positionMs = frameObj.atMs;
    remainingDelayMs = null;
    targetFrameTimeMs = null;
    state.status = "paused";

    if (frameIndexInTurn >= currentTurn.schedule.length) {
      if (turnIndex < currentScenario.turns.length - 1) {
        turnIndex++;
        frameIndexInTurn = 0;
        turnStarted = false;
      } else {
        state.status = "completed";
      }
    }
  }

  function handlePause() {
    if (state.status !== "playing") return;
    state.status = "paused";
    if (targetFrameTimeMs !== null) {
      remainingDelayMs = Math.max(0, targetFrameTimeMs - Date.now());
      targetFrameTimeMs = null;
    }
    if (timerResolve) {
      timerResolve();
    }
  }

  function handleSpeed(newSpeed) {
    if (!Number.isFinite(newSpeed) || newSpeed <= 0) {
      throw new Error("Speed must be a positive number");
    }
    const oldSpeed = state.speed;
    state.speed = newSpeed;

    if (targetFrameTimeMs !== null && currentTimerDuration !== null) {
      const remainingOld = Math.max(0, targetFrameTimeMs - Date.now());
      const remainingNew = remainingOld * (oldSpeed / newSpeed);
      remainingDelayMs = remainingNew;
      targetFrameTimeMs = null;
      currentTimerDuration = null;
      if (timerResolve) {
        timerResolve();
      }
    } else if (remainingDelayMs !== null) {
      remainingDelayMs = remainingDelayMs * (oldSpeed / newSpeed);
    }
  }

  async function handlePlay() {
    if (state.mode !== "omp") throw new Error("Event playback is only available in the OMP tour.");
    if (abortedByApp) {
      throw new Error("Playback was stopped by the application. Reset is required to continue.");
    }
    if (state.status === "completed") {
      await handleReset();
    }
    if (state.status === "playing") {
      return;
    }

    state.status = "playing";
    state.error = null;
    const loopGen = generation;

    (async () => {
      try {
        while (state.status === "playing" && loopGen === generation) {
          if (abortedByApp) {
            state.status = "paused";
            state.error = "Execution was stopped in the app. Reset needed to restart replay.";
            break;
          }

          if (turnIndex >= currentScenario.turns.length) {
            state.status = "completed";
            break;
          }

          const currentTurn = currentScenario.turns[turnIndex];

          if (!turnStarted) {
            workerPromptPending = false;
            if (turnIndex > 0 && backend) {
              await backend.waitForIdle();
              if (loopGen !== generation || state.status !== "playing") break;
            }
            if (backend) {
              await backend.startTurn(currentTurn.prompt);
              if (loopGen !== generation || state.status !== "playing") break;
            }
            await waitForWorkerPrompt(loopGen);
            if (loopGen !== generation || state.status !== "playing") break;
            await ensureWorkerStream(loopGen);
            if (loopGen !== generation || state.status !== "playing") break;
            turnStarted = true;
          }

          if (frameIndexInTurn >= currentTurn.schedule.length) {
            if (turnIndex < currentScenario.turns.length - 1) {
              turnIndex++;
              frameIndexInTurn = 0;
              turnStarted = false;
              continue;
            } else {
              state.status = "completed";
              break;
            }
          }

          const currentFrameObj = currentTurn.schedule[frameIndexInTurn];
          const prevFrameObj =
            frameIndexInTurn > 0 ? currentTurn.schedule[frameIndexInTurn - 1] : null;

          let delayMs = 0;
          if (remainingDelayMs !== null) {
            delayMs = remainingDelayMs;
            remainingDelayMs = null;
          } else if (prevFrameObj) {
            const delta = Math.max(0, currentFrameObj.atMs - prevFrameObj.atMs);
            delayMs = (delta * PLAYBACK_TIME_SCALE) / state.speed;
          } else {
            delayMs = 0;
          }

          if (delayMs > 0) {
            currentTimerDuration = delayMs;
            targetFrameTimeMs = Date.now() + delayMs;
            const completedWait = await waitWithCancel(delayMs, loopGen);
            targetFrameTimeMs = null;
            currentTimerDuration = null;

            if (loopGen !== generation || state.status !== "playing") {
              break;
            }

            if (!completedWait && remainingDelayMs !== null) {
              continue;
            }
          }

          if (loopGen !== generation || state.status !== "playing") break;

          emitFrame(currentFrameObj.frame);
          frameIndexInTurn++;
          state.cursor++;
          state.positionMs = currentFrameObj.atMs;

          if (frameIndexInTurn >= currentTurn.schedule.length) {
            if (turnIndex < currentScenario.turns.length - 1) {
              turnIndex++;
              frameIndexInTurn = 0;
              turnStarted = false;
            } else {
              state.status = "completed";
              break;
            }
          }
        }
      } catch (err) {
        if (loopGen === generation) {
          state.status = "paused";
          state.error = err.message || String(err);
        }
      }
    })();
  }

  // Create Controller HTTP Server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    // Control endpoints
    if (pathname === "/__omp-replay" || pathname === "/__omp-replay/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(indexHtml);
      return;
    }

    if (pathname === "/__omp-replay/state") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isValidHost(req.headers.host, controllerPort)) {
        sendJson(res, 400, { error: "Invalid Host header" });
        return;
      }
      sendJson(res, 200, getState());
      return;
    }

    if (pathname === "/__omp-replay/control") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isValidHost(req.headers.host, controllerPort)) {
        sendJson(res, 400, { error: "Invalid Host header" });
        return;
      }
      if (!isValidOrigin(req.headers.origin, controllerPort)) {
        sendJson(res, 403, { error: "Forbidden: invalid Origin" });
        return;
      }
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("application/json")) {
        sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }

      try {
        const body = await readJsonBody(req, MAX_CONTROL_BYTES);
        const action = body?.action;

        if (!action || typeof action !== "string") {
          sendJson(res, 400, { error: "action is required" });
          return;
        }

        await serializedControl(async () => {
          switch (action) {
            case "goal-session":
              await handleGoalSession();
              break;
            case "tour-session":
              await handleTourSession();
              break;
            case "play":
              await handlePlay();
              break;
            case "pause":
              handlePause();
              break;
            case "step":
              await handleStep();
              break;
            case "reset":
              await handleReset();
              break;
            case "speed":
              handleSpeed(Number(body.speed));
              break;
            default:
              throw new Error(`Unsupported action: ${action}`);
          }
        });

        sendJson(res, 200, { ok: true, ...getState() });
      } catch (err) {
        sendJson(res, 400, { error: err.message || String(err) });
      }
      return;
    }

    if (pathname === "/__omp-replay/import") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isValidHost(req.headers.host, controllerPort)) {
        sendJson(res, 400, { error: "Invalid Host header" });
        return;
      }
      if (!isValidOrigin(req.headers.origin, controllerPort)) {
        sendJson(res, 403, { error: "Forbidden: invalid Origin" });
        return;
      }
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("application/json")) {
        sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }

      try {
        const body = await readJsonBody(req, MAX_IMPORT_BYTES);
        await serializedControl(async () => {
          await handleImport({
            fileName: body.fileName,
            text: body.text,
          });
        });
        sendJson(res, 200, { ok: true, ...getState() });
      } catch (err) {
        const status = err instanceof ArchiveImportError ? 400 : 400;
        sendJson(res, status, { error: err.message || String(err) });
      }
      return;
    }

    // Worker routes
    if (pathname === "/__omp-replay/worker/register") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: "Forbidden: loopback connection required" });
        return;
      }
      if (req.headers["x-omp-replay-worker-key"] !== workerToken) {
        sendJson(res, 401, { error: "Unauthorized worker token" });
        return;
      }

      try {
        const body = await readJsonBody(req, MAX_CONTROL_BYTES);
        const { sessionId, pid } = body;
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message || String(err) });
      }
      return;
    }

    if (pathname === "/__omp-replay/worker/events") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: "Forbidden: loopback connection required" });
        return;
      }
      if (req.headers["x-omp-replay-worker-key"] !== workerToken) {
        sendJson(res, 401, { error: "Unauthorized worker token" });
        return;
      }

      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });

      const streamEntry = { res, req, generation };
      activeWorkerStreams.set(sessionId, streamEntry);

      req.on("close", () => {
        if (activeWorkerStreams.get(sessionId) === streamEntry) {
          activeWorkerStreams.delete(sessionId);
        }
      });
      return;
    }

    if (pathname === "/__omp-replay/worker/goal-speed") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: "Forbidden: loopback connection required" });
        return;
      }
      if (req.headers["x-omp-replay-worker-key"] !== workerToken) {
        sendJson(res, 401, { error: "Unauthorized worker token" });
        return;
      }
      sendJson(res, 200, { speed: state.speed });
      return;
    }

    if (pathname === "/__omp-replay/worker/command") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: "Forbidden: loopback connection required" });
        return;
      }
      if (req.headers["x-omp-replay-worker-key"] !== workerToken) {
        sendJson(res, 401, { error: "Unauthorized worker token" });
        return;
      }

      try {
        const body = await readJsonBody(req, MAX_CONTROL_BYTES);
        const { sessionId, command } = body;

        if (command?.type === "prompt" || command?.type === "steer") {
          let resolvedAny = false;
          for (let i = promptResolvers.length - 1; i >= 0; i--) {
            const p = promptResolvers[i];
            if (p.generation === generation) {
              p.resolve();
              promptResolvers.splice(i, 1);
              resolvedAny = true;
            }
          }
          if (!resolvedAny) {
            workerPromptPending = true;
          }
        } else if (command?.type === "abort") {
          handleWorkerAbort(sessionId);
        }

        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message || String(err) });
      }
      return;
    }

    if (pathname.startsWith("/__omp-replay/")) {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }

    // Reverse proxy to own backend
    if (!backendReady || !backendPort) {
      sendJson(res, 503, { error: "Replay backend initializing" });
      return;
    }

    proxyHttpRequest(req, res, backendPort, backendCookie);
  });

  // WebSocket upgrade handler
  server.on("upgrade", (req, clientSocket, head) => {
    const host = req.headers["host"] || "";
    if (!isValidHost(host, controllerPort)) {
      clientSocket.destroy();
      return;
    }

    if (!backendReady || !backendPort) {
      clientSocket.destroy();
      return;
    }

    proxyWsUpgrade(req, clientSocket, head, backendPort, backendCookie);
  });

  // 1. Launch loopback controller first
  const requestedPort = Number(options.port) || 0;
  await new Promise((resolveListen, rejectListen) => {
    server.listen(requestedPort, "127.0.0.1", () => resolveListen());
    server.on("error", rejectListen);
  });

  const controllerPort = server.address().port;
  const workerOrigin = `http://127.0.0.1:${controllerPort}`;
  const previewUrl = `http://omp-replay.localhost:${controllerPort}/__omp-replay`;

  // 2. Await own backend bootstrap with fresh temp scratch home/base-dir and ephemeral backend port
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-replay-"));
  backendPort = await getAvailablePort();
  const fakeWorkerPath = path.resolve(fileURLToPath(import.meta.url), "../fake-omp.mjs");
  const fakeCodexPath = path.resolve(fileURLToPath(import.meta.url), "../fake-codex.mjs");

  try {
    backend = await launchReplayBackend({
      scratchDir,
      port: backendPort,
      fakeWorkerPath,
      fakeCodexPath,
      controllerOrigin: workerOrigin,
      workerToken,
    });

    backendCookie = backend.cookie;
    state.threadUrl = backend.threadUrl;
    backendReady = true;
  } catch (err) {
    server.close();
    if (scratchDir && fs.existsSync(scratchDir)) {
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
    }
    throw new Error(`Failed to bootstrap replay backend: ${err.message}`);
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;

    if (timerResolve) timerResolve();

    // Stop active turn and backend child process
    if (backend) {
      try {
        await backend.stop();
      } catch {}
    }

    // Close worker streams
    for (const [sId, stream] of activeWorkerStreams.entries()) {
      try { stream.res.end(); } catch {}
    }
    activeWorkerStreams.clear();

    // Close controller server
    await new Promise((resolveClose) => {
      server.close(() => resolveClose());
    });

    // Clean scratchDir
    if (scratchDir && fs.existsSync(scratchDir)) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {}
    }
  }

  return {
    server,
    controllerPort,
    backendPort,
    previewUrl,
    workerToken,
    getState,
    stop,
  };
}

export async function stopReplayServer(serverInstance) {
  if (serverInstance && typeof serverInstance.stop === "function") {
    await serverInstance.stop();
  }
}
