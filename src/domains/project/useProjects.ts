import { isDummyProject } from "@domains/project/utils/isDummyProject";
import { useUser } from "@platform/identity";
import { Project, ProjectSchema } from "@schemas/project";
import { useQuery } from "@tanstack/react-query";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  libraryQueryKey,
  useRendererLibraryQueryScope
} from "@/platform/rendererLibraryQuery";
import {
  type RendererLibraryWork,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

const fetchProjects = async (work: RendererLibraryWork): Promise<Project[]> => {
  const response = isLocalApp
    ? await work.boundary(() => getLocalDesktopApi().projects.listAll())
    : (await backendApiClient.get(`/v03/projects`, {})).data;
  const parsed = response.map((project: unknown) => {
    const result = ProjectSchema.safeParse(project);
    if (!result.success) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[useProjects] project failed schema validation",
          result.error
        );
      }
      return project as Project;
    }
    return result.data;
  });
  return parsed.filter((project: Project) => project.active);
};

const projectsQueryOptions = (work: RendererLibraryWork, version?: number) => ({
  queryKey: libraryQueryKey(queryKeys.projects.all, version),
  queryFn: () => runRendererLibraryRequest(work, () => fetchProjects(work)),
  staleTime: isLocalApp ? 0 : Infinity,
  refetchOnMount: isLocalApp ? ("always" as const) : (false as const),
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: isLocalApp
});

const useProjects = <T = Project[]>(select?: (projects: Project[]) => T) => {
  const { user } = useUser();
  const scope = useRendererLibraryQueryScope();
  const options = projectsQueryOptions(scope.work, scope.libraryVersion);
  return useQuery({
    ...options,
    enabled: scope.active,
    retry: scope.retry(options.queryKey),
    select: (projects: Project[]) => {
      const filtered = projects.filter((p) => !isDummyProject(p, user?.id));
      return (select ? select(filtered) : filtered) as T;
    }
  });
};

export { useProjects, projectsQueryOptions };
