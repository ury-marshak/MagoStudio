import { useMutation } from "@tanstack/react-query";

import { postEnhancePrompt } from "../api/postEnhancePrompt";
import { EnhancedPrompt, EnhancePromptRequestBody } from "../interface";
import { useInferenceCancellation } from "../useInferenceCancellation";
import { useTextModelRoute } from "../useTextModelRoute";

const formatEnhancedPrompt = (data: EnhancedPrompt) => {
  return data.enhanced_prompt;
};

export const usePostEnhancePrompt = () => {
  const { route, routeLabel, isRoutePending } = useTextModelRoute();
  const { run, cancel } = useInferenceCancellation();
  const mutationFn = async (requestBody: EnhancePromptRequestBody) => {
    // The buttons are disabled meanwhile; this keeps any other caller from
    // sending the prompt down a route the user did not choose.
    if (isRoutePending)
      throw new Error("The text model setting has not loaded yet");
    const response = await run((signal) =>
      postEnhancePrompt(requestBody, route, signal)
    );
    return formatEnhancedPrompt(response);
  };

  return {
    ...useMutation({
      mutationFn
    }),
    cancel,
    routeLabel,
    isRoutePending
  };
};
