import { isCloudResourceAlreadyGoneError } from "@domains/cloud/isCloudResourceAlreadyGoneError";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import { fetchCloudQueueRowForQueueItem } from "./fetchCloudQueueRowForQueueItem";
import { QueueItem } from "./interface";

export const markCloudQueueItemInteracted = async (
  queueItem: QueueItem,
  work?: RendererLibraryWork
): Promise<void> => {
  const localCloudRenderJobId = queueItem.local_cloud_render_job_id;
  if (localCloudRenderJobId !== undefined) {
    const mark = () =>
      getLocalDesktopApi().imageRenders.markInteracted(localCloudRenderJobId);
    if (work) await work.boundary(mark);
    else await mark();
  }

  work?.check();
  const cloudQueueRow = await fetchCloudQueueRowForQueueItem(
    queueItem,
    work?.signal
  );
  work?.check();
  if (!cloudQueueRow?.cloudQueueItemId) return;
  try {
    const route = `/queue/interaction/${cloudQueueRow.cloudQueueItemId}`;
    if (work)
      await backendApiClient.put(route, undefined, { signal: work.signal });
    else await backendApiClient.put(route);
  } catch (err) {
    work?.check();
    if (!isCloudResourceAlreadyGoneError(err)) throw err;
  }
};
