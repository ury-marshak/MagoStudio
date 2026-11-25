import { z } from "zod";

import { videoAspects } from "../../../shared/falGenerationSettings";

// Send the native frame as image_url without aspect_ratio; the selected aspect
// is retained as a compatibility constraint, not sent as a canvas override.
export const FAL_OPENING_FRAME_POLICY = "native-frame-aspect-checked-v1";

export const falOpeningFrameSchema = z.strictObject({
  asset_id: z.string().min(1),
  predecessor_timeline_id: z.string().min(1),
  predecessor_asset_id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspect_ratio: z.enum(videoAspects),
  canvas_policy: z.literal(FAL_OPENING_FRAME_POLICY)
});

export const isFalOpeningPin = (
  sequential: Record<string, unknown> | null
): boolean =>
  sequential?.mode === "last_frame" && sequential.opening_frame === "pin";

export const numberedContinuitySlots = (
  sequential: Record<string, unknown> | null,
  isFal: boolean
): number =>
  Number(
    (sequential?.mode === "last_frame" || sequential?.mode === "key_frames") &&
      !(isFal && isFalOpeningPin(sequential))
  );

// H3 output may be aligned rather than exactly nominal (e.g. 1344×768 for 16:9).
// Compare ratios, symmetrically for landscape and portrait; never resize the frame.
const MAX_ASPECT_FACTOR = 1.02;
export const openingFrameMatchesAspect = (
  width: number,
  height: number,
  aspect: string
): boolean => {
  const [w, h] = aspect.split(":").map(Number);
  if (
    !w ||
    !h ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return false;
  const factor = (width * h) / (height * w);
  return Math.max(factor, 1 / factor) <= MAX_ASPECT_FACTOR;
};

export const openingFrameMismatch = (
  width: number,
  height: number,
  aspect: string
) =>
  `The previous shot’s opening-frame source (${width}×${height}) does not match the selected H3 Max aspect (${aspect}). Change the shot’s aspect or choose Cut or Loose reference.`;

// FFmpeg emits an unmodified PNG; its IHDR reports the actual decoded geometry.
const PNG_SIGNATURE_SIZE = 8;
const PNG_IHDR_START = 12;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_HEADER_SIZE = 33;
export const decodedPngDimensions = (frame: Buffer) => {
  if (
    frame.length < PNG_HEADER_SIZE ||
    frame.toString("hex", 0, PNG_SIGNATURE_SIZE) !== "89504e470d0a1a0a" ||
    frame.toString("ascii", PNG_IHDR_START, PNG_WIDTH_OFFSET) !== "IHDR"
  )
    return null;
  const width = frame.readUInt32BE(PNG_WIDTH_OFFSET);
  const height = frame.readUInt32BE(PNG_HEIGHT_OFFSET);
  return width && height ? { width, height } : null;
};

export const hasUnboundImageNumber = (prompt: string, count: number): boolean =>
  [...prompt.matchAll(/<Picture\s+(\d+)\s*>|\bImage\s+(\d+)\b/gi)].some(
    (match) =>
      Number(match[1] ?? match[2]) < 1 || Number(match[1] ?? match[2]) > count
  );
