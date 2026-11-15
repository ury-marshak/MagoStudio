import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { readCachedDataUrl, saveCachedDataUrl } from "./cachedDataUrl";

export async function getFilmstripFromCache(
  assetId: string,
  width: number,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<string | null> {
  try {
    return await readCachedDataUrl("filmstrip", `${assetId}_${width}`, work);
  } catch {
    work.check();
    return null;
  }
}

export async function saveFilmstripToCache(
  assetId: string,
  width: number,
  dataUrl: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<void> {
  try {
    await saveCachedDataUrl("filmstrip", `${assetId}_${width}`, dataUrl, work);
  } catch (error) {
    work.check();
    console.warn("Failed to save filmstrip to cache:", error);
  }
}
