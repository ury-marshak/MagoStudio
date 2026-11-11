import { describe, expect, it, vi } from "vitest";

import type { ProjectRepository } from "../database/projectRepository";
import { extractMetricsFrameGrid } from "../scriptProjects/localScriptMedia";

import type { VisionGenerator } from "./visionGenerator";
import { VlmService } from "./vlmService";

vi.mock("electron", () => ({ nativeImage: {} }));
vi.mock("../scriptProjects/localScriptMedia", () => ({
  createReferenceGrid: vi.fn(),
  extractMetricsFrameGrid: vi.fn()
}));

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
      maxTokens: 512
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
});
