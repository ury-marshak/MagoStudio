import { isCloudProject } from "@domains/shot/utils/isCloudProject";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { createCloudOutputLayer } from "./createCloudOutputLayer";
import { deleteCloudLayer } from "./deleteCloudLayer";
import { findCloudRenderAssetId } from "./findCloudRenderAssetId";
import { mirrorImageToVideoFrameImages } from "./mirrorImageToVideoFrameImages";
import {
  bindCloudApiToLibrary,
  CloudApi,
  ensureCloudImageAsset,
  ensureCloudProject,
  ensureCloudTimeline,
  MirrorProgress,
  reportMirrorProgress
} from "./mirrorService";
import { LocalImageToVideoRenderContext } from "./resolveImageToVideoRenderContext";
import { SubmitCloudRenderInput } from "./submitCloudRender";

export interface SubmitCloudImageToVideoRenderInput {
  payload: SubmitCloudRenderInput["payload"];
  local: LocalImageToVideoRenderContext;
  model: string;
  fps: number;
  frameRange: [number, number];
  onProgress?: MirrorProgress;
}

const readStartImageAssetId = (
  renderSettings: Record<string, unknown>
): string => {
  const startImageAssetId = renderSettings.image_id;
  if (typeof startImageAssetId !== "string" || !startImageAssetId) {
    throw new Error("Image-to-Video renders need a start image");
  }
  return startImageAssetId;
};

const ensureCloudContainerShotOutputLayer = async (
  api: CloudApi,
  input: SubmitCloudImageToVideoRenderInput,
  cloudProjectId: string,
  work: RendererLibraryWork
): Promise<string> => {
  reportMirrorProgress(work, input.onProgress, "timeline");
  const cloudTimelineId = await ensureCloudTimeline(
    api,
    {
      localShotId: input.local.shotId,
      localProjectId: input.local.projectId,
      cloudProjectId,
      name: input.local.shotName
    },
    work
  );
  return createCloudOutputLayer(
    api,
    {
      localOutputTrackId: input.local.outputTrackId,
      shotName: input.local.shotName,
      cloudTimelineId,
      cloudSourceLayerId: null
    },
    work
  );
};

export const submitCloudImageToVideoRender = async (
  api: CloudApi,
  input: SubmitCloudImageToVideoRenderInput,
  removeCloudLayer?: (cloudLayerId: string) => Promise<void>,
  work = rendererLibrary.capture()
): Promise<{ jobId: string; cloudAssetId: string }> => {
  const renderSettings = input.payload.render_settings.magov2;
  const startImageAssetId = readStartImageAssetId(renderSettings);

  await work.ready();
  reportMirrorProgress(work, input.onProgress, "project");
  const cloudProjectId = await ensureCloudProject(
    api,
    {
      localProjectId: input.local.projectId,
      name: input.local.projectName
    },
    work
  );

  const cloudRenderSettings = await mirrorImageToVideoFrameImages(
    renderSettings,
    (localAssetId) =>
      ensureCloudImageAsset(
        api,
        localAssetId,
        cloudProjectId,
        input.onProgress,
        work
      )
  );

  const isOutputLayerAlreadyInCloud = await work.boundary(() =>
    isCloudProject(input.local.projectId)
  );
  const outputLayerId = isOutputLayerAlreadyInCloud
    ? input.local.outputTrackId
    : await ensureCloudContainerShotOutputLayer(
        api,
        input,
        cloudProjectId,
        work
      );
  const removeOutputLayerCreatedHere = isOutputLayerAlreadyInCloud
    ? async () => undefined
    : () =>
        removeCloudLayer
          ? removeCloudLayer(outputLayerId)
          : deleteCloudLayer(outputLayerId, work);

  const submitted = await bindCloudApiToLibrary(api, work)
    .post<unknown>("/assets/add_render", {
      ...input.payload,
      parent_layer_id: outputLayerId,
      render_settings: {
        ...input.payload.render_settings,
        magov2: cloudRenderSettings
      }
    })
    .catch(async (submitError: unknown) => {
      // The provider may already have accepted this POST. Library teardown
      // neither deletes its output layer nor tries to submit it again.
      work.check();
      await removeOutputLayerCreatedHere().catch(() => undefined);
      work.check();
      throw submitError;
    });
  const cloudAssetId = findCloudRenderAssetId(submitted);
  if (!cloudAssetId) {
    throw new Error("Cloud Mago did not return a render output asset");
  }
  reportMirrorProgress(work, input.onProgress, "done");

  const registered = await work.boundary(() =>
    getLocalDesktopApi().cloud.renders.register({
      outputTrackId: input.local.outputTrackId,
      sourceAssetId: startImageAssetId,
      model: input.model,
      frameRange: input.frameRange,
      fps: input.fps,
      cloudAssetId,
      cloudOutputLayerId: outputLayerId,
      settings: renderSettings
    })
  );

  return { jobId: registered.jobId, cloudAssetId };
};
