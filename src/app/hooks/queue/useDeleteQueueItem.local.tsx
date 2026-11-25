import { useQueryClient } from "@tanstack/react-query";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { cancelCloudQueueItem } from "./cancelCloudQueueItem";
import { QueueItem } from "./interface";

export const useDeleteQueueItem = () => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: async (
      params: { queueItemId: string; shouldDeleteCloudOutputLayer?: boolean },
      work
    ) => {
      const queueItem = queryClient
        .getQueryData<QueueItem[]>(libraryQueryKey(queryKeys.queue.all))
        ?.find((candidate) => candidate.id === params.queueItemId);
      if (queueItem?.render_provider === "mago-cloud") {
        await cancelCloudQueueItem({
          queueItem,
          shouldDeleteCloudOutputLayer:
            params.shouldDeleteCloudOutputLayer ?? false,
          work
        });
        return;
      }
      work.check();
      await getLocalDesktopApi().imageRenders.cancel(params.queueItemId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.queue.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.project.all });
    }
  });
};
