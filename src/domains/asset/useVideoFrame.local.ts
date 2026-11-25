import { extractFrameFromVideo } from "@app/services/mediaBunny";
import { useQuery } from "@tanstack/react-query";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { useVideoAsset } from "./useVideoAsset";
import { getFrameFromCache, saveFrameToCache } from "./utils/frameCache";

interface UseVideoFrameProps {
  assetId?: string;
  selectedLayerId?: string;
  enabled?: boolean;
  frameNumber: number;
  fps?: number;
}

/** Local frames are decoded by bundled ffmpeg in Electron's main process. */
export function useVideoFrame({
  assetId,
  selectedLayerId,
  enabled = true,
  frameNumber,
  fps
}: UseVideoFrameProps) {
  const { work, libraryVersion } = useRendererLibraryWork();
  const {
    data: cachedFrame,
    isLoading: isCheckingCache,
    error: cacheError
  } = useQuery({
    queryKey: ["frame-cache", assetId, frameNumber, fps, libraryVersion],
    queryFn: () => getFrameFromCache(assetId!, frameNumber, fps, work),
    enabled: !work.signal.aborted && enabled && !!assetId,
    staleTime: Infinity,
    gcTime: Infinity
  });

  const hasCachedFrame = !!cachedFrame;
  const cacheChecked = !isCheckingCache;
  const { data: videoAsset, isLoading: isVideoAssetLoading } = useVideoAsset({
    assetId,
    selectedLayerId,
    enabled:
      !work.signal.aborted &&
      enabled &&
      cacheChecked &&
      !hasCachedFrame &&
      !!assetId
  });
  const videoUrl = (() => {
    if (!videoAsset) return undefined;
    if ("urlToUse" in videoAsset && videoAsset.urlToUse) {
      return videoAsset.urlToUse;
    }
    return undefined;
  })();
  const {
    data: generatedFrame,
    isLoading: isGenerating,
    error: generateError
  } = useQuery({
    queryKey: ["frame-generate", assetId, frameNumber, fps, libraryVersion],
    queryFn: async () => {
      await work.ready();
      work.check();
      const frame = videoUrl?.startsWith("mago-media:")
        ? await window.mago.assets.extractVideoFrame({
            assetId: assetId!,
            frameNumber,
            fps: fps!
          })
        : await extractFrameFromVideo(
            {
              videoSource: videoUrl!,
              frameNumber,
              fps
            },
            work
          );
      work.check();
      saveFrameToCache(assetId!, frameNumber, frame, fps, work).catch(() => {});
      return frame;
    },
    enabled:
      !work.signal.aborted &&
      enabled &&
      cacheChecked &&
      !hasCachedFrame &&
      !!assetId &&
      !!fps &&
      !!videoUrl,
    staleTime: Infinity,
    gcTime: Infinity
  });

  return {
    data: cachedFrame || generatedFrame || undefined,
    isLoading:
      isCheckingCache ||
      (!hasCachedFrame && (isVideoAssetLoading || isGenerating)),
    error: cacheError || generateError
  };
}
