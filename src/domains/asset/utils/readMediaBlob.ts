const PERCENTAGE_MULTIPLIER = 100;

export interface MediaDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  percentage: number;
}

/** Fetch abort alone is not a body-lifetime boundary (or honoured by every
 * transport). Keep the slot until actual reader cancellation has completed. */
export async function readMediaBlob(
  response: Response,
  signal: AbortSignal,
  onProgress?: (progress: MediaDownloadProgress) => void,
  fallbackType = "application/octet-stream"
): Promise<Blob> {
  if (signal.aborted) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Failed to fetch media: ${response.status}`);
  }
  if (!response.body) {
    const blob = await response.blob();
    signal.throwIfAborted();
    return blob;
  }
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const totalBytes = Number(response.headers.get("content-length")) || 0;
  let receivedBytes = 0;
  let complete = false;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(new Uint8Array(value));
      receivedBytes += value.length;
      if (totalBytes > 0)
        onProgress?.({
          receivedBytes,
          totalBytes,
          percentage: (receivedBytes / totalBytes) * PERCENTAGE_MULTIPLIER
        });
    }
    complete = true;
    return new Blob(chunks, {
      type: response.headers.get("content-type") || fallbackType
    });
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    await cancellation;
    reader.releaseLock();
  }
}
