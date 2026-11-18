import { AxiosError } from "axios";

import { backendApiClient } from "@/lib/backend-api-client";

import { VideoAssetResponse } from "./interface";

const HTTP_STATUS_UNPROCESSABLE_ENTITY = 422;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

export const getVideoAsset = async ({
  assetId,
  selectedLayerId,
  clerkToken,
  signal
}: {
  assetId?: string;
  selectedLayerId?: string;
  clerkToken?: string;
  signal?: AbortSignal;
}): Promise<VideoAssetResponse> => {
  if (!assetId) {
    return {
      status: "not_started"
    };
  }

  try {
    signal?.throwIfAborted();
    const url = `/assets/${assetId}`;
    const response = signal
      ? await backendApiClient.get(url, { signal })
      : await backendApiClient.get(url);

    return response.data;
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof AxiosError &&
      error.status === HTTP_STATUS_UNPROCESSABLE_ENTITY
    ) {
      return {
        error_message:
          "The video is not processable, please try a different video.",
        error_type: "unprocessable_entity"
      };
    }
    if (
      error instanceof AxiosError &&
      error.response?.status &&
      error.response.status >= HTTP_STATUS_INTERNAL_SERVER_ERROR
    ) {
      return {
        error_message: "Server error occurred while fetching the asset.",
        error_type: "server_error",
        status: error.response.status
      };
    }
    return {
      error_message: error as string,
      error_type: "generic"
    };
  }
};
