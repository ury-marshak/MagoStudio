import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import {
  RenderSheetGroupRequest,
  postSheetGroupRender
} from "../api/postSheetGroupRender";

import { ScriptProjectMutationOptions } from "./scriptProjectMutationOptions";

export const useRenderSheetGroup = (
  projectId: string | null | undefined,
  options?: ScriptProjectMutationOptions<RenderSheetGroupRequest>
) => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: (request: RenderSheetGroupRequest, work) =>
      postSheetGroupRender(
        { ...request, projectId: projectId ?? undefined },
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
