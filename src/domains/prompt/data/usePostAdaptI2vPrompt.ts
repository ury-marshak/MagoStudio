import { useToast } from "@store/useToast";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { getLocalDesktopApi } from "@/platform/localDesktop";

import { postAdaptI2vPrompt } from "../api/postAdaptI2vPrompt";
import { postLocalAdaptI2vPrompt } from "../api/postLocalAdaptI2vPrompt";
import { AdaptI2vPromptRequestBody } from "../interface";
import { TextModelRoute } from "../useTextModelRoute";

/** Desktop-managed routes take local asset IDs. */
export const usePostAdaptI2vPrompt = (route: TextModelRoute = "cloud") => {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const mutationFn = async (requestBody: AdaptI2vPromptRequestBody) => {
    if (
      route !== "cloud" &&
      (await getLocalDesktopApi().vlm.hasExternalText()) !==
        (route === "external")
    )
      throw new Error("External text configuration changed");
    const response =
      route !== "cloud"
        ? await postLocalAdaptI2vPrompt(requestBody)
        : await postAdaptI2vPrompt(requestBody);

    const hasUnresolvedReferences =
      !response.adapted || (response.label_warnings?.length ?? 0) > 0;
    if (hasUnresolvedReferences) {
      showToast({
        message: t("notifications.adapt_prompt_partial.description")
      });
    }

    return response.adapted_prompt;
  };

  return useMutation({
    mutationFn
  });
};
