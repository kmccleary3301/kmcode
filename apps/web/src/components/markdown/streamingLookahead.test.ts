import { prepareInlineStreamingLookahead } from "@stream-mdx/core";
import { describe, expect, it } from "vite-plus/test";

// While a block streams, stream-mdx scans its tail for unclosed formatting and,
// with anticipation off (KM's setting), shows unclosed content as raw text.
// The scan must treat math and code spans as opaque: a `*` in `$a^*$` or in
// `` `a*b` `` closes nothing, and counting it left finished list items raw.
function prepared(content: string) {
  return prepareInlineStreamingLookahead(content, { math: true, context: { provisional: true } })
    .prepared.kind;
}

describe("streaming inline lookahead", () => {
  it.each([
    "**Degenerate Reduction**: If removing the sketch $P_b(a^*)$ leaves performance within $1\\text{pp}$ of a teacher.",
    "**State-Occupancy Mismatch ($\\rho_{\\pi^*} \\neq \\rho_b$):** histories come from $\\rho_{\\pi^*}$.",
    "Partition all turns $(h_t, a^*_t)$ into **Entailed Turns**.",
    "Display $$x^* = \\arg\\max_x f(x)$$ then **bold**.",
    "Run `glob **/*.ts` and keep **bold**.",
    "Costs $5 and $10 with **bold**.",
    "Escaped dollar $a \\$ b^*$ then *em*.",
  ])("parses finished content with delimiters inside math or code: %s", (content) => {
    expect(prepared(content)).toBe("parse");
  });

  it.each([
    "**Degenerate Reduction",
    "The sketch $P_b(a^*",
    "Run `glob **/*.ts",
    "Display $$x^* = ",
  ])("keeps unfinished formatting raw: %s", (content) => {
    expect(prepared(content)).toBe("raw");
  });
});
