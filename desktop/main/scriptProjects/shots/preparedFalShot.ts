import { createHash } from "node:crypto";

import { z } from "zod";

import { falSettingsSchemas } from "../../../shared/falGenerationSettings";
import {
  FAL_SHOT_ENGINE,
  FAL_SHOT_IMAGE_SLOTS
} from "../../../shared/falShotModel";
import {
  FAL_VIDEO_TAIL_MIN_SECONDS,
  FAL_VIDEO_TAIL_MAX_SECONDS,
  videoTailProvenanceSchema
} from "../../../shared/falVideoTail";
import {
  FAL_H3_PRICING_SOURCE,
  falVideoTailEstimate,
  falVideoTailEstimateSchema
} from "../../../shared/falVideoTailPricing";
import type { ExternalRenderJob } from "../../providers/externalRenderJobRepository";
import { fingerprint } from "../renderSpec";

import {
  falOpeningFrameSchema,
  FAL_OPENING_FRAME_POLICY,
  hasUnboundImageNumber,
  openingFrameMatchesAspect
} from "./falOpeningFrame";

const maxKeyframes = 4;
const minOutputSeconds = 5;
const maxOutputSeconds = 15;
const id = z.string().min(1);
const json = z.record(z.string(), z.unknown());
const settings = falSettingsSchemas[FAL_SHOT_ENGINE].required({
  resolution: true,
  aspect_ratio: true,
  prompt_expansion_mode: true
});
const selection = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("last_frame"),
    prompt_appendix: z.string(),
    opening_frame: z.enum(["cut", "off", "pin"]).optional()
  }),
  z.strictObject({
    mode: z.literal("key_frames"),
    prompt_appendix: z.string(),
    num_select: z.number().int().min(1).max(maxKeyframes)
  }),
  z.strictObject({
    mode: z.literal("last_chunk"),
    prompt_appendix: z.string(),
    chunk_seconds: z
      .number()
      .min(FAL_VIDEO_TAIL_MIN_SECONDS)
      .max(FAL_VIDEO_TAIL_MAX_SECONDS)
  })
]);
const schema = z.strictObject({
  version: z.literal(1),
  project_id: id,
  timeline_id: id,
  job_id: id,
  provider: z.literal("fal"),
  endpoint: z.literal("minimax/h3-max/reference-to-video"),
  prompt: z
    .string()
    .refine(
      (value) => value.trim().length > 0,
      "A prepared prompt cannot be empty"
    ),
  duration: z.number().min(minOutputSeconds).max(maxOutputSeconds),
  settings,
  image_ids: z.array(id).max(FAL_SHOT_IMAGE_SLOTS),
  opening_frame: falOpeningFrameSchema.optional(),
  video_inputs: z
    .array(
      z.strictObject({
        asset_id: id,
        provenance: videoTailProvenanceSchema
      })
    )
    .max(1),
  image_slots: z.array(
    z.strictObject({
      asset_id: id,
      members: z.array(id).min(1),
      role: z.enum(["entity", "storyboard", "continuity"])
    })
  ),
  predecessor: z.strictObject({
    timeline_id: id.nullable(),
    asset_id: id.nullable(),
    in_run: z.boolean(),
    selection: selection.nullable()
  }),
  continues_from: z
    .strictObject({
      timeline_id: id,
      asset_id: id,
      mode: z.enum(["last_frame", "key_frames", "last_chunk"]),
      reference_asset_id: id,
      tail_provenance: videoTailProvenanceSchema.optional()
    })
    .nullable(),
  prompt_provenance: z.strictObject({
    rewrite: z.enum(["raw", "mago"]),
    raw_prompt: z.string(),
    composition: json.nullable()
  }),
  media_provenance: z.strictObject({
    continuity: json.nullable(),
    grids: json.nullable()
  }),
  render_spec: json,
  render_fingerprint: id,
  cost: z.strictObject({
    source: z.literal(FAL_H3_PRICING_SOURCE),
    output_base_usd: z.number().nonnegative(),
    video_scenario: falVideoTailEstimateSchema.nullable(),
    reference_usage: z.literal(
      "unknown; shared allowance, not a total or bound"
    )
  }),
  digest: id
});
export type PreparedFalShot = z.infer<typeof schema>;

// Unlike render matching, preparation integrity preserves exact prompt bytes.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
};
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);

export const preparedShotCost = (
  timelineId: string,
  resolution: PreparedFalShot["settings"]["resolution"],
  duration: number,
  tailSeconds?: number
): PreparedFalShot["cost"] => ({
  source: FAL_H3_PRICING_SOURCE,
  output_base_usd:
    duration * { "480P": 0.05, "768P": 0.08, "1080P": 0.16 }[resolution],
  video_scenario:
    tailSeconds == null
      ? null
      : falVideoTailEstimate(timelineId, resolution, duration, tailSeconds),
  reference_usage: "unknown; shared allowance, not a total or bound"
});

/** Credential-free, persisted boundary. Never resolves media or reads defaults. */
export const parsePreparedFalShot = (value: unknown): PreparedFalShot => {
  const parsed = schema.parse(value);
  const { digest: savedDigest, ...body } = parsed;
  const opener = parsed.opening_frame;
  const ids = [
    ...parsed.image_ids,
    ...parsed.video_inputs.map((video) => video.asset_id),
    ...(opener ? [opener.asset_id] : [])
  ];
  const continuation = parsed.continues_from;
  const predecessor = parsed.predecessor;
  if (
    savedDigest !== digest(body) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    !equal(
      parsed.image_ids,
      parsed.image_slots.map((slot) => slot.asset_id)
    ) ||
    parsed.render_fingerprint !== fingerprint(parsed.render_spec) ||
    !equal(
      parsed.cost,
      preparedShotCost(
        parsed.timeline_id,
        parsed.settings.resolution,
        parsed.duration,
        parsed.video_inputs[0]?.provenance.output_duration_seconds
      )
    )
  )
    throw new Error("The saved shot preparation is inconsistent");
  const pin =
    predecessor.selection?.mode === "last_frame" &&
    predecessor.selection.opening_frame === "pin";
  if (pin !== Boolean(opener))
    throw new Error("The saved shot opening-frame selection is inconsistent");
  if (opener) {
    const spec = json.parse(parsed.render_spec.sequential);
    if (
      opener.asset_id !== continuation?.reference_asset_id ||
      opener.predecessor_timeline_id !== predecessor.timeline_id ||
      opener.predecessor_asset_id !== predecessor.asset_id ||
      opener.aspect_ratio !== parsed.settings.aspect_ratio ||
      !openingFrameMatchesAspect(
        opener.width,
        opener.height,
        opener.aspect_ratio
      ) ||
      spec.opening_frame_preparation !== FAL_OPENING_FRAME_POLICY ||
      spec.prev_asset_id !== predecessor.asset_id ||
      !equal(spec.prepared_opening_frame, opener) ||
      !equal(parsed.media_provenance.continuity?.opening_frame, opener) ||
      parsed.image_slots.some((slot) => slot.role === "continuity") ||
      parsed.video_inputs.length ||
      continuation?.tail_provenance ||
      hasUnboundImageNumber(parsed.prompt, parsed.image_ids.length)
    )
      throw new Error(
        "The saved shot opening-frame provenance is inconsistent"
      );
  }
  if (predecessor.selection) {
    if (
      !continuation ||
      continuation.timeline_id !== predecessor.timeline_id ||
      continuation.asset_id !== predecessor.asset_id ||
      continuation.mode !== predecessor.selection.mode
    )
      throw new Error("The saved shot predecessor provenance is inconsistent");
    const media = parsed.media_provenance.continuity;
    if (
      !media ||
      !equal(media.continues_from, continuation) ||
      !equal(media.selection, predecessor.selection)
    )
      throw new Error("The saved shot media provenance is inconsistent");
    if (predecessor.selection.mode === "last_chunk") {
      const video = parsed.video_inputs[0];
      if (
        !video ||
        video.asset_id !== continuation.reference_asset_id ||
        !equal(video.provenance, continuation.tail_provenance) ||
        video.provenance.requested_seconds !==
          predecessor.selection.chunk_seconds
      )
        throw new Error("The saved shot video provenance is inconsistent");
    } else if (
      !opener &&
      (parsed.video_inputs.length ||
        parsed.image_slots.at(-1)?.role !== "continuity" ||
        parsed.image_ids.at(-1) !== continuation.reference_asset_id ||
        continuation.tail_provenance)
    )
      throw new Error("The saved shot frame provenance is inconsistent");
  } else if (
    continuation ||
    parsed.video_inputs.length ||
    predecessor.asset_id ||
    predecessor.timeline_id
  )
    throw new Error("The saved shot has unexpected predecessor provenance");
  const composition = parsed.prompt_provenance.composition;
  if (
    parsed.prompt_provenance.rewrite === "mago" &&
    (!composition ||
      composition.text_model_route !== "external" ||
      composition.fallback !== false ||
      typeof composition.adapted_video_prompt !== "string" ||
      composition.adapted_video_prompt
        .replace(/<Picture (\d+)>/gi, "Image $1")
        .replace(/<Video (\d+)>/gi, "Video $1") !== parsed.prompt ||
      !equal(composition.numbered_ref_asset_ids, parsed.image_ids) ||
      !equal(
        composition.numbered_video_asset_ids,
        parsed.video_inputs.map((video) => video.asset_id)
      ))
  )
    throw new Error("The saved shot prompt provenance is inconsistent");
  const grids = parsed.media_provenance.grids?.grids;
  const gridSlots = parsed.image_slots.filter(
    (slot) => slot.role === "entity" && slot.members.length > 1
  );
  if (
    (gridSlots.length && !Array.isArray(grids)) ||
    gridSlots.some(
      (slot) =>
        !(grids as Array<Record<string, unknown>>).some(
          (grid) =>
            grid.asset_id === slot.asset_id && equal(grid.members, slot.members)
        )
    )
  )
    throw new Error("The saved shot grid provenance is inconsistent");
  if (
    parsed.image_slots.some((slot) =>
      slot.role === "continuity"
        ? slot.members.length !== 1 || slot.members[0] !== predecessor.asset_id
        : slot.members.length === 1 && slot.members[0] !== slot.asset_id
    )
  )
    throw new Error("The saved shot reference-slot provenance is inconsistent");
  return parsed;
};

export const createPreparedFalShot = (
  body: Omit<PreparedFalShot, "digest">
): PreparedFalShot => parsePreparedFalShot({ ...body, digest: digest(body) });

export const assertPreparedShotOwner = (
  prepared: PreparedFalShot,
  projectId: string,
  timelineId: string,
  jobId: string
): void => {
  if (
    prepared.project_id !== projectId ||
    prepared.timeline_id !== timelineId ||
    prepared.job_id !== jobId
  )
    throw new Error(
      "The saved shot preparation belongs to a different submission"
    );
};

const uploadUrls = z.array(z.string().url());
const matchesUploadArray = (value: unknown, count: number): boolean => {
  if (!count) return value === undefined;
  const parsed = uploadUrls.safeParse(value);
  return parsed.success && parsed.data.length === count;
};

/** Accepted jobs are authoritative; never rebuild their uploaded request. */
export const assertPreparedShotJob = (
  prepared: PreparedFalShot,
  job: ExternalRenderJob
): void => {
  assertPreparedShotOwner(
    prepared,
    job.projectId,
    prepared.timeline_id,
    job.id
  );
  const {
    reference_image_urls: images,
    reference_video_urls: videos,
    image_url: openingUrl,
    ...request
  } = job.requestJson;
  const { seed, aspect_ratio, ...effective } = prepared.settings;
  if (
    job.provider !== prepared.provider ||
    job.endpoint !== prepared.endpoint ||
    job.kind !== "video" ||
    !equal(job.inputAssetIds, [
      ...prepared.image_ids,
      ...prepared.video_inputs.map((video) => video.asset_id),
      ...(prepared.opening_frame ? [prepared.opening_frame.asset_id] : [])
    ]) ||
    (prepared.opening_frame
      ? !z.string().url().safeParse(openingUrl).success
      : openingUrl !== undefined) ||
    !matchesUploadArray(images, prepared.image_ids.length) ||
    !matchesUploadArray(videos, prepared.video_inputs.length) ||
    !equal(request, {
      prompt: prepared.prompt,
      duration: prepared.duration,
      ...effective,
      ...(prepared.opening_frame ? {} : { aspect_ratio }),
      ...(seed == null ? {} : { seed })
    })
  )
    throw new Error(
      "The accepted job does not match its saved shot preparation"
    );
};
