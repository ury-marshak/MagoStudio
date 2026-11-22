import { backendApiClient } from "@/lib/backend-api-client";

import { AdaptedI2vPrompt, AdaptI2vPromptRequestBody } from "../interface";

export const postAdaptI2vPrompt = async (
  requestBody: AdaptI2vPromptRequestBody,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  const response = await backendApiClient.post<AdaptedI2vPrompt>(
    `/adapt_i2v_prompt`,
    requestBody,
    { signal }
  );

  signal?.throwIfAborted();
  return response.data;
};

export const hasUnresolvedAdaptedReferences = (response: AdaptedI2vPrompt) =>
  !response.adapted || (response.label_warnings?.length ?? 0) > 0;
