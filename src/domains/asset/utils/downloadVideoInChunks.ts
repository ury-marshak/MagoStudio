import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import {
  fetchRendererMedia,
  readableDesktopStorageUrl
} from "@/platform/rendererMediaAccess";

import { mediaDownloads } from "./mediaDownloadScheduler";
import { readMediaBlob, type MediaDownloadProgress } from "./readMediaBlob";

export const downloadVideoInChunks = async (
  url: string,
  onProgress?: (progress: MediaDownloadProgress) => void,
  assetId: string = url,
  signal?: AbortSignal,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<Blob> => {
  work.check();
  const read = (signal: AbortSignal) =>
    work.boundary(async () => {
      signal.throwIfAborted();
      const response = await fetchRendererMedia(
        readableDesktopStorageUrl(url),
        { signal }
      );
      return readMediaBlob(response, signal, onProgress, "video/mp4");
    });
  return signal
    ? read(AbortSignal.any([signal, work.signal]))
    : mediaDownloads.enqueue({
        key: `video:${assetId}`,
        assetId,
        kind: "video",
        work,
        run: read
      });
};
