/* oxlint-disable custom-react/no-use-effect -- legitimate useEffect for external sync */

import { useEffect, useState } from "react";

import { releaseRendererObjectUrl } from "@/platform/rendererObjectUrl";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { cacheImageUrl } from "../utils/cacheImageUrl";

import { useAssetDownloadPriority } from "./useAssetDownloadPriority";

interface CachedImage {
  sourceUrl: string;
  objectUrl: string;
  cacheKey: string;
  libraryVersion: number;
  lifetime: AbortSignal;
}

export const useCachedImageUrl = (
  imageUrl: string | undefined,
  cacheKey: string,
  enabled = true
): string | undefined => {
  const { work, libraryVersion } = useRendererLibraryWork();
  useAssetDownloadPriority(
    cacheKey.replace(/_thumb$/, ""),
    !work.signal.aborted && enabled && !!imageUrl
  );
  const [cachedImage, setCachedImage] = useState<CachedImage | undefined>(
    undefined
  );

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change, react-you-might-not-need-an-effect/no-derived-state -- async cache + objectURL sync, not derivable in render */
  useEffect(() => {
    if (!enabled || !imageUrl || work.signal.aborted) return;

    const lifetime = new AbortController();
    let acquiredUrl: string | undefined;
    const loadImage = async () => {
      try {
        const { urlToUse } = await cacheImageUrl(imageUrl, cacheKey, work);
        acquiredUrl = urlToUse;
        if (lifetime.signal.aborted || work.signal.aborted) {
          releaseRendererObjectUrl(urlToUse);
          return;
        }
        setCachedImage({
          sourceUrl: imageUrl,
          objectUrl: urlToUse,
          cacheKey,
          libraryVersion,
          lifetime: lifetime.signal
        });
      } catch (error) {
        if (!lifetime.signal.aborted && !work.signal.aborted)
          console.warn("Failed to load image:", error);
      }
    };

    void loadImage();
    return () => {
      lifetime.abort();
      if (acquiredUrl) releaseRendererObjectUrl(acquiredUrl);
    };
  }, [imageUrl, cacheKey, enabled, work, libraryVersion]);
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change, react-you-might-not-need-an-effect/no-derived-state */

  if (
    !enabled ||
    work.signal.aborted ||
    cachedImage?.libraryVersion !== libraryVersion ||
    cachedImage.lifetime.aborted ||
    cachedImage.cacheKey !== cacheKey ||
    cachedImage.sourceUrl !== imageUrl
  )
    return undefined;

  return cachedImage.objectUrl;
};
