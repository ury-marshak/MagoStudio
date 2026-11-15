import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";
import { fetchRendererMedia } from "@/platform/rendererMediaAccess";

import { cacheGet, cacheSet, type CacheType } from "./cacheStorage";
import { readMediaBlob } from "./readMediaBlob";

export async function readCachedDataUrl(
  type: CacheType,
  key: string,
  work: RendererLibraryWork
): Promise<string | null> {
  const blob = await cacheGet(type, key, work);
  work.check();
  if (!blob) return null;
  return work.boundary(
    () =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        const abort = () => reader.abort();
        const cleanup = () => work.signal.removeEventListener("abort", abort);
        reader.onloadend = () => {
          cleanup();
          if (work.signal.aborted) reject(work.signal.reason);
          else
            resolve(typeof reader.result === "string" ? reader.result : null);
        };
        reader.onerror = () => {
          cleanup();
          resolve(null);
        };
        work.signal.addEventListener("abort", abort, { once: true });
        reader.readAsDataURL(blob);
      })
  );
}

export async function saveCachedDataUrl(
  type: CacheType,
  key: string,
  dataUrl: string,
  work: RendererLibraryWork
): Promise<void> {
  work.check();
  const blob = await work.boundary(async () => {
    const response = await fetchRendererMedia(dataUrl, { signal: work.signal });
    return readMediaBlob(response, work.signal);
  });
  await cacheSet(type, key, blob, work);
}
