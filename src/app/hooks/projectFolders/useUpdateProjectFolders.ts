import { useEnsureLocalFolderDummyProject } from "@domains/project/useEnsureLocalFolderDummyProject";
import { useUpdateProject } from "@domains/project/useUpdateProject";
import { identityMode, useUser } from "@platform/identity";
import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { FolderOrProject } from "./interface";
import { useProjectFolders } from "./useProjectFolders";
import { replaceProjectSettings } from "./utils/replaceProjectSettings";

const isFolderDummyProjectCreatedByThisApp =
  isLocalApp && identityMode === "offline";

export const useUpdateProjectFolders = () => {
  const { data } = useProjectFolders();
  const folderDummyProject = data?.folderDummyProject;
  const { user } = useUser();
  const ensureLocalFolderDummyProject = useEnsureLocalFolderDummyProject();

  const mutation = useUpdateProject({
    onMutate: async (variables, work) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.all });
      work.check();
      const { projectId, settings } = variables;
      if (!settings) return;

      queryClient.setQueryData(
        queryKeys.projects.all,
        (oldProjects: Project[] | undefined) =>
          replaceProjectSettings(oldProjects, projectId, settings)
      );
    }
  });
  const queryClient = useQueryClient();

  const resolveFolderDummyProjectToUpdate = async (
    work: RendererLibraryWork
  ) => {
    if (folderDummyProject) return folderDummyProject;
    if (!isFolderDummyProjectCreatedByThisApp || !user) return undefined;
    return ensureLocalFolderDummyProject(user.id, work);
  };

  const updateProjectFolders = async (
    projectFolders: FolderOrProject[],
    work = rendererLibrary.capture()
  ) => {
    work.check();
    const folderDummyProjectToUpdate =
      await resolveFolderDummyProjectToUpdate(work);
    work.check();
    if (!folderDummyProjectToUpdate) return;

    await mutation.mutateAsync(
      {
        projectId: folderDummyProjectToUpdate.id,
        projectName: folderDummyProjectToUpdate.name,
        projectDescription: folderDummyProjectToUpdate.description,
        settings: {
          ...folderDummyProjectToUpdate.settings,
          folders: projectFolders
        },
        settingsPatch: { folders: projectFolders },
        settingsMergeBase: {
          folders: folderDummyProjectToUpdate.settings.folders ?? []
        }
      },
      work
    );
  };

  return {
    ...mutation,
    mutateAsync: updateProjectFolders
  };
};
