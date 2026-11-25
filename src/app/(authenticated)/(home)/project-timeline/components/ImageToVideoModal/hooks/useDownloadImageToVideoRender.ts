import { isCloudMirroredAssetCachedLocally } from "@domains/asset/utils/isCloudMirroredAssetCachedLocally";
import { getTrackAssetId } from "@domains/track/utils/getTrackAssetId";
import { isTrackOwnedByCloud } from "@domains/track/utils/isTrackOwnedByCloud";
import { downloadLayerVideo } from "@hooks/files/downloadFiles";
import { saveLayerDownloadToDisk } from "@hooks/files/saveLayerDownloadToDisk";
import { saveTrackVideoToDisk } from "@hooks/files/saveTrackVideoToDisk";
import { triggerBlobDownload } from "@hooks/files/utils";
import { sanitizeDownloadFilename } from "@hooks/files/utils/sanitizeDownloadFilename";
import { trackingUtils } from "@hooks/tracking/trackingUtils";
import { Layer } from "@schemas/layer";
import { useToast } from "@store/useToast";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";

export const useDownloadImageToVideoRender = (
  track: Layer,
  projectId: string | undefined
) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { work } = useRendererLibraryWork();
  const [downloadingWork, setDownloadingWork] = useState<typeof work | null>(
    null
  );
  const isDownloadingRenderVideo =
    downloadingWork === work && !work.signal.aborted;

  const downloadRenderVideo = async () => {
    if (work.signal.aborted) return;
    setDownloadingWork(work);

    try {
      await work.ready();
      work.check();
      const fileName = `${sanitizeDownloadFilename(track.name)}.mp4`;
      if (!isLocalApp) {
        const videoBlob = await downloadLayerVideo({ layerId: track.id });
        work.check();
        triggerBlobDownload(videoBlob, fileName);
      } else {
        const isTrackStoredInCloud = await isTrackOwnedByCloud({
          projectId,
          trackId: track.id
        });
        work.check();
        const trackAssetId = getTrackAssetId(track);
        const mirroredTrackAsset =
          isTrackStoredInCloud && trackAssetId
            ? await getLocalDesktopApi().assets.get(trackAssetId)
            : null;
        work.check();
        const isCloudRenderVideoOnlyInCloud =
          isTrackStoredInCloud &&
          !isCloudMirroredAssetCachedLocally(mirroredTrackAsset);
        if (isCloudRenderVideoOnlyInCloud) {
          await saveLayerDownloadToDisk(
            {
              layerId: track.id,
              kind: "video",
              suggestedName: fileName
            },
            work
          );
        } else {
          await saveTrackVideoToDisk({ track, fileName }, work);
        }
      }
      work.check();
      trackingUtils.exportActions.exportMedias({
        trackId: track.id,
        assetId: getTrackAssetId(track) ?? "",
        trackOrder: track.layer_order,
        trigger: "track_download_icon",
        exportType: "video"
      });
    } catch {
      if (work.signal.aborted) return;
      showToast({
        message: t("projectTimeline.imageToVideo.downloadFailed.label")
      });
    } finally {
      if (!work.signal.aborted) setDownloadingWork(null);
    }
  };

  return { downloadRenderVideo, isDownloadingRenderVideo };
};
