import { toDesktopCloudStorageUrl } from "@domains/asset/utils/toDesktopCloudStorageUrl";

import { isCloudAccountActive } from "./cloudAccount";

export class RendererNetworkPolicyError extends Error {
  constructor() {
    super(
      "Remote renderer requests require an explicit cloud account choice. Cached local media remains available."
    );
    this.name = "RendererNetworkPolicyError";
  }
}

/** Permission at use time, not a transform of persisted project/history URLs. */
export const readableRendererMediaUrl = (url: string): string => {
  if (!isCloudAccountActive()) {
    let parsed: URL;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      throw new RendererNetworkPolicyError();
    }
    const local =
      parsed.protocol === "blob:" ||
      parsed.protocol === "data:" ||
      (parsed.protocol === "mago-media:" &&
        parsed.hostname !== "cloud-storage") ||
      ((parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.origin === window.location.origin);
    if (!local) throw new RendererNetworkPolicyError();
  }
  return url;
};

/** Check synchronously at dispatch, including after a caller's queue/cache awaits. */
export const fetchRendererMedia = async (
  url: string,
  init?: RequestInit
): Promise<Response> => {
  const readableUrl = readableRendererMediaUrl(url);
  return init === undefined ? fetch(readableUrl) : fetch(readableUrl, init);
};

/** Preserve the existing signed-storage proxy route only at its desktop-aware callers. */
export const readableDesktopStorageUrl = (url: string): string =>
  readableRendererMediaUrl(toDesktopCloudStorageUrl(url));
