import {
  SheetGenerateResult,
  SheetGenerateResultSchema
} from "@schemas/scriptProject";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { SCRIPT_PROJECT_RENDER_MODE } from "../constants";

export type GenerateProjectSheetsRequest = {
  projectId: string;
  isDryRun: boolean;
  outputSize?: [number, number];
  settings?: Record<string, unknown>;
  tokens?: string[];
  shouldScoreImages?: boolean;
};

export const postGenerateProjectSheets = async (
  {
    projectId,
    isDryRun,
    outputSize,
    settings,
    tokens,
    shouldScoreImages
  }: GenerateProjectSheetsRequest,
  work = rendererLibrary.capture()
): Promise<SheetGenerateResult> => {
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      `/projects/${projectId}/sheets/generate`,
      {
        ...(outputSize ? { output_size: outputSize } : {}),
        settings: { ...settings, render_mode: SCRIPT_PROJECT_RENDER_MODE },
        ...(tokens ? { tokens } : {}),
        ...(shouldScoreImages ? { metrics: true } : {}),
        dry_run: isDryRun
      },
      { signal }
    )
  );
  return SheetGenerateResultSchema.parse(response.data);
};
