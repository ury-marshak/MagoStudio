import { getLocalDesktopApi } from "@/platform/localDesktop";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import { findLocalTrackName } from "./findLocalTrackName";
import { bindCloudApiToLibrary, CloudApi } from "./mirrorService";
import { readCloudLayerOrder } from "./readCloudLayerOrder";

const RENDER_LAYER_TYPE = "RENDER";

const DEFAULT_RENDER_LAYER_PARENT_ORDER = 1;

const readSourceLayerOrder = async (
  api: CloudApi,
  cloudSourceLayerId: string | null
): Promise<number> => {
  if (cloudSourceLayerId === null) return DEFAULT_RENDER_LAYER_PARENT_ORDER;
  const sourceLayer = await api
    .get<unknown>(`/layers/${cloudSourceLayerId}`)
    .catch(() => null);
  return readCloudLayerOrder(sourceLayer) ?? DEFAULT_RENDER_LAYER_PARENT_ORDER;
};

export const createCloudOutputLayer = async (
  api: CloudApi,
  input: {
    localOutputTrackId: string;
    shotName: string;
    cloudTimelineId: string;
    cloudSourceLayerId: string | null;
  },
  work: RendererLibraryWork
): Promise<string> => {
  const localProjects = await work.boundary(() =>
    getLocalDesktopApi()
      .projects.listAll()
      .catch(() => [])
  );
  const remote = bindCloudApiToLibrary(api, work);
  const outputLayerName =
    findLocalTrackName(localProjects, input.localOutputTrackId) ??
    input.shotName;
  const outputLayerParentOrder = await readSourceLayerOrder(
    remote,
    input.cloudSourceLayerId
  );

  const outputLayer = await remote.post<{ id: string }>("/layers", {
    timeline_id: input.cloudTimelineId,
    type: RENDER_LAYER_TYPE,
    name: outputLayerName,
    data: { renderEngine: "magov2" },
    parent_layer_order: outputLayerParentOrder
  });
  if (!outputLayer?.id) {
    throw new Error("Cloud Mago did not return an output layer");
  }
  return outputLayer.id;
};
