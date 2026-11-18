import { LayerType } from "@schemas/layer";
import { getLatestVideoLayer } from "@utils";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { getTrackAsset } from "../track/utils/getTrackAsset";

import {
  INGESTION_TIMEOUT_MS,
  POLL_TICK_INTERVAL_MS,
  REFETCH_VIDEO_ASSET_DATA_INTERVAL,
  UPLOAD_PROGRESS_COMPLETE,
  UPLOAD_PROGRESS_PART_IN_TOTAL_LOADING
} from "./constants";
import { IngestVideoDeps, IngestVideoParams, IngestVideoResult } from "./types";
import { buildTrimMetadataFile } from "./utils/buildTrimMetadataFile";
import {
  composeAbortSignals,
  isTimeoutAbort
} from "./utils/composeAbortSignals";
import { getAssetIngestionError } from "./utils/getAssetIngestionError";
import { getEasedIngestionProgress } from "./utils/getEasedIngestionProgress";
import { getTransferProgress } from "./utils/getTransferProgress";
import { isAssetIngested } from "./utils/isAssetIngested";

const CANCELLED: IngestVideoResult = { outcome: "cancelled" };

export const ingestVideo = async (
  params: IngestVideoParams,
  deps: IngestVideoDeps,
  work = rendererLibrary.capture()
): Promise<IngestVideoResult> => {
  const {
    shotId,
    projectId,
    file,
    trimMetadata,
    signal,
    awaitInvalidation = true,
    onProgress,
    onUploaded
  } = params;

  if (work.signal.aborted || signal?.aborted) return CANCELLED;

  const { signal: ingestSignal, release } = composeAbortSignals(
    signal ? AbortSignal.any([work.signal, signal]) : work.signal,
    INGESTION_TIMEOUT_MS
  );
  const check = () => ingestSignal.throwIfAborted();
  let transferring = false;

  try {
    await work.ready();
    check();
    onProgress?.({ phase: "creating", progress: 0 });
    check();

    const creation = await deps.createVideoAsset({
      file,
      shotId,
      signal: ingestSignal
    });
    check();

    if (trimMetadata) {
      await deps.uploadAssetToS3({
        s3_url: creation.meta_url,
        file: buildTrimMetadataFile(trimMetadata),
        signal: ingestSignal
      });
      check();
    }

    const hasImageTrack = creation.timeline.layers.some(
      (layer) => layer.type === LayerType.IMAGE
    );
    const videoTrack = getLatestVideoLayer(creation.timeline.layers);
    if (!hasImageTrack || !videoTrack) {
      throw new Error("Video layer not found");
    }

    const createdAsset = getTrackAsset(videoTrack);
    if (!createdAsset) {
      throw new Error("Video asset not found");
    }
    const assetId = createdAsset.id;

    onProgress?.({ phase: "uploading", progress: 0 });
    check();

    // Do not add this IPC to the renderer acknowledgement drain. Main owns
    // the issued transfer; the caller signal can independently request its
    // cancellation while main is still serving the old library.
    transferring = true;
    await deps.uploadAssetToS3({
      s3_url: creation.video_url,
      file,
      signal: ingestSignal,
      onUploadProgress: (transferPercent) => {
        if (!transferring || ingestSignal.aborted) return;
        onProgress?.({
          phase: "uploading",
          progress: getTransferProgress(transferPercent)
        });
      }
    });
    transferring = false;
    check();

    onProgress?.({
      phase: "uploading",
      progress: UPLOAD_PROGRESS_PART_IN_TOTAL_LOADING
    });
    check();

    void deps.cacheVideoFile(assetId, file).catch((error) => {
      if (!work.signal.aborted) console.warn("Failed to cache video:", error);
    });

    check();
    onUploaded?.({ trackId: videoTrack.id, trackName: videoTrack.name });
    check();

    onProgress?.({
      phase: "ingesting",
      progress: UPLOAD_PROGRESS_PART_IN_TOTAL_LOADING
    });
    check();

    await deps.publishIngestionJob(assetId, ingestSignal);
    check();
    await pollUntilIngested({ assetId, ingestSignal, deps, onProgress });
    check();

    onProgress?.({ phase: "finalizing", progress: UPLOAD_PROGRESS_COMPLETE });
    check();

    const invalidation = deps.invalidateAfterIngest(projectId, ingestSignal);
    if (awaitInvalidation) {
      await invalidation;
      check();
    } else {
      void invalidation.catch(() => {});
    }

    return { outcome: "ingested", assetId, trackId: videoTrack.id };
  } catch (error) {
    if (work.signal.aborted) return CANCELLED;
    if (isTimeoutAbort(ingestSignal)) throw ingestSignal.reason;
    if (ingestSignal.aborted) return CANCELLED;
    throw error;
  } finally {
    transferring = false;
    release();
  }
};

const pollUntilIngested = async ({
  assetId,
  ingestSignal,
  deps,
  onProgress
}: {
  assetId: string;
  ingestSignal: AbortSignal;
  deps: IngestVideoDeps;
  onProgress: IngestVideoParams["onProgress"];
}): Promise<void> => {
  let elapsedMs = 0;
  let msSinceLastRefetch = 0;

  for (;;) {
    ingestSignal.throwIfAborted();
    onProgress?.({
      phase: "ingesting",
      progress: Math.round(getEasedIngestionProgress(elapsedMs))
    });
    ingestSignal.throwIfAborted();

    await deps.waitForPollTick(POLL_TICK_INTERVAL_MS, ingestSignal);
    ingestSignal.throwIfAborted();

    elapsedMs += POLL_TICK_INTERVAL_MS;
    msSinceLastRefetch += POLL_TICK_INTERVAL_MS;

    if (msSinceLastRefetch < REFETCH_VIDEO_ASSET_DATA_INTERVAL) continue;
    msSinceLastRefetch = 0;

    const assetResponse = await deps.fetchVideoAssetStatus(
      assetId,
      ingestSignal
    );
    ingestSignal.throwIfAborted();
    if (assetResponse === undefined) {
      throw new Error("Failed to fetch video asset status");
    }

    const ingestionError = getAssetIngestionError(assetResponse);
    if (ingestionError) {
      throw new Error(ingestionError);
    }

    if (isAssetIngested(assetResponse)) return;
  }
};
