import { isCloudResourceAlreadyGoneError } from "@domains/cloud/isCloudResourceAlreadyGoneError";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { fetchCloudQueueRowForQueueItem } from "./fetchCloudQueueRowForQueueItem";
import { QueueItem } from "./interface";

const deleteCloudResourceUnlessAlreadyGone = async (
  url: string,
  work: RendererLibraryWork
) => {
  await runRendererLibraryRequest(work, async (signal) => {
    try {
      await backendApiClient.delete(url, { signal });
    } catch (err) {
      if (!isCloudResourceAlreadyGoneError(err)) throw err;
    }
  });
};

export const cancelCloudQueueItem = async ({
  queueItem,
  shouldDeleteCloudOutputLayer,
  work
}: {
  queueItem: QueueItem;
  shouldDeleteCloudOutputLayer: boolean;
  work: RendererLibraryWork;
}): Promise<void> => {
  const cloudQueueRow = await runRendererLibraryRequest(work, (signal) =>
    fetchCloudQueueRowForQueueItem(queueItem, signal)
  );
  if (cloudQueueRow?.cloudQueueItemId) {
    await deleteCloudResourceUnlessAlreadyGone(
      `/queue/${cloudQueueRow.cloudQueueItemId}`,
      work
    );
  }

  work.check();
  const localCloudRenderJobId = queueItem.local_cloud_render_job_id;
  if (localCloudRenderJobId === undefined) return;

  const cloudOutputLayerId = cloudQueueRow?.cloudOutputLayerId;
  if (shouldDeleteCloudOutputLayer && cloudOutputLayerId) {
    await deleteCloudResourceUnlessAlreadyGone(
      `/layers/${cloudOutputLayerId}`,
      work
    );
  }
  // Main owns an admitted cancellation. Do not drain a provider wait here.
  work.check();
  try {
    await getLocalDesktopApi().imageRenders.cancel(localCloudRenderJobId);
  } finally {
    work.check();
  }
};
