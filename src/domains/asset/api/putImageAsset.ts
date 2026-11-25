import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { ImageAssetResponse } from "./interface";

const putCloudImageAsset = async (
  assetId: string,
  changes: { rate: number },
  work: RendererLibraryWork
): Promise<ImageAssetResponse> => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.put<ImageAssetResponse>(`/assets/${assetId}`, changes, {
      signal
    })
  );
  work.check();
  return response.data;
};

export const putImageAsset = async (
  assetId: string,
  changes: { rate: number },
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<ImageAssetResponse> => {
  if (!isLocalApp) return putCloudImageAsset(assetId, changes, work);

  const desktop = getLocalDesktopApi();
  const localAsset = await work.boundary(() => desktop.assets.get(assetId));
  const updateRating = () =>
    work.boundary(() => desktop.assets.update({ assetId, rate: changes.rate }));
  const isOwnedByCloud = !localAsset || localAsset.data.cloudMirror === true;
  if (isOwnedByCloud) {
    const cloudAsset = await putCloudImageAsset(assetId, changes, work);
    if (localAsset) await updateRating();
    work.check();
    return cloudAsset;
  }

  const asset = await updateRating();
  work.check();
  if (!asset) throw new Error("Local image asset not found");
  const thumbnail = asset.data.thumbnail_filepath;
  return {
    s3_url: asset.filepath,
    urlToUse:
      typeof thumbnail === "string" && thumbnail ? thumbnail : asset.filepath,
    asset: asset as ImageAssetResponse["asset"]
  };
};
