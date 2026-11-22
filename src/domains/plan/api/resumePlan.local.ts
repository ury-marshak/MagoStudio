import {
  CLOUD_SHEET_EXECUTOR,
  executeCloudSheetPlan
} from "@domains/scriptProject/cloudSheetRender.local";
import { Plan } from "@schemas/plan";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { findLocallyRunPlan } from "./findLocallyRunPlan";

export const resumePlan = async (
  planId: string,
  work = rendererLibrary.capture()
): Promise<Plan> => {
  if (await work.boundary(() => findLocallyRunPlan(planId))) {
    const resumed = await work.boundary(() =>
      getLocalDesktopApi().scriptProjects.resumePlan(planId)
    );
    work.check();
    // A cloud sheet plan is run by the renderer, not the desktop.
    if (resumed.local_executor === CLOUD_SHEET_EXECUTOR)
      void executeCloudSheetPlan(planId, work);
    return resumed as Plan;
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post<Plan>(`/agent/plans/${planId}/resume`, undefined, {
      signal
    })
  );
  return response.data;
};
