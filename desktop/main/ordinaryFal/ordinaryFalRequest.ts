import { z } from "zod";

import type { FalProviderConfig } from "../../shared/contracts";
import {
  imageAspects,
  resolveFalGenerationSettings
} from "../../shared/falGenerationSettings";
import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3,
  isFalSheetModel,
  FAL_SHEET_MODELS
} from "../../shared/falSheetModel";
import {
  FAL_SHOT_ENGINE,
  FAL_SHOT_IMAGE_SLOTS
} from "../../shared/falShotModel";
import {
  FAL_KLING_EDIT,
  FAL_TOPAZ_UPSCALE,
  type OrdinaryFalEffectDestination
} from "../../shared/ordinaryFal";
import type { ExternalRenderJobService } from "../providers/externalRenderJobService";

const maxEffectReferences = 4;
export const TOPAZ_UPSCALE_FACTOR = 2;
const klingEndpoint = "fal-ai/kling-video/o1/video-to-video/edit";
const topazEndpoint = "fal-ai/topaz/upscale/video";
const maxIdLength = 256;
const maxPromptLength = 20_000;
const maxCanvasEdge = 16_384;
const h3ImageLimit = 16;
const nanoImageLimit = 14;
const minVideoSeconds = 5;
const maxVideoSeconds = 15;
const h3AspectLimit = 3;
const h3PixelArea = 1_048_576;
const id = z.string().min(1).max(maxIdLength);
const jobId = z.uuid().transform((value) => value.toLowerCase());
const imageEndpoints = {
  [FAL_SHEET_MODEL]: "fal-ai/nano-banana-2/edit",
  [FAL_SHEET_MODEL_21]: "google/nano-banana-2.1/edit",
  [FAL_SHEET_MODEL_H3]: "minimax/h3-image/edit"
} as const;
const videoEndpoint = "minimax/h3-max/reference-to-video";
export const ordinaryFalEndpoint = (model: string) =>
  model === FAL_KLING_EDIT
    ? klingEndpoint
    : model === FAL_TOPAZ_UPSCALE
      ? topazEndpoint
      : model === FAL_SHOT_ENGINE
        ? videoEndpoint
        : isFalSheetModel(model)
          ? imageEndpoints[model]
          : undefined;
const common = {
  id: jobId,
  projectId: id,
  shotId: id,
  prompt: z.string().trim().min(1).max(maxPromptLength),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional()
};
const canvasEdge = z.number().int().min(1).max(maxCanvasEdge);
const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("image-edit"),
    model: z.enum(FAL_SHEET_MODELS),
    baseAssetId: id,
    referenceAssetIds: z
      .array(id)
      .max(h3ImageLimit - 1)
      .default([]),
    frame: z.number().int().nonnegative(),
    canvas: z.strictObject({ width: canvasEdge, height: canvasEdge })
  }),
  z.strictObject({
    ...common,
    kind: z.literal("reference-video"),
    model: z.literal(FAL_SHOT_ENGINE),
    referenceAssetIds: z.array(id).min(1).max(FAL_SHOT_IMAGE_SLOTS),
    trackId: id,
    timelineOffsetMs: z.number().int().nonnegative(),
    durationSeconds: z.number().int().min(minVideoSeconds).max(maxVideoSeconds)
  })
]);
const effectCommon = {
  id: jobId,
  projectId: id,
  shotId: id,
  sourceClipId: id,
  expectedSourceAssetId: id
};
const effectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...effectCommon,
    kind: z.literal("video-edit"),
    model: z.literal(FAL_KLING_EDIT),
    prompt: common.prompt,
    keepAudio: z.boolean(),
    referenceAssetIds: z.array(id).max(maxEffectReferences).default([])
  }),
  z.strictObject({
    ...effectCommon,
    kind: z.literal("video-upscale"),
    model: z.literal(FAL_TOPAZ_UPSCALE)
  })
]);

const submitSchema = z.strictObject({
  request: z.unknown(),
  expectedFal: z.strictObject({
    keychainAccount: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/)
  })
});

export function parseOrdinaryFalSubmission(value: unknown) {
  const { request, expectedFal } = submitSchema.parse(value);
  return { parsed: parseOrdinaryFalAction(request), expectedFal };
}

export function parseOrdinaryFalAction(value: unknown) {
  if (
    typeof value === "object" &&
    value &&
    "kind" in value &&
    (value.kind === "video-edit" || value.kind === "video-upscale")
  ) {
    const input = effectSchema.parse(value);
    if (
      input.kind === "video-edit" &&
      new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length
    )
      throw new Error("Select distinct fal reference images");
    return { mode: "effect", input } as const;
  }
  return { mode: "generate", ...parseOrdinaryFalInput(value) } as const;
}

export function prepareOrdinaryFalEffect(
  input: z.output<typeof effectSchema>,
  destination: OrdinaryFalEffectDestination
) {
  const imageIds = input.kind === "video-edit" ? input.referenceAssetIds : [];
  const effectiveSettings: Record<string, string | number | boolean> =
    input.kind === "video-edit"
      ? { prompt: input.prompt, keep_audio: input.keepAudio }
      : {
          model: "Proteus",
          upscale_factor: TOPAZ_UPSCALE_FACTOR,
          H264_output: true
        };
  const submission: Parameters<ExternalRenderJobService["submit"]>[0] = {
    id: externalJobId(input.id),
    projectId: input.projectId,
    provider: "fal",
    endpoint: input.kind === "video-edit" ? klingEndpoint : topazEndpoint,
    kind: "video",
    inputAssetIds: [destination.sourceAssetId, ...imageIds],
    assetInputs: [
      {
        field: "video_url",
        kind: "video",
        scalar: true,
        assetIds: [destination.sourceAssetId]
      },
      ...(imageIds.length
        ? [{ field: "image_urls", kind: "image" as const, assetIds: imageIds }]
        : [])
    ],
    requestJson: effectiveSettings
  };
  return { submission, effectiveSettings };
}

export const ordinaryFalGetSchema = z.strictObject({ id: jobId });
export const ordinaryFalListSchema = z.strictObject({
  projectId: id.optional()
});

export const externalJobId = (id: string) => `ordinary-fal:${id}`;
export const publicJobId = (id: string) => id.slice("ordinary-fal:".length);

type Request = z.output<typeof requestSchema>;
export type OrdinaryFalDestination =
  | Pick<Extract<Request, { kind: "image-edit" }>, "kind" | "frame" | "canvas">
  | Pick<
      Extract<Request, { kind: "reference-video" }>,
      "kind" | "trackId" | "timelineOffsetMs" | "durationSeconds"
    >;

export function parseOrdinaryFalInput(value: unknown) {
  const input = requestSchema.parse(value);
  // Reject unsupported per-model settings before any settings or credential lookup.
  resolveFalGenerationSettings(input.model, input.settings);
  const inputAssetIds =
    input.kind === "image-edit"
      ? [input.baseAssetId, ...input.referenceAssetIds]
      : input.referenceAssetIds;
  const limit =
    input.model === FAL_SHEET_MODEL_H3 ? h3ImageLimit : nanoImageLimit;
  if (input.kind === "image-edit" && inputAssetIds.length > limit)
    throw new Error(
      `This model accepts up to ${limit} images including the base image`
    );
  if (new Set(inputAssetIds).size !== inputAssetIds.length)
    throw new Error("Select distinct fal input images");
  const destination: OrdinaryFalDestination =
    input.kind === "image-edit"
      ? { kind: input.kind, frame: input.frame, canvas: input.canvas }
      : {
          kind: input.kind,
          trackId: input.trackId,
          timelineOffsetMs: input.timelineOffsetMs,
          durationSeconds: input.durationSeconds
        };
  return { input, inputAssetIds, destination };
}

const ratioFor = (aspect: string) => {
  const [width, height] = aspect.split(":").map(Number);
  return width! / height!;
};
const closestAspect = (ratio: number) =>
  imageAspects.reduce((best, candidate) =>
    Math.abs(Math.log(ratioFor(candidate) / ratio)) <
    Math.abs(Math.log(ratioFor(best) / ratio))
      ? candidate
      : best
  );
const h3ImageSize = (ratio: number, megapixels: number) => {
  const clamped = Math.max(1 / h3AspectLimit, Math.min(h3AspectLimit, ratio));
  const stretch = Math.max(clamped, 1 / clamped);
  const alignment = 16;
  const aligned = (pixels: number) =>
    Math.round(pixels / alignment) * alignment;
  const shortEdge = aligned(Math.sqrt((megapixels * h3PixelArea) / stretch));
  const longEdge = aligned(shortEdge * stretch);
  return clamped >= 1
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
};

export function prepareOrdinaryFalRequest(
  { input, inputAssetIds }: ReturnType<typeof parseOrdinaryFalInput>,
  config: FalProviderConfig,
  projectSettings?: unknown
) {
  const effectiveSettings = resolveFalGenerationSettings(
    input.model,
    input.settings,
    projectSettings,
    config.generationSettings?.[input.model]
  );
  const common = {
    id: externalJobId(input.id),
    projectId: input.projectId,
    provider: "fal",
    inputAssetIds
  };
  const { seed, ...settings } = effectiveSettings;
  const seeded = seed == null ? {} : { seed };
  const submission: Parameters<ExternalRenderJobService["submit"]>[0] =
    input.kind === "reference-video"
      ? {
          ...common,
          endpoint: videoEndpoint,
          kind: "video",
          assetUrlField: "reference_image_urls",
          requestJson: {
            prompt: input.prompt,
            duration: input.durationSeconds,
            ...settings,
            ...seeded
          }
        }
      : (() => {
          const { megapixels, aspect_ratio: aspect, ...rest } = settings;
          const ratio =
            typeof aspect === "string" && aspect !== "layout"
              ? ratioFor(aspect)
              : input.canvas.width / input.canvas.height;
          const sizing =
            input.model === FAL_SHEET_MODEL_H3
              ? { image_size: h3ImageSize(ratio, Number(megapixels)) }
              : { aspect_ratio: closestAspect(ratio), ...rest, ...seeded };
          return {
            ...common,
            endpoint: imageEndpoints[input.model],
            kind: "image",
            assetUrlField: "image_urls",
            requestJson: {
              prompt: input.prompt,
              ...sizing,
              num_images: 1,
              output_format: "png"
            }
          };
        })();
  return { submission, effectiveSettings };
}
