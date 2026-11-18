import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";
import { usePublishVideoIngestionJob } from "@hooks/assets/usePublishVideoIngestionJob";
import { useAuth } from "@platform/identity";
import { useQueryClient } from "@tanstack/react-query";

import { isCloudAccountActive } from "@/platform/cloudAccount";
import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { getVideoAsset } from "../asset/getVideoAsset";
import { useCreateVideoAsset } from "../asset/useCreateVideoAsset";
import { useUploadAsset } from "../asset/useUploadAsset";
import { cacheSet } from "../asset/utils/cacheStorage";
import { handleVideoAssetCreation } from "../shot/handleVideoAssetCreation";

import { ingestVideo } from "./ingestVideo";
import { IngestVideoParams, IngestVideoResult } from "./types";
import { getIngestInvalidationKeys } from "./utils/getIngestInvalidationKeys";
import { waitForPollTick } from "./utils/waitForPollTick";

export const useIngestVideo = () => {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const { mutateAsync: createVideoAsset } = useCreateVideoAsset();
  const { mutateAsync: uploadAssetToS3 } = useUploadAsset();
  const { mutateAsync: publishIngestionJob } = usePublishVideoIngestionJob();

  const runIngestVideo = (
    params: IngestVideoParams,
    work = rendererLibrary.capture()
  ): Promise<IngestVideoResult> =>
    ingestVideo(
      params,
      {
        createVideoAsset: async ({ file, shotId, signal }) => {
          const creation = await handleVideoAssetCreation({
            selectedFile: file,
            selectedShotId: shotId,
            createVideoAsset,
            signal
          });

          if (!creation) throw new Error("Error creating video asset");
          return creation;
        },
        uploadAssetToS3,
        publishIngestionJob: (assetId, signal) =>
          publishIngestionJob({ assetId, signal }),
        fetchVideoAssetStatus: async (assetId, signal) => {
          if (!isCloudAccountActive()) return undefined;
          let clerkToken: string | null;
          try {
            clerkToken = await getToken({ template: "basicToken" });
          } catch {
            return undefined;
          }
          signal.throwIfAborted();
          if (!clerkToken) return undefined;
          return getVideoAsset({ assetId, clerkToken, signal });
        },
        invalidateAfterIngest: async (projectId, signal) => {
          // Invalidation may be detached. It still owns the same library, not
          // whichever library is active when metadata mirroring completes.
          try {
            await syncCloudProjectMetadata(projectId, work);
          } catch (error) {
            work.check();
            signal.throwIfAborted();
            console.warn(`Failed to mirror cloud project ${projectId}`, error);
          }
          work.check();
          signal.throwIfAborted();
          await Promise.all(
            getIngestInvalidationKeys(projectId).map((queryKey) =>
              queryClient.invalidateQueries({ queryKey })
            )
          );
        },
        cacheVideoFile: (assetId, file) =>
          cacheSet("video", assetId, file, work),
        waitForPollTick
      },
      work
    );

  return { ingestVideo: runIngestVideo };
};
