import { Layer } from "@schemas/layer";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { captureRendererAccountProfile } from "@/platform/rendererAccountProfile";
import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { getLayerDownloadSignedUrl, LayerDownloadKind } from "./downloadFiles";

export const saveLayerDownloadToDisk = async (
  {
    layerId,
    kind,
    suggestedName
  }: { layerId: Layer["id"]; kind: LayerDownloadKind; suggestedName: string },
  work = rendererLibrary.capture()
): Promise<boolean> => {
  const profile = captureRendererAccountProfile();
  const signal = profile
    ? AbortSignal.any([work.signal, profile])
    : work.signal;
  await work.ready();
  signal.throwIfAborted();
  const signedUrl = await getLayerDownloadSignedUrl({ layerId, kind, signal });
  signal.throwIfAborted();
  const saved = await getLocalDesktopApi().files.saveCloudStorageObjectAs({
    url: signedUrl,
    suggestedName
  });
  signal.throwIfAborted();
  return saved;
};
