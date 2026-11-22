import { resumePlan } from "@domains/plan/resumePlan";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

export const postBulkRendersRunResume = async (
  bulkRunId: string,
  work?: RendererLibraryWork
): Promise<void> => {
  await resumePlan(bulkRunId, work);
};
