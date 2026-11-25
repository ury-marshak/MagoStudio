import { useProject } from "@domains/project/useProject";
import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import { collectUnnavigableShotIds } from "./utils/collectUnnavigableShotIds";

export const useUnnavigableShotIds = (projectId: string | undefined) => {
  const queryClient = useQueryClient();
  const { data: derivedProject, isLoading } = useProject(projectId);

  const cachedRawProject = queryClient.getQueryData<Project>(
    libraryQueryKey(queryKeys.project.byId(projectId))
  );

  return {
    unnavigableShotIds: collectUnnavigableShotIds(
      cachedRawProject ?? derivedProject
    ),
    isUnnavigableShotIdsLoading: isLoading
  };
};
