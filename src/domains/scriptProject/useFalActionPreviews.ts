import { useQueries } from "@tanstack/react-query";

import { queryKeys } from "@/queryKeys";

import {
  postGenerateProjectSheets,
  type GenerateProjectSheetsRequest
} from "./api/postGenerateProjectSheets";
import {
  postGenerateProjectShots,
  type GenerateProjectShotsRequest
} from "./api/postGenerateProjectShots";

export const useSheetActionPreviews = (
  requests: (GenerateProjectSheetsRequest & { enabled: boolean })[]
) =>
  useQueries({
    queries: requests.map(({ enabled, ...request }) => ({
      queryKey: [
        ...queryKeys.projectState.sheetsDryRun(
          request.projectId,
          request.outputSize,
          request.settings
        ),
        request.tokens
      ],
      queryFn: () => postGenerateProjectSheets(request),
      enabled
    }))
  });
export const useShotActionPreviews = (
  requests: (GenerateProjectShotsRequest & { enabled: boolean })[]
) =>
  useQueries({
    queries: requests.map(({ enabled, ...request }) => ({
      queryKey: [
        ...queryKeys.projectState.shotsDryRun(
          request.projectId,
          request.outputSize,
          request.videoSettings,
          request.sequential
        ),
        request.timelineIds
      ],
      queryFn: () => postGenerateProjectShots(request),
      enabled
    }))
  });
