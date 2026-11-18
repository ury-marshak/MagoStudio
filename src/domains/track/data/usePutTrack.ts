import { Layer } from "@schemas/layer";
import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { putTrack } from "../api/putTrack";
import { buildUpdatedProjectAfterTrackPut } from "../utils/buildUpdatedProjectAfterTrackPut";

export const usePutTrack = ({
  selectedProjectId,
  selectedShotId
}: {
  selectedProjectId?: string;
  selectedShotId?: string;
}) => {
  const queryClient = useQueryClient();
  const onSuccess = (data: Layer) => {
    queryClient.setQueryData<Project>(
      queryKeys.project.byId(selectedProjectId),
      (project) =>
        buildUpdatedProjectAfterTrackPut(project, selectedShotId, data)
    );
  };
  return useRendererLibraryMutation({
    mutationFn: (
      params: Omit<Parameters<typeof putTrack>[0], "projectId">,
      work
    ) => putTrack({ ...params, projectId: selectedProjectId }, work),
    onSuccess
  });
};
