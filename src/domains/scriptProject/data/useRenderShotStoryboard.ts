import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import {
  RenderShotStoryboardRequest,
  postShotStoryboardRender
} from "../api/postShotStoryboardRender";

import { ScriptProjectMutationOptions } from "./scriptProjectMutationOptions";

export const useRenderShotStoryboard = (
  projectId: string | null | undefined,
  options?: ScriptProjectMutationOptions<RenderShotStoryboardRequest>
) => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: (request: RenderShotStoryboardRequest, work) =>
      postShotStoryboardRender(
        {
          ...request,
          projectId: projectId ?? undefined
        },
        work
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectState.byProjectId(projectId)
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.balance.all });
    },
    onError: options?.onError
  });
};
