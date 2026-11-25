import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { readableRendererMediaUrl } from "@/platform/rendererMediaAccess";

const DEFAULT_VIDEO_FPS = 30;
const DEFAULT_IMAGE_QUALITY = 0.95;
const FRAME_TIMEOUT_MS = 10_000;

export interface CaptureVideoFrameOptions {
  videoUrl: string;
  frame: number;
  fps?: number;
  imageFormat?: "image/jpeg" | "image/png";
  imageQuality?: number;
}

export const captureVideoFrame = async (
  {
    videoUrl,
    frame,
    fps = DEFAULT_VIDEO_FPS,
    imageFormat = "image/jpeg",
    imageQuality = DEFAULT_IMAGE_QUALITY
  }: CaptureVideoFrameOptions,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<string> => {
  await work.ready();
  work.check();
  videoUrl = readableRendererMediaUrl(videoUrl);
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      reject(new Error("Could not get canvas context"));
      return;
    }

    video.crossOrigin = "anonymous";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const handleLoadedMetadata = () => {
      if (settled) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const timeInSeconds = frame / fps;
      video.currentTime = timeInSeconds;
    };

    const handleSeeked = () => {
      if (settled) return;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frameDataUrl = canvas.toDataURL(imageFormat, imageQuality);
        resolve(frameDataUrl);
        cleanupEventListeners();
      } catch (error) {
        reject(error);
        cleanupEventListeners();
      }
    };

    const handleError = (error: Event) => {
      reject(new Error("Error loading video: " + error.type));
      cleanupEventListeners();
    };

    const cleanupEventListeners = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      work.signal.removeEventListener("abort", handleAbort);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      video.removeAttribute("src");
      video.load();
    };

    const handleAbort = () => {
      cleanupEventListeners();
      reject(work.signal.reason);
    };

    timeout = setTimeout(() => {
      cleanupEventListeners();
      reject(new Error(`Timed out capturing a frame of ${videoUrl}`));
    }, FRAME_TIMEOUT_MS);
    work.signal.addEventListener("abort", handleAbort, { once: true });
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);

    try {
      work.check();
      video.src = videoUrl;
      video.load();
    } catch (error) {
      cleanupEventListeners();
      reject(error);
    }
  }).finally(() => work.check());
};
