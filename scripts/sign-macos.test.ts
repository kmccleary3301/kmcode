import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

it("batches codesign calls without changing existing signing options", async () => {
  const options = {
    app: "/tmp/T3 Code.app",
    identity: "Developer ID Application: T3 Tools, Inc.",
    keychain: "/tmp/t3code.keychain",
    provisioningProfile: "/tmp/t3code.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/t3code.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
  });
});

it("signs ad hoc builds with the local identity, never over a release identity", async () => {
  vi.stubEnv("T3CODE_DESKTOP_MAC_LOCAL_SIGN_IDENTITY", "Apple Development: KM (TEAM123456)");
  try {
    await sign({ app: "/tmp/KM Code.app", identity: "-" });
    expect(signApplication).toHaveBeenLastCalledWith({
      app: "/tmp/KM Code.app",
      identity: "Apple Development: KM (TEAM123456)",
      batchCodesignCalls: true,
    });

    const release = { app: "/tmp/KM Code.app", identity: "Developer ID Application: KM" };
    await sign(release);
    expect(signApplication).toHaveBeenLastCalledWith({ ...release, batchCodesignCalls: true });
  } finally {
    vi.unstubAllEnvs();
  }
});
