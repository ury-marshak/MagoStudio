import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isCloudProject } from "../utils/isCloudProject";

export const putTimeline = async (
  timelineId: string,
  data: { name: string; settings: object | null; project_id: string },
  work = rendererLibrary.capture()
) => {
  if (
    isLocalApp &&
    !(await work.boundary(() => isCloudProject(data.project_id)))
  ) {
    return work.boundary(() =>
      getLocalDesktopApi().shots.update({
        shotId: timelineId,
        name: data.name,
        settings: (data.settings ?? {}) as Record<string, unknown>
      })
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.put(`/timeline/${timelineId}`, data, { signal })
  );
  work.check();
  await syncCloudProjectMetadata(data.project_id, work);
  work.check();
  return response.data;
};
