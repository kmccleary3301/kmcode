import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("mounts browser appearance recovery before the router and auth gate", () => {
    vi.stubGlobal("window", {
      location: {
        search: "?t3-appearance=safe",
        href: "https://example.test/?t3-appearance=safe",
      },
    });
    const root = AppRoot({ router: {} as AppRouter }) as ReactElement<{
      readonly action: string;
    }>;
    expect(root.props.action).toBe("safe");
    vi.unstubAllGlobals();
  });
});
