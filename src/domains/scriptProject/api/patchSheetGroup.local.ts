import { SheetGroup, SheetGroupSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isLocalScriptProject } from "../projectOrigin";

export type EditSheetGroupRequest = {
  projectId?: string;
  timelineId: string;
  token: string;
  name?: string;
  description?: string;
  prompt?: string;
  enabled?: boolean;
  bodyPlan?: "upright" | "four_legged" | null;
  referenceAssetIds?: string[] | null;
  referenceInstruction?: string | null;
};

export const patchSheetGroup = async (
  request: EditSheetGroupRequest,
  work = rendererLibrary.capture()
): Promise<SheetGroup> => {
  const { projectId } = request;
  if (
    projectId &&
    (await work.boundary(() => isLocalScriptProject(projectId)))
  ) {
    return SheetGroupSchema.parse(
      await work.boundary(() =>
        getLocalDesktopApi().scriptProjects.update({
          projectId,
          operation: "edit-sheet",
          payload: {
            token: request.token,
            ...(request.name === undefined ? {} : { name: request.name }),
            ...(request.bodyPlan === undefined
              ? {}
              : { body_plan: request.bodyPlan }),
            ...(request.description === undefined
              ? {}
              : { description: request.description }),
            ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
            ...(request.enabled === undefined
              ? {}
              : { enabled: request.enabled }),
            ...(request.referenceAssetIds === undefined
              ? {}
              : { reference_asset_ids: request.referenceAssetIds }),
            ...(request.referenceInstruction === undefined
              ? {}
              : { reference_instruction: request.referenceInstruction })
          }
        })
      )
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.patch(
      `/timelines/${request.timelineId}/sheets/${encodeURIComponent(request.token)}/edit`,
      {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.bodyPlan === undefined
          ? {}
          : { body_plan: request.bodyPlan }),
        ...(request.description === undefined
          ? {}
          : { description: request.description }),
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        ...(request.referenceAssetIds === undefined
          ? {}
          : { reference_asset_ids: request.referenceAssetIds }),
        ...(request.referenceInstruction === undefined
          ? {}
          : { reference_instruction: request.referenceInstruction })
      },
      { signal }
    )
  );
  return SheetGroupSchema.parse(response.data);
};
