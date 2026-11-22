import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { EditSheetGroupRequest, patchSheetGroup } from "../api/patchSheetGroup";

import { ScriptProjectMutationOptions } from "./scriptProjectMutationOptions";

export const useEditSheetGroup = (
  projectId: string | null | undefined,
  options?: ScriptProjectMutationOptions<EditSheetGroupRequest>
) => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: (request: EditSheetGroupRequest, work) =>
      patchSheetGroup({ ...request, projectId: projectId ?? undefined }, work),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectState.byProjectId(projectId)
      });
    },
    onError: options?.onError
  });
};
