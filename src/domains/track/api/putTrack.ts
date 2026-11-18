import { isTrackOwnedByCloud } from "@domains/track/utils/isTrackOwnedByCloud";
import { Layer } from "@schemas/layer";

import { backendApiClient } from "@/lib/backend-api-client";
import { getLocalDesktopApi, isLocalApp } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest
} from "@/platform/rendererLibraryWork";

import { RatingType } from "../interface";

import { toCachedLayerAfterCloudWrite } from "./toCachedLayerAfterCloudWrite";

export const putTrack = async (
  {
    layerId,
    layerName,
    layerData,
    rating,
    projectId
  }: {
    layerId: string;
    layerName: string;
    layerData: Object;
    rating?: RatingType;
    projectId?: string;
  },
  work = rendererLibrary.capture()
): Promise<Layer> => {
  const isTrackStoredLocally =
    isLocalApp &&
    !(await work.boundary(() =>
      isTrackOwnedByCloud({ projectId, trackId: layerId })
    ));
  if (isTrackStoredLocally) {
    return work.boundary(
      async () =>
        (await getLocalDesktopApi().tracks.update({
          trackId: layerId,
          name: layerName,
          data: layerData as Record<string, unknown>,
          rating
        })) as Layer
    );
  }
  const response = await runRendererLibraryRequest(work, (signal) =>
    backendApiClient.put(
      `/layers/${layerId}`,
      {
        name: layerName,
        data: layerData,
        rating
      },
      { signal }
    )
  );
  work.check();
  return toCachedLayerAfterCloudWrite(response.data, projectId, work);
};
