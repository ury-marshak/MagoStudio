import {
  CutExportDispatch,
  CutExportDispatchSchema
} from "@schemas/scriptProject";
import { isAxiosError } from "axios";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

export type ExportProjectCutRequest = {
  projectId: string;
  isDryRun: boolean;
};

const CONFLICT_STATUS = 409;

/** A refusal is an answer, not a failure — `409` carries the same body as a success and is what
 * tells the caller to fall back to the per-shot download. Only a genuine transport or auth
 * error throws. */
export const postProjectCutExport = async (
  { projectId, isDryRun }: ExportProjectCutRequest,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<CutExportDispatch> => {
  try {
    const response = await runRendererLibraryRequest(work, (signal) =>
      backendApiClient.post(
        `/projects/${projectId}/cut/export`,
        { dry_run: isDryRun },
        { signal }
      )
    );
    work.check();
    return CutExportDispatchSchema.parse(response.data);
  } catch (error) {
    work.check();
    if (isAxiosError(error) && error.response?.status === CONFLICT_STATUS) {
      return CutExportDispatchSchema.parse(error.response.data);
    }
    throw error;
  }
};
