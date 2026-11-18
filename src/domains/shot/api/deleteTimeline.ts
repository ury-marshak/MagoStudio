import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { isCloudProject } from "../utils/isCloudProject";

/** `projectId` tells a cloud project's shot (deleted in the cloud, then
 * mirrored) from a local one; without it the desktop app assumes local. */
export const deleteTimeline = async (
  timelineId: string,
  projectId?: string,
  work = rendererLibrary.capture()
) => {
  if (isLocalApp && !(await work.boundary(() => isCloudProject(projectId)))) {
    await work.boundary(() => getLocalDesktopApi().shots.delete(timelineId));
    return;
  }
  await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.delete(`/timeline/${timelineId}`, { signal })
  );
  work.check();
  if (projectId) await syncCloudProjectMetadata(projectId, work);
  work.check();
};
