import { z } from "zod";

export const FAL_VIDEO_TAIL_PROFILE = "h3-tail-cfr-720p-v1";
export const FAL_VIDEO_TAIL_MIN_SECONDS = 2;
export const FAL_VIDEO_TAIL_MAX_SECONDS = 10;
export const FAL_VIDEO_REFERENCE_SLOTS = 3;
export const FAL_COMBINED_REFERENCE_SLOTS = 12;
export const FAL_COMBINED_VIDEO_SECONDS = 15;
const fps = 24;
const maxWidth = 1280;
const maxHeight = 720;
const maxSourceFps = 120;
const epsilon = 1e-6;

export const videoTailProvenanceSchema = z
  .object({
    profile: z.literal(FAL_VIDEO_TAIL_PROFILE),
    requested_seconds: z
      .number()
      .min(FAL_VIDEO_TAIL_MIN_SECONDS)
      .max(FAL_VIDEO_TAIL_MAX_SECONDS),
    source_frame_count: z.number().int().positive(),
    source_fps: z.number().min(1).max(maxSourceFps),
    start_frame: z.number().int().nonnegative(),
    end_frame_exclusive: z.number().int().positive(),
    selected_frame_count: z.number().int().positive(),
    output_frame_count: z
      .number()
      .int()
      .min(FAL_VIDEO_TAIL_MIN_SECONDS * fps)
      .max(FAL_VIDEO_TAIL_MAX_SECONDS * fps),
    output_fps: z.literal(fps),
    output_duration_seconds: z
      .number()
      .min(FAL_VIDEO_TAIL_MIN_SECONDS)
      .max(FAL_VIDEO_TAIL_MAX_SECONDS),
    output_width: z.number().int().positive().max(maxWidth).multipleOf(2),
    output_height: z.number().int().positive().max(maxHeight).multipleOf(2),
    audio: z.literal(false)
  })
  .refine(
    (value) =>
      value.end_frame_exclusive === value.source_frame_count &&
      value.selected_frame_count ===
        value.end_frame_exclusive - value.start_frame &&
      value.selected_frame_count ===
        Math.min(
          value.source_frame_count,
          Math.ceil(value.requested_seconds * value.source_fps - epsilon)
        ) &&
      value.output_frame_count ===
        Math.floor(
          Math.min(
            value.requested_seconds,
            value.selected_frame_count / value.source_fps
          ) *
            fps +
            epsilon
        ) &&
      value.output_duration_seconds === value.output_frame_count / fps,
    "Inconsistent video-tail frame provenance"
  );

export type VideoTailProvenance = z.infer<typeof videoTailProvenanceSchema>;
