import { ipcMain, type WebContents } from "electron";

import {
  IPC_CHANNELS,
  type LocalImageImport,
  type LocalShotCreateInput,
  type LocalShotUpdateInput,
  type LocalTrackCreateInput,
  type LocalTrackUpdateInput,
  type LocalVideoImport
} from "../../shared/contracts";
import { requireCloudAccount } from "../cloud/requireCloudAccount";
import { CloudProjectMirrorRepository } from "../database/cloudProjectMirrorRepository";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { LibrarySettings } from "../librarySettings";
import { LibraryWorkSession } from "../libraryWorkSession";
import type { ProfileIoDrain } from "../providers/profileIoDrain";

import { requireTrustedSender } from "./trustedSender";

const MAX_IMPORT_VIDEOS = 100;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be an object");
  }
  return value as Record<string, unknown>;
};

const NO_STAR_RATING = 0;
const ONE_STAR_RATING = 10;
const TWO_STAR_RATING = 20;
const THREE_STAR_RATING = 30;
const STAR_RATINGS_STORED_IN_TENS = new Set([
  NO_STAR_RATING,
  ONE_STAR_RATING,
  TWO_STAR_RATING,
  THREE_STAR_RATING
]);

const optionalRating = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !STAR_RATINGS_STORED_IN_TENS.has(value)) {
    throw new Error("rating must be 0, 10, 20, or 30");
  }
  return value;
};

const requireRate = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("rate must be a non-negative integer");
  }
  return value;
};

const validateVideo = (value: unknown): LocalVideoImport => {
  const video = requireRecord(value);
  const number = (key: string): number => {
    const candidate = video[key];
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < 0
    ) {
      throw new Error(`${key} must be a non-negative finite number`);
    }
    return candidate;
  };
  return {
    sourcePath: requireString(video.sourcePath, "sourcePath"),
    name: requireString(video.name, "name"),
    durationSeconds: number("durationSeconds"),
    fps: number("fps"),
    width: number("width"),
    height: number("height"),
    frameCount: number("frameCount"),
    thumbnailDataUrl: requireString(video.thumbnailDataUrl, "thumbnailDataUrl"),
    trimStartSeconds:
      video.trimStartSeconds === undefined
        ? undefined
        : number("trimStartSeconds"),
    trimEndSeconds:
      video.trimEndSeconds === undefined ? undefined : number("trimEndSeconds")
  };
};

export const registerProjectHandlers = (
  repository: ProjectRepository,
  cloudProjects: CloudProjectMirrorRepository,
  databaseManager: DatabaseManager,
  settings: LibrarySettings,
  /** Told about every imported image, e.g. to caption it. Must not throw. */
  onImageImported?: (assetId: string) => void,
  importWork: Pick<
    LibraryWorkSession<unknown>,
    "run" | "boundary" | "capture"
  > = new LibraryWorkSession(() => undefined),
  mediaWork = importWork,
  captureAccountProfile?: (sender: WebContents) => AbortSignal,
  assertLibraryAvailable?: () => void,
  profileIo?: Pick<ProfileIoDrain, "run">
): void => {
  const cloudWork = cloudProjects.libraryWork;
  const handleCloud = (
    channel: string,
    handler: Parameters<typeof ipcMain.handle>[1]
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      requireTrustedSender(event);
      return cloudWork.run(async () => handler(event, ...args));
    });
  };
  const ensureCloudDatabase = async (profile?: AbortSignal): Promise<void> => {
    cloudWork.capture();
    profile?.throwIfAborted();
    if (databaseManager.isOpen()) return;
    const root = await cloudWork.boundary(() => settings.getLibraryRoot());
    profile?.throwIfAborted();
    if (!root) throw new Error("Choose a Mago library folder first");
    await cloudWork.boundary(() => {
      profile?.throwIfAborted();
      const open = () => databaseManager.open(root);
      return profileIo?.run(profile, open) ?? open();
    });
  };

  // Own lazy DB admission and each complete repository call, including reads
  // that migrate a setting and therefore issue follow-up writes.
  const handleLocal = (
    channel: string,
    handler: (...args: unknown[]) => Promise<unknown>
  ) =>
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      requireTrustedSender(event);
      assertLibraryAvailable?.();
      return importWork.run(() => handler(...args));
    });
  const local = <T>(operation: () => Promise<T>) =>
    importWork.boundary(operation);

  const ensureDatabase = async (required = false): Promise<boolean> => {
    if (databaseManager.isOpen()) return true;
    const libraryRoot = await importWork.boundary(() =>
      settings.getLibraryRoot()
    );
    if (!libraryRoot) {
      if (required) throw new Error("Choose a Mago library folder first");
      return false;
    }
    await importWork.boundary(() => databaseManager.open(libraryRoot));
    return true;
  };

  handleLocal(IPC_CHANNELS.assetsGet, async (assetId: unknown) => {
    if (!(await ensureDatabase())) return null;
    return local(() => repository.getAsset(requireString(assetId, "assetId")));
  });
  ipcMain.handle(
    IPC_CHANNELS.assetsImportImage,
    async (event, value: unknown) => {
      requireTrustedSender(event);
      return importWork.run(async () => {
        // Own the request before the first asynchronous root lookup. An issued
        // import drains in full, but a stale root result cannot open another DB.
        if (!databaseManager.isOpen()) {
          const root = await importWork.boundary(() =>
            settings.getLibraryRoot()
          );
          if (!root) throw new Error("Choose a Mago library folder first");
          await importWork.boundary(() => databaseManager.open(root));
        }
        const input = requireRecord(value);
        const number = (name: string) => {
          const candidate = input[name];
          if (
            typeof candidate !== "number" ||
            !Number.isFinite(candidate) ||
            candidate <= 0
          ) {
            throw new Error(`${name} must be a positive number`);
          }
          return candidate;
        };
        const common = {
          projectId: requireString(input.projectId, "projectId"),
          name: requireString(input.name, "name"),
          width: number("width"),
          height: number("height")
        };
        const requireThumbnail = () =>
          requireString(input.thumbnailDataUrl, "thumbnailDataUrl");
        const prepared = input.dataUrl !== undefined;
        if (prepared && input.sourcePath !== undefined)
          throw new Error("Choose either a file or prepared image bytes");
        const image: LocalImageImport = prepared
          ? {
              ...common,
              dataUrl: requireString(input.dataUrl, "dataUrl"),
              thumbnailDataUrl:
                input.thumbnailDataUrl === undefined
                  ? undefined
                  : requireThumbnail()
            }
          : {
              ...common,
              sourcePath: requireString(input.sourcePath, "sourcePath"),
              thumbnailDataUrl: requireThumbnail()
            };
        const asset = await importWork.boundary(() =>
          repository.importImage(image)
        );
        importWork.capture();
        if (!prepared) onImageImported?.(asset.id);
        return asset;
      });
    }
  );

  handleLocal(IPC_CHANNELS.projectsList, async () => {
    if (!(await ensureDatabase())) return [];
    return local(() => repository.list());
  });
  handleLocal(IPC_CHANNELS.projectsListAll, async () => {
    if (!(await ensureDatabase())) return [];
    return local(() => repository.listAll());
  });
  handleLocal(IPC_CHANNELS.projectsGet, async (projectId: unknown) => {
    if (!(await ensureDatabase())) return null;
    return local(() => repository.get(requireString(projectId, "projectId")));
  });
  handleCloud(
    IPC_CHANNELS.projectsMirrorCloud,
    async (event, value: unknown) => {
      requireTrustedSender(event);
      const profile = captureAccountProfile?.(event.sender);
      await requireCloudAccount(settings, profile);
      await ensureCloudDatabase(profile);
      profile?.throwIfAborted();
      const input = requireRecord(value);
      const project = requireRecord(input.project);
      return cloudProjects.put(
        {
          project,
          includeContent: input.includeContent === true
        },
        profile
      );
    }
  );
  handleCloud(
    IPC_CHANNELS.projectsCancelCloudMirror,
    async (event, projectId: unknown) => {
      requireTrustedSender(event);
      cloudProjects.cancel(requireString(projectId, "projectId"));
    }
  );
  handleCloud(
    IPC_CHANNELS.projectsCacheCloudAsset,
    async (event, value: unknown) => {
      requireTrustedSender(event);
      const profile = captureAccountProfile?.(event.sender);
      await requireCloudAccount(settings, profile);
      await ensureCloudDatabase(profile);
      profile?.throwIfAborted();
      const input = requireRecord(value);
      return cloudProjects.cacheAsset(
        {
          projectId: requireString(input.projectId, "projectId"),
          assetId: requireString(input.assetId, "assetId"),
          isImage: input.isImage === true,
          urls: {
            sourceUrl:
              typeof input.sourceUrl === "string" ? input.sourceUrl : undefined,
            thumbnailUrl:
              typeof input.thumbnailUrl === "string"
                ? input.thumbnailUrl
                : undefined
          }
        },
        profile
      );
    }
  );
  handleCloud(
    IPC_CHANNELS.projectsCancelCloudAsset,
    async (event, projectId: unknown, assetId: unknown) => {
      requireTrustedSender(event);
      cloudProjects.cancelAsset(
        requireString(projectId, "projectId"),
        requireString(assetId, "assetId")
      );
    }
  );
  handleLocal(IPC_CHANNELS.projectsCreate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    return local(() =>
      repository.create({
        name: requireString(input.name, "name"),
        description:
          typeof input.description === "string" ? input.description : "",
        settings: requireRecord(input.settings)
      })
    );
  });
  handleLocal(IPC_CHANNELS.projectsUpdate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    return local(() =>
      repository.update({
        projectId: requireString(input.projectId, "projectId"),
        name: requireString(input.name, "name"),
        description:
          typeof input.description === "string" ? input.description : "",
        settings: requireRecord(input.settings)
      })
    );
  });
  handleLocal(IPC_CHANNELS.projectsDelete, async (projectId: unknown) => {
    await ensureDatabase(true);
    await local(() => repository.delete(requireString(projectId, "projectId")));
  });
  ipcMain.handle(
    IPC_CHANNELS.projectsImportVideos,
    async (event, value: unknown) => {
      requireTrustedSender(event);
      return mediaWork.run(async () => {
        if (!databaseManager.isOpen()) {
          const root = await mediaWork.boundary(() =>
            settings.getLibraryRoot()
          );
          if (!root) throw new Error("Choose a Mago library folder first");
          await mediaWork.boundary(() => databaseManager.open(root));
        }
        const input = requireRecord(value);
        if (!Array.isArray(input.videos) || input.videos.length === 0) {
          throw new Error("At least one video is required");
        }
        if (input.videos.length > MAX_IMPORT_VIDEOS)
          throw new Error("Too many videos selected");
        return mediaWork.boundary(() =>
          repository.importVideos(
            requireString(input.projectId, "projectId"),
            (input.videos as unknown[]).map(validateVideo)
          )
        );
      });
    }
  );
  handleLocal(IPC_CHANNELS.tracksCreate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    const parentTrackOrder = input.parentTrackOrder;
    if (
      typeof parentTrackOrder !== "number" ||
      !Number.isInteger(parentTrackOrder)
    ) {
      throw new Error("parentTrackOrder must be an integer");
    }
    return local(() =>
      repository.createTrack({
        shotId: requireString(input.shotId, "shotId"),
        name: requireString(input.name, "name"),
        type: requireString(input.type, "type"),
        data: requireRecord(input.data),
        parentTrackOrder
      } satisfies LocalTrackCreateInput)
    );
  });
  handleLocal(IPC_CHANNELS.tracksUpdate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    return local(() =>
      repository.updateTrack({
        trackId: requireString(input.trackId, "trackId"),
        name: requireString(input.name, "name"),
        data: requireRecord(input.data),
        rating: optionalRating(input.rating)
      } satisfies LocalTrackUpdateInput)
    );
  });
  handleLocal(IPC_CHANNELS.tracksDelete, async (trackId: unknown) => {
    await ensureDatabase(true);
    await local(() =>
      repository.deleteTrack(requireString(trackId, "trackId"))
    );
  });
  handleLocal(IPC_CHANNELS.shotsCreate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    return local(() =>
      repository.createShot({
        projectId: requireString(input.projectId, "projectId"),
        name: requireString(input.name, "name")
      } satisfies LocalShotCreateInput)
    );
  });
  handleLocal(IPC_CHANNELS.shotsUpdate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    return local(() =>
      repository.updateShot({
        shotId: requireString(input.shotId, "shotId"),
        name: requireString(input.name, "name"),
        settings: requireRecord(input.settings)
      } satisfies LocalShotUpdateInput)
    );
  });
  handleLocal(IPC_CHANNELS.shotsDelete, async (shotId: unknown) => {
    await ensureDatabase(true);
    await local(() => repository.deleteShot(requireString(shotId, "shotId")));
  });
  handleLocal(IPC_CHANNELS.assetsUpdate, async (value: unknown) => {
    await ensureDatabase(true);
    const input = requireRecord(value);
    return local(() =>
      repository.updateAsset({
        assetId: requireString(input.assetId, "assetId"),
        rate: requireRate(input.rate)
      })
    );
  });
  handleLocal(IPC_CHANNELS.projectsListShots, async (projectId: unknown) => {
    if (!(await ensureDatabase())) return [];
    return local(() =>
      repository.listShots(requireString(projectId, "projectId"))
    );
  });
  handleLocal(IPC_CHANNELS.projectsStats, async (projectId: unknown) => {
    await ensureDatabase(true);
    return local(() =>
      repository.projectStats(requireString(projectId, "projectId"))
    );
  });
};
