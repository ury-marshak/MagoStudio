import { composeSbsVideo, EncodingProgress } from "@app/services/mediaBunny";
import { useVideoAsset } from "@domains/asset/useVideoAsset";
import { resolveVideoAssetUrl } from "@domains/asset/utils/resolveVideoAssetUrl";
import { useSelectedProjectId } from "@domains/project/useSelectedProjectId";
import { useSelectedShotId } from "@domains/shot/useSelectedShotId";
import { useFilteredAndSortedTracks } from "@domains/track/useFilteredAndSortedTracks";
import { useGetTracksById } from "@domains/track/useGetTracksById";
import { frameRangeOf } from "@domains/track/utils/frameCoordinates";
import { getTrackAssetData } from "@domains/track/utils/getTrackAssetData";
import { getTrackAssetId } from "@domains/track/utils/getTrackAssetId";
import { getTrackCropSettings } from "@domains/track/utils/getTrackCropSettings";
import { isRenderOutputTrack } from "@domains/track/utils/isRenderOutputTrack";
import { isTrackAssetFinished } from "@domains/track/utils/isTrackAssetFinished";
import { useFpsForShot } from "@domains/videoPlayer/useFpsForShot";
import { trackingUtils } from "@hooks/tracking/trackingUtils";
import { Layer } from "@schemas/layer";
import { useToast } from "@store/useToast";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

import { triggerBlobDownload } from "./utils";
import { sanitizeDownloadFilename } from "./utils/sanitizeDownloadFilename";

export const useDownloadSbsVideo = ({ trackId }: { trackId: Layer["id"] }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { work } = useRendererLibraryWork();
  const [downloadingWork, setDownloadingWork] = useState<typeof work | null>(
    null
  );
  const [progress, setProgress] = useState(0);
  const isDownloading = downloadingWork === work && !work.signal.aborted;

  const selectedProjectId = useSelectedProjectId();
  const { selectedShotId } = useSelectedShotId();

  const { data: filteredTracks } = useFilteredAndSortedTracks();
  const { videoTrack } = filteredTracks;

  const subjectTrack = useGetTracksById({
    trackIds: [trackId],
    selectedProjectId,
    selectedShotId
  }).data[0];

  const isRenderTrack = isRenderOutputTrack(subjectTrack);
  const isFinished = isTrackAssetFinished(subjectTrack);
  const isCroppedRender = !!getTrackCropSettings(subjectTrack);
  const inputAssetId = getTrackAssetId(videoTrack);
  const renderAssetId = getTrackAssetId(subjectTrack);

  const inputVideoAssetQuery = useVideoAsset({
    assetId: inputAssetId,
    selectedLayerId: videoTrack?.id,
    enabled: false
  });

  const renderVideoAssetQuery = useVideoAsset({
    assetId: renderAssetId,
    selectedLayerId: subjectTrack?.id,
    enabled: false
  });

  const frameRange = subjectTrack ? frameRangeOf(subjectTrack) : [0, 0];
  const trackName = subjectTrack?.name;
  const videoSize = getTrackAssetData(subjectTrack)?.size;
  const { fps } = useFpsForShot();

  const videoRatio = videoSize
    ? videoSize[0] && videoSize[1] && videoSize[0] > videoSize[1]
      ? "16:9"
      : "9:16"
    : undefined;

  const canDownload =
    !!subjectTrack &&
    isRenderTrack &&
    isFinished &&
    !isCroppedRender &&
    !!frameRange &&
    !!videoRatio &&
    !!trackName &&
    !!fps &&
    (!isLocalApp || (!!inputAssetId && !!renderAssetId)) &&
    frameRange.length === 2;
  const downloadSbsVideo = async () => {
    if (work.signal.aborted) return;
    if (
      !subjectTrack ||
      !frameRange ||
      !trackName ||
      !videoRatio ||
      (isLocalApp && (!inputAssetId || !renderAssetId))
    ) {
      console.warn("Missing required data for SBS video download");
      return;
    }

    setDownloadingWork(work);
    setProgress(0);
    try {
      await work.ready();
      work.check();

      if (isLocalApp) {
        const requestId = crypto.randomUUID();
        const unsubscribe = window.mago.files.onSbsExportProgress((event) => {
          if (!work.signal.aborted && event.requestId === requestId) {
            setProgress(event.percentage);
          }
        });
        const stop = () => unsubscribe();
        work.signal.addEventListener("abort", stop, { once: true });
        try {
          const saved = await window.mago.files.exportSbsVideo({
            requestId,
            inputAssetId: inputAssetId!,
            renderAssetId: renderAssetId!,
            startFrame: frameRange[0],
            endFrame: frameRange[1],
            fps,
            suggestedName: `${sanitizeDownloadFilename(trackName)}_sbs_comparison.mp4`
          });
          if (!saved) return;
        } finally {
          work.signal.removeEventListener("abort", stop);
          if (!work.signal.aborted) stop();
        }
      } else {
        const [inputVideoResult, renderVideoResult] = await Promise.all([
          inputVideoAssetQuery.refetch(),
          renderVideoAssetQuery.refetch()
        ]);
        work.check();
        const inputVideoUrl = resolveVideoAssetUrl(inputVideoResult.data);
        const renderVideoUrl = resolveVideoAssetUrl(renderVideoResult.data);
        if (!inputVideoUrl || !renderVideoUrl) {
          throw new Error(
            "Missing input or render video url for SBS video download"
          );
        }

        const videoBlob = await composeSbsVideo({
          inputVideoUrl,
          renderVideoUrl,
          startFrame: frameRange[0],
          endFrame: frameRange[1],
          fps,
          onProgress: (progressInfo: EncodingProgress) => {
            if (!work.signal.aborted) setProgress(progressInfo.percentage);
          }
        });

        work.check();
        triggerBlobDownload(
          videoBlob,
          `${sanitizeDownloadFilename(trackName)}_sbs_comparison.mp4`
        );
      }

      work.check();
      trackingUtils.exportActions.downloadSbsVideo({
        trackId,
        videoRatio
      });
    } catch (error) {
      if (work.signal.aborted) return;
      console.error("Error downloading SBS video:", error);
      showToast({
        message: t("notifications.sbs_video_download_failed.description")
      });
    } finally {
      if (!work.signal.aborted) {
        setDownloadingWork(null);
        setProgress(0);
      }
    }
  };
  return {
    downloadSbsVideo,
    isDownloading,
    canDownload,
    isCroppedRender,
    progress: isDownloading ? progress : 0
  };
};
