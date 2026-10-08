import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

import {
  NormalizedAppearanceProfileSchema,
  STRICT_APPEARANCE_PARSE_OPTIONS,
  type NormalizedAppearanceProfile,
} from "./schema.ts";
const decodeNormalizedAppearanceProfile = Schema.decodeUnknownSync(
  NormalizedAppearanceProfileSchema,
);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalString(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical appearance JSON rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical appearance JSON rejects values of type '${typeof value}'.`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical appearance JSON rejects cyclic values.");
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new TypeError(
        "Canonical appearance JSON rejects sparse arrays and arrays with named properties.",
      );
    }
    return `[${value.map((entry) => canonicalString(entry, nextAncestors)).join(",")}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Canonical appearance JSON accepts only plain objects and arrays.");
  }
  const fields = Object.keys(value)
    .sort(compareCodeUnits)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalString(
          (value as Readonly<Record<string, unknown>>)[key],
          nextAncestors,
        )}`,
    );
  return `{${fields.join(",")}}`;
}

export function canonicalAppearanceJson(value: unknown): string {
  return canonicalString(value, new Set());
}

export function appearanceSha256(value: unknown): string {
  return Hex.encode(sha256(new TextEncoder().encode(canonicalAppearanceJson(value))));
}
export function appearanceBytesSha256(bytes: Uint8Array): string {
  return Hex.encode(sha256(bytes));
}

export function hashNormalizedAppearanceProfile(profile: NormalizedAppearanceProfile): string {
  const decoded = decodeNormalizedAppearanceProfile(profile, STRICT_APPEARANCE_PARSE_OPTIONS);
  return appearanceSha256(decoded);
}
