export const OMP_MAX_FRAME_BYTES = 1_048_576;
export const OMP_MAX_REASSEMBLED_BYTES = 67_108_864;
export const OMP_CHUNK_PAYLOAD_BYTES = 262_144;

export interface OmpRpcChunkFrame {
  readonly type: "rpc_chunk";
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

export type OmpRpcRecord = Record<string, unknown>;

export class OmpChunkError extends Error {
  public readonly code: string;
  public readonly detail?: unknown;

  public constructor(message: string, code: string, detail?: unknown) {
    super(message);
    this.name = "OmpChunkError";
    this.code = code;
    this.detail = detail;
  }
}

interface PendingChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly chunks: Uint8Array[];
  readonly nextIndex: number;
  readonly receivedBytes: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reassembles the exact OMP protocol-v2 `rpc_chunk` sequence.
 *
 * OMP does not permit interleaving: one logical object is represented by a
 * contiguous index sequence. Chunks carry base64 of the original UTF-8 JSON,
 * so byte length is validated before decoding JSON and no replacement decoding
 * is possible.
 */
export class OmpChunkAssembler {
  private readonly maxReassembledBytes: number;
  private readonly maxChunkCount: number;
  private pending: PendingChunks | undefined;

  public constructor(maxReassembledBytes = OMP_MAX_REASSEMBLED_BYTES) {
    if (!Number.isSafeInteger(maxReassembledBytes) || maxReassembledBytes <= 0) {
      throw new TypeError("maxReassembledBytes must be a positive safe integer");
    }
    this.maxReassembledBytes = maxReassembledBytes;
    this.maxChunkCount = Math.ceil(maxReassembledBytes / OMP_CHUNK_PAYLOAD_BYTES);
  }

  public accept(value: unknown): OmpRpcRecord | undefined {
    if (!this.isChunkFrame(value)) {
      if (this.pending) {
        this.pending = undefined;
        throw new OmpChunkError(
          "OMP rpc_chunk sequence was interrupted",
          "OMP_CHUNK_INTERRUPTED",
          value,
        );
      }
      const record = asRecord(value);
      if (!record || typeof record.type !== "string") {
        throw new OmpChunkError(
          "RPC frame must be an object with a string type",
          "RPC_INVALID_FRAME",
          value,
        );
      }
      return record;
    }

    const { chunkId, index, count, byteLength } = value;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > this.maxChunkCount ||
      index >= count ||
      byteLength <= 0 ||
      byteLength > this.maxReassembledBytes
    ) {
      this.pending = undefined;
      throw new OmpChunkError("Invalid OMP rpc_chunk metadata", "OMP_CHUNK_METADATA", value);
    }

    let chunk: Uint8Array;
    try {
      chunk = decodeBase64(value.data);
    } catch (cause) {
      this.pending = undefined;
      throw new OmpChunkError("Invalid OMP rpc_chunk data", "OMP_CHUNK_DATA", {
        cause,
        value,
      });
    }
    if (chunk.byteLength === 0 || chunk.byteLength > OMP_CHUNK_PAYLOAD_BYTES) {
      this.pending = undefined;
      throw new OmpChunkError(
        "OMP rpc_chunk payload exceeds the transport limit",
        "OMP_CHUNK_PAYLOAD",
        {
          byteLength: chunk.byteLength,
        },
      );
    }

    if (!this.pending) {
      if (index !== 0) {
        throw new OmpChunkError(
          "OMP rpc_chunk sequence must start at index 0",
          "OMP_CHUNK_START",
          value,
        );
      }
      this.pending = { chunkId, count, byteLength, chunks: [], nextIndex: 0, receivedBytes: 0 };
    }

    const pending = this.pending;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      this.pending = undefined;
      throw new OmpChunkError("OMP rpc_chunk sequence mismatch", "OMP_CHUNK_SEQUENCE", value);
    }

    const receivedBytes = pending.receivedBytes + chunk.byteLength;
    if (receivedBytes > pending.byteLength) {
      this.pending = undefined;
      throw new OmpChunkError(
        "OMP rpc_chunk sequence exceeds declared length",
        "OMP_CHUNK_LENGTH",
        value,
      );
    }
    this.pending = {
      ...pending,
      chunks: [...pending.chunks, chunk],
      nextIndex: pending.nextIndex + 1,
      receivedBytes,
    };
    if (this.pending.nextIndex < this.pending.count) return undefined;
    if (this.pending.receivedBytes !== this.pending.byteLength) {
      this.pending = undefined;
      throw new OmpChunkError("OMP rpc_chunk sequence length mismatch", "OMP_CHUNK_LENGTH", value);
    }

    const completed = this.pending;
    this.pending = undefined;
    const bytes = concatBytes(completed.chunks, completed.receivedBytes);
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new OmpChunkError("Reassembled OMP frame contained malformed UTF-8", "OMP_CHUNK_UTF8", {
        cause,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (cause) {
      throw new OmpChunkError("Reassembled OMP frame was not valid JSON", "OMP_CHUNK_JSON", {
        cause,
      });
    }
    const record = asRecord(parsed);
    if (!record || typeof record.type !== "string") {
      throw new OmpChunkError("Reassembled OMP frame must be an object", "OMP_CHUNK_VALUE", parsed);
    }
    return record;
  }

  public clear(): void {
    this.pending = undefined;
  }

  public get pendingMessageCount(): number {
    return this.pending ? 1 : 0;
  }

  private isChunkFrame(value: unknown): value is OmpRpcChunkFrame {
    const record = asRecord(value);
    return record?.type === "rpc_chunk";
  }
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("non-canonical base64");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64(bytes) !== value) throw new Error("non-canonical base64");
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

function concatBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
