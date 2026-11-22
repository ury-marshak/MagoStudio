import { afterEach, describe, expect, it, vi } from "vitest";

import { RendererLibrarySession } from "@/platform/rendererLibraryWork";

const { post, ensureCloudImageAsset } = vi.hoisted(() => ({
  post: vi.fn(),
  ensureCloudImageAsset: vi.fn()
}));

vi.mock("@/lib/backend-api-client", () => ({
  backendApiClient: { post, get: vi.fn() }
}));
vi.mock("@domains/cloud/mirrorService", () => ({ ensureCloudImageAsset }));

import { createPlan } from "./createPlan.local";

afterEach(() => vi.clearAllMocks());

describe("createPlan (desktop)", () => {
  it("sends every image the plan references under its cloud asset id", async () => {
    const work = new RendererLibrarySession().capture();
    ensureCloudImageAsset.mockImplementation(
      async (_api: unknown, localAssetId: string) => `cloud-${localAssetId}`
    );
    post.mockResolvedValue({ data: { id: "plan-1" } });

    await createPlan(
      {
        project_id: "project-1",
        timeline_ids: ["shot-1", "shot-2"],
        img2img_settings: {
          mask_image_id: "mask-1",
          reference_images: ["reference-1"]
        } as never,
        shot_overrides: {
          "shot-1": {
            images: [{ asset_id: "first-frame-1", type: "reference_frame" }]
          },
          "shot-2": {}
        }
      },
      work
    );

    expect(ensureCloudImageAsset.mock.calls).toEqual(
      ["mask-1", "reference-1", "first-frame-1"].map((assetId) => [
        expect.anything(),
        assetId,
        "project-1",
        undefined,
        work
      ])
    );
    expect(post).toHaveBeenCalledWith(
      "/agent/plans",
      {
        project_id: "project-1",
        timeline_ids: ["shot-1", "shot-2"],
        img2img_settings: {
          mask_image_id: "cloud-mask-1",
          reference_images: ["cloud-reference-1"]
        },
        shot_overrides: {
          "shot-1": {
            images: [
              { asset_id: "cloud-first-frame-1", type: "reference_frame" }
            ]
          },
          "shot-2": {}
        }
      },
      { signal: work.signal }
    );
  });

  it("does not mirror the next image or post after a late mirror from a replaced library", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const mirror = Promise.withResolvers<string>();
    ensureCloudImageAsset.mockReturnValueOnce(mirror.promise);

    const creation = createPlan(
      {
        project_id: "project-1",
        timeline_ids: ["shot-1"],
        shot_overrides: {
          "shot-1": {
            images: [
              { asset_id: "first-frame-1", type: "reference_frame" },
              { asset_id: "reference-2", type: "reference_frame" }
            ]
          }
        }
      },
      work
    );
    const rejected = expect(creation).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(ensureCloudImageAsset).toHaveBeenCalledOnce();
    await library.suspend();
    library.reset();
    mirror.resolve("cloud-first-frame-1");

    await rejected;
    expect(ensureCloudImageAsset).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
  });
});
