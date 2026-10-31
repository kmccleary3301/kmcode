import { expect, it } from "vite-plus/test";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerContextReferences.ts";
import {
  countThreadFindOccurrences,
  findThreadFindOccurrences,
  searchableMessageSegments,
  searchablePlanSegments,
  splitThreadFindText,
} from "./threadFindText.ts";

it("excludes review attachment placeholders rendered as context chips", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Before review",
    " After review",
  ]);
});

it("keeps malformed attachment placeholders visible like the renderer", () => {
  const text = "<review_comment>not a valid attachment</review_comment>";
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([text]);
});

it("excludes structured context chips without joining text across them", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: "before[hidden label](t3-context://v1/terminal/terminal_1)after",
      context: { version: 1, records: [] },
    }),
  ).toEqual(["before", "after"]);
});

it("searches displayed Markdown text rather than formatting or hidden link targets", () => {
  expect(
    searchableMessageSegments({
      role: "assistant",
      streaming: false,
      text: "Check **the build** at [docs](https://hidden.example/needle)",
    }),
  ).toEqual(["Check the build at docs"]);
});

it("includes the displayed title and body of a proposed plan", () => {
  expect(searchablePlanSegments("# Ship it\n\nReview **the change**")).toEqual([
    "Ship it",
    "Review the change",
  ]);
});
it("counts non-overlapping case-folded matches for navigation and highlighting", () => {
  expect(countThreadFindOccurrences("Σς", "σ")).toBe(2);
  expect(findThreadFindOccurrences("one NEEDLE, needle", "needle")).toEqual([4, 12]);
  expect(splitThreadFindText("one NEEDLE", " needle ")).toEqual([
    { text: "one ", highlighted: false, start: 0 },
    { text: "NEEDLE", highlighted: true, start: 4 },
  ]);
});
it("excludes attachment-only bootstrap prompts from searchable text", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      streaming: false,
    }),
  ).toEqual([]);
});
