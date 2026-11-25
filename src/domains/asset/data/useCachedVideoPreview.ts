import { useQuery } from "@tanstack/react-query";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { isLocalVideoUrl } from "../utils/isLocalVideoUrl";
import { DOWNLOAD_PRIORITY } from "../utils/mediaDownloadScheduler";
import { resolveCachedVideoPreview } from "../utils/resolveCachedVideoPreview";

import { useAssetDownloadPriority } from "./useAssetDownloadPriority";

interface UseCachedVideoPreviewProps {
  assetId: string | null | undefined;
  videoUrl: string | null | undefined;
  fps: number;
  enabled?: boolean;
  loadVideo?: boolean;
  priority?: number;
}

export const useCachedVideoPreview = ({
  assetId,
  videoUrl,
  fps,
  enabled = true,
  loadVideo = true,
  priority = DOWNLOAD_PRIORITY.visible
}: UseCachedVideoPreviewProps): {
  videoFirstFrameUrl: string | undefined;
  playableVideoUrl: string | undefined;
  isLoading: boolean;
  isError: boolean;
  isVideoAvailable: boolean;
} => {
  const { work, libraryVersion } = useRendererLibraryWork();
  const active = !work.signal.aborted;
  useAssetDownloadPriority(assetId, active && enabled && !!videoUrl, priority);
  const {
    data: preview,
    isLoading,
    isError
  } = useQuery({
    queryKey: [
      "cached-video-preview",
      assetId,
      fps,
      loadVideo,
      isLocalVideoUrl(videoUrl),
      libraryVersion
    ],
    queryFn: () =>
      resolveCachedVideoPreview(
        {
          assetId: assetId!,
          videoUrl: videoUrl!,
          fps,
          loadVideo
        },
        work
      ),
    enabled: active && enabled && !!assetId && !!videoUrl,
    staleTime: Infinity,
    gcTime: Infinity
  });

  return {
    isVideoAvailable:
      active &&
      (isLocalVideoUrl(videoUrl) || preview?.isVideoAvailable === true),
    isLoading,
    isError,
    videoFirstFrameUrl: preview?.firstFrameUrl ?? undefined,
    playableVideoUrl:
      active && loadVideo
        ? (preview?.videoObjectUrl ??
          (isLocalVideoUrl(videoUrl) ? videoUrl : undefined))
        : undefined
  };
};
