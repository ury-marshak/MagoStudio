import { PERCENTAGE_MULTIPLIER } from "@constants";

import { getLocalDesktopApi } from "@/platform/localDesktop";

/** Desktop version of the S3 upload. The renderer's origin is not allowed by
 * the bucket's CORS policy, so the bytes are handed to the main process, which
 * PUTs them to the presigned URL instead of the browser doing it. */
export const uploadAssetToS3 = async (params: {
  s3_url: string;
  file: File;
  onUploadProgress?: (progress: number) => void;
  signal?: AbortSignal;
}): Promise<void> => {
  const { s3_url, file, onUploadProgress, signal } = params;
  signal?.throwIfAborted();
  const cloud = getLocalDesktopApi().cloud;
  const bytes = await file.arrayBuffer();
  // Cancellation during the read must not send a cancel before a later PUT.
  signal?.throwIfAborted();
  const uploadId = crypto.randomUUID();
  const unsubscribe = cloud.onUploadProgress(({ assetId, fraction }) => {
    if (signal?.aborted || assetId !== uploadId) return;
    onUploadProgress?.(Math.round(fraction * PERCENTAGE_MULTIPLIER));
  });
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    // A suspended main session can refuse this IPC. The upload's result
    // remains authoritative; still await any issued cancellation cleanup.
    cancellation = cloud.cancelUploadBytes(uploadId).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await cloud.uploadBytes({
      uploadId,
      presignedUrl: s3_url,
      contentType: file.type || "application/octet-stream",
      bytes
    });
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", cancel);
    unsubscribe();
    await cancellation;
  }
};
