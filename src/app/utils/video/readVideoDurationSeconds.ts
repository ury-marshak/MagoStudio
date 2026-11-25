import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { readableRendererMediaUrl } from "@/platform/rendererMediaAccess";

const METADATA_TIMEOUT_MS = 10_000;

export const readVideoDurationSeconds = async (
  videoUrl: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<number> => {
  await work.ready();
  work.check();
  videoUrl = readableRendererMediaUrl(videoUrl);
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    let timeoutId: ReturnType<typeof setTimeout>;
    let settled = false;

    const detach = () => {
      if (settled) return;
      settled = true;
      work.signal.removeEventListener("abort", handleAbort);
      clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("error", handleError);
      video.removeAttribute("src");
      video.load();
    };

    const handleLoadedMetadata = () => {
      if (settled) return;
      if (work.signal.aborted) return handleAbort();
      const { duration } = video;
      detach();

      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`Video reported an unusable duration: ${duration}`));
        return;
      }

      resolve(duration);
    };

    const handleError = () => {
      detach();
      reject(new Error(`Could not read the duration of ${videoUrl}`));
    };

    const handleAbort = () => {
      detach();
      reject(work.signal.reason);
    };

    timeoutId = setTimeout(() => {
      detach();
      reject(new Error(`Timed out reading the duration of ${videoUrl}`));
    }, METADATA_TIMEOUT_MS);

    work.signal.addEventListener("abort", handleAbort, { once: true });
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("error", handleError);
    try {
      work.check();
      video.preload = "metadata";
      video.src = videoUrl;
      video.load();
    } catch (error) {
      detach();
      reject(error);
    }
  }).finally(() => work.check());
};
