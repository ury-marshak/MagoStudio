import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  fetchCloudStorageObject,
  type FetchCloudStorage
} from "./fetchCloudStorageObject";

export type CloudStorageAccess = {
  allowedHosts: readonly string[];
  fetchFromCloudStorage?: FetchCloudStorage;
  assertAccess?: () => Promise<void>;
};

export type CloudStorageDownload = {
  body: Readable;
  headers: Headers;
};

export const openCloudStorageDownload = async ({
  url,
  allowedHosts,
  fetchFromCloudStorage,
  assertAccess,
  signal
}: CloudStorageAccess & {
  url: unknown;
  signal?: AbortSignal;
}): Promise<CloudStorageDownload> => {
  const response = await fetchCloudStorageObject({
    url,
    allowedHosts,
    signal,
    assertAccess,
    fetchFromCloudStorage
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      `Mago cloud storage could not deliver the file (${response.status})`
    );
  }
  return {
    body: Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
    headers: response.headers
  };
};

/** Headers are not a transfer drain. Keep ownership through actual body
 * cancellation/close, including a transport that delivers headers after abort. */
export const withCloudStorageDownload = async <Result>(
  input: CloudStorageAccess & { url: unknown; signal?: AbortSignal },
  consume: (download: CloudStorageDownload) => Promise<Result>
): Promise<Result> => {
  const download = await openCloudStorageDownload(input);
  const closed = finished(download.body, { cleanup: true }).catch(() => {});
  const abort = () => download.body.destroy(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    input.signal?.throwIfAborted();
    const result = await consume(download);
    input.signal?.throwIfAborted();
    return result;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    download.body.destroy();
    await closed;
  }
};
