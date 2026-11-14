import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ExternalRenderJob } from "../../providers/externalRenderJobRepository";
import type { ExternalRenderJobService } from "../../providers/externalRenderJobService";
import { waitForExternalRender } from "../../providers/waitForExternalRender";

import { renderFalShot } from "./falShotRenderer";

vi.mock("../../providers/waitForExternalRender", () => ({
  waitForExternalRender: vi.fn(async (_jobs, job) => ({
    job,
    assetId: "output"
  }))
}));

const provenance = {
  profile: "h3-tail-cfr-720p-v1" as const,
  requested_seconds: 2,
  source_frame_count: 96,
  source_fps: 24,
  start_frame: 48,
  end_frame_exclusive: 96,
  selected_frame_count: 48,
  output_frame_count: 48,
  output_fps: 24 as const,
  output_duration_seconds: 2,
  output_width: 1280,
  output_height: 720,
  audio: false as const
};
const video = (id: string, seconds = 2) => ({
  assetId: id,
  provenance: {
    ...provenance,
    requested_seconds: seconds,
    source_frame_count: 240,
    start_frame: 240 - seconds * 24,
    end_frame_exclusive: 240,
    selected_frame_count: seconds * 24,
    output_frame_count: seconds * 24,
    output_duration_seconds: seconds
  }
});
const submit = vi.fn(async () => ({ id: "job" }) as ExternalRenderJob);
const jobs = { submit } as unknown as ExternalRenderJobService;
const input = () => ({
  jobId: "job",
  savedJob: null,
  projectId: "project",
  prompt: "Continue Video 1",
  duration: 5,
  sourceIds: ["hero"],
  videoInputs: [video("tail")],
  signal: new AbortController().signal,
  onSubmitted: vi.fn(async () => {})
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe("fal shot modality boundary", () => {
  it("submits independent ordered groups and does not send provenance to the provider", async () => {
    await renderFalShot(jobs, input());
    const submitted = submit.mock.calls[0] as unknown as [
      Record<string, unknown>,
      AbortSignal
    ];
    expect(submitted[0]).toMatchObject({
      inputAssetIds: ["hero", "tail"],
      assetInputs: [
        { field: "reference_image_urls", kind: "image", assetIds: ["hero"] },
        { field: "reference_video_urls", kind: "video", assetIds: ["tail"] }
      ]
    });
    expect(submitted[0].requestJson).not.toHaveProperty("tail_provenance");
    expect(waitForExternalRender).toHaveBeenCalledOnce();
  });

  it.each([
    { sourceIds: [], videoInputs: [] },
    { sourceIds: Array.from({ length: 10 }, (_, i) => `image-${i}`) },
    { videoInputs: [video("a"), video("b"), video("c"), video("d")] },
    { videoInputs: [video("a", 10), video("b", 10)] },
    { videoInputs: [video("hero")] },
    { videoInputs: [video("a"), video("a")] },
    {
      videoInputs: [
        {
          assetId: "tail",
          provenance: { ...provenance, output_duration_seconds: 1 }
        }
      ]
    },
    {
      videoInputs: [
        { assetId: "tail", provenance: { ...provenance, source_fps: 12 } }
      ]
    },
    {
      videoInputs: [
        { assetId: "tail", provenance: { ...provenance, audio: true } }
      ]
    },
    {
      videoInputs: [
        { assetId: "tail", provenance: { ...provenance, output_width: 4096 } }
      ]
    }
  ])(
    "refuses invalid inputs before any upload or submission: %j",
    async (override) => {
      await expect(
        renderFalShot(jobs, { ...input(), ...override } as Parameters<
          typeof renderFalShot
        >[1])
      ).rejects.toThrow();
      expect(submit).not.toHaveBeenCalled();
      expect(waitForExternalRender).not.toHaveBeenCalled();
    }
  );

  it("allows nine images and three two-second videos within the combined limit", async () => {
    await renderFalShot(jobs, {
      ...input(),
      sourceIds: Array.from({ length: 9 }, (_, i) => `image-${i}`),
      videoInputs: [video("a"), video("b"), video("c")]
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("uses an accepted job unchanged despite invalid current defaults and inputs", async () => {
    const savedJob = {
      id: "original",
      requestJson: {
        reference_video_urls: ["https://v3.fal.media/original.mp4"]
      }
    } as unknown as ExternalRenderJob;
    await renderFalShot(jobs, {
      ...input(),
      savedJob,
      sourceIds: [],
      videoInputs: [],
      recovering: true,
      settings: { resolution: "invalid" }
    });
    expect(submit).not.toHaveBeenCalled();
    expect(waitForExternalRender).toHaveBeenCalledWith(
      jobs,
      savedJob,
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });
});
