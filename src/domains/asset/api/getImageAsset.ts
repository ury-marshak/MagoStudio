import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import { getRemoteImageAsset } from "./getRemoteImageAsset";
import { ImageAssetResponse } from "./interface";

export const getImageAsset = async (
  assetId?: string,
  work?: RendererLibraryWork
): Promise<ImageAssetResponse> => {
  if (!assetId) {
    throw new Error("Asset ID is required");
  }

  return getRemoteImageAsset(assetId, work);
};
