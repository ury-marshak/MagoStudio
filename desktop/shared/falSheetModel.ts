export const FAL_SHEET_MODEL = "fal_nano_banana_2";
export const FAL_SHEET_MODEL_21 = "fal_nano_banana_2_1";

export const FAL_SHEET_MODEL_H3 = "fal_minimax_h3_image";

export const FAL_SHEET_MODELS = [
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3,
  FAL_SHEET_MODEL
] as const;
export type FalSheetModel = (typeof FAL_SHEET_MODELS)[number];

export const isFalSheetModel = (model: unknown): model is FalSheetModel =>
  FAL_SHEET_MODELS.some((candidate) => candidate === model);
