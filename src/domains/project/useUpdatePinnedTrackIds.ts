import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { useProject } from "./useProject";
import { useUpdateProject } from "./useUpdateProject";

export const useUpdatePinnedTrackIds = (projectId: string | undefined) => {
  const { work } = useRendererLibraryWork();
  const { data: project } = useProject(projectId);
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

  const updatePinnedTrackIds = async (newPinned: Record<string, string>) => {
    if (!project || work.signal.aborted) return;

    await mutation.mutateAsync(
      {
        projectId: project.id,
        projectName: project.name,
        projectDescription: project.description,
        settings: {
          ...project.settings,
          pinnedTrackIds: newPinned
        },
        settingsPatch: { pinnedTrackIds: newPinned },
        settingsMergeBase: {
          pinnedTrackIds: project.settings.pinnedTrackIds ?? {}
        }
      },
      work
    );
  };

  const pinTrack = async (shotId: string, layerId: string) => {
    const currentPinned = project?.settings?.pinnedTrackIds ?? {};
    await updatePinnedTrackIds({ ...currentPinned, [shotId]: layerId });
  };

  const unpinTrack = async (shotId: string) => {
    const { [shotId]: _, ...newPinned } =
      project?.settings?.pinnedTrackIds ?? {};
    await updatePinnedTrackIds(newPinned);
  };

  return { pinTrack, unpinTrack };
};
