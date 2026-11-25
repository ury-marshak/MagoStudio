import { useCachedImageUrl } from "@domains/asset/useCachedImageUrl";
import { useCachedVideoUrl } from "@domains/asset/useCachedVideoUrl";
import { cacheGet } from "@domains/asset/utils/cacheStorage";
import { useCutShotDurations } from "@domains/scriptProject/useCutShotDurations";
import { usePreviewHasAudioTrack } from "@home/components/VideoPreview/hooks/usePreviewHasAudioTrack";
import { type CutShot } from "@schemas/scriptProject";
import { currentVideoSrcAtom } from "@store/atoms/currentVideoSrcAtom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { type PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { rendererLibrary } from "./rendererLibraryWork";

vi.mock("./localDesktop", () => ({ isLocalApp: false }));
vi.mock("@domains/asset/utils/cacheStorage", () => ({ cacheGet: vi.fn() }));
vi.mock("@domains/track/useSelectedTrackIds", () => ({
  useSelectedTrackIds: () => ["track"]
}));
const probe = vi.hoisted(() => vi.fn());
vi.mock("@app/services/mediaBunny/detectVideoHasAudioTrack", () => ({
  detectVideoHasAudioTrack: probe
}));

const url = "mago-media://asset/reused";
const shot: CutShot = {
  timeline_id: "track",
  shot_index: 0,
  sequence_id: null,
  asset_id: "reused",
  pinned_asset_id: null,
  is_upscale: false,
  url,
  poster_url: null,
  versions: []
};

const provider = () => {
  const client = new QueryClient();
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  return { wrapper, store };
};

const switchLibrary = async () => {
  await act(async () => {
    await rendererLibrary.suspend();
  });
  await act(async () => {
    rendererLibrary.reset();
  });
};

afterEach(async () => {
  cleanup();
  await switchLibrary();
  vi.restoreAllMocks();
});

it("measures the same asset ID and URL again in a new library", async () => {
  const { wrapper } = provider();
  let seconds = 3;
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockImplementation(
    () => seconds
  );
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(function (this: HTMLMediaElement) {
      if (this.hasAttribute("src"))
        queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
    });
  const { result } = renderHook(() => useCutShotDurations([shot]), { wrapper });
  await waitFor(() =>
    expect(result.current.durationSecondsByAssetId).toEqual({ reused: 3 })
  );

  seconds = 8;
  await switchLibrary();
  await waitFor(() =>
    expect(result.current.durationSecondsByAssetId).toEqual({ reused: 8 })
  );
  expect(load).toHaveBeenCalledTimes(4); // open and detach in each library
});

it("does not reprobe a retained audio source until the replacement publishes its own source", async () => {
  const { wrapper, store } = provider();
  const old = rendererLibrary.capture();
  store.set(currentVideoSrcAtom, { track: { url, signal: old.signal } });
  probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { result } = renderHook(usePreviewHasAudioTrack, { wrapper });
  await waitFor(() =>
    expect(result.current).toEqual({ hasAudioTrack: false, isResolved: true })
  );

  await switchLibrary();
  expect(result.current.isResolved).toBe(false);
  expect(probe).toHaveBeenCalledOnce();

  const current = rendererLibrary.capture();
  act(() =>
    store.set(currentVideoSrcAtom, { track: { url, signal: current.signal } })
  );
  await waitFor(() =>
    expect(result.current).toEqual({ hasAudioTrack: true, isResolved: true })
  );
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenLastCalledWith(
    url,
    expect.objectContaining({ signal: current.signal })
  );
});

it.each([
  ["image", (url: string) => useCachedImageUrl(url, "reused")],
  ["video", useCachedVideoUrl]
] as const)(
  "replaces an owned %s object URL and does not revoke it twice",
  async (_kind, useCachedUrl) => {
    const { wrapper } = provider();
    const first = "blob:old-library";
    const second = "blob:new-library";
    vi.mocked(cacheGet).mockResolvedValue(new Blob(["cached"]));
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const hook = renderHook(
      () => useCachedUrl("https://fixture.invalid/asset"),
      { wrapper }
    );
    await waitFor(() => expect(hook.result.current).toBe(first));
    await switchLibrary();
    await waitFor(() => expect(hook.result.current).toBe(second));
    expect(revoke.mock.calls).toEqual([[first]]);
    hook.unmount();
    await switchLibrary();
    expect(revoke.mock.calls).toEqual([[first], [second]]);
  }
);
