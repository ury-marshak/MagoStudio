import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { resolveCloudConfig } from "../../shared/cloudConfig";
import { IPC_CHANNELS } from "../../shared/contracts";
import {
  CloudLinkKind,
  CloudLinkRepository
} from "../cloud/cloudLinkRepository";
import { CloudRenderJobRepository } from "../cloud/cloudRenderJobRepository";
import {
  CloudRenderSubmitService,
  IMAGE_OUTPUT_EXTENSION,
  isImageJobRequest
} from "../cloud/cloudRenderSubmitService";
import { downloadRenderOutput } from "../cloud/downloadRenderOutput";
import {
  contentTypeForExtension,
  readLocalAssetInfo,
  resolveScriptProjectMediaPath
} from "../cloud/localAssetInfo";
import { requireCloudAccount } from "../cloud/requireCloudAccount";
import { toCloudImageOutputExtension } from "../cloud/toCloudImageOutputExtension";
import { UploadService } from "../cloud/uploadService";
import { DatabaseManager } from "../database/databaseManager";
import { ProjectRepository } from "../database/projectRepository";
import { LibrarySettings } from "../librarySettings";
import type { LibraryWorkSession } from "../libraryWorkSession";

import { requireTrustedSender } from "./trustedSender";

/**
 * The main-process half of cloud mirroring.
 *
 * The renderer runs the ensure-chain because that is where the authenticated API
 * client lives, but it never touches the filesystem: it asks for an asset to be
 * prepared by id, and hands back only a presigned URL. Native paths never cross
 * the bridge.
 */

const KINDS: CloudLinkKind[] = ["project", "timeline", "asset"];

const requireKind = (value: unknown): CloudLinkKind => {
  if (typeof value !== "string" || !KINDS.includes(value as CloudLinkKind)) {
    throw new Error("Unknown cloud link kind");
  }
  return value as CloudLinkKind;
};

const requireId = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

/** IPC's structured clone delivers an ArrayBuffer, or a typed array if the
 * renderer sent one; both are accepted, nothing else is. */
const requireBytes = (value: unknown): Buffer => {
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return Buffer.from(value as ArrayBuffer);
  }
  throw new Error("bytes must be an ArrayBuffer");
};

const optionalSeconds = (value: unknown, name: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
};

export const registerCloudHandlers = (options: {
  links: CloudLinkRepository;
  uploads: UploadService;
  repository: ProjectRepository;
  renderJobs: CloudRenderJobRepository;
  renderSubmits: CloudRenderSubmitService;
  databaseManager: DatabaseManager;
  getLibraryRoot: () => Promise<string | null>;
  settings: LibrarySettings;
  captureImageDescriptionSession?: () => AbortSignal;
}): void => {
  const { links, uploads, repository, renderJobs } = options;
  const renderWork = options.renderSubmits.libraryWork;
  const renderSubmits = renderWork.guard(options.renderSubmits, false);
  const handleRender = (
    channel: string,
    handler: Parameters<typeof ipcMain.handle>[1]
  ) =>
    ipcMain.handle(
      channel,
      renderWork.bind(async (...args) => handler(...args))
    );
  const handleLocal = <State>(
    work: LibraryWorkSession<State>,
    channel: string,
    handler: Parameters<typeof ipcMain.handle>[1]
  ) =>
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      requireTrustedSender(event);
      return work.run(async () => handler(event, ...args));
    });

  handleLocal(
    links.libraryWork,
    IPC_CHANNELS.cloudLinkGet,
    async (event, kind, localId) => {
      requireTrustedSender(event);
      return links.get(requireKind(kind), requireId(localId, "localId"));
    }
  );

  handleLocal(
    links.libraryWork,
    IPC_CHANNELS.cloudLinkPut,
    async (event, input) => {
      requireTrustedSender(event);
      const value = (input ?? {}) as Record<string, unknown>;
      await links.put({
        kind: requireKind(value.kind),
        localId: requireId(value.localId, "localId"),
        cloudId: requireId(value.cloudId, "cloudId"),
        data:
          value.data && typeof value.data === "object"
            ? (value.data as Record<string, unknown>)
            : undefined
      });
    }
  );

  handleLocal(
    links.libraryWork,
    IPC_CHANNELS.cloudLinkPatch,
    async (event, input) => {
      requireTrustedSender(event);
      const value = (input ?? {}) as Record<string, unknown>;
      await links.patchData(
        requireKind(value.kind),
        requireId(value.localId, "localId"),
        (value.patch ?? {}) as Record<string, unknown>
      );
    }
  );

  const uploadWork = uploads.libraryWork;
  const uploadRepository = uploadWork.guard(repository);
  const handleUpload = (
    channel: string,
    handler: Parameters<typeof ipcMain.handle>[1]
  ) => handleLocal(uploadWork, channel, handler);

  const assertUploadAccess = async () => {
    uploadWork.capture();
    await requireCloudAccount(options.settings);
    uploadWork.capture();
  };
  const getUploadRoot = () => uploadWork.boundary(options.getLibraryRoot);
  const progressFor =
    (event: IpcMainInvokeEvent, assetId: string) => (fraction: number) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.cloudUploadProgress, {
          assetId,
          fraction
        });
      }
    };
  const prepareVideo = async (
    value: Record<string, unknown>,
    assetId: string,
    force?: boolean
  ) => {
    // Resolved here rather than passed in, so native paths stay in main.
    const sourcePath = await uploadRepository.resolveMediaPath(
      "asset",
      assetId
    );
    if (!sourcePath) throw new Error("The local asset could not be found");
    return uploads.prepare({
      assetId,
      sourcePath,
      trimStartSeconds: optionalSeconds(
        value.trimStartSeconds,
        "trimStartSeconds"
      ),
      trimEndSeconds: optionalSeconds(value.trimEndSeconds, "trimEndSeconds"),
      force
    });
  };

  handleUpload(IPC_CHANNELS.cloudPrepareUpload, async (_event, input) => {
    await assertUploadAccess();
    const value = (input ?? {}) as Record<string, unknown>;
    const prepared = await prepareVideo(
      value,
      requireId(value.assetId, "assetId"),
      value.force === true
    );
    return { sizeBytes: prepared.sizeBytes, encoded: prepared.encoded };
  });

  handleUpload(IPC_CHANNELS.cloudUploadPrepared, async (event, input) => {
    await assertUploadAccess();
    const value = (input ?? {}) as Record<string, unknown>;
    const assetId = requireId(value.assetId, "assetId");
    const presignedUrl = requireId(value.presignedUrl, "presignedUrl");
    // Reuses the cached encode rather than re-encoding for the upload.
    const prepared = await prepareVideo(value, assetId);
    await assertUploadAccess();
    await uploads.upload({
      assertAccess: assertUploadAccess,
      filePath: prepared.filePath,
      presignedUrl,
      onProgress: progressFor(event, assetId)
    });
  });

  handleUpload(IPC_CHANNELS.cloudAssetInfo, async (_event, input) => {
    const assetId = requireId(input, "assetId");
    const signal = uploadWork.signal;
    const libraryRoot = await getUploadRoot();
    const info = await uploadWork.boundary(() =>
      readLocalAssetInfo(options.databaseManager, assetId, {
        libraryRoot,
        signal
      })
    );
    if (!info) return null;
    const { id, name, extension, width, height, type, frameCount } = info;
    return { id, name, extension, width, height, type, frameCount };
  });

  handleUpload(IPC_CHANNELS.cloudUploadBytes, async (event, input) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const uploadId = requireId(value.uploadId, "uploadId");
    await uploads.uploadBytes(event.sender, {
      uploadId,
      bytes: requireBytes(value.bytes),
      presignedUrl: requireId(value.presignedUrl, "presignedUrl"),
      contentType: requireId(value.contentType, "contentType"),
      assertAccess: assertUploadAccess,
      onProgress: progressFor(event, uploadId)
    });
  });

  handleUpload(IPC_CHANNELS.cloudCancelUploadBytes, async (event, input) => {
    await uploads.cancelUploadBytes(event.sender, requireId(input, "uploadId"));
  });

  handleUpload(IPC_CHANNELS.cloudUploadAsset, async (event, input) => {
    await assertUploadAccess();
    const value = (input ?? {}) as Record<string, unknown>;
    const assetId = requireId(value.assetId, "assetId");
    const presignedUrl = requireId(value.presignedUrl, "presignedUrl");
    const signal = uploadWork.signal;
    // Drain each issued sibling even if the other read rejects first.
    const [libraryPath, info] = await Promise.all([
      uploadRepository.resolveMediaPath("asset", assetId),
      uploadWork.boundary(() =>
        readLocalAssetInfo(options.databaseManager, assetId, { signal })
      )
    ]);
    const libraryRoot = libraryPath ? null : await getUploadRoot();
    const sourcePath =
      libraryPath ??
      (libraryRoot
        ? await uploadWork.boundary(() =>
            resolveScriptProjectMediaPath(
              options.databaseManager,
              libraryRoot,
              assetId,
              signal
            )
          )
        : null);
    if (!sourcePath || !info) {
      throw new Error("The local asset could not be found");
    }
    const imageLibraryRoot =
      info.type.toUpperCase() === "IMAGE"
        ? (libraryRoot ?? (await getUploadRoot()))
        : null;
    const uploadFile = imageLibraryRoot
      ? await uploads.prepareImage({
          assetId,
          sourcePath,
          extension: info.extension,
          libraryRoot: imageLibraryRoot
        })
      : {
          filePath: sourcePath,
          contentType: contentTypeForExtension(info.extension)
        };
    await assertUploadAccess();
    await uploads.upload({
      assertAccess: assertUploadAccess,
      filePath: uploadFile.filePath,
      presignedUrl,
      contentType: uploadFile.contentType,
      onProgress: progressFor(event, assetId)
    });
  });

  handleRender(IPC_CHANNELS.cloudRenderRegister, async (event, input) => {
    requireTrustedSender(event);
    await requireCloudAccount(options.settings);
    const value = (input ?? {}) as Record<string, unknown>;
    const range = value.frameRange;
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every((entry) => typeof entry === "number" && entry >= 0)
    ) {
      throw new Error("frameRange must be two non-negative numbers");
    }
    const fps = value.fps;
    if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
      throw new Error("fps must be a positive number");
    }
    return renderSubmits.register({
      outputTrackId: requireId(value.outputTrackId, "outputTrackId"),
      sourceAssetId: requireId(value.sourceAssetId, "sourceAssetId"),
      model: requireId(value.model, "model"),
      frameRange: [range[0] as number, range[1] as number],
      fps,
      cloudAssetId: requireId(value.cloudAssetId, "cloudAssetId"),
      cloudClipId:
        typeof value.cloudClipId === "string" ? value.cloudClipId : null,
      cloudOutputLayerId:
        typeof value.cloudOutputLayerId === "string" && value.cloudOutputLayerId
          ? value.cloudOutputLayerId
          : null,
      settings:
        value.settings && typeof value.settings === "object"
          ? (value.settings as Record<string, unknown>)
          : {},
      sources:
        value.sources &&
        typeof value.sources === "object" &&
        !Array.isArray(value.sources)
          ? (value.sources as Record<string, unknown>)
          : undefined,
      width: typeof value.width === "number" ? value.width : undefined,
      height: typeof value.height === "number" ? value.height : undefined
    });
  });

  handleRender(IPC_CHANNELS.cloudImageRenderRegister, async (event, input) => {
    requireTrustedSender(event);
    await requireCloudAccount(options.settings);
    const value = (input ?? {}) as Record<string, unknown>;
    const frame = value.frame;
    if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 0) {
      throw new Error("frame must be a non-negative integer");
    }
    return renderSubmits.registerImage({
      projectId: requireId(value.projectId, "projectId"),
      shotId: requireId(value.shotId, "shotId"),
      sourceAssetId: requireId(value.sourceAssetId, "sourceAssetId"),
      model: requireId(value.model, "model"),
      frame,
      name: requireId(value.name, "name"),
      cloudAssetId: requireId(value.cloudAssetId, "cloudAssetId"),
      cloudClipId: requireId(value.cloudClipId, "cloudClipId"),
      settings:
        value.settings && typeof value.settings === "object"
          ? (value.settings as Record<string, unknown>)
          : {}
    });
  });

  handleLocal(
    renderJobs.libraryWork,
    IPC_CHANNELS.cloudRenderListActive,
    async (event) => {
      requireTrustedSender(event);
      const rows = await renderJobs.listActive();
      // The local ids are what the queue UI matches a track on, so they travel
      // with the job rather than being looked up again in the renderer.
      return rows.map((row) => ({
        id: row.id,
        cloudAssetId: row.cloudAssetId,
        cloudClipId: row.cloudClipId,
        kind: isImageJobRequest(row.request) ? "img2img" : "video",
        projectId: row.projectId,
        shotId: row.shotId,
        model: row.model,
        status: row.status,
        progress: row.progress,
        assetId: row.assetId,
        trackId: row.trackId,
        clipId: row.clipId
      }));
    }
  );

  handleLocal(
    renderJobs.libraryWork,
    IPC_CHANNELS.cloudRenderListQueue,
    async (event) => {
      requireTrustedSender(event);
      return renderJobs.listQueue();
    }
  );

  handleLocal(
    renderJobs.libraryWork,
    IPC_CHANNELS.cloudRenderSetStatus,
    async (event, input) => {
      requireTrustedSender(event);
      const value = (input ?? {}) as Record<string, unknown>;
      await renderJobs.update(requireId(value.jobId, "jobId"), {
        status: requireId(value.status, "status"),
        progress:
          typeof value.progress === "number" ? value.progress : undefined
      });
    }
  );

  handleRender(IPC_CHANNELS.cloudRenderFinish, async (event, input) => {
    requireTrustedSender(event);
    const descriptionSession = options.captureImageDescriptionSession?.();
    await requireCloudAccount(options.settings);
    const value = (input ?? {}) as Record<string, unknown>;
    const jobId = requireId(value.jobId, "jobId");
    const url = requireId(value.url, "url");
    const libraryRoot = await renderWork.boundary(options.getLibraryRoot);
    if (!libraryRoot) throw new Error("Choose a Mago library folder first");

    // An img2img output is a still, so it must not land under a .mp4 name.
    const job = await renderWork.guard(renderJobs).get(jobId);
    const extension = isImageJobRequest(job?.request)
      ? toCloudImageOutputExtension(url, IMAGE_OUTPUT_EXTENSION)
      : undefined;

    const signal = renderWork.signal;
    const downloaded = await renderWork.boundary(() =>
      downloadRenderOutput({
        signal,
        cloudStorage: {
          allowedHosts: resolveCloudConfig().cloudStorageHosts,
          assertAccess: () => requireCloudAccount(options.settings)
        },
        url,
        libraryRoot,
        jobId,
        extension,
        onProgress: (fraction) => {
          if (!signal.aborted && !event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.cloudUploadProgress, {
              assetId: jobId,
              fraction
            });
          }
        }
      })
    );
    await renderSubmits.complete(
      {
        jobId,
        relativePath: downloaded.relativePath,
        sizeBytes: downloaded.sizeBytes
      },
      descriptionSession
    );
  });

  handleRender(IPC_CHANNELS.cloudRenderFail, async (event, input) => {
    requireTrustedSender(event);
    const value = (input ?? {}) as Record<string, unknown>;
    await renderSubmits.fail({
      jobId: requireId(value.jobId, "jobId"),
      message:
        typeof value.message === "string" && value.message
          ? value.message
          : "The cloud render failed"
    });
  });
};
