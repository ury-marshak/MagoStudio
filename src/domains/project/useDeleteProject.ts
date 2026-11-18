import { ProjectListItem } from "@domains/project/api/fetchProjectList";
import { Project } from "@schemas/project";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";

import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";
import { PaginatedResponse } from "@/schemas/pagination";

import { backendApiClient } from "../../lib/backend-api-client";

const deleteProject = async (
  { projectId }: { projectId: Project["id"] },
  work: RendererLibraryWork
) => {
  const desktop = window.mago;
  const localProject = desktop
    ? await work.boundary(() => desktop.projects.get(projectId))
    : null;
  if (
    !desktop ||
    (localProject?.origin === "cloud" && desktop.account.mode === "cloud")
  ) {
    await runRendererLibraryRequest(work, (signal) =>
      backendApiClient.delete(`/projects/${projectId}`, { signal })
    );
  }
  if (desktop) await work.boundary(() => desktop.projects.delete(projectId));
};

export const useDeleteProject = (props?: { noInvalidation?: boolean }) => {
  const queryClient = useQueryClient();
  return useRendererLibraryMutation({
    mutationFn: deleteProject,
    onSuccess: (_, params) => {
      if (props?.noInvalidation) return;
      queryClient.setQueryData(queryKeys.projects.all, (old: Project[]) => {
        return old?.filter((project) => project.id !== params.projectId);
      });

      queryClient.setQueriesData<
        InfiniteData<PaginatedResponse<ProjectListItem>>
      >({ queryKey: queryKeys.projectList.all }, (old) => {
        if (!old) return old;
        const newTotal = Math.max((old.pages[0]?.pagination.total ?? 1) - 1, 0);
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== params.projectId),
            pagination: {
              ...page.pagination,
              total: newTotal
            }
          }))
        };
      });

      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectList.all
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.homepage.all });
    }
  });
};
