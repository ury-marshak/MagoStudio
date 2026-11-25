import {
  FAL_SHOT_IMAGE_SLOTS,
  FAL_SHOT_PROVIDER,
  hasRawNumberedReferenceOverflow
} from "../../../shared/falShotModel";
import {
  FAL_VIDEO_TAIL_PROFILE,
  FAL_VIDEO_TAIL_MIN_SECONDS,
  videoTailProvenanceSchema
} from "../../../shared/falVideoTail";
import { falVideoTailEstimate } from "../../../shared/falVideoTailPricing";
import { textOf } from "../../vlm/dialogue";
import { changedFields, fingerprint } from "../renderSpec";

import {
  FAL_OPENING_FRAME_POLICY,
  falOpeningFrameSchema,
  hasUnboundImageNumber,
  isFalOpeningPin,
  numberedContinuitySlots,
  openingFrameMatchesAspect,
  openingFrameMismatch
} from "./falOpeningFrame";
import {
  defaultSequentialAppendix,
  isDefaultSequentialAppendix,
  OPENING_FRAME_CUT,
  OPENING_FRAMES,
  sequentialFingerprint
} from "./sequentialContinuation";
import { sequentialPredecessors, shotsInProjectOrder } from "./shotOrder";
import { shotPin } from "./shotPin";

/**
 * Which shots a Generate press renders, and why the rest do not: the backend's
 * shot generation, with its render-spec fingerprints and its cross-shot
 * reference config.
 *
 * Every local shot renders on the local MiniMax H3 workflow, whatever cloud
 * engine the panel has selected, so the engine checks answer for that: it
 * takes a cross-shot reference in every mode (including the `last_chunk`
 * video reference), pins an opening frame with a frame-0 guide, takes a
 * shot's own length directly, and keeps the cloud H3 window of 5-15 s.
 */

type JsonRecord = Record<string, unknown>;

export const LOCAL_SHOT_ENGINE = "minimax_h3_local";

const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 15;

/** The cloud's frame_range when a plan sets none, and the grid it is on. */
const DEFAULT_PLAN_FRAMES = 48;
const DEFAULT_FRAME_RANGE: [number, number] = [0, DEFAULT_PLAN_FRAMES];
const FPS = 24;

/** The prompt-rewrite settings; local H3 has no fal expansion. */
const PROMPT_REWRITES = ["mago", "raw"] as const;
export type PromptRewrite = (typeof PROMPT_REWRITES)[number];
const DEFAULT_PROMPT_REWRITE: PromptRewrite = "mago";
const PROMPT_REWRITE_PAIRS: Record<PromptRewrite, JsonRecord> = {
  mago: { adapt_video_prompt: true, prompt_expansion_mode: "disabled" },
  raw: { adapt_video_prompt: false, prompt_expansion_mode: "disabled" }
};
const PROMPT_REWRITE_INTERNAL_KEYS = [
  "adapt_video_prompt",
  "prompt_expansion_mode"
];

const SEQUENTIAL_MODES = ["last_frame", "key_frames", "last_chunk"] as const;
const DEFAULT_SEQUENTIAL_MODE = "last_frame";
const DEFAULT_NUM_SELECT = 1;
const MAX_NUM_SELECT = 4;
const DEFAULT_CHUNK_SECONDS = 2;
const MAX_CHUNK_SECONDS = 10;

/** A request the cloud answers with a 400 for the whole run. */
export class ShotRunError extends Error {}

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
/** Python's `:g` (six significant digits) for the lengths a message quotes. */
const G_FORMAT_PRECISION = 6;
const formatSeconds = (value: number) =>
  String(Number(value.toPrecision(G_FORMAT_PRECISION)));

const shotSpec = (
  shot: JsonRecord,
  videoSettings: JsonRecord,
  outputSize: unknown[],
  sequential: JsonRecord | null
): JsonRecord => {
  const references = isRecord(shot.references) ? shot.references : {};
  const spec: JsonRecord = {
    kind: "shot",
    sequence_id: shot.sequence_id ?? null,
    video_prompt: shot.video_prompt ?? null,
    references: Object.fromEntries(
      Object.keys(references)
        .sort()
        .map((group) => [
          group,
          records(references[group]).map((ref) => ref.asset_id ?? null)
        ])
    ),
    settings: videoSettings,
    output_size: [...outputSize]
  };
  if (Array.isArray(shot.dialogue) && shot.dialogue.length)
    spec.dialogue = shot.dialogue;
  if (sequential) spec.sequential = sequential;
  if (isRecord(shot._local_storyboard))
    spec.storyboard = [shot._local_storyboard.asset_id];
  return spec;
};

// ---------------------------------------------------------------------------
// Request helpers

const promptRewriteError = (value: unknown): string | null =>
  value === null ||
  value === undefined ||
  (PROMPT_REWRITES as readonly unknown[]).includes(value)
    ? null
    : `prompt_rewrite must be one of: ${PROMPT_REWRITES.join(", ")} (on engine ${LOCAL_SHOT_ENGINE})`;

const durationBoundError = (durationSeconds: number): string | null =>
  !durationSeconds ||
  (durationSeconds >= MIN_DURATION_SECONDS &&
    durationSeconds <= MAX_DURATION_SECONDS)
    ? null
    : `${LOCAL_SHOT_ENGINE} renders ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s; ` +
      `this shot is ${formatSeconds(durationSeconds)}s`;

/** `[config, error]`. */
export const sequentialShotConfig = (
  persisted: unknown,
  requestEntry: unknown,
  requestDefault: unknown
): [JsonRecord | null, string | null] => {
  const merged: JsonRecord = {
    ...(isRecord(requestDefault) ? requestDefault : {}),
    ...(isRecord(persisted) ? persisted : {}),
    ...(isRecord(requestEntry) ? requestEntry : {})
  };
  if (!merged.enabled) return [null, null];
  const mode = textOf(merged.mode || DEFAULT_SEQUENTIAL_MODE);
  if (!(SEQUENTIAL_MODES as readonly string[]).includes(mode))
    return [
      null,
      `sequential.mode must be one of ${SEQUENTIAL_MODES.join(", ")}`
    ];
  const appendix = merged.prompt_appendix;
  if (
    appendix !== null &&
    appendix !== undefined &&
    typeof appendix !== "string"
  )
    return [null, "sequential.prompt_appendix must be a string"];
  let openingFrame: string | null = null;
  if (mode === "last_frame") {
    openingFrame = textOf(merged.opening_frame || OPENING_FRAME_CUT);
    if (!(OPENING_FRAMES as readonly string[]).includes(openingFrame))
      return [
        null,
        `sequential.opening_frame must be one of ${OPENING_FRAMES.join(", ")}`
      ];
  }
  const ownAppendix = (appendix ?? "").trim();
  const config: JsonRecord = {
    mode,
    prompt_appendix:
      (isDefaultSequentialAppendix(ownAppendix) ? "" : ownAppendix) ||
      defaultSequentialAppendix(mode, openingFrame)
  };
  if (mode === "last_frame") {
    if (openingFrame !== OPENING_FRAME_CUT) config.opening_frame = openingFrame;
  } else if (mode === "key_frames") {
    const numSelect =
      "num_select" in merged ? merged.num_select : DEFAULT_NUM_SELECT;
    if (
      typeof numSelect !== "number" ||
      !Number.isInteger(numSelect) ||
      numSelect < 1 ||
      numSelect > MAX_NUM_SELECT
    )
      return [
        null,
        `sequential.num_select must be an integer in 1..${MAX_NUM_SELECT}`
      ];
    config.num_select = numSelect;
  } else if (mode === "last_chunk") {
    const chunk =
      "chunk_seconds" in merged ? merged.chunk_seconds : DEFAULT_CHUNK_SECONDS;
    if (!isNumber(chunk) || chunk <= 0 || chunk > MAX_CHUNK_SECONDS)
      return [
        null,
        `sequential.chunk_seconds must be a number in 0..${MAX_CHUNK_SECONDS}.0`
      ];
    config.chunk_seconds = chunk;
  }
  return [config, null];
};

/** The specs a shot has actually finished rendering, read off its versions. */
export const renderedFingerprints = (
  cutShot: JsonRecord | undefined
): Set<string> =>
  new Set(
    records(cutShot?.versions)
      .filter(
        (version) =>
          version.ready === true && typeof version.fingerprint === "string"
      )
      .map((version) => String(version.fingerprint))
  );

export const shotSpecsInFlight = (
  plans: JsonRecord[]
): Map<string, Set<string>> => {
  const inFlight = new Map<string, Set<string>>();
  for (const plan of plans) {
    if (!["PENDING", "RUNNING"].includes(String(plan.status))) continue;
    const abandoned = new Set(
      records(plan.steps)
        .filter((step) => step.status === "FAILED" && step.timeline_id)
        .map((step) => String(step.timeline_id))
    );
    for (const target of records(plan.local_targets)) {
      const value = isRecord(target._local_render_spec)
        ? target._local_render_spec.fingerprint
        : undefined;
      const timelineId = String(target.timeline_id);
      if (typeof value !== "string" || abandoned.has(timelineId)) continue;
      if (!inFlight.has(timelineId)) inFlight.set(timelineId, new Set());
      inFlight.get(timelineId)!.add(value);
    }
  }
  return inFlight;
};

// ---------------------------------------------------------------------------

export interface ShotRunRequest {
  videoSettings?: JsonRecord;
  outputSize?: unknown[];
  sequenceIds?: number[];
  timelineIds?: string[];
  sequential?: { default?: unknown; shots?: Record<string, unknown> };
  /** The project's `settings.visual_style`; part of every shot's spec when set. */
  visualStyle?: string;
}

/** One shot the run renders, with what the renderer needs to honour its decision. */
export interface PlannedShot {
  shot: JsonRecord;
  sequential: JsonRecord | null;
  previousTimelineId: string | null;
  /** The ready predecessor pin captured when it is not rendering in this run. */
  previousAssetId: string | null;
  /** The predecessor renders earlier in this same run, so this shot waits for it. */
  previousInRun: boolean;
  durationSeconds: number;
  promptRewrite: PromptRewrite;
  renderSpec: { fingerprint: string; spec: JsonRecord };
}

export interface ShotRunPlan {
  preview: JsonRecord;
  planned: PlannedShot[];
  /** The plan-level settings the run renders with (prompt_rewrite translated). */
  videoSettings: JsonRecord;
  /** Set when a shot's length is outside the engine's window: a real run is refused. */
  durationError: string | null;
}

/**
 * The cloud's shot generation minus the persistence: decides every shot, in
 * project order. Throws ShotRunError for what the cloud refuses outright.
 */
export const planShotRun = ({
  shots: stateShots,
  cutShots,
  request,
  inFlight
}: {
  shots: JsonRecord[];
  cutShots: JsonRecord[];
  request: ShotRunRequest;
  inFlight: Map<string, Set<string>>;
}): ShotRunPlan => {
  const videoSettings: JsonRecord = { ...request.videoSettings };
  const visualStyle = request.visualStyle?.trim() || null;
  const rejected = PROMPT_REWRITE_INTERNAL_KEYS.filter(
    (key) => key in videoSettings
  );
  if (rejected.length)
    throw new ShotRunError(
      `${rejected.join(", ")} is not settable here; use prompt_rewrite (${PROMPT_REWRITES.join(", ")})`
    );
  const projectRewrite = videoSettings.prompt_rewrite;
  delete videoSettings.prompt_rewrite;
  const rewriteError = promptRewriteError(projectRewrite);
  if (rewriteError) throw new ShotRunError(rewriteError);
  const planRewrite =
    (projectRewrite as PromptRewrite | undefined) ?? DEFAULT_PROMPT_REWRITE;
  // The default pair is left out, so a press that changes nothing keeps every fingerprint.
  if (planRewrite !== DEFAULT_PROMPT_REWRITE)
    Object.assign(videoSettings, PROMPT_REWRITE_PAIRS[planRewrite]);

  const sequentialBlock = request.sequential;
  if (
    sequentialBlock !== undefined &&
    sequentialBlock !== null &&
    !isRecord(sequentialBlock)
  )
    throw new ShotRunError("sequential must be an object");
  const seqDefault = sequentialBlock?.default ?? {};
  const seqPerShot = sequentialBlock?.shots ?? {};
  if (!isRecord(seqDefault))
    throw new ShotRunError("sequential.default must be an object");
  if (
    !isRecord(seqPerShot) ||
    Object.values(seqPerShot).some((value) => !isRecord(value))
  )
    throw new ShotRunError(
      "sequential.shots must be an object of timeline_id -> object"
    );

  const isNamedShotsRun =
    request.sequenceIds !== undefined || request.timelineIds !== undefined;
  const isBulkRun = !isNamedShotsRun;
  const wantedSequences = new Set(request.sequenceIds ?? []);
  const wantedTimelines = new Set((request.timelineIds ?? []).map(String));
  const wanted = (shot: JsonRecord) =>
    !isNamedShotsRun ||
    (isNumber(shot.sequence_id) && wantedSequences.has(shot.sequence_id)) ||
    wantedTimelines.has(String(shot.timeline_id));

  const ordered = shotsInProjectOrder(stateShots);
  const cutByTimeline = new Map(
    cutShots.map((shot) => [String(shot.timeline_id), shot])
  );
  const shotByTimelineId = new Map(
    ordered.map((shot) => [String(shot.timeline_id), shot])
  );
  const predecessor = new Map<string, JsonRecord>();
  for (const [timelineId, previousTimelineId] of sequentialPredecessors(
    ordered
  )) {
    const previousShot =
      previousTimelineId && shotByTimelineId.get(previousTimelineId);
    if (previousShot) predecessor.set(timelineId, previousShot);
  }

  const frameRange = Array.isArray(videoSettings.frame_range)
    ? (videoSettings.frame_range as unknown[])
    : DEFAULT_FRAME_RANGE;
  const planDurationSeconds =
    isNumber(frameRange[0]) && isNumber(frameRange[1])
      ? (frameRange[1] - frameRange[0]) / FPS
      : (DEFAULT_FRAME_RANGE[1] - DEFAULT_FRAME_RANGE[0]) / FPS;
  const outputSize = request.outputSize ?? [];

  const skipped: JsonRecord[] = [];
  const blocked: JsonRecord[] = [];
  const sequentialIgnored: JsonRecord[] = [];
  const durationMissing: JsonRecord[] = [];
  const durationBlocked: JsonRecord[] = [];
  const changed: Record<string, string[]> = {};
  const changedByTimelineId: Record<string, string[]> = {};
  const runIds = new Set<string>();
  const planned: PlannedShot[] = [];

  for (const shot of ordered) {
    if (!wanted(shot)) continue;
    const timelineId = String(shot.timeline_id);
    const reference = {
      sequence_id: isNumber(shot.sequence_id) ? shot.sequence_id : null,
      key:
        shot.key === undefined || shot.key === null ? null : textOf(shot.key),
      timeline_id: timelineId
    };
    const label = reference.key ?? String(shot.sequence_id);
    if (shot.dropped) {
      skipped.push({ ...reference, reason: "dropped" });
      continue;
    }
    if (shot.locked) {
      skipped.push({ ...reference, reason: "locked" });
      continue;
    }
    if (shot.hidden && isBulkRun) {
      skipped.push({ ...reference, reason: "hidden" });
      continue;
    }
    const missing = records(shot.missing_references);
    if (missing.length) {
      blocked.push({ ...reference, missing });
      continue;
    }
    if (!textOf(shot.video_prompt ?? "").trim()) {
      blocked.push({
        ...reference,
        missing: [],
        reason_code: "no_prompt",
        reason: "this shot has no video prompt"
      });
      continue;
    }
    let [sequential, seqError] = sequentialShotConfig(
      shot.sequential,
      seqPerShot[timelineId],
      seqDefault
    );
    if (seqError) throw new ShotRunError(`shot ${label}: ${seqError}`);
    if (sequential && !predecessor.has(timelineId)) {
      sequentialIgnored.push({ ...reference, reason: "first shot" });
      sequential = null;
    }
    if (
      sequential?.mode === "last_chunk" &&
      videoSettings.render_provider === FAL_SHOT_PROVIDER &&
      Number(sequential.chunk_seconds) < FAL_VIDEO_TAIL_MIN_SECONDS
    ) {
      blocked.push({
        ...reference,
        missing: [],
        reason_code: "fal_video_tail_invalid",
        reason: "H3 Max (fal) requires a 2–10 second predecessor tail"
      });
      continue;
    }
    const isFal = videoSettings.render_provider === FAL_SHOT_PROVIDER;
    const openingPin = isFal && isFalOpeningPin(sequential);
    const aspect = textOf(
      (isRecord(videoSettings.provider_settings)
        ? videoSettings.provider_settings.aspect_ratio
        : undefined) ?? "16:9"
    );
    let sequentialSpec: JsonRecord | null = null;
    let previousTimelineId: string | null = null;
    let previousAssetId: string | null = null;
    let previousInRun = false;
    if (sequential) {
      const previous = predecessor.get(timelineId)!;
      previousTimelineId = String(previous.timeline_id);
      previousInRun = runIds.has(previousTimelineId);
      if (!previousInRun) {
        const previousCut = cutByTimeline.get(previousTimelineId);
        const previousPin = shotPin(previousCut);
        const version = records(previousCut?.versions).find(
          (version) =>
            version.asset_id === previousPin && version.ready === true
        );
        if (version) previousAssetId = previousPin;
        const dimensions = version?.decoded_frame_dimensions;
        if (
          openingPin &&
          isRecord(dimensions) &&
          isNumber(dimensions.width) &&
          dimensions.width > 0 &&
          isNumber(dimensions.height) &&
          dimensions.height > 0 &&
          !openingFrameMatchesAspect(
            dimensions.width,
            dimensions.height,
            aspect
          )
        ) {
          blocked.push({
            ...reference,
            missing: [],
            reason_code: "fal_opening_frame_aspect_mismatch",
            reason: openingFrameMismatch(
              dimensions.width,
              dimensions.height,
              aspect
            )
          });
          continue;
        }
      }
      if (!previousAssetId && !previousInRun) {
        blocked.push({
          ...reference,
          missing: [],
          reason_code: "predecessor_not_rendered",
          reason:
            "sequential: the previous shot has no finished render to continue from — " +
            "render it first, or pin one of its versions"
        });
        continue;
      }
      sequentialSpec = {
        ...sequentialFingerprint(sequential),
        ...(openingPin
          ? { opening_frame_preparation: FAL_OPENING_FRAME_POLICY }
          : {}),
        ...(videoSettings.render_provider === FAL_SHOT_PROVIDER &&
        sequential.mode === "last_chunk"
          ? { tail_preparation: FAL_VIDEO_TAIL_PROFILE }
          : {}),
        prev_key: previous.key ?? previous.sequence_id,
        ...(previousInRun ? {} : { prev_asset_id: previousAssetId })
      };
    }

    const ownDuration =
      isNumber(shot.duration_s) && shot.duration_s ? shot.duration_s : null;
    const durationSeconds = ownDuration ?? planDurationSeconds;
    const boundError = durationBoundError(durationSeconds);
    if (boundError) {
      const entry = {
        ...reference,
        missing: [],
        reason_code: "duration_out_of_range",
        reason: boundError
      };
      blocked.push(entry);
      durationBlocked.push(entry);
      continue;
    }
    if (!ownDuration)
      durationMissing.push({ ...reference, duration_s: planDurationSeconds });

    const shotRewriteError = promptRewriteError(shot.prompt_rewrite);
    if (shotRewriteError)
      throw new ShotRunError(`shot ${label}: ${shotRewriteError}`);
    const shotRewrite =
      (shot.prompt_rewrite as PromptRewrite | undefined) ?? planRewrite;
    let shotSettings = videoSettings;
    if (ownDuration)
      shotSettings = { ...shotSettings, duration_s: ownDuration };
    if (shotRewrite !== planRewrite)
      shotSettings = { ...shotSettings, ...PROMPT_REWRITE_PAIRS[shotRewrite] };
    if (visualStyle)
      shotSettings = { ...shotSettings, visual_style: visualStyle };

    const renderShot = {
      ...shot,
      _local_storyboard: shotRewrite === "raw" ? null : shot._local_storyboard
    };
    const referenceCapacity =
      FAL_SHOT_IMAGE_SLOTS -
      numberedContinuitySlots(sequential, isFal) -
      Number(isRecord(renderShot._local_storyboard));
    const referenceCount = Object.values(
      isRecord(shot.references) ? shot.references : {}
    ).flatMap((value) => records(value)).length;
    const rawReferencePrompt = openingPin
      ? [shot.video_prompt, sequential?.prompt_appendix].map(textOf).join(" ")
      : textOf(shot.video_prompt);
    if (
      openingPin &&
      shotRewrite === "raw" &&
      hasUnboundImageNumber(
        rawReferencePrompt,
        Math.min(referenceCount, referenceCapacity)
      )
    ) {
      blocked.push({
        ...reference,
        missing: [],
        reason_code: "fal_opening_frame_numbered_reference",
        reason:
          "The pinned opening frame is not a numbered image. Remove references to its Image number or choose Cut or Loose reference."
      });
      continue;
    }
    if (
      videoSettings.render_provider === FAL_SHOT_PROVIDER &&
      shotRewrite === "raw" &&
      hasRawNumberedReferenceOverflow(
        rawReferencePrompt,
        referenceCount,
        referenceCapacity
      )
    ) {
      blocked.push({
        ...reference,
        missing: [],
        reason_code: "raw_reference_overflow",
        reason:
          "Raw numbered image references cannot be preserved when reference images exceed " +
          `the ${referenceCapacity} available slots with H3 Max (fal); ` +
          "use normal prompt composition or reduce reference images"
      });
      continue;
    }
    const spec = shotSpec(renderShot, shotSettings, outputSize, sequentialSpec);
    if (
      isFal &&
      (openingPin || sequential?.mode === "last_chunk") &&
      !previousInRun
    ) {
      // Reuse an immutable prepared binding only if all unprepared inputs match.
      for (const version of records(
        cutByTimeline.get(timelineId)?.versions
      ).reverse()) {
        if (
          version.ready !== true ||
          !isRecord(version.render_spec) ||
          !isRecord(version.render_spec.sequential)
        )
          continue;
        const { prepared_video, prepared_opening_frame, ...baseSequential } =
          version.render_spec.sequential;
        const baseSpec = { ...version.render_spec, sequential: baseSequential };
        if (fingerprint(baseSpec) !== fingerprint(spec)) continue;
        if (openingPin) {
          const valid = falOpeningFrameSchema.safeParse(prepared_opening_frame);
          if (
            !valid.success ||
            valid.data.predecessor_asset_id !== previousAssetId ||
            valid.data.predecessor_timeline_id !== previousTimelineId ||
            valid.data.aspect_ratio !== aspect ||
            !openingFrameMatchesAspect(
              valid.data.width,
              valid.data.height,
              aspect
            )
          )
            continue;
          spec.sequential = { ...sequentialSpec, prepared_opening_frame };
          break;
        }
        if (
          !isRecord(prepared_video) ||
          typeof prepared_video.asset_id !== "string" ||
          !prepared_video.asset_id
        )
          continue;
        const valid = videoTailProvenanceSchema.safeParse(
          prepared_video.provenance
        );
        if (
          !valid.success ||
          valid.data.requested_seconds !== sequential?.chunk_seconds
        )
          continue;
        spec.sequential = { ...sequentialSpec, prepared_video };
        break;
      }
    }
    const value = fingerprint(spec);
    // A matching old spec cannot represent the new predecessor render.
    if (
      !previousInRun &&
      renderedFingerprints(cutByTimeline.get(timelineId)).has(value)
    ) {
      skipped.push({
        ...reference,
        reason: "already rendered with these inputs"
      });
      continue;
    }
    if (inFlight.get(timelineId)?.has(value)) {
      skipped.push({ ...reference, reason: "render already in progress" });
      continue;
    }
    const hasReferenceImage =
      isRecord(shot.references) && Object.keys(shot.references).length > 0;
    if (
      !hasReferenceImage &&
      !sequential &&
      !isRecord(renderShot._local_storyboard)
    ) {
      blocked.push({
        ...reference,
        missing: [],
        reason_code: "no_reference_image",
        reason: "this shot has no reference image"
      });
      continue;
    }
    const fields = changedFields(shot.last_spec, spec);
    if (fields.length) {
      changed[label] = fields;
      changedByTimelineId[timelineId] = fields;
    }
    runIds.add(timelineId);
    planned.push({
      shot: renderShot,
      sequential,
      previousTimelineId,
      previousAssetId,
      previousInRun,
      durationSeconds,
      promptRewrite: shotRewrite,
      renderSpec: { fingerprint: value, spec }
    });
  }

  const reported = ordered.some(
    (shot) => isNumber(shot.duration_s) && shot.duration_s
  )
    ? durationMissing
    : [];
  return {
    preview: {
      would_run: planned.map(({ shot }) =>
        isNumber(shot.sequence_id) ? shot.sequence_id : null
      ),
      would_run_keys: planned.map(({ shot }) =>
        shot.key === undefined || shot.key === null ? null : textOf(shot.key)
      ),
      would_run_timeline_ids: planned.map(({ shot }) =>
        String(shot.timeline_id)
      ),
      skipped,
      blocked,
      changed,
      changed_by_timeline_id: changedByTimelineId,
      duration_ignored: [],
      duration_missing: reported,
      sequential_ignored: sequentialIgnored,
      ...(videoSettings.render_provider === FAL_SHOT_PROVIDER
        ? {
            fal_video_tail_estimates: planned
              .filter((item) => item.sequential?.mode === "last_chunk")
              .map((item) =>
                falVideoTailEstimate(
                  String(item.shot.timeline_id),
                  isRecord(videoSettings.provider_settings)
                    ? videoSettings.provider_settings.resolution
                    : undefined,
                  item.durationSeconds,
                  Number(item.sequential?.chunk_seconds)
                )
              )
          }
        : {})
    },
    planned,
    videoSettings,
    durationError: durationBlocked.length
      ? `shot ${textOf(durationBlocked[0]!.key ?? durationBlocked[0]!.sequence_id)}: ${textOf(durationBlocked[0]!.reason)}`
      : null
  };
};
