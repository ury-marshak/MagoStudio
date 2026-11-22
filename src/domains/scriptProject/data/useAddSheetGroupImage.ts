import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import {
  AddSheetGroupImageRequest,
  postSheetGroupImage
} from "../api/postSheetGroupImage";

import { ScriptProjectMutationOptions } from "./scriptProjectMutationOptions";

export const useAddSheetGroupImage = (
  projectId: string | null | undefined,
  options?: ScriptProjectMutationOptions<AddSheetGroupImageRequest>
) => {
  const queryClient = useQueryClient();

  return useRendererLibraryMutation({
    mutationFn: (request: AddSheetGroupImageRequest, work) =>
      postSheetGroupImage(
        { ...request, projectId: projectId ?? undefined },
        work
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectState.byProjectId(projectId)
      });
    },
    onError: options?.onError
  });
};
