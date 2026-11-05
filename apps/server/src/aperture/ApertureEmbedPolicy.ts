import type { ApertureFetchErrorCode, ApertureFetchInput } from "@t3tools/contracts";
import {
  isApertureEmbedRecord,
  type ApertureEmbedTokenPayload,
} from "@t3tools/shared/apertureEmbed";

const API_ORIGIN = "https://aperture.invalid";
const READ_ONLY_RUN_SUBRESOURCES: Readonly<Record<string, true>> = {
  console: true,
  history: true,
  "history.csv": true,
  keys: true,
  system: true,
};

const PINNED_AS_OF_QUERY_KINDS: ReadonlySet<string> = new Set([
  "history",
  "system",
  "band",
  "scan",
  "console",
  "stream",
]);

export type ApertureEmbedPolicyDecision =
  | {
      readonly allowed: true;
      readonly path: string;
      readonly body: string | null;
    }
  | {
      readonly allowed: false;
      readonly code: ApertureFetchErrorCode;
      readonly message: string;
    };

interface AperturePolicyInput {
  readonly request: Pick<ApertureFetchInput, "method" | "mode" | "path" | "body">;
  readonly token: ApertureEmbedTokenPayload;
}

const denied = (
  message: string,
  code: ApertureFetchErrorCode = "policy_denied",
): ApertureEmbedPolicyDecision => ({ allowed: false, code, message });

const projectPath = (token: ApertureEmbedTokenPayload) => `${token.entity}/${token.project}`;

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\") ? decoded : null;
  } catch {
    return null;
  }
}

function runScopeMatches(value: unknown, token: ApertureEmbedTokenPayload): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  if (parts.length !== 3) return false;
  const runId = parts[2];
  return (
    parts[0] === token.entity &&
    parts[1] === token.project &&
    runId !== undefined &&
    runId.length > 0
  );
}

function queryRunIdsMatch(
  query: Record<string, unknown>,
  token: ApertureEmbedTokenPayload,
): boolean {
  const selector = query.runs;
  if (!isApertureEmbedRecord(selector) || !Array.isArray(selector.ids)) return true;
  const ids: ReadonlyArray<unknown> = selector.ids;
  return ids.every(
    (runId) => typeof runId === "string" && (!runId.includes("/") || runScopeMatches(runId, token)),
  );
}

function queryBodyMatches(
  input: AperturePolicyInput,
  body: unknown,
): body is Record<string, unknown> {
  return (
    isApertureEmbedRecord(body) &&
    body.project === projectPath(input.token) &&
    queryRunIdsMatch(body, input.token)
  );
}

function liveBodyMatches(body: unknown, token: ApertureEmbedTokenPayload): boolean {
  if (!isApertureEmbedRecord(body) || !Array.isArray(body.subscriptions)) return false;
  const subscriptions: ReadonlyArray<unknown> = body.subscriptions;
  return subscriptions.every((entry) => {
    if (!isApertureEmbedRecord(entry)) return false;
    switch (entry.topic) {
      case "run.history":
      case "run.system":
      case "run.console":
      case "run.state":
        return runScopeMatches(entry.run, token);
      case "project.runs":
        return entry.project === projectPath(token);
      case "stream": {
        let hasProjectScope = false;
        if (entry.project !== undefined) {
          if (entry.project !== projectPath(token)) return false;
          hasProjectScope = true;
        }
        if (entry.runs !== undefined) {
          if (!Array.isArray(entry.runs)) return false;
          const runs: ReadonlyArray<unknown> = entry.runs;
          if (!runs.every((run) => runScopeMatches(run, token))) {
            return false;
          }
          hasProjectScope = true;
        }
        return hasProjectScope;
      }
      default:
        return false;
    }
  });
}

function decodeRequestPath(path: string): URL | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  try {
    const url = new URL(path, API_ORIGIN);
    return url.origin === API_ORIGIN && url.hash.length === 0 ? url : null;
  } catch {
    return null;
  }
}

function allowedReadPath(
  method: ApertureFetchInput["method"],
  url: URL,
  token: ApertureEmbedTokenPayload,
): "viewer" | "entity" | "projects" | "project" | "runs" | "run" | "keys" | "history" | null {
  if (method !== "GET") return null;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length === 3 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "viewer") {
    return "viewer";
  }
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "entities") return null;

  if (parts.length === 4) {
    const entity = decodePathSegment(parts[3] ?? "");
    return entity === token.entity ? "entity" : null;
  }
  if (parts.length === 5 && parts[4] === "projects") {
    const entity = decodePathSegment(parts[3] ?? "");
    return entity === token.entity ? "projects" : null;
  }
  if (parts.length < 6 || parts[4] !== "projects") return null;

  const entity = decodePathSegment(parts[3] ?? "");
  const project = decodePathSegment(parts[5] ?? "");
  if (entity !== token.entity || project !== token.project) return null;
  if (parts.length === 6) return "project";
  if (parts[6] !== "runs") return null;
  if (parts.length === 7) return "runs";
  if (decodePathSegment(parts[7] ?? "") === null) return null;
  if (parts.length === 8) return "run";
  if (parts.length === 9 && parts[8] === "keys") return "keys";
  if (parts.length === 9 && READ_ONLY_RUN_SUBRESOURCES[parts[8] ?? ""] === true) {
    return "history";
  }
  if (parts.length === 10 && parts[8] === "history" && parts[9] === "scan") {
    return "history";
  }
  return null;
}

export type AperturePinnedQueryClamp =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: ApertureFetchErrorCode; readonly message: string };

function clampPinnedRunsQuery(
  query: Record<string, unknown>,
  asOfMillis: number,
): AperturePinnedQueryClamp {
  const existingFilter = query.filter;
  if (existingFilter !== undefined && !isApertureEmbedRecord(existingFilter)) {
    return { ok: false, code: "policy_denied", message: "Aperture run filter must be an object." };
  }
  const createdBeforeFilter = { created_at: { $lte: asOfMillis } };
  const filter =
    existingFilter === undefined
      ? createdBeforeFilter
      : { $and: [existingFilter, createdBeforeFilter] };
  return { ok: true, body: JSON.stringify({ ...query, filter }) };
}

export function clampPinnedApertureQuery(body: string, asOf: string): AperturePinnedQueryClamp {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, code: "policy_denied", message: "Aperture query body must be JSON." };
  }
  if (!isApertureEmbedRecord(parsed)) {
    return { ok: false, code: "policy_denied", message: "Aperture query body must be an object." };
  }
  const kind = parsed.kind;
  if (kind === "keys") return { ok: true, body };
  const asOfMillis = Date.parse(asOf);
  if (!Number.isFinite(asOfMillis)) {
    return { ok: false, code: "invalid_ref", message: "Pinned embed asOf timestamp is invalid." };
  }
  if (kind === "runs") return clampPinnedRunsQuery(parsed, asOfMillis);
  if (typeof kind !== "string" || !PINNED_AS_OF_QUERY_KINDS.has(kind)) {
    return {
      ok: false,
      code: "policy_denied",
      message: "Pinned embeds only allow Aperture query kinds that support as_of.",
    };
  }

  const asOfSeconds = asOfMillis / 1000;
  const clientAsOf = parsed.as_of;
  if (
    clientAsOf !== undefined &&
    (typeof clientAsOf !== "number" || !Number.isFinite(clientAsOf))
  ) {
    return { ok: false, code: "policy_denied", message: "Aperture as_of must be a finite number." };
  }
  return {
    ok: true,
    body: JSON.stringify({
      ...parsed,
      as_of: typeof clientAsOf === "number" ? Math.min(clientAsOf, asOfSeconds) : asOfSeconds,
    }),
  };
}

export function authorizeApertureEmbedRequest(
  input: AperturePolicyInput,
): ApertureEmbedPolicyDecision {
  const url = decodeRequestPath(input.request.path);
  if (url === null) return denied("Aperture request path is invalid.");

  if (
    input.request.method === "POST" &&
    url.pathname === "/api/v1/live" &&
    input.request.mode === "pinned"
  ) {
    return denied("Pinned Aperture embeds cannot open a live stream.", "pinned_live_denied");
  }

  if (input.request.method === "POST" && url.pathname === "/api/v1/query") {
    if (input.request.body === null) return denied("Aperture query body is required.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.request.body);
    } catch {
      return denied("Aperture query body must be JSON.");
    }
    if (!queryBodyMatches(input, parsed)) {
      return denied("Aperture query is outside the embed's project scope.");
    }
    if (input.request.mode === "pinned") {
      const clamp = clampPinnedApertureQuery(input.request.body, input.token.asOf);
      if (!clamp.ok) return denied(clamp.message, clamp.code);
      return { allowed: true, path: input.request.path, body: clamp.body };
    }
    return { allowed: true, path: input.request.path, body: input.request.body };
  }

  if (input.request.method === "POST" && url.pathname === "/api/v1/live") {
    let parsed: unknown;
    try {
      parsed = input.request.body === null ? null : JSON.parse(input.request.body);
    } catch {
      return denied("Aperture live subscription body must be JSON.");
    }
    if (input.request.mode !== "live" || !liveBodyMatches(parsed, input.token)) {
      return denied("Aperture live subscription is outside the embed's project scope.");
    }
    return { allowed: true, path: input.request.path, body: input.request.body };
  }

  const pathKind = allowedReadPath(input.request.method, url, input.token);
  if (pathKind === null) return denied("Aperture method and path are not allowlisted.");
  if (input.request.mode === "pinned" && (pathKind === "history" || pathKind === "runs")) {
    return denied(
      "Pinned embeds must use /api/v1/query so Aperture can apply the native as_of bound.",
    );
  }
  if (input.request.mode === "pinned" && pathKind === "run") {
    return denied("Pinned embeds must use /api/v1/query so run creation time is bounded.");
  }
  if (input.request.body !== null) return denied("Aperture GET requests cannot include a body.");
  return { allowed: true, path: input.request.path, body: null };
}
