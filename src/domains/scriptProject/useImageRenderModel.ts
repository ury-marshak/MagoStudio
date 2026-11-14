import { isCloudRenderAvailable } from "@/platform/renderTarget";

import {
  AnySheetRenderModel,
  FAL_SHEET_MODEL_H3,
  isLocalSheetRenderModel
} from "./constants";
import { useLocalImageModelAvailability } from "./data/useLocalImageModelAvailability";
import { useFalProviderConfig } from "./useFalProviderConfigured";
import { useSaveProjectSettingsPatch } from "./useSaveProjectSettingsPatch";
import { resolveImageRenderModel } from "./utils/resolveImageRenderModel";

export const useImageRenderModel = (
  projectId: string | undefined,
  setting: "sheet_render_model" | "storyboard_render_model",
  enabled = true
) => {
  const { project, saveProjectSettingsPatch, isSavingProjectSettings } =
    useSaveProjectSettingsPatch(projectId);
  const isLocalProject = project?.origin === "local";
  const savedModel = project?.settings?.[setting];
  const isStoryboard = setting === "storyboard_render_model";
  const checksFal = enabled && isLocalProject;
  const fal = useFalProviderConfig(checksFal);
  const isFalAvailable = checksFal && !!fal.data;
  const isLoadingProvider = checksFal && fal.isPending;
  const installedLocalModels = useLocalImageModelAvailability(
    enabled &&
      isLocalProject &&
      !isLoadingProvider &&
      (!isFalAvailable || (isStoryboard && isLocalSheetRenderModel(savedModel)))
  );
  const canUseCloudModels = isCloudRenderAvailable();
  return {
    renderModel: resolveImageRenderModel({
      savedModel,
      isLocalProject,
      isCloudAvailable: canUseCloudModels,
      installedLocalModels,
      supportsFal: true,
      falDefaultModel: isStoryboard
        ? (fal.data?.storyboardImageModel ?? FAL_SHEET_MODEL_H3)
        : fal.data?.referenceImageModel,
      isFalAvailable
    }),
    isLocalProject,
    installedLocalModels,
    isLoadingProvider,
    isFalAvailable,
    canUseCloudModels,
    isSavingRenderModel: isSavingProjectSettings,
    setRenderModel: (model: AnySheetRenderModel) =>
      saveProjectSettingsPatch({ [setting]: model })
  };
};
