import {
  resolveFalGenerationSettings,
  type FalGenerationSettings
} from "../../../shared/falGenerationSettings";
import {
  FAL_SHOT_ENGINE,
  FAL_SHOT_IMAGE_SLOTS
} from "../../../shared/falShotModel";
import type { ExternalRenderJob } from "../../providers/externalRenderJobRepository";
import type { ExternalRenderJobService } from "../../providers/externalRenderJobService";
import { waitForExternalRender } from "../../providers/waitForExternalRender";

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
    recovering?: boolean;
    signal: AbortSignal;
    onSubmitted: () => Promise<void>;
  }
) => {
  let job = input.savedJob;
  if (!job) {
    if (input.recovering)
      throw new Error("Resume the plan to submit its remaining renders");
    if (!input.sourceIds.length)
      throw new Error(
        "H3 Max requires at least one reference image in Director"
      );
    if (input.sourceIds.length > FAL_SHOT_IMAGE_SLOTS)
      throw new Error("H3 Max accepts up to 9 reference images");
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
        inputAssetIds: input.sourceIds,
        assetUrlField: "reference_image_urls",
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
