import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { and, eq, isNull, sql } from "drizzle-orm";

import { resolveCloudConfig } from "../../shared/cloudConfig";
import type {
  LocalScriptProjectSnapshot,
  LocalScriptProjectSnapshotInput
} from "../../shared/contracts";
import {
  withCloudStorageDownload,
  type CloudStorageAccess
} from "../cloudStorage/openCloudStorageDownload";
import { parseAllowedCloudStorageUrl } from "../cloudStorage/parseAllowedCloudStorageUrl";
import { LibraryWorkSession } from "../libraryWorkSession";
import { createImageThumbnail } from "../media/imageThumbnail";
import type { ProfileIoDrain } from "../providers/profileIoDrain";
import { atomicWriteFile, publishFile } from "../storage/atomicFile";
import { storedObject } from "../storage/storedJson";

import { DatabaseManager } from "./databaseManager";
import {
  assets,
  projectAssets,
  projects,
  scriptProjectMedia,
  scriptProjectSnapshots
} from "./schema";

const MEDIA_URL_KEYS = new Set(["url", "thumbnail_url", "poster_url"]);
const PROJECT_DIRECTORY_HASH_LENGTH = 32;
const MAX_CONCURRENT_MEDIA_DOWNLOADS = 6;
const MAX_CONCURRENT_THUMBNAIL_BUILDS = 2;

export const optimizedThumbnailUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol !== "mago-media:") return value;
    if (url.hostname === "asset") {
      return `mago-media://thumbnail${url.pathname}`;
    }
    if (url.hostname === "script-project") {
      return `mago-media://script-project-thumbnail${url.pathname}`;
    }
  } catch {
    // Preserve malformed legacy values; the image component will show its
    // normal broken-image state rather than making snapshot reads fail.
  }
  return value;
};

const stableMediaUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return value;
  }
};
const parseJson = (
  value: string | null,
  cachedMedia = new Map<string, string>()
): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    // The reviver upgrades legacy thumbnail URLs during the JSON parse we
    // already have to perform, avoiding a second traversal of large snapshots.
    const parsed: unknown = JSON.parse(value, (key, member: unknown) => {
      if (!MEDIA_URL_KEYS.has(key) || typeof member !== "string") return member;
      const localized = cachedMedia.get(stableMediaUrl(member)) ?? member;
      return key === "thumbnail_url"
        ? optimizedThumbnailUrl(localized)
        : localized;
    });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasRemoteMedia = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasRemoteMedia);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, member]) =>
      (MEDIA_URL_KEYS.has(key) &&
        typeof member === "string" &&
        member.startsWith("https://")) ||
      hasRemoteMedia(member)
  );
};

const dateValue = (value: unknown, fallback: Date): Date => {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed;
};

const mediaExtension = (contentType: string | undefined, url: URL): string => {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const fromType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm"
  };
  if (normalized && fromType[normalized]) return fromType[normalized];
  const candidate = path.extname(url.pathname).slice(1).toLowerCase();
  return /^(?:jpe?g|png|webp|mp4|mov|webm)$/.test(candidate)
    ? candidate
    : "bin";
};

type LocalizedMedia = { url: string; isImage: boolean };

export class ScriptProjectSnapshotRepository {
  readonly libraryWork = new LibraryWorkSession(() => ({
    downloads: new Map<string, Promise<LocalizedMedia>>(),
    profileDownloads: new WeakMap<
      AbortSignal,
      Map<string, Promise<LocalizedMedia>>
    >(),
    thumbnailJobs: new Map<string, Promise<string | null>>(),
    pendingThumbnailStarts: [] as Array<() => void>,
    activeThumbnailBuilds: 0,
    pendingDownloadStarts: [] as Array<() => void>,
    activeMediaDownloads: 0,
    scheduledDownloads: new Map<string, Set<AbortController>>()
  }));
  private get downloads() {
    return this.libraryWork.state.downloads;
  }
  private getProfileDownloads(profile: AbortSignal) {
    const profiles = this.libraryWork.state.profileDownloads;
    const existing = profiles.get(profile);
    if (existing) return existing;
    const downloads = new Map<string, Promise<LocalizedMedia>>();
    profiles.set(profile, downloads);
    return downloads;
  }
  private get thumbnailJobs() {
    return this.libraryWork.state.thumbnailJobs;
  }
  private get pendingThumbnailStarts() {
    return this.libraryWork.state.pendingThumbnailStarts;
  }
  private get activeThumbnailBuilds() {
    return this.libraryWork.state.activeThumbnailBuilds;
  }
  private set activeThumbnailBuilds(value: number) {
    this.libraryWork.state.activeThumbnailBuilds = value;
  }
  private get pendingDownloadStarts() {
    return this.libraryWork.state.pendingDownloadStarts;
  }
  private get activeMediaDownloads() {
    return this.libraryWork.state.activeMediaDownloads;
  }
  private set activeMediaDownloads(value: number) {
    this.libraryWork.state.activeMediaDownloads = value;
  }
  private get scheduledDownloads() {
    return this.libraryWork.state.scheduledDownloads;
  }

  constructor(
    private readonly manager: DatabaseManager,
    private readonly getLibraryRoot: () => Promise<string>,
    private readonly cloudStorage: CloudStorageAccess = {
      allowedHosts: resolveCloudConfig().cloudStorageHosts
    },
    private readonly profileIo?: ProfileIoDrain
  ) {
    // Own complete repository/media work independently of Director callers.
    // cacheMedia also drains sibling transfers when localization Promise.all
    // rejects early; map/finally and slot state never cross library sessions.
    const owned = this.libraryWork.guard({
      put: this.put.bind(this),
      get: this.get.bind(this),
      cacheScheduledMedia: this.cacheScheduledMedia.bind(this),
      cancelScheduledMedia: this.cancelScheduledMedia.bind(this),
      storeRemoteMedia: this.storeRemoteMedia.bind(this),
      listProjectIds: this.listProjectIds.bind(this),
      getPlan: this.getPlan.bind(this),
      putPlan: this.putPlan.bind(this),
      storeGeneratedMedia: this.storeGeneratedMedia.bind(this),
      registerGeneratedAsset: this.registerGeneratedAsset.bind(this),
      getListSummary: this.getListSummary.bind(this),
      resolveMediaPath: this.resolveMediaPath.bind(this),
      getMediaMetrics: this.getMediaMetrics.bind(this),
      putMediaMetrics: this.putMediaMetrics.bind(this),
      resolveThumbnailMediaPath: this.resolveThumbnailMediaPath.bind(this),
      cacheMedia: this.cacheMedia.bind(this),
      writeSnapshot: this.writeSnapshot.bind(this)
    });
    this.put = owned.put;
    this.get = owned.get;
    this.cacheScheduledMedia = owned.cacheScheduledMedia;
    this.cancelScheduledMedia = owned.cancelScheduledMedia;
    this.storeRemoteMedia = owned.storeRemoteMedia;
    this.listProjectIds = owned.listProjectIds;
    this.getPlan = owned.getPlan;
    this.putPlan = owned.putPlan;
    this.storeGeneratedMedia = owned.storeGeneratedMedia;
    this.registerGeneratedAsset = owned.registerGeneratedAsset;
    this.getListSummary = owned.getListSummary;
    this.resolveMediaPath = owned.resolveMediaPath;
    this.getMediaMetrics = owned.getMediaMetrics;
    this.putMediaMetrics = owned.putMediaMetrics;
    this.resolveThumbnailMediaPath = owned.resolveThumbnailMediaPath;
    this.cacheMedia = owned.cacheMedia;
    this.writeSnapshot = owned.writeSnapshot;
  }

  private runProfileIo<T>(
    profile: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    this.libraryWork.capture();
    profile?.throwIfAborted();
    return this.profileIo?.run(profile, operation) ?? operation();
  }

  async put(
    input: LocalScriptProjectSnapshotInput,
    profile?: AbortSignal
  ): Promise<void> {
    const importProfile = input.intent === "cloud-import" ? profile : undefined;
    importProfile?.throwIfAborted();
    const projectRowAcceptsSnapshot = await this.ensureProject(
      input.projectId,
      input.project,
      importProfile
    );
    importProfile?.throwIfAborted();
    if (!projectRowAcceptsSnapshot) return;

    // Cloud mirrors persist metadata immediately and schedule media separately.
    // get() resolves already cached URLs without waiting for network transfers.
    // Other callers retain the durable, fully localized write behavior.
    if (
      !input.metadataOnly &&
      !profile?.aborted &&
      (hasRemoteMedia(input.state) || hasRemoteMedia(input.cut))
    ) {
      try {
        await this.localizeSnapshotMedia(input, profile, importProfile);
        return;
      } catch (error) {
        // Only local edits can fall back to their original URLs on retirement.
        importProfile?.throwIfAborted();
        if (!profile?.aborted || this.libraryWork.signal.aborted) throw error;
      }
    }

    const snapshotValues = this.snapshotValues(input);
    if (Object.keys(snapshotValues).length > 0) {
      await this.writeSnapshot(input.projectId, snapshotValues, importProfile);
    }
  }

  private async localizeSnapshotMedia(
    input: LocalScriptProjectSnapshotInput,
    profile: AbortSignal | undefined,
    importProfile: AbortSignal | undefined
  ): Promise<void> {
    const localizedValues: Record<string, string | null> = {};
    let previewUrl: string | null = null;
    for (const [inputKey, columnKey] of [
      ["state", "stateJson"],
      ["scriptVersions", "scriptVersionsJson"],
      ["planDetails", "planDetailsJson"],
      ["cut", "cutJson"]
    ] as const) {
      const value = input[inputKey];
      if (!value) continue;
      const localized = await this.localizeMedia(
        input.projectId,
        value,
        (media) => {
          if (!previewUrl && media.isImage) previewUrl = media.url;
        },
        profile
      );
      localizedValues[columnKey] = JSON.stringify(localized);
    }
    profile?.throwIfAborted();
    if (previewUrl) localizedValues.previewUrl = previewUrl;
    if (Object.keys(localizedValues).length > 0) {
      await this.writeSnapshot(input.projectId, localizedValues, importProfile);
    }
  }

  async get(projectId: string): Promise<LocalScriptProjectSnapshot | null> {
    if (!this.manager.isOpen()) return null;
    const [snapshot] = await this.manager
      .get()
      .select()
      .from(scriptProjectSnapshots)
      .where(eq(scriptProjectSnapshots.projectId, projectId))
      .limit(1);
    if (!snapshot) return null;
    const parsed = this.validateSnapshot(snapshot);
    // Parse once, then inspect just the URL fields. JSON.parse's reviver runs
    // for every scalar in the (often large) render/plan history on every read.
    const fields: Array<{
      owner: Record<string, unknown>;
      key: string;
      value: string;
    }> = [];
    const pending: unknown[] = Object.values(parsed);
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item)) {
        for (const child of item)
          if (child && typeof child === "object") pending.push(child);
        continue;
      }
      const owner = item as Record<string, unknown>;
      for (const [key, value] of Object.entries(owner)) {
        if (MEDIA_URL_KEYS.has(key) && typeof value === "string")
          fields.push({ owner, key, value });
        else if (value && typeof value === "object") pending.push(value);
      }
    }
    const stableUrls = new Map<string, string>();
    const stableUrl = (value: string): string => {
      let stable = stableUrls.get(value);
      if (stable === undefined) {
        stable = stableMediaUrl(value);
        stableUrls.set(value, stable);
      }
      return stable;
    };
    const referencedUrls = new Set(fields.map(({ value }) => stableUrl(value)));
    const mediaRows = await this.manager
      .get()
      .select()
      .from(scriptProjectMedia)
      .where(eq(scriptProjectMedia.projectId, projectId));
    const cachedMedia = new Map<string, string>();
    // Already-local URLs need no disk verification to be returned. Only a
    // remote URL being replaced by a cached file depends on that file existing.
    const referencedMedia = mediaRows.filter((media) =>
      referencedUrls.has(stableUrl(media.sourceUrl))
    );
    const libraryRoot = referencedMedia.length
      ? await this.getLibraryRoot()
      : "";
    await Promise.all(
      referencedMedia.map(async (media) => {
        const file = await stat(
          path.join(libraryRoot, media.relativePath)
        ).catch(() => null);
        if (file?.isFile() && file.size > 0 && media.sourceUrl)
          cachedMedia.set(
            stableUrl(media.sourceUrl),
            `mago-media://script-project/${media.id}`
          );
      })
    );
    const thumbnails = new Map<string, string>();
    for (const { owner, key, value } of fields) {
      const localized = cachedMedia.get(stableUrl(value)) ?? value;
      if (key === "thumbnail_url") {
        let thumbnail = thumbnails.get(localized);
        if (thumbnail === undefined) {
          thumbnail = optimizedThumbnailUrl(localized);
          thumbnails.set(localized, thumbnail);
        }
        owner[key] = thumbnail;
      } else owner[key] = localized;
    }
    return parsed;
  }

  /** Downloads one HTTPS media file into the project, as snapshots do. */
  async cacheScheduledMedia(
    projectId: string,
    sourceUrl: string,
    profile?: AbortSignal
  ): Promise<void> {
    profile?.throwIfAborted();
    const key = JSON.stringify([projectId, stableMediaUrl(sourceUrl)]);
    const controller = new AbortController();
    const controllers =
      this.scheduledDownloads.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.scheduledDownloads.set(key, controllers);
    try {
      const media = await this.cacheMedia(
        projectId,
        sourceUrl,
        controller.signal,
        profile
      );
      profile?.throwIfAborted();
      if (media.isImage) {
        await this.runProfileIo(profile, () =>
          this.manager
            .get()
            .update(scriptProjectSnapshots)
            .set({ previewUrl: media.url })
            .where(
              and(
                eq(scriptProjectSnapshots.projectId, projectId),
                isNull(scriptProjectSnapshots.previewUrl)
              )
            )
            .run()
        );
        profile?.throwIfAborted();
      }
    } finally {
      controllers.delete(controller);
      if (
        controllers.size === 0 &&
        this.scheduledDownloads.get(key) === controllers
      )
        this.scheduledDownloads.delete(key);
    }
  }

  cancelScheduledMedia(projectId: string, sourceUrl: string): void {
    for (const controller of this.scheduledDownloads.get(
      JSON.stringify([projectId, stableMediaUrl(sourceUrl)])
    ) ?? [])
      controller.abort();
  }

  /** Downloads one HTTPS media file into the project, as snapshots do. */
  async storeRemoteMedia(
    projectId: string,
    sourceUrl: string,
    profile?: AbortSignal
  ): Promise<{ id: string; url: string; isImage: boolean }> {
    const media = await this.cacheMedia(
      projectId,
      sourceUrl,
      undefined,
      profile
    );
    profile?.throwIfAborted();
    return { ...media, id: media.url.replace(/^.*\//, "") };
  }

  /** Every project that has a snapshot, cloud mirrors included. */
  async listProjectIds(): Promise<string[]> {
    if (!this.manager.isOpen()) return [];
    const rows = await this.manager
      .get()
      .select({ projectId: scriptProjectSnapshots.projectId })
      .from(scriptProjectSnapshots);
    return rows.map((row) => row.projectId);
  }

  async getPlan(planId: string): Promise<Record<string, unknown> | null> {
    if (!this.manager.isOpen()) return null;
    // Filter in SQLite so progress polling transfers/parses only the requested
    // plan. json_each keys are bound values, including IDs containing quotes.
    // Preserve the old reader's tolerance for absent or malformed plan maps.
    const planMap = sql`CASE WHEN json_valid(${scriptProjectSnapshots.planDetailsJson})
      THEN CASE WHEN json_type(${scriptProjectSnapshots.planDetailsJson}) = 'object'
        THEN ${scriptProjectSnapshots.planDetailsJson} ELSE '{}' END
      ELSE '{}' END`;
    const [row] = await this.manager
      .get()
      .select({ plan: sql<string>`entry.value` })
      .from(sql`${scriptProjectSnapshots}, json_each(${planMap}) AS entry`)
      .where(sql`entry.key = ${planId} AND entry.type = 'object'`)
      .limit(1);
    return row ? parseJson(row.plan) : null;
  }

  async putPlan(
    projectId: string,
    planId: string,
    plan: Record<string, unknown>,
    profile?: AbortSignal
  ): Promise<void> {
    if (profile) {
      // A Cloud submission checkpoint only updates an existing snapshot.
      // Unlike put(), this path has no awaits between authority and the write.
      profile.throwIfAborted();
      const database = this.manager.get();
      const [snapshot] = await database
        .select()
        .from(scriptProjectSnapshots)
        .where(eq(scriptProjectSnapshots.projectId, projectId))
        .limit(1);
      if (!snapshot) throw new Error("Local script project snapshot not found");
      const current = this.validateSnapshot(snapshot);
      const planDetailsJson = JSON.stringify({
        ...current.planDetails,
        [planId]: plan
      });
      this.libraryWork.capture();
      profile.throwIfAborted();
      await database
        .update(scriptProjectSnapshots)
        .set({ planDetailsJson, updatedAt: new Date() })
        .where(eq(scriptProjectSnapshots.projectId, projectId))
        .run();
      return;
    }

    const current = await this.get(projectId);
    await this.put({
      projectId,
      planDetails: { ...(current?.planDetails ?? {}), [planId]: plan }
    });
  }

  async storeGeneratedMedia(
    projectId: string,
    bytes: Buffer,
    extension: "png" | "mp4",
    useAsPreview = false
  ): Promise<{ id: string; url: string; path: string }> {
    const id = createHash("sha256")
      .update(projectId)
      .update(bytes)
      .digest("hex");
    const projectDirectory = createHash("sha256")
      .update(projectId)
      .digest("hex")
      .slice(0, PROJECT_DIRECTORY_HASH_LENGTH);
    const relativePath = path.join(
      "script-projects",
      projectDirectory,
      `${id}.${extension}`
    );
    const libraryRoot = await this.getLibraryRoot();
    const absolutePath = path.join(libraryRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await atomicWriteFile(absolutePath, bytes);
    const now = new Date();
    await this.manager
      .get()
      .insert(scriptProjectMedia)
      .values({
        id,
        projectId,
        sourceUrl: `local-generated:${id}`,
        relativePath,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: scriptProjectMedia.id,
        set: { relativePath, updatedAt: now }
      });
    const url = `mago-media://script-project/${id}`;
    if (useAsPreview) {
      await this.writeSnapshot(projectId, { previewUrl: url });
    }
    return { id, url, path: absolutePath };
  }

  async registerGeneratedAsset(
    projectId: string,
    id: string,
    useAsPreview: boolean
  ) {
    const database = this.manager.get();
    const [asset] = await database
      .select({
        relativePath: assets.relativeSourcePath,
        width: assets.width,
        height: assets.height,
        duration: assets.duration,
        fps: assets.fps
      })
      .from(projectAssets)
      .innerJoin(assets, eq(projectAssets.assetId, assets.id))
      .where(
        and(
          eq(projectAssets.projectId, projectId),
          eq(assets.id, id),
          eq(assets.origin, "generated"),
          eq(assets.status, "available"),
          eq(assets.active, true)
        )
      );
    if (!asset?.relativePath)
      throw new Error("Generated library asset is unavailable");
    await database
      .insert(scriptProjectMedia)
      .values({
        id,
        projectId,
        sourceUrl: `local-generated:${id}`,
        relativePath: asset.relativePath
      })
      .onConflictDoNothing({ target: scriptProjectMedia.id });
    const url = `mago-media://script-project/${id}`;
    if (useAsPreview) await this.writeSnapshot(projectId, { previewUrl: url });
    return {
      id,
      url,
      width: asset.width,
      height: asset.height,
      duration: asset.duration,
      fps: asset.fps
    };
  }

  async getListSummary(projectId: string): Promise<{
    previewUrl: string | null;
    shotCount: number;
    renderCount: number;
  } | null> {
    if (!this.manager.isOpen()) return null;
    const [snapshot] = await this.manager
      .get()
      .select()
      .from(scriptProjectSnapshots)
      .where(eq(scriptProjectSnapshots.projectId, projectId))
      .limit(1);
    if (!snapshot) return null;
    const state = parseJson(snapshot.stateJson);
    const cut = parseJson(snapshot.cutJson);
    return {
      previewUrl: snapshot.previewUrl,
      shotCount: Array.isArray(state?.shots) ? state.shots.length : 0,
      renderCount: Array.isArray(cut?.shots)
        ? cut.shots.filter(
            (shot) => objectValue(shot)?.url || objectValue(shot)?.asset_id
          ).length
        : 0
    };
  }

  async resolveMediaPath(
    mediaId: string,
    projectId?: string
  ): Promise<string | null> {
    if (!this.manager.isOpen()) return null;
    const [media] = await this.manager
      .get()
      .select()
      .from(scriptProjectMedia)
      .where(
        and(
          eq(scriptProjectMedia.id, mediaId),
          projectId === undefined
            ? undefined
            : eq(scriptProjectMedia.projectId, projectId)
        )
      )
      .limit(1);
    if (!media) return null;
    const libraryRoot = await this.getLibraryRoot();
    const resolvedRoot = path.resolve(libraryRoot);
    const resolvedPath = path.resolve(resolvedRoot, media.relativePath);
    if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    return resolvedPath;
  }

  /** Sidecars avoid overwriting a cut snapshot while another shot finishes. */
  async getMediaMetrics(
    mediaId: string
  ): Promise<Record<string, unknown> | null> {
    const mediaPath = await this.resolveMediaPath(mediaId);
    if (!mediaPath) throw new Error("Local video is unavailable");
    try {
      return parseJson(await readFile(`${mediaPath}.metrics.json`, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async putMediaMetrics(
    mediaId: string,
    metrics: Record<string, unknown>
  ): Promise<void> {
    const mediaPath = await this.resolveMediaPath(mediaId);
    if (!mediaPath) throw new Error("Local video is unavailable");
    const target = `${mediaPath}.metrics.json`;
    await atomicWriteFile(target, JSON.stringify(metrics), "utf8");
  }

  async resolveThumbnailMediaPath(
    mediaId: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    signal = signal
      ? AbortSignal.any([signal, this.libraryWork.signal])
      : this.libraryWork.signal;
    signal.throwIfAborted();
    const active = this.thumbnailJobs.get(mediaId);
    if (active) return active;
    const job = this.createThumbnail(mediaId, signal).finally(() => {
      if (this.thumbnailJobs.get(mediaId) === job) {
        this.thumbnailJobs.delete(mediaId);
      }
    });
    this.thumbnailJobs.set(mediaId, job);
    return job;
  }

  private async createThumbnail(
    mediaId: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const sourcePath = await this.resolveMediaPath(mediaId);
    signal?.throwIfAborted();
    if (!sourcePath) return null;
    const thumbnailPath = `${sourcePath}.thumbnail.jpg`;
    const temporaryPath = `${thumbnailPath}.partial`;
    try {
      const existing = await stat(thumbnailPath);
      if (existing.isFile() && existing.size > 0) return thumbnailPath;
    } catch {
      // Existing projects create their thumbnail on the first visible request.
    }
    signal?.throwIfAborted();
    await this.acquireThumbnailSlot();
    try {
      signal?.throwIfAborted();
      await unlink(temporaryPath).catch(() => {});
      signal?.throwIfAborted();
      await createImageThumbnail(sourcePath, temporaryPath, signal);
      signal?.throwIfAborted();
      await publishFile(temporaryPath, thumbnailPath);
      return thumbnailPath;
    } catch {
      await unlink(temporaryPath).catch(() => {});
      signal?.throwIfAborted();
      // Keep the card usable if this particular format cannot be decoded.
      return sourcePath;
    } finally {
      const next = this.pendingThumbnailStarts.shift();
      if (next) next();
      else this.activeThumbnailBuilds -= 1;
    }
  }

  private async acquireThumbnailSlot(): Promise<void> {
    if (this.activeThumbnailBuilds < MAX_CONCURRENT_THUMBNAIL_BUILDS) {
      this.activeThumbnailBuilds += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.pendingThumbnailStarts.push(resolve);
    });
  }

  private snapshotValues(
    input: LocalScriptProjectSnapshotInput
  ): Record<string, string | null> {
    return {
      ...(input.state ? { stateJson: JSON.stringify(input.state) } : {}),
      ...(input.scriptVersions
        ? { scriptVersionsJson: JSON.stringify(input.scriptVersions) }
        : {}),
      ...(input.planDetails
        ? { planDetailsJson: JSON.stringify(input.planDetails) }
        : {}),
      ...(input.cut ? { cutJson: JSON.stringify(input.cut) } : {})
    };
  }

  private async ensureProject(
    projectId: string,
    project: Record<string, unknown> | undefined,
    profile?: AbortSignal
  ): Promise<boolean> {
    const now = new Date();
    const database = this.manager.get();
    const [existing] = await database
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    profile?.throwIfAborted();
    const existingSettings = parseJson(existing?.settingsJson ?? null) ?? {};
    const existingRowIsLocalProject =
      !!existing && existingSettings.origin !== "cloud";
    const isCloudWriteOverLocalProject = !!project && existingRowIsLocalProject;
    if (isCloudWriteOverLocalProject) return false;
    const projectSettings = objectValue(project?.settings) ?? {};
    const settings = {
      ...existingSettings,
      ...projectSettings,
      type: "script_to_shots",
      origin: "cloud"
    };
    const createdAt = dateValue(
      project?.created_at,
      existing?.createdAt ?? now
    );
    const values = {
      id: projectId,
      name:
        typeof project?.name === "string" && project.name.trim()
          ? project.name
          : "Script project",
      description:
        typeof project?.description === "string" ? project.description : "",
      active: typeof project?.active === "boolean" ? project.active : true,
      settingsJson: JSON.stringify(settings),
      createdAt,
      updatedAt: createdAt
    };
    await this.runProfileIo(profile, () => {
      const insert = database.insert(projects).values(values);
      if (!project) return insert.onConflictDoNothing().run();
      return insert
        .onConflictDoUpdate({
          target: projects.id,
          set: {
            name: values.name,
            description: values.description,
            active: values.active,
            settingsJson: values.settingsJson,
            createdAt: values.createdAt,
            updatedAt: values.updatedAt
          }
        })
        .run();
    });
    return true;
  }

  private validateSnapshot(
    snapshot: typeof scriptProjectSnapshots.$inferSelect
  ): LocalScriptProjectSnapshot {
    const parsed: Record<
      keyof LocalScriptProjectSnapshot,
      Record<string, unknown> | null
    > = {
      state: null,
      scriptVersions: null,
      planDetails: null,
      cut: null
    };
    for (const [key, field] of [
      ["stateJson", "state"],
      ["scriptVersionsJson", "scriptVersions"],
      ["planDetailsJson", "planDetails"],
      ["cutJson", "cut"]
    ] as const) {
      if (snapshot[key] !== null)
        parsed[field] = storedObject(snapshot[key], {
          id: `project:${snapshot.projectId}:${key}`,
          kind: "project",
          projectId: snapshot.projectId,
          message: `Could not read ${key.replace("Json", "")} for project ${snapshot.projectId}. Original data has been kept; recover a database backup to restore it.`
        });
    }
    return {
      ...parsed,
      planDetails:
        parsed.planDetails as LocalScriptProjectSnapshot["planDetails"]
    };
  }

  private async writeSnapshot(
    projectId: string,
    values: Record<string, string | null>,
    profile?: AbortSignal
  ): Promise<void> {
    const [existing] = await this.manager
      .get()
      .select()
      .from(scriptProjectSnapshots)
      .where(eq(scriptProjectSnapshots.projectId, projectId))
      .limit(1);
    if (existing) this.validateSnapshot(existing);
    const now = new Date();
    await this.runProfileIo(profile, () =>
      this.manager
        .get()
        .insert(scriptProjectSnapshots)
        .values({ projectId, ...values, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: scriptProjectSnapshots.projectId,
          set: { ...values, updatedAt: now }
        })
        .run()
    );
    profile?.throwIfAborted();
  }

  private async localizeMedia(
    projectId: string,
    value: unknown,
    onMedia: (media: LocalizedMedia) => void,
    profile?: AbortSignal
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((member) =>
          this.localizeMedia(projectId, member, onMedia, profile)
        )
      );
    }
    if (!value || typeof value !== "object") return value;

    const entries = await Promise.all(
      Object.entries(value).map(async ([key, member]) => {
        if (
          MEDIA_URL_KEYS.has(key) &&
          typeof member === "string" &&
          member.startsWith("https://")
        ) {
          try {
            const media = await this.cacheMedia(
              projectId,
              member,
              undefined,
              profile
            );
            this.libraryWork.capture();
            profile?.throwIfAborted();
            onMedia(media);
            return [key, media.url] as const;
          } catch (error) {
            this.libraryWork.capture();
            profile?.throwIfAborted();
            console.warn("Failed to cache script-project media", error);
            return [key, member] as const;
          }
        }
        return [
          key,
          await this.localizeMedia(projectId, member, onMedia, profile)
        ] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  private cacheMedia(
    projectId: string,
    sourceUrl: string,
    cancelBeforeTransferStarts?: AbortSignal,
    profile?: AbortSignal
  ): Promise<LocalizedMedia> {
    const parsedUrl = parseAllowedCloudStorageUrl(
      sourceUrl,
      this.cloudStorage.allowedHosts
    );
    // Signed CDN query strings rotate. Cache by the immutable asset path so a
    // refreshed signature does not download another copy of the same media.
    const stableSource = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const mediaId = createHash("sha256")
      .update(`${projectId}\0${stableSource}`)
      .digest("hex");
    profile?.throwIfAborted();
    const downloads = profile
      ? this.getProfileDownloads(profile)
      : this.downloads;
    const existingDownload = downloads.get(mediaId);
    if (existingDownload) return existingDownload;
    const download = this.withDownloadSlot(() =>
      this.performMediaDownload(
        projectId,
        mediaId,
        sourceUrl,
        cancelBeforeTransferStarts,
        profile
      )
    );
    downloads.set(mediaId, download);
    void download.then(
      () => {
        if (downloads.get(mediaId) === download) downloads.delete(mediaId);
      },
      () => {
        if (downloads.get(mediaId) === download) downloads.delete(mediaId);
      }
    );
    return download;
  }

  private async withDownloadSlot<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireDownloadSlot();
    // Queued old work may release its slot, but cannot start a new transfer.
    try {
      this.libraryWork.capture();
      return await operation();
    } finally {
      const next = this.pendingDownloadStarts.shift();
      if (next) next();
      else this.activeMediaDownloads -= 1;
    }
  }

  private async acquireDownloadSlot(): Promise<void> {
    if (this.activeMediaDownloads < MAX_CONCURRENT_MEDIA_DOWNLOADS) {
      this.activeMediaDownloads += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.pendingDownloadStarts.push(resolve);
    });
  }

  private async performMediaDownload(
    projectId: string,
    mediaId: string,
    sourceUrl: string,
    cancelBeforeTransferStarts?: AbortSignal,
    profile?: AbortSignal
  ): Promise<LocalizedMedia> {
    const library = this.libraryWork.capture();
    const signal = profile ? AbortSignal.any([library, profile]) : library;
    signal.throwIfAborted();
    const database = this.manager.get();
    const [cached] = await database
      .select()
      .from(scriptProjectMedia)
      .where(eq(scriptProjectMedia.id, mediaId))
      .limit(1);
    const libraryRoot = await this.getLibraryRoot();
    signal.throwIfAborted();
    if (cached) {
      const existingPath = path.join(libraryRoot, cached.relativePath);
      try {
        const existingFile = await stat(existingPath);
        if (existingFile.isFile() && existingFile.size > 0) {
          signal.throwIfAborted();
          return {
            url: `mago-media://script-project/${cached.id}`,
            isImage: /\.(?:jpe?g|png|webp)$/i.test(existingPath)
          };
        }
      } catch {
        // The row survived but the file did not; download it again below.
      }
    }

    const url = new URL(sourceUrl);
    cancelBeforeTransferStarts?.throwIfAborted();
    signal.throwIfAborted();
    const transfer = () =>
      withCloudStorageDownload(
        {
          ...this.cloudStorage,
          url: sourceUrl,
          signal
        },
        async (download) => {
          const contentType = download.headers.get("content-type") ?? undefined;
          const extension = mediaExtension(contentType, url);
          const projectDirectory = createHash("sha256")
            .update(projectId)
            .digest("hex")
            .slice(0, PROJECT_DIRECTORY_HASH_LENGTH);
          const relativePath = path.join(
            "script-projects",
            projectDirectory,
            `${mediaId}.${extension}`
          );
          const destination = path.join(libraryRoot, relativePath);
          const temporary = `${destination}.${randomUUID()}.partial`;
          await mkdir(path.dirname(destination), { recursive: true });
          try {
            signal.throwIfAborted();
            await pipeline(download.body, createWriteStream(temporary), {
              signal
            });
            signal.throwIfAborted();
            if ((await stat(temporary)).size === 0) {
              throw new Error("Downloaded script-project media was empty");
            }
            signal.throwIfAborted();
            await publishFile(temporary, destination, signal);
            signal.throwIfAborted();
          } catch (error) {
            await unlink(temporary).catch(() => {});
            throw error;
          }

          signal.throwIfAborted();
          const now = new Date();
          await database
            .insert(scriptProjectMedia)
            .values({
              id: mediaId,
              projectId,
              sourceUrl,
              relativePath,
              createdAt: now,
              updatedAt: now
            })
            .onConflictDoUpdate({
              target: scriptProjectMedia.id,
              set: { sourceUrl, relativePath, updatedAt: now }
            })
            .run();
          return {
            url: `mago-media://script-project/${mediaId}`,
            isImage: /^(?:jpg|jpeg|png|webp)$/.test(extension)
          };
        }
      );
    return this.runProfileIo(profile, transfer);
  }
}
