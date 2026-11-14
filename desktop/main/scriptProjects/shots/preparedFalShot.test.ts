import { describe, expect, it, vi } from "vitest";

import type { ExternalRenderJob } from "../../providers/externalRenderJobRepository";
import type { ExternalRenderJobService } from "../../providers/externalRenderJobService";

import { renderPreparedFalShot } from "./falShotRenderer";

vi.mock("../../providers/waitForExternalRender", () => ({
  waitForExternalRender: vi.fn(async (_jobs, saved) => ({
    job: saved,
    assetId: "output"
  }))
}));
import { fingerprint } from "../renderSpec";

import {
  assertPreparedShotJob,
  assertPreparedShotOwner,
  createPreparedFalShot,
  parsePreparedFalShot,
  preparedShotCost,
  type PreparedFalShot
} from "./preparedFalShot";

const body = (): Omit<PreparedFalShot, "digest"> => {
  const renderSpec = { kind: "shot", video_prompt: "A courier walks" };
  return {
    version: 1,
    project_id: "project",
    timeline_id: "shot",
    job_id: "job",
    provider: "fal",
    endpoint: "minimax/h3-max/reference-to-video",
    prompt: "Image 1: a courier.\n  Walk slowly.",
    duration: 5,
    settings: {
      resolution: "480P",
      aspect_ratio: "9:16",
      prompt_expansion_mode: "disabled",
      seed: null
    },
    image_ids: ["hero", "grid", "board"],
    video_inputs: [],
    image_slots: [
      { asset_id: "hero", members: ["hero"], role: "entity" },
      { asset_id: "grid", members: ["a", "b"], role: "entity" },
      { asset_id: "board", members: ["board"], role: "storyboard" }
    ],
    predecessor: {
      timeline_id: null,
      asset_id: null,
      in_run: false,
      selection: null
    },
    continues_from: null,
    prompt_provenance: {
      rewrite: "mago",
      raw_prompt: "A courier walks",
      composition: {
        model: "mock/text",
        text_model_route: "external",
        fallback: false,
        adapted_video_prompt: "Image 1: a courier.\n  Walk slowly.",
        numbered_ref_asset_ids: ["hero", "grid", "board"],
        numbered_video_asset_ids: []
      }
    },
    media_provenance: {
      continuity: null,
      grids: { grids: [{ asset_id: "grid", members: ["a", "b"] }] }
    },
    render_spec: renderSpec,
    render_fingerprint: fingerprint(renderSpec),
    cost: preparedShotCost("shot", "480P", 5)
  };
};
const job = (prepared: PreparedFalShot): ExternalRenderJob =>
  ({
    id: prepared.job_id,
    projectId: prepared.project_id,
    provider: prepared.provider,
    endpoint: prepared.endpoint,
    kind: "video",
    status: "SUBMITTED",
    requestId: "accepted",
    createdAt: new Date(),
    updatedAt: new Date(),
    error: null,
    outputJson: null,
    keychainAccount: "mock-fal",
    inputAssetIds: prepared.image_ids,
    requestJson: {
      prompt: prepared.prompt,
      duration: prepared.duration,
      resolution: "480P",
      aspect_ratio: "9:16",
      prompt_expansion_mode: "disabled",
      reference_image_urls: prepared.image_ids.map(
        (id) => `https://v3.fal.media/${id}.png`
      )
    }
  }) as ExternalRenderJob;

describe("persisted fal shot preparation", () => {
  it("round trips all effective inputs, slots, provenance, costs and fingerprint without changing prompt bytes", () => {
    const prepared = createPreparedFalShot(body());
    expect(parsePreparedFalShot(JSON.parse(JSON.stringify(prepared)))).toEqual(
      prepared
    );
    expect(prepared.prompt).toBe(body().prompt);
    expect(prepared.cost).toMatchObject({
      output_base_usd: 0.25,
      video_scenario: null
    });
    expect(JSON.stringify(prepared)).not.toMatch(
      /keychain|api_key|reference_image_urls/
    );
  });

  it.each([
    { version: 2 },
    { prompt: "" },
    { duration: 4 },
    { duration: 16 },
    { settings: { resolution: "bogus" } },
    { settings: { resolution: "480P" } },
    { image_ids: [] },
    { image_ids: ["hero", "hero", "board"] },
    { image_ids: ["board", "grid", "hero"] },
    { render_fingerprint: "wrong" },
    {
      predecessor: {
        timeline_id: "previous",
        asset_id: "source",
        in_run: false,
        selection: null
      }
    },
    { cost: { ...body().cost, output_base_usd: 100 } }
  ])(
    "refuses incomplete or internally inconsistent preparation even with a fresh digest: %j",
    (override) => {
      expect(() =>
        createPreparedFalShot({ ...body(), ...override } as Omit<
          PreparedFalShot,
          "digest"
        >)
      ).toThrow();
    }
  );

  it.each([
    "prompt",
    "duration",
    "image_ids",
    "prompt_provenance",
    "render_spec",
    "cost"
  ])("detects mutation of %s after persistence", (field) => {
    const prepared = createPreparedFalShot(body());
    const altered = {
      ...prepared,
      [field]: field === "prompt" ? prepared.prompt.replace("  ", " ") : null
    };
    expect(() => parsePreparedFalShot(altered)).toThrow();
  });

  it("checks submission ownership independently of mutable project targets", () => {
    const prepared = createPreparedFalShot(body());
    expect(() =>
      assertPreparedShotOwner(prepared, "project", "shot", "job")
    ).not.toThrow();
    for (const ids of [
      ["other", "shot", "job"],
      ["project", "other", "job"],
      ["project", "shot", "other"]
    ])
      expect(() =>
        assertPreparedShotOwner(prepared, ids[0]!, ids[1]!, ids[2]!)
      ).toThrow();
  });

  it("checks the immutable accepted payload and ordered modality mapping without accessing local media", () => {
    const prepared = createPreparedFalShot(body());
    const accepted = job(prepared);
    expect(() => assertPreparedShotJob(prepared, accepted)).not.toThrow();
    for (const changed of [
      { inputAssetIds: [...accepted.inputAssetIds].reverse() },
      { endpoint: "other/model" },
      { provider: "other" },
      { kind: "image" },
      { requestJson: { ...accepted.requestJson, duration: 10 } },
      { requestJson: { ...accepted.requestJson, seed: 42 } },
      { requestJson: { ...accepted.requestJson, reference_image_urls: [] } },
      {
        requestJson: {
          ...accepted.requestJson,
          reference_video_urls: ["https://v3.fal.media/extra.mp4"]
        }
      }
    ])
      expect(() =>
        assertPreparedShotJob(prepared, {
          ...accepted,
          ...changed
        } as ExternalRenderJob)
      ).toThrow();
  });
});

describe("prepared submission-only entry point", () => {
  const setup = () => {
    const preparation = createPreparedFalShot(body());
    const submit = vi.fn(async () => job(preparation));
    const jobs = { submit } as unknown as ExternalRenderJobService;
    const input = {
      preparation,
      projectId: "project",
      timelineId: "shot",
      jobId: "job",
      savedJob: null as ExternalRenderJob | null,
      signal: new AbortController().signal,
      onSubmitted: vi.fn(async () => {})
    };
    return { input, submit, jobs };
  };

  it("submits only the complete saved request and preserves independent slot ordering", async () => {
    const test = setup();
    await renderPreparedFalShot(test.jobs, test.input);
    expect(test.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job",
        projectId: "project",
        inputAssetIds: ["hero", "grid", "board"],
        assetInputs: [
          {
            field: "reference_image_urls",
            kind: "image",
            assetIds: ["hero", "grid", "board"]
          }
        ],
        requestJson: {
          prompt: test.input.preparation.prompt,
          duration: 5,
          resolution: "480P",
          aspect_ratio: "9:16",
          prompt_expansion_mode: "disabled"
        }
      }),
      test.input.signal
    );
  });

  it.each([
    "corrupt",
    "wrong-owner",
    "recovering",
    "aborted",
    "mismatched-job"
  ])(
    "refuses %s before calling the upload/submission service",
    async (reason) => {
      const test = setup();
      const input = { ...test.input, recovering: false };
      if (reason === "corrupt")
        input.preparation = { ...input.preparation, digest: "bad" };
      if (reason === "wrong-owner") input.jobId = "different";
      if (reason === "recovering") input.recovering = true;
      if (reason === "aborted") input.signal = AbortSignal.abort();
      if (reason === "mismatched-job")
        input.savedJob = {
          ...job(input.preparation),
          requestJson: { prompt: "changed" }
        };
      await expect(renderPreparedFalShot(test.jobs, input)).rejects.toThrow();
      expect(test.submit).not.toHaveBeenCalled();
    }
  );

  it("recovers an accepted request without submitting or resolving local inputs", async () => {
    const test = setup();
    const savedJob = job(test.input.preparation);
    const result = await renderPreparedFalShot(test.jobs, {
      ...test.input,
      savedJob,
      recovering: true
    });
    expect(result.job).toBe(savedJob);
    expect(test.submit).not.toHaveBeenCalled();
  });
});

it.each(["composition", "mapping", "grids"])(
  "refuses incomplete %s provenance even with a new integrity digest",
  (missing) => {
    const input = body();
    if (missing === "composition") input.prompt_provenance.composition = null;
    if (missing === "mapping")
      input.prompt_provenance.composition!.numbered_ref_asset_ids = [
        "board",
        "grid",
        "hero"
      ];
    if (missing === "grids") input.media_provenance.grids = null;
    expect(() => createPreparedFalShot(input)).toThrow();
  }
);
