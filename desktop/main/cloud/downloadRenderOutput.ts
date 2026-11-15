import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import { resolveCloudConfig } from "../../shared/cloudConfig";
import {
  openCloudStorageDownload,
  type CloudStorageAccess
} from "../cloudStorage/openCloudStorageDownload";
import { publishFile } from "../storage/atomicFile";

/**
 * Downloads a finished cloud render into the library.
 *
 * Once this completes the output is an ordinary local file, so playback works
 * offline and the cloud is never a read path. Written to a temporary name and
 * renamed on success, so an interrupted download cannot leave a truncated file
 * that later looks complete.
 */

type DownloadResult = { relativePath: string; sizeBytes: number };

type DownloadRenderOutputInput = {
  url: string;
  libraryRoot: string;
  jobId: string;
  extension?: string;
  onProgress?: (fraction: number) => void;
  cloudStorage?: CloudStorageAccess;
  signal?: AbortSignal;
};

// Development remounts and multiple renderer windows can observe the same
// finished cloud job at once. They must share one download: two writers using
// the same `.partial` path race when the first one renames it into place.
const downloadsInFlight = new Map<string, Promise<DownloadResult>>();
const sessionDownloads = new WeakMap<
  AbortSignal,
  Map<string, Promise<DownloadResult>>
>();

/**
 * A cloud render's output file. The extension matters: an img2img render comes
 * back as a still, and a `.mp4` named PNG confuses both the player and the
 * thumbnailer.
 */
export const renderOutputPath = (
  jobId: string,
  extension: string = "mp4"
): string => `renders/cloud/${jobId}/output.${extension}`;

const performDownload = async (
  input: DownloadRenderOutputInput,
  relativePath: string,
  destination: string
): Promise<DownloadResult> => {
  const cloudStorage = input.cloudStorage ?? {
    allowedHosts: resolveCloudConfig().cloudStorageHosts
  };
  const temporary = `${destination}.partial`;

  input.signal?.throwIfAborted();
  const download = await openCloudStorageDownload({
    ...cloudStorage,
    url: input.url,
    signal: input.signal
  });
  // A transport may ignore abort and deliver headers late. Own the actual
  // body cleanup too; a rejected dispatch promise is not a stream drain.
  const bodyClosed = finished(download.body, { cleanup: true }).catch(() => {});
  const abort = () => download.body.destroy(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    input.signal?.throwIfAborted();
    await mkdir(path.dirname(destination), { recursive: true });
    input.signal?.throwIfAborted();
    await unlink(temporary).catch(() => {});
    input.signal?.throwIfAborted();
    const expected = Number(download.headers.get("content-length") ?? 0);
    let received = 0;
    download.body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (!input.signal?.aborted && expected > 0)
        input.onProgress?.(received / expected);
    });
    await pipeline(download.body, createWriteStream(temporary), {
      signal: input.signal
    });
    input.signal?.throwIfAborted();
    const { size } = await stat(temporary);
    input.signal?.throwIfAborted();
    if (size === 0) throw new Error("The downloaded render output was empty");
    if (expected > 0 && size !== expected)
      throw new Error(
        `The render output download was incomplete (${size} of ${expected} bytes)`
      );
    await publishFile(temporary, destination);
    input.signal?.throwIfAborted();
    return { relativePath, sizeBytes: size };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    download.body.destroy();
    await bodyClosed;
  }
};

export const downloadRenderOutput = async (
  input: DownloadRenderOutputInput
): Promise<DownloadResult> => {
  input.signal?.throwIfAborted();
  let downloads = downloadsInFlight;
  if (input.signal) {
    downloads = sessionDownloads.get(input.signal) ?? new Map();
    sessionDownloads.set(input.signal, downloads);
  }
  const relativePath = renderOutputPath(input.jobId, input.extension);
  const destination = path.join(input.libraryRoot, relativePath);
  const existing = downloads.get(destination);
  if (existing) return existing;

  const operation = performDownload(input, relativePath, destination);
  downloads.set(destination, operation);
  try {
    return await operation;
  } finally {
    if (downloads.get(destination) === operation) {
      downloads.delete(destination);
    }
  }
};
