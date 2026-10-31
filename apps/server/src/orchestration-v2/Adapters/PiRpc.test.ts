import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  extractBunPanicSignature,
  MAX_PI_STDERR_TAIL_BYTES,
  PiStderrTail,
} from "./PiCrashDiagnostics.ts";

import * as ServerConfig from "../../config.ts";
import { OMP_DIALECT } from "../../provider/piDialect.ts";
import { makePiRpcConnection } from "./PiRpc.ts";

const panicSample = `============================================================
Bun v1.4.2 (744846f84) Linux x64
Linux Kernel v6.18.59 | glibc v2.43
CPU: sse42 popcnt avx avx2 avx512
Args: "bun" "--preload" "/x/omp.ts"
Elapsed: 29818ms | User: 2599ms | Sys: 247ms
RSS: 0.60 GB | Peak: 0.84 GB | Commit: 1.63 GB | Faults: 0 | Machine: 0.1 TB

panic(main thread): Segmentation fault at address 0x8000000080
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
`;

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-rpc-crash-",
}).pipe(Layer.provide(NodeServices.layer));
const layerTest = Layer.mergeAll(NodeServices.layer, layerServerConfig);

const readAbnormalExit = (stderr: string, exitCode: number | undefined) =>
  Effect.gen(function* () {
    const exit =
      exitCode === undefined
        ? `process.kill(process.pid, "SIGTERM");`
        : `process.exitCode = ${exitCode};`;
    const script = `process.stderr.write(${JSON.stringify(stderr)}); ${exit}`;
    const error = yield* makePiRpcConnection({
      command: process.execPath,
      args: ["-e", script],
      cwd: undefined,
      env: {},
      dialect: OMP_DIALECT,
    }).pipe(Effect.flip);
    return error;
  }).pipe(Effect.scoped);

describe("PiRpc crash diagnostics", () => {
  it("retains exactly the newest 16 KiB of stderr", () => {
    const tail = new PiStderrTail();
    tail.append(new TextEncoder().encode("a".repeat(MAX_PI_STDERR_TAIL_BYTES)));
    tail.append(new TextEncoder().encode("tail"));

    assert.equal(tail.byteLength, MAX_PI_STDERR_TAIL_BYTES);
    assert.equal(tail.toString(), `${"a".repeat(MAX_PI_STDERR_TAIL_BYTES - 4)}tail`);
  });

  it("extracts only a matching, bounded Bun panic signature", () => {
    assert.equal(
      extractBunPanicSignature(panicSample),
      "Bun v1.4.2 panic(main thread): Segmentation fault at address 0x8000000080",
    );
    const secret = "ANTHROPIC_API_KEY=sk-ant-xyz";
    assert.isUndefined(extractBunPanicSignature(`${secret}\n`));
    assert.notInclude(extractBunPanicSignature(`${secret}\n`) ?? "", secret);

    const longPanic = `panic(main thread): ${"x".repeat(250)}`;
    assert.equal(
      extractBunPanicSignature(longPanic),
      `Bun panic(main thread): ${"x".repeat(200)}`,
    );
  });
  it.effect("saves an OMP panic tail privately and reports its sanitized signature", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const error = yield* readAbnormalExit(panicSample, 139);

      assert.equal(error._tag, "PiRpcError");
      assert.include(error.detail ?? "", "pi process exited with code 139");
      assert.include(
        error.detail ?? "",
        "Bun v1.4.2 panic(main thread): Segmentation fault at address 0x8000000080",
      );
      const fileMatch = /stderr saved to (.+\.stderr\.log)\)/.exec(error.detail ?? "");
      assert.isNotNull(fileMatch);
      if (fileMatch === null) return;

      const filePath = fileMatch[1];
      if (filePath === undefined) return;
      assert.isTrue(filePath.startsWith(path.join(config.logsDir, "pi-crashes")));
      assert.isTrue(
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-pid\d+\.stderr\.log$/.test(
          path.basename(filePath),
        ),
      );
      assert.include(error.message, "Bun v1.4.2 panic(main thread): Segmentation fault");
      assert.equal(yield* fs.readFileString(filePath), panicSample);
      assert.equal((yield* fs.stat(filePath)).mode & 0o777, 0o600);
      assert.equal((yield* fs.stat(path.dirname(filePath))).mode & 0o777, 0o700);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("does not expose non-panic stderr in the process error", () =>
    Effect.gen(function* () {
      const secret = "ANTHROPIC_API_KEY=sk-ant-xyz";
      const error = yield* readAbnormalExit(`${secret}\n`, 1);

      assert.equal(error._tag, "PiRpcError");
      assert.include(error.detail ?? "", "pi process exited with code 1");
      assert.notInclude(error.detail ?? "", secret);
      assert.notInclude(error.message, secret);
      assert.notInclude(error.detail ?? "", "Bun panic");
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("reports a child exit signal", () =>
    Effect.gen(function* () {
      const error = yield* readAbnormalExit("", undefined);
      assert.equal(error._tag, "PiRpcError");
      assert.include(error.detail ?? "", "pi process exited with signal SIGTERM");
    }).pipe(Effect.provide(layerTest)),
  );
});
