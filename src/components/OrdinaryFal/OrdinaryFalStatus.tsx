import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import {
  ordinaryFalJobsKey,
  ORDINARY_FAL_POLL_MS
} from "@/domains/ordinaryFal/useOrdinaryFalAction";
import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";
import {
  useRendererLibraryQueryScope,
  libraryQueryKey
} from "@/platform/rendererLibraryQuery";
import { queryKeys } from "@/queryKeys";

import type { OrdinaryFalJob } from "../../../desktop/shared/ordinaryFal";

const statusLabel = (job: OrdinaryFalJob) => {
  switch (job.status) {
    case "PREPARING":
      return "Preparing inputs";
    case "NOT_SUBMITTED":
      return "Not submitted";
    case "SUBMITTING":
      return "Confirming submission";
    case "SUBMISSION_UNKNOWN":
      return "Submission unknown — do not resubmit";
    case "SUBMITTED":
      return "Queued or rendering on fal";
    case "CANCELLATION_REQUESTED":
      return "Cancellation requested";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed";
    case "COMPLETED":
      return "Importing result into the library";
    case "INGESTED":
      if (job.placement === "ATTACHED") return "Added to the timeline";
      if (job.placement === "UNATTACHED")
        return "Saved to the project; could not attach to the timeline";
      return "Placing result on the timeline";
  }
};

export const OrdinaryFalStatus = ({
  projectId,
  shotId,
  kind
}: {
  projectId?: string;
  shotId?: string;
  kind: OrdinaryFalJob["kind"];
}) => {
  const client = useQueryClient();
  const scope = useRendererLibraryQueryScope();
  const bridge =
    typeof window === "undefined" ? undefined : window.mago?.ordinaryFal;
  const key = scope.key(ordinaryFalJobsKey(projectId ?? ""));
  const jobs = useQuery({
    queryKey: key,
    queryFn: () =>
      scope.run(async () => {
        const profile = captureRendererAccountProfile();
        profile?.throwIfAborted();
        const list = await bridge!.list({ projectId });
        profile?.throwIfAborted();
        return list;
      }),
    enabled: !!bridge && !!projectId && scope.active,
    refetchInterval: ORDINARY_FAL_POLL_MS,
    retry: false
  });
  const jobsForTool = useMemo(
    () => jobs.data?.filter((job) => job.kind === kind),
    [jobs.data, kind]
  );
  const settled = useRef<{ owner: AbortSignal; ids: Set<string> }>(null);
  const { work, libraryVersion } = scope;

  // oxlint-disable-next-line custom-react/no-use-effect -- synchronize project caches with placement completed by the main worker
  useEffect(() => {
    if (
      !jobsForTool ||
      work.signal.aborted ||
      captureRendererAccountProfile()?.aborted
    )
      return;
    if (settled.current?.owner !== work.signal)
      settled.current = { owner: work.signal, ids: new Set() };
    const refreshProjects = new Set<string>();
    for (const job of jobsForTool) {
      if (
        job.status !== "INGESTED" ||
        job.placement === "PENDING" ||
        settled.current.ids.has(job.id)
      )
        continue;
      settled.current.ids.add(job.id);
      refreshProjects.add(job.projectId);
    }
    for (const id of refreshProjects) {
      // Both editor shot views derive from the original project query. Never
      // invalidate by whichever project/shot happens to be selected now.
      void client.invalidateQueries({
        queryKey: libraryQueryKey(queryKeys.project.byId(id), libraryVersion)
      });
      void client.invalidateQueries({
        queryKey: libraryQueryKey(
          queryKeys.timelineList.byProjectId(id),
          libraryVersion
        )
      });
    }
  }, [client, jobsForTool, libraryVersion, work]);

  if (!bridge || !projectId || !scope.active) return null;
  const visible =
    jobsForTool?.filter((job) => !shotId || job.shotId === shotId) ?? [];
  if (!visible.length && !jobs.isError) return null;
  return (
    <section
      aria-label="Direct fal jobs"
      className="border-b border-glyph-invert-main p-3 text-xs"
    >
      <h3 className="font-medium">Direct fal jobs</h3>
      {jobs.isError && (
        <p role="status">Could not read fal job status. Checking again…</p>
      )}
      <ul className="max-h-32 space-y-2 overflow-y-auto scrollbar-custom">
        {visible.map((job) => (
          <li key={job.id} title={job.id}>
            {statusLabel(job)}
            {job.error && (
              <p className="break-words text-glyph-secondary">{job.error}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
