import { describe, expect, it, vi } from "vitest";

import {
  resolveFalGenerationSettings,
  falVideoSize,
  falGenerationDefaultsSchema
} from "../../shared/falGenerationSettings";
import {
  FAL_SHEET_MODEL,
  FAL_SHEET_MODEL_21,
  FAL_SHEET_MODEL_H3
} from "../../shared/falSheetModel";
import { FAL_SHOT_ENGINE } from "../../shared/falShotModel";
import { renderFalSheet } from "../scriptProjects/sheets/falSheetRenderer";
import { planSheetRun } from "../scriptProjects/sheets/planSheetRun";
import { renderFalShot } from "../scriptProjects/shots/falShotRenderer";
import { planShotRun } from "../scriptProjects/shots/planShotRun";

const job = {
  id: "job",
  projectId: "p",
  provider: "fal",
  requestId: "remote",
  status: "INGESTED",
  requestJson: { resolution: "480P" },
  outputJson: { assetIds: ["asset"] }
};
const jobs = () => ({
  get: vi.fn().mockResolvedValue(null),
  submit: vi.fn(async (input) => ({ ...job, ...input }))
});
const base = {
  jobId: "job",
  projectId: "p",
  prompt: "A cat",
  sourceIds: ["reference"],
  signal: new AbortController().signal,
  onSubmitted: vi.fn().mockResolvedValue(undefined)
};

describe("fal generation settings", () => {
  it("merges action, project, app and built-in defaults by field", () => {
    expect(
      resolveFalGenerationSettings(
        FAL_SHOT_ENGINE,
        { resolution: "480P" },
        { resolution: "1080P", seed: 4 },
        { resolution: "768P", aspect_ratio: "9:16" }
      )
    ).toEqual({
      resolution: "480P",
      aspect_ratio: "9:16",
      seed: 4,
      prompt_expansion_mode: "disabled"
    });
    expect(resolveFalGenerationSettings(FAL_SHOT_ENGINE).resolution).toBe(
      "768P"
    );
    expect(
      resolveFalGenerationSettings(FAL_SHOT_ENGINE, { seed: null }, { seed: 4 })
        .seed
    ).toBeNull();
    expect(falVideoSize({ resolution: "480P", aspect_ratio: "9:16" })).toEqual([
      480, 848
    ]);
  });

  it.each([
    [FAL_SHEET_MODEL_21, { resolution: "0.5K" }],
    [FAL_SHEET_MODEL, { thinking_level: "medium" }],
    [FAL_SHEET_MODEL_H3, { resolution: "4K" }],
    [FAL_SHEET_MODEL_H3, { seed: 1 }],
    [FAL_SHOT_ENGINE, { resolution: "4K" }],
    [FAL_SHOT_ENGINE, { aspect_ratio: "2:3" }],
    [FAL_SHOT_ENGINE, { seed: 0.5 }],
    [FAL_SHOT_ENGINE, { seed: -1 }],
    [FAL_SHOT_ENGINE, { quality: "high" }]
  ] as const)(
    "rejects incompatible settings for %s before submit",
    async (model, settings) => {
      expect(() => resolveFalGenerationSettings(model, settings)).toThrow();
      expect(
        falGenerationDefaultsSchema.safeParse({ [model]: settings }).success
      ).toBe(false);
    }
  );

  it.each([FAL_SHEET_MODEL, FAL_SHEET_MODEL_21] as const)(
    "maps every Nano control on generate and edit: %s",
    async (model) => {
      for (const sourceIds of [[], ["reference"]]) {
        for (const resolution of model === FAL_SHEET_MODEL
          ? ["0.5K", "1K", "2K", "4K"]
          : ["1K", "2K", "4K"]) {
          const service = jobs();
          const settings = {
            resolution,
            aspect_ratio: "9:16",
            thinking_level: "high",
            seed: 123
          };
          const result = await renderFalSheet(service as never, {
            ...base,
            model,
            sourceIds,
            frame: [1024, 1024],
            settings
          });
          expect(service.submit.mock.calls[0]![0].requestJson).toMatchObject({
            ...settings,
            output_format: "png",
            num_images: 1
          });
          expect(result.job.requestJson).toMatchObject(settings);
          expect(result.job.endpoint.endsWith("/edit")).toBe(
            sourceIds.length > 0
          );
        }
      }
    }
  );

  it("maps H3 megapixels and aspect on generate/edit without unsupported fields", async () => {
    for (const megapixels of ["1", "2", "4", "8", "16"]) {
      for (const sourceIds of [[], ["reference"]]) {
        const service = jobs();
        await renderFalSheet(service as never, {
          ...base,
          model: FAL_SHEET_MODEL_H3,
          sourceIds,
          frame: [1024, 1024],
          settings: { megapixels, aspect_ratio: "16:9" }
        });
        const request = service.submit.mock.calls[0]![0].requestJson;
        const { width, height } = request.image_size;
        expect(width / height).toBeCloseTo(16 / 9, 1);
        expect((width * height) / (Number(megapixels) * 1048576)).toBeCloseTo(
          1,
          1
        );
        expect(request).not.toHaveProperty("resolution");
        expect(request).not.toHaveProperty("megapixels");
        expect(request.enable_prompt_expansion).toBe(
          sourceIds.length ? undefined : false
        );
      }
    }
  });

  it.each(["480P", "768P", "1080P"])(
    "sends video resolution %s with aspect, seed and prompt expansion",
    async (resolution) => {
      const service = jobs();
      const settings = {
        resolution,
        aspect_ratio: "9:16",
        seed: 12,
        prompt_expansion_mode: "quality"
      };
      const result = await renderFalShot(service as never, {
        ...base,
        savedJob: null,
        duration: 5,
        settings
      });
      expect(result.job.requestJson).toEqual({
        prompt: base.prompt,
        duration: 5,
        ...settings
      });
    }
  );

  it("recovers accepted jobs without modifying the request or submitting again", async () => {
    const service = jobs();
    service.get.mockResolvedValue(job);
    const sheet = await renderFalSheet(service as never, {
      ...base,
      recovering: true,
      model: FAL_SHEET_MODEL_21,
      frame: [1, 1],
      settings: { resolution: "4K" }
    });
    const shot = await renderFalShot(service as never, {
      ...base,
      recovering: true,
      savedJob: job as never,
      duration: 10,
      settings: { resolution: "1080P" }
    });
    expect(sheet.job.requestJson).toEqual({ resolution: "480P" });
    expect(shot.job.requestJson).toEqual({ resolution: "480P" });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("includes effective settings in sheet and shot fingerprints", () => {
    const sheet = (resolution: string) =>
      planSheetRun({
        keys: [{ token: "cat", prompt: "cat" }],
        request: {
          renderModel: FAL_SHEET_MODEL_21,
          providerSettings: { resolution }
        },
        inFlight: new Map(),
        visualStyle: "",
        masterFor: () => null
      });
    expect(sheet("1K").planned[0]!.fingerprint).not.toBe(
      sheet("2K").planned[0]!.fingerprint
    );
    const shot = (resolution: string) =>
      planShotRun({
        shots: [
          {
            timeline_id: "shot",
            video_prompt: "cat",
            duration_s: 5,
            references: { characters: [{ asset_id: "cat" }] }
          }
        ],
        cutShots: [],
        request: {
          videoSettings: {
            render_provider: "fal",
            provider_settings: { resolution }
          }
        },
        inFlight: new Map()
      });
    expect(shot("480P").planned[0]!.renderSpec.fingerprint).not.toBe(
      shot("768P").planned[0]!.renderSpec.fingerprint
    );
  });
});
