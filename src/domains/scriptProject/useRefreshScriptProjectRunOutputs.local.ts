import { useBulkRendersRunsForProject } from "@domains/bulkRendersRun/useBulkRendersRuns";
import { useProject } from "@domains/project/useProject";
/* oxlint-disable custom-react/no-use-effect, react-you-might-not-need-an-effect/no-event-handler -- the durable desktop plan advances outside React, and its revision must refresh the open project's cached output */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { queryKeys } from "@/queryKeys";

const renderPlanRevision = (
  runs: NonNullable<ReturnType<typeof useBulkRendersRunsForProject>["data"]>
): string =>
  runs
    .map(
      (run) =>
        `${run.id}:${run.status}:${run.completed_steps}:${run.progress_pct}`
    )
    .sort()
    .join("|");

/** Refreshes the authoritative local snapshot as a background render plan moves.
 *
 * The first non-empty revision also refreshes once on mount. That closes the
 * race where the Cut query reads just before the final video is persisted but
 * the plan list's first response already sees the run as completed.
 */
export const useRefreshScriptProjectRunOutputs = (
  projectId: string | null | undefined
): void => {
  const queryClient = useQueryClient();
  const { data: project } = useProject(projectId ?? undefined);
  const isLocalProject = project?.origin === "local";
  const { data: projectRuns } = useBulkRendersRunsForProject(
    projectId ?? undefined,
    isLocalProject
  );
  const revisions = useMemo(() => {
    const runs = projectRuns ?? [];
    return {
      shots: renderPlanRevision(
        runs.filter((run) => run.input_settings?.timeline_ids?.length)
      ),
      sheets: renderPlanRevision(
        runs.filter((run) => !run.input_settings?.timeline_ids?.length)
      )
    };
  }, [projectRuns]);
  const observedRevisionRef = useRef<{
    projectId: string;
    shots: string;
    sheets: string;
  } | null>(null);

  useEffect(() => {
    if (!projectId || !isLocalProject || projectRuns === undefined) return;

    const observed = observedRevisionRef.current;
    const isSameProject = observed?.projectId === projectId;
    const shotsChanged =
      !!revisions.shots &&
      (!isSameProject || revisions.shots !== observed.shots);
    const sheetsChanged =
      !!revisions.sheets &&
      (!isSameProject || revisions.sheets !== observed.sheets);
    observedRevisionRef.current = { projectId, ...revisions };
    if (shotsChanged) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectCut.byProjectId(projectId)
      });
    }
    if (shotsChanged || sheetsChanged) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectState.byProjectId(projectId)
      });
    }
  }, [isLocalProject, projectId, projectRuns, queryClient, revisions]);
};
