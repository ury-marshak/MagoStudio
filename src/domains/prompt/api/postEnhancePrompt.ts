import { backendApiClient } from "@/lib/backend-api-client";
import { cancellableInference } from "@/platform/cancellableInference";

import { EnhancePromptRequestBody, EnhancedPrompt } from "../interface";
import { TextModelRoute } from "../useTextModelRoute";

/** Desktop-managed routes use the bridge, while the cloud route uses Mago's API. */
export const postEnhancePrompt = async (
  requestBody: EnhancePromptRequestBody,
  route: TextModelRoute,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  if (typeof window !== "undefined" && window.mago) {
    const external = await window.mago.vlm.hasExternalText();
    if (external !== (route === "external"))
      throw new Error("External text configuration changed");
    if (route !== "cloud") {
      return cancellableInference(
        (id) =>
          window.mago.vlm.enhancePrompt(
            {
              query: requestBody.query,
              version: requestBody.version
            },
            id
          ),
        signal
      );
    }
  }

  const response = await backendApiClient.post<EnhancedPrompt>(
    `/chat/enhance-prompt`,
    requestBody,
    { signal }
  );

  return response.data;
};
