import { ProjectCut, ProjectCutSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

export const getProjectCut = async (
  projectId: string,
  _options: { preferCache?: boolean } = {},
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<ProjectCut> => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.get(`/projects/${projectId}/cut`, { signal })
  );
  work.check();
  return ProjectCutSchema.parse(response.data);
};
