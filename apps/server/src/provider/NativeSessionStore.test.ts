// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  OMP_TITLE_SLOT_BYTES,
  listNativeSessionFiles,
  readNativeHistory,
  resolveNativeSessionDirectory,
  serializeOmpTitleSlot,
  writeNativeSessionTitle,
  type NativeSessionLocation,
} from "./NativeSessionStore.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

async function agentDirectory(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "km-native-sessions-"));
  temporaryDirectories.push(directory);
  return directory;
}

function location(
  runtime: NativeSessionLocation["runtime"],
  agentDir: string,
): NativeSessionLocation {
  return {
    runtime,
    cwd: "/workspace",
    environment: { PI_CODING_AGENT_DIR: agentDir },
    launchArguments: [],
  };
}

function jsonl(records: ReadonlyArray<unknown>): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function writeSession(
  agentDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const filePath = NodePath.join(agentDir, "sessions", relativePath);
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, content);
  return filePath;
}

describe("resolveNativeSessionDirectory", () => {
  it("prefers --session-dir, then the session-dir variable, then the agent dir", () => {
    const base = { runtime: "omp", cwd: "/workspace", launchArguments: [] } as const;
    expect(
      resolveNativeSessionDirectory({
        ...base,
        environment: { PI_CODING_AGENT_SESSION_DIR: "/env-sessions" },
        launchArguments: ["--session-dir=rel"],
      }),
    ).toBe("/workspace/rel");
    expect(
      resolveNativeSessionDirectory({
        ...base,
        environment: { PI_CODING_AGENT_SESSION_DIR: "/env-sessions", PI_CODING_AGENT_DIR: "/a" },
      }),
    ).toBe("/env-sessions");
    expect(
      resolveNativeSessionDirectory({ ...base, environment: { PI_CODING_AGENT_DIR: "/agent" } }),
    ).toBe("/agent/sessions");
  });

  it("scopes OMP to its profile and Pi to ~/.pi", () => {
    expect(
      resolveNativeSessionDirectory({
        runtime: "omp",
        cwd: "/workspace",
        environment: { HOME: "/home/km", OMP_PROFILE: "env" },
        launchArguments: ["--profile", "work"],
      }),
    ).toBe("/home/km/.omp/profiles/work/agent/sessions");
    expect(
      resolveNativeSessionDirectory({
        runtime: "pi",
        cwd: "/workspace",
        environment: { HOME: "/home/km", OMP_PROFILE: "work" },
        launchArguments: [],
      }),
    ).toBe("/home/km/.pi/agent/sessions");
  });
});

describe("listNativeSessionFiles", () => {
  it("lists top-level OMP sessions newest-first, once per session id", async () => {
    const agentDir = await agentDirectory();
    await writeSession(
      agentDir,
      "-workspace/current.jsonl",
      serializeOmpTitleSlot("Existing OMP work", "2026-08-01T12:00:00.000Z") +
        jsonl([
          {
            type: "session",
            id: "session-1",
            cwd: "/workspace",
            timestamp: "2026-08-01T12:00:00.000Z",
          },
          { type: "model_change", id: "m", provider: "openai", modelId: "gpt-5.6" },
          {
            type: "message",
            id: "u",
            parentId: "m",
            timestamp: "2026-08-01T12:00:01.000Z",
            message: { role: "user", content: "continue this" },
          },
          {
            type: "message",
            id: "a",
            parentId: "u",
            timestamp: "2026-08-01T12:00:02.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          },
        ]),
    );
    const stale = await writeSession(
      agentDir,
      "-workspace/stale-copy.jsonl",
      jsonl([{ type: "session", id: "session-1", cwd: "/workspace", title: "Old duplicate" }]),
    );
    await NodeFSP.utimes(stale, 0, 0);
    await writeSession(agentDir, "-workspace/corrupt.jsonl", "{not json\n");
    // OMP keeps subagent transcripts under a directory named after the parent.
    await writeSession(
      agentDir,
      "-workspace/current/subagent.jsonl",
      jsonl([{ type: "session", id: "subagent", cwd: "/workspace" }]),
    );
    await writeSession(
      agentDir,
      "-other/other.jsonl",
      jsonl([
        { type: "session", id: "other", cwd: "/other" },
        {
          type: "message",
          id: "u",
          timestamp: "2026-08-01T12:00:01.000Z",
          message: { role: "user", content: "untitled  prompt\nbecomes title" },
        },
      ]),
    );

    const sessions = await listNativeSessionFiles(
      location("omp", agentDir),
      ProviderInstanceId.make("omp"),
    );

    expect(sessions.map((session) => session.summary.sessionId).sort()).toEqual([
      "other",
      "session-1",
    ]);
    expect(
      sessions.find((session) => session.summary.sessionId === "session-1")?.summary,
    ).toMatchObject({
      runtime: "omp",
      cwd: "/workspace",
      title: "Existing OMP work",
      model: "openai/gpt-5.6",
      status: "complete",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(sessions.find((session) => session.summary.sessionId === "other")?.summary.title).toBe(
      "untitled prompt becomes title",
    );
  });

  it("skips OMP subagent directories in a flat --session-dir", async () => {
    const sessionDir = await agentDirectory();
    const write = async (relativePath: string, id: string) => {
      const filePath = NodePath.join(sessionDir, relativePath);
      await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
      await NodeFSP.writeFile(filePath, jsonl([{ type: "session", id, cwd: "/workspace" }]));
    };
    await write("parent.jsonl", "parent");
    await write("parent/Worker.jsonl", "subagent");

    const sessions = await listNativeSessionFiles(
      {
        runtime: "omp",
        cwd: "/workspace",
        environment: {},
        launchArguments: ["--session-dir", sessionDir],
      },
      ProviderInstanceId.make("omp"),
    );

    expect(sessions.map((session) => session.summary.sessionId)).toEqual(["parent"]);
  });

  it("returns nothing when the sessions directory does not exist", async () => {
    const agentDir = await agentDirectory();
    expect(
      await listNativeSessionFiles(location("pi", agentDir), ProviderInstanceId.make("pi")),
    ).toEqual([]);
  });
});

describe("readNativeHistory", () => {
  it("follows the active branch in content order and attaches tool results to their calls", async () => {
    const agentDir = await agentDirectory();
    const filePath = await writeSession(
      agentDir,
      "-workspace/branched.jsonl",
      jsonl([
        { type: "session", id: "s", cwd: "/workspace", timestamp: "2026-08-01T12:00:00.000Z" },
        { type: "model_change", id: "root", parentId: null, modelId: "gpt-5.6" },
        {
          type: "message",
          id: "abandoned",
          parentId: "root",
          timestamp: "2026-08-01T12:00:01.000Z",
          message: { role: "user", content: "abandoned prompt" },
        },
        {
          type: "message",
          id: "user",
          parentId: "root",
          timestamp: "2026-08-01T12:00:02.000Z",
          message: { role: "user", content: [{ type: "text", text: "active prompt" }] },
        },
        {
          type: "message",
          id: "assistant",
          parentId: "user",
          timestamp: "2026-08-01T12:00:03.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan" },
              { type: "thinking", thinking: "more plan" },
              { type: "text", text: "active answer" },
              { type: "toolCall", id: "c", name: "bash", arguments: { command: "false" } },
              { type: "text", text: "after the call" },
              { type: "toolCall", id: "unanswered", name: "read", arguments: { path: "a" } },
            ],
          },
        },
        {
          type: "message",
          id: "tool",
          parentId: "assistant",
          timestamp: "2026-08-01T12:00:04.000Z",
          message: {
            role: "toolResult",
            toolCallId: "c",
            content: [{ type: "text", text: "x" }],
            details: { exitCode: 1 },
            isError: true,
          },
        },
      ]),
    );

    expect(await readNativeHistory(filePath)).toEqual([
      { role: "user", text: "active prompt", createdAt: "2026-08-01T12:00:02.000Z" },
      { role: "reasoning", text: "plan\n\nmore plan", createdAt: "2026-08-01T12:00:03.000Z" },
      { role: "assistant", text: "active answer", createdAt: "2026-08-01T12:00:03.000Z" },
      {
        role: "tool",
        toolCallId: "c",
        toolName: "bash",
        args: { command: "false" },
        result: {
          outputText: "x",
          details: { exitCode: 1 },
          isError: true,
          completedAt: "2026-08-01T12:00:04.000Z",
        },
        createdAt: "2026-08-01T12:00:03.000Z",
      },
      { role: "assistant", text: "after the call", createdAt: "2026-08-01T12:00:03.000Z" },
      {
        role: "tool",
        toolCallId: "unanswered",
        toolName: "read",
        args: { path: "a" },
        result: undefined,
        createdAt: "2026-08-01T12:00:03.000Z",
      },
    ]);
  });
});

describe("writeNativeSessionTitle", () => {
  it("rewrites the OMP title slot in place without moving the rest of the file", async () => {
    const agentDir = await agentDirectory();
    const body = jsonl([
      { type: "session", id: "omp-1", cwd: "/workspace", timestamp: "2026-08-01T12:00:00.000Z" },
    ]);
    const filePath = await writeSession(
      agentDir,
      "-workspace/omp.jsonl",
      serializeOmpTitleSlot("", "2026-08-01T12:00:00.000Z") + body,
    );

    await writeNativeSessionTitle({
      filePath,
      runtime: "omp",
      title: "ünïcode ".repeat(40),
      updatedAt: "2026-08-02T00:00:00.000Z",
      entryId: "unused",
    });

    const bytes = await NodeFSP.readFile(filePath);
    expect(bytes.subarray(OMP_TITLE_SLOT_BYTES).toString("utf8")).toBe(body);
    const slot = JSON.parse(bytes.subarray(0, OMP_TITLE_SLOT_BYTES - 1).toString("utf8"));
    expect(slot).toMatchObject({ type: "title", v: 1, source: "user" });
    expect("ünïcode ".repeat(40).startsWith(slot.title)).toBe(true);
    const [session] = await listNativeSessionFiles(
      location("omp", agentDir),
      ProviderInstanceId.make("omp"),
    );
    expect(session?.summary.title).toBe(slot.title.trim());
  });

  it("appends a session_info rename under the Pi leaf", async () => {
    const agentDir = await agentDirectory();
    const filePath = await writeSession(
      agentDir,
      "-workspace/pi.jsonl",
      jsonl([
        { type: "session", id: "pi-1", cwd: "/workspace", timestamp: "2026-08-01T12:00:00.000Z" },
        { type: "model_change", id: "leaf", parentId: null, modelId: "m" },
      ]),
    );

    await writeNativeSessionTitle({
      filePath,
      runtime: "pi",
      title: "Renamed Pi work",
      updatedAt: "2026-08-02T00:00:00.000Z",
      entryId: "abcd1234",
    });

    const lines = (await NodeFSP.readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      type: "session_info",
      id: "abcd1234",
      parentId: "leaf",
      timestamp: "2026-08-02T00:00:00.000Z",
      name: "Renamed Pi work",
    });
    const [session] = await listNativeSessionFiles(
      location("pi", agentDir),
      ProviderInstanceId.make("pi"),
    );
    expect(session?.summary.title).toBe("Renamed Pi work");
  });

  it("appends a title_change to OMP files that predate the title slot", async () => {
    const agentDir = await agentDirectory();
    const filePath = await writeSession(
      agentDir,
      "-workspace/legacy.jsonl",
      jsonl([{ type: "session", id: "omp-legacy", cwd: "/workspace", title: "Old" }]),
    );

    await writeNativeSessionTitle({
      filePath,
      runtime: "omp",
      title: "New",
      updatedAt: "2026-08-02T00:00:00.000Z",
      entryId: "e1",
    });

    const [session] = await listNativeSessionFiles(
      location("omp", agentDir),
      ProviderInstanceId.make("omp"),
    );
    expect(session?.summary.title).toBe("New");
  });
});
