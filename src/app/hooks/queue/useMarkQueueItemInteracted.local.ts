import { useQueryClient } from "@tanstack/react-query";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { QueueItem } from "./interface";
import { markCloudQueueItemInteracted } from "./markCloudQueueItemInteracted";

export const useMarkQueueItemInteracted = () => {
  const queryClient = useQueryClient();
  return useRendererLibraryMutation({
    mutationFn: async (queueItemId: string, work) => {
      const queueItem = queryClient
        .getQueryData<QueueItem[]>(libraryQueryKey(queryKeys.queue.all))
        ?.find((candidate) => candidate.id === queueItemId);
      if (queueItem?.render_provider === "mago-cloud") {
        await markCloudQueueItemInteracted(queueItem, work);
        return;
      }
      await work.boundary(() =>
        getLocalDesktopApi().imageRenders.markInteracted(queueItemId)
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.queue.all });
    }
  });
};
