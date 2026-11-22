import { BulkRendersRun, BulkRendersRunSchema } from "@schemas/bulkRendersRun";

import { backendApiClient } from "@/lib/backend-api-client";
import {
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { listLocalBulkRendersRuns } from "./localBulkRendersRun";

const parseCloudRuns = (value: unknown): BulkRendersRun[] =>
  !Array.isArray(value)
    ? []
    : value.flatMap((run) => {
        const parsed = BulkRendersRunSchema.safeParse(run);
        // Scenario-agent plans have no timeline list and belong in Plans, not Bulk Rendering.
        return parsed.success &&
          Array.isArray(parsed.data.input_settings?.timeline_ids)
          ? [parsed.data]
          : [];
      });

export const fetchBulkRendersRuns = async (
  projectId?: string,
  work?: RendererLibraryWork
): Promise<BulkRendersRun[]> => {
  const desktop = typeof window === "undefined" ? undefined : window.mago;
  const params = projectId ? { project_id: projectId } : undefined;
  const fetchCloud = () =>
    work
      ? runRendererLibraryRequest(work, (signal) =>
          backendApiClient.get("/agent/plans", { params, signal })
        )
      : backendApiClient.get("/agent/plans", { params });
  if (!desktop) {
    const response = await fetchCloud();
    return parseCloudRuns(response.data);
  }
  // Local project plans are authoritative on disk, even while signed in.
  // Waiting for a cloud history request here stalls the local history panel.
  if (
    desktop.account.mode === "cloud" &&
    projectId &&
    (
      await (work
        ? work.boundary(() => desktop.projects.get(projectId))
        : desktop.projects.get(projectId))
    )?.origin === "local"
  )
    return listLocalBulkRendersRuns(projectId, work);
  const localRunsPromise = listLocalBulkRendersRuns(projectId, work);
  if (desktop.account.mode !== "cloud") return localRunsPromise;

  const [localRuns, cloudResult] = await Promise.all([
    localRunsPromise,
    fetchCloud()
      .then((response) => parseCloudRuns(response.data))
      .catch((error: unknown) => {
        work?.check();
        console.warn("Could not load cloud bulk-render history", error);
        return [];
      })
  ]);
  work?.check();
  const runsById = new Map(
    [...cloudResult, ...localRuns].map((run) => [run.id, run])
  );
  return [...runsById.values()];
};
