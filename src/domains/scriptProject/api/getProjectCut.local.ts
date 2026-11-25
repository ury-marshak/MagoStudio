import { rendererCloudBackgroundWork } from "@domains/cloud/rendererCloudBackgroundWork";
import { ProjectCut, ProjectCutSchema } from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { isLocalScriptProject } from "../projectOrigin";
import {
  readScriptProjectSnapshot,
  writeScriptProjectSnapshot
} from "../scriptProjectSnapshot";

export const getProjectCut = async (
  projectId: string,
  options: { preferCache?: boolean } = {},
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<ProjectCut> => {
  const desktop = getLocalDesktopApi();
  const isLocal = await work.boundary(() => isLocalScriptProject(projectId));
  const cached = (await readScriptProjectSnapshot(projectId, work))?.cut;
  work.check();
  // Local rendered videos live in this durable snapshot. A generic query
  // invalidation must not replace them with the empty pre-render default.
  if (cached && (isLocal || options.preferCache !== false)) {
    return ProjectCutSchema.parse(cached);
  }
  if (!isLocal && desktop.account.mode === "cloud") {
    try {
      const cloudWork = rendererCloudBackgroundWork(work);
      const response = await runRendererLibraryRequest(cloudWork, (signal) =>
        backendApiClient.get(`/projects/${projectId}/cut`, { signal })
      );
      cloudWork.check();
      const cut = ProjectCutSchema.parse(response.data);
      await writeScriptProjectSnapshot(
        { projectId, intent: "cloud-import", cut },
        cloudWork
      );
      const refreshed = await readScriptProjectSnapshot(projectId, cloudWork);
      cloudWork.check();
      return ProjectCutSchema.parse(refreshed?.cut ?? cut);
    } catch (error) {
      work.check();
      if (cached) return ProjectCutSchema.parse(cached);
      throw error;
    }
  }
  if (isLocal)
    return {
      project_id: projectId,
      shots: [],
      hidden_shots: [],
      missing: [],
      missing_timeline_ids: [],
      export: null
    };
  throw new Error("This script project has not been mirrored yet");
};
