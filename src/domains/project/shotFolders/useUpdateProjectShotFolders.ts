import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { rendererLibrary } from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useUpdateProject } from "../useUpdateProject";

import { ShotFolderOrShot } from "./interface";
import { useProjectShotFolders } from "./useProjectShotFolders";

export const useUpdateProjectShotFolders = (projectId: string | undefined) => {
  const { data } = useProjectShotFolders(projectId);
  const project = data?.project;
  const queryClient = useQueryClient();

  const mutation = useUpdateProject({
    onMutate: async (updatedProject, work) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.project.byId(projectId)
      });
      work.check();

      queryClient.setQueryData(
        queryKeys.project.byId(projectId),
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
    work = rendererLibrary.capture()
  ) => {
    work.check();
    const current =
      queryClient.getQueryData<Project>(queryKeys.project.byId(projectId)) ??
      project;
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
