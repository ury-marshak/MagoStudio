import { extractFrameFromVideo } from "@app/services/mediaBunny";

import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { createRendererObjectUrl } from "@/platform/rendererObjectUrl";

import { cacheGet } from "./cacheStorage";
import { getFrameFromCache, saveFrameToCache } from "./frameCache";
import { getCachedVideoBlob } from "./getCachedVideoBlob";
import { isLocalVideoUrl } from "./isLocalVideoUrl";

const FIRST_FRAME_NUMBER = 0;

export interface CachedVideoPreview {
  videoObjectUrl: string | null;
  firstFrameUrl: string | null;
  isVideoAvailable: boolean;
}

/** A persisted first frame and, when requested, a playable local copy of a finished render.
 * Thumbnail-only reads return the saved frame without touching the video after the first visit.
 *
 * Keyed on the asset id rather than the URL: a render's URL can be reissued while the bytes
 * behind it never change, and re-downloading a finished render on every visit is what this
 * exists to stop.
 *
 * Keep shared playable URLs for replays within the owning library.
 * Thumbnail-only reads do not create an object URL. */
export const resolveCachedVideoPreview = async (
  {
    assetId,
    videoUrl,
    fps,
    loadVideo = true
  }: {
    assetId: string;
    videoUrl: string;
    fps: number;
    loadVideo?: boolean;
  },
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<CachedVideoPreview> => {
  await work.ready();
  work.check();
  const cachedFirstFrameUrl = await getFrameFromCache(
    assetId,
    FIRST_FRAME_NUMBER,
    fps,
    work
  );
  work.check();

  // Thumbnail-only callers must not reopen or download the video when the
  // persisted first frame already exists.
  if (cachedFirstFrameUrl && !loadVideo) {
    const isVideoAvailable =
      isLocalVideoUrl(videoUrl) ||
      ((await cacheGet("video", assetId, work))?.size ?? 0) > 0;
    work.check();
    return {
      videoObjectUrl: null,
      firstFrameUrl: cachedFirstFrameUrl,
      isVideoAvailable
    };
  }

  const videoSource = isLocalVideoUrl(videoUrl)
    ? videoUrl
    : await getCachedVideoBlob(videoUrl, assetId, work);
  work.check();
  const result = (firstFrameUrl: string | null): CachedVideoPreview => {
    work.check();
    return {
      videoObjectUrl: loadVideo
        ? typeof videoSource === "string"
          ? videoSource
          : createRendererObjectUrl(videoSource, work)
        : null,
      firstFrameUrl,
      isVideoAvailable: true
    };
  };

  if (cachedFirstFrameUrl) return result(cachedFirstFrameUrl);

  try {
    const extractedFirstFrameUrl = await extractFrameFromVideo(
      {
        videoSource,
        frameNumber: FIRST_FRAME_NUMBER,
        fps
      },
      work
    );
    work.check();
    await saveFrameToCache(
      assetId,
      FIRST_FRAME_NUMBER,
      extractedFirstFrameUrl,
      fps,
      work
    );
    return result(extractedFirstFrameUrl);
  } catch {
    return result(null);
  }
};
