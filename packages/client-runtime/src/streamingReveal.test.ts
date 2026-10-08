import { describe, expect, it } from "vite-plus/test";

import {
  createStreamingRevealController,
  revealGraphemeCatchUp,
  revealGraphemePrefix,
} from "./streamingReveal.ts";

describe("streaming reveal", () => {
  it("reveals Unicode graphemes without splitting an emoji or combining mark", () => {
    const text = "A👩‍💻e\u0301";

    expect(revealGraphemePrefix(text, 1)).toBe("A");
    expect(revealGraphemePrefix(text, 2)).toBe("A👩‍💻");
    expect(revealGraphemePrefix(text, 3)).toBe(text);
  });

  it("catches up at a bounded grapheme rate", () => {
    expect(revealGraphemeCatchUp(0)).toBe(3);
    expect(revealGraphemeCatchUp(24)).toBe(3);
    expect(revealGraphemeCatchUp(25)).toBe(4);
  });

  it("reconciles authoritative replacements instead of appending deltas", () => {
    const controller = createStreamingRevealController();

    controller.updateTarget("alpha");
    expect(controller.tick()).toEqual({ text: "alp", complete: false });

    expect(controller.updateTarget("alX")).toEqual({ text: "al", complete: false });
    expect(controller.tick()).toEqual({ text: "alX", complete: true });
  });

  it("resets cleanly between identities and ignores a cancelled tick", () => {
    const controller = createStreamingRevealController();

    controller.updateTarget("first response");
    controller.tick();
    controller.cancel();
    expect(controller.tick().text).toBe("fir");

    controller.reset();
    expect(controller.updateTarget("second response")).toEqual({ text: "", complete: false });
    expect(controller.complete()).toEqual({ text: "second response", complete: true });
  });

  it("reconciles a same-length authoritative replacement at completion", () => {
    const controller = createStreamingRevealController();
    controller.complete("old");
    expect(controller.complete("new")).toEqual({ text: "new", complete: true });
  });

  it("resegments a trailing grapheme when its combining sequence grows", () => {
    const controller = createStreamingRevealController();
    controller.complete("A👩");
    expect(controller.updateTarget("A👩‍💻")).toEqual({ text: "A", complete: false });
    expect(controller.tick().text).toBe("A👩‍💻");
    controller.complete("e");
    expect(controller.updateTarget("e\u0301").text).toBe("");
    expect(controller.tick().text).toBe("e\u0301");
  });

  it("keeps flags, skin tones, and CRLF whole without Intl.Segmenter", () => {
    const text = "🇺🇸🇫🇷👍🏽\r\nx";

    expect(revealGraphemePrefix(text, 1)).toBe("🇺🇸");
    expect(revealGraphemePrefix(text, 2)).toBe("🇺🇸🇫🇷");
    expect(revealGraphemePrefix(text, 3)).toBe("🇺🇸🇫🇷👍🏽");
    expect(revealGraphemePrefix(text, 4)).toBe("🇺🇸🇫🇷👍🏽\r\n");
    expect(revealGraphemePrefix(text, 5)).toBe(text);
  });
});
