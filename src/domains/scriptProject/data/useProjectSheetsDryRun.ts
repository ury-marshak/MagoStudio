import { useQuery } from "@tanstack/react-query";

import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { postGenerateProjectSheets } from "../api/postGenerateProjectSheets";

export const useProjectSheetsDryRun = (
  projectId: string | null | undefined,
  outputSize: [number, number],
  settings?: Record<string, unknown>,
  enabled = true
) => {
  const { work, libraryVersion } = useRendererLibraryWork();
  return useQuery({
    queryKey: [
      ...queryKeys.projectState.sheetsDryRun(projectId, outputSize, settings),
      libraryVersion
    ],
    queryFn: () =>
      postGenerateProjectSheets(
        {
          projectId: projectId!,
          isDryRun: true,
          outputSize,
          settings
        },
        work
      ),
    enabled: !!projectId && enabled && !work.signal.aborted
  });
};
