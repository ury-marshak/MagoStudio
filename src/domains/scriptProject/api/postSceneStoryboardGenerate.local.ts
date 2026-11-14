import { SceneStoryboardSubmittedSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";

import {
  canUseCloudSheetModels,
  executeCloudSheetPlan
} from "../cloudSheetRender.local";
import {
  FAL_SHEET_MODEL_H3,
  isFalSheetModel,
  isLocalSheetRenderModel
} from "../constants";
import { isLocalScriptProject } from "../projectOrigin";
import { installedLocalImageModels } from "../utils/installedLocalImageModels";
import { isSheetRenderModel } from "../utils/isSheetRenderModel";
import { resolveImageRenderModel } from "../utils/resolveImageRenderModel";

import { buildSceneStoryboardPath } from "./sceneStoryboardPath";

export type GenerateSceneStoryboardRequest = {
  projectId: string;
  sceneTimelineId: string;
  renderModel?: string;
  providerSettings?: Record<string, string | number | null>;
};
export const postSceneStoryboardGenerate = async (
  request: GenerateSceneStoryboardRequest
) => {
  if (!(await isLocalScriptProject(request.projectId)))
    return SceneStoryboardSubmittedSchema.parse(
      (
        await backendApiClient.post(
          `${buildSceneStoryboardPath(request)}/generate`
        )
      ).data
    );
  const project = await getLocalDesktopApi().projects.get(request.projectId);
  const selected =
    request.renderModel ??
    (project?.settings as Record<string, unknown> | undefined)
      ?.storyboard_render_model;
  const cloudAvailable = canUseCloudSheetModels();
  if (isSheetRenderModel(request.renderModel) && !cloudAvailable)
    throw new Error("Sign in to Mago Cloud to use this image model");
  const fal =
    !isLocalSheetRenderModel(selected) && !isSheetRenderModel(selected)
      ? await getLocalDesktopApi().externalProviders?.fal?.get()
      : null;
  if (isFalSheetModel(selected) && !fal)
    throw new Error(
      "Configure fal.ai in Local settings to use this storyboard model"
    );
  const setup =
    !selected &&
    !fal &&
    !cloudAvailable &&
    getLocalDesktopApi().comfy?.scriptSetupStatus
      ? await getLocalDesktopApi().comfy.scriptSetupStatus()
      : undefined;
  const renderModel = resolveImageRenderModel({
    savedModel: selected,
    isLocalProject: true,
    isCloudAvailable: cloudAvailable,
    supportsFal: true,
    isFalAvailable: !!fal,
    falDefaultModel: fal?.storyboardImageModel ?? FAL_SHEET_MODEL_H3,
    installedLocalModels: installedLocalImageModels(setup)
  });
  const result = await getLocalDesktopApi().scriptProjects.update({
    projectId: request.projectId,
    operation: "storyboard-generate",
    payload: {
      timelineId: request.sceneTimelineId,
      renderModel,
      ...(request.providerSettings
        ? { providerSettings: request.providerSettings }
        : {})
    }
  });
  if (isSheetRenderModel(renderModel) && typeof result.plan_id === "string")
    void executeCloudSheetPlan(result.plan_id);
  return SceneStoryboardSubmittedSchema.parse(result);
};
