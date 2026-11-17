// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// util-linux's script gives the real installer a terminal without a browser or extra packages.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed T3 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed T3 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "uname",
            "tar",
            "gzip",
            "cut",
            "curl",
            "grep",
            "mkdir",
            "mktemp",
            "rm",
            "mv",
            "ln",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            "#!/bin/sh\necho 't3 v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          server.on("request", (request, response) => {
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    PATH: tools,
                    T3CODE_VERSION: version,
                    T3CODE_HOME: home,
                    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed T3 Code");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

// regression: #38234
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("concurrent installers", () => {
  it("publishes one runtime without nesting the other install's staging directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-concurrent-"));
    const version = "1.2.3";
    const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    const target = NodePath.join(root, "home/runtime/versions", version);
    const waiting = new Map<string, NodeHttp.ServerResponse>();
    const server = NodeHttp.createServer();
    try {
      const tools = NodePath.join(root, "tools");
      await NodeFSP.mkdir(tools);
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const archivePath = NodePath.join(root, archiveName);
      NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
      const archive = await NodeFSP.readFile(archivePath);
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      server.on("request", (request, response) => {
        if (request.url?.startsWith("/ready/")) {
          waiting.set(request.url.slice(7), response);
          if (waiting.size === 2) waiting.get("first")!.end("go");
        } else if (request.url === "/published") {
          waiting.get("second")!.end("go");
          response.end("ok");
        } else {
          response.end(
            request.url?.endsWith("/SHA256SUMS") ? `${digest}  ${archiveName}\n` : archive,
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const realMv = NodeChildProcess.execFileSync("sh", ["-c", "command -v mv"], {
        encoding: "utf8",
      }).trim();
      // Hold publication until both installers have removed the destination, then let them rename in order.
      const wrapper = NodePath.join(tools, "mv.mjs");
      await NodeFSP.writeFile(
        wrapper,
        `
import { execFileSync } from 'node:child_process';
await fetch(process.env.T3_TEST_ORIGIN + '/ready/' + process.env.T3_TEST_INSTALLER);
execFileSync(${JSON.stringify(realMv)}, process.argv.slice(2));
if (process.env.T3_TEST_INSTALLER === 'first') await fetch(process.env.T3_TEST_ORIGIN + '/published');
`,
      );
      await NodeFSP.writeFile(
        NodePath.join(tools, "mv"),
        `#!/bin/sh\nexec '${process.execPath}' '${wrapper}' "$@"\n`,
        { mode: 0o755 },
      );
      const install = (id: string) =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "sh",
            [NodePath.join(import.meta.dirname, "install.sh")],
            {
              env: {
                ...process.env,
                PATH: `${tools}:${process.env.PATH}`,
                T3CODE_VERSION: version,
                T3CODE_HOME: NodePath.join(root, "home"),
                T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin", id),
                T3CODE_RELEASE_BASE_URL: origin,
                T3_TEST_ORIGIN: origin,
                T3_TEST_INSTALLER: id,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
      const results = await Promise.all([install("first"), install("second")]);
      for (const result of results) expect(result.code, result.output).toBe(0);
      expect(
        (await NodeFSP.readdir(target)).filter((name) => name.startsWith(".staging-")),
        "concurrent installs must not leave a nested runtime",
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
