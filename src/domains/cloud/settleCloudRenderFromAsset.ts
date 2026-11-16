import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { CloudApi } from "./mirrorService";
import { readCloudRenderAsset } from "./readCloudRenderAsset";

export type CloudRenderSettlement = "finished" | "failed" | "waiting";

export type PendingCloudRenderOutputMeaning = "still-rendering" | "cancelled";

export const CANCELLED_CLOUD_RENDER_MESSAGE = "The cloud render was cancelled";

export const settleCloudRenderFromAsset = async (
  api: CloudApi,
  job: { id: string; cloudAssetId: string },
  pendingOutputMeaning: PendingCloudRenderOutputMeaning,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<CloudRenderSettlement> => {
  await work.ready();
  const renders = getLocalDesktopApi().cloud.renders;
  const asset = await readCloudRenderAsset(api, job.cloudAssetId);
  work.check();

  if (asset.kind === "unreachable") return "waiting";

  if (asset.kind === "failed") {
    await work.boundary(() =>
      renders.fail({ jobId: job.id, message: asset.reason })
    );
    return "failed";
  }

  if (asset.kind === "pending") {
    if (pendingOutputMeaning === "still-rendering") return "waiting";
    await work.boundary(() =>
      renders.fail({
        jobId: job.id,
        message: CANCELLED_CLOUD_RENDER_MESSAGE
      })
    );
    return "failed";
  }

  try {
    await work.boundary(() =>
      renders.finish({ jobId: job.id, url: asset.url })
    );
    return "finished";
  } catch {
    work.check();
    return "waiting";
  }
};
