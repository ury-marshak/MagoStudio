import {
  CutExportDispatch,
  CutExportDispatchSchema
} from "@schemas/scriptProject";
import { isAxiosError } from "axios";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { isLocalScriptProject } from "../projectOrigin";

export type ExportProjectCutRequest = {
  projectId: string;
  isDryRun: boolean;
};

const CONFLICT_STATUS = 409;

export const postProjectCutExport = async (
  request: ExportProjectCutRequest,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<CutExportDispatch> => {
  const isLocal = await work.boundary(() =>
    isLocalScriptProject(request.projectId)
  );
  if (isLocal) {
    // The IPC resolves when submission bookkeeping is done, not when the
    // main-owned export finishes. Only drain the former here.
    const dispatch = await work.boundary(() =>
      getLocalDesktopApi().scriptProjects.exportCut(request)
    );
    work.check();
    return CutExportDispatchSchema.parse(dispatch);
  }
  try {
    const response = await runRendererLibraryRequest(work, (signal) =>
      backendApiClient.post(
        `/projects/${request.projectId}/cut/export`,
        { dry_run: request.isDryRun },
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
