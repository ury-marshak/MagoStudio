/* oxlint-disable custom-react/no-use-effect -- legitimate useEffect for external sync */

import { useEffect, useState } from "react";

import { releaseRendererObjectUrl } from "@/platform/rendererObjectUrl";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { cacheVideoUrl } from "../utils/cacheVideoUrl";

interface CachedVideo {
  sourceUrl: string;
  objectUrl: string;
  libraryVersion: number;
  lifetime: AbortSignal;
}

export const useCachedVideoUrl = (
  videoUrl: string | undefined
): string | undefined => {
  const { work, libraryVersion } = useRendererLibraryWork();
  const [cachedVideo, setCachedVideo] = useState<CachedVideo | undefined>(
    undefined
  );

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change, react-you-might-not-need-an-effect/no-derived-state -- async cache + objectURL sync, not derivable in render */
  useEffect(() => {
    if (!videoUrl || work.signal.aborted) return;

    const lifetime = new AbortController();
    let acquiredUrl: string | undefined;
    const loadVideo = async () => {
      try {
        const { urlToUse } = await cacheVideoUrl(videoUrl, videoUrl, work);
        acquiredUrl = urlToUse;
        if (lifetime.signal.aborted || work.signal.aborted) {
          releaseRendererObjectUrl(urlToUse);
          return;
        }
        setCachedVideo({
          sourceUrl: videoUrl,
          objectUrl: urlToUse,
          libraryVersion,
          lifetime: lifetime.signal
        });
      } catch (error) {
        if (!lifetime.signal.aborted && !work.signal.aborted)
          console.warn("Failed to load video:", error);
      }
    };

    void loadVideo();
    return () => {
      lifetime.abort();
      if (acquiredUrl) releaseRendererObjectUrl(acquiredUrl);
    };
  }, [videoUrl, work, libraryVersion]);
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change, react-you-might-not-need-an-effect/no-derived-state */

  if (
    work.signal.aborted ||
    cachedVideo?.libraryVersion !== libraryVersion ||
    cachedVideo.lifetime.aborted ||
    cachedVideo.sourceUrl !== videoUrl
  ) {
    return undefined;
  }

  return cachedVideo.objectUrl;
};
