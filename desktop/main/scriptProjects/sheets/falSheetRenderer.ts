import {
  resolveFalGenerationSettings,
  type FalGenerationSettings
} from "../../../shared/falGenerationSettings";
import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3,
  type FalSheetModel
} from "../../../shared/falSheetModel";
import type { ExternalRenderJobService } from "../../providers/externalRenderJobService";
import { waitForExternalRender } from "../../providers/waitForExternalRender";

const nanoBananaReferenceLimit = 14;
const h3ReferenceLimit = 16;
const h3ImageArea = 1_048_576;
const h3AspectLimit = 3;
const h3PixelAlignment = 16;

const models = {
  [FAL_SHEET_MODEL]: {
    label: "Nano Banana 2",
    generate: "fal-ai/nano-banana-2",
    edit: "fal-ai/nano-banana-2/edit",
    maxReferences: nanoBananaReferenceLimit
  },
  [FAL_SHEET_MODEL_21]: {
    label: "Nano Banana 2.1",
    generate: "google/nano-banana-2.1",
    edit: "google/nano-banana-2.1/edit",
    maxReferences: nanoBananaReferenceLimit
  },
  [FAL_SHEET_MODEL_H3]: {
    label: "MiniMax H3 Image",
    generate: "minimax/h3-image/text-to-image",
    edit: "minimax/h3-image/edit",
    maxReferences: h3ReferenceLimit
  }
} satisfies Record<
  FalSheetModel,
  {
    label: string;
    generate: string;
    edit: string;
    maxReferences: number;
  }
>;

export const falImageReferenceLimit = (model: FalSheetModel) =>
  models[model].maxReferences;

const aspectRatios = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
].map((label) => {
  const [width, height] = label.split(":").map(Number);
  return { label, ratio: width! / height! };
});

const aspectRatioFor = (frame: unknown[]) => {
  const [width, height] = frame.map(Number);
  if (!width || !height) return "1:1";
  const ratio = width / height;
  const distance = (candidate: number) => Math.abs(Math.log(candidate / ratio));
  return aspectRatios.reduce((best, candidate) =>
    distance(candidate.ratio) < distance(best.ratio) ? candidate : best
  ).label;
};

const h3ImageSize = (frame: unknown[], megapixels = 1) => {
  const [width, height] = frame.map(Number);
  const ratio =
    width && height && width > 0 && height > 0
      ? Math.max(1 / h3AspectLimit, Math.min(h3AspectLimit, width / height))
      : 1;
  // Align both edges and derive the long edge from the rounded short edge
  // to keep extreme aspect ratios within the API limit.
  const shortEdge =
    Math.round(
      Math.sqrt((megapixels * h3ImageArea) / Math.max(ratio, 1 / ratio)) /
        h3PixelAlignment
    ) * h3PixelAlignment;
  const longEdge =
    Math.round((shortEdge * Math.max(ratio, 1 / ratio)) / h3PixelAlignment) *
    h3PixelAlignment;
  return ratio >= 1
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
};

export const renderFalSheet = async (
  jobs: ExternalRenderJobService,
  input: {
    jobId: string;
    model: FalSheetModel;
    settings?: FalGenerationSettings;
    recovering?: boolean;
    projectId: string;
    prompt: string;
    frame: unknown[];
    sourceIds: string[];
    signal: AbortSignal;
    profile?: AbortSignal;
    onSubmitted: () => Promise<void>;
  }
) => {
  const { jobId, projectId, prompt, frame, sourceIds, signal } = input;
  let job = await jobs.get(jobId);
  if (job && job.projectId !== projectId)
    throw new Error("The saved render belongs to another project");
  if (!job) {
    if (input.recovering)
      throw new Error("Resume the plan to submit its remaining renders");
    const model = models[input.model];
    if (sourceIds.length > model.maxReferences)
      throw new Error(
        `${model.label} accepts up to ${model.maxReferences} reference images`
      );
    const isEdit = sourceIds.length > 0;
    const settings = resolveFalGenerationSettings(input.model, input.settings);
    const requestedFrame =
      settings.aspect_ratio && settings.aspect_ratio !== "layout"
        ? String(settings.aspect_ratio).split(":").map(Number)
        : frame;
    const { megapixels, aspect_ratio: _aspect, seed, ...parameters } = settings;
    const sizing =
      input.model === FAL_SHEET_MODEL_H3
        ? {
            image_size: h3ImageSize(requestedFrame, Number(megapixels)),
            ...(isEdit ? {} : { enable_prompt_expansion: false })
          }
        : {
            aspect_ratio: aspectRatioFor(requestedFrame),
            ...parameters,
            ...(seed == null ? {} : { seed })
          };
    job = await jobs.submit(
      {
        id: jobId,
        projectId,
        provider: "fal",
        endpoint: isEdit ? model.edit : model.generate,
        kind: "image",
        inputAssetIds: sourceIds,
        ...(isEdit ? { assetUrlField: "image_urls" } : {}),
        requestJson: {
          prompt,
          ...sizing,
          num_images: 1,
          output_format: "png"
        }
      },
      signal
    );
  }
  return waitForExternalRender(
    jobs,
    job,
    signal,
    input.onSubmitted,
    input.profile
  );
};
