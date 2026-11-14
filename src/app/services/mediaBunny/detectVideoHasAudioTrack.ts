import {
  fetchRendererMedia,
  readableRendererMediaUrl
} from "@/platform/rendererMediaAccess";

import { getMediabunny } from "./lazyLoad";

type Mediabunny = Awaited<ReturnType<typeof getMediabunny>>;

const isObjectUrl = (videoSrc: string) => videoSrc.startsWith("blob:");

const sourceFor = async (
  videoSrc: string,
  { UrlSource, BlobSource }: Mediabunny
) => {
  videoSrc = readableRendererMediaUrl(videoSrc);
  if (!isObjectUrl(videoSrc)) return new UrlSource(videoSrc);

  const response = await fetchRendererMedia(videoSrc);
  return new BlobSource(await response.blob());
};

export const detectVideoHasAudioTrack = async (
  videoSrc: string
): Promise<boolean> => {
  const mediabunny = await getMediabunny();
  const { Input, ALL_FORMATS } = mediabunny;

  const input = new Input({
    source: await sourceFor(videoSrc, mediabunny),
    formats: ALL_FORMATS
  });

  const audioTrack = await input.getPrimaryAudioTrack();

  return !!audioTrack;
};
