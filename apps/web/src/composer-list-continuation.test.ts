import { describe, expect, it } from "vite-plus/test";

import {
  listContinuationForEnter,
  listIndentForTab,
  nextOrderedMarkerText,
} from "./composer-list-continuation";

function applyEdit(value: string, edit: { start: number; end: number; replacement: string }) {
  return value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
}

describe("composer list continuation", () => {
  it("continues ordered lists with the next number", () => {
    const value = "1. foo";
    const edit = listContinuationForEnter(value, value.length);
    expect(edit).not.toBeNull();
    expect(applyEdit(value, edit!)).toBe("1. foo\n2. ");
  });

  it("increments multi-digit and paren markers", () => {
    expect(applyEdit("12. foo", listContinuationForEnter("12. foo", 7)!)).toBe("12. foo\n13. ");
    expect(applyEdit("3) foo", listContinuationForEnter("3) foo", 6)!)).toBe("3) foo\n4) ");
  });

  it("continues bullets and keeps indentation", () => {
    expect(applyEdit("- foo", listContinuationForEnter("- foo", 5)!)).toBe("- foo\n- ");
    expect(applyEdit("  * foo", listContinuationForEnter("  * foo", 7)!)).toBe("  * foo\n  * ");
  });

  it("continues tasks unchecked", () => {
    expect(applyEdit("- [x] done", listContinuationForEnter("- [x] done", 10)!)).toBe(
      "- [x] done\n- [ ] ",
    );
  });

  it("splits mid-line items", () => {
    expect(applyEdit("1. foobar", listContinuationForEnter("1. foobar", 5)!)).toBe(
      "1. fo\n2. obar",
    );
  });

  it("exits the list on an empty item", () => {
    expect(applyEdit("1. foo\n2. ", listContinuationForEnter("1. foo\n2. ", 10)!)).toBe("1. foo\n");
    expect(applyEdit("- ", listContinuationForEnter("- ", 2)!)).toBe("");
  });

  it("lifts an empty nested item one level at a time, then exits", () => {
    const nested = "1. parent\n   1. child\n      1. ";
    const first = applyEdit(nested, listContinuationForEnter(nested, nested.length)!);
    expect(first).toBe("1. parent\n   1. child\n   2. ");

    const second = applyEdit(first, listContinuationForEnter(first, first.length)!);
    expect(second).toBe("1. parent\n   1. child\n2. ");
    expect(applyEdit(second, listContinuationForEnter(second, second.length)!)).toBe(
      "1. parent\n   1. child\n",
    );
  });

  it("renumbers following ordered siblings after lifting an empty nested item", () => {
    const value = "1. first\n2. parent\n  1. child\n  2. \n3. next\n4. last";
    const cursor = value.indexOf("\n3. next");
    const edit = listContinuationForEnter(value, cursor)!;
    expect(applyEdit(value, edit)).toBe("1. first\n2. parent\n  1. child\n3. \n4. next\n5. last");
    expect(edit.cursorAfter).toBe("1. first\n2. parent\n  1. child\n3. ".length);
  });

  it("ignores non-list lines and carets inside the marker", () => {
    expect(listContinuationForEnter("plain text", 5)).toBeNull();
    expect(listContinuationForEnter("1.foo no space", 3)).toBeNull();
    expect(listContinuationForEnter("-foo", 2)).toBeNull();
    expect(listContinuationForEnter("1. foo", 1)).toBeNull();
  });

  it("refuses to split a supplementary currency skill chip", () => {
    const value = "1. 𑿝review go";
    const cursor = value.indexOf(" go") - 1;
    expect(listContinuationForEnter(value, cursor)).toBeNull();
  });

  it("refuses to split an inline chip", () => {
    const value = "1. @README.md go";
    const cursor = value.indexOf("README") + 2;
    expect(listContinuationForEnter(value, cursor)).toBeNull();
  });

  it("indents list items on Tab", () => {
    expect(applyEdit("- foo", listIndentForTab("- foo", 2, 2)!)).toBe("  - foo");
    expect(listIndentForTab("plain", 2, 2)).toBeNull();
    expect(listIndentForTab("- foo", 1, 3)).toBeNull();
  });

  it.each([
    ["1. parent\n2. child", "1. parent\n   1. child"],
    ["10. parent\n11. child", "10. parent\n    1. child"],
    ["1.\tparent\n2. child", "1.\tparent\n    1. child"],
    ['1. @"file\n   9. name"\n2. child', '1. @"file\n   9. name"\n   1. child'],
  ])("nests %j as a first child and keeps the caret on its text", (value, expected) => {
    const cursor = value.lastIndexOf("child") + 2;
    const edit = listIndentForTab(value, cursor, cursor)!;
    expect(applyEdit(value, edit)).toBe(expected);
    expect(edit.cursorAfter).toBe(expected.lastIndexOf("child") + 2);
  });

  it("continues numbering an existing nested sibling", () => {
    const value = "1. parent\n   1. first\n2. second";
    const edit = listIndentForTab(value, value.length, value.length)!;
    expect(applyEdit(value, edit)).toBe("1. parent\n   1. first\n   2. second");
  });
});

describe("nextOrderedMarkerText", () => {
  it.each([
    ["1.", "2."],
    ["1)", "2)"],
    ["09.", "10."],
    ["001)", "002)"],
    ["99.", "100."],
    ["99999999999999999999.", "99999999999999999999."],
  ])("counts %s up to %s", (marker, expected) => {
    expect(nextOrderedMarkerText(marker)).toBe(expected);
  });
});
