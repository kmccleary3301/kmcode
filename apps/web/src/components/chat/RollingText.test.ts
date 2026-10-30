import { describe, expect, it } from "vite-plus/test";

import { splitRoll } from "./RollingText";

describe("splitRoll", () => {
  it("rolls the whole changed word, not the changed letters", () => {
    expect(splitRoll("Reading src/app.ts", "Read src/app.ts")).toEqual({
      prefix: "",
      from: "Reading",
      to: "Read",
      suffix: " src/app.ts",
      numeric: false,
    });
  });

  it("spins a whole number when it gains a digit", () => {
    expect(splitRoll("Working for 9s", "Working for 10s")).toEqual({
      prefix: "Working for ",
      from: "9",
      to: "10",
      suffix: "s",
      numeric: true,
    });
  });

  it("spins only the number between unchanged words", () => {
    expect(splitRoll("Exploring 2 files", "Exploring 3 files")).toEqual({
      prefix: "Exploring ",
      from: "2",
      to: "3",
      suffix: " files",
      numeric: true,
    });
  });

  it("rolls words when a number changes alongside them", () => {
    expect(splitRoll("Explored 2 files", "Exploring 3 files")).toEqual({
      prefix: "",
      from: "Explored 2",
      to: "Exploring 3",
      suffix: " files",
      numeric: false,
    });
  });

  it("rolls in only the appended text when the change starts at punctuation", () => {
    expect(splitRoll("Explored 4 files", "Explored 4 files, 1 search")).toEqual({
      prefix: "Explored 4 files",
      from: "",
      to: ", 1 search",
      suffix: "",
      numeric: false,
    });
  });
});
