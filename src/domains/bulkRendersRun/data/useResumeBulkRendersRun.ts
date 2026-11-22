import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { postBulkRendersRunResume } from "../api/postBulkRendersRunResume";

export interface ResumeBulkRendersRunInput {
  bulkRunId: string;
  projectId: string | undefined;
}

export const useResumeBulkRendersRun = () => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: ({ bulkRunId }: ResumeBulkRendersRunInput, work) =>
      postBulkRendersRunResume(bulkRunId, work),
    onSuccess: (_resumedRun, { bulkRunId, projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bulkRendersRunProgress.byRunId(bulkRunId)
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bulkRendersRunSteps.byRunId(bulkRunId)
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bulkRendersRuns.everyProject()
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bulkRendersRuns.byProjectId(projectId)
      });
    }
  });
};
