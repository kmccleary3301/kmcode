import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("exposes Pi-family metadata through the generic settings form", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")];
    const omp = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("omp")];

    expect(pi).toMatchObject({ label: "Pi" });
    expect(omp).toMatchObject({ label: "Oh My Pi" });
    expect(deriveProviderSettingsFields(pi!).map((field) => field.key)).toEqual([
      "binaryPath",
      "workingDirectory",
      "agentDirectory",
      "environment",
      "launchArguments",
      "trustMode",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("derives a select control with its choices for the Antigravity sign-in method", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("antigravity")];
    expect(antigravity).toBeDefined();

    const fields = deriveProviderSettingsFields(antigravity!);
    expect(fields.map((field) => field.key)).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    const authMethod = fields.find((field) => field.key === "authMethod");
    expect(authMethod).toMatchObject({ control: "select", clearWhenEmpty: "omit" });
    expect(authMethod?.options?.map((option) => option.value)).toEqual([
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ]);
    expect(fields.find((field) => field.key === "apiKey")?.control).toBe("password");
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "launchArgs",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("round-trips Pi-family structured values without flattening them", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")];
    expect(pi).toBeDefined();
    const fields = deriveProviderSettingsFields(pi!);
    const environment = fields.find((field) => field.key === "environment");
    const launchArguments = fields.find((field) => field.key === "launchArguments");
    expect(environment?.valueFormat).toBe("json");
    expect(launchArguments?.valueFormat).toBe("json");

    const current = {
      opaqueForkSetting: { keep: true },
      environment: { PI_PROFILE: "work", EMPTY: "" },
      launchArguments: ["--model", "reasoning", "--flag=value"],
    };
    expect(readProviderConfigString(current, "environment", environment?.valueFormat)).toContain(
      '"PI_PROFILE": "work"',
    );
    expect(
      nextProviderConfigWithFieldValue(
        current,
        environment!,
        '{ "PI_PROFILE": "personal", "EMPTY": "" }',
      ),
    ).toEqual({
      opaqueForkSetting: { keep: true },
      environment: { PI_PROFILE: "personal", EMPTY: "" },
      launchArguments: ["--model", "reasoning", "--flag=value"],
    });
    expect(
      nextProviderConfigWithFieldValue(current, launchArguments!, '[ "--model", "fast" ]'),
    ).toEqual({
      opaqueForkSetting: { keep: true },
      environment: { PI_PROFILE: "work", EMPTY: "" },
      launchArguments: ["--model", "fast"],
    });
  });

  it("keeps the last valid structured value while JSON is incomplete", () => {
    const field = {
      key: "launchArguments",
      control: "textarea" as const,
      label: "Launch arguments",
      clearWhenEmpty: "omit" as const,
      valueFormat: "json" as const,
    };
    const current = { launchArguments: ["--model", "reasoning"], opaque: "keep" };
    expect(nextProviderConfigWithFieldValue(current, field, '[ "--model",')).toEqual(current);
  });
});
