import { isCloudProject } from "@domains/shot/utils/isCloudProject";
import { Layer, LayerType } from "@schemas/layer";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { toCachedLayerAfterCloudWrite } from "./toCachedLayerAfterCloudWrite";

export interface PostTrackParams {
  shotId: string;
  trackName: string;
  trackType: LayerType;
  data: Object;
  parentTrackOrder: number;
  isOutputOfLocalProviderRender?: boolean;
}

export const postTrack = async (
  {
    shotId,
    trackName,
    trackType,
    data,
    parentTrackOrder,
    isOutputOfLocalProviderRender = false
  }: PostTrackParams,
  projectId?: string,
  work = rendererLibrary.capture()
): Promise<Layer> => {
  const isTrackStoredLocally =
    isLocalApp &&
    (isOutputOfLocalProviderRender ||
      !(await work.boundary(() => isCloudProject(projectId))));
  if (isTrackStoredLocally) {
    return work.boundary(
      async () =>
        (await getLocalDesktopApi().tracks.create({
          shotId,
          name: trackName,
          type: trackType,
          data: data as Record<string, unknown>,
          parentTrackOrder
        })) as Layer
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.post(
      `/layers`,
      {
        timeline_id: shotId,
        type: trackType,
        name: trackName,
        data,
        parent_layer_order: parentTrackOrder
      },
      { signal }
    )
  );
  work.check();
  return toCachedLayerAfterCloudWrite(response.data, projectId, work);
};
