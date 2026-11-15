import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import {
  isOPFSSupported,
  opfsClear,
  opfsGet,
  opfsSet,
  type CacheType
} from "./opfs";
import {
  handleQuotaExceeded,
  isQuotaExceededError
} from "./opfs/quotaManagement";

export type { CacheType } from "./opfs";

export async function cacheClear(type?: CacheType): Promise<void> {
  const work = rendererLibrary.capture();
  const useOPFS = await isOPFSSupported();
  work.check();
  if (!useOPFS) return;
  try {
    await work.boundary(() => opfsClear(type));
  } catch (error) {
    work.check();
    console.warn("OPFS clear failed:", error);
  }
}

export async function cacheSet(
  type: CacheType,
  key: string,
  blob: Blob,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<void> {
  work.check();
  const useOPFS = await isOPFSSupported();
  work.check();
  if (!useOPFS) return;
  const scopedKey = await work.cacheKey(key);
  try {
    await work.boundary(() => opfsSet(type, scopedKey, blob));
  } catch (error) {
    work.check();
    if (isQuotaExceededError(error)) {
      await work.boundary(handleQuotaExceeded);
      await work.boundary(() => opfsSet(type, scopedKey, blob));
    } else {
      console.warn("OPFS write failed:", error);
    }
  }
}

export async function cacheGet(
  type: CacheType,
  key: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<Blob | undefined> {
  work.check();
  const useOPFS = await isOPFSSupported();
  work.check();
  if (!useOPFS) return undefined;
  const scopedKey = await work.cacheKey(key);
  try {
    return await work.boundary(() => opfsGet(type, scopedKey));
  } catch (error) {
    work.check();
    console.warn("OPFS read failed:", error);
    return undefined;
  }
}
