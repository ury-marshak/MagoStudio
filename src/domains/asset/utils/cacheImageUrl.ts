import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { readableDesktopStorageUrl } from "@/platform/rendererMediaAccess";

import { cacheGet } from "./cacheStorage";
import { downloadImageBlob } from "./downloadImageBlob";

const isFetchableAssetUrl = (url: string): boolean =>
  url.startsWith("https://");

/** The image mirror of `cacheVideoUrl`: read the blob from the local cache, or fetch it once
 * and write it back. `cacheKey` should be an asset id rather than a URL — the worker sanitises
 * a key down to `[a-zA-Z0-9_-]`, so two URLs can otherwise collide on one cached file.
 *
 * Mirrors its emptiness guard too: a render that has not landed can answer `200` with nothing
 * behind it, and storing that blank would outlive the render. */
export const cacheImageUrl = async (
  url: string,
  cacheKey: string
): Promise<{ urlToUse: string; isCached: boolean }> => {
  const work = rendererLibrary.capture();
  work.check();
  if (!isFetchableAssetUrl(url)) {
    return { urlToUse: readableDesktopStorageUrl(url), isCached: false };
  }

  try {
    const cachedBlob = await cacheGet("image", cacheKey, work);
    work.check();
    if (cachedBlob?.size) {
      return { urlToUse: URL.createObjectURL(cachedBlob), isCached: true };
    }

    const blob = await downloadImageBlob(url, cacheKey, work);
    work.check();
    if (!blob.size) {
      return { urlToUse: readableDesktopStorageUrl(url), isCached: false };
    }

    return { urlToUse: URL.createObjectURL(blob), isCached: true };
  } catch (error) {
    work.check();
    console.warn("Error downloading/caching image, using direct URL:", error);
    return { urlToUse: readableDesktopStorageUrl(url), isCached: false };
  }
};
