import { useQuery } from "@tanstack/react-query";

import { MINUTES_TO_MILLISECONDS } from "@/constants";
import { useRendererLibraryQueryScope } from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import { fetchTimelineList } from "./api/fetchTimelineList";

const STALE_TIME_MINUTES = 5;
const STALE_TIME_MS = STALE_TIME_MINUTES * MINUTES_TO_MILLISECONDS;

export const useTimelineList = (projectId: string | undefined) => {
  const scope = useRendererLibraryQueryScope();
  const queryKey = scope.key(queryKeys.timelineList.byProjectId(projectId));
  const query = useQuery({
    queryKey,
    queryFn: () =>
      scope.run(() => fetchTimelineList({ projectId: projectId! }, scope.work)),
    retry: scope.retry(queryKey),
    enabled: scope.active && !!projectId,
    staleTime: STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true
  });

  const items = query.data?.items ?? [];

  const thumbnailUrlById: Record<string, string | undefined> = {};
  for (const item of items) {
    thumbnailUrlById[item.id] = item.preview_url ?? undefined;
  }

  const timelineIdsByMostRecentlyEdited = items.map((item) => item.id);

  return {
    thumbnailUrlById,
    timelineIdsByMostRecentlyEdited,
    isLoading: query.isLoading
  };
};
