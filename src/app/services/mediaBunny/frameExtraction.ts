import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import { readableRendererMediaUrl } from "@/platform/rendererMediaAccess";

import { getMediabunny } from "./lazyLoad";
import { FilmstripOptions } from "./types";
import { withRendererMediaInput } from "./withRendererMediaInput";

const FRAME_QUALITY = 0.95;
const FILMSTRIP_QUALITY = 0.85;
const FILMSTRIP_FRAME_HEIGHT = 65;
const SINGLE_FRAME_PROGRESS = 0.5;

export async function extractFrameFromVideo(
  {
    videoSource,
    frameNumber,
    fps
  }: {
    videoSource: Blob | string;
    frameNumber: number;
    fps?: number;
  },
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<string> {
  try {
    await work.ready();
    work.check();
    if (!fps) {
      throw new Error("FPS is required");
    }
    const { Input, BlobSource, UrlSource, ALL_FORMATS, VideoSampleSink } =
      await getMediabunny();
    work.check();
    const input = new Input({
      source:
        typeof videoSource === "string"
          ? new UrlSource(readableRendererMediaUrl(videoSource))
          : new BlobSource(videoSource),
      formats: ALL_FORMATS
    });

    return await withRendererMediaInput(input, work, async () => {
      const videoTrack = await input.getPrimaryVideoTrack();
      work.check();

      if (!videoTrack) {
        throw new Error("No video track found in the input file");
      }

      const canDecode = await videoTrack.canDecode();
      work.check();
      if (!canDecode) {
        throw new Error("Video codec not supported by browser");
      }

      const firstTimestamp = await videoTrack.getFirstTimestamp();
      work.check();
      const requestedTimestamp = frameNumber / fps;

      const timestampSeconds = Math.max(requestedTimestamp, firstTimestamp);

      const sink = new VideoSampleSink(videoTrack);
      const sample = await sink.getSample(timestampSeconds);

      if (!sample) {
        throw new Error(`No frame found at ${timestampSeconds} seconds`);
      }

      try {
        work.check();
        const canvas = document.createElement("canvas");
        canvas.width = videoTrack.displayWidth;
        canvas.height = videoTrack.displayHeight;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Could not get canvas context");
        }

        sample.draw(ctx, 0, 0);

        const frameDataUrl = canvas.toDataURL("image/jpeg", FRAME_QUALITY);

        return frameDataUrl;
      } finally {
        if (sample && typeof sample.close === "function") {
          sample.close();
        }
      }
    });
  } catch (error) {
    work.check();
    const isCodecError =
      error instanceof Error &&
      (error.message.includes("Unsupported configuration") ||
        error.message.includes("codec not supported"));
    if (!isCodecError) {
      console.error("Error extracting frame:", error);
    }
    throw error instanceof Error
      ? error
      : new Error("Failed to extract frame from video");
  }
}

export async function generateFilmstrip(
  videoSource: Blob | string,
  options: FilmstripOptions,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<string> {
  try {
    await work.ready();
    work.check();
    const { Input, BlobSource, UrlSource, ALL_FORMATS, CanvasSink } =
      await getMediabunny();
    work.check();
    const input = new Input({
      source:
        typeof videoSource === "string"
          ? new UrlSource(readableRendererMediaUrl(videoSource))
          : new BlobSource(videoSource),
      formats: ALL_FORMATS
    });

    return await withRendererMediaInput(input, work, async () => {
      const videoTrack = await input.getPrimaryVideoTrack();
      work.check();

      if (!videoTrack) {
        throw new Error("No video track found in the input file");
      }

      const canDecode = await videoTrack.canDecode();
      work.check();
      if (!canDecode) {
        throw new Error("Video track cannot be decoded");
      }

      const startTimestamp = await videoTrack.getFirstTimestamp();
      work.check();
      const endTimestamp = await videoTrack.computeDuration();
      work.check();
      const duration = endTimestamp - startTimestamp;

      if (duration <= 1) {
        return extractFrameFromVideo(
          {
            videoSource,
            frameNumber: 0,
            fps: options.fps
          },
          work
        );
      }

      const frameHeight = options.frameHeight || FILMSTRIP_FRAME_HEIGHT;

      const videoAspectRatio =
        videoTrack.displayWidth / videoTrack.displayHeight;
      const frameWidth = Math.floor(frameHeight * videoAspectRatio);

      const numFrames =
        options.numFrames || Math.floor(options.width / frameWidth);

      const actualNumFrames = Math.max(1, numFrames);

      const sink = new CanvasSink(videoTrack, {
        width: frameWidth
      });

      const timestamps: number[] = [];
      for (let i = 0; i < actualNumFrames; i++) {
        const progress =
          actualNumFrames > 1
            ? i / (actualNumFrames - 1)
            : SINGLE_FRAME_PROGRESS;
        timestamps.push(startTimestamp + progress * duration);
      }

      const frames: HTMLCanvasElement[] = [];
      for await (const result of sink.canvasesAtTimestamps(timestamps)) {
        work.check();
        if (!result) continue;

        if (result.canvas instanceof HTMLCanvasElement) {
          frames.push(result.canvas);
        } else if (result.canvas instanceof OffscreenCanvas) {
          const htmlCanvas = document.createElement("canvas");
          htmlCanvas.width = result.canvas.width;
          htmlCanvas.height = result.canvas.height;
          const ctx = htmlCanvas.getContext("2d");
          if (ctx) {
            const bitmap = await createImageBitmap(result.canvas);
            try {
              work.check();
              ctx.drawImage(bitmap, 0, 0);
            } finally {
              bitmap.close();
            }
            frames.push(htmlCanvas);
          }
        }
      }

      if (frames.length === 0) {
        throw new Error("No frames could be extracted from video");
      }

      const filmstripCanvas = document.createElement("canvas");
      const totalWidth = frames.reduce((sum, frame) => sum + frame.width, 0);
      const maxHeight = Math.max(...frames.map((frame) => frame.height));

      filmstripCanvas.width = totalWidth;
      filmstripCanvas.height = maxHeight;

      const ctx = filmstripCanvas.getContext("2d");
      if (!ctx) {
        throw new Error("Could not get canvas context for filmstrip");
      }

      let xOffset = 0;
      for (const frame of frames) {
        ctx.drawImage(frame, xOffset, 0);
        xOffset += frame.width;
      }

      const filmstripDataUrl = filmstripCanvas.toDataURL(
        "image/jpeg",
        FILMSTRIP_QUALITY
      );

      return filmstripDataUrl;
    });
  } catch (error) {
    work.check();
    const isCodecError =
      error instanceof Error &&
      (error.message.includes("Unsupported configuration") ||
        error.message.includes("codec not supported") ||
        error.message.includes("cannot be decoded"));
    if (!isCodecError) {
      console.error("Error generating filmstrip:", error);
    }
    throw error instanceof Error
      ? error
      : new Error("Failed to generate filmstrip from video");
  }
}
