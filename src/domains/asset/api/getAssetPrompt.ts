import { AssetPromptResponse } from "@hooks/assets/interface";

import { backendApiClient } from "@/lib/backend-api-client";
import { cancellableInference } from "@/platform/cancellableInference";

import { isAssetPromptGeneratedInCloud } from "./isAssetPromptGeneratedInCloud";

const getCloudAssetPrompt = async (
  assetId: string,
  signal?: AbortSignal
): Promise<AssetPromptResponse> => {
  const response = await backendApiClient.get(`/assets/${assetId}/prompt`, {
    signal
  });
  return response.data;
};

export const getAssetPrompt = async (
  assetId?: string,
  signal?: AbortSignal
): Promise<AssetPromptResponse> => {
  signal?.throwIfAborted();
  if (!assetId) {
    throw new Error("Asset ID is required");
  }

  const isCloud = await isAssetPromptGeneratedInCloud(assetId);
  signal?.throwIfAborted();
  if (isCloud) {
    return getCloudAssetPrompt(assetId, signal);
  }

  const { prompt } = await cancellableInference(
    (id) => window.mago.vlm.captionAsset(assetId, id),
    signal
  );
  return { prompt } as AssetPromptResponse;
};
