import { cancellableInference } from "@/platform/cancellableInference";
import { getLocalDesktopApi } from "@/platform/localDesktop";

import { AdaptedI2vPrompt, AdaptI2vPromptRequestBody } from "../interface";

/** The desktop bridge's `/adapt_i2v_prompt`: same body and response, with local
 *  asset IDs and the configured desktop text route. */
export const postLocalAdaptI2vPrompt = (
  requestBody: AdaptI2vPromptRequestBody,
  signal?: AbortSignal
): Promise<AdaptedI2vPrompt> =>
  cancellableInference(
    (id) => getLocalDesktopApi().vlm.adaptI2vPrompt(requestBody, id),
    signal
  );
