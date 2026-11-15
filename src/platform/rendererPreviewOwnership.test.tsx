import { useMediaBunnyFilmstrip } from "@app/hooks/preview/useMediaBunnyFilmstrip";
import { useVideoFrame } from "@domains/asset/useVideoFrame";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  queries: [] as any[],
  frame: vi.fn(),
  filmstrip: vi.fn(),
  saveFrame: vi.fn(),
  saveFilmstrip: vi.fn()
}));
vi.mock("@/platform/localDesktop", () => ({ isLocalApp: false }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    fixture.queries.push(options);
    return { data: null, isLoading: false };
  }
}));
vi.mock("@domains/asset/useVideoAsset", () => ({
  useVideoAsset: () => ({
    data: {
      urlToUse: "mago-media://asset/reused",
      asset: { data: { status: "ingested" }, updated_at: "fixture" }
    },
    isLoading: false
  })
}));
vi.mock("@domains/asset/utils/frameCache", () => ({
  getFrameFromCache: async () => null,
  saveFrameToCache: fixture.saveFrame
}));
vi.mock("@domains/asset/utils/filmstripCache", () => ({
  getFilmstripFromCache: async () => null,
  saveFilmstripToCache: fixture.saveFilmstrip
}));
vi.mock("@app/services/mediaBunny", () => ({
  extractFrameFromVideo: vi.fn(),
  generateFilmstrip: vi.fn()
}));

import { rendererLibrary } from "./rendererLibraryWork";

function useFrameFixture() {
  return useVideoFrame({ assetId: "reused", fps: 24, frameNumber: 0 });
}
function useFilmstripFixture() {
  return useMediaBunnyFilmstrip({
    assetId: "reused",
    trackId: "track",
    width: 300,
    fps: 24,
    enabled: true
  });
}
const cases = [
  {
    kind: "frame",
    render: useFrameFixture,
    call: fixture.frame,
    save: fixture.saveFrame
  },
  {
    kind: "filmstrip",
    render: useFilmstripFixture,
    call: fixture.filmstrip,
    save: fixture.saveFilmstrip
  }
];
const generation = (kind: string) =>
  fixture.queries
    .filter((query) => query.queryKey[0] === `${kind}-generate`)
    .at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.queries.length = 0;
  fixture.frame.mockResolvedValue("data:new-frame");
  fixture.filmstrip.mockResolvedValue("data:new-filmstrip");
  fixture.saveFrame.mockResolvedValue(undefined);
  fixture.saveFilmstrip.mockResolvedValue(undefined);
  window.mago = {
    assets: {
      extractVideoFrame: fixture.frame,
      generateVideoFilmstrip: fixture.filmstrip
    }
  } as unknown as typeof window.mago;
});
afterEach(async () => {
  await act(async () => {
    await rendererLibrary.suspend();
    rendererLibrary.reset();
  });
});

it.each(cases)(
  "freezes $kind ownership before a queued query/retry and refreshes its key after replacement",
  async (test) => {
    renderHook(test.render);
    const old = generation(test.kind);
    await act(async () => {
      await rendererLibrary.suspend();
    });
    expect(generation(test.kind).enabled).toBe(false);
    await act(async () => {
      rendererLibrary.reset();
    });
    await expect(old.queryFn()).rejects.toMatchObject({ name: "AbortError" });
    expect(test.call).not.toHaveBeenCalled();
    const replacement = generation(test.kind);
    expect(replacement.queryKey).not.toEqual(old.queryKey);
    await expect(replacement.queryFn()).resolves.toBe(`data:new-${test.kind}`);
    expect(test.call).toHaveBeenCalledOnce();
    expect(test.save).toHaveBeenCalledOnce();
  }
);

it.each(cases)(
  "does not cache or publish a late $kind IPC result after replacement",
  async (test) => {
    let finish!: (value: string) => void;
    test.call.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      })
    );
    renderHook(test.render);
    const request = generation(test.kind).queryFn();
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError"
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(test.call).toHaveBeenCalledOnce();
    await act(async () => {
      await rendererLibrary.suspend();
      rendererLibrary.reset();
    });
    finish("data:old-library");
    await rejected;
    expect(test.save).not.toHaveBeenCalled();
  }
);
