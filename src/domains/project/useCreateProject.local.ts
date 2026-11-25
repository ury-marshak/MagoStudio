import { rendererCloudBackgroundWork } from "@domains/cloud/rendererCloudBackgroundWork";
import { writeScriptProjectSnapshot } from "@domains/scriptProject/scriptProjectSnapshot";
import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";
import { Project } from "@schemas/project";
import { ProjectType } from "@schemas/scriptProject";
import { useToast } from "@store/useToast";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { backendApiClient } from "@/lib/backend-api-client";
import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";
import { useRendererLibraryMutation } from "@/platform/useRendererLibraryMutation";
import { queryKeys } from "@/queryKeys";

import { ProjectCreationTarget } from "./projectCreationTarget";
import { isProjectQuotaReachedError } from "./utils/isProjectQuotaReachedError";

type CreateProjectParams = {
  projectName: string;
  projectDescription: string;
  rangeMin: number;
  rangeMax: number;
  projectType?: ProjectType;
  creationTarget?: ProjectCreationTarget;
};

export const createProject = async (
  {
    projectName,
    projectDescription,
    rangeMin,
    rangeMax,
    projectType,
    creationTarget
  }: CreateProjectParams,
  work = rendererLibrary.capture()
): Promise<Project> => {
  work.check();
  const desktop = window.mago;
  const shouldCreateCloudProject =
    creationTarget === "cloud" ||
    (creationTarget === undefined &&
      projectType === "script_to_shots" &&
      desktop?.account.mode === "cloud");
  if (
    creationTarget === "cloud" &&
    desktop &&
    desktop.account.mode !== "cloud"
  ) {
    throw new Error("Mago Cloud is not available");
  }
  if (!desktop || shouldCreateCloudProject) {
    const cloudWork = desktop ? rendererCloudBackgroundWork(work) : work;
    const response = await runRendererLibraryRequest(cloudWork, (signal) =>
      backendApiClient.post(
        `/projects`,
        {
          name: projectName,
          description: projectDescription,
          ...(projectType ? { type: projectType } : {}),
          settings: { rangeMin, rangeMax }
        },
        { signal }
      )
    );
    cloudWork.check();
    const project = response.data as Project;
    if (desktop && shouldCreateCloudProject) {
      if (projectType === "script_to_shots") {
        await writeScriptProjectSnapshot(
          {
            projectId: project.id,
            intent: "cloud-import",
            project: project as Record<string, unknown>
          },
          cloudWork
        );
      } else {
        await syncCloudProjectMetadata(project.id, cloudWork);
      }
    }
    cloudWork.check();
    return project;
  }
  const library = await work.boundary(() => desktop.library.get());
  if (!library) throw new Error("The local Mago library is unavailable");
  const response = await work.boundary(() =>
    desktop.projects.create({
      name: projectName,
      description: projectDescription,
      settings: {
        rangeMin,
        rangeMax,
        ...(projectType ? { type: projectType } : {})
      }
    })
  );
  work.check();
  if (projectType === "script_to_shots") {
    await writeScriptProjectSnapshot(
      {
        projectId: response.id,
        state: {
          project_id: response.id,
          sheets_timeline_id: null,
          keys: [],
          shots: []
        },
        scriptVersions: { active_version: null, versions: [] },
        cut: {
          project_id: response.id,
          shots: [],
          missing: [],
          export: null
        }
      },
      work
    );
    work.check();
  }
  return response as Project;
};

export const useCreateProject = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation();

  return useRendererLibraryMutation({
    mutationFn: createProject,
    onSuccess: (newProject) => {
      queryClient.setQueryData(
        libraryQueryKey(queryKeys.projects.all),
        (old: Project[] | undefined) => {
          return [...(old ?? []), newProject];
        }
      );

      void queryClient.invalidateQueries({ queryKey: queryKeys.homepage.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectList.all
      });
    },
    onError: (error) => {
      if (isProjectQuotaReachedError(error)) {
        showToast({
          message: t("notifications.project_quota_reached.description")
        });
        return;
      }
      showToast({
        message:
          error instanceof Error
            ? error.message
            : t("notifications.project_create_failed.description")
      });
    }
  });
};
