import { getTrackAssetId } from "@domains/track/utils/getTrackAssetId";
import { Layer } from "@schemas/layer";

import { getLocalDesktopApi } from "@/platform/localDesktop";
import { rendererLibrary } from "@/platform/rendererLibraryWork";

export const saveTrackVideoToDisk = async (
  { track, fileName }: { track: Layer; fileName: string },
  work = rendererLibrary.capture()
): Promise<void> => {
  await work.ready();
  work.check();
  const assetId = getTrackAssetId(track);
  if (!assetId) {
    throw new Error("This track has no rendered video to save");
  }
  await getLocalDesktopApi().files.saveAssetAs({
    assetId,
    suggestedName: fileName
  });
  work.check();
};
