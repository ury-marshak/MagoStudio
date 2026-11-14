import {
  resolveFalGenerationSettings,
  type FalGenerationSettings
} from "../../../shared/falGenerationSettings";
import {
  FAL_SHOT_ENGINE,
  FAL_SHOT_IMAGE_SLOTS
} from "../../../shared/falShotModel";
import {
  FAL_COMBINED_REFERENCE_SLOTS,
  FAL_COMBINED_VIDEO_SECONDS,
  FAL_VIDEO_REFERENCE_SLOTS,
  videoTailProvenanceSchema,
  type VideoTailProvenance
} from "../../../shared/falVideoTail";
import type { ExternalRenderJob } from "../../providers/externalRenderJobRepository";
import type { ExternalRenderJobService } from "../../providers/externalRenderJobService";
import { waitForExternalRender } from "../../providers/waitForExternalRender";

import {
  assertPreparedShotJob,
  assertPreparedShotOwner,
  parsePreparedFalShot
} from "./preparedFalShot";

export { FAL_SHOT_IMAGE_SLOTS } from "../../../shared/falShotModel";

export const renderFalShot = async (
  jobs: ExternalRenderJobService,
  input: {
    jobId: string;
    savedJob: ExternalRenderJob | null;
    projectId: string;
    prompt: string;
    duration: number;
    settings?: FalGenerationSettings;
    sourceIds: string[];
    videoInputs?: Array<{ assetId: string; provenance: VideoTailProvenance }>;
    recovering?: boolean;
    signal: AbortSignal;
    onSubmitted: () => Promise<void>;
  }
) => {
  let job = input.savedJob;
  if (!job) {
    if (input.recovering)
      throw new Error("Resume the plan to submit its remaining renders");
    const videos = input.videoInputs ?? [];
    if (!input.sourceIds.length && !videos.length)
      throw new Error(
        "H3 Max requires at least one image or video reference in Director"
      );
    if (input.sourceIds.length > FAL_SHOT_IMAGE_SLOTS)
      throw new Error("H3 Max accepts up to 9 reference images");
    if (
      videos.length > FAL_VIDEO_REFERENCE_SLOTS ||
      input.sourceIds.length + videos.length > FAL_COMBINED_REFERENCE_SLOTS
    )
      throw new Error("H3 Max reference count limit exceeded");
    const provenance = videos.map((video) =>
      videoTailProvenanceSchema.parse(video.provenance)
    );
    if (
      provenance.reduce((sum, tail) => sum + tail.output_duration_seconds, 0) >
      FAL_COMBINED_VIDEO_SECONDS
    )
      throw new Error("H3 Max accepts at most 15 seconds of reference video");
    if (
      new Set([...input.sourceIds, ...videos.map((video) => video.assetId)])
        .size !==
      input.sourceIds.length + videos.length
    )
      throw new Error("Render references must have distinct asset IDs");
    const { seed, ...settings } = resolveFalGenerationSettings(
      FAL_SHOT_ENGINE,
      input.settings
    );
    job = await jobs.submit(
      {
        id: input.jobId,
        projectId: input.projectId,
        provider: "fal",
        endpoint: "minimax/h3-max/reference-to-video",
        kind: "video",
        inputAssetIds: [
          ...input.sourceIds,
          ...videos.map((video) => video.assetId)
        ],
        assetInputs: [
          ...(input.sourceIds.length
            ? [
                {
                  field: "reference_image_urls",
                  kind: "image" as const,
                  assetIds: input.sourceIds
                }
              ]
            : []),
          ...(videos.length
            ? [
                {
                  field: "reference_video_urls",
                  kind: "video" as const,
                  assetIds: videos.map((video) => video.assetId)
                }
              ]
            : [])
        ],
        requestJson: {
          prompt: input.prompt,
          duration: input.duration,
          ...settings,
          ...(seed == null ? {} : { seed })
        }
      },
      input.signal
    );
  }
  return waitForExternalRender(jobs, job, input.signal, input.onSubmitted);
};

/** Submission-only entry point: all composition/media work must already be persisted. */
export const renderPreparedFalShot = async (
  jobs: ExternalRenderJobService,
  input: {
    preparation: unknown;
    projectId: string;
    timelineId: string;
    jobId: string;
    savedJob: ExternalRenderJob | null;
    recovering?: boolean;
    signal: AbortSignal;
    onSubmitted: () => Promise<void>;
  }
) => {
  input.signal.throwIfAborted();
  const prepared = parsePreparedFalShot(input.preparation);
  assertPreparedShotOwner(
    prepared,
    input.projectId,
    input.timelineId,
    input.jobId
  );
  if (input.savedJob) assertPreparedShotJob(prepared, input.savedJob);
  return renderFalShot(jobs, {
    jobId: prepared.job_id,
    projectId: prepared.project_id,
    savedJob: input.savedJob,
    prompt: prepared.prompt,
    duration: prepared.duration,
    settings: prepared.settings,
    sourceIds: prepared.image_ids,
    videoInputs: prepared.video_inputs.map((video) => ({
      assetId: video.asset_id,
      provenance: video.provenance
    })),
    recovering: input.recovering,
    signal: input.signal,
    onSubmitted: input.onSubmitted
  });
};
