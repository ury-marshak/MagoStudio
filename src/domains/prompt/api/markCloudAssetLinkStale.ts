import { getLocalDesktopApi } from "@/platform/localDesktop";
import type { RendererLibraryWork } from "@/platform/rendererLibraryWork";

export const markCloudAssetLinkStale = (
  localAssetId: string,
  work: RendererLibraryWork
): Promise<void> =>
  work.boundary(() =>
    getLocalDesktopApi().cloud.links.patch({
      kind: "asset",
      localId: localAssetId,
      patch: { status: "stale" }
    })
  );
