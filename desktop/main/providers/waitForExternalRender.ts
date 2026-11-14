import { setTimeout } from "node:timers/promises";

import type { ExternalRenderJob } from "./externalRenderJobRepository";
import type { ExternalRenderJobService } from "./externalRenderJobService";

const pollIntervalMs = 2500;

export const waitForExternalRender = async (
  jobs: ExternalRenderJobService,
  job: ExternalRenderJob,
  signal: AbortSignal,
  onSubmitted: () => Promise<void>
) => {
  const jobId = job.id;
  try {
    signal.throwIfAborted();
    if (job.requestId) await onSubmitted();
    while (
      job.status === "SUBMITTED" ||
      job.status === "CANCELLATION_REQUESTED"
    ) {
      signal.throwIfAborted();
      job = await jobs.refresh(jobId, signal);
      if (job.status === "SUBMITTED" || job.status === "CANCELLATION_REQUESTED")
        await setTimeout(pollIntervalMs, undefined, { signal });
    }
    if (job.status === "OUTPUT_READY") job = await jobs.ingest(jobId, signal);
    const assetId = job.outputJson?.assetIds?.[0];
    if (job.status === "INGESTED" && assetId) return { assetId, job };
    if (job.status === "SUBMISSION_UNKNOWN" || job.status === "SUBMITTING")
      throw new Error(
        `${job.provider} may have accepted this render. Check the provider's request history before starting a new render.`
      );
    throw new Error(
      job.error ?? `${job.provider} render ended with status ${job.status}`
    );
  } catch (error) {
    if (signal.aborted) await jobs.cancel(jobId).catch(() => undefined);
    throw error;
  }
};
