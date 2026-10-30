import { describe, expect, it } from "vite-plus/test";

import { formatLoopbackUrl, parsePortNumber } from "./PortsView";

describe("port input", () => {
  it.each(["1", "1455", " 8080 ", "65535"])("accepts TCP port %s", (input) => {
    expect(parsePortNumber(input)).toBe(Number(input));
  });

  it.each(["", " ", "0", "-1", "65536", "1.5", "3000.0", "1455abc", "0x12"])(
    "rejects invalid TCP port %s without truncating it",
    (input) => {
      expect(parsePortNumber(input)).toBeNull();
    },
  );
});

describe("loopback preview URL formatting", () => {
  it("brackets IPv6 loopback ::1", () => {
    expect(formatLoopbackUrl("::1", 3000)).toBe("http://[::1]:3000");
  });

  it("preserves IPv4 loopback 127.0.0.1", () => {
    expect(formatLoopbackUrl("127.0.0.1", 5173)).toBe("http://127.0.0.1:5173");
  });

  it("preserves localhost", () => {
    expect(formatLoopbackUrl("localhost", 4173)).toBe("http://localhost:4173");
  });
});
