import { useAuth } from "@platform/identity";
import { useQuery } from "@tanstack/react-query";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { releaseRendererObjectUrl } from "@/platform/rendererObjectUrl";
import { queryKeys } from "@/queryKeys";

import { getVideoAsset } from "../api/getVideoAsset";
import {
  VideoAssetIngestionSuccess,
  VideoAssetResponse
} from "../api/interface";
import { cacheVideoUrl } from "../utils/cacheVideoUrl";
import { createUnresolvedAssetRefetchInterval } from "../utils/createUnresolvedAssetRefetchInterval";
import { getVideoAssetUrl } from "../utils/getVideoAssetUrl";

import { useAssetDownloadPriority } from "./useAssetDownloadPriority";

const MAX_RETRY_DELAY_MS = 10000;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
const MAX_RETRY_COUNT = 5;
const UNRESOLVED_VIDEO_ASSET_POLL_INTERVAL_MS = 5000;

export const useGetVideoAsset = ({
  assetId,
  selectedLayerId,
  enabled = true,
  priority
}: {
  assetId?: string;
  selectedLayerId?: string;
  enabled?: boolean;
  priority?: number;
}) => {
  const scope = useRendererLibraryQueryScope();
  const isEnabled = scope.active && !!assetId && enabled;
  useAssetDownloadPriority(assetId, isEnabled, priority);
  const { getToken } = useAuth();

  const queryKey = scope.key(queryKeys.videoAsset.byId(assetId));
  const queryFn = () =>
    scope.run(async () => {
      if (!assetId) return;

      if (window.mago) {
        const asset = await window.mago.assets.get(assetId);
        scope.work.check();
        if (asset) {
          // A cloud video whose file has not been downloaded yet has no bytes
          // behind its URL. Handing the URL out anyway makes the player and the
          // frame extractor fail once and stay failed, so it stays unresolved
          // (and is polled / invalidated) until the download lands.
          const isAwaitingDownload =
            asset.data?.cloudMirror === true &&
            asset.data?.status !== "ingested";
          // Something is mounted and waiting for this file, so fetch it sooner.
          const playableUrl = isAwaitingDownload ? "" : asset.filepath;
          return {
            asset,
            s3_url: playableUrl,
            urlToUse: playableUrl
          } as VideoAssetIngestionSuccess;
        }
      }

      let token: string | null;
      try {
        token = await getToken({ template: "basicToken" });
      } catch {
        return;
      }
      scope.work.check();
      if (!token) return;

      const result = await getVideoAsset({
        assetId,
        selectedLayerId,
        clerkToken: token,
        signal: isLocalApp ? scope.work.signal : undefined
      });

      scope.work.check();
      if (result && "error_message" in result) {
        const error = new Error(result.error_message) as Error & {
          status?: number;
        };
        if ("status" in result && typeof result.status === "number") {
          error.status = result.status;
        }
        throw error;
      }

      const hasS3Url =
        result &&
        typeof result === "object" &&
        "s3_url" in result &&
        assetId &&
        !!result.s3_url;

      if (hasS3Url) {
        const { urlToUse } = await cacheVideoUrl(
          result.s3_url,
          assetId,
          scope.work
        );

        scope.work.check();
        const controlNets = (result as VideoAssetIngestionSuccess).asset
          ?.manifest?.controlNets;
        if (controlNets) {
          controlNets.forEach((cn) => {
            cacheVideoUrl(cn.video, cn.video, scope.work)
              .then(({ urlToUse }) => {
                releaseRendererObjectUrl(urlToUse);
              })
              .catch((error) => {
                if (scope.work.signal.aborted) return;
                console.warn("Failed to preload controlnet video:", error);
              });
          });
        }

        return { ...result, urlToUse };
      }

      return { ...result, urlToUse: "" };
    });

  const queryResult = useQuery<VideoAssetResponse | undefined, Error>({
    queryKey,
    queryFn,
    enabled: isEnabled,
    staleTime: Infinity,
    gcTime: isLocalApp ? undefined : Infinity,
    retry: scope.retry(queryKey, (failureCount, error) => {
      const errorWithStatus = error as Error & { status?: number };
      if (
        errorWithStatus.status &&
        errorWithStatus.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR
      ) {
        return false;
      }
      return failureCount < MAX_RETRY_COUNT;
    }),
    retryDelay: (attemptIndex) =>
      Math.min(1000 * 2 ** attemptIndex, MAX_RETRY_DELAY_MS),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: createUnresolvedAssetRefetchInterval({
      pollIntervalMs: UNRESOLVED_VIDEO_ASSET_POLL_INTERVAL_MS,
      getPlayableUrl: getVideoAssetUrl
    })
  });

  return queryResult;
};
