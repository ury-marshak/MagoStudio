import { SceneStoryboardSubmittedSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { buildSceneStoryboardPath } from "./sceneStoryboardPath";

export type GenerateSceneStoryboardRequest = {
  projectId: string;
  sceneTimelineId: string;
  renderModel?: string;
};

export const postSceneStoryboardGenerate = async (
  request: GenerateSceneStoryboardRequest,
  work = rendererLibrary.capture()
) => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      `${buildSceneStoryboardPath(request)}/generate`,
      undefined,
      { signal }
    )
  );
  return SceneStoryboardSubmittedSchema.parse(response.data);
};
