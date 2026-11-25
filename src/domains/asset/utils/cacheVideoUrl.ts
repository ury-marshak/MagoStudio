import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { readableDesktopStorageUrl } from "@/platform/rendererMediaAccess";
import { createRendererObjectUrl } from "@/platform/rendererObjectUrl";

import { getCachedVideoBlob } from "./getCachedVideoBlob";

/** A render that has not landed can answer `200` with nothing behind it, and a read taken
 * mid-write can stop short. An empty body is left uncached and the direct URL handed back, so
 * the next attempt sees the finished video rather than a stored blank. */
export const cacheVideoUrl = async (
  url: string,
  cacheKey: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<{ urlToUse: string; isCached: boolean }> => {
  try {
    const blob = await getCachedVideoBlob(url, cacheKey, work);
    work.check();

    const blobUrl = createRendererObjectUrl(blob, work);
    return { urlToUse: blobUrl, isCached: true };
  } catch (error) {
    work.check();
    console.warn("Error downloading/caching video, using direct URL:", error);
    return { urlToUse: readableDesktopStorageUrl(url), isCached: false };
  }
};
