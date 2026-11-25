import { ImageAssetResponse } from "@domains/asset/interface";
import { readMediaBlob } from "@domains/asset/utils/readMediaBlob";

import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { fetchRendererMedia } from "@/platform/rendererMediaAccess";

export const createFileFromImageData = async (
  imageData: ImageAssetResponse,
  work: RendererLibraryWork
): Promise<File> => {
  work.check();
  const response = await fetchRendererMedia(imageData.urlToUse, {
    signal: work.signal
  });
  const blob = await readMediaBlob(response, work.signal);
  work.check();

  const file = new File([blob], imageData.asset.name, {
    type: blob.type || "image/jpeg"
  });

  return file;
};
