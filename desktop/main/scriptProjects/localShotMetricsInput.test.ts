import { describe, expect, it, vi } from "vitest";

import { LocalScriptProjectService } from "./localScriptProjectService";

const setup = (version: Record<string, unknown>) => {
  const snapshot = {
    state: {
      shots: [
        {
          video_prompt: "NEW unsaved intent",
          references: { characters: [{ asset_id: "new-sheet" }] }
        }
      ]
    },
    cut: {
      shots: [{ versions: [{ asset_id: "video", ready: true, ...version }] }]
    }
  };
  const write = vi.fn(async () => undefined);
  const evaluate = vi.fn(async () => ({ vid_score: 8, vid_pass: true }));
  const resolveMediaPath = vi.fn(async (id: string) => `saved/${id}`);
  const service = new LocalScriptProjectService(
    { get: async () => ({ origin: "local" }) } as never,
    {
      get: async () => snapshot,
      listProjectIds: async () => ["project"],
      resolveMediaPath,
      getMediaMetrics: async () => null,
      putMediaMetrics: write
    } as never,
    async () => "http://localhost:8188",
    undefined,
    undefined,
    undefined,
    evaluate
  );
  return { service, evaluate, write, resolveMediaPath };
};

describe("immutable local video evaluation inputs", () => {
  it("uses the composed render prompt and original numbered references", async () => {
    const test = setup({
      metrics_input: {
        prompt: "Original composed prompt",
        duration_s: 6,
        reference_asset_ids: ["old-sheet", "continuity-frame", "old-sheet"]
      }
    });
    await test.service.getRenderMetrics("video");
    await vi.waitFor(() =>
      expect(test.evaluate).toHaveBeenCalledWith(
        {
          sourcePath: "saved/video",
          prompt: "Original composed prompt",
          durationSeconds: 6,
          referencePaths: ["saved/old-sheet", "saved/continuity-frame"]
        },
        test.service.captureMetricsSession()
      )
    );
    expect(test.resolveMediaPath).not.toHaveBeenCalledWith("new-sheet");
  });
  it("backfills old versions from saved render specs", async () => {
    const test = setup({
      render_spec: {
        video_prompt: "Old prompt",
        references: { characters: ["old-sheet"] }
      },
      input_settings: { duration_s: 5 }
    });
    await test.service.getRenderMetrics("video");
    await vi.waitFor(() =>
      expect(test.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Old prompt",
          referencePaths: ["saved/old-sheet"]
        }),
        test.service.captureMetricsSession()
      )
    );
  });
  it("fails explicitly when an old version lacks saved inputs", async () => {
    const test = setup({});
    await test.service.getRenderMetrics("video");
    await vi.waitFor(() =>
      expect(test.write).toHaveBeenCalledWith(
        "video",
        expect.objectContaining({
          status: "FAILED",
          error: expect.objectContaining({ stage: "input" })
        })
      )
    );
    expect(test.evaluate).not.toHaveBeenCalled();
  });
  it("rejects assets outside a local shot version", async () => {
    const test = setup({});
    await expect(test.service.getRenderMetrics("cloud-id")).rejects.toThrow(
      "Local shot version not found"
    );
    expect(test.write).not.toHaveBeenCalled();
  });
  it("stops saved-input resolution after teardown before evaluating or writing a terminal state", async () => {
    const test = setup({
      metrics_input: {
        prompt: "saved",
        duration_s: 5,
        reference_asset_ids: ["sheet"]
      }
    });
    let release!: (path: string) => void;
    test.resolveMediaPath.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    await test.service.getRenderMetrics("video");
    await vi.waitFor(() =>
      expect(test.resolveMediaPath).toHaveBeenCalledWith("video")
    );
    await test.service.suspendMetrics();
    release("old/video");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.evaluate).not.toHaveBeenCalled();
    expect(test.resolveMediaPath).not.toHaveBeenCalledWith("sheet");
    expect(test.write).toHaveBeenCalledTimes(1);
    expect(test.write).toHaveBeenCalledWith(
      "video",
      expect.objectContaining({ status: "PENDING" })
    );
  });

  it("refuses a captured prior library session even when asset IDs are reused", async () => {
    const test = setup({});
    const signal = test.service.captureMetricsSession();
    await test.service.suspendMetrics();
    test.service.resetMetrics();
    await expect(
      test.service.getRenderMetrics("video", signal)
    ).rejects.toThrow();
    expect(test.resolveMediaPath).not.toHaveBeenCalled();
    expect(test.write).not.toHaveBeenCalled();
  });
});
