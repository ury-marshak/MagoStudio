import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { getRemoteImageAsset } from "./getRemoteImageAsset";
import { ImageAssetResponse } from "./interface";

/** Desktop previews must use the original image. `thumbnail_filepath` is a
 * 480px library-card derivative and made cloud img2img/SBS previews blurry. */
export const getImageAsset = async (
  assetId?: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<ImageAssetResponse> => {
  if (!assetId) throw new Error("Asset ID is required");

  const asset = await runRendererLibraryRequest(work, () =>
    window.mago.assets.get(assetId)
  );
  work.check();
  if (!asset) return getRemoteImageAsset(assetId, work);
  const awaitingDownload =
    asset.data?.cloudMirror === true && asset.data?.status !== "ingested";
  return {
    s3_url: awaitingDownload ? "" : asset.filepath,
    urlToUse: awaitingDownload ? "" : asset.filepath,
    asset: asset as ImageAssetResponse["asset"]
  };
};
