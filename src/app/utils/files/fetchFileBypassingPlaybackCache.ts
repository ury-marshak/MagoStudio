import { fetchRendererMedia } from "@/platform/rendererMediaAccess";

export const fetchFileBypassingPlaybackCache = (
  url: string,
  signal?: AbortSignal
): Promise<Response> =>
  fetchRendererMedia(
    url,
    signal ? { cache: "no-store", signal } : { cache: "no-store" }
  );
