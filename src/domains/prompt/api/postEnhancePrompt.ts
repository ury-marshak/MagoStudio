import { backendApiClient } from "@/lib/backend-api-client";

import { EnhancePromptRequestBody, EnhancedPrompt } from "../interface";
import { TextModelRoute } from "../useTextModelRoute";

/** Desktop-managed routes use the bridge, while the cloud route uses Mago's API. */
export const postEnhancePrompt = async (
  requestBody: EnhancePromptRequestBody,
  route: TextModelRoute
) => {
  if (typeof window !== "undefined" && window.mago) {
    const external = await window.mago.vlm.hasExternalText();
    if (external !== (route === "external"))
      throw new Error("External text configuration changed");
    if (route !== "cloud") {
      return window.mago.vlm.enhancePrompt({
        query: requestBody.query,
        version: requestBody.version
      });
    }
  }

  const response = await backendApiClient.post<EnhancedPrompt>(
    `/chat/enhance-prompt`,
    requestBody
  );

  return response.data;
};
