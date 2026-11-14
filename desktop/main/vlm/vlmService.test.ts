import { describe, expect, it, vi } from "vitest";

import type { ProjectRepository } from "../database/projectRepository";
import { extractMetricsFrameGrid } from "../scriptProjects/localScriptMedia";

import { extractVideoCaptionFrames } from "./videoFrames";
import type { VisionGenerator } from "./visionGenerator";
import { VlmService } from "./vlmService";

vi.mock("electron", () => ({ nativeImage: {} }));
vi.mock("../scriptProjects/localScriptMedia", () => ({
  createReferenceGrid: vi.fn(),
  extractMetricsFrameGrid: vi.fn()
}));
vi.mock("./videoFrames", () => ({ extractVideoCaptionFrames: vi.fn() }));

describe("VlmService", () => {
  it("passes the assembled prompt to the selected generator and keeps the queue usable after a failure", async () => {
    const generateVision = vi
      .fn<VisionGenerator>()
      .mockRejectedValueOnce(new Error("Selected provider unavailable"))
      .mockResolvedValueOnce({ text: "  Enhanced prompt  ", model: "test" });
    const service = new VlmService(
      {} as ProjectRepository,
      generateVision,
      async () => {
        throw new Error("Generation should not probe model availability");
      }
    );

    const first = service.enhancePrompt({ query: "A foggy street" });
    const second = service.enhancePrompt({ query: "A moonlit beach" });

    await expect(first).rejects.toThrow("Selected provider unavailable");
    await expect(second).resolves.toEqual({
      enhanced_prompt: "Enhanced prompt"
    });
    expect(generateVision).toHaveBeenCalledTimes(2);
    expect(generateVision).toHaveBeenNthCalledWith(2, {
      systemPrompt: expect.stringContaining("visual analysis assistant"),
      userPrompt: expect.stringContaining("User prompt: A moonlit beach"),
      maxTokens: 512,
      signal: expect.any(AbortSignal)
    });
  });

  it("records the model that evaluated the sampled frames", async () => {
    const frames = Buffer.from("frame grid");
    vi.mocked(extractMetricsFrameGrid).mockResolvedValueOnce(frames);
    const generateVision = vi.fn<VisionGenerator>().mockResolvedValueOnce({
      model: "configured-vision-model",
      text: JSON.stringify({
        vid_score: 9,
        vid_pass: true,
        vid_style: 9,
        vid_content: 9,
        vid_identity: 9,
        vid_lighting: 9,
        vid_quality: 9,
        vid_temporal_style: 9,
        vid_temporal_identity: 9,
        vid_next_prompt: "Keep the framing"
      })
    });
    const service = new VlmService(
      {} as ProjectRepository,
      generateVision,
      async () => {
        throw new Error("Evaluation should not probe model availability");
      }
    );

    await expect(
      service.evaluateShotVideo({
        sourcePath: "shot.mp4",
        prompt: "A moonlit beach",
        durationSeconds: 3,
        referencePaths: []
      })
    ).resolves.toMatchObject({
      model: "configured-vision-model",
      frame_count: 3,
      vid_score: 9
    });
    expect(generateVision).toHaveBeenCalledWith(
      expect.objectContaining({ images: [frames] })
    );
  });

  it("skips an aborted queued request and keeps subsequent requests usable", async () => {
    let finish!: (value: { text: string; model: string }) => void;
    const generate = vi
      .fn<VisionGenerator>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ text: "next", model: "test" });
    const service = new VlmService({} as ProjectRepository, generate, vi.fn());
    const first = service.enhancePrompt({ query: "first" });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = service.enhancePrompt(
      { query: "queued" },
      controller.signal
    );
    controller.abort();
    await expect(queued).rejects.toThrow();
    finish({ text: "first", model: "test" });
    await first;
    await expect(service.enhancePrompt({ query: "next" })).resolves.toEqual({
      enhanced_prompt: "next"
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("passes cancellation to active transport and rejects a late success", async () => {
    const controller = new AbortController();
    let finish!: (value: { text: string; model: string }) => void;
    const generate = vi.fn<VisionGenerator>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const service = new VlmService({} as ProjectRepository, generate, vi.fn());
    const result = service.enhancePrompt({ query: "test" }, controller.signal);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(generate.mock.calls[0]![0].signal?.aborted).toBe(true);
    finish({ text: "late", model: "test" });
  });

  it("does not repair or persist a caption after cancellation", async () => {
    vi.mocked(extractVideoCaptionFrames).mockResolvedValue({
      firstFrame: Buffer.from("frame"),
      grids: []
    });
    const repository = {
      getAsset: vi.fn(async () => ({
        type: "VIDEO",
        data: { total_frames: 24 }
      })),
      assetSourcePath: vi.fn(async () => "video.mp4"),
      setAssetPrompt: vi.fn()
    };
    const controller = new AbortController();
    const generate = vi.fn<VisionGenerator>(async () => {
      controller.abort();
      return { text: "not JSON", model: "test" };
    });
    const service = new VlmService(
      repository as unknown as ProjectRepository,
      generate,
      vi.fn()
    );
    await expect(
      service.captionAsset("video", controller.signal)
    ).rejects.toThrow();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(repository.setAssetPrompt).not.toHaveBeenCalled();
    expect(extractVideoCaptionFrames).toHaveBeenLastCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("shares caption work, while cancelling only the departing consumer", async () => {
    vi.mocked(extractVideoCaptionFrames).mockResolvedValue({
      firstFrame: Buffer.from("frame"),
      grids: []
    });
    const repository = {
      getAsset: vi.fn(async () => ({
        type: "VIDEO",
        data: { total_frames: 24 }
      })),
      assetSourcePath: vi.fn(async () => "video.mp4"),
      setAssetPrompt: vi.fn()
    };
    let finish!: (value: { text: string; model: string }) => void;
    const generate = vi.fn<VisionGenerator>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const service = new VlmService(
      repository as unknown as ProjectRepository,
      generate,
      vi.fn()
    );
    const controller = new AbortController();
    const a = service.captionAsset("video", controller.signal);
    const b = service.captionAsset("video");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(a).rejects.toThrow();
    expect(generate.mock.calls[0]![0].signal?.aborted).toBe(false);
    finish({
      text: JSON.stringify({
        positive: {
          content: "a dancer",
          setting: "studio",
          style: "film",
          references: ""
        },
        negative: ""
      }),
      model: "test"
    });
    await expect(b).resolves.toMatchObject({
      prompt: { positive: { content: "a dancer" } }
    });
    expect(repository.setAssetPrompt).toHaveBeenCalledTimes(1);
  });

  it("aborts active and queued inference on shutdown", async () => {
    const generate = vi.fn<VisionGenerator>(() => new Promise(() => {}));
    const service = new VlmService({} as ProjectRepository, generate, vi.fn());
    const active = service.enhancePrompt({ query: "active" });
    const queued = service.enhancePrompt({ query: "queued" });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    service.stop();
    await expect(active).rejects.toThrow();
    await expect(queued).rejects.toThrow();
    await expect(
      service.enhancePrompt({ query: "after stop" })
    ).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].signal?.aborted).toBe(true);
  });
});
