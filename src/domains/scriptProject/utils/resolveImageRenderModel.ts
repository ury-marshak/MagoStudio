import {
  AnySheetRenderModel,
  DEFAULT_SHEET_RENDER_MODEL,
  FAL_SHEET_MODEL_21,
  isFalSheetModel,
  type FalSheetModel,
  LOCAL_SHEET_RENDER_MODEL,
  isLocalSheetRenderModel
} from "../constants";

import { isSheetRenderModel } from "./isSheetRenderModel";

export const resolveImageRenderModel = ({
  savedModel,
  isLocalProject,
  isCloudAvailable,
  installedLocalModels,
  falDefaultModel = FAL_SHEET_MODEL_21,
  isFalAvailable = false,
  supportsFal = false
}: {
  savedModel: unknown;
  isLocalProject: boolean;
  isCloudAvailable: boolean;
  falDefaultModel?: FalSheetModel;
  isFalAvailable?: boolean;
  supportsFal?: boolean;
  installedLocalModels: readonly AnySheetRenderModel[];
}): AnySheetRenderModel => {
  if (isLocalProject && supportsFal && isFalSheetModel(savedModel))
    return savedModel;
  if (isSheetRenderModel(savedModel) && (!isLocalProject || isCloudAvailable))
    return savedModel;
  if (isLocalProject && isLocalSheetRenderModel(savedModel)) return savedModel;
  if (isLocalProject && supportsFal && isFalAvailable) return falDefaultModel;
  if (!isLocalProject || isCloudAvailable) return DEFAULT_SHEET_RENDER_MODEL;
  return (
    installedLocalModels.find((model) => model === LOCAL_SHEET_RENDER_MODEL) ??
    installedLocalModels[0] ??
    LOCAL_SHEET_RENDER_MODEL
  );
};
