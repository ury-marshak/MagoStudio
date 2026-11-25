import { fetchFileBypassingPlaybackCache } from "@app/utils/files/fetchFileBypassingPlaybackCache";
import { getTrackAssetId } from "@domains/track/utils/getTrackAssetId";
import { getTrackDuration } from "@domains/track/utils/getTrackDuration";
import { getTrackRenderSettings } from "@domains/track/utils/getTrackRenderSettings";
import { isTrackAssetFinished } from "@domains/track/utils/isTrackAssetFinished";
import { isTrackMirroredFromCloud } from "@domains/track/utils/isTrackMirroredFromCloud";
import { trackingUtils } from "@hooks/tracking/trackingUtils";
import { RENDER_MODELS } from "@models/video/constants";
import { IMAGE_SEQUENCE_EXPORT } from "@models/video/types";
import { Layer, LayerType } from "@schemas/layer";

import { isCloudAccountActive } from "@/platform/cloudAccount";
import { isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { readableDesktopStorageUrl } from "@/platform/rendererMediaAccess";

import { downloadLayerVideo } from "./downloadFiles";
import { saveLayerDownloadToDisk } from "./saveLayerDownloadToDisk";
import { saveTrackVideoToDisk } from "./saveTrackVideoToDisk";
import { sanitizeDownloadFilename } from "./utils/sanitizeDownloadFilename";
import { withImageExtensionMatchingContentType } from "./utils/withImageExtensionMatchingContentType";

export const triggerBlobDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const hasMultipleFrames = (track: Layer) => (getTrackDuration(track) || 0) > 1;

const isRenderLayer = (track: Layer) =>
  track.type.toLocaleLowerCase() === LayerType.RENDER.toLocaleLowerCase();

const hasFrames = (track: Layer) => track.clips && track.clips.length > 0;

const getTrackMagoEngine = (track: Layer): string | undefined =>
  getTrackRenderSettings(track)?.mago_engine as string | undefined;

const getModelForTrack = (track: Layer) => {
  const magoEngine = getTrackMagoEngine(track);
  return RENDER_MODELS.find((m) => m.name === magoEngine);
};

const isDownloadDisabled = (
  track: Layer,
  downloadType: "video" | "frames" | "video+frames"
): boolean => {
  const model = getModelForTrack(track);
  return model?.disableDownload?.includes(downloadType) ?? false;
};

const getTrackImageSequenceExport = (track: Layer): string | undefined => {
  const settings = getTrackRenderSettings(track);
  if (!settings) return undefined;

  if ("convert_exrs_to_pngs" in settings) {
    return settings.convert_exrs_to_pngs === false
      ? IMAGE_SEQUENCE_EXPORT.EXR_16BIT
      : IMAGE_SEQUENCE_EXPORT.PNG;
  }

  return settings.image_sequence_export as string | undefined;
};

export const isEXRRender = (track: Layer): boolean => {
  return getTrackImageSequenceExport(track) === IMAGE_SEQUENCE_EXPORT.EXR_16BIT;
};

const isTrackDownloadableFromCloud = (track: Layer): boolean =>
  isCloudAccountActive() && isTrackMirroredFromCloud(track);

export const isEXRDownloadable = (track: Layer): boolean => {
  if (!isTrackDownloadableFromCloud(track)) return false;
  return (
    isRenderLayer(track) && isTrackAssetFinished(track) && isEXRRender(track)
  );
};

export const areFramesDownloadable = (track: Layer) => {
  if (!isTrackDownloadableFromCloud(track)) return false;
  if (isDownloadDisabled(track, "frames")) return false;
  if (isEXRRender(track)) return false;
  return (
    isRenderLayer(track) && hasFrames(track) && isTrackAssetFinished(track)
  );
};

export const areVideoAndFramesDownloadable = (track: Layer) => {
  if (!isTrackDownloadableFromCloud(track)) return false;
  if (isDownloadDisabled(track, "video+frames")) return false;
  if (isEXRRender(track)) return false;
  const isFinished = isTrackAssetFinished(track);
  const multipleFrames = hasMultipleFrames(track);
  return isFinished && multipleFrames;
};

export const isVideoDownloadable = (track: Layer) => {
  if (isDownloadDisabled(track, "video")) return false;
  const isFinished = isTrackAssetFinished(track);
  const multipleFrames = hasMultipleFrames(track);
  return isFinished && multipleFrames;
};

type TrackDownload = {
  track: Layer;
  setIsDownloading: (value: boolean) => void;
  onError?: (error: unknown) => void;
};

type TrackDownloadTrigger = "track_download_icon" | "track_three_dots_dropdown";

const runTrackDownload = async (
  { track, setIsDownloading, onError }: TrackDownload,
  trigger: TrackDownloadTrigger,
  exportType: "frames" | "frames_and_video" | "video" | "exr",
  download: (work: RendererLibraryWork) => Promise<unknown>
) => {
  const work = rendererLibrary.capture();
  if (work.signal.aborted) return;
  const stop = () => setIsDownloading(false);
  work.signal.addEventListener("abort", stop, { once: true });
  try {
    setIsDownloading(true);
    await work.ready();
    work.check();
    await download(work);
  } catch (error) {
    if (!work.signal.aborted) {
      console.error(`Error downloading ${exportType}:`, error);
      onError?.(error);
    }
  } finally {
    work.signal.removeEventListener("abort", stop);
    if (!work.signal.aborted) {
      trackingUtils.exportActions.exportMedias({
        trackId: track.id,
        assetId: getTrackAssetId(track) ?? "",
        trackOrder: track.layer_order,
        trigger,
        exportType
      });
      stop();
    }
  }
};

export const handleDownloadFrames = async (
  input: TrackDownload & { trigger: TrackDownloadTrigger }
) => {
  const { track, trigger } = input;
  if (!isRenderLayer(track) || !hasFrames(track)) return;
  await runTrackDownload(input, trigger, "frames", (work) =>
    saveLayerDownloadToDisk(
      {
        layerId: track.id,
        kind: "frames",
        suggestedName: `${sanitizeDownloadFilename(track.name)}_frames.zip`
      },
      work
    )
  );
};

export const handleDownloadVideoAndFramesZip = async (input: TrackDownload) => {
  const { track } = input;
  if (!isVideoDownloadable(track)) return;
  await runTrackDownload(
    input,
    "track_three_dots_dropdown",
    "frames_and_video",
    (work) =>
      saveLayerDownloadToDisk(
        {
          layerId: track.id,
          kind: "assets",
          suggestedName: `${sanitizeDownloadFilename(track.name)}_video.zip`
        },
        work
      )
  );
};

export const handleDownloadVideo = async (
  input: TrackDownload & { projectName: string; trigger: TrackDownloadTrigger }
) => {
  const { track, trigger, projectName } = input;
  if (!isVideoDownloadable(track)) return;
  await runTrackDownload(input, trigger, "video", async (work) => {
    const fileName = `${sanitizeDownloadFilename(projectName)}_${sanitizeDownloadFilename(track.name)}.mp4`;
    if (isLocalApp) {
      await saveTrackVideoToDisk({ track, fileName }, work);
    } else {
      const blob = await downloadLayerVideo({ layerId: track.id });
      work.check();
      triggerBlobDownload(blob, fileName);
    }
  });
};

export const handleDownloadEXR = async (input: TrackDownload) => {
  const { track } = input;
  if (!isEXRDownloadable(track)) return;
  await runTrackDownload(input, "track_three_dots_dropdown", "exr", (work) =>
    saveLayerDownloadToDisk(
      {
        layerId: track.id,
        kind: "exr",
        suggestedName: `${sanitizeDownloadFilename(track.name)}_exr.zip`
      },
      work
    )
  );
};

export const downloadFile = async (url: string, filename: string) => {
  const work = rendererLibrary.capture();
  try {
    await work.ready();
  } catch (error) {
    if (work.signal.aborted) return;
    throw error;
  }
  const readableUrl = readableDesktopStorageUrl(url);
  try {
    const response = await fetchFileBypassingPlaybackCache(
      readableUrl,
      work.signal
    );
    work.check();
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const blob = await response.blob();
    work.check();
    triggerBlobDownload(
      blob,
      withImageExtensionMatchingContentType(filename, blob.type)
    );
  } catch (error) {
    if (work.signal.aborted) return;
    console.error("Error downloading file:", error);
    const link = document.createElement("a");
    link.href = readableDesktopStorageUrl(url);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};
