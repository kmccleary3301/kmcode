import { describe, expect, it } from "vite-plus/test";

import { parseToolDeviceArguments, parseToolDeviceName } from "./toolDevice.ts";

describe("OMP tool devices", () => {
  it("recognizes one tool name and parses its JSON arguments", () => {
    expect(parseToolDeviceName("xd://mcp__t3-code__delegate_task")).toBe(
      "mcp__t3-code__delegate_task",
    );
    expect(parseToolDeviceArguments('{"task":"Run checks"}')).toEqual({ task: "Run checks" });
    expect(parseToolDeviceArguments(undefined)).toEqual({});
  });

  it("leaves non-device paths and partial argument text unchanged", () => {
    expect(parseToolDeviceName("xd://mcp__t3-code__delegate_task/usage")).toBeUndefined();
    expect(parseToolDeviceName("src/index.ts")).toBeUndefined();
    expect(parseToolDeviceArguments('{"task":')).toBe('{"task":');
  });
});
