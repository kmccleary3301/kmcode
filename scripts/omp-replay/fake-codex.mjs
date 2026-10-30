#!/usr/bin/env node

/**
 * Offline Codex app-server for the isolated replay. It implements the stdio
 * JSON-RPC surface used by CodexProvider and CodexAdapterV2, then emits a
 * deterministic native goal session without launching commands or models.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import { createInterface } from "node:readline";

const CLI_VERSION = "0.156.1";
const MODEL = "gpt-6-luna";
const MODEL_CONTEXT_WINDOW = 128_000;
const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--version") || rawArgs.includes("-v") || rawArgs[0] === "version") {
  process.stdout.write(`codex-cli ${CLI_VERSION}\n`);
  process.exit(0);
}

const goalStages = [
  {
    plan: "Inspect the transcript renderer and map its style boundaries",
    reasoning: "I am tracing the shared transcript data path before changing presentation.",
    commentary: "The same event projection can drive three distinct transcript styles.",
    command: "node scripts/check-transcript-style-contract.mjs",
    output: [
      "Checking transcript renderer contracts…\n",
      "KM: shared event projection matches.\n",
      "Terminal: flat rows and pane output match.\n",
      "Minimal: compact wording verified.\n",
    ],
    path: "apps/web/src/transcript.css",
    diff: "diff --git a/apps/web/src/transcript.css b/apps/web/src/transcript.css\n--- a/apps/web/src/transcript.css\n+++ b/apps/web/src/transcript.css\n@@\n+.transcript-style-root {\n+  --transcript-row-gap: 0.25rem;\n+}\n",
    answer: "The shared transcript structure is ready for three independent visual treatments.",
  },
  {
    plan: "Implement the dense Terminal transcript with flat rows and output panes",
    reasoning: "The Terminal style needs flat ordering, compact status lines, and native tool panes.",
    commentary: "I am keeping event grouping and activity state shared with the other styles.",
    command: "pnpm --filter @t3tools/web verify:terminal-transcript",
    output: [
      "Loading the flat transcript layout…\n",
      "Tool rows: command, read, edit, and search retain their native kinds.\n",
      "Output panes: streamed arguments and results stay attached to each row.\n",
      "Terminal style contract passed.\n",
    ],
    path: "apps/web/src/transcript-terminal.css",
    diff: "diff --git a/apps/web/src/transcript-terminal.css b/apps/web/src/transcript-terminal.css\n--- a/apps/web/src/transcript-terminal.css\n+++ b/apps/web/src/transcript-terminal.css\n@@\n+.transcript-terminal {\n+  font-family: var(--font-mono);\n+  line-height: 1.25;\n+}\n",
    answer: "The Terminal style now keeps tool details readable without changing transcript data.",
  },
  {
    plan: "Add the Minimal style with compact prompt and activity rows",
    reasoning: "Minimal should reduce decoration while preserving the action, object, and diff details.",
    commentary: "The compact style is using the same rows and status transitions as Terminal.",
    command: "node scripts/check-minimal-transcript.mjs",
    output: [
      "Rendering compact prompt blocks…\n",
      "Activity rows: labels and objects remain aligned.\n",
      "Diff summary: added and removed line counts remain visible.\n",
      "Minimal style contract passed.\n",
    ],
    path: "apps/web/src/transcript-minimal.css",
    diff: "diff --git a/apps/web/src/transcript-minimal.css b/apps/web/src/transcript-minimal.css\n--- a/apps/web/src/transcript-minimal.css\n+++ b/apps/web/src/transcript-minimal.css\n@@\n+.transcript-minimal {\n+  --transcript-row-gap: 0.125rem;\n+  --transcript-border: transparent;\n+}\n",
    answer: "The Minimal style presents the same work in a quieter, more compact timeline.",
  },
  {
    plan: "Add previews for KM, Terminal, and Minimal in Appearance settings",
    reasoning: "A fixed sample turn can preview each style without starting a provider run.",
    commentary: "I am wiring the style picker and preview gallery to the shared renderer.",
    command: "pnpm --filter @t3tools/web verify:transcript-style-previews",
    output: [
      "Mounting the fixed sample turn…\n",
      "KM preview: borderless activity rows rendered.\n",
      "Terminal preview: flat rows and panes rendered.\n",
      "Minimal preview: compact prompt and activity rows rendered.\n",
    ],
    path: "apps/web/src/components/settings/TranscriptStylePreview.tsx",
    diff: "diff --git a/apps/web/src/components/settings/TranscriptStylePreview.tsx b/apps/web/src/components/settings/TranscriptStylePreview.tsx\n--- a/apps/web/src/components/settings/TranscriptStylePreview.tsx\n+++ b/apps/web/src/components/settings/TranscriptStylePreview.tsx\n@@\n+const styles = [\"km\", \"terminal\", \"minimal\"] as const;\n+// Each preview renders the same fixed sample turn.\n",
    answer: "Appearance settings now preview all three transcript styles from one fixed sample.",
  },
  {
    plan: "Verify style switching and finish the objective",
    reasoning: "The final pass checks that style selection changes rendering, not the underlying events.",
    commentary: "All previews share one transcript model and the goal controls remain provider-native.",
    command: "node scripts/check-transcript-style-parity.mjs",
    output: [
      "Switching KM → Terminal → Minimal…\n",
      "Shared event count: unchanged.\n",
      "Native goal controls: available.\n",
      "Transcript style parity passed.\n",
    ],
    path: "apps/web/src/components/chat/ChatView.tsx",
    diff: "diff --git a/apps/web/src/components/chat/ChatView.tsx b/apps/web/src/components/chat/ChatView.tsx\n--- a/apps/web/src/components/chat/ChatView.tsx\n+++ b/apps/web/src/components/chat/ChatView.tsx\n@@\n+// Keep the transcript style preview connected to the production renderer.\n",
    answer: "KM, Terminal, and Minimal styles all render the same session data; the objective is complete.",
  },
];

const threads = new Map();
let initialized = false;
let itemSequence = 0;
let turnSequence = 0;

function writeFrame(frame) {
  if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function notify(method, params) {
  writeFrame({ method, params });
}

function respond(id, result) {
  writeFrame({ id, result });
}

function respondError(id, code, message) {
  writeFrame({ id, error: { code, message } });
}

function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeThread(threadId, params = {}) {
  const now = unixSeconds();
  const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
  const model = typeof params.model === "string" && params.model ? params.model : MODEL;
  return {
    id: threadId,
    sessionId: threadId,
    cliVersion: CLI_VERSION,
    createdAt: now,
    updatedAt: now,
    cwd,
    ephemeral: false,
    forkedFromId: null,
    model,
    modelProvider: "openai",
    name: null,
    originator: "t3code",
    parentThreadId: null,
    path: null,
    preview: "",
    projectId: null,
    reasoningEffort: "medium",
    section: null,
    sectionEnteredAt: null,
    source: "appServer",
    status: { type: "idle" },
    turns: [],
  };
}

function makeThreadStartResponse(thread, params = {}) {
  return {
    thread,
    model: thread.model ?? MODEL,
    modelProvider: "openai",
    cwd: thread.cwd,
    approvalPolicy: params.approvalPolicy ?? "never",
    approvalsReviewer: params.approvalsReviewer ?? "user",
    sandbox: params.sandboxPolicy ?? { type: "dangerFullAccess" },
    disabledPluginIds: [],
    instructionSources: [],
    reasoningEffort: params.effort ?? "medium",
    serviceTier: params.serviceTier ?? null,
  };
}

function currentGoalPayload(thread) {
  const goal = thread.goal;
  if (!goal) return null;
  const activeMs = goal.activeSinceMs === null ? 0 : Math.max(0, Date.now() - goal.activeSinceMs);
  return {
    threadId: thread.data.id,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    timeUsedSeconds: Math.floor((goal.accumulatedMs + activeMs) / 1000),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function emitGoalUpdated(thread) {
  if (!thread.goal) return;
  thread.goal.updatedAt = unixSeconds();
  notify("thread/goal/updated", {
    threadId: thread.data.id,
    goal: currentGoalPayload(thread),
    ...(thread.activeTurn ? { turnId: thread.activeTurn.id } : {}),
  });
}

function stopGoalProgress(thread) {
  clearInterval(thread.goalPulse);
  thread.goalPulse = null;
}

function startGoalProgress(thread) {
  stopGoalProgress(thread);
  thread.goalPulse = setInterval(() => {
    if (thread.goal?.status !== "active") return;
    thread.goal.tokensUsed += 60;
    emitGoalUpdated(thread);
  }, 3000);
}

function setGoalStatus(thread, status) {
  const goal = thread.goal;
  if (!goal) return false;
  if (goal.status === "active" && status !== "active" && goal.activeSinceMs !== null) {
    goal.accumulatedMs += Math.max(0, Date.now() - goal.activeSinceMs);
    goal.activeSinceMs = null;
  } else if (goal.status !== "active" && status === "active") {
    goal.activeSinceMs = Date.now();
  }
  goal.status = status;
  if (status === "active") startGoalProgress(thread);
  else stopGoalProgress(thread);
  emitGoalUpdated(thread);
  return true;
}

function makeTurn(thread, goalStageIndex = null) {
  const id = `mock-turn-${++turnSequence}-${randomUUID()}`;
  const turn = {
    id,
    startedAt: unixSeconds(),
    startedAtMs: Date.now(),
    goalStageIndex,
    scriptStarted: false,
    cancelled: false,
    finished: false,
    activeItems: new Map(),
  };
  thread.activeTurn = turn;
  thread.data.status = { type: "active", activeFlags: [] };
  thread.data.updatedAt = unixSeconds();
  return turn;
}

function turnPayload(turn, status, completedAt = null) {
  return {
    id: turn.id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: turn.startedAt,
    completedAt,
    durationMs: completedAt === null ? null : Math.max(0, Date.now() - turn.startedAtMs),
  };
}

function emitTurnStarted(thread, turn, { sendThreadStarted = false } = {}) {
  if (sendThreadStarted && !thread.startedNotificationSent) {
    notify("thread/started", { thread: thread.data });
    thread.startedNotificationSent = true;
  }
  notify("thread/status/changed", {
    threadId: thread.data.id,
    status: { type: "active", activeFlags: [] },
  });
  notify("turn/started", {
    threadId: thread.data.id,
    turn: turnPayload(turn, "inProgress"),
  });
}

function completeItem(thread, turn, item) {
  turn.activeItems.delete(item.id);
  notify("item/completed", {
    threadId: thread.data.id,
    turnId: turn.id,
    completedAtMs: Date.now(),
    item,
  });
}

function startItem(thread, turn, item) {
  turn.activeItems.set(item.id, item);
  notify("item/started", {
    threadId: thread.data.id,
    turnId: turn.id,
    startedAtMs: Date.now(),
    item,
  });
}

function replaceActiveItem(turn, item) {
  if (turn.activeItems.has(item.id)) turn.activeItems.set(item.id, item);
}

function interruptedItem(item) {
  if (item.type === "commandExecution") {
    return {
      ...item,
      status: "completed",
      exitCode: 130,
      aggregatedOutput: `${item.aggregatedOutput ?? ""}\nInterrupted by replay control.`,
    };
  }
  if (item.type === "fileChange") return { ...item, status: "completed" };
  if (item.type === "reasoning") return { ...item, content: item.content ?? [], summary: item.summary ?? [] };
  if (item.type === "agentMessage") return { ...item, text: item.text ?? "" };
  return item;
}

function stopActiveTurn(thread, status = "interrupted") {
  const turn = thread.activeTurn;
  if (!turn || turn.finished) return;
  turn.cancelled = true;
  turn.finished = true;
  for (const item of turn.activeItems.values()) completeItem(thread, turn, interruptedItem(item));
  turn.activeItems.clear();
  thread.activeTurn = null;
  thread.lastTurnId = turn.id;
  thread.data.status = { type: "idle" };
  thread.data.updatedAt = unixSeconds();
  notify("thread/status/changed", { threadId: thread.data.id, status: { type: "idle" } });
  notify("turn/completed", {
    threadId: thread.data.id,
    turn: turnPayload(turn, status, unixSeconds()),
  });
}

function stopNextGoalTurn(thread) {
  clearTimeout(thread.nextGoalTimer);
  thread.nextGoalTimer = null;
}

function finishTurn(thread, turn, status = "completed") {
  if (turn.finished) return;
  turn.finished = true;
  for (const item of turn.activeItems.values()) completeItem(thread, turn, interruptedItem(item));
  turn.activeItems.clear();
  if (thread.activeTurn === turn) thread.activeTurn = null;
  thread.lastTurnId = turn.id;
  thread.data.status = { type: "idle" };
  thread.data.updatedAt = unixSeconds();
  notify("thread/status/changed", { threadId: thread.data.id, status: { type: "idle" } });
  notify("turn/completed", {
    threadId: thread.data.id,
    turn: turnPayload(turn, status, unixSeconds()),
  });
}

function isRunning(thread, turn) {
  return !turn.cancelled && !turn.finished && thread.activeTurn === turn && thread.goal?.status === "active";
}

function controllerOrigin() {
  const origin = process.env.OMP_REPLAY_CONTROLLER_ORIGIN || process.env.CONTROLLER_ORIGIN;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(host)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readReplaySpeed() {
  const origin = controllerOrigin();
  const token = process.env.OMP_REPLAY_WORKER_TOKEN;
  if (!origin || !token) return Promise.resolve(1);
  const url = new URL("/__omp-replay/worker/goal-speed", origin);
  return new Promise((resolve) => {
    const request = http.get(url, { headers: { "x-omp-replay-worker-key": token } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const speed = JSON.parse(body)?.speed;
          resolve(response.statusCode === 200 && Number.isFinite(speed) && speed > 0 ? speed : 1);
        } catch {
          resolve(1);
        }
      });
    });
    request.setTimeout(800, () => request.destroy());
    request.on("error", () => resolve(1));
  });
}

async function waitScaled(thread, turn, durationMs) {
  let remaining = durationMs;
  let lastTick = Date.now();
  let speed = 1;
  let lastSpeedRead = 0;
  while (remaining > 0) {
    if (!isRunning(thread, turn)) return false;
    const now = Date.now();
    if (now - lastSpeedRead >= 700) {
      speed = await readReplaySpeed();
      lastSpeedRead = Date.now();
      if (!isRunning(thread, turn)) return false;
    }
    const tick = Date.now();
    remaining -= Math.max(0, tick - lastTick) * speed;
    lastTick = tick;
    if (remaining <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(120, Math.max(25, remaining / speed))));
  }
  return isRunning(thread, turn);
}

function updateTokenUsage(thread, turn, inputTokens, outputTokens, reasoningTokens) {
  const usage = thread.tokenUsage;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.reasoningOutputTokens += reasoningTokens;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  const lastTotal = inputTokens + outputTokens;
  notify("thread/tokenUsage/updated", {
    threadId: thread.data.id,
    turnId: turn.id,
    tokenUsage: {
      modelContextWindow: MODEL_CONTEXT_WINDOW,
      total: {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
      },
      last: {
        totalTokens: lastTotal,
        inputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens,
        reasoningOutputTokens: reasoningTokens,
      },
    },
  });
}

function emitPlan(thread, turn, stageIndex) {
  notify("turn/plan/updated", {
    threadId: thread.data.id,
    turnId: turn.id,
    explanation: "The native goal is advancing through its implementation checklist.",
    plan: goalStages.map((stage, index) => ({
      step: stage.plan,
      status: index < stageIndex ? "completed" : index === stageIndex ? "inProgress" : "pending",
    })),
  });
}

async function streamReasoning(thread, turn, stage) {
  const id = `mock-item-${++itemSequence}`;
  const item = { id, type: "reasoning", content: [], summary: [] };
  startItem(thread, turn, item);
  const pieces = [stage.reasoning.slice(0, 34), stage.reasoning.slice(34, 70), stage.reasoning.slice(70)].filter(Boolean);
  // GPT models stream only the reasoning summary; raw reasoning (`textDelta`,
  // `content`) is a separate stream the app shows as its own block, so sending
  // the same text on both drew every thought twice.
  let summary = "";
  for (const piece of pieces) {
    if (!(await waitScaled(thread, turn, 3500))) return false;
    summary += piece;
    notify("item/reasoning/summaryTextDelta", {
      threadId: thread.data.id,
      turnId: turn.id,
      itemId: id,
      summaryIndex: 0,
      delta: piece,
    });
    replaceActiveItem(turn, { ...item, summary: [summary] });
  }
  completeItem(thread, turn, { ...item, summary: [summary] });
  return true;
}

async function streamAgentMessage(thread, turn, text, phase = "commentary") {
  const id = `mock-item-${++itemSequence}`;
  let accumulated = "";
  const item = { id, type: "agentMessage", phase, text: "" };
  startItem(thread, turn, item);
  const pieces = [text.slice(0, 32), text.slice(32, 67), text.slice(67)].filter(Boolean);
  for (const piece of pieces) {
    if (!(await waitScaled(thread, turn, phase === "final_answer" ? 2000 : 2500))) return false;
    accumulated += piece;
    notify("item/agentMessage/delta", {
      threadId: thread.data.id,
      turnId: turn.id,
      itemId: id,
      delta: piece,
    });
    replaceActiveItem(turn, { ...item, text: accumulated });
  }
  completeItem(thread, turn, { ...item, text: accumulated });
  return true;
}

async function streamCommand(thread, turn, stage) {
  const id = `mock-item-${++itemSequence}`;
  const startedAt = Date.now();
  let aggregatedOutput = "";
  const item = {
    id,
    type: "commandExecution",
    command: stage.command,
    commandActions: [],
    cwd: thread.data.cwd,
    source: "agent",
    status: "inProgress",
    aggregatedOutput,
  };
  startItem(thread, turn, item);
  for (const delta of stage.output) {
    if (!(await waitScaled(thread, turn, 3800))) return false;
    aggregatedOutput += delta;
    notify("commandExecution/outputDelta", {
      threadId: thread.data.id,
      turnId: turn.id,
      itemId: id,
      delta,
    });
    replaceActiveItem(turn, { ...item, aggregatedOutput });
  }
  completeItem(thread, turn, {
    ...item,
    status: "completed",
    exitCode: 0,
    durationMs: Date.now() - startedAt,
    aggregatedOutput,
  });
  return true;
}

async function showFileChange(thread, turn, stage) {
  const id = `mock-item-${++itemSequence}`;
  const change = {
    path: stage.path,
    kind: { type: "update" },
    diff: stage.diff,
  };
  const item = { id, type: "fileChange", status: "inProgress", changes: [change] };
  startItem(thread, turn, item);
  if (!(await waitScaled(thread, turn, 10_000))) return false;
  completeItem(thread, turn, { ...item, status: "completed" });
  return true;
}

function setGoalProgress(thread, tokenIncrement) {
  if (!thread.goal || thread.goal.status !== "active") return;
  thread.goal.tokensUsed += tokenIncrement;
  emitGoalUpdated(thread);
}

// Real Codex starts the next goal turn milliseconds after the last one
// completes, and the adapter only holds the run open for 5 seconds
// (CODEX_GOAL_CONTINUATION_GRACE), so the gap must stay well under that.
function scheduleAutonomousTurn(thread) {
  stopNextGoalTurn(thread);
  if (thread.goal?.status !== "active" || thread.nextGoalStage >= goalStages.length) return;
  thread.nextGoalTimer = setTimeout(() => {
    thread.nextGoalTimer = null;
    if (thread.goal?.status !== "active" || thread.activeTurn) return;
    const turn = makeTurn(thread, thread.nextGoalStage);
    emitTurnStarted(thread, turn);
    void runGoalStage(thread, turn);
  }, 400);
}

async function runGoalStage(thread, turn) {
  if (!isRunning(thread, turn) || turn.goalStageIndex === null) return;
  if (turn.scriptStarted) return;
  turn.scriptStarted = true;
  const stageIndex = turn.goalStageIndex;
  const stage = goalStages[stageIndex];
  if (!stage) return;

  if (!(await waitScaled(thread, turn, 1800))) return;
  emitPlan(thread, turn, stageIndex);
  if (!(await streamReasoning(thread, turn, stage))) return;
  setGoalProgress(thread, 135);
  if (!(await streamAgentMessage(thread, turn, stage.commentary))) return;
  if (!(await streamCommand(thread, turn, stage))) return;
  setGoalProgress(thread, 235);
  if (!(await showFileChange(thread, turn, stage))) return;
  if (!(await streamAgentMessage(thread, turn, stage.answer, "final_answer"))) return;

  updateTokenUsage(thread, turn, 950 + stageIndex * 40, 230 + stageIndex * 30, 145 + stageIndex * 20);
  setGoalProgress(thread, 180);
  thread.nextGoalStage = stageIndex + 1;
  if (thread.nextGoalStage >= goalStages.length) {
    setGoalStatus(thread, "complete");
    finishTurn(thread, turn, "completed");
    return;
  }
  finishTurn(thread, turn, "completed");
  scheduleAutonomousTurn(thread);
}

function startTurn(thread, params = {}) {
  if (thread.activeTurn && !thread.activeTurn.finished) {
    return { error: "A native turn is already running." };
  }
  const stageIndex = thread.goal ? thread.nextGoalStage : null;
  const turn = makeTurn(thread, stageIndex);
  const responseTurn = {
    id: turn.id,
    items: [],
    itemsView: "notLoaded",
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  queueMicrotask(() => {
    emitTurnStarted(thread, turn, { sendThreadStarted: true });
    if (thread.goal?.status === "active") void runGoalStage(thread, turn);
    else if (!thread.goal && params.input?.length) {
      const prompt = params.input.map((entry) => entry?.text ?? "").join(" ").trim();
      if (prompt) void streamAgentMessage(thread, turn, `Mock Codex received: ${prompt}`, "final_answer").then(() => finishTurn(thread, turn));
    }
  });
  return { turn: responseTurn };
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    if (initialized) {
      respondError(id, -32600, "Already initialized");
      return;
    }
    initialized = true;
    respond(id, {
      userAgent: `codex/${CLI_VERSION} macos-arm64`,
      codexHome: process.env.CODEX_HOME || `${process.env.HOME || "/tmp"}/.codex`,
      platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : "linux",
    });
    return;
  }

  if (method === "account/read") {
    respond(id, {
      account: { type: "chatgpt", email: "mock-codex@localhost", planType: "plus" },
      requiresOpenaiAuth: false,
    });
    return;
  }
  if (method === "account/rateLimits/read") {
    respond(id, { rateLimits: { planType: "plus", limitId: "codex" }, rateLimitResetCredits: null });
    return;
  }
  if (method === "model/list") {
    respond(id, {
      data: [{
        id: MODEL,
        model: MODEL,
        displayName: "Mock GPT-6 Luna",
        description: "Offline replay model; no requests leave this machine.",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low" },
          { reasoningEffort: "medium", description: "Medium" },
          { reasoningEffort: "high", description: "High" },
        ],
        serviceTiers: [],
      }],
      nextCursor: null,
    });
    return;
  }
  if (method === "skills/list") {
    respond(id, { data: (params.cwds ?? []).map((cwd) => ({ cwd, skills: [], errors: [] })) });
    return;
  }
  if (method === "config/read") {
    respond(id, { config: {}, layers: [] });
    return;
  }

  if (method === "thread/start") {
    const threadId = randomUUID();
    const data = makeThread(threadId, params);
    const thread = {
      data,
      goal: null,
      goalPulse: null,
      activeTurn: null,
      nextGoalStage: 0,
      nextGoalTimer: null,
      startedNotificationSent: false,
      lastTurnId: null,
      tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    };
    threads.set(threadId, thread);
    respond(id, makeThreadStartResponse(data, params));
    return;
  }
  if (method === "thread/read" || method === "thread/resume") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      respondError(id, -32001, `Unknown mock Codex thread: ${params.threadId}`);
      return;
    }
    thread.data.status = { type: "idle" };
    respond(id, method === "thread/read" ? { thread: thread.data } : makeThreadStartResponse(thread.data, params));
    return;
  }
  if (method === "thread/unsubscribe") {
    respond(id, { status: "unsubscribed" });
    return;
  }

  if (method === "thread/goal/get") {
    const thread = threads.get(params.threadId);
    if (!thread) return respondError(id, -32001, "Unknown mock Codex thread");
    respond(id, { goal: currentGoalPayload(thread) });
    return;
  }
  if (method === "thread/goal/set") {
    const thread = threads.get(params.threadId);
    if (!thread) return respondError(id, -32001, "Unknown mock Codex thread");
    if (typeof params.objective === "string") {
      stopNextGoalTurn(thread);
      stopActiveTurn(thread);
      stopGoalProgress(thread);
      const now = unixSeconds();
      thread.goal = {
        objective: params.objective,
        status: params.status ?? "paused",
        tokensUsed: 0,
        tokenBudget: params.tokenBudget ?? 5000,
        createdAt: now,
        updatedAt: now,
        accumulatedMs: 0,
        activeSinceMs: null,
      };
      thread.nextGoalStage = 0;
      respond(id, { goal: currentGoalPayload(thread) });
      emitGoalUpdated(thread);
      if (thread.goal.status === "active") {
        thread.goal.activeSinceMs = Date.now();
        startGoalProgress(thread);
        if (thread.activeTurn) void runGoalStage(thread, thread.activeTurn);
      }
      return;
    }
    if (!thread.goal) return respondError(id, -32002, "No mock Codex goal is set");
    const wasActive = thread.goal.status === "active";
    const status = params.status ?? thread.goal.status;
    if (!setGoalStatus(thread, status)) return respondError(id, -32002, "No mock Codex goal is set");
    respond(id, { goal: currentGoalPayload(thread) });
    if (status !== "active") {
      stopNextGoalTurn(thread);
      if (wasActive) {
        if (thread.activeTurn?.scriptStarted) thread.nextGoalStage = Math.max(thread.nextGoalStage, thread.activeTurn.goalStageIndex + 1);
        stopActiveTurn(thread);
      }
    } else if (thread.activeTurn) {
      void runGoalStage(thread, thread.activeTurn);
    }
    return;
  }
  if (method === "thread/goal/clear") {
    const thread = threads.get(params.threadId);
    if (!thread) return respondError(id, -32001, "Unknown mock Codex thread");
    const cleared = thread.goal !== null;
    stopNextGoalTurn(thread);
    stopGoalProgress(thread);
    thread.goal = null;
    respond(id, { cleared });
    if (cleared) notify("thread/goal/cleared", { threadId: thread.data.id });
    stopActiveTurn(thread);
    return;
  }

  if (method === "turn/start") {
    const thread = threads.get(params.threadId);
    if (!thread) return respondError(id, -32001, "Unknown mock Codex thread");
    const result = startTurn(thread, params);
    if (result.error) return respondError(id, -32000, result.error);
    respond(id, result);
    return;
  }
  if (method === "turn/interrupt") {
    const thread = threads.get(params.threadId);
    if (!thread) return respondError(id, -32001, "Unknown mock Codex thread");
    if (thread.goal?.status === "active") {
      setGoalStatus(thread, "paused");
      stopNextGoalTurn(thread);
    }
    stopActiveTurn(thread);
    respond(id, { turn: { id: params.turnId, status: "interrupted" } });
    return;
  }
  if (method === "turn/steer") {
    const thread = threads.get(params.threadId);
    if (!thread?.activeTurn) return respondError(id, -32001, "No active mock Codex turn");
    respond(id, { turnId: thread.activeTurn.id });
    return;
  }

  if (id !== undefined) respondError(id, -32601, `Unsupported mock Codex method: ${method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("[fake-codex] Ignoring malformed JSON-RPC input.\n");
    return;
  }
  if (message.method === "initialized") return;
  try {
    handleRequest(message);
  } catch (error) {
    process.stderr.write(`[fake-codex] ${error instanceof Error ? error.message : String(error)}\n`);
    if (message.id !== undefined) respondError(message.id, -32603, "Mock Codex app-server error");
  }
});

input.on("close", () => {
  for (const thread of threads.values()) {
    stopNextGoalTurn(thread);
    stopGoalProgress(thread);
  }
});
