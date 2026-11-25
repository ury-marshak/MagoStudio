import { readMediaBlob } from "@domains/asset/utils/readMediaBlob";

import {
  rendererLibrary,
  type RendererLibraryWork
} from "@/platform/rendererLibraryWork";
import {
  fetchRendererMedia,
  readableRendererMediaUrl
} from "@/platform/rendererMediaAccess";

import { getMediabunny } from "./lazyLoad";
import { withRendererMediaInput } from "./withRendererMediaInput";

export const detectVideoHasAudioTrack = async (
  videoSrc: string,
  work: RendererLibraryWork = rendererLibrary.capture()
): Promise<boolean> => {
  await work.ready();
  work.check();
  const { Input, ALL_FORMATS, UrlSource, BlobSource } = await getMediabunny();
  work.check();
  videoSrc = readableRendererMediaUrl(videoSrc);

  // Mediabunny needs a BlobSource for blob URLs. Keep the body owned too.
  let blob: Blob | undefined;
  if (videoSrc.startsWith("blob:")) {
    const response = await fetchRendererMedia(videoSrc, {
      signal: work.signal
    });
    blob = await readMediaBlob(response, work.signal);
  }
  work.check();
  const input = new Input({
    source: blob ? new BlobSource(blob) : new UrlSource(videoSrc),
    formats: ALL_FORMATS
  });
  return withRendererMediaInput(
    input,
    work,
    async () => !!(await input.getPrimaryAudioTrack())
  );
};
