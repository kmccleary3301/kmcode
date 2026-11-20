import { describe, expect, it } from "@effect/vitest";

import { antigravityCliTarget, parseAntigravityCliRelease } from "./antigravityCliRelease.ts";

interface ManifestFixture {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
}

interface TargetFixture {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly musl: boolean;
  readonly target: string;
  readonly file: string;
}

const manifest: ManifestFixture = {
  version: "1.5.7",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/darwin-arm/cli_mac_arm64.tar.gz",
  sha512: "a".repeat(128),
};

const targets: ReadonlyArray<TargetFixture> = [
  {
    platform: "darwin",
    arch: "arm64",
    musl: false,
    target: "darwin_arm64",
    file: "darwin-arm/cli_mac_arm64.tar.gz",
  },
  {
    platform: "darwin",
    arch: "x64",
    musl: false,
    target: "darwin_amd64",
    file: "darwin-x64/cli_mac_x64.tar.gz",
  },
  {
    platform: "linux",
    arch: "arm64",
    musl: false,
    target: "linux_arm64",
    file: "linux-arm/cli_linux_arm64.tar.gz",
  },
  {
    platform: "linux",
    arch: "x64",
    musl: false,
    target: "linux_amd64",
    file: "linux-x64/cli_linux_x64.tar.gz",
  },
  {
    platform: "linux",
    arch: "arm64",
    musl: true,
    target: "linux_arm64_musl",
    file: "linux-arm-musl/cli_linux_arm64_musl.tar.gz",
  },
  {
    platform: "linux",
    arch: "x64",
    musl: true,
    target: "linux_amd64_musl",
    file: "linux-x64-musl/cli_linux_x64_musl.tar.gz",
  },
  {
    platform: "win32",
    arch: "arm64",
    musl: false,
    target: "windows_arm64",
    file: "windows-arm/cli_windows_arm64.exe",
  },
  {
    platform: "win32",
    arch: "x64",
    musl: false,
    target: "windows_amd64",
    file: "windows-x64/cli_windows_x64.exe",
  },
];

describe("Antigravity CLI release manifests", () => {
  it.each(targets)("selects Google's $platform-$arch release", (fixture) => {
    expect(antigravityCliTarget(fixture.platform, fixture.arch, fixture.musl)).toBe(fixture.target);
    expect(
      parseAntigravityCliRelease(
        {
          ...manifest,
          url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/${fixture.file}`,
        },
        fixture.platform,
        fixture.arch,
        fixture.musl,
      ),
    ).toMatchObject({
      version: "1.5.7",
      format: fixture.platform === "win32" ? "executable" : "tar.gz",
      executable: { name: fixture.platform === "win32" ? "agy.exe" : "antigravity" },
    });
  });

  it("accepts the 1.5.0 minimum and normalizes SHA-512 casing", () => {
    const minimum = {
      ...manifest,
      version: "1.5.0",
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-123/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "A".repeat(128),
    };

    expect(parseAntigravityCliRelease(minimum, "darwin", "arm64")).toMatchObject({
      version: "1.5.0",
      sha512: "a".repeat(128),
    });
  });

  it.each([
    {
      name: "invalid checksum",
      value: { ...manifest, sha512: "invalid" },
    },
    {
      name: "version below the minimum",
      value: {
        ...manifest,
        version: "1.4.9",
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.9-123/darwin-arm/cli_mac_arm64.tar.gz",
      },
    },
    {
      name: "non-HTTPS download",
      value: { ...manifest, url: manifest.url.replace("https:", "http:") },
    },
    {
      name: "host suffix attack",
      value: {
        ...manifest,
        url: manifest.url.replace("storage.googleapis.com", "storage.googleapis.com.evil.test"),
      },
    },
    {
      name: "unexpected bucket",
      value: { ...manifest, url: manifest.url.replace("antigravity-public", "another-bucket") },
    },
    {
      name: "wrong platform asset",
      value: { ...manifest, url: manifest.url.replace("darwin-arm", "linux-arm") },
    },
    { name: "query string", value: { ...manifest, url: `${manifest.url}?redirect=elsewhere` } },
    {
      name: "version mismatch",
      value: { ...manifest, url: manifest.url.replace("1.5.7-123", "1.5.6-123") },
    },
  ])("rejects $name metadata", ({ value }) => {
    expect(parseAntigravityCliRelease(value, "darwin", "arm64")).toBeNull();
  });

  it("rejects unsupported platforms and architectures", () => {
    expect(antigravityCliTarget("freebsd", "x64")).toBeNull();
    expect(antigravityCliTarget("linux", "ia32")).toBeNull();
    expect(parseAntigravityCliRelease(manifest, "freebsd", "x64")).toBeNull();
  });
});
