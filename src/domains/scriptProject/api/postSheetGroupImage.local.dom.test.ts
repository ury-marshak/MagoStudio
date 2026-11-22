import { afterEach, describe, expect, it, vi } from "vitest";

const { post, ensureCloudImageAsset } = vi.hoisted(() => ({
  post: vi.fn(),
  ensureCloudImageAsset: vi.fn()
}));

vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { post, get: vi.fn() }
}));
vi.mock("@domains/cloud/mirrorService", () => ({ ensureCloudImageAsset }));

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

import { postSheetGroupImage } from "./postSheetGroupImage.local";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("postSheetGroupImage (desktop)", () => {
  it("files a cloud project's uploaded entity image under its cloud asset id", async () => {
    vi.stubGlobal("mago", {
      account: { mode: "cloud" },
      projects: { get: vi.fn().mockResolvedValue({ origin: "cloud" }) }
    });
    ensureCloudImageAsset.mockResolvedValue("cloud-asset-1");
    post.mockResolvedValue({
      data: { token: "baker", name: "Baker", layer_id: "layer-1", images: [] }
    });

    const work = new RendererLibrarySession().capture();
    await postSheetGroupImage(
      {
        projectId: "project-1",
        timelineId: "sheets-1",
        token: "baker",
        assetId: "local-asset-1"
      },
      work
    );

    expect(ensureCloudImageAsset).toHaveBeenCalledWith(
      expect.anything(),
      "local-asset-1",
      "project-1",
      undefined,
      work
    );
    expect(post).toHaveBeenCalledWith(
      "/timelines/sheets-1/sheets/baker/images",
      { asset_id: "cloud-asset-1" },
      { signal: work.signal }
    );
  });

  it("keeps a local project's entity image on the desktop", async () => {
    const update = vi.fn().mockResolvedValue({
      token: "baker",
      name: "Baker",
      layer_id: "layer-1",
      images: []
    });
    vi.stubGlobal("mago", {
      account: { mode: "cloud" },
      projects: { get: vi.fn().mockResolvedValue({ origin: "local" }) },
      scriptProjects: { update }
    });

    await postSheetGroupImage({
      projectId: "project-1",
      timelineId: "sheets-1",
      token: "baker",
      assetId: "local-asset-1"
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "add-sheet-image",
        payload: { token: "baker", assetId: "local-asset-1" }
      })
    );
    expect(ensureCloudImageAsset).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it("ignores a late accepted image response without retrying", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const accepted = Promise.withResolvers<{ data: object }>();
    const dispatched = Promise.withResolvers<void>();
    vi.stubGlobal("mago", {
      projects: { get: vi.fn().mockResolvedValue({ origin: "cloud" }) }
    });
    ensureCloudImageAsset.mockResolvedValue("cloud-asset-1");
    post.mockImplementationOnce(() => {
      dispatched.resolve();
      return accepted.promise;
    });
    const submission = postSheetGroupImage(
      {
        projectId: "project-1",
        timelineId: "sheets-1",
        token: "baker",
        assetId: "local-asset-1"
      },
      work
    );
    const stale = expect(submission).rejects.toMatchObject({
      name: "AbortError"
    });
    await dispatched.promise;
    await library.suspend();
    library.reset();
    expect(post.mock.calls[0]?.[2]).toEqual({ signal: work.signal });
    accepted.resolve({
      data: { token: "baker", name: "Baker", layer_id: "layer-1" }
    });
    await stale;
    expect(post).toHaveBeenCalledTimes(1);
  });
});
