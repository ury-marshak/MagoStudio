import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";

import type {
  OrdinaryFalEffectDestination,
  OrdinaryFalEffectInput
} from "../../shared/ordinaryFal";
import type { DatabaseManager } from "../database/databaseManager";
import { clipTimelineFrames } from "../database/projectRepository";
import {
  assets,
  clips,
  externalRenderJobs,
  ordinaryFalJobs,
  projectAssets,
  projects,
  shots,
  tracks
} from "../database/schema";
import type { PreparedRenderInput } from "../providers/externalRenderJobService";

import type { OrdinaryFalDestination } from "./ordinaryFalRequest";
import { TOPAZ_UPSCALE_FACTOR } from "./ordinaryFalRequest";
import {
  MAX_EFFECT_SOURCE_BYTES,
  probeEffectVideo,
  validateEffectVideo
} from "./probeEffectVideo";

const MAX_TIMELINE_FPS_DRIFT = 0.01;
const MAX_TIMELINE_DURATION_DRIFT_MS = 1;

const parseRecord = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid clip metadata");
  return parsed as Record<string, unknown>;
};

async function findEffectSource(
  database: Database,
  projectId: string,
  shotId: string,
  clipId: string
) {
  const [source] = await database
    .select({ clip: clips, track: tracks, asset: assets })
    .from(clips)
    .innerJoin(tracks, eq(tracks.id, clips.trackId))
    .innerJoin(assets, eq(assets.id, clips.assetId))
    .innerJoin(
      projectAssets,
      and(
        eq(projectAssets.assetId, assets.id),
        eq(projectAssets.projectId, projectId)
      )
    )
    .where(
      and(
        activeTracks(projectId, shotId),
        eq(clips.id, clipId),
        inArray(tracks.type, ["IMAGE", "RENDER"]),
        eq(assets.type, "video"),
        eq(assets.status, "available"),
        eq(assets.active, true)
      )
    )
    .limit(1);
  return source;
}

function sourceTiming(
  record: NonNullable<Awaited<ReturnType<typeof findEffectSource>>>,
  source: OrdinaryFalEffectDestination["source"]
) {
  const { clip, asset } = record;
  const frameCount = Math.round(source.durationSeconds * source.fps);
  const { duration, timelineOffset } = clipTimelineFrames({
    clipData: parseRecord(clip.dataJson),
    assetFrameCount: frameCount,
    assetFps: source.fps,
    timelineOffsetMs: clip.timelineOffset
  });
  if (
    timelineOffset < 0 ||
    duration !== frameCount ||
    (clip.trimStart ?? 0) !== 0 ||
    (clip.trimEnd !== null &&
      Math.abs(clip.trimEnd - source.durationSeconds * 1000) >
        MAX_TIMELINE_DURATION_DRIFT_MS) ||
    (asset.frameCount !== null && asset.frameCount !== frameCount)
  )
    return null;
  return { frameCount, startFrame: timelineOffset };
}

export type OrdinaryFalReservation = typeof ordinaryFalJobs.$inferSelect;
type Database = ReturnType<DatabaseManager["get"]>;
const activeStatuses = [
  "SUBMITTED",
  "CANCELLATION_REQUESTED",
  "OUTPUT_READY"
] as const;

function editorJobs(database: Database) {
  return database
    .select({ editor: ordinaryFalJobs, job: externalRenderJobs })
    .from(ordinaryFalJobs)
    .leftJoin(
      externalRenderJobs,
      eq(externalRenderJobs.id, ordinaryFalJobs.jobId)
    );
}
export type OrdinaryFalRecord = Awaited<ReturnType<typeof editorJobs>>[number];

async function findOutputAsset(
  database: Database,
  projectId: string,
  job: NonNullable<OrdinaryFalRecord["job"]>
) {
  const assetId = job.outputJson?.assetIds?.[0];
  if (!assetId) return;
  const [asset] = await database
    .select({
      id: assets.id,
      sourcePath: assets.sourcePath,
      duration: assets.duration,
      fps: assets.fps,
      frameCount: assets.frameCount,
      width: assets.width,
      height: assets.height,
      dataJson: assets.dataJson
    })
    .from(assets)
    .innerJoin(projectAssets, eq(projectAssets.assetId, assets.id))
    .where(
      and(
        eq(projectAssets.projectId, projectId),
        eq(assets.id, assetId),
        eq(assets.active, true),
        eq(assets.status, "available"),
        eq(assets.type, job.kind)
      )
    );
  return asset;
}

async function activeShot(
  database: Database,
  projectId: string,
  shotId: string
) {
  const [shot] = await database
    .select({ id: shots.id, settingsJson: projects.settingsJson })
    .from(shots)
    .innerJoin(projects, eq(projects.id, shots.projectId))
    .where(
      and(
        eq(shots.id, shotId),
        eq(projects.id, projectId),
        eq(shots.active, true),
        eq(projects.active, true)
      )
    )
    .limit(1);
  return shot;
}

const activeTracks = (projectId: string, shotId: string) =>
  and(
    eq(tracks.projectId, projectId),
    eq(tracks.shotId, shotId),
    eq(tracks.active, true)
  );

async function videoTrack(
  database: Database,
  projectId: string,
  shotId: string,
  trackId: string
) {
  const [track] = await database
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(
      and(
        activeTracks(projectId, shotId),
        eq(tracks.type, "RENDER"),
        eq(tracks.id, trackId)
      )
    )
    .limit(1);
  return track;
}

export class OrdinaryFalRepository {
  constructor(private readonly manager: DatabaseManager) {}

  async get(jobId: string): Promise<OrdinaryFalRecord | null> {
    const [row] = await editorJobs(this.manager.get())
      .where(eq(ordinaryFalJobs.jobId, jobId))
      .limit(1);
    return row ?? null;
  }

  list(projectId?: string) {
    return editorJobs(this.manager.get())
      .where(
        projectId === undefined
          ? undefined
          : eq(ordinaryFalJobs.projectId, projectId)
      )
      .orderBy(desc(ordinaryFalJobs.createdAt), asc(ordinaryFalJobs.jobId));
  }

  recoverable(keychainAccount: string) {
    return editorJobs(this.manager.get())
      .where(
        and(
          eq(ordinaryFalJobs.keychainAccount, keychainAccount),
          or(
            and(
              inArray(externalRenderJobs.status, activeStatuses),
              isNotNull(externalRenderJobs.requestId)
            ),
            and(
              eq(externalRenderJobs.status, "INGESTED"),
              eq(ordinaryFalJobs.placement, "PENDING")
            )
          )
        )
      )
      .orderBy(asc(ordinaryFalJobs.createdAt), asc(ordinaryFalJobs.jobId));
  }

  async markInterrupted() {
    const database = this.manager.get();
    await database
      .update(externalRenderJobs)
      .set({
        status: "SUBMISSION_UNKNOWN",
        error: "The library closed before the provider request ID was saved",
        updatedAt: new Date()
      })
      .where(
        and(
          eq(externalRenderJobs.status, "SUBMITTING"),
          inArray(
            externalRenderJobs.id,
            database.select({ id: ordinaryFalJobs.jobId }).from(ordinaryFalJobs)
          )
        )
      );
  }

  async validateDestination(
    projectId: string,
    shotId: string,
    destination: OrdinaryFalDestination,
    signal: AbortSignal
  ) {
    const database = this.manager.get();
    const shot = await activeShot(database, projectId, shotId);
    signal.throwIfAborted();
    const project = shot && parseRecord(shot.settingsJson);
    if (
      !project ||
      project.origin === "cloud" ||
      project.type === "script_to_shots"
    )
      throw new Error(
        "Choose an active local timeline shot for this fal render"
      );
    if (
      destination.kind === "reference-video" &&
      !(await videoTrack(database, projectId, shotId, destination.trackId))
    )
      throw new Error("Choose an active render track in this shot");
    signal.throwIfAborted();
    const settings = project.fal_generation_settings;
    return settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : undefined;
  }

  async prepareEffect(
    request: OrdinaryFalEffectInput,
    getLibraryRoot: () => Promise<string | null>,
    signal: AbortSignal
  ): Promise<{
    destination: OrdinaryFalEffectDestination;
    input: PreparedRenderInput;
    dispose: () => Promise<void>;
  }> {
    const database = this.manager.get();
    const shot = await activeShot(database, request.projectId, request.shotId);
    signal.throwIfAborted();
    if (!shot || parseRecord(shot.settingsJson).origin !== "local")
      throw new Error(
        "Video effects require an active shot in a local project"
      );
    const record = await findEffectSource(
      database,
      request.projectId,
      request.shotId,
      request.sourceClipId
    );
    signal.throwIfAborted();
    if (!record)
      throw new Error("Select a playable local video clip in this shot");
    if (record.asset.id !== request.expectedSourceAssetId)
      throw new Error(
        "The selected source clip changed. Reopen video effects and confirm the current video."
      );
    let sourcePath = record.asset.sourcePath;
    if (record.asset.relativeSourcePath) {
      const root = await getLibraryRoot();
      signal.throwIfAborted();
      if (!root) throw new Error("Open the local library first");
      sourcePath = path.join(root, record.asset.relativeSourcePath);
    }
    if (!path.isAbsolute(sourcePath) || !/\.(mp4|mov)$/i.test(sourcePath))
      throw new Error("Select a readable local MP4 or MOV video");
    const info = await stat(sourcePath);
    signal.throwIfAborted();
    if (!info.isFile() || !info.size)
      throw new Error("Select a readable local MP4 or MOV video");
    if (info.size > MAX_EFFECT_SOURCE_BYTES)
      throw new Error("Source video must be at most 200 MB");
    // Do not resolve or reopen the original path after validation. A linked
    // asset may be overwritten, moved or replaced while the action waits.
    const directory = await mkdtemp(path.join(tmpdir(), "mago-effect-"));
    const dispose = () => rm(directory, { recursive: true, force: true });
    const isMov = /\.mov$/i.test(sourcePath);
    const name = isMov ? "source.mov" : "source.mp4";
    const snapshot = path.join(directory, name);
    try {
      signal.throwIfAborted();
      // The range cap applies even if the linked file grew after stat.
      await pipeline(
        createReadStream(sourcePath, { end: MAX_EFFECT_SOURCE_BYTES }),
        createWriteStream(snapshot, { flags: "wx" }),
        { signal }
      );
      if ((await stat(snapshot)).size > MAX_EFFECT_SOURCE_BYTES)
        throw new Error("Source video must be at most 200 MB");
      const source = await probeEffectVideo(snapshot, signal);
      signal.throwIfAborted();
      validateEffectVideo(source, request.kind);
      const timing = sourceTiming(record, source);
      if (!timing)
        throw new Error(
          "Video effects require the entire source video; trimmed clips are not supported"
        );
      const file = await openAsBlob(snapshot, {
        type: isMov ? "video/quicktime" : "video/mp4"
      });
      signal.throwIfAborted();
      return {
        destination: {
          kind: request.kind,
          sourceClipId: record.clip.id,
          sourceAssetId: record.asset.id,
          sourceTrackId: record.track.id,
          ...timing,
          source
        },
        input: { file, name, kind: "video" },
        dispose
      };
    } catch (error) {
      await dispose();
      signal.throwIfAborted();
      throw error;
    }
  }

  async reserve(input: typeof ordinaryFalJobs.$inferInsert) {
    const [inserted] = await this.manager
      .get()
      .insert(ordinaryFalJobs)
      .values(input)
      .onConflictDoNothing()
      .returning({ id: ordinaryFalJobs.jobId });
    return !!inserted;
  }

  async assertDispatchRecorded(id: string, signal: AbortSignal) {
    // A fresh transaction proves the reservation and external job aren’t
    // uncommitted writes from another library operation on this connection.
    await this.manager.transaction(async (database) => {
      const [row] = await editorJobs(database).where(
        eq(ordinaryFalJobs.jobId, id)
      );
      if (row?.job?.status !== "SUBMITTING")
        throw new Error("The fal submission record is not durable");
    }, signal);
  }

  async attach({ editor, job }: OrdinaryFalRecord, signal: AbortSignal) {
    if (job?.status !== "INGESTED" || editor.placement !== "PENDING") return;
    signal.throwIfAborted();
    const { projectId, shotId, destination, jobId } = editor;
    let verifiedOutputPath: string | undefined;
    if (
      (destination.kind === "video-edit" ||
        destination.kind === "video-upscale") &&
      destination.source.presentationSignature
    ) {
      // Ingest stores aggregate metadata, not packet timing. Inspect the local
      // output before opening the write transaction; recheck its path below.
      const asset = await findOutputAsset(this.manager.get(), projectId, job);
      signal.throwIfAborted();
      if (asset && path.isAbsolute(asset.sourcePath)) {
        const output = await probeEffectVideo(asset.sourcePath, signal).catch(
          () => undefined
        );
        signal.throwIfAborted();
        if (
          output?.presentationSignature ===
          destination.source.presentationSignature
        )
          verifiedOutputPath = asset.sourcePath;
      }
    }
    await this.manager.transaction(async (database) => {
      const [reservation] = await database
        .select({ placement: ordinaryFalJobs.placement })
        .from(ordinaryFalJobs)
        .where(eq(ordinaryFalJobs.jobId, jobId));
      if (reservation?.placement !== "PENDING") return;
      const settle = async (
        placement: OrdinaryFalReservation["placement"],
        clipId: string | null
      ) => {
        signal.throwIfAborted();
        await database
          .update(ordinaryFalJobs)
          .set({ placement, clipId, updatedAt: new Date() })
          .where(eq(ordinaryFalJobs.jobId, jobId));
        signal.throwIfAborted();
      };
      const asset = await findOutputAsset(database, projectId, job);
      if (!asset || !(await activeShot(database, projectId, shotId)))
        return settle("UNATTACHED", null);
      signal.throwIfAborted();
      const now = new Date();
      let track: { id: string; name: string } | undefined;
      if (destination.kind === "reference-video") {
        track = await videoTrack(
          database,
          projectId,
          shotId,
          destination.trackId
        );
        if (!track) return settle("UNATTACHED", null);
      } else if (
        destination.kind === "video-edit" ||
        destination.kind === "video-upscale"
      ) {
        const source = await findEffectSource(
          database,
          projectId,
          shotId,
          destination.sourceClipId
        );
        const timing = source && sourceTiming(source, destination.source);
        const input = destination.source;
        const requestedAudio =
          destination.kind === "video-edit"
            ? editor.effectiveSettings.keep_audio === true && input.hasAudio
            : input.hasAudio;
        // Never force or trim an incompatible result onto an aligned timeline.
        // The locally ingested asset remains playable separately in history.
        if (
          asset.sourcePath !== verifiedOutputPath ||
          !source ||
          source.track.id !== destination.sourceTrackId ||
          source.asset.id !== destination.sourceAssetId ||
          timing?.startFrame !== destination.startFrame ||
          timing.frameCount !== destination.frameCount ||
          asset.frameCount !== destination.frameCount ||
          asset.fps === null ||
          Math.abs(asset.fps / 1000 - input.fps) > MAX_TIMELINE_FPS_DRIFT ||
          asset.duration === null ||
          Math.abs(asset.duration - input.durationSeconds * 1000) >
            MAX_TIMELINE_DURATION_DRIFT_MS ||
          parseRecord(asset.dataJson).hasAudio !== requestedAudio ||
          (destination.kind === "video-upscale" &&
            (asset.width !== input.width * TOPAZ_UPSCALE_FACTOR ||
              asset.height !== input.height * TOPAZ_UPSCALE_FACTOR))
        )
          return settle("UNATTACHED", null);
        const [last] = await database
          .select({ position: tracks.position })
          .from(tracks)
          .where(eq(tracks.shotId, shotId))
          .orderBy(desc(tracks.position))
          .limit(1);
        signal.throwIfAborted();
        track = {
          id: randomUUID(),
          name:
            destination.kind === "video-edit"
              ? "fal video edit"
              : "fal 2× upscale"
        };
        await database.insert(tracks).values({
          ...track,
          projectId,
          shotId,
          type: "RENDER",
          dataJson: JSON.stringify({
            externalRender: { provider: "fal", kind: destination.kind }
          }),
          position: (last?.position ?? -1) + 1,
          createdAt: now,
          updatedAt: now
        });
      } else {
        const [existing] = await database
          .select({ id: tracks.id, name: tracks.name })
          .from(tracks)
          .where(
            and(activeTracks(projectId, shotId), eq(tracks.type, "IMG2IMG"))
          )
          .orderBy(asc(tracks.position), asc(tracks.id))
          .limit(1);
        track = existing;
        if (!track) {
          const [last] = await database
            .select({ position: tracks.position })
            .from(tracks)
            .where(eq(tracks.shotId, shotId))
            .orderBy(desc(tracks.position))
            .limit(1);
          signal.throwIfAborted();
          track = { id: randomUUID(), name: "Generated images" };
          await database.insert(tracks).values({
            ...track,
            projectId,
            shotId,
            type: "IMG2IMG",
            position: (last?.position ?? -1) + 1,
            createdAt: now,
            updatedAt: now
          });
        }
      }
      signal.throwIfAborted();
      const clipId = randomUUID();
      await database.insert(clips).values({
        id: clipId,
        trackId: track.id,
        assetId: asset.id,
        name: destination.kind === "image-edit" ? "fal image edit" : track.name,
        timelineOffset:
          destination.kind === "reference-video"
            ? destination.timelineOffsetMs
            : destination.kind === "video-edit" ||
                destination.kind === "video-upscale"
              ? Math.round(
                  (destination.startFrame / destination.source.fps) * 1000
                )
              : 0,
        dataJson: JSON.stringify({
          status: "success",
          generated_at: now.toISOString(),
          ...(destination.kind === "image-edit"
            ? { frame: destination.frame, source: job.inputAssetIds[0] }
            : {}),
          ...(destination.kind === "video-edit" ||
          destination.kind === "video-upscale"
            ? {
                frame_range: [
                  destination.startFrame,
                  destination.startFrame + destination.frameCount
                ]
              }
            : {}),
          externalRender: {
            provider: "fal",
            jobId,
            model: editor.model,
            settings: editor.effectiveSettings,
            destination
          }
        }),
        createdAt: now,
        updatedAt: now
      });
      signal.throwIfAborted();
      await database
        .update(projects)
        .set({ updatedAt: now })
        .where(eq(projects.id, projectId));
      return settle("ATTACHED", clipId);
    }, signal);
  }
}
