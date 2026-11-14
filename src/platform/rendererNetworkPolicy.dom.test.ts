import { useIsImagePortrait } from "@hooks/useIsImagePortrait";
import { act, renderHook } from "@testing-library/react";
import { cropImageToNormalizedRect } from "@utils/image/cropImageToNormalizedRect";
import { resizeImageFromUrl } from "@utils/image/resizeImage";
import { captureVideoFrame } from "@utils/video/captureVideoFrame";
import { readVideoDurationSeconds } from "@utils/video/readVideoDurationSeconds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@domains/asset/utils/cacheStorage", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn()
}));
const media = vi.hoisted(() => ({
  UrlSource: vi.fn(),
  Input: vi.fn(),
  BlobSource: vi.fn()
}));
vi.mock("@app/services/mediaBunny/lazyLoad", () => ({
  getMediabunny: async () => ({ ...media, ALL_FORMATS: [] })
}));

import { loadImageElement } from "@app/services/canvas/loadImageElement";
import { detectVideoHasAudioTrack } from "@app/services/mediaBunny/detectVideoHasAudioTrack";
import {
  extractFrameFromVideo,
  generateFilmstrip
} from "@app/services/mediaBunny/frameExtraction";
import { fetchFileBypassingPlaybackCache } from "@app/utils/files/fetchFileBypassingPlaybackCache";
import { cacheImageUrl } from "@domains/asset/utils/cacheImageUrl";
import { cacheGet } from "@domains/asset/utils/cacheStorage";
import { cacheVideoUrl } from "@domains/asset/utils/cacheVideoUrl";
import { downloadImageBlob } from "@domains/asset/utils/downloadImageBlob";
import { downloadVideoInChunks } from "@domains/asset/utils/downloadVideoInChunks";
import { imageUrlToBase64 } from "@domains/asset/utils/imageUrlToBase64";

import { readableDesktopStorageUrl } from "./rendererMediaAccess";

const remote = "https://historical.invalid/saved-output.mp4";
const fetchTrap = vi.fn();
const setMode = (mode: unknown) => {
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { account: { mode } }
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cacheGet).mockResolvedValue(undefined);
  fetchTrap.mockResolvedValue(
    new Response("fixture", { headers: { "content-type": "video/mp4" } })
  );
  vi.stubGlobal("fetch", fetchTrap);
  setMode("offline");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { mago?: unknown }).mago;
});

const readers: Array<[string, (url: string) => Promise<unknown>]> = [
  ["uncached export download", (url) => fetchFileBypassingPlaybackCache(url)],
  ["image download", (url) => downloadImageBlob(url, "policy-image")],
  [
    "video download",
    (url) =>
      downloadVideoInChunks(
        url,
        undefined,
        "policy-video",
        new AbortController().signal
      )
  ],
  ["base64 conversion", (url) => imageUrlToBase64(url)],
  ["resized image", (url) => imageUrlToBase64(url, 256)],
  ["image cache fallback", (url) => cacheImageUrl(url, "policy-image")],
  ["video cache fallback", (url) => cacheVideoUrl(url, "policy-video")],
  ["audio probe", (url) => detectVideoHasAudioTrack(url)],
  [
    "frame extraction",
    (url) =>
      extractFrameFromVideo({ videoSource: url, frameNumber: 0, fps: 24 })
  ],
  ["filmstrip", (url) => generateFilmstrip(url, { width: 100, fps: 24 })],
  ["canvas image", (url) => loadImageElement(url)],
  ["video duration", (url) => readVideoDurationSeconds(url)],
  [
    "native video frame",
    (url) => captureVideoFrame({ videoUrl: url, frame: 0 })
  ],
  [
    "image crop",
    (url) =>
      cropImageToNormalizedRect({
        imageSrc: url,
        crop: { x: 0, y: 0, width: 1, height: 1 }
      })
  ],
  ["native image resize", (url) => resizeImageFromUrl(url)]
];

describe("renderer media dispatch", () => {
  it.each(readers)(
    "refuses account-free %s before transport/native media sources",
    async (_name, read) => {
      await expect(read(remote)).rejects.toThrow("explicit cloud account");
      expect(fetchTrap).not.toHaveBeenCalled();
      expect(media.UrlSource).not.toHaveBeenCalled();
    }
  );
  it.each([undefined, null, "unchosen", "CLOUD", "cloud "])(
    "does not authorize a historical URL in mode %s",
    async (mode) => {
      setMode(mode);
      await expect(fetchFileBypassingPlaybackCache(remote)).rejects.toThrow(
        "explicit cloud account"
      );
      expect(fetchTrap).not.toHaveBeenCalled();
    }
  );
  it.each([
    "mago-media://asset/output",
    "mago-media://script-project/output",
    "blob:http://localhost/local",
    "data:video/mp4;base64,AA==",
    "/local-fixture.mp4"
  ])("keeps local media %s fetchable", async (url) => {
    await fetchFileBypassingPlaybackCache(url);
    expect(fetchTrap).toHaveBeenCalledExactlyOnceWith(url, {
      cache: "no-store"
    });
  });
  it("does not treat the historical cloud-storage proxy as a local file", async () => {
    await expect(
      fetchFileBypassingPlaybackCache(
        `mago-media://cloud-storage/?url=${encodeURIComponent(remote)}`
      )
    ).rejects.toThrow("explicit cloud account");
    expect(fetchTrap).not.toHaveBeenCalled();
  });
  it.each(["cloud", "web"])(
    "preserves deliberate %s remote media reads",
    async (mode) => {
      if (mode === "web") delete (window as { mago?: unknown }).mago;
      else setMode(mode);
      await fetchFileBypassingPlaybackCache(remote);
      expect(fetchTrap).toHaveBeenCalledExactlyOnceWith(remote, {
        cache: "no-store"
      });
    }
  );
  it("serves an already cached historical image/video without remote access", async () => {
    vi.mocked(cacheGet).mockResolvedValue(new Blob(["cached output"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-output");
    expect(await cacheImageUrl(remote, "cached-image")).toEqual({
      urlToUse: "blob:cached-output",
      isCached: true
    });
    expect(await cacheVideoUrl(remote, "cached-video")).toEqual({
      urlToUse: "blob:cached-output",
      isCached: true
    });
    expect(fetchTrap).not.toHaveBeenCalled();
  });
  it.each([
    "http://remote.invalid/file",
    "//remote.invalid/file",
    "file:///private/file",
    "javascript:alert(1)"
  ])("refuses nonlocal media %s before transport", async (url) => {
    await expect(fetchFileBypassingPlaybackCache(url)).rejects.toThrow(
      "explicit cloud account"
    );
    expect(fetchTrap).not.toHaveBeenCalled();
  });
  it("rechecks account permission after a delayed cache miss", async () => {
    setMode("cloud");
    let release!: (value: undefined) => void;
    vi.mocked(cacheGet).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = cacheImageUrl(remote, "delayed-cache");
    const refused = expect(pending).rejects.toThrow("explicit cloud account");
    setMode("offline");
    release(undefined);
    await refused;
    expect(fetchTrap).not.toHaveBeenCalled();
  });
  it("keeps cloud-mode S3 media routed through the main storage protocol", async () => {
    setMode("cloud");
    const url = "https://mago-s3-prod.s3.amazonaws.com/output.mp4";
    expect(readableDesktopStorageUrl(url)).toBe(
      `mago-media://cloud-storage/?url=${encodeURIComponent(url)}`
    );
  });
});

it("does not load a remote image for orientation, but still measures local images", () => {
  const image = {
    src: "",
    naturalWidth: 10,
    naturalHeight: 20,
    onload: () => {}
  };
  const construct = vi.fn(function () {
    return image;
  });
  vi.stubGlobal("Image", construct);
  const hook = renderHook(({ url }) => useIsImagePortrait(url), {
    initialProps: { url: remote }
  });
  expect(construct).not.toHaveBeenCalled();
  expect(hook.result.current).toBeUndefined();
  hook.rerender({ url: "mago-media://thumbnail/local" });
  expect(construct).toHaveBeenCalledOnce();
  expect(image.src).toBe("mago-media://thumbnail/local");
  act(() => image.onload());
  expect(hook.result.current).toBe(true);
});
