import { createWriteStream } from "node:fs";
import { link, readFile, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { atomicWriteFile, syncFile } from "../storage/atomicFile";

import { hashFile } from "./hashFile";
import { SETUP_PAUSED } from "./setupAttempt";

type Metadata = {
  url: string;
  validator: string | null;
  size: number | null;
  checksum: string | null;
  partialHash: string | null;
};
const PARTIAL_CONTENT = 206;
const RANGE_NOT_SATISFIABLE = 416;
const TIMEOUT_MS = 21_600_000;
const active = new Set<string>();
const cancelBody = (response: Response) =>
  response.body?.cancel().catch(() => {});

const waitForClose = (
  stream: Readable | ReturnType<typeof createWriteStream>
) => new Promise<void>((resolve) => stream.once("close", resolve));

/** Partials belong to this downloader, and only verified, unchanged partials
 * are appended. If-Range prevents mixing different revisions of a file. */
export const resumableDownload = async (
  url: string,
  destination: string,
  signal?: AbortSignal,
  onProgress?: (bytes: number, total: number | null) => void,
  expectedSha256?: string
): Promise<void> => {
  if (signal?.aborted) throw new Error(SETUP_PAUSED);
  if (active.has(destination))
    throw new Error("This file is already downloading.");
  active.add(destination);
  const partial = destination + ".mago-part";
  const metadataPath = partial + ".json";
  const publish = async () => {
    await syncFile(partial);
    signal?.throwIfAborted();
    // Commit without clobbering a concurrent download.
    await link(partial, destination);
    await unlink(partial);
    await unlink(metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
  try {
    if (await stat(destination).catch(() => null))
      throw new Error(
        "The destination file already exists. Choose another folder or remove it before downloading."
      );
    let metadata: Metadata | null = null;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Metadata;
    } catch {
      /* New download. */
    }
    let offset = (await stat(partial).catch(() => null))?.size ?? 0;
    const canResume =
      metadata?.url === url &&
      metadata.validator &&
      metadata.partialHash &&
      offset > 0 &&
      metadata.partialHash === (await hashFile(partial, signal));
    if (!canResume) offset = 0;
    if (
      canResume &&
      metadata &&
      offset === metadata.size &&
      metadata.partialHash ===
        (expectedSha256 ?? metadata.checksum ?? metadata.partialHash)
    ) {
      await publish();
      return;
    }
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (offset && metadata?.validator) {
      headers.Range = `bytes=${offset}-`;
      headers["If-Range"] = metadata.validator;
    }
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS);
    const request = async (requestHeaders: Record<string, string>) => {
      combinedSignal.throwIfAborted();
      const response = await fetch(url, {
        headers: requestHeaders,
        signal: combinedSignal
      });
      if (combinedSignal.aborted) {
        await cancelBody(response);
        combinedSignal.throwIfAborted();
      }
      return response;
    };
    let response = await request(headers);
    if (response.status === RANGE_NOT_SATISFIABLE && offset) {
      await cancelBody(response);
      offset = 0;
      response = await request({ "Accept-Encoding": "identity" });
    }
    if (!response.ok || !response.body) {
      await cancelBody(response);
      throw new Error(
        `Download failed (${response.status}). Retry to resume where supported.`
      );
    }
    if (response.headers.get("content-type")?.includes("text/html")) {
      await response.body.cancel();
      throw new Error(
        "The source returned a web page instead of a file. Check the source link."
      );
    }
    const range = response.headers
      .get("content-range")
      ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (
      response.status === PARTIAL_CONTENT &&
      (!offset ||
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) < offset)
    ) {
      await response.body.cancel();
      throw new Error(
        "Invalid resume response. The partial download was retained."
      );
    }
    if (response.status !== PARTIAL_CONTENT) offset = 0; // Server ignored Range or changed revision.
    const etag = response.headers.get("etag");
    const validator =
      etag && !etag.startsWith("W/")
        ? etag
        : response.headers.get("last-modified");
    const checksumHeader =
      response.headers.get("x-checksum-sha256") ??
      response.headers.get("x-linked-etag");
    const checksum = checksumHeader?.replaceAll('"', "");
    const length = response.headers.get("content-length");
    metadata = {
      url,
      validator,
      size:
        range && response.status === PARTIAL_CONTENT
          ? Number(range[3])
          : length !== null
            ? Number(length)
            : null,
      checksum:
        checksum && /^[a-f0-9]{64}$/i.test(checksum)
          ? checksum.toLowerCase()
          : offset
            ? (metadata?.checksum ?? null)
            : null,
      partialHash: null
    };
    if (expectedSha256) metadata.checksum = expectedSha256;
    // Do not replace previously verified metadata until streaming starts.
    if (combinedSignal.aborted) {
      await cancelBody(response);
      combinedSignal.throwIfAborted();
    }
    const source = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream
    );
    const writer = createWriteStream(partial, { flags: offset ? "a" : "w" });
    const closed = Promise.all([waitForClose(source), waitForClose(writer)]);
    let received = offset;
    const sizeExpected = metadata.size;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (!combinedSignal.aborted) onProgress?.(received, sizeExpected);
        callback(null, chunk);
      }
    });
    let preservePartial = true;
    try {
      try {
        await pipeline(source, progress, writer, { signal: combinedSignal });
      } finally {
        // A pipeline's rejection can precede cancellation of a Web body.
        await closed;
      }
      combinedSignal.throwIfAborted();
      const size = (await stat(partial)).size;
      if (metadata.size !== null && size !== metadata.size)
        throw new Error(
          "Incomplete download. Retry and choose the same folder to resume."
        );
      const actual =
        metadata.checksum && (await hashFile(partial, combinedSignal));
      combinedSignal.throwIfAborted();
      if (actual && actual !== metadata.checksum) {
        preservePartial = false;
        await unlink(partial);
        await unlink(metadataPath).catch(() => {});
        throw new Error(
          "SHA-256 verification failed. Retry to download a fresh copy."
        );
      }
      await publish();
    } catch (error) {
      if (preservePartial) {
        metadata.partialHash = await hashFile(partial).catch(() => null);
        await atomicWriteFile(metadataPath, JSON.stringify(metadata));
      }
      throw error;
    }
  } catch (error) {
    if (signal?.aborted) throw new Error(SETUP_PAUSED);
    throw error;
  } finally {
    active.delete(destination);
  }
};
