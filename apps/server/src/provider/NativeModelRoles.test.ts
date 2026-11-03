// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { ProviderModelRoleError } from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "vite-plus/test";

import {
  parseModelRoleSelector,
  readModelRoles,
  readRecentModels,
  writeModelRole,
} from "./NativeModelRoles.ts";

describe("parseModelRoleSelector", () => {
  it.each([
    [
      "openai-codex/gpt-5.4:high",
      { model: "openai-codex/gpt-5.4", thinkingLevel: "high", aliasOf: null },
    ],
    // `:8b` is a model tag, not a thinking level.
    ["ollama/llama3:8b", { model: "ollama/llama3:8b", thinkingLevel: null, aliasOf: null }],
    ["ollama/llama3:8b:max", { model: "ollama/llama3:8b", thinkingLevel: "max", aliasOf: null }],
    [
      "openrouter/~typesafe/jev-latest",
      { model: "openrouter/~typesafe/jev-latest", thinkingLevel: null, aliasOf: null },
    ],
    ["@slow:high", { model: null, thinkingLevel: "high", aliasOf: "slow" }],
    ["*", { model: null, thinkingLevel: null, aliasOf: "default" }],
    ["a/one:low, b/two", { model: "a/one", thinkingLevel: "low", aliasOf: null }],
  ])("parses %s", (selector, expected) => {
    assert.deepStrictEqual(parseModelRoleSelector(selector), expected);
  });
});

describe("model role config", () => {
  let agentDir: string;
  let configPath: string;
  beforeEach(() => {
    agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-roles-"));
    configPath = NodePath.join(agentDir, "config.yml");
  });
  afterEach(() => NodeFS.rmSync(agentDir, { recursive: true, force: true }));

  it("edits one role in place, keeping comments, order and other settings", async () => {
    NodeFS.writeFileSync(
      configPath,
      [
        "# my omp config",
        "theme: dark",
        "modelRoles:",
        "  smol: a/fast # cheap",
        "  reviewer: b/careful:max",
        "  default: c/main",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const { roles } = await writeModelRole(agentDir, "smol", "d/faster", "high");
    const text = NodeFS.readFileSync(configPath, "utf8");
    assert.include(text, "# my omp config");
    assert.include(text, "theme: dark");
    assert.include(text, "smol: d/faster:high # cheap");
    assert.isBelow(text.indexOf("smol:"), text.indexOf("reviewer:"));
    assert.strictEqual(NodeFS.statSync(configPath).mode & 0o777, 0o600);

    assert.deepStrictEqual(
      roles.slice(0, 2).map((r) => [r.role, r.selector]),
      [
        ["default", "c/main"],
        ["smol", "d/faster:high"],
      ],
    );
    assert.deepStrictEqual(
      roles.filter((r) => !r.builtIn).map((r) => [r.role, r.model, r.thinkingLevel]),
      [["reviewer", "b/careful", "max"]],
    );
    assert.isNull(roles.find((r) => r.role === "plan")?.selector);
  });

  it("rebinding a fallback chain replaces only its primary model", async () => {
    NodeFS.writeFileSync(configPath, "modelRoles:\n  slow: a/deep:high, b/backup,c/last\n");
    const { roles } = await writeModelRole(agentDir, "slow", "x/new", "max");
    const slow = roles.find((r) => r.role === "slow");
    assert.strictEqual(slow?.selector, "x/new:max, b/backup, c/last");
    assert.strictEqual(slow?.model, "x/new");
    assert.strictEqual(slow?.thinkingLevel, "max");
  });

  it("unbinds a role and treats unbinding an unset role as a no-op", async () => {
    NodeFS.writeFileSync(configPath, "modelRoles:\n  task: a/b\n  plan: c/d\n");
    await writeModelRole(agentDir, "commit", null);
    assert.strictEqual(
      NodeFS.readFileSync(configPath, "utf8"),
      "modelRoles:\n  task: a/b\n  plan: c/d\n",
    );

    await writeModelRole(agentDir, "task", null);
    const { roles } = await readModelRoles(agentDir);
    assert.isNull(roles.find((r) => r.role === "task")?.selector);
    assert.strictEqual(roles.find((r) => r.role === "plan")?.model, "c/d");
  });

  it("creates the config and fills an empty modelRoles key", async () => {
    await writeModelRole(agentDir, "default", "a/b");
    assert.strictEqual((await readModelRoles(agentDir)).roles[0]?.model, "a/b");

    NodeFS.writeFileSync(configPath, "modelRoles:\nother: 1\n");
    await writeModelRole(agentDir, "task", "x/y");
    assert.include(NodeFS.readFileSync(configPath, "utf8"), "other: 1");
    assert.strictEqual(
      (await readModelRoles(agentDir)).roles.find((r) => r.role === "task")?.model,
      "x/y",
    );
  });

  it("serializes concurrent writes without losing bindings", async () => {
    await Promise.all(
      ["default", "smol", "slow", "plan", "task"].map((role, i) =>
        writeModelRole(agentDir, role, `p/m${i}`),
      ),
    );
    const { roles } = await readModelRoles(agentDir);
    assert.deepStrictEqual(
      roles.slice(0, 5).map((r) => r.model),
      ["p/m0", "p/m1", "p/m2", "p/m3", "p/m4"],
    );
  });

  it("rejects malformed input and non-mapping modelRoles without touching the file", async () => {
    NodeFS.writeFileSync(configPath, "modelRoles:\n  task: a/b\n");
    for (const [model, level] of [
      ["no-slash", undefined],
      ["a/b, c/d", undefined],
      ["a/b", "turbo"],
    ] as const) {
      const error = await writeModelRole(agentDir, "task", model, level).catch(
        (cause: unknown) => cause,
      );
      assert.instanceOf(error, ProviderModelRoleError);
      assert.strictEqual(error.code, "invalid");
    }
    assert.strictEqual(NodeFS.readFileSync(configPath, "utf8"), "modelRoles:\n  task: a/b\n");

    NodeFS.writeFileSync(configPath, "modelRoles: a/b\n");
    const error = await writeModelRole(agentDir, "task", "c/d").catch((cause: unknown) => cause);
    assert.instanceOf(error, ProviderModelRoleError);
    assert.strictEqual(error.code, "invalid");
    assert.strictEqual(NodeFS.readFileSync(configPath, "utf8"), "modelRoles: a/b\n");
  });
});

describe("readRecentModels", () => {
  it("returns OMP usage most recent first and [] when the db is missing", async () => {
    const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-usage-"));
    try {
      assert.deepStrictEqual(await readRecentModels(agentDir), []);
      const db = new NodeSqlite.DatabaseSync(NodePath.join(agentDir, "agent.db"));
      db.exec(
        "CREATE TABLE model_usage (model_key TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL)",
      );
      db.exec("INSERT INTO model_usage VALUES ('a/old', 100), ('b/new', 200)");
      db.close();
      assert.deepStrictEqual(await readRecentModels(agentDir), [
        { model: "b/new", usedAt: "1970-01-01T00:03:20.000Z" },
        { model: "a/old", usedAt: "1970-01-01T00:01:40.000Z" },
      ]);
    } finally {
      NodeFS.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
