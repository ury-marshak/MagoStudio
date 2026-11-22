import { backendApiClient } from "@/lib/backend-api-client";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

export const postBulkRendersRunResume = async (
  bulkRunId: string,
  work?: RendererLibraryWork
): Promise<void> => {
  await backendApiClient.post(
    `/agent/plans/${encodeURIComponent(bulkRunId)}/resume`,
    undefined,
    { signal: work?.signal }
  );
};
