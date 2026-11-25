import { extractFrameFromVideo } from "@app/services/mediaBunny/frameExtraction";
import { getMediabunny } from "@app/services/mediaBunny/lazyLoad";
import { withRendererMediaInput } from "@app/services/mediaBunny/withRendererMediaInput";
import { captureVideoFrame } from "@app/utils/video/captureVideoFrame";

import type { LocalVideoImport } from "../../desktop/shared/contracts";

import {
  rendererLibrary,
  type RendererLibraryWork
} from "./rendererLibraryWork";
import {
  createRendererObjectUrl,
  releaseRendererObjectUrl
} from "./rendererObjectUrl";

const DEFAULT_FPS = 30;
const PACKET_SAMPLE_COUNT = 100;

export const prepareLocalVideoImport = async (
  file: File,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<LocalVideoImport> => {
  await work.ready();
  work.check();
  const sourcePath = window.mago.files.getPath(file);
  if (!sourcePath) throw new Error(`Cannot resolve the path for ${file.name}`);

  const { Input, BlobSource, ALL_FORMATS } = await getMediabunny();
  work.check();
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS
  });
  const metadata = await withRendererMediaInput(input, work, async () => {
    const track = await input.getPrimaryVideoTrack();
    work.check();
    if (!track) throw new Error(`${file.name} does not contain a video track`);
    const canDecode = await track.canDecode();
    work.check();
    if (!canDecode) {
      throw new Error(
        `${file.name} uses a video codec this computer cannot decode`
      );
    }

    const durationSeconds = await input.computeDuration();
    work.check();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`${file.name} has an invalid duration`);
    }
    const packetStats = await track.computePacketStats(PACKET_SAMPLE_COUNT);
    work.check();
    return {
      durationSeconds,
      fps: packetStats.averagePacketRate || DEFAULT_FPS,
      width: track.displayWidth,
      height: track.displayHeight
    };
  });
  work.check();
  const { durationSeconds, fps } = metadata;

  let thumbnailDataUrl: string;
  try {
    thumbnailDataUrl = await extractFrameFromVideo(
      {
        videoSource: file,
        frameNumber: 0,
        fps
      },
      work
    );
  } catch {
    const objectUrl = createRendererObjectUrl(file, work);
    try {
      thumbnailDataUrl = await captureVideoFrame(
        {
          videoUrl: objectUrl,
          frame: 0,
          fps
        },
        work
      );
    } finally {
      releaseRendererObjectUrl(objectUrl);
    }
  }

  work.check();
  return {
    sourcePath,
    name: file.name,
    ...metadata,
    frameCount: Math.max(1, Math.round(durationSeconds * fps)),
    thumbnailDataUrl
  };
};
