import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const MAX_PI_STDERR_TAIL_BYTES = 16 * 1024;
const MAX_PI_CRASH_FILES = 50;
const MAX_PANIC_MESSAGE_CHARS = 200;

/** Retains only the newest bytes received from a process stderr stream. */
export class PiStderrTail {
  private readonly buffer = new Uint8Array(MAX_PI_STDERR_TAIL_BYTES);
  private start = 0;
  private length = 0;

  get byteLength(): number {
    return this.length;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength >= MAX_PI_STDERR_TAIL_BYTES) {
      this.buffer.set(chunk.subarray(chunk.byteLength - MAX_PI_STDERR_TAIL_BYTES));
      this.start = 0;
      this.length = MAX_PI_STDERR_TAIL_BYTES;
      return;
    }

    const overflow = Math.max(0, this.length + chunk.byteLength - MAX_PI_STDERR_TAIL_BYTES);
    this.start = (this.start + overflow) % MAX_PI_STDERR_TAIL_BYTES;
    this.length -= overflow;

    const writeAt = (this.start + this.length) % MAX_PI_STDERR_TAIL_BYTES;
    const firstLength = Math.min(chunk.byteLength, MAX_PI_STDERR_TAIL_BYTES - writeAt);
    this.buffer.set(chunk.subarray(0, firstLength), writeAt);
    this.buffer.set(chunk.subarray(firstLength), 0);
    this.length += chunk.byteLength;
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.length);
    const firstLength = Math.min(this.length, MAX_PI_STDERR_TAIL_BYTES - this.start);
    bytes.set(this.buffer.subarray(this.start, this.start + firstLength));
    bytes.set(this.buffer.subarray(0, this.length - firstLength), firstLength);
    return bytes;
  }

  toString(): string {
    return new TextDecoder().decode(this.toBytes());
  }
}

/** Returns only the recognized, bounded Bun panic signature, never surrounding stderr. */
export function extractBunPanicSignature(stderr: string): string | undefined {
  let version: string | undefined;
  let panic: string | undefined;

  for (const line of stderr.split(/\r?\n/)) {
    if (version === undefined) {
      const versionMatch = /^Bun v(\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/.exec(
        line,
      );
      version = versionMatch?.[1];
    }
    if (panic !== undefined) continue;

    const panicMatch = /^panic\(([A-Za-z0-9 _.-]{1,80})\): ([^\r\n]*)$/.exec(line);
    if (panicMatch === null) continue;

    const thread = panicMatch[1];
    const message = (panicMatch[2] ?? "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .trim()
      .slice(0, MAX_PANIC_MESSAGE_CHARS);
    if (thread === undefined || message.length === 0) continue;

    panic = `panic(${thread}): ${message}`;
  }

  return panic === undefined ? undefined : `Bun${version === undefined ? "" : ` v${version}`} ${panic}`;
}

export const writePiCrashStderr = (input: {
  readonly logsDir: string;
  readonly timestampMillis: number;
  readonly pid: number;
  readonly stderr: Uint8Array;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crashDir = path.join(input.logsDir, "pi-crashes");
    yield* fs.makeDirectory(crashDir, { recursive: true, mode: 0o700 });
    yield* fs.chmod(crashDir, 0o700);

    const timestamp = DateTime.formatIso(
      DateTime.toUtc(DateTime.makeUnsafe(input.timestampMillis)),
    ).replace(/:/g, "-");
    const crashPath = path.join(crashDir, `${timestamp}-pid${input.pid}.stderr.log`);
    yield* fs.writeFile(crashPath, input.stderr, { mode: 0o600 });
    yield* fs.chmod(crashPath, 0o600);

    yield* Effect.gen(function* () {
      const entries = yield* fs.readDirectory(crashDir);
      const files: Array<string> = [];
      for (const entry of entries) {
        if (entry.endsWith(".stderr.log")) files.push(entry);
      }
      files.sort().reverse();
      for (const staleFile of files.slice(MAX_PI_CRASH_FILES)) {
        yield* fs.remove(path.join(crashDir, staleFile));
      }
    }).pipe(Effect.catch(() => Effect.logWarning("Could not prune pi crash stderr files.")));

    return crashPath;
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Could not save pi crash stderr.").pipe(Effect.as(undefined)),
    ),
  );
