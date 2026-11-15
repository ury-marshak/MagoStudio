import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import {
  fetchRendererMedia,
  readableDesktopStorageUrl
} from "@/platform/rendererMediaAccess";

import { cacheSet } from "./cacheStorage";
import { mediaDownloads } from "./mediaDownloadScheduler";
import { readMediaBlob } from "./readMediaBlob";

export const downloadImageBlob = (
  url: string,
  assetId: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<Blob> =>
  mediaDownloads.enqueue({
    key: `image:${assetId}`,
    assetId: assetId.replace(/_thumb$/, ""),
    kind: "image",
    work,
    run: async (signal) => {
      signal.throwIfAborted();
      const response = await fetchRendererMedia(
        readableDesktopStorageUrl(url),
        { signal }
      );
      const blob = await readMediaBlob(response, signal);
      work.check();
      if (!blob.size) throw new Error("Image has no bytes yet");
      await cacheSet("image", assetId, blob, work).catch((error) =>
        console.warn("Failed to cache image", error)
      );
      return blob;
    }
  });
