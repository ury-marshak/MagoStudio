import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { ORDINARY_FAL_POLL_MS } from "@/domains/ordinaryFal/useOrdinaryFalAction";
import { libraryQueryKey } from "@/platform/rendererLibraryQuery";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { queryKeys } from "@/queryKeys";

import type {
  OrdinaryFalApi,
  OrdinaryFalJob
} from "../../../desktop/shared/ordinaryFal";

export const videoEffectsHistoryKey = (projectId: string, shotId?: string) =>
  ["videoEffects", "jobs", projectId, shotId ?? null] as const;

const isVideoEffectJob = (
  job: OrdinaryFalJob,
  projectId: string,
  shotId?: string
) =>
  job.projectId === projectId &&
  (shotId === undefined || job.shotId === shotId) &&
  (job.kind === "video-edit" || job.kind === "video-upscale");

export const useVideoEffectsHistory = ({
  bridge,
  work,
  libraryVersion,
  owner,
  projectId,
  shotId
}: {
  bridge: Pick<OrdinaryFalApi, "list">;
  work: RendererLibraryWork;
  libraryVersion: number;
  owner?: AbortSignal;
  projectId: string;
  shotId?: string;
}) => {
  const client = useQueryClient();
  const settled = useRef(new Set<string>());
  const validJob = (job: OrdinaryFalJob) =>
    isVideoEffectJob(job, projectId, shotId);
  const refreshPlacement = (jobs: OrdinaryFalJob[]) => {
    // Only refresh the origin editor, never whichever project is now selected.
    if (work.signal.aborted || owner?.aborted) return;
    const fresh = jobs.filter(
      ({ id, status, placement }) =>
        status === "INGESTED" &&
        placement !== "PENDING" &&
        !settled.current.has(id)
    );
    if (!fresh.length) return;
    fresh.forEach(({ id }) => settled.current.add(id));
    void client.invalidateQueries({
      queryKey: libraryQueryKey(
        queryKeys.project.byId(projectId),
        libraryVersion
      )
    });
    void client.invalidateQueries({
      queryKey: libraryQueryKey(
        queryKeys.timelineList.byProjectId(projectId),
        libraryVersion
      )
    });
  };
  const historyKey = libraryQueryKey(
    videoEffectsHistoryKey(projectId, shotId),
    libraryVersion
  );
  const history = useQuery({
    queryKey: historyKey,
    enabled: !owner?.aborted && !work.signal.aborted,
    queryFn: ({ signal }) =>
      runRendererLibraryRequest(work, async () => {
        const check = () => {
          owner?.throwIfAborted();
          signal.throwIfAborted();
        };
        check();
        const jobs = await bridge.list({ projectId });
        check();
        const effects = jobs.filter(validJob);
        refreshPlacement(effects);
        return effects;
      }),
    refetchInterval: ORDINARY_FAL_POLL_MS,
    retry: false
  });
  return { history, historyKey, validJob, refreshPlacement };
};
