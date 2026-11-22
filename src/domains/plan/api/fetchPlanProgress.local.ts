import { PlanSummary } from "@schemas/plan";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { findPlanReadableFromDesktop } from "./findPlanReadableFromDesktop";

export const fetchPlanProgress = async (
  planId: string,
  work?: RendererLibraryWork
): Promise<PlanSummary> => {
  const desktopPlan = await (work
    ? work.boundary(() => findPlanReadableFromDesktop(planId))
    : findPlanReadableFromDesktop(planId));
  if (desktopPlan) return desktopPlan as PlanSummary;
  const path = `/agent/plans/${planId}/progress`;
  const response = await (work
    ? runRendererLibraryRequest(work, (signal) =>
        backendApiClient.get<PlanSummary>(path, { signal })
      )
    : backendApiClient.get<PlanSummary>(path));
  return response.data;
};
