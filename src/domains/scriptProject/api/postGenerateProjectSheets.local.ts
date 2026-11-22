import {
  SheetGenerateResult,
  SheetGenerateResultSchema
} from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import {
  canUseCloudSheetModels,
  executeCloudSheetPlan
} from "../cloudSheetRender.local";
import {
  isFalSheetModel,
  resolveLocalSheetRenderModel,
  SCRIPT_PROJECT_RENDER_MODE
} from "../constants";
import { isLocalScriptProject } from "../projectOrigin";
import { isSheetRenderModel } from "../utils/isSheetRenderModel";

import { generateLocalSheets } from "./generateLocalSheets";

export type GenerateProjectSheetsRequest = {
  projectId: string;
  isDryRun: boolean;
  outputSize?: [number, number];
  settings?: Record<string, unknown>;
  tokens?: string[];
  shouldScoreImages?: boolean;
};

export const postGenerateProjectSheets = async (
  request: GenerateProjectSheetsRequest,
  work = rendererLibrary.capture()
): Promise<SheetGenerateResult> => {
  if (await work.boundary(() => isLocalScriptProject(request.projectId))) {
    // The desktop owns fal and ComfyUI jobs. Mago Cloud plans are executed
    // by the renderer while signed in.
    const isCloudModel =
      isSheetRenderModel(request.settings?.render_model) &&
      canUseCloudSheetModels();
    const localRequest = {
      projectId: request.projectId,
      isDryRun: request.isDryRun,
      ...(request.outputSize ? { outputSize: request.outputSize } : {}),
      settings: {
        ...request.settings,
        render_model:
          isCloudModel || isFalSheetModel(request.settings?.render_model)
            ? request.settings?.render_model
            : resolveLocalSheetRenderModel(request.settings?.render_model)
      },
      ...(request.tokens ? { tokens: request.tokens } : {})
    };
    const result = SheetGenerateResultSchema.parse(
      await generateLocalSheets(localRequest, work)
    );
    work.check();
    if (isCloudModel && !request.isDryRun && result.plan_id)
      void executeCloudSheetPlan(result.plan_id, work);
    return result;
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      `/projects/${request.projectId}/sheets/generate`,
      {
        ...(request.outputSize ? { output_size: request.outputSize } : {}),
        settings: {
          ...request.settings,
          render_mode: SCRIPT_PROJECT_RENDER_MODE
        },
        ...(request.tokens ? { tokens: request.tokens } : {}),
        ...(request.shouldScoreImages ? { metrics: true } : {}),
        dry_run: request.isDryRun
      },
      { signal }
    )
  );
  return SheetGenerateResultSchema.parse(response.data);
};
