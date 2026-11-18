import { MirrorProgress } from "@domains/cloud/mirrorService";
import { Layer } from "@schemas/layer";
import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { postRender, PostRenderParams } from "../api/postRender";
import { buildUpdatedProjectAfterRender } from "../utils/buildUpdatedProjectAfterRender";

export const usePostRender = ({
  selectedProjectId,
  selectedShotId
}: {
  selectedProjectId?: string;
  selectedShotId?: string;
}) => {
  const queryClient = useQueryClient();
  const onSuccess = (updatedLayer: Layer) => {
    queryClient.setQueryData<Project>(
      queryKeys.project.byId(selectedProjectId),
      (project) =>
        buildUpdatedProjectAfterRender(project, selectedShotId, updatedLayer)
    );
  };
  return useRendererLibraryMutation({
    mutationFn: (
      {
        params,
        onProgress
      }: { params: PostRenderParams; onProgress?: MirrorProgress },
      work
    ) => postRender(params, onProgress, work),
    onSuccess
  });
};
