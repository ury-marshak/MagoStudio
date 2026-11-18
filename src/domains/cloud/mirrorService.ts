import { waitForPollTick } from "@domains/videoUpload/utils/waitForPollTick";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { toSourceVideoTrimKey } from "../../../desktop/shared/toSourceVideoTrimKey";

import { describeIngestionErrorPayload } from "./describeIngestionErrorPayload";
import {
  findUploadedAssetId,
  findUploadedLayerId
} from "./findUploadedAssetId";
import { ingestionFailureFromRequestError } from "./ingestionFailureFromRequestError";
import { isCloudAssetLinkReusable } from "./isCloudAssetLinkReusable";
import { isCloudResourceAlreadyGoneError } from "./isCloudResourceAlreadyGoneError";
import { isCloudSourceVideoLinkReusable } from "./isCloudSourceVideoLinkReusable";
import { isIngestedCloudSourceVideoUploadOfTrim } from "./isIngestedCloudSourceVideoUploadOfTrim";
import { toAssetScopedCloudSourceVideoLinkLocalId } from "./toAssetScopedCloudSourceVideoLinkLocalId";
import { toCloudImageExtension } from "./toCloudImageExtension";
import { toCloudImageSize } from "./toCloudImageSize";
import { toCloudMirrorProjectSettings } from "./toCloudMirrorProjectSettings";
import { toCloudSourceVideoLinkLocalId } from "./toCloudSourceVideoLinkLocalId";

/**
 * Mirrors just enough of a local project into cloud Mago for a render to run.
 *
 * The local library stays authoritative. Everything here is derived and
 * disposable: each step is cached in `cloud_links`, and a cloud record that has
 * gone away is simply created again. Nothing in this file may write to a local
 * record.
 *
 * The chain runs in the renderer because that is where the authenticated API
 * client lives. Filesystem work is delegated to the main process, which resolves
 * the asset by id — no native path ever crosses the bridge.
 *
 * The endpoint shapes here were validated against staging.
 */

export interface CloudApi {
  post: <T>(url: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  get: <T>(url: string, signal?: AbortSignal) => Promise<T>;
}

/** Guard transport dispatch, including credentials, and late responses from
 * even a transport that ignores the signal. */
export const bindCloudApiToLibrary = (
  api: CloudApi,
  work: RendererLibraryWork
): CloudApi => ({
  get: <T>(url: string) =>
    runRendererLibraryRequest(work, (signal) => api.get<T>(url, signal)),
  post: <T>(url: string, body?: unknown) =>
    runRendererLibraryRequest(work, (signal) => api.post<T>(url, body, signal))
});

const INGESTION_POLL_INTERVAL_MS = 3000;
const INGESTION_POLL_ATTEMPTS = 100;

export type MirrorProgress = (
  step:
    | "project"
    | "timeline"
    | "asset"
    | "encoding"
    | "uploading"
    | "ingesting"
    | "done"
) => void;

const bridge = () => getLocalDesktopApi();

export const reportMirrorProgress = (
  work: RendererLibraryWork,
  onProgress: MirrorProgress | undefined,
  step: Parameters<MirrorProgress>[0]
): void => {
  work.check();
  onProgress?.(step);
};

interface CreatedProject {
  id: string;
  timelines?: { id?: unknown }[];
}

type MirrorState = {
  projectResolutions: Map<string, Promise<string>>;
  confirmedRecords: Set<string>;
};
const mirrorStates = new WeakMap<AbortSignal, MirrorState>();

const mirrorState = (work: RendererLibraryWork): MirrorState => {
  work.check();
  let state = mirrorStates.get(work.signal);
  if (!state) {
    state = { projectResolutions: new Map(), confirmedRecords: new Set() };
    mirrorStates.set(work.signal, state);
  }
  return state;
};

const isCloudOriginLink = (link: { data: Record<string, unknown> }): boolean =>
  link.data.origin === "cloud";

const toCloudProjectConfirmationKey = (cloudProjectId: string): string =>
  `project:${cloudProjectId}`;

const toCloudTimelineConfirmationKey = (
  cloudTimelineId: string,
  cloudProjectId: string
): string => `timeline:${cloudTimelineId}:${cloudProjectId}`;

const isLinkedCloudProjectStillInCloud = async (
  api: CloudApi,
  cloudProjectId: string,
  work: RendererLibraryWork
): Promise<boolean> => {
  const { confirmedRecords } = mirrorState(work);
  const confirmationKey = toCloudProjectConfirmationKey(cloudProjectId);
  if (confirmedRecords.has(confirmationKey)) return true;
  try {
    await bindCloudApiToLibrary(api, work).get(`/projects/${cloudProjectId}`);
  } catch (err) {
    work.check();
    if (isCloudResourceAlreadyGoneError(err)) return false;
    throw err;
  }
  work.check();
  confirmedRecords.add(confirmationKey);
  return true;
};

const isLinkedCloudTimelineInCloudProject = async (
  api: CloudApi,
  cloudTimelineId: string,
  cloudProjectId: string,
  work: RendererLibraryWork
): Promise<boolean> => {
  const { confirmedRecords } = mirrorState(work);
  const confirmationKey = toCloudTimelineConfirmationKey(
    cloudTimelineId,
    cloudProjectId
  );
  if (confirmedRecords.has(confirmationKey)) return true;
  let cloudTimeline: { project_id?: unknown } | undefined;
  try {
    cloudTimeline = await bindCloudApiToLibrary(api, work).get<{
      project_id?: unknown;
    }>(`/timeline/${cloudTimelineId}`);
  } catch (err) {
    work.check();
    if (isCloudResourceAlreadyGoneError(err)) return false;
    throw err;
  }
  if (cloudTimeline?.project_id !== cloudProjectId) return false;
  work.check();
  confirmedRecords.add(confirmationKey);
  return true;
};

export const ensureCloudProject = async (
  api: CloudApi,
  input: { localProjectId: string; name: string; description?: string },
  work = rendererLibrary.capture()
): Promise<string> => {
  const { projectResolutions } = mirrorState(work);
  const resolutionInFlight = projectResolutions.get(input.localProjectId);
  if (resolutionInFlight) return resolutionInFlight;

  const resolution = linkOrCreateCloudProject(api, input, work).finally(() => {
    projectResolutions.delete(input.localProjectId);
  });
  projectResolutions.set(input.localProjectId, resolution);
  return resolution;
};

const linkOrCreateCloudProject = async (
  api: CloudApi,
  input: { localProjectId: string; name: string; description?: string },
  work: RendererLibraryWork
): Promise<string> => {
  const { confirmedRecords } = mirrorState(work);
  const existing = await work.boundary(() =>
    bridge().cloud.links.get("project", input.localProjectId)
  );
  if (
    existing &&
    (isCloudOriginLink(existing) ||
      (await isLinkedCloudProjectStillInCloud(api, existing.cloudId, work)))
  )
    return existing.cloudId;

  const created = await bindCloudApiToLibrary(api, work).post<CreatedProject>(
    "/projects",
    {
      name: input.name,
      description: input.description ?? "",
      settings: toCloudMirrorProjectSettings(input.localProjectId)
    }
  );
  if (!created?.id) throw new Error("Cloud Mago did not return a project id");

  // Creating a project also creates an empty timeline. Remembering it lets the
  // first shot adopt it instead of leaving an orphan empty shot that a user
  // would see if they opened this project in the cloud web app.
  const spare = created.timelines?.[0]?.id;
  await work.boundary(() =>
    bridge().cloud.links.put({
      kind: "project",
      localId: input.localProjectId,
      cloudId: created.id,
      data: {
        isCloudProjectMarkedAsMirror: true,
        ...(typeof spare === "string" && spare
          ? { spareTimelineId: spare }
          : {})
      }
    })
  );
  work.check();
  confirmedRecords.add(toCloudProjectConfirmationKey(created.id));
  return created.id;
};

export const ensureCloudTimeline = async (
  api: CloudApi,
  input: {
    localShotId: string;
    localProjectId?: string;
    cloudProjectId: string;
    name: string;
  },
  work = rendererLibrary.capture()
): Promise<string> => {
  const { confirmedRecords } = mirrorState(work);
  const existing = await work.boundary(() =>
    bridge().cloud.links.get("timeline", input.localShotId)
  );
  if (
    existing &&
    (isCloudOriginLink(existing) ||
      (await isLinkedCloudTimelineInCloudProject(
        api,
        existing.cloudId,
        input.cloudProjectId,
        work
      )))
  )
    return existing.cloudId;

  // Adopt the timeline that came free with the project, once.
  const { localProjectId } = input;
  const projectLink = localProjectId
    ? await work.boundary(() =>
        bridge().cloud.links.get("project", localProjectId)
      )
    : null;
  const spare = projectLink?.data.spareTimelineId;
  if (typeof spare === "string" && spare) {
    await work.boundary(() =>
      bridge().cloud.links.put({
        kind: "project",
        localId: projectLink!.localId,
        cloudId: projectLink!.cloudId,
        data: { ...projectLink!.data, spareTimelineId: undefined }
      })
    );
    await work.boundary(() =>
      bridge().cloud.links.put({
        kind: "timeline",
        localId: input.localShotId,
        cloudId: spare
      })
    );
    work.check();
    confirmedRecords.add(
      toCloudTimelineConfirmationKey(spare, projectLink!.cloudId)
    );
    return spare;
  }

  return createCloudTimeline(api, input, work);
};

const createCloudTimeline = async (
  api: CloudApi,
  input: {
    localShotId: string;
    cloudProjectId: string;
    name: string;
  },
  work: RendererLibraryWork
): Promise<string> => {
  const { confirmedRecords } = mirrorState(work);
  const created = await bindCloudApiToLibrary(api, work).post<{ id: string }>(
    `/timelines/${input.cloudProjectId}`,
    { name: input.name }
  );
  if (!created?.id) throw new Error("Cloud Mago did not return a timeline id");

  await work.boundary(() =>
    bridge().cloud.links.put({
      kind: "timeline",
      localId: input.localShotId,
      cloudId: created.id
    })
  );
  work.check();
  confirmedRecords.add(
    toCloudTimelineConfirmationKey(created.id, input.cloudProjectId)
  );
  return created.id;
};

interface AssetStatusResponse {
  asset?: {
    data?: {
      status?: string;
      error?: unknown;
    };
  };
}

class CloudTimelineOccupiedError extends Error {
  constructor() {
    super("Cloud timeline already contains an uploaded video");
    this.name = "CloudTimelineOccupiedError";
  }
}

interface CloudSourceVideo {
  cloudAssetId: string;
  cloudLayerId: string | null;
  cloudSourceVideoLinkLocalId: string;
}

interface CloudSourceVideoLink {
  localId: string;
  cloudId: string;
  data: Record<string, unknown>;
}

const toCloudSourceVideo = (link: CloudSourceVideoLink): CloudSourceVideo => ({
  cloudAssetId: link.cloudId,
  cloudLayerId:
    typeof link.data.cloudLayerId === "string" ? link.data.cloudLayerId : null,
  cloudSourceVideoLinkLocalId: link.localId
});

const adoptAssetScopedCloudSourceVideoLink = async (
  api: CloudApi,
  input: {
    localAssetId: string;
    cloudTimelineId: string;
    sourceVideoTrimKey: string;
    sourceVideoLinkLocalId: string;
  },
  work: RendererLibraryWork
): Promise<CloudSourceVideo | null> => {
  const assetScopedLink = await work.boundary(() =>
    bridge().cloud.links.get(
      "asset",
      toAssetScopedCloudSourceVideoLinkLocalId(input)
    )
  );
  const isAssetScopedLinkAnUploadOfRequestedTrim =
    isIngestedCloudSourceVideoUploadOfTrim(
      assetScopedLink,
      input.sourceVideoTrimKey
    );
  if (!assetScopedLink || !isAssetScopedLinkAnUploadOfRequestedTrim)
    return null;

  const shotCloudTimeline = await bindCloudApiToLibrary(api, work).get<unknown>(
    `/timeline/${input.cloudTimelineId}`
  );
  const cloudLayerIdOnShotTimeline = findUploadedLayerId(
    { timeline: shotCloudTimeline },
    assetScopedLink.cloudId
  );
  if (!cloudLayerIdOnShotTimeline) return null;

  const adoptedLink = {
    kind: "asset" as const,
    localId: input.sourceVideoLinkLocalId,
    cloudId: assetScopedLink.cloudId,
    data: {
      ...assetScopedLink.data,
      sourceVideoTrimKey: input.sourceVideoTrimKey,
      cloudTimelineId: input.cloudTimelineId,
      cloudLayerId: cloudLayerIdOnShotTimeline
    }
  };
  await work.boundary(() => bridge().cloud.links.put(adoptedLink));
  return toCloudSourceVideo(adoptedLink);
};

/** Ingestion status is nested under `asset`, not at the response root. */
const ingestionStatus = (response: AssetStatusResponse): string | undefined =>
  response?.asset?.data?.status;

interface CloudSourceVideoRequest {
  localAssetId: string;
  localShotId: string;
  cloudTimelineId: string;
  name: string;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  onProgress?: MirrorProgress;
}

const ensureCloudSourceVideo = async (
  api: CloudApi,
  input: CloudSourceVideoRequest,
  work: RendererLibraryWork
): Promise<CloudSourceVideo> => {
  const remote = bindCloudApiToLibrary(api, work);
  const assetLink = await work.boundary(() =>
    bridge().cloud.links.get("asset", input.localAssetId)
  );
  const isSourceVideoOwnedByCloud = assetLink?.data.origin === "cloud";
  if (assetLink && isSourceVideoOwnedByCloud)
    return toCloudSourceVideo(assetLink);

  const sourceVideoTrimKey = toSourceVideoTrimKey(input);
  const sourceVideoLinkLocalId = toCloudSourceVideoLinkLocalId({
    localAssetId: input.localAssetId,
    localShotId: input.localShotId,
    sourceVideoTrimKey
  });
  const shotSourceVideoLink = await work.boundary(() =>
    bridge().cloud.links.get("asset", sourceVideoLinkLocalId)
  );
  const isShotSourceVideoLinkReusable = isCloudSourceVideoLinkReusable(
    shotSourceVideoLink,
    { sourceVideoTrimKey, cloudTimelineId: input.cloudTimelineId }
  );
  if (shotSourceVideoLink && isShotSourceVideoLinkReusable)
    return toCloudSourceVideo(shotSourceVideoLink);

  const hasShotEverLinkedThisSourceVideo = !!shotSourceVideoLink;
  const adoptedSourceVideo = hasShotEverLinkedThisSourceVideo
    ? null
    : await adoptAssetScopedCloudSourceVideoLink(
        api,
        {
          localAssetId: input.localAssetId,
          cloudTimelineId: input.cloudTimelineId,
          sourceVideoTrimKey,
          sourceVideoLinkLocalId
        },
        work
      );
  if (adoptedSourceVideo) return adoptedSourceVideo;

  // Main owns and drains upload/preparation. The renderer acknowledgement
  // must not wait for an abort that is only issued after it.
  // The trim is applied locally, so the metadata file that would tell ingestion
  // to trim is deliberately not written -- sending it would trim twice.
  reportMirrorProgress(work, input.onProgress, "encoding");
  await runRendererLibraryRequest(work, () =>
    bridge().cloud.prepareUpload({
      assetId: input.localAssetId,
      trimStartSeconds: input.trimStartSeconds,
      trimEndSeconds: input.trimEndSeconds
    })
  );

  const registration = await remote.post<Record<string, unknown>>(
    "/assets/video/upload",
    { name: input.name, ext: "mp4", timeline_id: input.cloudTimelineId }
  );
  const cloudAssetId = findUploadedAssetId(registration);
  const responseKeys = Object.keys(registration).sort().join(", ") || "none";
  if (!cloudAssetId)
    throw new Error(
      `Cloud Mago's video-upload response has no asset id (response keys: ${responseKeys})`
    );

  const videoUrl = registration.video_url;
  if (typeof videoUrl !== "string" || !videoUrl) {
    // The backend deliberately returns only the existing timeline when its
    // first clip already has a healthy asset. That asset is not an upload slot
    // for this local video; the caller must remap the shot to a fresh timeline.
    if (Object.hasOwn(registration, "timeline")) {
      throw new CloudTimelineOccupiedError();
    }
    throw new Error(
      `Cloud Mago did not return a video upload URL (response keys: ${responseKeys})`
    );
  }

  // The layer id is only in this response, and a render needs it as its input.
  const cloudLayerId = findUploadedLayerId(registration, cloudAssetId);
  await work.boundary(() =>
    bridge().cloud.links.put({
      kind: "asset",
      localId: sourceVideoLinkLocalId,
      cloudId: cloudAssetId,
      data: {
        status: "uploading",
        sourceVideoTrimKey,
        cloudTimelineId: input.cloudTimelineId,
        ...(cloudLayerId ? { cloudLayerId } : {})
      }
    })
  );

  reportMirrorProgress(work, input.onProgress, "uploading");
  await runRendererLibraryRequest(work, () =>
    bridge().cloud.uploadPrepared({
      assetId: input.localAssetId,
      trimStartSeconds: input.trimStartSeconds,
      trimEndSeconds: input.trimEndSeconds,
      presignedUrl: videoUrl
    })
  );

  reportMirrorProgress(work, input.onProgress, "ingesting");
  await remote.post(`/assets/${cloudAssetId}/ingestion`, {});
  await work.boundary(() =>
    bridge().cloud.links.patch({
      kind: "asset",
      localId: sourceVideoLinkLocalId,
      patch: { status: "processing" }
    })
  );

  await waitForIngestion(api, cloudAssetId, {}, work);

  await work.boundary(() =>
    bridge().cloud.links.patch({
      kind: "asset",
      localId: sourceVideoLinkLocalId,
      patch: { status: "ingested" }
    })
  );
  return {
    cloudAssetId,
    cloudLayerId,
    cloudSourceVideoLinkLocalId: sourceVideoLinkLocalId
  };
};

export const ensureCloudAsset = async (
  api: CloudApi,
  input: CloudSourceVideoRequest,
  work = rendererLibrary.capture()
): Promise<string> =>
  (await ensureCloudSourceVideo(api, input, work)).cloudAssetId;

const fetchIngestionStatus = async (
  api: CloudApi,
  cloudAssetId: string
): Promise<AssetStatusResponse> => {
  try {
    return await api.get<AssetStatusResponse>(`/assets/${cloudAssetId}`);
  } catch (requestError) {
    const ingestionFailure = ingestionFailureFromRequestError(requestError);
    if (ingestionFailure) throw new Error(ingestionFailure);
    throw requestError;
  }
};

export const waitForIngestion = async (
  api: CloudApi,
  cloudAssetId: string,
  options: { attempts?: number; intervalMs?: number } = {},
  work = rendererLibrary.capture()
): Promise<void> => {
  const remote = bindCloudApiToLibrary(api, work);
  const attempts = options.attempts ?? INGESTION_POLL_ATTEMPTS;
  const intervalMs = options.intervalMs ?? INGESTION_POLL_INTERVAL_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchIngestionStatus(remote, cloudAssetId);
    work.check();
    const status = ingestionStatus(response);
    if (status === "ingested") return;
    if (status === "error" || status === "failed") {
      throw new Error(
        describeIngestionErrorPayload(response.asset?.data?.error)
      );
    }
    await waitForPollTick(intervalMs, work.signal);
    work.check();
  }
  throw new Error("Cloud ingestion did not finish in time");
};

/**
 * Walks the whole chain for one shot. Cheap after the first render, because each
 * step short-circuits on its cached link.
 */
export const ensureMirroredShot = async (
  api: CloudApi,
  input: {
    localProjectId: string;
    projectName: string;
    localShotId: string;
    shotName: string;
    localAssetId: string;
    assetName: string;
    trimStartSeconds?: number;
    trimEndSeconds?: number;
    onProgress?: MirrorProgress;
  },
  work = rendererLibrary.capture()
): Promise<{
  cloudProjectId: string;
  cloudTimelineId: string;
  cloudAssetId: string;
  /** The layer holding the input video, needed as a render's source. */
  cloudLayerId: string | null;
  cloudSourceVideoLinkLocalId: string;
}> => {
  await work.ready();
  reportMirrorProgress(work, input.onProgress, "project");
  const cloudProjectId = await ensureCloudProject(
    api,
    {
      localProjectId: input.localProjectId,
      name: input.projectName
    },
    work
  );

  reportMirrorProgress(work, input.onProgress, "timeline");
  let cloudTimelineId = await ensureCloudTimeline(
    api,
    {
      localShotId: input.localShotId,
      localProjectId: input.localProjectId,
      cloudProjectId,
      name: input.shotName
    },
    work
  );

  reportMirrorProgress(work, input.onProgress, "asset");
  const ensureSourceVideo = () =>
    ensureCloudSourceVideo(
      api,
      {
        localAssetId: input.localAssetId,
        localShotId: input.localShotId,
        cloudTimelineId,
        name: input.assetName,
        trimStartSeconds: input.trimStartSeconds,
        trimEndSeconds: input.trimEndSeconds,
        onProgress: input.onProgress
      },
      work
    );

  let sourceVideo: CloudSourceVideo;
  try {
    sourceVideo = await ensureSourceVideo();
  } catch (error) {
    work.check();
    if (!(error instanceof CloudTimelineOccupiedError)) throw error;

    reportMirrorProgress(work, input.onProgress, "timeline");
    cloudTimelineId = await createCloudTimeline(
      api,
      {
        localShotId: input.localShotId,
        cloudProjectId,
        name: input.shotName
      },
      work
    );
    reportMirrorProgress(work, input.onProgress, "asset");
    sourceVideo = await ensureSourceVideo();
  }

  reportMirrorProgress(work, input.onProgress, "done");
  return { cloudProjectId, cloudTimelineId, ...sourceVideo };
};

/**
 * Mirrors a reference image so a render can point at it.
 *
 * A render's `sources` carries image asset ids -- reference frames, key frames,
 * an ipadapter source, a mask -- and they are local ids the cloud has never
 * seen, which it rejects with "Invalid source: asset not found or
 * inaccessible". Images need no encode, so this is register, upload, link.
 */
export const ensureCloudImageAsset = async (
  api: CloudApi,
  localAssetId: string,
  cloudProjectId?: string,
  onProgress?: MirrorProgress,
  work = rendererLibrary.capture()
): Promise<string> => {
  const existing = await work.boundary(() =>
    bridge().cloud.links.get("asset", localAssetId)
  );
  if (existing && isCloudAssetLinkReusable(existing)) return existing.cloudId;

  const info = await work.boundary(() =>
    bridge().cloud.assetInfo(localAssetId)
  );
  if (!info) throw new Error("The reference image could not be found locally");
  const cloudImageSize = toCloudImageSize(info);
  if (!cloudImageSize) {
    throw new Error(
      "The reference image's dimensions could not be read, so it cannot be sent to cloud Mago"
    );
  }

  reportMirrorProgress(work, onProgress, "asset");
  const registered = await bindCloudApiToLibrary(api, work).post<{
    asset?: { id?: unknown };
    s3_url?: unknown;
    thumbnail_s3_url?: unknown;
  }>("/assets/image/upload", {
    name: info.name,
    ext: toCloudImageExtension(info.extension),
    size: cloudImageSize,
    ...(cloudProjectId ? { project_id: cloudProjectId } : {})
  });
  const cloudAssetId = registered.asset?.id;
  const uploadUrl = registered.s3_url;
  const thumbnailUploadUrl = registered.thumbnail_s3_url;
  if (typeof cloudAssetId !== "string" || typeof uploadUrl !== "string") {
    throw new Error("Cloud Mago did not return an uploadable image asset");
  }

  reportMirrorProgress(work, onProgress, "uploading");
  await runRendererLibraryRequest(work, () =>
    bridge().cloud.uploadAsset({
      assetId: localAssetId,
      presignedUrl: uploadUrl
    })
  );
  if (typeof thumbnailUploadUrl === "string" && thumbnailUploadUrl) {
    await runRendererLibraryRequest(work, () =>
      bridge().cloud.uploadAsset({
        assetId: localAssetId,
        presignedUrl: thumbnailUploadUrl
      })
    );
  }
  await work.boundary(() =>
    bridge().cloud.links.put({
      kind: "asset",
      localId: localAssetId,
      cloudId: cloudAssetId,
      // Images are usable as soon as they are uploaded: no ingestion step.
      data: { status: "ingested", kind: "image" }
    })
  );
  reportMirrorProgress(work, onProgress, "done");
  return cloudAssetId;
};
