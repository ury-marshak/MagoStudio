import { PlanSummary } from "@schemas/plan";
import { useQuery } from "@tanstack/react-query";

import { isLocalApp } from "@/platform/localDesktop";
import { useRendererLibraryWork } from "@/platform/useRendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import { fetchPlanProgress } from "../api/fetchPlanProgress";
import { ACTIVE_PLAN_STATUSES } from "../utils/planStatuses";

const ACTIVE_POLL_INTERVAL_MS = 10000;

export const usePlanProgress = (
  planId: string,
  pollIntervalMs: number = ACTIVE_POLL_INTERVAL_MS
) => {
  const { work, libraryVersion } = useRendererLibraryWork();
  const key = queryKeys.planProgress.byId(planId);
  const query = useQuery({
    queryKey: isLocalApp ? [...key, libraryVersion] : key,
    queryFn: () =>
      isLocalApp ? fetchPlanProgress(planId, work) : fetchPlanProgress(planId),
    enabled: !!planId && !work.signal.aborted,
    refetchInterval: (query) => {
      const status = (query.state.data as PlanSummary | undefined)?.status;
      if (status && !ACTIVE_PLAN_STATUSES.has(status)) return false;
      return pollIntervalMs;
    }
  });
  return { ...query, work };
};
