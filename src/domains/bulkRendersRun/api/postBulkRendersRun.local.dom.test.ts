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

import { postBulkRendersRun } from "./postBulkRendersRun.local";

afterEach(() => vi.clearAllMocks());

describe("postBulkRendersRun (desktop)", () => {
  it("sends uploaded first frames to the cloud under their cloud asset ids", async () => {
    const work = new RendererLibrarySession().capture();
    ensureCloudImageAsset.mockImplementation(
      async (_api: unknown, localAssetId: string) => `cloud-${localAssetId}`
    );
    post.mockResolvedValue({ data: { id: "run-1", status: "PENDING" } });

    await postBulkRendersRun(
      {
        project_id: "project-1",
        timeline_ids: ["shot-1"],
        shot_overrides: {
          "shot-1": {
            images: [{ asset_id: "first-frame-1", type: "reference_frame" }]
          }
        }
      },
      work
    );

    expect(ensureCloudImageAsset).toHaveBeenCalledWith(
      expect.anything(),
      "first-frame-1",
      "project-1",
      undefined,
      work
    );
    expect(post).toHaveBeenCalledWith(
      "/agent/plans",
      expect.objectContaining({
        shot_overrides: {
          "shot-1": {
            images: [
              { asset_id: "cloud-first-frame-1", type: "reference_frame" }
            ]
          }
        }
      }),
      { signal: work.signal }
    );
  });

  it("discards a late accepted response without blocking a library switch", async () => {
    const library = new RendererLibrarySession();
    const work = library.capture();
    const response = Promise.withResolvers<{
      data: { id: string; status: string };
    }>();
    post.mockReturnValueOnce(response.promise);

    const creation = postBulkRendersRun(
      { project_id: "project-1", timeline_ids: ["shot-1"] },
      work
    );
    const rejected = expect(creation).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await library.suspend();
    library.reset();
    expect(work.signal.aborted).toBe(true);
    response.resolve({ data: { id: "accepted-run", status: "PENDING" } });

    await rejected;
    expect(post).toHaveBeenCalledOnce();
    expect(ensureCloudImageAsset).not.toHaveBeenCalled();
  });
});
