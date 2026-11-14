import { z } from "zod";

import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3
} from "./falSheetModel";
import { FAL_SHOT_ENGINE } from "./falShotModel";

export const imageAspects = [
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
] as const;
export const videoAspects = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16"
] as const;
export const MAX_FAL_SEED = 2147483647;
const videoHeights = { "480P": 480, "768P": 768, "1080P": 1080 };
const pixelAlignment = 16;
const seed = z.number().int().min(0).max(MAX_FAL_SEED).nullable().optional();
const nano = z.strictObject({
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  aspect_ratio: z.enum(["layout", ...imageAspects]).optional(),
  thinking_level: z.enum(["minimal", "medium", "high"]).optional(),
  seed
});
export const falSettingsSchemas = {
  [FAL_SHEET_MODEL]: nano.extend({
    resolution: z.enum(["0.5K", "1K", "2K", "4K"]).optional(),
    thinking_level: z.enum(["minimal", "high"]).optional()
  }),
  [FAL_SHEET_MODEL_21]: nano,
  [FAL_SHEET_MODEL_H3]: z.strictObject({
    megapixels: z.enum(["1", "2", "4", "8", "16"]).optional(),
    aspect_ratio: z.enum(["layout", ...imageAspects]).optional()
  }),
  [FAL_SHOT_ENGINE]: z.strictObject({
    resolution: z.enum(["480P", "768P", "1080P"]).optional(),
    aspect_ratio: z.enum(videoAspects).optional(),
    prompt_expansion_mode: z
      .enum(["disabled", "balanced", "quality"])
      .optional(),
    seed
  })
};
export type FalGenerationModel = keyof typeof falSettingsSchemas;
export type FalGenerationSettings = Record<string, string | number | null>;
export const falGenerationDefaultsSchema = z.strictObject({
  [FAL_SHEET_MODEL]: falSettingsSchemas[FAL_SHEET_MODEL].optional(),
  [FAL_SHEET_MODEL_21]: falSettingsSchemas[FAL_SHEET_MODEL_21].optional(),
  [FAL_SHEET_MODEL_H3]: falSettingsSchemas[FAL_SHEET_MODEL_H3].optional(),
  [FAL_SHOT_ENGINE]: falSettingsSchemas[FAL_SHOT_ENGINE].optional()
});
export type FalGenerationDefaults = z.infer<typeof falGenerationDefaultsSchema>;
export const isFalGenerationModel = (
  model: string
): model is FalGenerationModel => Object.hasOwn(falSettingsSchemas, model);
export const resolveFalGenerationSettings = (
  model: FalGenerationModel,
  override?: unknown,
  project?: unknown,
  app?: unknown
): FalGenerationSettings => {
  const schema = falSettingsSchemas[model];
  const parse = (value: unknown) => schema.parse(value ?? {});
  return {
    ...(model === FAL_SHOT_ENGINE
      ? {
          resolution: "768P",
          aspect_ratio: "16:9",
          prompt_expansion_mode: "disabled"
        }
      : model === FAL_SHEET_MODEL_H3
        ? { megapixels: "1", aspect_ratio: "layout" }
        : {
            resolution: "1K",
            thinking_level: "minimal",
            aspect_ratio: "layout"
          }),
    ...parse(app),
    ...parse(project),
    ...parse(override)
  };
};
export const falVideoSize = (
  settings: FalGenerationSettings
): [number, number] => {
  const height =
    videoHeights[settings.resolution as keyof typeof videoHeights] ??
    videoHeights["768P"];
  const [w, h] = String(settings.aspect_ratio ?? "16:9")
    .split(":")
    .map(Number);
  const scale = height / Math.min(w!, h!);
  return [
    Math.round((w! * scale) / pixelAlignment) * pixelAlignment,
    Math.round((h! * scale) / pixelAlignment) * pixelAlignment
  ];
};
