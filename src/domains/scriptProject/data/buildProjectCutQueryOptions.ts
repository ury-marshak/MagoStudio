import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { getProjectCut } from "../api/getProjectCut";

export const buildProjectCutQueryOptions = (
  projectId: string | null | undefined,
  work = rendererLibrary.capture(),
  libraryVersion = rendererLibrary.getSnapshot()
) => ({
  queryKey: libraryQueryKey(
    queryKeys.projectCut.byProjectId(projectId),
    libraryVersion
  ),
  queryFn: () => getProjectCut(projectId!, {}, work)
});
