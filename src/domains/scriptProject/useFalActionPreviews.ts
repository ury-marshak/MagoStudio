import { useQueries } from "@tanstack/react-query";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
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
) => {
  const { work, libraryVersion } = useRendererLibraryWork();
  return useQueries({
    queries: requests.map(({ enabled, ...request }) => ({
      queryKey: [
        ...queryKeys.projectState.sheetsDryRun(
          request.projectId,
          request.outputSize,
          request.settings
        ),
        request.tokens,
        libraryVersion
      ],
      queryFn: () => postGenerateProjectSheets(request, work),
      enabled: enabled && !work.signal.aborted
    }))
  });
};
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
