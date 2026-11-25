import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { readableDesktopStorageUrl } from "@/platform/rendererMediaAccess";
import { createRendererObjectUrl } from "@/platform/rendererObjectUrl";

import { cacheGet } from "../utils/cacheStorage";
import { downloadImageBlob } from "../utils/downloadImageBlob";

import { ImageAssetResponse } from "./interface";

export const getRemoteImageAsset = async (
  assetId: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<ImageAssetResponse> => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.get(`/assets/${assetId}`, { signal })
  );
  const cachedBlob = await cacheGet("image", assetId, work);
  work.check();
  if (cachedBlob) {
    return {
      ...response.data,
      urlToUse: createRendererObjectUrl(cachedBlob, work)
    };
  }

  const responseUrl = response.data.original_url || response.data.s3_url;
  if (!responseUrl) return { ...response.data, urlToUse: responseUrl };

  const readableResponseUrl = readableDesktopStorageUrl(responseUrl);
  try {
    const blob = await downloadImageBlob(responseUrl, assetId, work);
    return { ...response.data, urlToUse: createRendererObjectUrl(blob, work) };
  } catch (error) {
    work.check();
    console.log("error creating blob", error);
    return { ...response.data, urlToUse: readableResponseUrl };
  }
};
