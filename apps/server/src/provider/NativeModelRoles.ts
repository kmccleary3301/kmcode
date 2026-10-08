// @effect-diagnostics nodeBuiltinImport:off
/**
 * OMP model roles (`modelRoles` in `<agentDir>/config.yml`) and OMP's model
 * usage history (`<agentDir>/agent.db`). Pi has neither.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import { Document, isMap, isScalar, parseDocument } from "yaml";
import {
  ProviderModelRoleError,
  type ProviderModelRoleBinding,
  type ProviderModelUsage,
} from "@t3tools/contracts";

/** OMP built-in roles (`config/model-roles.ts`), in the order the picker lists them. */
export const BUILT_IN_MODEL_ROLES: ReadonlyArray<string> = [
  "default",
  "smol",
  "slow",
  "plan",
  "task",
  "advisor",
  "vision",
  "designer",
  "commit",
  "tiny",
];

/** Thinking suffixes OMP's `splitThinkingSuffix` accepts. */
const THINKING_LEVELS: Readonly<Record<string, true>> = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};

const ROLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const MODEL_PATTERN = /^[^\s,/]+\/[^\s,]+$/u;

export interface ParsedModelRoleSelector {
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly aliasOf: string | null;
}

export interface ModelRolesSnapshot {
  readonly roles: ReadonlyArray<ProviderModelRoleBinding>;
  readonly configPath: string;
}

/**
 * Parse an OMP role selector: `provider/model[:level]`, `@role[:level]`, `*`
 * (alias of `default`), and comma fallback chains (first entry wins). A
 * trailing `:x` is a thinking level only when OMP knows the level, so
 * `ollama/llama3:8b` keeps its tag.
 */
export function parseModelRoleSelector(selector: string | null): ParsedModelRoleSelector {
  const first = selector?.split(",")[0]?.trim() ?? "";
  if (first.length === 0) return { model: null, thinkingLevel: null, aliasOf: null };
  const colon = first.lastIndexOf(":");
  const suffix = colon < 0 ? "" : first.slice(colon + 1).trim();
  const level = THINKING_LEVELS[suffix] === true ? suffix : null;
  const base = level === null ? first : first.slice(0, colon).trim();
  if (base === "*") return { model: null, thinkingLevel: level, aliasOf: "default" };
  if (base.startsWith("@")) {
    const target = base.slice(1).trim();
    return { model: null, thinkingLevel: level, aliasOf: target.length > 0 ? target : null };
  }
  return { model: base.length > 0 ? base : null, thinkingLevel: level, aliasOf: null };
}

function ioError(action: string, configPath: string, cause: unknown): ProviderModelRoleError {
  return new ProviderModelRoleError({
    code: "io",
    message: `Failed to ${action} '${configPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/** Read config.yml; `null` when it does not exist. Rejects invalid YAML rather than guessing. */
async function loadConfigDocument(configPath: string): Promise<Document | null> {
  let content: string;
  try {
    content = await NodeFSP.readFile(configPath, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw ioError("read", configPath, cause);
  }
  const doc = parseDocument(content);
  const [parseError] = doc.errors;
  if (parseError !== undefined) {
    throw new ProviderModelRoleError({
      code: "invalid",
      message: `YAML parse error in '${configPath}': ${parseError.message}`,
    });
  }
  return doc;
}

/** Every built-in role (unset ones have a null selector), then custom roles in config order. */
function rolesFromDocument(doc: Document | null): ReadonlyArray<ProviderModelRoleBinding> {
  const configured: Array<readonly [string, string | null]> = [];
  const node = doc?.get("modelRoles");
  if (isMap(node)) {
    for (const pair of node.items) {
      const role = String(isScalar(pair.key) ? pair.key.value : pair.key);
      const raw = isScalar(pair.value) ? pair.value.value : pair.value;
      const selector = typeof raw === "string" ? raw.trim() : "";
      configured.push([role, selector.length > 0 ? selector : null]);
    }
  }
  const selectors: Record<string, string | null> = Object.fromEntries(configured);
  const toBinding = (role: string, builtIn: boolean): ProviderModelRoleBinding => {
    const selector = selectors[role] ?? null;
    return { role, builtIn, selector, ...parseModelRoleSelector(selector) };
  };
  const builtIn: Record<string, true> = Object.fromEntries(
    BUILT_IN_MODEL_ROLES.map((role) => [role, true] as const),
  );
  return [
    ...BUILT_IN_MODEL_ROLES.map((role) => toBinding(role, true)),
    ...configured
      .filter(([role]) => builtIn[role] !== true && ROLE_ID_PATTERN.test(role))
      .map(([role]) => toBinding(role, false)),
  ];
}

export async function readModelRoles(agentDir: string): Promise<ModelRolesSnapshot> {
  const configPath = NodePath.join(agentDir, "config.yml");
  return { roles: rolesFromDocument(await loadConfigDocument(configPath)), configPath };
}

const writeQueues: Record<string, Promise<unknown>> = {};

/** Serialize read-modify-write cycles per config file. */
function enqueueWrite<T>(configPath: string, task: () => Promise<T>): Promise<T> {
  const run = (writeQueues[configPath] ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  writeQueues[configPath] = settled;
  void settled.then(() => {
    if (writeQueues[configPath] === settled) delete writeQueues[configPath];
  });
  return run;
}

/** Temp file + rename in the same directory, preserving the existing file mode. */
async function writeDocumentAtomically(configPath: string, doc: Document): Promise<void> {
  const mode = await NodeFSP.stat(configPath).then(
    (stat) => stat.mode & 0o777,
    () => undefined,
  );
  const tempPath = `${configPath}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true });
    await NodeFSP.writeFile(
      tempPath,
      doc.toString(),
      mode === undefined ? "utf8" : { encoding: "utf8", mode },
    );
    await NodeFSP.rename(tempPath, configPath);
  } catch (cause) {
    await NodeFSP.rm(tempPath, { force: true });
    throw ioError("write", configPath, cause);
  }
}

/**
 * Bind (`model` set) or unbind (`model` null) one role in `<agentDir>/config.yml`.
 * Binding replaces only the primary entry of a fallback chain
 * (`a/b:high, c/d` → `x/y, c/d`). Edits the YAML document in place so
 * comments, key order and unrelated settings survive (OMP's own writer
 * re-serializes and drops comments).
 */
export async function writeModelRole(
  agentDir: string,
  role: string,
  model: string | null,
  thinkingLevel?: string | null,
): Promise<ModelRolesSnapshot> {
  const invalidReason = !ROLE_ID_PATTERN.test(role)
    ? `Invalid role name '${role}'.`
    : model !== null && !MODEL_PATTERN.test(model)
      ? `Model '${model}' must be 'provider/id' without spaces or commas.`
      : thinkingLevel && THINKING_LEVELS[thinkingLevel] !== true
        ? `Unknown thinking level '${thinkingLevel}'.`
        : null;
  if (invalidReason !== null) {
    throw new ProviderModelRoleError({ code: "invalid", message: invalidReason });
  }
  const configPath = NodePath.join(agentDir, "config.yml");

  return enqueueWrite(configPath, async () => {
    const doc = (await loadConfigDocument(configPath)) ?? new Document({});
    const existing = doc.get("modelRoles", true);
    const rolesMap = isMap(existing) ? existing : null;
    if (rolesMap === null && existing != null && !(isScalar(existing) && existing.value == null)) {
      throw new ProviderModelRoleError({
        code: "invalid",
        message: `'modelRoles' in '${configPath}' is not a mapping.`,
      });
    }

    if (model === null) {
      if (rolesMap === null || !rolesMap.has(role)) {
        return { roles: rolesFromDocument(doc), configPath };
      }
      rolesMap.delete(role);
    } else {
      if (rolesMap === null) doc.set("modelRoles", doc.createNode({}));
      const previous = rolesMap?.get(role);
      const fallbacks =
        typeof previous === "string"
          ? previous
              .split(",")
              .slice(1)
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : [];
      const primary = thinkingLevel ? `${model}:${thinkingLevel}` : model;
      doc.setIn(["modelRoles", role], [primary, ...fallbacks].join(", "));
    }
    await writeDocumentAtomically(configPath, doc);
    return { roles: rolesFromDocument(doc), configPath };
  });
}

/**
 * OMP's model usage history (`<agentDir>/agent.db`, table `model_usage`),
 * most recent first. Read-only; never rejects: a missing or locked db is `[]`.
 */
export async function readRecentModels(
  agentDir: string,
  limit = 24,
): Promise<ReadonlyArray<ProviderModelUsage>> {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(NodePath.join(agentDir, "agent.db"), { readOnly: true });
    const rows = db
      .prepare("SELECT model_key, last_used_at FROM model_usage ORDER BY last_used_at DESC LIMIT ?")
      .all(limit);
    return rows.flatMap((row) => {
      const model = typeof row.model_key === "string" ? row.model_key.trim() : "";
      const seconds = Number(row.last_used_at);
      return model.length > 0 && Number.isFinite(seconds)
        ? [{ model, usedAt: DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)) }]
        : [];
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
