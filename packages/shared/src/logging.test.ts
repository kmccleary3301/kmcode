// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HostProcessPlatform } from "./hostProcess.ts";

import {
  RotatingFileSink,
  RotatingFileSinkConfigurationError,
  RotatingFileSinkError,
} from "./logging.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const tempDirectories: string[] = [];

const makeTempDirectory = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-logging-"));
  tempDirectories.push(directory);
  return directory;
};

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};
const capturePromiseError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to reject");
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("RotatingFileSink", () => {
  it.each([
    { option: "maxBytes" as const, maxBytes: 0, maxFiles: 1 },
    { option: "maxFiles" as const, maxBytes: 1, maxFiles: 0 },
  ])("reports invalid $option configuration structurally", (input) => {
    const thrown = captureError(
      () =>
        new RotatingFileSink({
          filePath: "/unused/log.ndjson",
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
        }),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkConfigurationError);
    expect(thrown).toMatchObject({
      option: input.option,
      received: 0,
      minimum: 1,
    });
    expect((thrown as Error).message).toBe(
      `${input.option} must be a positive safe integer >= 1 (received 0)`,
    );
  });

  it("rejects unbounded queue limits", () => {
    const filePath = "/unused/log.ndjson";
    expect(
      () =>
        new RotatingFileSink({
          filePath,
          maxBytes: 1,
          maxFiles: 1,
          maxBufferedBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(RotatingFileSinkConfigurationError);
    expect(
      () =>
        new RotatingFileSink({
          filePath,
          maxBytes: 1,
          maxFiles: 1,
          maxBufferedRecords: Number.NaN,
        }),
    ).toThrow(RotatingFileSinkConfigurationError);
  });

  it("preserves directory initialization failures", async () => {
    const directory = makeTempDirectory();
    const parentFile = NodePath.join(directory, "not-a-directory");
    const filePath = NodePath.join(parentFile, "log.ndjson");
    NodeFS.writeFileSync(parentFile, "occupied");
    const sink = new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 });

    const thrown = await capturePromiseError(() => sink.initialize());

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "initialize", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  // An over-long name is the one stat failure that is neither ENOENT nor a
  // permission problem on posix. Windows reports it as ENOENT, so there is nothing to assert.
  it.skipIf(windowsHost)("only treats a missing log file as an empty current size", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "a".repeat(300));
    const sink = new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 });

    const thrown = await capturePromiseError(() => sink.initialize());

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "read", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "ENAMETOOLONG" });
  });

  it("keeps enqueued writes in order and starts an absent file at zero bytes", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 100, maxFiles: 1 });

    expect(sink.write("first\n")).toBe(true);
    expect(sink.write("second\n")).toBe(true);
    await sink.flush();

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("first\nsecond\n");
  });

  it("rotates enqueued writes in order", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 4, maxFiles: 2 });

    sink.write("one\n");
    sink.write("two\n");
    sink.write("tri\n");
    await sink.flush();

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("tri\n");
    expect(NodeFS.readFileSync(`${filePath}.1`, "utf8")).toBe("two\n");
    expect(NodeFS.readFileSync(`${filePath}.2`, "utf8")).toBe("one\n");
  });

  it("bounds buffered bytes and counts dropped records", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 100,
      maxFiles: 1,
      maxBufferedBytes: 4,
      maxBufferedRecords: 4,
      throwOnError: true,
    });

    expect(sink.write("1234")).toBe(true);
    expect(sink.write("x")).toBe(false);
    expect(sink.droppedCount).toBe(1);
    await sink.flush();

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("1234");
    expect(sink.droppedCount).toBe(1);
  });

  it("bounds drops with a stalled async writer without blocking the event loop", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    let notifyWriteStarted = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      notifyWriteStarted = resolve;
    });
    let unblockWriter = () => {};
    const writerGate = new Promise<void>((resolve) => {
      unblockWriter = resolve;
    });
    const appendFile = vi
      .spyOn(NodeFS.promises, "appendFile")
      .mockImplementation(async () => {
        notifyWriteStarted();
        await writerGate;
      });
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 100,
      maxFiles: 1,
      maxBufferedBytes: 4,
      maxBufferedRecords: 4,
    });

    try {
      expect(sink.write("1234")).toBe(true);
      await writeStarted;

      expect(sink.write("x")).toBe(false);
      expect(sink.droppedCount).toBe(1);

      let eventLoopContinued = false;
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          eventLoopContinued = true;
          resolve();
        }),
      );
      expect(eventLoopContinued).toBe(true);
    } finally {
      unblockWriter();
      appendFile.mockRestore();
      await sink.close();
    }
  });

  it("preserves asynchronous write failures", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(filePath);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: 1,
      throwOnError: true,
    });
    sink.write("entry");

    const thrown = await capturePromiseError(() => sink.flush());

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "write", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "EISDIR" });
    expect(sink.droppedCount).toBe(1);
  });

  it("preserves rotation failures without an artificial write wrapper", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.writeFileSync(filePath, "a");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });
    sink.write("b");

    const thrown = await capturePromiseError(() => sink.flush());

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  it("never reports a rotation failure after successfully appending a chunk", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    sink.write("oversized");
    await sink.flush();
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");

    sink.write("next");
    const thrown = await capturePromiseError(() => sink.flush());
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
  });

  it("preserves backup pruning failures", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const overflowBackup = `${filePath}.2`;
    NodeFS.mkdirSync(overflowBackup);
    NodeFS.writeFileSync(NodePath.join(overflowBackup, "entry"), "occupied");
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = await capturePromiseError(() => sink.initialize());

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "prune", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });
});
