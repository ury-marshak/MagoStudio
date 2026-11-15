import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { readCachedDataUrl, saveCachedDataUrl } from "./cachedDataUrl";

function getFrameCacheKey(
  assetId: string,
  frameNumber: number,
  fps?: number
): string {
  return fps
    ? `${assetId}_f${frameNumber}_fps${fps}`
    : `${assetId}_f${frameNumber}`;
}

export async function getFrameFromCache(
  assetId: string,
  frameNumber: number,
  fps?: number,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<string | null> {
  try {
    return await readCachedDataUrl(
      "frame",
      getFrameCacheKey(assetId, frameNumber, fps),
      work
    );
  } catch {
    work.check();
    return null;
  }
}

export async function saveFrameToCache(
  assetId: string,
  frameNumber: number,
  dataUrl: string,
  fps?: number,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<void> {
  try {
    await saveCachedDataUrl(
      "frame",
      getFrameCacheKey(assetId, frameNumber, fps),
      dataUrl,
      work
    );
  } catch (error) {
    work.check();
    console.warn("Failed to save frame to cache:", error);
  }
}
