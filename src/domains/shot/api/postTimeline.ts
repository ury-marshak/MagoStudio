import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isCloudProject } from "../utils/isCloudProject";

export const postTimeline = async (
  projectId: string,
  name: string,
  work = rendererLibrary.capture()
) => {
  if (isLocalApp && !(await work.boundary(() => isCloudProject(projectId)))) {
    return work.boundary(() =>
      getLocalDesktopApi().shots.create({ projectId, name })
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(`/timelines/${projectId}`, { name }, { signal })
  );
  work.check();
  return response.data;
};
