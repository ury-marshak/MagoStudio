import { backendCloudApi } from "@domains/cloud/backendCloudApi";
import { ensureCloudImageAsset } from "@domains/cloud/mirrorService";
import {
  SheetGroup,
  SheetGroupSchema,
  SheetKind
} from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isLocalScriptProject } from "../projectOrigin";

export type AddSheetGroupImageRequest = {
  projectId?: string;
  timelineId: string;
  token: string;
  assetId: string;
  name?: string;
  kind?: SheetKind;
};

export const postSheetGroupImage = async (
  request: AddSheetGroupImageRequest,
  work = rendererLibrary.capture()
): Promise<SheetGroup> => {
  const { projectId } = request;
  if (
    projectId &&
    (await work.boundary(() => isLocalScriptProject(projectId)))
  ) {
    return SheetGroupSchema.parse(
      // Filing can wait for main-owned image description after the local write.
      await runRendererLibraryRequest(work, () =>
        getLocalDesktopApi().scriptProjects.update({
          projectId,
          operation: "add-sheet-image",
          payload: {
            token: request.token,
            assetId: request.assetId,
            ...(request.name ? { name: request.name } : {})
          }
        })
      )
    );
  }
  const cloudAssetId = await ensureCloudImageAsset(
    backendCloudApi(),
    request.assetId,
    projectId,
    undefined,
    work
  );
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      `/timelines/${request.timelineId}/sheets/${encodeURIComponent(request.token)}/images`,
      {
        asset_id: cloudAssetId,
        ...(request.name ? { name: request.name } : {}),
        ...(request.kind ? { kind: request.kind } : {})
      },
      { signal }
    )
  );
  return SheetGroupSchema.parse(response.data);
};
