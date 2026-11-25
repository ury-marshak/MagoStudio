import { useQuery } from "@tanstack/react-query";

import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import { postProjectCutExport } from "../api/postProjectCutExport";

/** What an export would do, without dispatching one, so the button can say up front that it
 * will hand back separate files instead of one MP4. */
export const useProjectCutExportDryRun = (
  projectId: string | null | undefined
) => {
  const scope = useRendererLibraryQueryScope();
  const queryKey = scope.key(queryKeys.projectCut.exportDryRun(projectId));
  return useQuery({
    queryKey,
    queryFn: () =>
      scope.run(() =>
        postProjectCutExport(
          { projectId: projectId!, isDryRun: true },
          scope.work
        )
      ),
    enabled: !!projectId && scope.active,
    retry: scope.retry(queryKey)
  });
};
