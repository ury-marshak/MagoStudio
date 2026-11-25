import { Layer } from "@schemas/layer";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rendererLibrary } from "@/platform/rendererLibraryWork";

const {
  downloadLayerVideo,
  isTrackOwnedByCloud,
  saveLayerDownloadToDisk,
  saveTrackVideoToDisk,
  triggerBlobDownload
} = vi.hoisted(() => ({
  downloadLayerVideo: vi.fn(),
  isTrackOwnedByCloud: vi.fn(),
  saveLayerDownloadToDisk: vi.fn(),
  saveTrackVideoToDisk: vi.fn(),
  triggerBlobDownload: vi.fn()
}));

vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => window.mago
}));
vi.mock("@domains/track/utils/isTrackOwnedByCloud", () => ({
  isTrackOwnedByCloud
}));
vi.mock("@hooks/files/downloadFiles", () => ({ downloadLayerVideo }));
vi.mock("@hooks/files/saveLayerDownloadToDisk", () => ({
  saveLayerDownloadToDisk
}));
vi.mock("@hooks/files/saveTrackVideoToDisk", () => ({ saveTrackVideoToDisk }));
vi.mock("@hooks/files/utils", () => ({ triggerBlobDownload }));
vi.mock("@hooks/tracking/trackingUtils", () => ({
  trackingUtils: { exportActions: { exportMedias: vi.fn() } }
}));
vi.mock("@store/useToast", () => ({
  useToast: () => ({ showToast: vi.fn() })
}));

import { useDownloadImageToVideoRender } from "./useDownloadImageToVideoRender";

const renderTrack = {
  id: "track-1",
  name: "Render",
  layer_order: 0,
  clips: [{ asset_id: "asset-1" }]
} as unknown as Layer;

const stubMirroredAsset = (assetData: Record<string, unknown> | null) => {
  vi.stubGlobal("mago", {
    account: { mode: "offline" },
    library: { onWillChange: async () => {}, onDidChange: () => {} },
    assets: {
      get: vi
        .fn()
        .mockResolvedValue(
          assetData ? { id: "asset-1", filepath: "", data: assetData } : null
        )
    }
  });
};

const downloadRender = async () => {
  const { result } = renderHook(() =>
    useDownloadImageToVideoRender(renderTrack, "project-1")
  );
  await act(() => result.current.downloadRenderVideo());
};

describe("useDownloadImageToVideoRender in the desktop app", () => {
  afterEach(() => {
    vi.clearAllMocks();
    rendererLibrary.reset();
    vi.unstubAllGlobals();
  });

  it("saves a local track's render from the library", async () => {
    isTrackOwnedByCloud.mockResolvedValue(false);
    stubMirroredAsset(null);

    await downloadRender();

    expect(saveTrackVideoToDisk).toHaveBeenCalledWith(
      {
        track: renderTrack,
        fileName: "Render.mp4"
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(saveLayerDownloadToDisk).not.toHaveBeenCalled();
    expect(triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("saves a cloud track's render from the mirror's downloaded file", async () => {
    isTrackOwnedByCloud.mockResolvedValue(true);
    stubMirroredAsset({ cloudMirror: true, status: "ingested" });

    await downloadRender();

    expect(saveTrackVideoToDisk).toHaveBeenCalledWith(
      {
        track: renderTrack,
        fileName: "Render.mp4"
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(saveLayerDownloadToDisk).not.toHaveBeenCalled();
    expect(downloadLayerVideo).not.toHaveBeenCalled();
  });

  it("saves a cloud track's render from cloud storage through the save dialog when the mirror has no file yet", async () => {
    isTrackOwnedByCloud.mockResolvedValue(true);
    stubMirroredAsset({ cloudMirror: true, status: "created" });

    await downloadRender();

    expect(saveLayerDownloadToDisk).toHaveBeenCalledWith(
      {
        layerId: "track-1",
        kind: "video",
        suggestedName: "Render.mp4"
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(saveTrackVideoToDisk).not.toHaveBeenCalled();
    expect(triggerBlobDownload).not.toHaveBeenCalled();
  });

  it("does not look up or save the render after an old ownership read settles", async () => {
    const ownership = Promise.withResolvers<boolean>();
    isTrackOwnedByCloud.mockReturnValueOnce(ownership.promise);
    stubMirroredAsset({ cloudMirror: true, status: "ingested" });
    const { result } = renderHook(() =>
      useDownloadImageToVideoRender(renderTrack, "project-1")
    );
    let saving!: Promise<void>;
    await act(async () => {
      saving = result.current.downloadRenderVideo();
      await vi.waitFor(() =>
        expect(isTrackOwnedByCloud).toHaveBeenCalledOnce()
      );
    });
    await act(async () => {
      await rendererLibrary.suspend();
      rendererLibrary.reset();
      ownership.resolve(true);
      await saving;
    });
    expect(window.mago.assets.get).not.toHaveBeenCalled();
    expect(saveTrackVideoToDisk).not.toHaveBeenCalled();
    expect(saveLayerDownloadToDisk).not.toHaveBeenCalled();
    expect(result.current.isDownloadingRenderVideo).toBe(false);
  });
});
