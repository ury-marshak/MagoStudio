import { useQuery } from "@tanstack/react-query";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { fetchBulkRendersRuns } from "../api/fetchBulkRendersRuns";
import { resolveBulkRendersRunListPollInterval } from "../utils/resolveBulkRendersRunListPollInterval";

const useBulkRendersRunList = ({
  queryKey,
  projectId,
  enabled
}: {
  queryKey: readonly unknown[];
  projectId: string | undefined;
  enabled: boolean;
}) => {
  const { work, libraryVersion } = useRendererLibraryWork();
  const query = useQuery({
    queryKey: isLocalApp ? [...queryKey, libraryVersion] : queryKey,
    queryFn: () =>
      isLocalApp
        ? fetchBulkRendersRuns(projectId, work)
        : fetchBulkRendersRuns(projectId),
    enabled: enabled && !work.signal.aborted,
    refetchInterval: (query) =>
      resolveBulkRendersRunListPollInterval({
        hasQueryErrored: query.state.status === "error",
        consecutiveFailureCount: query.state.fetchFailureCount,
        runs: query.state.data
      })
  });
  return { ...query, work };
};

export const useBulkRendersRunsForProject = (
  projectId: string | undefined,
  enabled = true
) =>
  useBulkRendersRunList({
    queryKey: queryKeys.bulkRendersRuns.byProjectId(projectId),
    projectId,
    enabled: !!projectId && enabled
  });

export const useBulkRendersRunsAcrossProjects = (enabled = true) =>
  useBulkRendersRunList({
    queryKey: queryKeys.bulkRendersRuns.everyProject(),
    projectId: undefined,
    enabled
  });
