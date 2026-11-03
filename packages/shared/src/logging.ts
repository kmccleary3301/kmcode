// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly throwOnError?: boolean;
}

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

export class RotatingFileSinkConfigurationError extends Schema.TaggedError<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles", "maxBufferedBytes", "maxBufferedRecords"]),
    received: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be a positive safe integer >= ${this.minimum} ` +
      `(received ${this.received})`;
  }
}

export class RotatingFileSinkError extends Schema.TaggedError<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    operation: Schema.Literals(["initialize", "read", "write", "rotate", "prune"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);

const isFileNotFoundError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

interface PendingWrite {
  readonly buffer: Buffer;
  readonly recordCount: number;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedRecords: number;
  private readonly throwOnError: boolean;
  private readonly queue: Array<PendingWrite> = [];
  private currentSize = 0;
  private queuedBytes = 0;
  private queuedRecords = 0;
  private inFlightBytes = 0;
  private inFlightRecords = 0;
  private dropped = 0;
  private failureVersion = 0;
  private reportedFailureVersion = 0;
  private lastError: RotatingFileSinkError | undefined;
  private initializePromise: Promise<void> | undefined;
  private drainPromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: RotatingFileSinkOptions) {
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    const maxBufferedRecords = options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS;
    const invalidOption =
      !isPositiveSafeInteger(options.maxBytes)
        ? { option: "maxBytes" as const, received: options.maxBytes }
        : !isPositiveSafeInteger(options.maxFiles)
          ? { option: "maxFiles" as const, received: options.maxFiles }
          : !isPositiveSafeInteger(maxBufferedBytes)
            ? { option: "maxBufferedBytes" as const, received: maxBufferedBytes }
            : !isPositiveSafeInteger(maxBufferedRecords)
              ? { option: "maxBufferedRecords" as const, received: maxBufferedRecords }
              : undefined;
    if (invalidOption) {
      throw new RotatingFileSinkConfigurationError({
        ...invalidOption,
        minimum: 1,
      });
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxBufferedRecords = maxBufferedRecords;
    this.throwOnError = options.throwOnError ?? false;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const task = this.initializeUnsafe();
    const guarded = task.catch((cause: unknown) => {
      if (this.initializePromise === guarded) this.initializePromise = undefined;
      throw this.wrapError("initialize", cause);
    });
    this.initializePromise = guarded;
    return guarded;
  }

  write(chunk: string | Buffer, recordCount = 1): boolean {
    const byteLength =
      typeof chunk === "string" && chunk.length > this.maxBufferedBytes
        ? this.maxBufferedBytes + 1
        : typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : chunk.length;
    if (byteLength === 0) return true;
    if (
      this.closed ||
      this.queuedBytes + this.inFlightBytes + byteLength > this.maxBufferedBytes ||
      this.queuedRecords + this.inFlightRecords + recordCount > this.maxBufferedRecords
    ) {
      this.dropped += recordCount;
      return false;
    }

    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.queue.push({ buffer, recordCount });
    this.queuedBytes += buffer.length;
    this.queuedRecords += recordCount;
    void this.startDrain();
    return true;
  }

  async flush(): Promise<void> {
    while (true) {
      const work =
        this.drainPromise ?? (this.queue.length > 0 ? this.startDrain() : undefined);
      if (!work) break;
      await work;
      if (!this.drainPromise && this.queue.length === 0) break;
    }

    if (this.failureVersion > this.reportedFailureVersion) {
      this.reportedFailureVersion = this.failureVersion;
      if (this.throwOnError && this.lastError) throw this.lastError;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private async initializeUnsafe(): Promise<void> {
    try {
      await NodeFS.promises.mkdir(NodePath.dirname(this.filePath), { recursive: true });
    } catch (cause) {
      throw this.wrapError("initialize", cause);
    }
    await this.pruneOverflowBackups();
    this.currentSize = await this.readCurrentSize();
  }

  private startDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    let drainPromise: Promise<void>;
    drainPromise = this.drainQueue().finally(() => {
      if (this.drainPromise === drainPromise) this.drainPromise = undefined;
      if (this.queue.length > 0) void this.startDrain();
    });
    this.drainPromise = drainPromise;
    return drainPromise;
  }

  private async drainQueue(): Promise<void> {
    try {
      await this.initialize();
    } catch (cause) {
      this.dropQueuedWrites(this.wrapError("initialize", cause));
      return;
    }

    while (this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) break;
      this.queuedBytes -= pending.buffer.length;
      this.queuedRecords -= pending.recordCount;
      this.inFlightBytes = pending.buffer.length;
      this.inFlightRecords = pending.recordCount;
      try {
        if (this.currentSize > 0 && this.currentSize + pending.buffer.length > this.maxBytes) {
          await this.rotate();
        }
        await NodeFS.promises.appendFile(this.filePath, pending.buffer);
        this.currentSize += pending.buffer.length;
      } catch (cause) {
        this.dropQueuedWrites(this.wrapError("write", cause), pending);
        return;
      } finally {
        this.inFlightBytes = 0;
        this.inFlightRecords = 0;
      }
    }
  }

  private dropQueuedWrites(error: RotatingFileSinkError, current?: PendingWrite): void {
    this.lastError = error;
    this.failureVersion += 1;
    if (current) this.dropped += current.recordCount;
    this.dropped += this.queue.reduce((count, pending) => count + pending.recordCount, 0);
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.queuedRecords = 0;
  }

  private async rotate(): Promise<void> {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (await this.exists(oldest)) {
        await NodeFS.promises.rm(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (await this.exists(source)) {
          await NodeFS.promises.rename(source, target);
        }
      }

      if (await this.exists(this.filePath)) {
        await NodeFS.promises.rename(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch (cause) {
      throw this.wrapError("rotate", cause);
    }
  }

  private async pruneOverflowBackups(): Promise<void> {
    try {
      const dir = NodePath.dirname(this.filePath);
      const baseName = NodePath.basename(this.filePath);
      for (const entry of await NodeFS.promises.readdir(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        await NodeFS.promises.rm(NodePath.join(dir, entry), { force: true });
      }
    } catch (cause) {
      throw this.wrapError("prune", cause);
    }
  }

  private async readCurrentSize(): Promise<number> {
    try {
      return (await NodeFS.promises.stat(this.filePath)).size;
    } catch (cause) {
      if (isFileNotFoundError(cause)) return 0;
      throw this.wrapError("read", cause);
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await NodeFS.promises.stat(filePath);
      return true;
    } catch (cause) {
      if (isFileNotFoundError(cause)) return false;
      throw cause;
    }
  }

  private wrapError(
    operation: "initialize" | "read" | "write" | "rotate" | "prune",
    cause: unknown,
  ): RotatingFileSinkError {
    return isRotatingFileSinkError(cause)
      ? cause
      : new RotatingFileSinkError({ operation, filePath: this.filePath, cause });
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
