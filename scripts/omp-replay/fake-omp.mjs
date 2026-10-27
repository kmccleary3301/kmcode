#!/usr/bin/env node

/**
 * fake-omp.mjs — Offline mock OMP stdio worker for native replay.
 *
 * Implements minimal OMP native ready handshake and PiRpc RPC responses.
 * Speaks line-delimited JSON on stdio and connects to local controller via loopback HTTP.
 */

import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// --- CLI version probe handling ---
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  process.stdout.write("omp 18.8.3 (mock replay worker)\n");
  process.exit(0);
}

// --- Loopback origin validation ---
function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]"
  ) {
    return true;
  }
  // Check IPv4 127.0.0.0/8
  const parts = lower.split(".");
  if (parts.length === 4 && Number(parts[0]) === 127) {
    return parts.slice(1).every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return false;
}

function parseAndValidateLoopbackOrigin(originStr) {
  if (!originStr) return null;
  try {
    const url = new URL(originStr);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!isLoopbackHost(hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

// --- Session and configuration discovery ---
let sessionId = process.env.OMP_REPLAY_SESSION_ID || process.env.SESSION_ID;
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--session" || arg === "--session-id") {
    sessionId = rawArgs[i + 1] || sessionId;
  } else if (arg.startsWith("--session=")) {
    sessionId = arg.slice("--session=".length);
  } else if (arg.startsWith("--session-id=")) {
    sessionId = arg.slice("--session-id=".length);
  }
}
if (!sessionId) {
  sessionId = `omp-replay-${process.pid}-${Date.now()}`;
}

const controllerOriginEnv =
  process.env.OMP_REPLAY_CONTROLLER_ORIGIN || process.env.CONTROLLER_ORIGIN;
const controllerOrigin = parseAndValidateLoopbackOrigin(controllerOriginEnv);
const workerToken = process.env.OMP_REPLAY_WORKER_TOKEN;

// --- Native state ---
let currentSessionFile = path.join(
  os.tmpdir(),
  `omp-replay-${sessionId}.jsonl`,
);
let currentModel = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  name: "Mock OMP",
  contextWindow: 128000,
};
let currentThinkingLevel = "medium";
let isStreaming = false;
let isSettled = true;
let pendingMessageCount = 0;

let nextEntryId = 1;
let entries = [];

// --- Diagnostics and sanitized output ---
function logError(msg) {
  const sanitized = String(msg).replace(
    /(?:key|token|secret|password|bearer)=?[^\s&]+/gi,
    "[REDACTED]",
  );
  process.stderr.write(`[fake-omp] ${sanitized}\n`);
}

function writeJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(resp) {
  writeJsonLine(resp);
}

function getHttpHeaders(contentType, extra = {}) {
  const headers = { ...extra };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (workerToken) {
    headers["x-omp-replay-worker-key"] = workerToken;
  }
  return headers;
}

// --- Controller HTTP communications ---
function postToController(pathname, payload) {
  return new Promise((resolve, reject) => {
    if (!controllerOrigin) {
      return reject(new Error("No controller origin configured"));
    }
    const url = new URL(pathname, controllerOrigin);
    const client = url.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    const req = client.request(
      url,
      {
        method: "POST",
        headers: getHttpHeaders("application/json", {
          "Content-Length": body.length,
        }),
      },
      (res) => {
        let respBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          respBody += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: respBody });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${respBody.slice(0, 100)}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

let eventsReq = null;

function handleIncomingControllerLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    logError("Malformed NDJSON frame from controller");
    return;
  }

  const nativeEvent =
    parsed && typeof parsed === "object" && parsed.frame !== undefined
      ? parsed.frame
      : parsed;

  if (!nativeEvent || typeof nativeEvent !== "object") return;

  // Update native state for agent lifecycle frames
  if (nativeEvent.type === "agent_start") {
    isStreaming = true;
    isSettled = false;
  } else if (
    nativeEvent.type === "agent_end" &&
    nativeEvent.isTerminal === true
  ) {
    isStreaming = false;
    isSettled = true;
    pendingMessageCount = 0;
  } else if (nativeEvent.type === "agent_settled") {
    isStreaming = false;
    isSettled = true;
    pendingMessageCount = 0;
  } else if (nativeEvent.type === "message_end" && nativeEvent.message) {
    entries.push({
      id: `entry-${nextEntryId++}`,
      type: "message",
      message: nativeEvent.message,
      timestamp: Date.now(),
    });
  }

  // Write actual event unchanged to stdout
  writeJsonLine(nativeEvent);
}

function openEventsStream() {
  if (!controllerOrigin) return;
  const url = new URL(
    `/__omp-replay/worker/events?sessionId=${encodeURIComponent(sessionId)}`,
    controllerOrigin,
  );
  const client = url.protocol === "https:" ? https : http;

  const req = client.request(
    url,
    {
      method: "GET",
      headers: getHttpHeaders(null, {
        Accept: "application/x-ndjson, text/event-stream, */*",
      }),
    },
    (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        logError(`Events stream returned HTTP ${res.statusCode}`);
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            handleIncomingControllerLine(line);
          }
        }
      });
      res.on("end", () => {
        if (buffer.trim()) {
          handleIncomingControllerLine(buffer.trim());
        }
      });
    },
  );

  req.on("error", (err) => {
    logError("Events stream connection error: " + err.message);
  });

  eventsReq = req;
  req.end();
}

async function connectToController() {
  try {
    await postToController("/__omp-replay/worker/register", {
      sessionId,
      pid: process.pid,
    });
  } catch (err) {
    logError("Worker registration failed: " + err.message);
    return;
  }
  openEventsStream();
}

// --- Stdio JSONL command dispatcher ---
async function handleStdinCommand(record) {
  if (!record || typeof record !== "object") return;
  const command = record.type;

  switch (command) {
    case "negotiate_protocol": {
      respond({
        id: record.id,
        type: "response",
        command: "negotiate_protocol",
        success: true,
        data: {
          protocolVersion: record.protocolVersion ?? 2,
        },
      });
      break;
    }

    case "set_subagent_subscription": {
      respond({
        id: record.id,
        type: "response",
        command: "set_subagent_subscription",
        success: true,
        data: {},
      });
      break;
    }

    case "get_commands": {
      respond({
        id: record.id,
        type: "response",
        command: "get_commands",
        success: true,
        data: {
          commands: [
            {
              name: "review",
              description: "Review pending fixture",
              input: null,
            },
            {
              name: "test",
              description: "Run fixture tests",
              input: null,
            },
          ],
        },
      });
      break;
    }

    case "get_available_models": {
      respond({
        id: record.id,
        type: "response",
        command: "get_available_models",
        success: true,
        data: {
          models: [
            {
              provider: currentModel.provider,
              id: currentModel.id,
              name: currentModel.name,
              contextWindow: currentModel.contextWindow,
            },
          ],
        },
      });
      break;
    }

    case "get_state": {
      respond({
        id: record.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionFile: currentSessionFile,
          model: {
            provider: currentModel.provider,
            id: currentModel.id,
            name: currentModel.name,
            contextWindow: currentModel.contextWindow,
          },
          thinkingLevel: currentThinkingLevel,
          isStreaming,
          isSettled,
          isCompacting: false,
          hasPendingAsyncWork: false,
          pendingMessageCount,
        },
      });
      break;
    }

    case "set_model": {
      currentModel = {
        provider:
          typeof record.provider === "string"
            ? record.provider
            : currentModel.provider,
        id:
          typeof record.modelId === "string"
            ? record.modelId
            : currentModel.id,
        name: "Mock OMP",
        contextWindow: 128000,
      };
      respond({
        id: record.id,
        type: "response",
        command: "set_model",
        success: true,
        data: {
          provider: currentModel.provider,
          id: currentModel.id,
          name: currentModel.name,
          contextWindow: currentModel.contextWindow,
        },
      });
      break;
    }

    case "set_thinking_level": {
      if (typeof record.level === "string" || record.level === null) {
        currentThinkingLevel = record.level;
      }
      respond({
        id: record.id,
        type: "response",
        command: "set_thinking_level",
        success: true,
        data: {
          thinkingLevel: currentThinkingLevel,
        },
      });
      break;
    }

    case "set_session_name": {
      respond({
        id: record.id,
        type: "response",
        command: "set_session_name",
        success: true,
        data: {},
      });
      break;
    }

    case "get_entries": {
      let resultEntries = entries;
      if (typeof record.since === "string") {
        const idx = entries.findIndex((e) => e.id === record.since);
        if (idx >= 0) {
          resultEntries = entries.slice(idx + 1);
        }
      }
      const leafId =
        entries.length > 0 ? entries[entries.length - 1].id : "leaf-0";
      respond({
        id: record.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: {
          entries: resultEntries,
          leafId,
        },
      });
      break;
    }

    case "get_messages": {
      respond({
        id: record.id,
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: entries
            .filter((e) => e.type === "message")
            .map((e) => e.message),
        },
      });
      break;
    }

    case "get_session_stats": {
      respond({
        id: record.id,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: {
          contextUsage: {
            contextWindow: currentModel.contextWindow,
            tokens: 4200,
          },
          tokens: {
            input: 3200,
            cacheRead: 500,
            output: 1000,
          },
        },
      });
      break;
    }

    case "new_session": {
      entries = [];
      nextEntryId = 1;
      isStreaming = false;
      isSettled = true;
      pendingMessageCount = 0;
      currentSessionFile = path.join(
        os.tmpdir(),
        `omp-replay-${sessionId}-${Date.now()}.jsonl`,
      );
      respond({
        id: record.id,
        type: "response",
        command: "new_session",
        success: true,
        data: {
          sessionFile: currentSessionFile,
        },
      });
      break;
    }

    case "switch_session": {
      if (typeof record.sessionPath === "string") {
        currentSessionFile = record.sessionPath;
      }
      respond({
        id: record.id,
        type: "response",
        command: "switch_session",
        success: true,
        data: {
          sessionFile: currentSessionFile,
        },
      });
      break;
    }

    case "fork": {
      const forkSessionFile = path.join(
        os.tmpdir(),
        `omp-replay-${sessionId}-fork-${Date.now()}.jsonl`,
      );
      respond({
        id: record.id,
        type: "response",
        command: "fork",
        success: true,
        data: {
          sessionFile: forkSessionFile,
        },
      });
      break;
    }

    case "prompt":
    case "steer": {
      const userText =
        typeof record.message === "string" ? record.message : "";
      entries.push({
        id: `entry-${nextEntryId++}`,
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: userText }],
        },
        timestamp: Date.now(),
      });
      isStreaming = true;
      isSettled = false;
      pendingMessageCount = 0;

      if (controllerOrigin) {
        await postToController("/__omp-replay/worker/command", {
          sessionId,
          command: record,
        }).catch((err) => {
          logError("Failed to notify controller of command: " + err.message);
        });
      }

      const ack = {
        type: "response",
        command: record.type,
        success: true,
      };
      if (typeof record.id === "string") {
        ack.id = record.id;
      }
      respond(ack);
      break;
    }

    case "abort": {
      isStreaming = false;
      isSettled = true;
      pendingMessageCount = 0;

      if (controllerOrigin) {
        await postToController("/__omp-replay/worker/command", {
          sessionId,
          command: record,
        }).catch((err) => {
          logError("Failed to notify controller of abort: " + err.message);
        });
      }

      if (typeof record.id === "string") {
        respond({
          id: record.id,
          type: "response",
          command: "abort",
          success: true,
          data: {},
        });
      }

      writeJsonLine({
        type: "agent_end",
        isTerminal: true,
      });
      break;
    }

    case "extension_ui_response": {
      // Fire-and-forget notification from host; no reply expected
      break;
    }

    default: {
      if (typeof record.id === "string") {
        respond({
          id: record.id,
          type: "response",
          command: record.type ?? "unknown",
          success: false,
          error: `Unsupported command: ${record.type}`,
        });
      }
      break;
    }
  }
}

// --- Cleanup handlers ---
function cleanup() {
  if (eventsReq) {
    try {
      eventsReq.destroy();
    } catch {}
    eventsReq = null;
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// --- Startup handshake ---
// Immediately output ready frame and available commands on stdout
writeJsonLine({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
});

writeJsonLine({
  type: "available_commands_update",
  commands: [
    { name: "review", description: "Review pending fixture", input: null },
    { name: "test", description: "Run fixture tests", input: null },
  ],
});

if (controllerOrigin) {
  connectToController().catch((err) => {
    logError("Controller connection setup error: " + err.message);
  });
}

// --- Stdin processing queue ---
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const commandQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (commandQueue.length > 0) {
    const line = commandQueue.shift();
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      await handleStdinCommand(record);
    } catch {
      logError("Malformed JSON line on stdin");
    }
  }
  isProcessingQueue = false;
}

rl.on("line", (line) => {
  commandQueue.push(line);
  processQueue().catch((err) => {
    logError("Queue processing error: " + err.message);
  });
});

rl.on("close", () => {
  cleanup();
  process.exit(0);
});
