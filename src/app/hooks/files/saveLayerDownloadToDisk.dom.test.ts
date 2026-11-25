import { afterEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { get }
}));
vi.mock("@/platform/localDesktop", () => ({
  isLocalApp: true,
  getLocalDesktopApi: () => window.mago
}));

import { rendererLibrary } from "@/platform/rendererLibraryWork";

import { saveLayerDownloadToDisk } from "./saveLayerDownloadToDisk";

const SIGNED_URL =
  "https://mago-s3-prod.s3.eu-north-1.amazonaws.com/a/exr.zip?X-Amz-Signature=abc";

const library = { onWillChange: async () => {}, onDidChange: () => {} };
describe("saveLayerDownloadToDisk", () => {
  afterEach(() => {
    rendererLibrary.reset();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("hands the presigned URL to the main process to save, never fetching it in the renderer", async () => {
    get.mockResolvedValue({ data: { url: SIGNED_URL } });
    const saveCloudStorageObjectAs = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("mago", { library, files: { saveCloudStorageObjectAs } });
    const rendererFetch = vi.fn();
    vi.stubGlobal("fetch", rendererFetch);

    const saved = await saveLayerDownloadToDisk({
      layerId: "layer-1",
      kind: "exr",
      suggestedName: "Render_exr.zip"
    });

    expect(saved).toBe(true);
    expect(get).toHaveBeenCalledWith("/download/exr/layer/layer-1", {
      signal: expect.any(AbortSignal)
    });
    expect(saveCloudStorageObjectAs).toHaveBeenCalledWith({
      url: SIGNED_URL,
      suggestedName: "Render_exr.zip"
    });
    expect(rendererFetch).not.toHaveBeenCalled();
  });

  it("does not open Save As when an old signed URL lookup resolves after reset", async () => {
    const signed = Promise.withResolvers<{ data: { url: string } }>();
    get.mockReturnValueOnce(signed.promise);
    const saveCloudStorageObjectAs = vi.fn();
    vi.stubGlobal("mago", { library, files: { saveCloudStorageObjectAs } });
    const save = saveLayerDownloadToDisk({
      layerId: "reused-id",
      kind: "video",
      suggestedName: "Render.mp4"
    });
    const rejected = expect(save).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    const { signal } = get.mock.calls[0][1];
    await rendererLibrary.suspend();
    rendererLibrary.reset();
    expect(signal.aborted).toBe(true);
    signed.resolve({ data: { url: SIGNED_URL } });
    await rejected;
    expect(saveCloudStorageObjectAs).not.toHaveBeenCalled();
  });
});
