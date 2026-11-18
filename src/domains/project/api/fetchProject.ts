import { Project, ProjectSchema } from "@schemas/project";

import { backendApiClient } from "@/lib/backend-api-client";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

export async function fetchProject(
  projectId: Project["id"] | undefined,
  work?: RendererLibraryWork
) {
  if (!projectId) return undefined;
  work?.check();
  const desktop = window.mago;
  const response = desktop
    ? work
      ? await work.boundary(() => desktop.projects.get(projectId))
      : await desktop.projects.get(projectId)
    : (await backendApiClient.get<Project>(`/projects/${projectId}`)).data;
  work?.check();
  if (!response) return undefined;

  const parsedData = ProjectSchema.safeParse(response);
  if (!parsedData.success) {
    console.error("Failed to parse project data:", parsedData.error);
    return response as Project;
  }

  return parsedData.data;
}
