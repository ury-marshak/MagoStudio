import { SceneStoryboardResponseSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isLocalScriptProject } from "../projectOrigin";

import { buildSceneStoryboardPath } from "./sceneStoryboardPath";

export type UpdateSceneStoryboardRequest = {
  projectId: string;
  sceneTimelineId: string;
  selectedAssetId?: string | null;
  isUsedInVideoRenders?: boolean;
};
export const putSceneStoryboard = async (
  {
    selectedAssetId,
    isUsedInVideoRenders,
    ...scene
  }: UpdateSceneStoryboardRequest,
  work = rendererLibrary.capture()
) => {
  const fields = {
    ...(selectedAssetId === undefined
      ? {}
      : { selected_asset_id: selectedAssetId }),
    ...(isUsedInVideoRenders === undefined
      ? {}
      : { enabled: isUsedInVideoRenders })
  };
  const data = (await work.boundary(() =>
    isLocalScriptProject(scene.projectId)
  ))
    ? await work.boundary(() =>
        getLocalDesktopApi().scriptProjects.update({
          projectId: scene.projectId,
          operation: "storyboard-update",
          payload: { timelineId: scene.sceneTimelineId, ...fields }
        })
      )
    : (
        await runRendererLibraryRequest(work, (signal) =>
          backendApiClient.put(buildSceneStoryboardPath(scene), fields, {
            signal
          })
        )
      ).data;
  return SceneStoryboardResponseSchema.parse(data).storyboard;
};
