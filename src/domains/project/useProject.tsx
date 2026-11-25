import { Project } from "@schemas/project";
import { useQuery } from "@tanstack/react-query";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import { fetchProject } from "./api/fetchProject";
import { deriveProjectTracks } from "./utils/deriveProjectTracks";

function useProject(
  projectId: Project["id"] | undefined
): ReturnType<typeof useQuery<Project | undefined, Error, Project | undefined>>;

function useProject<TSelected>(
  projectId: Project["id"] | undefined,
  select: (data: Project) => TSelected,
  disabled?: boolean
): ReturnType<
  typeof useQuery<Project | undefined, Error, TSelected | undefined>
>;

function useProject<TSelected = Project>(
  projectId: Project["id"] | undefined,
  select?: (data: Project) => TSelected,
  disabled?: boolean
) {
  const scope = useRendererLibraryQueryScope();
  const queryKey = scope.key(queryKeys.project.byId(projectId));
  return useQuery({
    queryKey,
    queryFn: () => scope.run(() => fetchProject(projectId, scope.work)),
    retry: scope.retry(queryKey),
    enabled:
      scope.active && !!projectId && projectId !== "undefined" && !disabled,
    staleTime: Infinity,
    gcTime: isLocalApp ? undefined : Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: (data) => {
      if (!data) return data;
      const derived = deriveProjectTracks(data);
      return select ? select(derived) : derived;
    }
  });
}

export { useProject };
