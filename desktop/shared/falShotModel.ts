export const FAL_SHOT_PROVIDER = "fal";
export const FAL_SHOT_ENGINE = "minimax_h3_max";
const nominalWidth = 1360;
const nominalHeight = 768;
export const FAL_SHOT_SIZE: [number, number] = [nominalWidth, nominalHeight];

export const FAL_SHOT_IMAGE_SLOTS = 9;

/** Raw numbered references cannot survive overflow contact-sheet regrouping. */
export const hasRawNumberedReferenceOverflow = (
  prompt: string,
  referenceCount: number,
  referenceCapacity: number
): boolean =>
  referenceCount > referenceCapacity &&
  /<Picture\s+\d+\s*>|\bImage\s+\d+\b/i.test(prompt);
