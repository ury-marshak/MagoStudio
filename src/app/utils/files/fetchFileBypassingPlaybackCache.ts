import { fetchRendererMedia } from "@/platform/rendererMediaAccess";

export const fetchFileBypassingPlaybackCache = (
  url: string
): Promise<Response> => fetchRendererMedia(url, { cache: "no-store" });
