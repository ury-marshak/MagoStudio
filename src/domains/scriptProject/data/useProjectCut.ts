import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";

import { getProjectCut } from "../api/getProjectCut";

import { buildProjectCutQueryOptions } from "./buildProjectCutQueryOptions";

export const useProjectCut = (projectId: string | null | undefined) => {
  const queryClient = useQueryClient();
  const scope = useRendererLibraryQueryScope();
  const { queryKey } = buildProjectCutQueryOptions(
    projectId,
    scope.work,
    scope.libraryVersion
  );
  return useQuery({
    queryKey,
    queryFn: () =>
      scope.run(() =>
        getProjectCut(
          projectId!,
          { preferCache: !queryClient.getQueryData(queryKey) },
          scope.work
        )
      ),
    enabled: !!projectId && scope.active,
    retry: scope.retry(queryKey)
  });
};
