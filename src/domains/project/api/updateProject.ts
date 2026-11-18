import { writeScriptProjectSnapshot } from "@domains/scriptProject/scriptProjectSnapshot";
import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";
import { Project, ProjectSchema } from "@schemas/project";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { buildCloudProjectSettings } from "../utils/buildCloudProjectSettings";
import { ProjectSettingsMergeBase } from "../utils/mergeSettingsPatchWithCloudSettings";

import { fetchCloudProjectSettings } from "./fetchCloudProjectSettings";

export type UpdateProjectParams = {
  projectId: string;
  projectName: string;
  projectDescription: string | null;
  settings?: { [key: string]: any };
  settingsPatch: Record<string, unknown>;
  settingsMergeBase?: ProjectSettingsMergeBase;
};

const resolveCloudPutSettings = async (
  {
    projectId,
    settings,
    settingsPatch,
    settingsMergeBase
  }: UpdateProjectParams,
  work: RendererLibraryWork
) => {
  if (!window.mago) {
    return { settingsToPut: settings, settingsToCache: settings };
  }
  const freshSettings = await runRendererLibraryRequest(work, (signal) =>
    fetchCloudProjectSettings(projectId, signal)
  );
  const settingsToPut = buildCloudProjectSettings(
    freshSettings,
    settingsPatch,
    settingsMergeBase
  );
  const parsedSettings = ProjectSchema.shape.settings.safeParse(settingsToPut);
  return {
    settingsToPut,
    settingsToCache: parsedSettings.success ? parsedSettings.data : settings
  };
};

export const updateProject = async (
  params: UpdateProjectParams,
  work = rendererLibrary.capture()
): Promise<Project["settings"] | undefined> => {
  const { projectId, projectName, projectDescription, settings } = params;
  const desktop = window.mago;
  const localProject = desktop
    ? await work.boundary(() => desktop.projects.get(projectId))
    : null;
  work.check();
  if (
    !desktop ||
    !localProject ||
    (localProject.origin === "cloud" && desktop.account.mode === "cloud")
  ) {
    const { settingsToPut, settingsToCache } = await resolveCloudPutSettings(
      params,
      work
    );
    const response = await runRendererLibraryRequest(work, (signal) =>
      backendApiClient.put(
        `/projects/${projectId}`,
        {
          name: projectName,
          description: projectDescription,
          settings: settingsToPut
        },
        { signal }
      )
    );
    work.check();
    if (localProject?.type === "script_to_shots") {
      await writeScriptProjectSnapshot(
        {
          projectId,
          project: response.data as Record<string, unknown>
        },
        work
      );
    } else if (localProject?.origin === "cloud") {
      await syncCloudProjectMetadata(projectId, work);
    }
    work.check();
    return settingsToCache as Project["settings"] | undefined;
  }
  const storedLocalProjectSettings =
    (localProject.settings as Record<string, unknown> | undefined) ?? {};
  await work.boundary(() =>
    desktop.projects.update({
      projectId,
      name: projectName,
      description: projectDescription ?? "",
      settings:
        localProject.type === "script_to_shots"
          ? {
              ...storedLocalProjectSettings,
              ...(settings ?? {}),
              type: "script_to_shots"
            }
          : (settings ?? storedLocalProjectSettings)
    })
  );
  work.check();
  return settings as Project["settings"] | undefined;
};
