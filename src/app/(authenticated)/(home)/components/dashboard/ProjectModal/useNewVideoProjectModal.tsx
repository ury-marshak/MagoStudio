import { useDeleteProject } from "@domains/project/useDeleteProject";
import { Project } from "@schemas/project";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import { type RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { ProjectModal } from "./ProjectModal";

export const useNewVideoProjectModal = () => {
  const { work } = useRendererLibraryWork();
  const [newProject, setNewProject] = useState<{
    id: string;
    work: RendererLibraryWork;
  }>();
  const newVideoProjectId =
    newProject?.work.signal === work.signal && !work.signal.aborted
      ? newProject.id
      : undefined;
  const queryClient = useQueryClient();
  const { mutate: deleteProject } = useDeleteProject();

  const closeNewVideoProjectModal = () => {
    if (newVideoProjectId && newProject && !newProject.work.signal.aborted) {
      const project = queryClient.getQueryData<Project>(
        libraryQueryKey(queryKeys.project.byId(newVideoProjectId))
      );
      const hasContent =
        !project ||
        project.timelines?.some((timeline) => timeline.layers.length > 0);
      if (!hasContent) {
        void queryClient.cancelQueries({ queryKey: queryKeys.projectList.all });
        deleteProject({ projectId: newVideoProjectId }, newProject.work);
      }
    }
    setNewProject(undefined);
  };

  return {
    openNewVideoProjectModal: (newProject: Project) => {
      if (!work.signal.aborted) setNewProject({ id: newProject.id, work });
    },
    newVideoProjectModal: (
      <ProjectModal
        open={!!newVideoProjectId}
        onClose={closeNewVideoProjectModal}
        projectId={newVideoProjectId ?? undefined}
      />
    )
  };
};
