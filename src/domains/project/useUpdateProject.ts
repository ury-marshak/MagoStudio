import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { UpdateProjectParams, updateProject } from "./api/updateProject";
import { applyProjectUpdateToCache } from "./utils/applyProjectUpdateToCache";

export const useUpdateProject = <Context = unknown>({
  onMutate,
  onError
}: {
  onMutate?: (
    variables: UpdateProjectParams,
    work: RendererLibraryWork
  ) => Context | Promise<Context>;
  onError?: (
    error: unknown,
    variables: UpdateProjectParams,
    context: Context | undefined
  ) => void;
} = {}) => {
  const queryClient = useQueryClient();
  return useRendererLibraryMutation({
    mutationFn: updateProject,
    onMutate,
    onError,
    onSuccess: (persistedSettings, variables) => {
      const cachedVariables = {
        ...variables,
        settings: persistedSettings ?? variables.settings
      };
      queryClient.setQueryData(
        queryKeys.project.byId(variables.projectId),
        (oldProject: Project | undefined) =>
          applyProjectUpdateToCache(oldProject, cachedVariables)
      );

      queryClient.setQueryData(
        queryKeys.projects.all,
        (old: Project[] | undefined) => {
          if (!old) return old;
          return old.map((project) =>
            project.id === variables.projectId
              ? (applyProjectUpdateToCache(project, cachedVariables) ?? project)
              : project
          );
        }
      );

      void queryClient.invalidateQueries({ queryKey: queryKeys.homepage.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectList.all
      });
    }
  });
};
