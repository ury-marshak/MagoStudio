import { getLocalDesktopApi } from "@/platform/localDesktop";
import {
  rendererLibrary,
  runRendererLibraryRequest,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";

import { classifyCloudRequestFailure } from "./classifyCloudRequestFailure";
import { parseImg2ImgStatus, toImg2ImgJobStatus } from "./img2imgStatus";
import { CloudApi } from "./mirrorService";
import { rendererCloudBackgroundWork } from "./rendererCloudBackgroundWork";

/**
 * The img2img counterpart of `pollCloudRenders`.
 *
 * img2img has no project-wide queue: `GET /assets/img2img/status/{clipId}`
 * answers for exactly one render, so this polls per job rather than batching
 * by project. Everything past that -- reading the status, downloading the
 * output, recording failure -- reuses the same bridge calls the video path
 * uses, since a finished render is a finished render regardless of kind.
 */

export interface PollOutcome {
  checked: number;
  finished: number;
  failed: number;
}

const HTTP_NOT_FOUND = 404;

const bridge = () => getLocalDesktopApi();

export const pollCloudImageRenders = async (
  api: CloudApi,
  origin: RendererLibraryWork = rendererLibrary.capture()
): Promise<PollOutcome> => {
  const work = rendererCloudBackgroundWork(origin);
  await work.ready();
  const jobs = (
    await work.boundary(() => bridge().cloud.renders.listActive())
  ).filter((job) => job.kind === "img2img");
  const outcome: PollOutcome = { checked: jobs.length, finished: 0, failed: 0 };

  for (const job of jobs) {
    work.check();
    if (!job.cloudClipId) continue;

    let response: unknown;
    try {
      response = await api.get(`/assets/img2img/status/${job.cloudClipId}`);
      work.check();
    } catch (err) {
      work.check();
      const failure = classifyCloudRequestFailure(err);
      const isImageRenderGoneFromCloud =
        failure.kind === "rejected" && failure.httpStatus === HTTP_NOT_FOUND;
      if (!isImageRenderGoneFromCloud) continue;
      await work.boundary(() =>
        bridge().cloud.renders.fail({
          jobId: job.id,
          message: failure.reason || "The cloud render no longer exists"
        })
      );
      outcome.failed += 1;
      continue;
    }

    const parsed = parseImg2ImgStatus(response);
    const status = toImg2ImgJobStatus(parsed.status);

    if (status === "SUCCESS") {
      const outputUrl = parsed.outputUrl;
      if (!outputUrl) continue; // Not downloadable yet; try next tick.
      try {
        await runRendererLibraryRequest(work, () =>
          bridge().cloud.renders.finish({
            jobId: job.id,
            url: outputUrl
          })
        );
        outcome.finished += 1;
      } catch {
        work.check();
        // A successful cloud render remains successful when only the local
        // download failed. Leave it active and retry on the next poll.
      }
      continue;
    }

    if (status === "FAILED" || status === "CANCELLED") {
      await work.boundary(() =>
        bridge().cloud.renders.fail({
          jobId: job.id,
          message:
            status === "CANCELLED"
              ? "The cloud render was cancelled"
              : (parsed.failureReason ?? "The cloud render failed")
        })
      );
      outcome.failed += 1;
      continue;
    }

    const hasCloudRenderStatusChanged = status !== job.status;
    const hasCloudRenderProgressChanged =
      parsed.progressPercent !== null &&
      parsed.progressPercent !== job.progress;
    if (hasCloudRenderStatusChanged || hasCloudRenderProgressChanged) {
      await work.boundary(() =>
        bridge().cloud.renders.setStatus({
          jobId: job.id,
          status,
          ...(parsed.progressPercent === null
            ? {}
            : { progress: parsed.progressPercent })
        })
      );
    }
  }

  work.check();
  return outcome;
};
