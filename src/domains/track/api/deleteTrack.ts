import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";
import { isTrackOwnedByCloud } from "@domains/track/utils/isTrackOwnedByCloud";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

export const deleteTrack = async (
  { trackId, projectId }: { trackId: string; projectId?: string },
  work = rendererLibrary.capture()
) => {
  const isTrackStoredLocally =
    isLocalApp &&
    !(await work.boundary(() => isTrackOwnedByCloud({ projectId, trackId })));
  if (isTrackStoredLocally) {
    return work.boundary(() => getLocalDesktopApi().tracks.delete(trackId));
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.delete(`/layers/${trackId}`, { signal })
  );
  work.check();
  if (projectId) await syncCloudProjectMetadata(projectId, work);
  work.check();
  return response;
};
