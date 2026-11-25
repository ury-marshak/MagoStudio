import { createHash } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { and, eq } from "drizzle-orm";
import { nativeImage } from "electron";

import { probeRenderedVideoMetadata } from "../cloud/probeRenderedVideoMetadata";
import { toDeliveredVideoAssetFields } from "../cloud/toDeliveredVideoAssetFields";
import type { DatabaseManager } from "../database/databaseManager";
import { assets, projectAssets } from "../database/schema";
import { doesVideoHaveAudioStream } from "../media/doesVideoHaveAudioStream";
import { createImageThumbnail } from "../media/imageThumbnail";
import { probeEffectVideo } from "../ordinaryFal/probeEffectVideo";
import { publishFile, temporaryFile } from "../storage/atomicFile";

import type { ExternalRenderJob } from "./externalRenderJobRepository";
import type { MediaRenderOutput } from "./mediaRenderProvider";
import { consumeProviderBody } from "./providerResponseBody";

const effectEndpoints = new Set([
  "fal-ai/kling-video/o1/video-to-video/edit",
  "fal-ai/topaz/upscale/video"
]);

const downloadTimeoutMs = 120_000;
const httpOk = 200;
const unauthorized = 401;
const forbidden = 403;
const notFound = 404;
const gone = 410;
const unavailableStatuses = new Set([unauthorized, forbidden, notFound, gone]);
const imageTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

export class RenderOutputUnavailable extends Error {}

export class ExternalRenderAssets {
  constructor(
    private readonly manager: DatabaseManager,
    private readonly getLibraryRoot: () => Promise<string | null>,
    private readonly resolveScriptMedia?: (
      assetId: string,
      projectId: string
    ) => Promise<string | null>
  ) {}

  async input(
    projectId: string,
    assetId: string,
    kind: "image" | "video" = "image"
  ) {
    const [asset] = await this.manager
      .get()
      .select({
        sourcePath: assets.sourcePath,
        relativeSourcePath: assets.relativeSourcePath,
        type: assets.type,
        active: assets.active,
        status: assets.status
      })
      .from(projectAssets)
      .innerJoin(assets, eq(assets.id, projectAssets.assetId))
      .where(
        and(eq(projectAssets.projectId, projectId), eq(assets.id, assetId))
      );
    // A known but unavailable/wrong-modality asset must not fall through to
    // a script-media resolver and bypass the project asset's state.
    if (
      asset &&
      (!asset.active || asset.status !== "available" || asset.type !== kind)
    )
      throw new Error(`Render input ${kind} is unavailable in this project`);
    const source = asset?.relativeSourcePath
      ? path.join(await this.libraryRoot(), asset.relativeSourcePath)
      : (asset?.sourcePath ??
        (await this.resolveScriptMedia?.(assetId, projectId)));
    if (!source)
      throw new Error(`Render input ${kind} is unavailable in this project`);
    const name = path.basename(source);
    const extension = path.extname(name).toLowerCase();
    const type =
      kind === "video"
        ? extension === ".mp4"
          ? "video/mp4"
          : undefined
        : imageTypes.get(extension);
    if (!type)
      throw new Error(
        kind === "video"
          ? "Render input must be an MP4 video"
          : "Render input must be a PNG, JPEG, or WebP image"
      );
    const file = await openAsBlob(source, { type });
    if (!file.size) throw new Error(`Render input ${kind} is empty`);
    return { file, name };
  }

  async download(
    job: ExternalRenderJob,
    output: MediaRenderOutput,
    signal?: AbortSignal
  ): Promise<(typeof assets.$inferInsert)[]> {
    signal?.throwIfAborted();
    const root = await this.libraryRoot();
    const files: (typeof assets.$inferInsert)[] = [];
    for (const [index, url] of output.urls.entries()) {
      signal?.throwIfAborted();
      const id = createHash("sha256")
        .update(JSON.stringify([job.id, index]))
        .digest("hex");
      const name = `output-${index + 1}.${job.kind === "image" ? "png" : "mp4"}`;
      const relativeSourcePath = path.join("renders", "external", id, name);
      const sourcePath = path.join(root, relativeSourcePath);
      const thumbnailRelativePath = path.join(
        "thumbnails",
        "assets",
        `${id}.jpg`
      );
      await mkdir(path.dirname(sourcePath), { recursive: true });

      // The final path exists only after the complete file has been published.
      // Reuse finished files when a later output or the database write failed.
      const local = await stat(sourcePath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        }
      );
      const fields = local
        ? await this.mediaFields(job, sourcePath, signal)
        : await this.downloadFile(job, url, sourcePath, signal);
      signal?.throwIfAborted();
      const thumbnail = path.join(root, thumbnailRelativePath);
      await mkdir(path.dirname(thumbnail), { recursive: true });
      const preview = await createImageThumbnail(sourcePath, thumbnail)
        .then(() => thumbnailRelativePath)
        .catch(() => undefined);
      const info = local ?? (await stat(sourcePath));
      signal?.throwIfAborted();
      const { hasAudio: measuredAudio, ...assetFields } = fields;
      const hasAudio =
        measuredAudio ??
        (job.kind === "video"
          ? await doesVideoHaveAudioStream(sourcePath)
          : undefined);
      signal?.throwIfAborted();
      files.push({
        id,
        name,
        type: job.kind,
        origin: "generated",
        sourcePath,
        relativeSourcePath,
        thumbnailRelativePath: preview,
        sizeBytes: info.size,
        modifiedAtImport: info.mtime,
        ...assetFields,
        dataJson: JSON.stringify({
          origin: "generated",
          status: "ingested",
          hasAudio,
          externalRender: {
            jobId: job.id,
            provider: job.provider,
            endpoint: job.endpoint,
            requestId: job.requestId
          }
        })
      });
    }
    return files;
  }

  private async downloadFile(
    job: ExternalRenderJob,
    url: string,
    destination: string,
    callerSignal?: AbortSignal
  ) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password)
      throw new Error("Invalid render output URL");
    const timeout = AbortSignal.timeout(downloadTimeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    const temporary = temporaryFile(destination);
    try {
      const response = await fetch(target.href, { redirect: "error", signal });
      if (signal.aborted) {
        await response.body?.cancel();
        signal.throwIfAborted();
      }
      if (unavailableStatuses.has(response.status)) {
        await response.body?.cancel();
        throw new RenderOutputUnavailable(
          `Render output is unavailable (HTTP ${response.status})`
        );
      }
      if (response.status !== httpOk || !response.body) {
        await response.body?.cancel();
        throw new Error(
          `Render output download returned HTTP ${response.status}`
        );
      }
      // The source owns its web reader, so abort can cancel a pending read
      // without another chunk. Keep the transfer enrolled through cleanup.
      await consumeProviderBody(response.body, signal, (chunks) =>
        pipeline(chunks, createWriteStream(temporary), { signal })
      );
      const { size } = await stat(temporary);
      const expected = response.headers.get("content-length");
      if (
        !size ||
        (expected &&
          !response.headers.has("content-encoding") &&
          size !== Number(expected))
      )
        throw new Error("Render output download was incomplete");
      const fields = await this.mediaFields(job, temporary, signal);
      signal.throwIfAborted();
      await publishFile(temporary, destination, signal);
      return fields;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async mediaFields(
    job: ExternalRenderJob,
    source: string,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    if (job.kind === "image") {
      const image = nativeImage.createFromPath(source);
      if (image.isEmpty())
        throw new Error("Could not decode the rendered image");
      return { ...image.getSize(), hasAudio: undefined };
    }
    if (job.provider === "fal" && effectEndpoints.has(job.endpoint)) {
      const video = await probeEffectVideo(source, signal);
      signal?.throwIfAborted();
      return {
        width: video.width,
        height: video.height,
        fps: Math.round(video.fps * 1000),
        frameCount: Math.round(video.durationSeconds * video.fps),
        duration: Math.round(video.durationSeconds * 1000),
        hasAudio: video.hasAudio
      };
    }
    const video = await probeRenderedVideoMetadata(source, signal);
    signal?.throwIfAborted();
    if (!video) throw new Error("Could not read the rendered video");
    return {
      ...toDeliveredVideoAssetFields(video, undefined),
      hasAudio: undefined
    };
  }

  private async libraryRoot(): Promise<string> {
    const root = await this.getLibraryRoot();
    if (!root) throw new Error("Choose a Mago library folder first");
    return root;
  }
}
