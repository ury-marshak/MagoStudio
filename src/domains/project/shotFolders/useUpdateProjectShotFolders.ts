import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useUpdateProject } from "../useUpdateProject";

import { ShotFolderOrShot } from "./interface";
import { useProjectShotFolders } from "./useProjectShotFolders";

export const useUpdateProjectShotFolders = (projectId: string | undefined) => {
  const { work: origin } = useRendererLibraryWork();
  const { data } = useProjectShotFolders(projectId);
  const project = data?.project;
  const queryClient = useQueryClient();

  const mutation = useUpdateProject({
    onMutate: async (updatedProject, work) => {
      await queryClient.cancelQueries({
        queryKey: libraryQueryKey(queryKeys.project.byId(projectId))
      });
      work.check();

      queryClient.setQueryData(
        libraryQueryKey(queryKeys.project.byId(projectId)),
        (oldProject: Project | undefined) => {
          if (!oldProject) return oldProject;
          return {
            ...oldProject,
            settings: updatedProject.settings
          };
        }
      );
    }
  });

  const updateShotFolders = async (
    shotFolders: ShotFolderOrShot[],
    work = origin
  ) => {
    work.check();
    const current =
      queryClient.getQueryData<Project>(
        libraryQueryKey(queryKeys.project.byId(projectId))
      ) ?? project;
    if (!current) return;

    await mutation.mutateAsync(
      {
        projectId: current.id,
        projectName: current.name,
        projectDescription: current.description,
        settings: {
          ...current.settings,
          shotFolders
        },
        settingsPatch: { shotFolders },
        settingsMergeBase: { shotFolders: current.settings.shotFolders ?? [] }
      },
      work
    );
  };

  return {
    ...mutation,
    mutateAsync: updateShotFolders
  };
};
