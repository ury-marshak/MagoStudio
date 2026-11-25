import { beforeEach, describe, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import { readVideoDurationSeconds } from "./readVideoDurationSeconds";

const VIDEO_URL = "https://example.com/shot.mp4";

describe("readVideoDurationSeconds", () => {
  let mockVideo: HTMLVideoElement;
  let listeners: Record<string, () => void>;

  const fireLoadedMetadataWith = (duration: number) => {
    Object.defineProperty(mockVideo, "duration", {
      value: duration,
      configurable: true
    });
    listeners.loadedmetadata?.();
  };

  beforeEach(() => {
    listeners = {};

    mockVideo = {
      preload: "",
      src: "",
      duration: 0,
      load: vi.fn(),
      removeAttribute: vi.fn(() => {
        mockVideo.src = "";
      }),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeEventListener: vi.fn((event: string) => {
        delete listeners[event];
      })
    } as unknown as HTMLVideoElement;

    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string
    ) =>
      tagName === "video"
        ? mockVideo
        : ({} as unknown as HTMLElement)) as never);
  });

  it("reports the duration the browser read from the metadata", async () => {
    const durationSeconds = readVideoDurationSeconds(VIDEO_URL);
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    fireLoadedMetadataWith(3.25);

    await expect(durationSeconds).resolves.toBe(3.25);
  });

  it("asks only for metadata, not for the whole file", async () => {
    const duration = readVideoDurationSeconds(VIDEO_URL);
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    fireLoadedMetadataWith(3);
    await duration;

    expect(mockVideo.preload).toBe("metadata");
  });

  it("refuses a duration it cannot lay out with", async () => {
    const infiniteDuration = readVideoDurationSeconds(VIDEO_URL);
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    fireLoadedMetadataWith(Infinity);
    await expect(infiniteDuration).rejects.toThrow("unusable duration");

    const zeroDuration = readVideoDurationSeconds(VIDEO_URL);
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    fireLoadedMetadataWith(0);
    await expect(zeroDuration).rejects.toThrow("unusable duration");
  });

  it("rejects when the video fails to load", async () => {
    const durationSeconds = readVideoDurationSeconds(VIDEO_URL);
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    listeners.error?.();

    await expect(durationSeconds).rejects.toThrow(
      "Could not read the duration"
    );
  });

  it("detaches the source so a pending request cannot outlive the probe", async () => {
    const durationSeconds = readVideoDurationSeconds(VIDEO_URL);
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    fireLoadedMetadataWith(3);
    await durationSeconds;

    expect(mockVideo.src).toBe("");
    expect(mockVideo.removeEventListener).toHaveBeenCalledWith(
      "loadedmetadata",
      expect.any(Function)
    );
  });

  it("retires the native element and rejects even queued metadata after a switch", async () => {
    const session = new RendererLibrarySession();
    const work = session.capture();
    const url = "mago-media://asset/reused";
    const pending = readVideoDurationSeconds(url, work);
    const refused = expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.waitFor(() => expect(listeners.loadedmetadata).toBeDefined());
    expect(mockVideo.src).toBe(url);
    const queuedMetadata = listeners.loadedmetadata;

    await session.suspend();
    session.reset();
    expect(listeners).toEqual({});
    expect(mockVideo.src).toBe("");
    expect(mockVideo.load).toHaveBeenCalledTimes(2);
    queuedMetadata?.();
    await refused;

    await expect(readVideoDurationSeconds(url, work)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(document.createElement).toHaveBeenCalledOnce();
    expect(mockVideo.load).toHaveBeenCalledTimes(2);
  });
});
