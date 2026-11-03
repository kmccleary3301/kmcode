import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { OmpIcon, PiIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider identity for Pi-family drivers", () => {
  it("maps Pi and OMP to their own canonical icons", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("pi")]).toBe(PiIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("omp")]).toBe(OmpIcon);
  });

  it("keeps the Pi and OMP icons distinct from each other and every other provider", () => {
    const icons = Object.values(PROVIDER_ICON_BY_PROVIDER);
    const distinct = new Set(icons);
    expect(distinct.size).toBe(icons.length);
    expect(PiIcon).not.toBe(OmpIcon);
  });
});
