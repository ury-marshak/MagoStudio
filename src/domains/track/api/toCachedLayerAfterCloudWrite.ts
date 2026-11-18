import { syncCloudProjectMetadata } from "@domains/scriptProject/syncCloudScriptProjects";
import { Layer } from "@schemas/layer";

import { isLocalApp } from "@/platform/localDesktop";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

import { readMirroredLayer } from "./readMirroredLayer";

export const toCachedLayerAfterCloudWrite = async (
  cloudLayer: Layer,
  projectId: string | undefined,
  work: RendererLibraryWork
): Promise<Layer> => {
  work.check();
  if (!projectId) return cloudLayer;
  await syncCloudProjectMetadata(projectId, work);
  work.check();
  if (!isLocalApp) return cloudLayer;
  const layer = await work.boundary(() =>
    readMirroredLayer(projectId, cloudLayer.id)
  );
  work.check();
  return layer ?? cloudLayer;
};
