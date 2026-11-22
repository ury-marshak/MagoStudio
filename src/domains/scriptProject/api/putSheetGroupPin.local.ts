import { SheetGroup, SheetGroupSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isLocalScriptProject } from "../projectOrigin";

export type PinSheetGroupImageRequest = {
  projectId?: string;
  timelineId: string;
  token: string;
  selectedAssetId: string | null;
};

export const putSheetGroupPin = async (
  request: PinSheetGroupImageRequest,
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
          operation: "pin-sheet",
          payload: {
            token: request.token,
            selectedAssetId: request.selectedAssetId
          }
        })
      )
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.put(
      `/timelines/${request.timelineId}/sheets/${encodeURIComponent(request.token)}`,
      { selected_asset_id: request.selectedAssetId },
      { signal }
    )
  );
  return SheetGroupSchema.parse(response.data);
};
