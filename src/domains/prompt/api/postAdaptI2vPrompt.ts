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

  return response.data;
};
