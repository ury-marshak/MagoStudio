import { useQueryClient } from "@tanstack/react-query";

import { backendApiClient } from "@/lib/backend-api-client";
import { runRendererLibraryRequest } from "@/platform/rendererLibraryWork";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

export const useDeleteQueueItem = () => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: async (
      params: { queueItemId: string; shouldDeleteCloudOutputLayer?: boolean },
      work
    ) => {
      await runRendererLibraryRequest(work, (signal) =>
        backendApiClient.delete(`/queue/${params.queueItemId}`, { signal })
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.queue.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.project.all });
    }
  });
};
