import { toDesktopCloudStorageUrl } from "@domains/asset/utils/toDesktopCloudStorageUrl";

import { isCloudAccountActive } from "./cloudAccount";
import { captureRendererAccountProfile } from "./rendererAccountProfile";

export class RendererNetworkPolicyError extends Error {
  constructor() {
    super(
      "Remote renderer requests require an explicit cloud account choice. Cached local media remains available."
    );
    this.name = "RendererNetworkPolicyError";
  }
}

const isLocalRendererMedia = (url: string): boolean => {
  const parsed = new URL(url, window.location.href);
  return (
    parsed.protocol === "blob:" ||
    parsed.protocol === "data:" ||
    (parsed.protocol === "mago-media:" &&
      parsed.hostname !== "cloud-storage") ||
    ((parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin === window.location.origin)
  );
};

/** Permission at use time, not a transform of persisted project/history URLs. */
export const readableRendererMediaUrl = (url: string): string => {
  if (!isCloudAccountActive()) {
    try {
      if (isLocalRendererMedia(url)) return url;
    } catch {
      // Malformed input is not an allowed local resource.
    }
    throw new RendererNetworkPolicyError();
  }
  return url;
};

/** Check synchronously at dispatch, including after a caller's queue/cache awaits. */
export const fetchRendererMedia = async (
  url: string,
  init?: RequestInit
): Promise<Response> => {
  const readableUrl = readableRendererMediaUrl(url);
  const profile =
    typeof window !== "undefined" &&
    window.mago &&
    !isLocalRendererMedia(readableUrl)
      ? captureRendererAccountProfile()
      : undefined;
  if (!profile)
    return init === undefined ? fetch(readableUrl) : fetch(readableUrl, init);
  const signal = init?.signal
    ? AbortSignal.any([profile, init.signal])
    : profile;
  signal.throwIfAborted();
  const response = await fetch(readableUrl, { ...init, signal });
  if (signal.aborted) {
    await response.body?.cancel(signal.reason);
    signal.throwIfAborted();
  }
  return response;
};

/** Preserve the existing signed-storage proxy route only at its desktop-aware callers. */
export const readableDesktopStorageUrl = (url: string): string =>
  readableRendererMediaUrl(toDesktopCloudStorageUrl(url));
