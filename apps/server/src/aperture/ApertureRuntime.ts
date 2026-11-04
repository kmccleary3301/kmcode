import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  type ApertureConnectionError as ApertureConnectionErrorType,
  type ApertureConnectionErrorCode,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const RUNTIME_FILE_MAX_BYTES = 8 * 1024 * 1024;
const RUNTIME_CACHE_MAX_VERSIONS = 4;
const RUNTIME_STORE_MAX_VERSIONS = 16;
const STORED_DOCUMENT_PATTERN = /^[a-f0-9]{64}\.html$/u;
const RUNTIME_REQUEST_TIMEOUT = Duration.seconds(30);
const RUNTIME_VERSION_PATTERN = /^[a-f0-9]{64}$/u;
const RUNTIME_VERSION_PLACEHOLDER = "__APERTURE_RUNTIME_VERSION__";
interface RuntimeBytesAccumulator {
  readonly chunks: Array<Uint8Array<ArrayBufferLike>>;
  readonly byteLength: number;
}

export interface ApertureRuntimeDocument {
  readonly version: string;
  readonly bytes: Uint8Array;
}

export class ApertureRuntime extends Context.Service<
  ApertureRuntime,
  {
    readonly getLatest: Effect.Effect<ApertureRuntimeDocument, ApertureConnectionErrorType>;
    readonly getCached: (version: string) => Effect.Effect<Uint8Array | null>;
  }
>()("t3/aperture/ApertureRuntime") {}

const runtimeError = (
  code: ApertureConnectionErrorCode,
  message: string,
): ApertureConnectionErrorType => ({ _tag: "ApertureConnectionError", code, message });

export const make = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDirectory = path.join((yield* ServerConfig.ServerConfig).stateDir, "aperture-runtime");
  const cache = yield* Ref.make(new Map<string, Uint8Array>());

  const runtimeBaseUrl = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() =>
        runtimeError("unreachable", "Aperture web settings could not be read."),
      ),
    );
    const baseUrl = settings.aperture.webUrl.trim() || settings.aperture.apiUrl.trim();
    if (baseUrl.length === 0) {
      return yield* Effect.fail(runtimeError("unreachable", "Aperture web URL is not configured."));
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return yield* Effect.fail(runtimeError("bad_response", "Aperture web URL is invalid."));
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return yield* Effect.fail(runtimeError("bad_response", "Aperture web URL is invalid."));
    }
    return url.href.replace(/\/+$/u, "");
  });

  const fetchBytes = (url: URL, maxBytes: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeaders({
                accept: "text/html, text/plain;q=0.9, */*;q=0.1",
                "accept-encoding": "identity",
              }),
            ),
          )
          .pipe(
            Effect.timeout(RUNTIME_REQUEST_TIMEOUT),
            Effect.mapError(() =>
              runtimeError("unreachable", "Aperture runtime request timed out or failed."),
            ),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          );
        if (response.status === 401) {
          return yield* Effect.fail(
            runtimeError("unauthorized", "Aperture rejected the runtime request."),
          );
        }
        if (response.status === 403) {
          return yield* Effect.fail(
            runtimeError("forbidden", "Aperture denied the runtime request."),
          );
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            runtimeError(
              "bad_response",
              `Aperture returned HTTP ${response.status} for the runtime.`,
            ),
          );
        }
        const declaredLength = response.headers["content-length"];
        if (declaredLength !== undefined) {
          const length = Number(declaredLength);
          if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
            return yield* Effect.fail(
              runtimeError("bad_response", "Aperture runtime response exceeds the size limit."),
            );
          }
        }
        const accumulated = yield* response.stream.pipe(
          Stream.mapError(() =>
            runtimeError("unreachable", "Aperture runtime response stream failed."),
          ),
          Stream.runFoldEffect<
            RuntimeBytesAccumulator,
            Uint8Array<ArrayBufferLike>,
            ApertureConnectionErrorType,
            never
          >(
            () => ({ chunks: [], byteLength: 0 }),
            (state, chunk) => {
              const byteLength = state.byteLength + chunk.byteLength;
              if (byteLength > maxBytes) {
                return Effect.fail(
                  runtimeError("bad_response", "Aperture runtime response exceeds the size limit."),
                );
              }
              state.chunks.push(chunk);
              return Effect.succeed({ chunks: state.chunks, byteLength });
            },
          ),
        );
        const bytes = new Uint8Array(accumulated.byteLength);
        let offset = 0;
        for (const chunk of accumulated.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }),
    );

  const sha256Hex = (text: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));

  // The runtime embeds its own version, so the hash covers the document with that version masked.
  const isVerifiedDocument = (version: string, bytes: Uint8Array) =>
    Effect.gen(function* () {
      let html: string;
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return false;
      }
      if (!html.includes(version)) return false;
      const template = html.replaceAll(version, RUNTIME_VERSION_PLACEHOLDER);
      return (yield* sha256Hex(template)) === version;
    }).pipe(Effect.orElseSucceed(() => false));

  const remember = (version: string, bytes: Uint8Array) =>
    Ref.update(cache, (current) => {
      const updated = new Map(current);
      updated.delete(version);
      updated.set(version, bytes);
      while (updated.size > RUNTIME_CACHE_MAX_VERSIONS) {
        const oldest = updated.keys().next();
        if (oldest.done) break;
        updated.delete(oldest.value);
      }
      return updated;
    });

  const storedPath = (version: string) => path.join(storeDirectory, `${version}.html`);

  // Pinned messages keep referencing the runtime version they were rendered with, so verified
  // documents outlive restarts; a file that no longer verifies is treated as absent.
  const readStored = (version: string) =>
    Effect.gen(function* () {
      const bytes = yield* fs.readFile(storedPath(version));
      return (yield* isVerifiedDocument(version, bytes)) ? bytes : null;
    }).pipe(Effect.orElseSucceed(() => null));

  const store = (version: string, bytes: Uint8Array) =>
    Effect.gen(function* () {
      yield* writeFileStringAtomically({
        filePath: storedPath(version),
        contents: new TextDecoder().decode(bytes),
      });
      const entries = yield* fs.readDirectory(storeDirectory);
      const documents = entries.filter((entry) => STORED_DOCUMENT_PATTERN.test(entry));
      if (documents.length <= RUNTIME_STORE_MAX_VERSIONS) return;
      const aged = yield* Effect.forEach(documents, (entry) =>
        fs.stat(path.join(storeDirectory, entry)).pipe(
          Effect.map((info) => ({
            entry,
            mtimeMs: Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (mtime) => mtime.getTime(),
            }),
          })),
        ),
      );
      aged.sort((left, right) => left.mtimeMs - right.mtimeMs);
      yield* Effect.forEach(aged.slice(0, aged.length - RUNTIME_STORE_MAX_VERSIONS), ({ entry }) =>
        fs.remove(path.join(storeDirectory, entry)),
      );
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignoreCause({ log: true }),
    );

  const lookup = (version: string) =>
    Effect.gen(function* () {
      const remembered = (yield* Ref.get(cache)).get(version);
      if (remembered !== undefined) return remembered;
      const stored = yield* readStored(version);
      if (stored !== null) yield* remember(version, stored);
      return stored;
    });

  const getLatest = Effect.gen(function* () {
    const baseUrl = yield* runtimeBaseUrl;
    const versionUrl = new URL(`${baseUrl}/embed/runtime.version`);
    const versionBytes = yield* fetchBytes(versionUrl, 128);
    let version: string;
    try {
      version = new TextDecoder("utf-8", { fatal: true }).decode(versionBytes).trim();
    } catch {
      return yield* Effect.fail(
        runtimeError("bad_response", "Aperture runtime version is not valid UTF-8."),
      );
    }
    if (!RUNTIME_VERSION_PATTERN.test(version)) {
      return yield* Effect.fail(
        runtimeError("bad_response", "Aperture runtime version is not a SHA-256 hash."),
      );
    }

    const known = yield* lookup(version);
    if (known !== null) return { version, bytes: known };

    const runtimeUrl = new URL(`${baseUrl}/embed/runtime.html`);
    const bytes = yield* fetchBytes(runtimeUrl, RUNTIME_FILE_MAX_BYTES);
    if (!(yield* isVerifiedDocument(version, bytes))) {
      return yield* Effect.fail(
        runtimeError("bad_response", "Aperture runtime content hash verification failed."),
      );
    }
    yield* remember(version, bytes);
    yield* store(version, bytes);
    return { version, bytes };
  });

  return ApertureRuntime.of({
    getLatest,
    getCached: (version) =>
      RUNTIME_VERSION_PATTERN.test(version) ? lookup(version) : Effect.succeed(null),
  });
});

export const layer = Layer.effect(ApertureRuntime, make);
