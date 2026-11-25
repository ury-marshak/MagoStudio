import { projectsQueryOptions } from "@domains/project/useProjects";
import { isDummyProject } from "@domains/project/utils/isDummyProject";
import { useUser } from "@platform/identity";
import { useQuery } from "@tanstack/react-query";

import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";

export const useDummyProject = () => {
  const { user } = useUser();

  const scope = useRendererLibraryQueryScope();
  const options = projectsQueryOptions(scope.work, scope.libraryVersion);
  return useQuery({
    ...options,
    enabled: scope.active,
    retry: scope.retry(options.queryKey),
    select: (projects) => projects.find((p) => isDummyProject(p, user?.id))
  });
};
