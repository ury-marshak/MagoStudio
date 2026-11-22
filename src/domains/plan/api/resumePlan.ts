import { Plan } from "@schemas/plan";

import { backendApiClient } from "@/lib/backend-api-client";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

export const resumePlan = async (
  planId: string,
  work?: RendererLibraryWork
): Promise<Plan> => {
  const response = await backendApiClient.post<Plan>(
    `/agent/plans/${planId}/resume`,
    undefined,
    { signal: work?.signal }
  );
  return response.data;
};
